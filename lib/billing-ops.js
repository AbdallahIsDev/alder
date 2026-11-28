// lib/billing-ops.js — the two things that act on billing.
//
//   applyPayment()    records that a business is paid until a date. It is what
//                     the operator's "Extend 30 days" calls, and it is THE
//                     function a payment-provider webhook will call later.
//   runBillingJob()   the daily job: the six notices, automatic suspension and
//                     termination, and one summary for the operator.
//
// The rules themselves are in lib/billing.js (pure) and the durations in
// lib/lifecycle-config.js. Suspension, termination and reactivation go
// through lib/service-status.js, the same code the operator's buttons use;
// every notice goes through lib/lifecycle-notify.js. Every database, Telegram
// and mail call is a member of `io`, so the webhook can pass its timed
// wrappers and a test can pass fakes; the default is the real thing.
//
// There is no payment-provider code here, on purpose: money arrives outside
// the system and the operator records it.

import * as dbApi from './db.js';
import { sendMessage } from './tg.js';
import { sendMail } from './mail.js';
import { sendLifecycleEmail } from './notify.js';
import { deliverOperatorAlarm } from './operator-alarm.js';
import { suspendBusiness, terminateBusiness, reactivateBusiness, heldLeadCount, suspendedKeyboard } from './service-status.js';
import { sendHeldLeadsToPhones } from './held-leads.js';
import { sendOwnerNotice } from './lifecycle-notify.js';
import { ownerNotice } from './lifecycle-text.js';
import {
  toMs, billingDecision, billingSummaryText, stageOf, STAGE_NONE,
} from './billing.js';

export const DEFAULT_IO = {
  getBusinessById: dbApi.getBusinessById,
  listHeldLeads: dbApi.listHeldLeads,
  sendHeldLeads: (args) => sendHeldLeadsToPhones(args, DEFAULT_IO),
  extendPaidUntil: dbApi.extendPaidUntil,
  setBusinessStatus: dbApi.setBusinessStatus,
  setBillingStage: dbApi.setBillingStage,
  listBilledBusinesses: dbApi.listBilledBusinesses,
  listBusinessChatsDetailed: dbApi.listBusinessChatsDetailed,
  countHeldLeads: dbApi.countHeldLeads,
  lastBusinessEventAt: dbApi.lastBusinessEventAt,
  addBusinessEvent: dbApi.addBusinessEvent,
  hitRateLimit: dbApi.hitRateLimit,
  clearRateLimit: dbApi.clearRateLimit,
  sendMessage,
  sendMail,
  sendLifecycleEmail,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 *  3. It clears the warning stage. billing_warning_stage goes to 0 in the
 *     same statement, so the next period's notices start from the first.
 *  4. It restores service through the one reactivation path (status 'active',
 *     suspended_for_billing cleared, "Your service is active again" with the
 *     keyboards, the held-lead count), and only when THIS call moved
 *     paid_until. A suspended ('paused') and a terminated ('churned')
 *     business are both restored:
 *       reactivate 'billing' (default)  only one the billing job switched off
 *                                       (suspended_for_billing)
 *       reactivate 'any'                any suspended or terminated business
 *                                       (the operator's Extend, whose
 *                                       question says so)
 *       reactivate 'never'              leave the status alone
 *     A webhook should keep the default: a business the operator switched
 *     off by hand must not come back because a card was charged.
 *  5. It never creates, deletes or reassigns anything else, and it does NOT
 *     decide the date: the caller computes `paidUntil`. Today that is
 *     nextPaidUntil(current, now, days) from lib/billing.js (max(paid_until,
 *     now) + 30 days). LATER, when a payment provider is connected, the
 *     provider's own period end is authoritative: the webhook passes the
 *     period end it was given, not a date computed here, and rules 1 and 2
 *     make redelivered and out-of-order deliveries harmless.
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
 *   { ok: true, changed: true, paidUntil, wasSuspended, reactivated, notice, held }
 *       wasSuspended && !reactivated: paid_until moved, the status did not
 *       (rule 4). notice is the reactivation notice's outcome, or null.
 * paidUntil is milliseconds: what is stored after the call.
 */
export async function applyPayment({ businessId, paidUntil, source = 'operator', reactivate = 'billing', business = null, now = Date.now() }, io = DEFAULT_IO) {
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
  const wanted = wasSuspended && (reactivate === 'any' || (reactivate === 'billing' && row.suspended_for_billing === true));
  let reactivated = false;
  let notice = null;
  let held = 0;
  if (wanted) {
    try {
      // `row` still carries the OLD paid_until: that is what dates the
      // suspension the held leads belong to.
      const r = await reactivateBusiness({ business: row, reason: 'payment', paidUntil: target, now }, io);
      reactivated = r.changed;
      notice = r.notice;
      held = r.held;
    } catch (e) {
      console.error('billing_reactivate_failed', (e && e.code) || 'no_code');
    }
  }
  return { ok: true, changed: true, paidUntil: target, wasSuspended, reactivated, notice, held };
}

/* ---------- the daily job ---------- */

const DAY_WINDOW_SECONDS = 86400;   // one UTC day: the rate-limit bucket is floor(now / window)
/** One billing notice (or notifying transition) per business per UTC day. */
const stepClaimKey = (id) => `billing:step:${id}`;

/** One claim per key per UTC day. A claim that cannot be made fails OPEN: a
 *  warning sent twice is better than a suspension nobody was warned about. */
async function claimToday(io, key) {
  try { return await io.hitRateLimit(key, DAY_WINDOW_SECONDS, 1); } catch { return true; }
}

/** The stage is recorded when the notice reached somebody, or when there was
 *  nobody to reach at all. Otherwise it stays, and tomorrow's run sends the
 *  notice again. */
const counts = (notice) => !!notice && (notice.delivered || notice.nobody);

/**
 * The daily billing job. It reads every business that has a paid_until and
 * whose status is active, paused or churned, and for each one does what
 * billingDecision() says (the whole table is in lib/billing.js). It never
 * acts on a demo, on a business without a paid_until, or on one the operator
 * suspended or terminated by hand.
 *
 *   reset      the business paid: stage -> 0.
 *   notice     one of the six notices to every bound phone and the owner
 *              address (lib/lifecycle-notify.js); then the stage is recorded.
 *   suspend    suspendBusiness(), the operator's Suspend path, with
 *              suspended_for_billing set in the same update.
 *   terminate  terminateBusiness(), the operator's Terminate path. NO data is
 *              deleted, by this job or by anything else.
 *   restore    a billing-suspended business whose paid_until is ahead again
 *              (a payment was recorded but the status did not follow):
 *              reactivateBusiness().
 *
 * The delivery rule: a notice's stage is recorded when at least one copy was
 * accepted (one phone, or the owner email), or when there was nobody to
 * notify at all. When there WAS somebody and nothing got through, the stage
 * stays, the business is listed as "notice not delivered", the operator is
 * alerted, and the next day's run sends it again. A failed notice never
 * delays a suspension or a termination: those follow the dates alone.
 *
 * Idempotent: a second run on the same day finds the stage already recorded
 * (or the status already changed) and does nothing. On top of that, every
 * step that notifies a business first takes a claim that lasts for the UTC
 * day, so a business gets at most ONE billing notice a day: two runs at the
 * same moment cannot both send it. A suspension or termination that falls on
 * a day whose notice was already used still happens; its notice goes out
 * with the next day's run.
 *
 * The operator gets ONE short summary, and only when this run did something
 * (lib/billing.js billingSummaryText): a second run on the same day did
 * nothing, so it says nothing.
 *
 * A database without the billing columns (migration 0006 not applied) is not
 * an error: the job reports { skipped: 'unavailable' } and does nothing.
 *
 * Returns counts only (no names): { ok, checked, reset, warned, suspended,
 * terminated, restored, undelivered, failed, grace, due, held, operator }.
 */
export async function runBillingJob({ now = Date.now() } = {}, io = DEFAULT_IO) {
  const nowMs = toMs(now);
  const dateKey = new Date(nowMs).toISOString().slice(0, 10);
  const lists = { terminated: [], suspended: [], restored: [], warned: [], undelivered: [], failed: [], grace: [], due: [], held: [] };
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
    const stage = stageOf(business);
    let status = business.status;
    try {
      if (d.action === 'reset') {
        reset += await io.setBillingStage(business.id, STAGE_NONE, stage);
      } else if (d.action === 'restore') {
        const r = await reactivateBusiness({ business, reason: 'payment', paidUntil: d.paidUntil, now: nowMs }, io);
        if (r.changed) { lists.restored.push(business); status = 'active'; }
      } else if (d.action !== 'none') {
        // At most ONE billing notice per business per UTC day. A transition
        // does not wait for that: it happens now, and its notice follows with
        // tomorrow's run (the stage is not recorded until it was sent).
        const claimed = await claimToday(io, stepClaimKey(business.id));
        // The email's event instance: this paid period, this notice, this day.
        // A retry tomorrow is a new key; a second run today replays the first.
        const instance = `${Math.floor(d.paidUntil / 1000)}:${dateKey}`;
        let notice = null;
        if (d.action === 'notice') {
          if (claimed) {
            const off = business.status !== 'active';
            notice = await sendOwnerNotice(io, {
              business,
              rows: await io.listBusinessChatsDetailed(business.id),
              notice: ownerNotice(d.notice, { business, now: nowMs, reason: 'billing' }),
              instance, dateKey,
              keyboard: off ? suspendedKeyboard : null,
            });
            if (notice.delivered) lists.warned.push({ business, notice: d.notice });
          }
        } else if (d.action === 'suspend') {
          const r = await suspendBusiness({ business, forBilling: true, from: ['active'], now: nowMs, notify: claimed }, io);
          notice = r.notice;
          if (r.changed) { lists.suspended.push(business); status = 'paused'; }
        } else if (d.action === 'terminate') {
          const r = await terminateBusiness({ business, forBilling: true, from: ['active', 'paused'], now: nowMs, notify: claimed }, io);
          notice = r.notice;
          if (r.changed) { lists.terminated.push(business); status = 'churned'; }
        }
        if (counts(notice)) await io.setBillingStage(business.id, d.stage, stage);
        else if (notice) lists.undelivered.push(business);
      }
    } catch (e) {
      // One business that cannot be processed never stops the others. Nothing
      // was recorded for it, so tomorrow's run does the same step again.
      console.error('billing_step_failed', d.action, (e && e.code) || 'no_code');
      lists.failed.push(business);
    }
    if (status === 'active' && d.state === 'grace') lists.grace.push(business);
    if (status === 'active' && d.state === 'due_soon') lists.due.push(business);
    if (status === 'paused') {
      const count = await heldLeadCount({ ...business, suspended_for_billing: business.suspended_for_billing || d.action === 'suspend' }, io);
      if (count > 0) lists.held.push({ business, count });
    }
  }

  let operator = 'none';
  const text = billingSummaryText(lists);
  if (text) {
    // The operator alert channel the self-check uses: Telegram, then email.
    operator = await deliverOperatorAlarm({ body: text, text, dateKey, keyPrefix: 'billing' }, io);
  }

  return {
    ok: true, checked: businesses.length, reset,
    warned: lists.warned.length, suspended: lists.suspended.length, terminated: lists.terminated.length,
    restored: lists.restored.length, undelivered: lists.undelivered.length, failed: lists.failed.length,
    grace: lists.grace.length, due: lists.due.length, held: lists.held.length, operator,
  };
}
