// lib/service-status.js — switching one business's service off and on.
//
// ONE code path for every way a business is suspended or reactivated: the
// operator's Suspend and Reactivate buttons (api/tg.js), the daily billing job
// and a recorded payment (lib/billing-ops.js). They differ only in WHO asked;
// what the business's phones are told, what is written, and in which order,
// is decided here.
//
// No I/O of its own: the three calls it makes (send a Telegram message, send
// the owner email, write the status) are passed in as `io`. The webhook passes
// its timed wrappers, so the calls still show up in its timing line; the job
// passes the plain functions; a test passes fakes.
//
//   io.sendMessage(chatId, text, extra)             -> { ok }
//   io.sendSuspensionEmail({ business, text, billing }) -> { ok, status }
//   io.setBusinessStatus(id, to, from, flags)       -> rows changed

import {
  BOT_SUSPENDED_NOTICE, BOT_REACTIVATED, persistentKeyboard, OWNER_KEYBOARD_LABELS, STAFF_KEYBOARD_LABELS,
} from './content.js';
import { BILLING_SUSPENDED_NOTICE } from './billing.js';
import { ACTIVE_STATUSES, SUSPENDED_STATUSES } from './db.js';

/** A promise's outcome as a value: a notice that fails must never throw. */
const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
/** Whether a send reached its service and was accepted. */
export const sendFailed = (r) => !!(r.error || !(r.value && r.value.ok));

/**
 * Suspend one business. `rows` are its bound phones (as read by the caller a
 * moment ago). In this order:
 *   (a) one plain notice to every bound phone, with ReplyKeyboardRemove on the
 *       same message, and one plain email to the owner address, BEFORE the
 *       status changes. A notice or an email that fails is counted and blocks
 *       nothing. A business with no owner address has no email to fail.
 *   (b) the status goes to 'paused' in ONE update scoped by the id AND the
 *       statuses in `from`, so a second call (or a race) changes nothing.
 *
 * `forBilling` is the only difference between the operator's Suspend and the
 * billing job's: the notice says payment was not received, and the same
 * update sets suspended_for_billing. A manual Suspend never sets that flag
 * (and clears one the row still carries, so the screen cannot say "for
 * non-payment" about a suspension the operator made by hand).
 *
 * Returns { changed, failed, phones }: whether the status was written by THIS
 * call, how many notices failed, how many phones there were.
 */
export async function suspendBusiness({ business, rows, forBilling = false, from = ACTIVE_STATUSES }, io) {
  const notice = forBilling ? BILLING_SUSPENDED_NOTICE : BOT_SUSPENDED_NOTICE;
  const [sent, mail] = await Promise.all([
    Promise.all(rows.map((r) => settle(
      io.sendMessage(r.tg_chat_id, notice, { reply_markup: { remove_keyboard: true } })))),
    settle(io.sendSuspensionEmail({ business, text: notice, billing: forBilling })),
  ]);
  const noAddress = !!(mail.value && mail.value.status === 'no_owner_email');
  const failed = sent.filter(sendFailed).length + (!noAddress && sendFailed(mail) ? 1 : 0);
  // No flag in the statement unless one has to change: a database without the
  // billing columns (migration 0006 not applied) must still suspend.
  let flags = null;
  if (forBilling) flags = { suspended_for_billing: true };
  else if (business.suspended_for_billing) flags = { suspended_for_billing: false };
  const changed = await io.setBusinessStatus(business.id, 'paused', from, flags);
  return { changed: changed > 0, failed, phones: rows.length };
}

/**
 * Reactivate, step 1: the status goes to 'active' in ONE update scoped by the
 * id AND the suspended statuses, so a second call changes nothing. A business
 * that was suspended for non-payment loses that flag in the same statement.
 * paid_until is never touched here. Returns whether THIS call changed it.
 */
export async function reactivateStatus(business, io) {
  const flags = business.suspended_for_billing ? { suspended_for_billing: false } : null;
  return (await io.setBusinessStatus(business.id, 'active', SUSPENDED_STATUSES, flags)) > 0;
}

/**
 * Reactivate, step 2: every bound phone is told, with its own role keyboard
 * on the same message (the main phone is the oldest binding, the first row).
 * Returns one settled promise per phone; a notice that fails blocks nothing.
 */
export function reactivationNotices(rows, io) {
  return rows.map((r, i) => settle(io.sendMessage(r.tg_chat_id, BOT_REACTIVATED, {
    reply_markup: persistentKeyboard(i === 0 ? OWNER_KEYBOARD_LABELS : STAFF_KEYBOARD_LABELS),
  })));
}

/** Both steps. Returns { changed, failed, phones }; no notice is sent unless
 *  this call is the one that changed the status. */
export async function reactivateBusiness({ business, rows }, io) {
  if (!(await reactivateStatus(business, io))) return { changed: false, failed: 0, phones: rows.length };
  const sent = await Promise.all(reactivationNotices(rows, io));
  return { changed: true, failed: sent.filter(sendFailed).length, phones: rows.length };
}
