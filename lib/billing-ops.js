// lib/billing-ops.js — the two things that act on billing.
//
//   applyPayment()    records that a business is paid until a date. It is what
//                     the operator's "Extend 30 days" calls, and it is THE
//                     function a payment-provider webhook will call later.
//   runBillingJob()   the daily job: warnings, the final warning, automatic
//                     suspension, and one summary for the operator.
//
// The rules themselves are in lib/billing.js (pure). Suspension and
// reactivation go through lib/service-status.js, the same code the operator's
// Suspend and Reactivate buttons use. Every database, Telegram and mail call
// is a member of `io`, so the webhook can pass its timed wrappers and a test
// can pass fakes; the default is the real thing.
//
// There is no payment-provider code here, on purpose: money arrives outside
// the system and the operator records it.

import * as dbApi from './db.js';
import { sendMessage } from './tg.js';
import { sendMail } from './mail.js';
import { sendSuspensionEmail, sendBillingEmail } from './notify.js';
import { deliverOperatorAlarm } from './operator-alarm.js';
import { suspendBusiness, reactivateBusiness, sendFailed } from './service-status.js';
import {
  toMs, billingState, billingDecision, dueSoon, billingSummaryText,
  overdueWarningText, finalWarningText, BILLING_OVERDUE_SUBJECT, BILLING_FINAL_SUBJECT,
  STAGE_NONE, STAGE_OVERDUE, STAGE_FINAL,
} from './billing.js';

const DEFAULT_IO = {
  getBusinessById: dbApi.getBusinessById,
  extendPaidUntil: dbApi.extendPaidUntil,
  setBusinessStatus: dbApi.setBusinessStatus,
  setBillingStage: dbApi.setBillingStage,
  listBilledBusinesses: dbApi.listBilledBusinesses,
  listBusinessChatsDetailed: dbApi.listBusinessChatsDetailed,
  hitRateLimit: dbApi.hitRateLimit,
  clearRateLimit: dbApi.clearRateLimit,
  sendMessage,
  sendMail,
  sendSuspensionEmail,
  sendBillingEmail,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

/* ---------- applyPayment: the seam ---------- */

/**
 * Record that a business is paid until `paidUntil`.
 *
 * THE CONTRACT (a payment webhook must be able to rely on every line):
 *
 *  1. Idempotent. The same (businessId, paidUntil) applied twice changes one
 *     row the first time and nothing the second: no write, no notice, no
 *     reactivation. Providers redeliver webhooks; that must be harmless.
 *  2. It never shortens a paid period. paid_until only moves FORWARD: a
 *     target that is not later than what is stored changes nothing. The check
 *     is part of the UPDATE's WHERE, not only of this function.
 *  3. It clears grace and the warning stage. A later paid_until is what ends
 *     the grace period; billing_warning_stage goes to 0 in the same statement,
 *     so the next overdue period warns again from the start.
 *  4. It reactivates through the one Reactivate code path (notices and
 *     keyboards included), and only when THIS call moved paid_until:
 *       reactivate 'billing' (default)  only a business the billing job
 *                                       suspended (suspended_for_billing)
 *       reactivate 'any'                any suspended business (the operator's
 *                                       Extend, whose question says so)
 *       reactivate 'never'              leave the status alone
 *     A webhook should keep the default: a business the operator suspended by
 *     hand must not come back because a card was charged.
 *  5. It never creates, deletes or reassigns anything else, and it does not
 *     decide the date: the caller computes `paidUntil` (for "one more period"
 *     that is nextPaidUntil(current, now, days) from lib/billing.js).
 *
 * `source` says who is recording the payment ('operator' today; a provider's
 * name later). It is written to the log line and nowhere else.
 * `business` may be the row the caller has just read by this id (the operator
 * tap already validated it); otherwise it is read here.
 *
 * Returns:
 *   { ok: false, reason: 'bad_request' | 'not_found' | 'unavailable' }
 *       unavailable: the billing columns do not exist (migration 0006)
 *   { ok: true, changed: false, paidUntil }             already paid that far
 *   { ok: true, changed: true, paidUntil, wasSuspended, reactivated, noticesFailed }
 *       wasSuspended && !reactivated: paid_until moved, the status did not
 *       (by rule 4, or the phones could not be read): it is still suspended.
 * paidUntil is milliseconds: what is stored after the call.
 */
export async function applyPayment({ businessId, paidUntil, source = 'operator', reactivate = 'billing', business = null }, io = DEFAULT_IO) {
  const target = toMs(paidUntil);
  if (!UUID.test(String(businessId || '')) || target === null) return { ok: false, reason: 'bad_request' };
  const row = business && business.id === businessId ? business : await io.getBusinessById(businessId);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.billing_unavailable) return { ok: false, reason: 'unavailable' };

  const current = toMs(row.paid_until);
  if (current !== null && current >= target) return { ok: true, changed: false, paidUntil: current };

  let changed;
  try {
    changed = await io.extendPaidUntil(businessId, new Date(target).toISOString(), { fromNull: current === null });
  } catch (e) {
    if (dbApi.isMissingColumn(e)) return { ok: false, reason: 'unavailable' };
    throw e;
  }
  if (!changed) {
    // Somebody else moved it between the read and the write: report what is
    // stored now, and do nothing more.
    const again = await io.getBusinessById(businessId);
    return { ok: true, changed: false, paidUntil: again ? toMs(again.paid_until) : current };
  }
  console.log('billing_payment_applied', /^[a-z][a-z0-9_]{0,23}$/.test(String(source)) ? source : 'other');

  const wasSuspended = dbApi.isSuspendedStatus(row.status);
  const wanted = wasSuspended && (reactivate === 'any' || (reactivate === 'billing' && !!row.suspended_for_billing));
  let reactivated = false;
  let noticesFailed = 0;
  if (wanted) {
    // The phones are told with their keyboards; without the list nobody could
    // be, so the status is left for the operator's Reactivate button.
    const chats = await settle(io.listBusinessChatsDetailed(businessId));
    if (!chats.error) {
      try {
        const r = await reactivateBusiness({ business: row, rows: chats.value }, io);
        reactivated = r.changed;
        noticesFailed = r.failed;
      } catch (e) {
        console.error('billing_reactivate_failed', (e && e.code) || 'no_code');
      }
    }
  }
  return { ok: true, changed: true, paidUntil: target, wasSuspended, reactivated, noticesFailed };
}

/* ---------- the daily job ---------- */

const DAY_WINDOW_SECONDS = 86400;   // one UTC day: the rate-limit bucket is floor(now / window)
/** One notifying step (a warning or a suspension) per business per UTC day. */
const stepClaimKey = (id) => `billing:step:${id}`;
const SUMMARY_CLAIM_KEY = 'billing:summary';

/** One claim per key per UTC day. A claim that cannot be made fails OPEN: a
 *  warning sent twice is better than a suspension nobody was warned about. */
async function claimToday(io, key) {
  try { return await io.hitRateLimit(key, DAY_WINDOW_SECONDS, 1); } catch { return true; }
}

/**
 * One warning to one business: every bound phone (Telegram), and one plain
 * email to the owner address. Returns { delivered, nobody }: whether at least
 * one of them was accepted, and whether there was nobody to send to at all.
 */
async function sendWarning(io, business, { text, subject, kind, dateKey }) {
  const chats = await io.listBusinessChatsDetailed(business.id);
  const [sent, mail] = await Promise.all([
    Promise.all(chats.map((r) => settle(io.sendMessage(r.tg_chat_id, text)))),
    settle(io.sendBillingEmail({ business, subject, text, kind, dateKey })),
  ]);
  const phonesOk = sent.filter((r) => !sendFailed(r)).length;
  const mailOk = !sendFailed(mail);
  return { delivered: phonesOk > 0 || mailOk, nobody: chats.length === 0 && !business.owner_email };
}

/**
 * The daily billing job. Reads ONLY businesses whose status is 'active' and
 * whose paid_until is set; a demo, paused, churned or unbilled business is
 * never read, warned or changed. For each one, billingDecision() says what to
 * do (the table is in lib/billing.js):
 *
 *   reset     the business paid: stage -> 0.
 *   warn      the overdue warning to every bound phone and the owner address;
 *             then stage -> 1.
 *   final     the final warning, the same way; then stage -> 2.
 *   suspend   suspendBusiness(): the same code path as the operator's Suspend
 *             (notices with ReplyKeyboardRemove, the owner email, status
 *             'paused'), plus suspended_for_billing in the same update.
 *
 * The delivery rule for a warning: the stage advances when at least one
 * notice was accepted (one phone, or the owner email), or when there was
 * nobody to notify at all (no phone and no owner address). When there WAS
 * somebody and nothing got through, the stage stays, the business is listed
 * as "could not be warned", and the next day's run tries again. A failed
 * warning never delays the suspension: that follows the dates alone.
 *
 * Idempotent: a second run on the same day finds the stage already advanced
 * (or the status already paused) and does nothing. On top of that, every
 * step that notifies a business (a warning, a suspension) first takes a claim
 * that lasts for the UTC day, so a business gets at most ONE billing notice a
 * day: two runs at the same moment cannot both send it, a warning that failed
 * is not retried until tomorrow, and the final warning and the suspension
 * never arrive on the same day. The operator's summary is one message per UTC
 * day; a second run sends one only for something it newly did.
 *
 * A database without the billing columns (migration 0006 not applied) is not
 * an error: the job reports { skipped: 'unavailable' } and does nothing.
 *
 * Returns counts only (no names): { ok, checked, reset, warned, final_warned,
 * suspended, unwarned, failed, grace, due, operator }.
 */
export async function runBillingJob({ now = Date.now() } = {}, io = DEFAULT_IO) {
  const nowMs = toMs(now);
  const dateKey = new Date(nowMs).toISOString().slice(0, 10);
  const lists = { suspended: [], warned: [], finalWarned: [], unwarned: [], failed: [], grace: [], due: [] };
  let reset = 0;

  let businesses;
  try {
    businesses = await io.listBilledBusinesses();
  } catch (e) {
    if (dbApi.isMissingColumn(e)) return { ok: true, skipped: 'unavailable' };
    throw e;
  }

  for (const business of businesses) {
    const d = billingDecision(business, nowMs);
    const stage = Number(business.billing_warning_stage) || STAGE_NONE;
    try {
      if (d.action === 'reset') {
        reset += await io.setBillingStage(business.id, STAGE_NONE, stage);
      } else if (d.action === 'warn' || d.action === 'final') {
        const final = d.action === 'final';
        if (await claimToday(io, stepClaimKey(business.id))) {
          const r = await sendWarning(io, business, {
            text: final ? finalWarningText(business, d.graceEnd) : overdueWarningText(business, d.graceEnd),
            subject: final ? BILLING_FINAL_SUBJECT : BILLING_OVERDUE_SUBJECT,
            kind: final ? 'final' : 'overdue',
            dateKey,
          });
          if (r.delivered || r.nobody) {
            await io.setBillingStage(business.id, final ? STAGE_FINAL : STAGE_OVERDUE, stage);
            if (r.delivered) (final ? lists.finalWarned : lists.warned).push(business);
            else lists.unwarned.push(business);
          } else {
            lists.unwarned.push(business);
          }
        }
      } else if (d.action === 'suspend' && await claimToday(io, stepClaimKey(business.id))) {
        const rows = await io.listBusinessChatsDetailed(business.id);
        const r = await suspendBusiness({ business, rows, forBilling: true, from: ['active'] }, io);
        if (r.changed) lists.suspended.push(business);
      }
    } catch (e) {
      // One business that cannot be processed never stops the others. Nothing
      // was recorded for it, so tomorrow's run does the same step again.
      console.error('billing_step_failed', d.action, (e && e.code) || 'no_code');
      lists.failed.push(business);
    }
    if (d.state === 'grace') lists.grace.push({ business, graceEnd: d.graceEnd });
    if (dueSoon(business, nowMs)) lists.due.push({ business, paidUntil: billingState(business, nowMs).paidUntil });
  }

  // One summary per UTC day. A later run the same day speaks only about what
  // it newly did, never repeats the standing lists.
  const events = { suspended: lists.suspended, warned: lists.warned, finalWarned: lists.finalWarned, unwarned: lists.unwarned, failed: lists.failed };
  let operator = 'none';
  const full = billingSummaryText(lists);
  if (full) {
    const first = await claimToday(io, SUMMARY_CLAIM_KEY);
    const text = first ? full : billingSummaryText(events);
    if (text) {
      // The operator alert channel the self-check uses: Telegram, then email.
      operator = await deliverOperatorAlarm({ body: text, text, dateKey, keyPrefix: 'billing' }, io);
      // Nobody heard it: give the day's slot back so the next run says it.
      if (operator === 'undelivered' && first) await io.clearRateLimit(SUMMARY_CLAIM_KEY).catch(() => {});
    }
  }

  return {
    ok: true, checked: businesses.length, reset,
    warned: lists.warned.length, final_warned: lists.finalWarned.length, suspended: lists.suspended.length,
    unwarned: lists.unwarned.length, failed: lists.failed.length,
    grace: lists.grace.length, due: lists.due.length, operator,
  };
}
