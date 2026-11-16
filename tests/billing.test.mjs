#!/usr/bin/env node
// tests/billing.test.mjs — Gate BL (the billing rules).
// HARNESS: in-process, pure functions only. No network, no database, no clock:
// every case passes its own `now`.
//
// What it proves (lib/billing.js):
//   BL1  billingState: null / missing / unparseable paid_until is "not
//        enforced"; paid strictly before paid_until; grace from paid_until
//        itself up to (not including) paid_until + 7 days; expired from that
//        exact moment on; graceEnd is paid_until + 7 days; the status of the
//        business plays no part; every input type of a date is accepted
//   BL2  nextPaidUntil = max(current, now) + days: a paid business keeps its
//        days, an overdue or unbilled one starts from now; whole seconds;
//        month ends, a leap day and a year end land on the right date
//   BL3  billingDate: "Dec 14" in UTC whatever the local zone; no padding
//   BL4  the notice texts, to the character
//   BL5  billingDecision: the whole decision table, including every boundary
//        of the final-warning window, and that only status 'active' is ever
//        acted on (demo, paused, churned, unknown: none)
//   BL6  billingLine: every line the operator can see
//   BL7  billingSummaryText: null when nothing happened; names only; the
//        order and wording of each part; dueSoon's three-day window
//   BL8  the Extend button's date: encode/decode round trip, what decode
//        refuses, and extendTargetAllowed (future only, never more than one
//        period from max(current, now))
//
// Mutation: change GRACE_DAYS, or `<` to `<=` in billingState, and BL1 fails;
// drop the Math.max in nextPaidUntil and BL2 fails.

import * as B from '../lib/billing.js';

let failed = 0, total = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(5)}${String(what).padEnd(56)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 110) : ''}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const DAY = 86400000;
const HOUR = 3600000;
const T = (iso) => Date.parse(iso);
const biz = (patch = {}) => ({ id: 'b1', name: 'Alder Roofing', slug: 'alder', status: 'active', paid_until: null, billing_warning_stage: 0, suspended_for_billing: false, ...patch });

/* BL1 */
{
  const paid = '2026-12-14T09:00:00Z';
  const P = T(paid);
  const st = (now, p = paid) => B.billingState(biz({ paid_until: p }), now).state;
  const notEnforced = [null, undefined, '', 'not a date', NaN].every((v) => same(B.billingState(biz({ paid_until: v }), P), { state: 'not_enforced' }))
    && same(B.billingState(null, P), { state: 'not_enforced' }) && same(B.billingState({}, P), { state: 'not_enforced' });
  const paidOk = st(P - 1) === 'paid' && st(P - 30 * DAY) === 'paid' && st(0) === 'paid';
  // The boundary: AT paid_until the period is over.
  const graceOk = st(P) === 'grace' && st(P + 1) === 'grace' && st(P + 3 * DAY) === 'grace' && st(P + 7 * DAY - 1) === 'grace';
  const expiredOk = st(P + 7 * DAY) === 'expired' && st(P + 7 * DAY + 1) === 'expired' && st(P + 400 * DAY) === 'expired';
  const g = B.billingState(biz({ paid_until: paid }), P + DAY);
  const shapeOk = same(g, { state: 'grace', paidUntil: P, graceEnd: P + 7 * DAY })
    && same(B.billingState(biz({ paid_until: paid }), P - 1), { state: 'paid', paidUntil: P, graceEnd: P + 7 * DAY })
    && same(B.billingState(biz({ paid_until: paid }), P + 8 * DAY), { state: 'expired', paidUntil: P, graceEnd: P + 7 * DAY })
    && B.GRACE_DAYS === 7 && B.EXTEND_DAYS === 30 && B.DUE_SOON_DAYS === 3;
  // The status is not part of the answer: the dates are.
  const statusFree = ['demo', 'active', 'paused', 'churned', undefined].every((s) => B.billingState(biz({ status: s, paid_until: paid }), P + DAY).state === 'grace');
  // A date may arrive as a Postgres string, a Date or a number; `now` too.
  const typesOk = [paid, '2026-12-14T09:00:00+00:00', '2026-12-14 09:00:00+00', new Date(P), P].every((v) => B.billingState(biz({ paid_until: v }), P).paidUntil === P)
    && B.billingState(biz({ paid_until: paid }), new Date(P + DAY)).state === 'grace'
    && B.billingState(biz({ paid_until: paid }), '2026-12-22T09:00:00Z').state === 'expired'
    && B.toMs('2026-12-14T11:00:00+02:00') === P;
  // A date long past: expired, not an error.
  const pastOk = st(T('2026-11-14T00:00:00Z'), '2020-01-01T00:00:00Z') === 'expired';
  line(notEnforced && paidOk && graceOk && expiredOk && shapeOk && statusFree && typesOk && pastOk,
    'BL1', 'billingState: null, paid, grace, expired, exact boundaries',
    `null=${notEnforced} paid=${paidOk} grace=${graceOk} expired=${expiredOk} shape=${shapeOk} status=${statusFree} types=${typesOk} past=${pastOk}`);
}

/* BL2 */
{
  const now = T('2026-11-14T10:20:30Z');
  const iso = (ms) => new Date(ms).toISOString();
  // Still paid: 30 days are added to what it has.
  const keepOk = B.nextPaidUntil('2026-11-24T10:00:00Z', now, 30) === T('2026-12-24T10:00:00Z');
  // Overdue or long past: the period starts now; the missed days are not charged.
  const lateOk = B.nextPaidUntil('2026-11-10T00:00:00Z', now, 30) === now + 30 * DAY
    && B.nextPaidUntil('2019-01-01T00:00:00Z', now, 30) === now + 30 * DAY;
  // Never billed.
  const nullOk = [null, undefined, '', 'nope'].every((v) => B.nextPaidUntil(v, now, 30) === now + 30 * DAY);
  // Equal to now: either side of the max gives the same answer.
  const equalOk = B.nextPaidUntil(iso(now), now, 30) === now + 30 * DAY;
  // Defaults: 30 days.
  const defaultOk = B.nextPaidUntil(null, now) === now + 30 * DAY && B.nextPaidUntil('2026-11-24T10:00:00Z', now) === T('2026-12-24T10:00:00Z');
  // Other lengths, and whole seconds whatever the milliseconds were.
  const daysOk = B.nextPaidUntil(null, now, 1) === now + DAY && B.nextPaidUntil(null, now, 365) === now + 365 * DAY
    && B.nextPaidUntil(null, now + 789, 30) === now + 30 * DAY && B.nextPaidUntil(iso(now + 5 * DAY + 999), now, 30) === now + 35 * DAY;
  // Calendar edges, by the date they land on (30 days is 30 days, not "a month").
  const lands = (from, want) => B.billingDate(B.nextPaidUntil(from, T('2020-01-01T00:00:00Z'), 30)) === want;
  const edgesOk = lands('2027-01-31T12:00:00Z', 'Mar 2')      // over a 28-day February
    && lands('2028-01-31T12:00:00Z', 'Mar 1')                  // over a leap February
    && lands('2028-01-30T12:00:00Z', 'Feb 29')                 // onto the leap day
    && lands('2026-12-14T12:00:00Z', 'Jan 13')                 // over the year end
    && lands('2026-12-02T12:00:00Z', 'Jan 1')
    && lands('2026-11-30T23:59:59Z', 'Dec 30')
    && lands('2026-03-01T00:00:00Z', 'Mar 31');
  // Pressing twice in a row, each from what the first stored: 60 days, by
  // intent. (One press pressed twice is what the button's date prevents.)
  const first = B.nextPaidUntil(null, now, 30);
  const twiceOk = B.nextPaidUntil(first, now + 1000, 30) === now + 60 * DAY;
  line(keepOk && lateOk && nullOk && equalOk && defaultOk && daysOk && edgesOk && twiceOk,
    'BL2', 'nextPaidUntil = max(current, now) + days; calendar edges',
    `keep=${keepOk} late=${lateOk} null=${nullOk} equal=${equalOk} default=${defaultOk} days=${daysOk} edges=${edgesOk} twice=${twiceOk}`);
}

/* BL3 */
{
  const savedTz = process.env.TZ;
  const cases = [
    ['2026-12-14T09:00:00Z', 'Dec 14'], ['2026-12-21T00:00:00Z', 'Dec 21'], ['2026-01-01T00:00:00Z', 'Jan 1'],
    ['2026-12-31T23:59:59Z', 'Dec 31'], ['2028-02-29T12:00:00Z', 'Feb 29'], ['2026-05-05T05:05:05Z', 'May 5'],
    // UTC decides the day: 23:30 in New York on the 13th is already the 14th.
    ['2026-12-13T23:30:00-05:00', 'Dec 14'], ['2026-12-14T01:00:00+03:00', 'Dec 13'],
  ];
  const bad = [];
  for (const tz of ['UTC', 'America/Chicago', 'Asia/Tokyo', 'Africa/Cairo']) {
    process.env.TZ = tz;
    for (const [iso, want] of cases) if (B.billingDate(iso) !== want) bad.push(`${tz}:${iso}`);
  }
  if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    .every((m, i) => B.billingDate(Date.UTC(2026, i, 9, 12)) === `${m} 9`);
  const noDate = B.billingDate(null) === '?' && B.billingDate('x') === '?';
  line(bad.length === 0 && months && noDate, 'BL3', 'billingDate: "Dec 14", UTC in every zone',
    `bad=${bad.slice(0, 3).join(',') || 'none'} months=${months} none=${noDate}`);
}

/* BL4 */
{
  const end = T('2026-12-21T09:00:00Z');
  const ok = B.overdueWarningText(biz(), end) === 'Payment for Alder Roofing is overdue. Your service will be suspended on Dec 21 unless payment is received. Contact support.'
    && B.finalWarningText(biz(), end) === 'Final notice: payment for Alder Roofing is overdue. Your service will be suspended on Dec 21 unless payment is received. Contact support.'
    && B.BILLING_SUSPENDED_NOTICE === 'Your service has been suspended because payment was not received. Contact support.'
    && B.BILLING_OVERDUE_SUBJECT === 'Payment overdue' && B.BILLING_FINAL_SUBJECT === 'Final notice: payment overdue'
    // A name is one line, and a business without one still gets a sentence.
    && B.overdueWarningText({ name: ' Fir \n & Sons ' }, end).startsWith('Payment for Fir & Sons is overdue.')
    && B.overdueWarningText({ slug: 'fir' }, end).startsWith('Payment for fir is overdue.')
    && B.overdueWarningText({}, end).startsWith('Payment for your business is overdue.');
  const all = [B.overdueWarningText(biz(), end), B.finalWarningText(biz(), end), B.BILLING_SUSPENDED_NOTICE];
  const plain = all.every((t) => !/[<>*_`\[\]]/.test(t) && !/\p{Extended_Pictographic}/u.test(t) && !t.includes('\n'));
  line(ok && plain, 'BL4', 'notice texts, exact; plain text, one line', `texts=${ok} plain=${plain}`);
}

/* BL5 */
{
  const paid = '2026-12-14T09:00:00Z';
  const P = T(paid);
  const END = P + 7 * DAY;
  const act = (now, stage, status = 'active', p = paid) => B.billingDecision(biz({ paid_until: p, billing_warning_stage: stage, status }), now).action;
  const rows = [
    // [when, stage, expected]
    [P - DAY, 0, 'none'], [P - DAY, 1, 'reset'], [P - DAY, 2, 'reset'], [P - 1, 2, 'reset'],
    [P, 0, 'warn'], [P + DAY, 0, 'warn'], [P + DAY, 1, 'none'], [P + DAY, 2, 'none'], [P + 5 * DAY, 1, 'none'],
    // The final-warning window: a day (plus the hour a daily cron may drift) or less.
    [END - B.FINAL_WARNING_MS - 1, 0, 'warn'], [END - B.FINAL_WARNING_MS - 1, 1, 'none'],
    [END - B.FINAL_WARNING_MS, 0, 'final'], [END - B.FINAL_WARNING_MS, 1, 'final'], [END - B.FINAL_WARNING_MS, 2, 'none'],
    [END - DAY, 1, 'final'], [END - HOUR, 1, 'final'], [END - 1, 0, 'final'], [END - 1, 1, 'final'], [END - 1, 2, 'none'],
    [END, 0, 'suspend'], [END, 1, 'suspend'], [END, 2, 'suspend'], [END + 30 * DAY, 2, 'suspend'],
  ];
  const wrong = rows.filter(([now, stage, want]) => act(now, stage) !== want).map(([now, stage, want]) => `${(now - P) / HOUR}h/s${stage}!=${want}`);
  const windowOk = B.FINAL_WARNING_MS === DAY + HOUR;
  // Never anything but 'active': not demo, not suspended, not unknown.
  const others = [];
  for (const status of ['demo', 'paused', 'churned', 'weird', '', null]) {
    for (const now of [P - DAY, P + DAY, END - 1, END + DAY]) {
      for (const stage of [0, 1, 2]) if (act(now, stage, status) !== 'none') others.push(`${status}@${(now - P) / DAY}`);
    }
  }
  // Not billed: nothing, whatever the stage says.
  const nullOk = [0, 1, 2].every((s) => act(P, s, 'active', null) === 'none')
    && B.billingDecision(null, P).action === 'none';
  // The decision carries the dates the caller needs for the notice.
  const d = B.billingDecision(biz({ paid_until: paid }), P + DAY);
  const shapeOk = same(d, { action: 'warn', state: 'grace', paidUntil: P, graceEnd: END });
  // A stage that is not 0, 1 or 2 is read as 0, never as "already warned".
  const junkOk = act(P + DAY, 7) === 'warn' && act(P + DAY, null) === 'warn' && act(P + DAY, '1') === 'none';
  line(wrong.length === 0 && windowOk && others.length === 0 && nullOk && shapeOk && junkOk,
    'BL5', 'billingDecision: the whole table; only active is acted on',
    `wrong=${wrong.slice(0, 3).join(',') || 'none'} window=${windowOk} others=${others.slice(0, 2).join(',') || 'none'} null=${nullOk} shape=${shapeOk} junk=${junkOk}`);
}

/* BL6 */
{
  const now = T('2026-12-16T12:00:00Z');
  const l = (patch, at = now) => B.billingLine(biz(patch), at);
  const ok = l({}) === 'Billing: not tracked'
    && l({ paid_until: '2027-01-13T09:00:00Z' }) === 'Paid until: Jan 13'
    && l({ paid_until: '2026-12-14T09:00:00Z' }) === 'Paid until: Dec 14 (overdue, suspends Dec 21)'
    && l({ paid_until: '2026-12-14T09:00:00Z', billing_warning_stage: 2 }) === 'Paid until: Dec 14 (overdue, suspends Dec 21)'
    && l({ paid_until: '2026-12-01T09:00:00Z' }) === 'Paid until: Dec 1 (overdue, suspends at the next daily check)'
    && l({ paid_until: '2026-12-01T09:00:00Z', status: 'paused', suspended_for_billing: true }) === 'Suspended for non-payment · paid until Dec 1'
    && l({ paid_until: '2026-12-01T09:00:00Z', status: 'churned', suspended_for_billing: true }) === 'Suspended for non-payment · paid until Dec 1'
    // Suspended by hand: the dates, and never "for non-payment".
    && l({ paid_until: '2026-12-01T09:00:00Z', status: 'paused' }) === 'Paid until: Dec 1 (ended)'
    && l({ paid_until: '2027-01-13T09:00:00Z', status: 'paused' }) === 'Paid until: Jan 13'
    // The flag on a business that is not suspended means nothing.
    && l({ paid_until: '2027-01-13T09:00:00Z', suspended_for_billing: true }) === 'Paid until: Jan 13'
    && l({ paid_until: '2026-12-01T09:00:00Z', status: 'demo' }) === 'Paid until: Dec 1 (demo: not enforced)'
    && l({ paid_until: '2027-01-13T09:00:00Z', status: 'demo' }) === 'Paid until: Jan 13 (demo: not enforced)'
    && l({ status: 'paused', suspended_for_billing: true }) === 'Billing: not tracked'
    && l({ billing_unavailable: true, paid_until: '2027-01-13T09:00:00Z' }) === 'Billing: unavailable'
    && B.billingLine(null, now) === 'Billing: unavailable';
  line(ok, 'BL6', 'billingLine: every line the operator can see', `ok=${ok}`);
}

/* BL7 */
{
  const a = biz({ name: 'Alder Roofing' });
  const b = biz({ name: 'Beta Roofing' });
  const c = biz({ name: 'Cedar Co' });
  const nothing = B.billingSummaryText() === null && B.billingSummaryText({}) === null
    && B.billingSummaryText({ suspended: [], warned: [], finalWarned: [], unwarned: [], failed: [], grace: [], due: [] }) === null;
  const full = B.billingSummaryText({
    suspended: [a], finalWarned: [b], warned: [c, a], unwarned: [b], failed: [c],
    grace: [{ business: b, graceEnd: T('2026-12-21T09:00:00Z') }, { business: c, graceEnd: T('2026-12-23T09:00:00Z') }],
    due: [{ business: a, paidUntil: T('2026-12-18T09:00:00Z') }],
  });
  const fullOk = full === ['Billing', '',
    'Suspended for non-payment: Alder Roofing',
    'Final warning sent: Beta Roofing',
    'Overdue warning sent: Cedar Co, Alder Roofing',
    'Could not be warned (no notice delivered): Beta Roofing',
    'Not completed, tried again tomorrow: Cedar Co',
    'Overdue: Beta Roofing (suspends Dec 21), Cedar Co (suspends Dec 23)',
    'Due within 3 days: Alder Roofing (Dec 18)'].join('\n');
  const one = B.billingSummaryText({ due: [{ business: a, paidUntil: T('2026-12-18T09:00:00Z') }] }) === 'Billing\n\nDue within 3 days: Alder Roofing (Dec 18)';
  // Names only: an address, a chat id or an id on the row never appears.
  const rich = { id: 'b0000001-0000-4000-8000-000000000001', name: 'Alder Roofing', slug: 'alder', owner_email: 'owner@fixture.invalid', tg_chat_id: 987654321 };
  const lean = B.billingSummaryText({ suspended: [rich], grace: [{ business: rich, graceEnd: 0 }] });
  const leanOk = !/fixture\.invalid|987654321|b0000001|@/.test(lean);
  // dueSoon: paid, and three days or less to go.
  const P = T('2026-12-14T09:00:00Z');
  const due = (now, patch = {}) => B.dueSoon(biz({ paid_until: '2026-12-14T09:00:00Z', ...patch }), now);
  const dueOk = due(P - 3 * DAY) === true && due(P - 3 * DAY - 1) === false && due(P - 1) === true && due(P) === false
    && due(P + DAY) === false && B.dueSoon(biz(), P) === false;
  line(nothing && fullOk && one && leanOk && dueOk, 'BL7', 'summary: null when quiet, names only, exact; dueSoon',
    `quiet=${nothing} full=${fullOk} one=${one} lean=${leanOk} due=${dueOk}`);
}

/* BL8 */
{
  const now = T('2026-11-14T10:20:30Z');
  const target = B.nextPaidUntil(null, now, 30);
  const token = B.encodePaidUntil(target);
  const roundOk = B.decodePaidUntil(token) === target && /^[0-9a-z]{6,7}$/.test(token)
    && B.decodePaidUntil(B.encodePaidUntil(target + 999)) === target   // whole seconds
    && B.encodePaidUntil(T('2099-12-31T23:59:59Z')).length <= 7;
  const refused = ['', null, undefined, 'ABC', 'a-b', 'a.b', ' 1', '1 ', '123456789', '-1', 'é', '1\n'].every((v) => B.decodePaidUntil(v) === null);
  const ok = (t, current, at = now) => B.extendTargetAllowed(t, current, at);
  // Not billed: anything up to now + 30 days, and only the future.
  const nullOk = ok(target, null) && ok(now + 1000, null) && !ok(now, null) && !ok(now - 1000, null)
    && !ok(target + 1000, null) && !ok(now + 60 * DAY, null) && !ok(null, null) && !ok('x', null);
  // Paid until P: up to P + 30 days; one second more is refused.
  const P = now + 10 * DAY;
  const paidOk = ok(P + 30 * DAY, new Date(P).toISOString()) && !ok(P + 30 * DAY + 1000, new Date(P).toISOString())
    && !ok(P + 60 * DAY, new Date(P).toISOString());
  // Overdue: counted from now, so the old button of a later moment is refused
  // only when it reaches further than now + 30 days.
  const late = new Date(now - 5 * DAY).toISOString();
  const lateOk = ok(now + 30 * DAY, late) && !ok(now + 30 * DAY + 1000, late);
  // A button kept for a day still works (its date is nearer than one period).
  const keptOk = ok(target, null, now + DAY) && !ok(target, null, target);
  line(roundOk && refused && nullOk && paidOk && lateOk && keptOk, 'BL8', 'Extend date: round trip; never more than one period',
    `round=${roundOk} refused=${refused} null=${nullOk} paid=${paidOk} late=${lateOk} kept=${keptOk}`);
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
