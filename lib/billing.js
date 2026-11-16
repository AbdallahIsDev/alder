// lib/billing.js — the billing rules, and nothing else.
//
// PURE: no database, no network, no environment, no clock of its own (every
// function takes `now`). The daily job (lib/billing-ops.js), the operator
// screens (api/tg.js) and a future payment webhook all decide through these
// functions, so they cannot disagree about what "overdue" means.
//
// The rules:
//   - businesses.paid_until is the moment the paid period ends (UTC).
//   - paid_until NULL means the business is NOT billing-enforced: nothing here
//     ever warns or suspends it (demo and legacy businesses).
//   - After paid_until there is a grace period of GRACE_DAYS. During it the
//     service keeps running and the business is warned.
//   - At the end of the grace period the service is suspended.
//
// Boundaries, exactly: paid while now < paid_until; in grace while
// paid_until <= now < paid_until + GRACE_DAYS; expired from then on.
//
// Dates are shown in UTC as "Dec 14" (no year: a period is 30 days).

export const DAY_MS = 86400000;
/** Days of service after paid_until before the business is suspended. */
export const GRACE_DAYS = 7;
/** What one press of "Extend 30 days" adds. */
export const EXTEND_DAYS = 30;
/** The final warning goes out when a day or less of the grace period is left.
 *  "A day" is 25 hours here: a daily cron may fire anywhere inside its hour,
 *  and a run that comes a few minutes early must not find "a day and five
 *  minutes" left, skip the final warning, and leave the next run to suspend. */
export const FINAL_WARNING_MS = DAY_MS + 3600000;
/** "Due soon" in the operator's summary: paid_until is within this many days. */
export const DUE_SOON_DAYS = 3;

/** billing_warning_stage: what the business has already been told. */
export const STAGE_NONE = 0;
export const STAGE_OVERDUE = 1;
export const STAGE_FINAL = 2;

/** A date as milliseconds, or null for "no date": null, undefined, '' and
 *  anything that is not a date. Never throws and never returns NaN. */
export function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) { const t = value.getTime(); return Number.isFinite(t) ? t : null; }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

const stageOf = (business) => {
  const n = Number(business && business.billing_warning_stage);
  return n === STAGE_OVERDUE || n === STAGE_FINAL ? n : STAGE_NONE;
};

/**
 * Where a business stands at `now`:
 *   { state: 'not_enforced' }                        paid_until is null
 *   { state: 'paid',    paidUntil, graceEnd }        now < paid_until
 *   { state: 'grace',   paidUntil, graceEnd }        paid_until <= now < graceEnd
 *   { state: 'expired', paidUntil, graceEnd }        now >= graceEnd
 * paidUntil and graceEnd are milliseconds. The business status is NOT part of
 * this answer: it says what the dates say, and the caller decides whom the
 * rules apply to (the daily job: status 'active' only).
 */
export function billingState(business, now = Date.now()) {
  const paidUntil = toMs(business && business.paid_until);
  if (paidUntil === null) return { state: 'not_enforced' };
  const t = toMs(now);
  const graceEnd = paidUntil + GRACE_DAYS * DAY_MS;
  if (t < paidUntil) return { state: 'paid', paidUntil, graceEnd };
  if (t < graceEnd) return { state: 'grace', paidUntil, graceEnd };
  return { state: 'expired', paidUntil, graceEnd };
}

/**
 * The end of the paid period after one payment of `days` days:
 * max(current, now) + days. A business that is still paid keeps the days it
 * has; one that is overdue (or was never billed) starts from now, so a late
 * payment is never eaten by the days already missed. Whole seconds, so the
 * value survives a round trip through a button. Returns milliseconds.
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

/**
 * What the daily job does with ONE business, as a value. The whole decision
 * table is this function:
 *
 *   not billed (paid_until null), or status not 'active'   none
 *   paid,    stage 0                                       none
 *   paid,    stage 1 or 2                                  reset   (stage -> 0)
 *   grace,   more than a day left, stage 0                 warn    (-> stage 1)
 *   grace,   more than a day left, stage 1 or 2            none
 *   grace,   a day or less left,   stage 0 or 1            final   (-> stage 2)
 *   grace,   a day or less left,   stage 2                 none
 *   expired                                                suspend
 *
 * Returns { action, state, paidUntil, graceEnd }.
 */
export function billingDecision(business, now = Date.now()) {
  const s = billingState(business, now);
  const out = (action) => ({ action, ...s });
  if (s.state === 'not_enforced') return out('none');
  if (!business || business.status !== 'active') return out('none');
  const stage = stageOf(business);
  if (s.state === 'paid') return out(stage === STAGE_NONE ? 'none' : 'reset');
  if (s.state === 'expired') return out('suspend');
  const left = s.graceEnd - toMs(now);
  if (left <= FINAL_WARNING_MS) return out(stage < STAGE_FINAL ? 'final' : 'none');
  return out(stage === STAGE_NONE ? 'warn' : 'none');
}

/** paid_until is still ahead, by DUE_SOON_DAYS or less. */
export function dueSoon(business, now = Date.now()) {
  const s = billingState(business, now);
  return s.state === 'paid' && s.paidUntil - toMs(now) <= DUE_SOON_DAYS * DAY_MS;
}

/* ---------- what the business is told ---------- */

const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const nameOf = (business) => clean((business && (business.name || business.slug)) || 'your business');

/** The overdue warning (stage 1). `graceEnd` is when the service stops. */
export function overdueWarningText(business, graceEnd) {
  return `Payment for ${nameOf(business)} is overdue. Your service will be suspended on ${billingDate(graceEnd)} unless payment is received. Contact support.`;
}
/** The final warning (stage 2): the same facts, said as the last notice. */
export function finalWarningText(business, graceEnd) {
  return `Final notice: payment for ${nameOf(business)} is overdue. Your service will be suspended on ${billingDate(graceEnd)} unless payment is received. Contact support.`;
}
/** What every phone (and the owner address) gets when the job suspends. */
export const BILLING_SUSPENDED_NOTICE = 'Your service has been suspended because payment was not received. Contact support.';

export const BILLING_OVERDUE_SUBJECT = 'Payment overdue';
export const BILLING_FINAL_SUBJECT = 'Final notice: payment overdue';

/* ---------- what the operator reads ---------- */

/**
 * The billing line of the operator's business screen:
 *   Billing: not tracked                               paid_until is null
 *   Paid until: Dec 14
 *   Paid until: Dec 14 (overdue, suspends Dec 21)      in grace
 *   Paid until: Dec 14 (overdue, suspends at the next daily check)
 *   Suspended for non-payment · paid until Dec 14      suspended by the job
 *   Paid until: Dec 14 (ended)                         suspended by hand, period over
 *   Paid until: Dec 14 (demo: not enforced)
 *   Billing: unavailable                               the columns do not exist yet
 */
export function billingLine(business, now = Date.now()) {
  if (!business || business.billing_unavailable) return 'Billing: unavailable';
  const s = billingState(business, now);
  if (s.state === 'not_enforced') return 'Billing: not tracked';
  const until = billingDate(s.paidUntil);
  const status = String(business.status || '');
  const suspended = status === 'paused' || status === 'churned';
  if (suspended && business.suspended_for_billing) return `Suspended for non-payment · paid until ${until}`;
  if (status === 'demo') return `Paid until: ${until} (demo: not enforced)`;
  if (s.state === 'paid') return `Paid until: ${until}`;
  if (suspended) return `Paid until: ${until} (ended)`;
  if (s.state === 'grace') return `Paid until: ${until} (overdue, suspends ${billingDate(s.graceEnd)})`;
  return `Paid until: ${until} (overdue, suspends at the next daily check)`;
}

const names = (list) => list.map((b) => nameOf(b));

/**
 * The operator's daily summary, or null when there is nothing to say.
 * Business names only: no phone, no address, no amount.
 *   suspended     suspended by this run
 *   warned        got the overdue warning in this run
 *   finalWarned   got the final warning in this run
 *   unwarned      a warning was due and nobody could be reached (tried again tomorrow)
 *   failed        a step could not be completed (tried again tomorrow)
 *   grace         in the grace period now: [{ business, graceEnd }]
 *   due           paid_until within DUE_SOON_DAYS: [{ business, paidUntil }]
 */
export function billingSummaryText({ suspended = [], warned = [], finalWarned = [], unwarned = [], failed = [], grace = [], due = [] } = {}) {
  const lines = [];
  if (suspended.length) lines.push(`Suspended for non-payment: ${names(suspended).join(', ')}`);
  if (finalWarned.length) lines.push(`Final warning sent: ${names(finalWarned).join(', ')}`);
  if (warned.length) lines.push(`Overdue warning sent: ${names(warned).join(', ')}`);
  if (unwarned.length) lines.push(`Could not be warned (no notice delivered): ${names(unwarned).join(', ')}`);
  if (failed.length) lines.push(`Not completed, tried again tomorrow: ${names(failed).join(', ')}`);
  if (grace.length) lines.push(`Overdue: ${grace.map((g) => `${nameOf(g.business)} (suspends ${billingDate(g.graceEnd)})`).join(', ')}`);
  if (due.length) lines.push(`Due within ${DUE_SOON_DAYS} days: ${due.map((g) => `${nameOf(g.business)} (${billingDate(g.paidUntil)})`).join(', ')}`);
  return lines.length ? ['Billing', '', ...lines].join('\n') : null;
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
  return t > toMs(now) && t <= nextPaidUntil(current, now, days);
}
