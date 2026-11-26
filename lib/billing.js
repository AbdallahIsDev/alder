// lib/billing.js — the lifecycle rules, and nothing else.
//
// PURE: no database, no network, no environment, no clock of its own (every
// function takes `now`). The daily job (lib/billing-ops.js), the operator
// screens and the owner bot (api/tg.js), the lead endpoint and a future
// payment webhook all decide through these functions, so they cannot disagree
// about what "overdue" means. Every duration comes from lib/lifecycle-config.js.
//
// D = businesses.paid_until, the moment the paid period ends (UTC).
//   D is NULL        not billing-enforced: never warned, suspended or terminated.
//   paid             now <  D - 3 d
//   due_soon         D - 3 d <= now < D
//   grace            D <= now < D + 5 d          everything still works
//   suspended        D + 5 d <= now < D + 15 d
//   terminated       now >= D + 15 d
// Every boundary is inclusive on the left and exclusive on the right.
//
// Dates are shown in UTC as "Dec 14" (no year: a period is 30 days).

import {
  RENEWAL_REMINDER_DAYS, GRACE_DAYS, TERMINATE_AFTER_DAYS, EXTEND_DAYS,
  FINAL_WARNING_DAYS_BEFORE, TERMINATION_WARNING_DAYS_BEFORE, NOTICE_JITTER_MS,
} from './lifecycle-config.js';

export { RENEWAL_REMINDER_DAYS, GRACE_DAYS, EXTEND_DAYS };
export const DAY_MS = 86400000;
/** "Due soon" in the operator's summary: the renewal-reminder window. */
export const DUE_SOON_DAYS = RENEWAL_REMINDER_DAYS;

/** billing_warning_stage: the LAST notice the business was sent in this paid
 *  period. A payment puts it back to 0. Each notice is sent once. */
export const STAGE_NONE = 0;
export const STAGE_REMINDER = 1;             // renewal reminder        (D - 3 d)
export const STAGE_OVERDUE = 2;              // overdue notice          (D)
export const STAGE_FINAL = 3;                // final warning           (D + 4 d)
export const STAGE_SUSPENDED = 4;            // suspension notice       (D + 5 d)
export const STAGE_TERMINATION_WARNING = 5;  // termination warning     (D + 10 d)
export const STAGE_TERMINATED = 6;           // termination notice      (D + 15 d)

/** The notice each stage stands for. These strings are also the `type` of a
 *  business_events row (migration 0007). */
export const NOTICE_TYPES = Object.freeze({
  [STAGE_REMINDER]: 'renewal_reminder',
  [STAGE_OVERDUE]: 'overdue',
  [STAGE_FINAL]: 'final_warning',
  [STAGE_SUSPENDED]: 'suspension',
  [STAGE_TERMINATION_WARNING]: 'termination_warning',
  [STAGE_TERMINATED]: 'termination',
});

/** A date as milliseconds, or null for "no date": null, undefined, '' and
 *  anything that is not a date. Never throws and never returns NaN. */
export function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) { const t = value.getTime(); return Number.isFinite(t) ? t : null; }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

export function stageOf(business) {
  const n = Number(business && business.billing_warning_stage);
  return Number.isInteger(n) && n >= STAGE_NONE && n <= STAGE_TERMINATED ? n : STAGE_NONE;
}

/**
 * Where a business stands at `now`, by its dates alone:
 *   { state: 'not_enforced' }                                 paid_until is null
 *   { state, paidUntil, suspendAt, terminateAt, endsAt, daysLeft }
 * with state one of paid | due_soon | grace | suspended | terminated.
 *   suspendAt    paid_until + GRACE_DAYS
 *   terminateAt  paid_until + GRACE_DAYS + SUSPENDED_DAYS
 *   endsAt       when the CURRENT state ends: paid_until while paid or due
 *                soon, suspendAt in grace, terminateAt while suspended (and,
 *                once terminated, the moment it was).
 *   daysLeft     whole days until endsAt, rounded up; 0 once terminated.
 * All moments are milliseconds. The business STATUS is not part of this
 * answer: it says what the dates say, and the caller decides whom the rules
 * apply to (billingDecision below).
 */
export function billingState(business, now = Date.now()) {
  const paidUntil = toMs(business && business.paid_until);
  if (paidUntil === null) return { state: 'not_enforced' };
  const t = toMs(now);
  const suspendAt = paidUntil + GRACE_DAYS * DAY_MS;
  const terminateAt = paidUntil + TERMINATE_AFTER_DAYS * DAY_MS;
  let state;
  let endsAt;
  if (t < paidUntil - RENEWAL_REMINDER_DAYS * DAY_MS) { state = 'paid'; endsAt = paidUntil; }
  else if (t < paidUntil) { state = 'due_soon'; endsAt = paidUntil; }
  else if (t < suspendAt) { state = 'grace'; endsAt = suspendAt; }
  else if (t < terminateAt) { state = 'suspended'; endsAt = terminateAt; }
  else { state = 'terminated'; endsAt = terminateAt; }
  const daysLeft = Math.max(0, Math.ceil((endsAt - t) / DAY_MS));
  return { state, paidUntil, suspendAt, terminateAt, endsAt, daysLeft };
}

/**
 * The end of the paid period after one payment of `days` days:
 * max(current, now) + days. A business that is still paid keeps the days it
 * has; one that is overdue (or was never billed) starts from now, so a late
 * payment starts a fresh period and is never eaten by the days already
 * missed. Whole seconds, so the value survives a round trip through a button.
 * Returns milliseconds.
 */
export function nextPaidUntil(current, now = Date.now(), days = EXTEND_DAYS) {
  const base = Math.max(toMs(current) === null ? -Infinity : toMs(current), toMs(now));
  return Math.floor((base + days * DAY_MS) / 1000) * 1000;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Dec 14", in UTC. '?' for no date. */
export function billingDate(value) {
  const t = toMs(value);
  if (t === null) return '?';
  const d = new Date(t);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** "1 day" / "3 days". */
export function daysText(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  return `${v} day${v === 1 ? '' : 's'}`;
}

/** Whether the daily job may act on this business at all: it has a
 *  paid_until, it is not a demo, and it was not suspended or terminated BY
 *  HAND (paused or churned without suspended_for_billing). */
export function billingEnforced(business) {
  if (!business || toMs(business.paid_until) === null) return false;
  const status = String(business.status || '');
  if (status === 'active') return true;
  if (status === 'paused' || status === 'churned') return business.suspended_for_billing === true;
  return false;
}

/**
 * What the daily job does with ONE business, as a value. The whole decision
 * table is this function (stage = billing_warning_stage, the last notice sent):
 *
 *   not enforced (no paid_until, demo, suspended or terminated by hand)   none
 *
 *   status active
 *     paid         stage 0                                    none
 *     paid         stage > 0                                  reset (stage -> 0)
 *     due_soon     stage 0                                    notice renewal_reminder  (-> 1)
 *     due_soon     stage 1                                    none
 *     due_soon     stage > 1                                  reset (stage -> 0)
 *     grace        before D + 4 d, stage < 2                  notice overdue           (-> 2)
 *     grace        from D + 4 d,   stage < 3                  notice final_warning     (-> 3)
 *     grace        otherwise                                  none
 *     suspended                                               suspend   + suspension notice   (-> 4)
 *     terminated                                              terminate + termination notice  (-> 6)
 *
 *   status paused, suspended for billing
 *     paid | due_soon | grace                                 restore (a payment moved D)
 *     suspended    from D + 10 d, stage < 5                   notice termination_warning (-> 5)
 *     suspended    stage < 4                                  notice suspension, again (-> 4)
 *     suspended    otherwise                                  none
 *     terminated                                              terminate + termination notice  (-> 6)
 *
 *   status churned, terminated for billing
 *     paid | due_soon | grace                                 restore
 *     stage < 6                                               notice termination, again (-> 6)
 *     otherwise                                               none
 *
 * After missed days only the CURRENT state's notice is sent (a business found
 * in D + 12 d gets the termination warning, never the reminder it missed),
 * and a transition never waits for a notice: suspend and terminate follow the
 * dates alone. "Again" rows exist only for a notice that reached nobody.
 * A warning may go out NOTICE_JITTER_MS before its exact moment (see the
 * config); a suspension or termination never does.
 *
 * Returns { action, notice, stage, ...billingState }: `notice` is the notice
 * type to send (null for none / reset / restore) and `stage` the stage to
 * record once it was sent.
 */
export function billingDecision(business, now = Date.now()) {
  const s = billingState(business, now);
  const out = (action, stage = null) => ({ action, notice: stage === null ? null : NOTICE_TYPES[stage], stage, ...s });
  if (!billingEnforced(business)) return out('none');
  const status = String(business.status);
  const stage = stageOf(business);
  const t = toMs(now);
  const paidAgain = s.state === 'paid' || s.state === 'due_soon' || s.state === 'grace';

  if (status === 'active') {
    if (s.state === 'paid') return out(stage === STAGE_NONE ? 'none' : 'reset');
    if (s.state === 'due_soon') {
      if (stage === STAGE_NONE) return out('notice', STAGE_REMINDER);
      return out(stage === STAGE_REMINDER ? 'none' : 'reset');
    }
    if (s.state === 'grace') {
      const finalFrom = s.suspendAt - FINAL_WARNING_DAYS_BEFORE * DAY_MS - NOTICE_JITTER_MS;
      if (t >= finalFrom) return stage < STAGE_FINAL ? out('notice', STAGE_FINAL) : out('none');
      return stage < STAGE_OVERDUE ? out('notice', STAGE_OVERDUE) : out('none');
    }
    return s.state === 'suspended' ? out('suspend', STAGE_SUSPENDED) : out('terminate', STAGE_TERMINATED);
  }

  if (paidAgain) return out('restore');
  if (status === 'paused') {
    if (s.state === 'terminated') return out('terminate', STAGE_TERMINATED);
    const warnFrom = s.terminateAt - TERMINATION_WARNING_DAYS_BEFORE * DAY_MS - NOTICE_JITTER_MS;
    if (t >= warnFrom) return stage < STAGE_TERMINATION_WARNING ? out('notice', STAGE_TERMINATION_WARNING) : out('none');
    return stage < STAGE_SUSPENDED ? out('notice', STAGE_SUSPENDED) : out('none');
  }
  // churned, terminated for billing
  return stage < STAGE_TERMINATED ? out('notice', STAGE_TERMINATED) : out('none');
}

/** paid_until is still ahead, by RENEWAL_REMINDER_DAYS or less. */
export function dueSoon(business, now = Date.now()) {
  return billingState(business, now).state === 'due_soon';
}

/* ---------- what the operator reads ---------- */

/**
 * The ONE billing line of the operator's business screen:
 *   Billing: not tracked                             paid_until is null
 *   Paid until: Dec 14
 *   Paid until: Dec 14 · due in 2 days               the reminder window
 *   Overdue since Dec 14 · suspends Dec 19           in grace
 *   Suspended since Dec 19 · terminates Dec 29       suspended for billing
 *   Terminated Dec 29                                terminated for billing
 *   Billing: unavailable                             the columns do not exist yet
 * A business suspended or terminated BY HAND, and a demo, show their dates
 * without a consequence, because the daily job never acts on them.
 */
export function billingLine(business, now = Date.now()) {
  if (!business || business.billing_unavailable) return 'Billing: unavailable';
  const s = billingState(business, now);
  if (s.state === 'not_enforced') return 'Billing: not tracked';
  const until = billingDate(s.paidUntil);
  const status = String(business.status || '');
  const forBilling = business.suspended_for_billing === true;
  const paidLine = s.state === 'paid' ? `Paid until: ${until}`
    : s.state === 'due_soon' ? `Paid until: ${until} · due in ${daysText(s.daysLeft)}`
      : `Overdue since ${until}`;
  if (status === 'churned') return forBilling ? `Terminated ${billingDate(s.terminateAt)}` : paidLine;
  if (status === 'paused') {
    return forBilling ? `Suspended since ${billingDate(s.suspendAt)} · terminates ${billingDate(s.terminateAt)}` : paidLine;
  }
  if (status !== 'active') return `${paidLine} · not enforced`;
  if (s.state === 'grace') return `${paidLine} · suspends ${billingDate(s.suspendAt)}`;
  if (s.state === 'suspended') return `${paidLine} · suspends today`;
  if (s.state === 'terminated') return `${paidLine} · terminates today`;
  return paidLine;
}

const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
export const businessNameOf = (business) => clean((business && (business.name || business.slug)) || 'your business');

/**
 * The operator's daily summary, or null when this run did nothing new. One
 * short message, business names only (no phone, no address, no amount), one
 * name per line:
 *   terminated    terminated by this run
 *   suspended     suspended by this run
 *   restored      put back in service by this run (a payment was recorded)
 *   warned        got a notice in this run: [{ business, notice }]
 *   undelivered   a notice was due and nobody could be reached (retried tomorrow)
 *   failed        a step could not be completed (retried tomorrow)
 * and, added only when one of the above is not empty:
 *   grace         in the grace period now
 *   due           paid_until within RENEWAL_REMINDER_DAYS
 *   held          suspended businesses with held leads: [{ business, count }]
 */
export function billingSummaryText({
  terminated = [], suspended = [], restored = [], warned = [], undelivered = [], failed = [],
  grace = [], due = [], held = [],
} = {}) {
  if (!(terminated.length + suspended.length + restored.length + warned.length + undelivered.length + failed.length)) return null;
  const lines = ['Billing today'];
  const block = (title, rows) => { if (rows.length) lines.push('', title, ...rows); };
  const names = (list) => list.map((b) => businessNameOf(b.business || b));
  block('Newly terminated:', names(terminated));
  block('Newly suspended:', names(suspended));
  block('Back in service:', names(restored));
  block('Newly warned:', names(warned));
  block('Notice not delivered:', names(undelivered));
  block('Not completed, retried tomorrow:', names(failed));
  block('In grace:', names(grace));
  block(`Due within ${daysText(DUE_SOON_DAYS)}:`, names(due));
  block('Suspended, held leads:', held.map((h) => `${businessNameOf(h.business)}: ${h.count}`));
  return lines.join('\n');
}

/* ---------- the Extend button ---------- */

/** A paid-until moment as the short token a button carries (whole seconds,
 *  base 36), and back. decode answers null for anything else. */
export function encodePaidUntil(ms) {
  return Math.floor(toMs(ms) / 1000).toString(36);
}
export function decodePaidUntil(token) {
  if (!/^[0-9a-z]{1,8}$/.test(String(token || ''))) return null;
  const seconds = parseInt(String(token), 36);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/**
 * Whether a target carried by a Confirm button may still be applied at `now`:
 * it must lie in the future, and no further than one press could reach
 * (max(current, now) + days). A button can therefore never add more than one
 * period, however old it is and however often it is pressed.
 */
export function extendTargetAllowed(target, current, now = Date.now(), days = EXTEND_DAYS) {
  const t = toMs(target);
  if (t === null) return false;
  // A Confirm minted days ago for an unbilled or overdue business can still be
  // in the future, but applying it would grant fewer than `days`. The lower
  // bound keeps the button honest: an exact period or nothing.
  const expected = nextPaidUntil(current, now, days);
  const currentMs = toMs(current);
  // The exact current end is the double-tap: it must reach applyPayment, which
  // answers "Already extended." without changing the row.
  const freshPeriod = t <= expected && t >= expected - 1000;
  // Any date at or below the stored end is a harmless stale/double tap: the
  // payment path will refuse it. Dates in between would buy a partial period.
  const staleHarmless = currentMs !== null && t <= currentMs;
  return t > toMs(now) && (freshPeriod || staleHarmless);
}
