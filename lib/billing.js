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

/* ---------- the ONE status formatter ----------
   The operator's business screen (Part 1 of the UI/UX pass) and the owner's
   /status (Part 2f) are drawn from the same facts, so they cannot disagree
   about what state a business is in or how many days are left. Two callers,
   one function: `statusLines()` returns the facts as a small object, and
   `statusBlock()` renders them as the lines both screens use. Nothing here
   reads the clock: every date and every countdown is relative to `now`. */

/**
 * "today" / "tomorrow" / "in N days". The ONE way a countdown is phrased, so
 * no screen can say "in 0 days" or "in 1 days".
 */
export function inDays(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v === 0) return 'today';
  if (v === 1) return 'tomorrow';
  return `in ${v} days`;
}

/**
 * The lifecycle facts of one business, as values. Both the operator's
 * business screen and the owner's /status are drawn from this object, so they
 * cannot disagree about the state or the countdown.
 *
 *   state    paid | due_soon | grace | suspended_billing | suspended_manual |
 *            terminated | not_tracked
 *   badge    the word after "Status:" on either screen
 *   lines    every line AFTER `Status: <badge>`, in order. One fact per line.
 *
 * The exact wording of each state (the block the operator reads):
 *
 *   Paid                   Status: Paid
 *                          Next: Due soon in 20 days
 *                          Paid until: Dec 14
 *   Due soon               Status: Due soon
 *                          Next: Overdue in 2 days
 *                          Paid until: Dec 14
 *   Grace                  Status: Overdue (grace)
 *                          Next: Suspension in 4 days
 *                          Paid until: Dec 14
 *   Suspended (payment)    Status: Suspended (payment)
 *                          Next: Termination in 9 days
 *                          Terminates: Dec 29
 *   Suspended (manual)     Status: Suspended (manual)
 *                          Next: none (manual hold)
 *   Terminated             Status: Terminated
 *                          Terminated: Dec 29
 *   Terminated by hand     Status: Terminated
 *                          (no line: there is no date to show)
 *   Not tracked            Status: Not tracked
 *                          No payment date recorded
 *   Billing unavailable    Status: Billing unavailable
 *                          No payment data available
 *
 * A demo business, a business with no paid date and a business suspended or
 * terminated BY HAND are all "not tracked" for these purposes: their dates,
 * if any, are never shown as if the billing rules were running.
 *
 * Nothing here reads the clock: every date and countdown is relative to `now`.
 */
export function statusFacts(business, now = Date.now()) {
  const status = String((business && business.status) || '');
  const s = billingState(business, now);
  // A business the billing rules do not apply to (no paid date, a demo, or a
  // suspension or termination made by hand) is NEVER described with the dates
  // it happens to carry: that is how a demo business used to read
  // "Terminated: Nov 23". The state says which of the three it is.
  const enforced = billingEnforced(business) && !(business && business.billing_unavailable);
  const forBilling = !!(business && business.suspended_for_billing === true);
  const t = toMs(now);
  const daysTo = (ms) => Math.max(0, Math.ceil((ms - t) / DAY_MS));

  if (business && business.billing_unavailable) {
    return { tracked: false, state: 'unavailable', badge: 'Billing unavailable', lines: ['No payment data available'] };
  }
  if (!enforced) {
    // A termination made by hand has no date, and the screen must not invent
    // one (Extend is the way back, not a date in the past).
    if (status === 'churned') return { tracked: false, state: 'terminated', badge: 'Terminated', lines: [] };
    if (status === 'paused') return { tracked: false, state: 'suspended_manual', badge: 'Suspended (manual)', lines: ['Next: none (manual hold)'] };
    return { tracked: false, state: 'not_tracked', badge: 'Not tracked', lines: ['No payment date recorded'] };
  }

  if (status === 'churned') {
    return { tracked: true, state: 'terminated', badge: 'Terminated', lines: [`Terminated: ${billingDate(s.terminateAt)}`] };
  }
  if (status === 'paused') {
    return forBilling
      ? {
        tracked: true, state: 'suspended_billing', badge: 'Suspended (payment)',
        lines: [`Next: Termination ${inDays(daysTo(s.terminateAt))}`, `Terminates: ${billingDate(s.terminateAt)}`],
      }
      : { tracked: true, state: 'suspended_manual', badge: 'Suspended (manual)', lines: ['Next: none (manual hold)'] };
  }

  // In service: the dates decide the words, whatever the status column says.
  if (s.state === 'paid') {
    return {
      tracked: true, state: 'paid', badge: 'Paid',
      lines: [`Next: Due soon ${inDays(daysTo(s.paidUntil - RENEWAL_REMINDER_DAYS * DAY_MS))}`, `Paid until: ${billingDate(s.paidUntil)}`],
    };
  }
  if (s.state === 'due_soon') {
    return {
      tracked: true, state: 'due_soon', badge: 'Due soon',
      lines: [`Next: Overdue ${inDays(daysTo(s.paidUntil))}`, `Paid until: ${billingDate(s.paidUntil)}`],
    };
  }
  if (s.state === 'grace') {
    return {
      tracked: true, state: 'grace', badge: 'Overdue (grace)',
      lines: [`Next: Suspension ${inDays(daysTo(s.suspendAt))}`, `Paid until: ${billingDate(s.paidUntil)}`],
    };
  }
  // The dates say suspended or terminated but the status column has not been
  // caught up by a daily run yet. Say what the dates say; the run will agree.
  if (s.state === 'suspended') {
    return {
      tracked: true, state: 'suspended_billing', badge: 'Suspended (payment)',
      lines: [`Next: Termination ${inDays(daysTo(s.terminateAt))}`, `Terminates: ${billingDate(s.terminateAt)}`],
    };
  }
  return { tracked: true, state: 'terminated', badge: 'Terminated', lines: [`Terminated: ${billingDate(s.terminateAt)}`] };
}

/**
 * The status block both screens show: `Status: <badge>` and the facts under
 * it. `held` adds a count line only when it is a positive number, and it is
 * never a detail.
 */
export function statusLines(business, { now = Date.now(), held = null, heldLabel = 'Held leads' } = {}) {
  const f = statusFacts(business, now);
  const out = [`Status: ${f.badge}`, ...f.lines];
  if (held !== null && held !== undefined && Number(held) > 0) out.push(`${heldLabel}: ${Number(held)}`);
  return out;
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
  const first = String(token || '').split('.')[0];
  if (!/^[0-9a-z]{1,8}$/.test(first)) return null;
  const seconds = parseInt(first, 36);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/** An Extend Confirm also carries the moment the question was shown, so the
 *  button can expire even though its paid-until target is still in the future. */
export const EXTEND_TOKEN_WINDOW_MS = 10 * 60 * 1000;

export function encodeExtendToken(ms, mintMs = Date.now()) {
  const target = toMs(ms), mint = toMs(mintMs);
  if (target === null || mint === null) return '';
  return `${Math.floor(target / 1000).toString(36)}.${Math.floor(mint / 1000).toString(36)}`;
}

export function decodeExtendToken(token) {
  const parts = /^([0-9a-z]{1,8})\.([0-9a-z]{1,8})$/.exec(String(token || ''));
  if (!parts) return null;
  const target = parseInt(parts[1], 36) * 1000, mint = parseInt(parts[2], 36) * 1000;
  return Number.isFinite(target) && Number.isFinite(mint) ? { target, mint } : null;
}

export function extendTokenExpired(parsed, now = Date.now()) {
  const mint = parsed && toMs(parsed.mint);
  return mint === null || now - mint > EXTEND_TOKEN_WINDOW_MS;
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
  // The token IS the period end computed when the operator pressed Extend. A
  // tap a few seconds (or days) later keeps that exact end, so the customer
  // still gets 30 days from the payment moment. Only a LATER end than one
  // period from now is forbidden; an earlier one is already accounted for.
  const expected = nextPaidUntil(current, now, days);
  const currentMs = toMs(current);
  const freshPeriod = t <= expected;
  // Any date at or below the stored end is a harmless stale/double tap: the
  // payment path will refuse it. Dates in between would buy a partial period.
  const staleHarmless = currentMs !== null && t <= currentMs;
  return t > toMs(now) && (freshPeriod || staleHarmless);
}
