#!/usr/bin/env node
// tests/billing.test.mjs — Gate BL (the lifecycle rules).
// HARNESS: in-process, pure functions only. No network, no database, no clock:
// every case passes its own `now`.
//
// What it proves (lib/billing.js + lib/lifecycle-config.js):
//   BL1  the constants: 3 / 5 / 10 / 60 / 30 days, one support address, and
//        that no other source file states the address as a literal
//   BL2  billingState: null / missing / unparseable paid_until is "not
//        enforced"; every boundary (D-3d, D, D+5d, D+15d) is inclusive on the
//        left and exclusive on the right; the end date and the days left of
//        each state; the status plays no part; every date input type
//   BL3  nextPaidUntil = max(current, now) + days: a paid business keeps its
//        days, an overdue or unbilled one starts from now; whole seconds;
//        month ends, a leap day and a year end land on the right date
//   BL4  billingDate: "Dec 14" in UTC whatever the local zone; daysText
//   BL5  billingDecision: the whole table, every warning window boundary
//        (with the one-hour cron allowance), who is enforced (never a demo,
//        never a business suspended or terminated by hand)
//   BL6  missed days: only the current state's notice, and a transition never
//        waits for a notice; a full walk through a period sends each of the
//        six notices exactly once
//   BL7  billingLine: every line the operator can see
//   BL8  billingSummaryText: null when the run did nothing; names only
//   BL9  the Extend button's date: encode/decode and extendTargetAllowed
//
// Mutation: change GRACE_DAYS, or `<` to `<=` in billingState, and BL2 fails;
// drop the Math.max in nextPaidUntil and BL3 fails.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as B from '../lib/billing.js';
import * as CFG from '../lib/lifecycle-config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0, total = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(5)}${String(what).padEnd(56)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 110) : ''}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const DAY = 86400000;
const HOUR = 3600000;
const T = (iso) => Date.parse(iso);
const PAID = '2026-12-14T09:00:00Z';
const P = T(PAID);
const biz = (patch = {}) => ({ id: 'b1', name: 'Alder Roofing', slug: 'alder', status: 'active', paid_until: PAID, billing_warning_stage: 0, suspended_for_billing: false, ...patch });

/* BL1 */
{
  const constants = CFG.RENEWAL_REMINDER_DAYS === 3 && CFG.GRACE_DAYS === 5 && CFG.SUSPENDED_DAYS === 10
    && CFG.TERMINATE_AFTER_DAYS === 15 && CFG.RETENTION_DAYS === 60 && CFG.EXTEND_DAYS === 30
    && B.GRACE_DAYS === 5 && B.EXTEND_DAYS === 30 && B.DUE_SOON_DAYS === 3;
  line(constants, 'BL1', 'durations: 3 / 5 / 10 (15) / 60 / 30 days');
  line(CFG.SUPPORT_TELEGRAM_URL === 'https://t.me/AbdallahIsDev' && CFG.SUPPORT_LINK_LABEL === 'Contact support',
    'BL1b', 'one support address and one link label');
  line(CFG.supportEmail({ OPERATOR_EMAIL: ' ops@example.test ' }) === 'ops@example.test' && CFG.supportEmail({}) === null,
    'BL1c', 'support email = the configured operator address, or null');
  // The address is written in the config module and nowhere else in the code.
  const hits = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      const rel = `${dir}/${f}`;
      if (fs.statSync(path.join(ROOT, rel)).isDirectory()) { walk(rel); continue; }
      if (!/\.(js|mjs|html)$/.test(f) || rel === 'lib/lifecycle-config.js') continue;
      if (fs.readFileSync(path.join(ROOT, rel), 'utf8').includes('t.me/AbdallahIsDev')) hits.push(rel);
    }
  };
  ['lib', 'api', 'scripts'].forEach(walk);
  line(hits.length === 0, 'BL1d', 'support address is not hardcoded outside the config', hits.join(','));
}

/* BL2 */
{
  const st = (now, p = PAID) => B.billingState(biz({ paid_until: p }), now).state;
  const notEnforced = [null, undefined, '', 'not a date', NaN].every((v) => same(B.billingState(biz({ paid_until: v }), P), { state: 'not_enforced' }))
    && same(B.billingState(null, P), { state: 'not_enforced' }) && same(B.billingState({}, P), { state: 'not_enforced' });
  line(notEnforced, 'BL2', 'no paid_until (any form): not enforced');
  const edges = [
    [P - 30 * DAY, 'paid'], [P - 3 * DAY - 1, 'paid'],
    [P - 3 * DAY, 'due_soon'], [P - 1, 'due_soon'],
    [P, 'grace'], [P + 5 * DAY - 1, 'grace'],
    [P + 5 * DAY, 'suspended'], [P + 15 * DAY - 1, 'suspended'],
    [P + 15 * DAY, 'terminated'], [P + 400 * DAY, 'terminated'],
  ];
  const wrong = edges.filter(([now, want]) => st(now) !== want).map(([now, want]) => `${(now - P) / DAY}d!=${want}`);
  line(wrong.length === 0, 'BL2b', 'every boundary: inclusive left, exclusive right', wrong.join(' '));
  const at = (now) => B.billingState(biz(), now);
  const base = { paidUntil: P, suspendAt: P + 5 * DAY, terminateAt: P + 15 * DAY };
  const shapes = same(at(P - 10 * DAY), { state: 'paid', ...base, endsAt: P, daysLeft: 10 })
    && same(at(P - 2 * DAY - 1), { state: 'due_soon', ...base, endsAt: P, daysLeft: 3 })
    && same(at(P - 2 * DAY), { state: 'due_soon', ...base, endsAt: P, daysLeft: 2 })
    && same(at(P + DAY), { state: 'grace', ...base, endsAt: P + 5 * DAY, daysLeft: 4 })
    && same(at(P + 5 * DAY), { state: 'suspended', ...base, endsAt: P + 15 * DAY, daysLeft: 10 })
    && same(at(P + 14 * DAY + 1), { state: 'suspended', ...base, endsAt: P + 15 * DAY, daysLeft: 1 })
    && same(at(P + 20 * DAY), { state: 'terminated', ...base, endsAt: P + 15 * DAY, daysLeft: 0 });
  line(shapes, 'BL2c', 'end date and days left of each state');
  const statusFree = ['demo', 'active', 'paused', 'churned', undefined].every((s) => B.billingState(biz({ status: s }), P + DAY).state === 'grace');
  const inputs = [PAID, new Date(P), P].every((v) => B.billingState(biz({ paid_until: v }), new Date(P + DAY)).state === 'grace');
  line(statusFree && inputs, 'BL2d', 'status plays no part; string, Date and number accepted');
}

/* BL3 */
{
  const now = T('2026-11-16T12:00:00.750Z');
  const whole = Math.floor(now / 1000) * 1000;
  const keeps = B.nextPaidUntil('2026-12-01T00:00:00Z', now) === T('2026-12-31T00:00:00Z');
  const late = B.nextPaidUntil('2026-11-01T00:00:00Z', now) === whole + 30 * DAY;
  const never = B.nextPaidUntil(null, now) === whole + 30 * DAY && B.nextPaidUntil('', now) === whole + 30 * DAY;
  line(keeps && late && never, 'BL3', 'max(paid_until, now) + 30 days, whole seconds');
  const d = (cur, n) => B.billingDate(B.nextPaidUntil(cur, T(n)));
  const months = d('2026-01-31T00:00:00Z', '2026-01-01T00:00:00Z') === 'Mar 2'
    && d('2028-01-30T00:00:00Z', '2028-01-01T00:00:00Z') === 'Feb 29'       // leap year
    && d('2027-01-30T00:00:00Z', '2027-01-01T00:00:00Z') === 'Mar 1'        // not a leap year
    && d('2026-12-15T00:00:00Z', '2026-12-01T00:00:00Z') === 'Jan 14'       // year end
    && d(null, '2028-02-29T10:00:00Z') === 'Mar 30';
  line(months, 'BL3b', 'month ends, a leap day and a year end');
  line(B.nextPaidUntil('2026-12-01T00:00:00Z', now, 7) === T('2026-12-08T00:00:00Z'), 'BL3c', 'days is a parameter');
}

/* BL4 */
{
  const ok = B.billingDate('2026-12-14T23:59:59Z') === 'Dec 14' && B.billingDate('2026-12-15T00:00:00Z') === 'Dec 15'
    && B.billingDate('2026-01-05T00:00:00Z') === 'Jan 5' && B.billingDate(null) === '?' && B.billingDate('x') === '?'
    && B.daysText(1) === '1 day' && B.daysText(0) === '0 days' && B.daysText(9) === '9 days';
  line(ok, 'BL4', 'billingDate in UTC, no padding; daysText');
}

/* BL5 */
{
  const dec = (patch, now) => { const r = B.billingDecision(biz(patch), now); return `${r.action}:${r.notice || '-'}:${r.stage === null ? '-' : r.stage}`; };
  const rows = [
    // status active
    [{}, P - 10 * DAY, 'none:-:-'],
    [{ billing_warning_stage: 3 }, P - 10 * DAY, 'reset:-:-'],
    [{}, P - 3 * DAY, 'notice:renewal_reminder:1'],
    [{ billing_warning_stage: 1 }, P - DAY, 'none:-:-'],
    [{ billing_warning_stage: 4 }, P - DAY, 'reset:-:-'],
    [{}, P, 'notice:overdue:2'],
    [{ billing_warning_stage: 1 }, P + DAY, 'notice:overdue:2'],
    [{ billing_warning_stage: 2 }, P + DAY, 'none:-:-'],
    [{ billing_warning_stage: 2 }, P + 4 * DAY - HOUR - 1, 'none:-:-'],
    [{ billing_warning_stage: 2 }, P + 4 * DAY - HOUR, 'notice:final_warning:3'],   // the cron allowance
    [{ billing_warning_stage: 2 }, P + 4 * DAY, 'notice:final_warning:3'],
    [{ billing_warning_stage: 3 }, P + 5 * DAY - 1, 'none:-:-'],
    [{ billing_warning_stage: 3 }, P + 5 * DAY, 'suspend:suspension:4'],
    [{ billing_warning_stage: 0 }, P + 5 * DAY - 1, 'notice:final_warning:3'],       // never early
    [{}, P + 15 * DAY, 'terminate:termination:6'],
    // suspended for billing
    [{ status: 'paused', suspended_for_billing: true, billing_warning_stage: 4 }, P + 6 * DAY, 'none:-:-'],
    [{ status: 'paused', suspended_for_billing: true, billing_warning_stage: 3 }, P + 6 * DAY, 'notice:suspension:4'],
    [{ status: 'paused', suspended_for_billing: true, billing_warning_stage: 4 }, P + 10 * DAY - HOUR - 1, 'none:-:-'],
    [{ status: 'paused', suspended_for_billing: true, billing_warning_stage: 4 }, P + 10 * DAY - HOUR, 'notice:termination_warning:5'],
    [{ status: 'paused', suspended_for_billing: true, billing_warning_stage: 5 }, P + 12 * DAY, 'none:-:-'],
    [{ status: 'paused', suspended_for_billing: true, billing_warning_stage: 5 }, P + 15 * DAY - 1, 'none:-:-'],
    [{ status: 'paused', suspended_for_billing: true, billing_warning_stage: 5 }, P + 15 * DAY, 'terminate:termination:6'],
    [{ status: 'paused', suspended_for_billing: true, billing_warning_stage: 0 }, P + DAY, 'restore:-:-'],
    // terminated for billing
    [{ status: 'churned', suspended_for_billing: true, billing_warning_stage: 6 }, P + 30 * DAY, 'none:-:-'],
    [{ status: 'churned', suspended_for_billing: true, billing_warning_stage: 5 }, P + 30 * DAY, 'notice:termination:6'],
    [{ status: 'churned', suspended_for_billing: true }, P - DAY, 'restore:-:-'],
  ];
  const wrong = rows.map(([patch, now, want], i) => (dec(patch, now) === want ? null : `#${i} ${dec(patch, now)}!=${want}`)).filter(Boolean);
  line(wrong.length === 0, 'BL5', `the decision table (${rows.length} rows)`, wrong.join(' | '));
  // Never enforced: no date, a demo, suspended or terminated by hand, unknown status.
  const moments = [P - 10 * DAY, P - DAY, P + DAY, P + 6 * DAY, P + 30 * DAY];
  const never = [
    { paid_until: null }, { status: 'demo' }, { status: 'paused' }, { status: 'churned' }, { status: 'weird' }, { status: undefined },
    { status: 'paused', suspended_for_billing: null }, { status: 'demo', suspended_for_billing: true },
  ].every((patch) => moments.every((now) => B.billingDecision(biz(patch), now).action === 'none'));
  line(never && B.billingDecision(null, P).action === 'none', 'BL5b', 'no date, demo, manual pause or termination: never acted on');
  line(B.billingEnforced(biz()) && !B.billingEnforced(biz({ status: 'paused' })) && B.billingEnforced(biz({ status: 'paused', suspended_for_billing: true }))
    && !B.billingEnforced(biz({ status: 'demo' })) && !B.billingEnforced(biz({ paid_until: null })), 'BL5c', 'billingEnforced');
}

/* BL6 */
{
  // A daily walk through one period: apply each decision the way the job does.
  const walk = (startOffsetDays, stepDays, untilDays) => {
    const b = biz();
    const sent = [];
    for (let d = startOffsetDays; d <= untilDays; d += stepDays) {
      const r = B.billingDecision(b, P + d * DAY + 5 * 60000);
      if (r.action === 'reset') b.billing_warning_stage = 0;
      if (r.notice) { sent.push(r.notice); b.billing_warning_stage = r.stage; }
      if (r.action === 'suspend') { b.status = 'paused'; b.suspended_for_billing = true; }
      if (r.action === 'terminate') { b.status = 'churned'; b.suspended_for_billing = true; }
    }
    return { sent, status: b.status };
  };
  const daily = walk(-5, 1, 20);
  line(same(daily.sent, ['renewal_reminder', 'overdue', 'final_warning', 'suspension', 'termination_warning', 'termination']) && daily.status === 'churned',
    'BL6', 'a daily walk sends each of the six notices exactly once', daily.sent.join(','));
  // The job did not run for days: only the notice of the state it finds.
  const first = (patch, d) => { const r = B.billingDecision(biz(patch), P + d * DAY); return `${r.action}:${r.notice}`; };
  const missed = first({}, 2) === 'notice:overdue' && first({}, 4.5) === 'notice:final_warning'
    && first({}, 7) === 'suspend:suspension' && first({}, 40) === 'terminate:termination'
    && first({ status: 'paused', suspended_for_billing: true, billing_warning_stage: 0 }, 12) === 'notice:termination_warning'
    && first({ status: 'paused', suspended_for_billing: true, billing_warning_stage: 0 }, 16) === 'terminate:termination';
  line(missed, 'BL6b', 'missed days: only the current state\'s notice');
  const weekly = walk(-5, 7, 23);
  line(weekly.status === 'churned' && !weekly.sent.includes('final_warning') && weekly.sent[weekly.sent.length - 1] === 'termination',
    'BL6c', 'a transition never waits for a notice', weekly.sent.join(','));
}

/* BL7 */
{
  const L = (patch, d) => B.billingLine(biz(patch), P + d * DAY);
  const rows = [
    [{ paid_until: null }, 0, 'Billing: not tracked'],
    [{ billing_unavailable: true }, 0, 'Billing: unavailable'],
    [{}, -10, 'Paid until: Dec 14'],
    [{}, -1.5, 'Paid until: Dec 14 · due in 2 days'],
    [{}, -0.5, 'Paid until: Dec 14 · due in 1 day'],
    [{}, 1, 'Overdue since Dec 14 · suspends Dec 19'],
    [{}, 6, 'Overdue since Dec 14 · suspends today'],
    [{}, 16, 'Overdue since Dec 14 · terminates today'],
    [{ status: 'paused', suspended_for_billing: true }, 6, 'Suspended since Dec 19 · terminates Dec 29'],
    [{ status: 'churned', suspended_for_billing: true }, 20, 'Terminated Dec 29'],
    [{ status: 'paused' }, -10, 'Paid until: Dec 14'],
    [{ status: 'paused' }, 6, 'Overdue since Dec 14'],
    [{ status: 'churned' }, 6, 'Overdue since Dec 14'],
    [{ status: 'demo' }, -10, 'Paid until: Dec 14 · not enforced'],
  ];
  const wrong = rows.map(([patch, d, want]) => (L(patch, d) === want ? null : `${L(patch, d)} != ${want}`)).filter(Boolean);
  line(wrong.length === 0 && B.billingLine(null, P) === 'Billing: unavailable', 'BL7', `billingLine: ${rows.length} lines`, wrong.join(' | '));
}

/* BL8 */
{
  const a = biz({ name: 'Alder  Roofing' });
  const z = biz({ name: '', slug: 'zed-roof' });
  const none = B.billingSummaryText({}) === null && B.billingSummaryText() === null
    && B.billingSummaryText({ grace: [a], due: [z], held: [{ business: a, count: 2 }] }) === null;
  line(none, 'BL8', 'summary: null when the run did nothing new');
  const text = B.billingSummaryText({
    terminated: [a], suspended: [z], restored: [a], warned: [{ business: z, notice: 'overdue' }], undelivered: [a], failed: [z],
    grace: [a], due: [z], held: [{ business: a, count: 2 }],
  });
  const want = ['Billing today', '', 'Newly terminated:', 'Alder Roofing', '', 'Newly suspended:', 'zed-roof', '', 'Back in service:', 'Alder Roofing',
    '', 'Newly warned:', 'zed-roof', '', 'Notice not delivered:', 'Alder Roofing', '', 'Not completed, retried tomorrow:', 'zed-roof',
    '', 'In grace:', 'Alder Roofing', '', 'Due within 3 days:', 'zed-roof', '', 'Suspended, held leads:', 'Alder Roofing: 2'].join('\n');
  line(text === want, 'BL8b', 'summary: every block, names only, one per line', text === want ? '' : text);
  line(B.dueSoon(biz(), P - DAY) && B.dueSoon(biz(), P - 3 * DAY) && !B.dueSoon(biz(), P - 3 * DAY - 1) && !B.dueSoon(biz(), P), 'BL8c', 'dueSoon: the reminder window');
}

/* BL9 */
{
  const ms = T('2026-12-31T00:00:00Z');
  const tok = B.encodePaidUntil(ms + 999);
  const round = B.decodePaidUntil(tok) === ms && /^[0-9a-z]{1,8}$/.test(tok);
  const refuses = ['', null, undefined, 'ABC', '12-3', 'zzzzzzzzz', ' 1'].every((v) => B.decodePaidUntil(v) === null);
  line(round && refuses, 'BL9', 'Extend token: round trip, refuses anything else');
  const now = T('2026-11-16T12:00:00Z');
  const cur = '2026-12-01T00:00:00Z';
  const max = B.nextPaidUntil(cur, now);
  const ok = B.extendTargetAllowed(max, cur, now) && !B.extendTargetAllowed(max + 1000, cur, now)
    && !B.extendTargetAllowed(now, cur, now) && !B.extendTargetAllowed(now - 1, null, now)
    && B.extendTargetAllowed(now + 30 * DAY, null, now) && !B.extendTargetAllowed(null, cur, now)
    && !B.extendTargetAllowed(max, cur, max + 1);            // an old button: its date is in the past
  line(ok, 'BL9b', 'extendTargetAllowed: future only, at most one period');
}

console.log(`\nGate BL (billing rules): ${total - failed}/${total} PASS`);
process.exit(failed ? 1 : 0);
