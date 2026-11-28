// lib/service-status.js — switching one business's service off and on.
//
// ONE code path for every way a business is suspended, terminated or put back
// in service: the operator's Suspend, Terminate and Reactivate buttons
// (api/tg.js), the daily billing job and a recorded payment
// (lib/billing-ops.js). They differ only in WHO asked (`forBilling`, `reason`);
// what is written, what the business's phones are told, and in which order,
// is decided here.
//
// The order is always: the status first, in ONE update scoped by the id AND
// the statuses it may come from (so a second call, a double tap or a race
// changes nothing), then the notice, and only when THIS call changed the
// status. A notice that fails is logged, alerts the operator
// (lib/lifecycle-notify.js) and blocks nothing. Nothing is ever deleted.
//
// No I/O of its own: every call is a member of `io`.
//   io.setBusinessStatus(id, to, from, flags)   -> rows changed
//   io.listBusinessChatsDetailed(id)            -> the bound phones
//   io.countHeldLeads(id, sinceIso)             -> a count
//   io.lastBusinessEventAt(id, type)            -> an ISO time or null
//   plus what sendOwnerNotice needs.
//
// One optional member: io.sendHeldLeads({ business, rows, now }), the SECOND
// message of a reactivation (the held leads themselves). The webhook and the
// daily job pass it; a caller without it simply sends message 1.

import { persistentKeyboard, OWNER_KEYBOARD_LABELS, STAFF_KEYBOARD_LABELS } from './content.js';
import { ACTIVE_STATUSES, SUSPENDED_STATUSES } from './db.js';
import { toMs, DAY_MS, GRACE_DAYS } from './billing.js';
import { HELD_GROUP_DAYS } from './lifecycle-config.js';
import { ownerNotice, STATUS_BUTTON_LABEL } from './lifecycle-text.js';
import { sendOwnerNotice, sendFailed } from './lifecycle-notify.js';

export { sendFailed };

/** What a suspended or terminated business's phone keeps: one button. */
export const suspendedKeyboard = () => persistentKeyboard([STATUS_BUTTON_LABEL]);
/** The role keyboard of a phone in service (the main phone is the oldest
 *  binding, the first row). */
export const roleKeyboard = (index) => persistentKeyboard(index === 0 ? OWNER_KEYBOARD_LABELS : STAFF_KEYBOARD_LABELS);

/** The phones as { rows, unreadable }. A status change never waits for a
 *  notice: when the list cannot be read the notice still goes to the owner
 *  address, and `unreadable` makes sendOwnerNotice count one failed Telegram
 *  delivery, so the operator is alerted that no phone was told. */
async function phonesOf(business, rows, io) {
  if (Array.isArray(rows)) return { rows, unreadable: false };
  try { return { rows: (await io.listBusinessChatsDetailed(business.id)) || [], unreadable: false }; } catch {
    console.error('lifecycle_phones_unreadable');
    return { rows: [], unreadable: true };
  }
}

/** The billing flag to write with a status, or null when the statement must
 *  not name a billing column (a database without migration 0006). */
function billingFlag(business, forBilling) {
  if (forBilling) return { suspended_for_billing: true };
  return business.suspended_for_billing ? { suspended_for_billing: false } : null;
}

/**
 * Suspend one business: status -> 'paused', then the suspension notice to
 * every bound phone (with the one-button Status keyboard) and the owner
 * address. `forBilling` is the only difference between the operator's Suspend
 * and the billing job's: the notice gives payment as the reason and the
 * termination date, and the same update sets suspended_for_billing. A manual
 * Suspend always leaves that flag false, so the daily job never touches a
 * business the operator suspended by hand.
 *
 * Returns { changed, notice }: whether THIS call wrote the status, and the
 * notice's outcome (null when nothing changed, or with `notify: false`: the
 * daily job passes that when the business already got its one billing notice
 * today, because a transition never waits for a notice; the notice then goes
 * out with the next run).
 */
export async function suspendBusiness({ business, rows = null, forBilling = false, from = ACTIVE_STATUSES, now = Date.now(), notify = true }, io) {
  const changed = (await io.setBusinessStatus(business.id, 'paused', from, billingFlag(business, forBilling))) > 0;
  if (!changed) return { changed: false, notice: null };
  if (!notify) return { changed: true, notice: null };
  const after = { ...business, status: 'paused', suspended_for_billing: forBilling };
  const notice = await sendOwnerNotice(io, {
    business: after,
    ...(await phonesOf(business, rows, io)),
    notice: ownerNotice('suspension', { business: after, now, reason: forBilling ? 'billing' : 'manual' }),
    instance: toMs(now),
    keyboard: suspendedKeyboard,
  });
  return { changed: true, notice };
}

/**
 * Terminate one business: status -> 'churned', then the termination notice
 * to every bound phone and the owner address. The bot is reduced to /status,
 * the website form answers "unavailable", and NO data is deleted: the
 * business, its phones, its leads and its invites stay where they are, and
 * recording a payment (Extend) puts it back in service. The operator's
 * Terminate and the billing job's automatic termination are this function.
 */
export async function terminateBusiness({ business, rows = null, forBilling = false, from = [...ACTIVE_STATUSES, 'paused'], now = Date.now(), notify = true }, io) {
  const changed = (await io.setBusinessStatus(business.id, 'churned', from, billingFlag(business, forBilling))) > 0;
  if (!changed) return { changed: false, notice: null };
  if (!notify) return { changed: true, notice: null };
  const after = { ...business, status: 'churned', suspended_for_billing: forBilling };
  const notice = await sendOwnerNotice(io, {
    business: after,
    ...(await phonesOf(business, rows, io)),
    notice: ownerNotice('termination', { business: after, now, reason: forBilling ? 'billing' : 'manual' }),
    instance: toMs(now),
    keyboard: suspendedKeyboard,
  });
  return { changed: true, notice };
}

/**
 * How many leads are being held for a business: the ones stored since its
 * current suspension began. The start is the newest suspension in the notice
 * log; without the log (migration 0007 not applied, or nothing logged) it is
 * paid_until + the grace period for a billing suspension, and otherwise
 * every held lead counts. null when it cannot be read.
 */
export async function heldLeadCount(business, io) {
  if (!io.countHeldLeads) return null;
  try {
    let since = null;
    if (io.lastBusinessEventAt) {
      try { since = await io.lastBusinessEventAt(business.id, 'suspension'); } catch { since = null; }
    }
    if (!since && business.suspended_for_billing && toMs(business.paid_until) !== null) {
      since = new Date(toMs(business.paid_until) + GRACE_DAYS * DAY_MS).toISOString();
    }
    return await io.countHeldLeads(business.id, since);
  } catch {
    console.error('held_count_unreadable');
    return null;
  }
}

/**
 * The count for the "Received while suspended" GROUP in /leads. Unlike
 * heldLeadCount() (the renewal notice and the reactivation message, scoped to
 * the CURRENT suspension), this counts every held row still in the group: a
 * lead held in an earlier cycle stays grouped for HELD_GROUP_DAYS after the
 * reactivation that released it. The heading must list the same number the
 * group shows, not a smaller one from the newest suspension alone.
 *
 * `open` is the caller's heldGroupOpen() answer, so the reactivation log is
 * read once. 0 means no group; null means the count could not be read and the
 * caller falls back to the rows on the page.
 */
export async function heldGroupCount(business, io, open = true) {
  if (!io || !io.countHeldLeads) return null;
  if (open === false) return 0;
  try {
    return await io.countHeldLeads(business.id);
  } catch {
    console.error('held_count_unreadable');
    return null;
  }
}

/**
 * Whether the "Received while suspended" group still applies, judged from the
 * reactivation event and nothing else (no new column): the newest
 * `reactivation` round in the notice log, and HELD_GROUP_DAYS from it.
 *
 * No reactivation ever logged (migration 0007 not applied, a business that was
 * never suspended, or a log that could not be read) answers true: a page that
 * shows a held row for a business with no reactivation it can see is showing
 * the truth, and hiding the group would be the bigger mistake.
 */
export async function heldGroupOpen(business, io, now = Date.now()) {
  if (!io || !io.lastBusinessEventAt) return true;
  try {
    const at = await io.lastBusinessEventAt(business.id, 'reactivation');
    if (!at) return true;
    const t = toMs(at);
    return t === null || toMs(now) - t < HELD_GROUP_DAYS * DAY_MS;
  } catch {
    return true;
  }
}

/**
 * Put a suspended or terminated business back in service: status -> 'active'
 * in one update scoped by the id AND the suspended statuses (so a business
 * that was demo comes back as active, and a second call changes nothing),
 * clearing suspended_for_billing in the same statement.
 *
 * Then TWO messages, deliberately:
 *   1. "Your service is active again." — that and nothing else, with the
 *      normal role keyboard back on it, and the same by email. No "support
 *      reactivated it", no lead count, no /status line.
 *   2. When any lead was held, the held leads themselves, straight after, in
 *      /leads' own format and pagination, numbering and buttons included, so
 *      the owner does not have to go and ask.
 *
 * paid_until is never touched here: reactivating is not paying.
 *
 * `reason`: 'payment' (a recorded payment; `paidUntil` is the new date) or
 * 'manual' (the operator's Reactivate). Returns { changed, notice, held }.
 * `heldNotice` is the outcome of message 2 (null when there was nothing held,
 * and never a reason to fail the reactivation).
 */
export async function reactivateBusiness({ business, rows = null, reason = 'manual', paidUntil = null, now = Date.now() }, io) {
  // Counted before the status changes: afterwards nothing is "being held".
  const held = (await heldLeadCount(business, io)) || 0;
  const flags = business.suspended_for_billing ? { suspended_for_billing: false } : null;
  const changed = (await io.setBusinessStatus(business.id, 'active', SUSPENDED_STATUSES, flags)) > 0;
  if (!changed) return { changed: false, notice: null, held, heldNotice: null };
  const after = { ...business, status: 'active', suspended_for_billing: false };
  const phones = await phonesOf(business, rows, io);
  const notice = await sendOwnerNotice(io, {
    business: after,
    ...phones,
    notice: ownerNotice('reactivation', { business: after, now, reason, held, paidUntil }),
    instance: toMs(now),
    keyboard: (_row, i) => roleKeyboard(i),
  });
  // Message 2: the held leads, only when there are some. Best effort, and it
  // can never change the reactivation that already happened.
  let heldNotice = null;
  if (held > 0 && io.sendHeldLeads) {
    try {
      heldNotice = await io.sendHeldLeads({ business: after, rows: phones.rows, now });
    } catch (e) {
      console.error('held_release_failed', (e && e.code) || 'no_code');
      heldNotice = 'failed';
    }
  }
  return { changed: true, notice, held, heldNotice };
}
