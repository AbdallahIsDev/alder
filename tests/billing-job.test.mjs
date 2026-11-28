#!/usr/bin/env node
// tests/billing-job.test.mjs — Gate BJ (the daily lifecycle job and the
// payment seam).
// HARNESS: runs lib/billing-ops.js against the loopback Telegram and Resend
// fakes and the in-memory PostgREST of tests/lifecycle-harness.mjs. No
// database, no network, no real clock: every run passes its own `now`.
//
// What it proves:
//   BJ1  scope: a demo, a business with no paid_until and one suspended or
//        terminated BY HAND are never warned, changed or written, however
//        overdue their dates are
//   BJ2  paid: nothing; a leftover stage is reset to 0
//   BJ3  the three warnings of an active business (renewal reminder at
//        D-3d, overdue at D, final warning at D+4d): every phone and the
//        owner address once, the stage recorded, plain text with the support
//        link entity, no keyboard change, nothing twice
//   BJ4  D+5d: suspended through the operator's Suspend path (status first,
//        one scoped update, then the notice with the Status keyboard),
//        differing only in the words and suspended_for_billing
//   BJ5  D+10d: the termination warning; D+15d: terminated through the
//        operator's Terminate path; nothing is ever deleted and no binding
//        is touched
//   BJ6  idempotent: a second run at any point of the life changes nothing
//        and sends nothing, the operator included
//   BJ7  failed notices: nothing delivered = the stage stays, the operator
//        is alerted once, the next day retries; one phone failing does not
//        hold the stage; nobody to tell = the stage advances; a failed
//        notice never blocks a suspension, and that notice is retried
//   BJ8  one billing notice per business per day, and a transition that
//        falls on a used day still happens (its notice follows)
//   BJ9  one business that cannot be processed does not stop the others
//   BJ10 the operator summary: only when the run did something, exact text,
//        names only, held-lead counts, to the operator chat only
//   BJ11 applyPayment, the seam: bad input refused; forward only; the same
//        payment twice writes once; clears the stage; restores a suspended
//        AND a terminated business (billing ones by default, any with
//        'any', none with 'never') with the role keyboards and the held count
//   BJ12 the job restores a billing-suspended business whose date is ahead
//   BJ13 the notice log: one 'expected' row per round and one row per
//        attempt, fixed vocabulary only; without migration 0007 everything
//        still works
//   BJ14 email idempotency per event instance: two suspensions of one
//        business on one day are two emails; Reply-To is the support
//        address; no button
//   BJ15 a database without the billing columns: "unavailable", nothing
//        done; the job runs inside the daily self-check, no new cron
//   BJ16 over the whole suite: no parse_mode, no line over 34 characters in
//        anything a business was sent
//
// Mutation: record the stage before sending in runBillingJob and BJ7 fails;
// make listBilledBusinesses read demo rows and BJ1 still holds (the decision
// refuses them) but drop billingEnforced and BJ1 fails; make applyPayment
// write without the forward-only filter and BJ11 fails.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OWNER, STAFF, CHAT_B, OTHER, OP, world, setStore, get, set, newDay, during, everything, textOf, toOf, keyOf, same,
  bizId, businessRow, iso, DAY, HOUR, tgRefuse, fail500, longLines, supportLinkOk, renewLinkOk, mailCtl, OPERATOR_MAIL,
} from './lifecycle-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0, total = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(5)}${String(what).padEnd(56)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 150) : ''}`);
};

const A = bizId(1);       // Alder Roofing: active, two phones, an owner address
const B = bizId(2);       // Beta Roofing: active, one phone
const C = bizId(3);       // Cedar Co: active, no phone, an owner address
const D = bizId(4);       // Delta Roofs: active, no phone, no owner address
const DEMO = bizId(5);
const PAUSED = bizId(6);  // suspended by hand
const CHURNED = bizId(7); // terminated by hand
const NEVER = bizId(8);   // active, never billed
const PAID = '2026-12-14T09:00:00.000Z';
const P = Date.parse(PAID);

const fresh = (patches = {}) => {
  const longAgo = iso(P - 60 * DAY);
  const rows = [
    businessRow(A, 'alder', 'Alder Roofing', 'active', { paid_until: PAID }),
    businessRow(B, 'beta', 'Beta Roofing', 'active'),
    businessRow(C, 'cedar', 'Cedar Co', 'active'),
    businessRow(D, 'delta', 'Delta Roofs', 'active', { owner_email: null }),
    businessRow(DEMO, 'demo-co', 'Demo Roofing', 'demo', { paid_until: longAgo }),
    businessRow(PAUSED, 'paused-co', 'Paused Co', 'paused', { paid_until: longAgo }),
    businessRow(CHURNED, 'churned-co', 'Churned Co', 'churned', { paid_until: longAgo }),
    businessRow(NEVER, 'never', 'Never Billed', 'active'),
  ];
  for (const r of rows) Object.assign(r, patches[r.id] || {});
  return setStore({
    businesses: rows,
    chats: [
      { id: 'c1', business_id: A, tg_chat_id: OWNER, label: null, created_at: '2026-11-01T10:00:00Z' },
      { id: 'c2', business_id: A, tg_chat_id: STAFF, label: 'Van', created_at: '2026-11-02T10:00:00Z' },
      { id: 'c3', business_id: B, tg_chat_id: CHAT_B, label: null, created_at: '2026-11-03T10:00:00Z' },
      { id: 'c4', business_id: DEMO, tg_chat_id: OTHER, label: null, created_at: '2026-11-04T10:00:00Z' },
      { id: 'c5', business_id: PAUSED, tg_chat_id: OTHER + 1, label: null, created_at: '2026-11-04T10:00:00Z' },
      { id: 'c6', business_id: NEVER, tg_chat_id: OTHER + 2, label: null, created_at: '2026-11-04T10:00:00Z' },
    ],
  });
};
const untouchable = () => JSON.stringify(world.store.businesses.filter((b) => [DEMO, PAUSED, CHURNED, NEVER].includes(b.id)));

const { runBillingJob, applyPayment, DEFAULT_IO } = await import('../lib/billing-ops.js');
const SS = await import('../lib/service-status.js');
const LT = await import('../lib/lifecycle-text.js');
const CFG = await import('../lib/lifecycle-config.js');
const BL = await import('../lib/billing.js');

const job = (now, opts) => during(() => runBillingJob({ now }), opts);
const quiet = (r) => r.sends.length === 0 && r.mail.length === 0 && r.w.length === 0 && r.operator.length === 0 && r.operatorMail.length === 0;
const at = (days, extra = 0) => P + days * DAY + extra + 5 * 60000;     // the cron fires five minutes past
const state = (id) => { const b = get(id); return `${b.status}/${b.billing_warning_stage}/${b.suspended_for_billing}`; };
const STATUS_KB = { keyboard: [[{ text: 'Status' }]], is_persistent: true, resize_keyboard: true };
const notice = (type, id, now, opts = {}) => LT.ownerNotice(type, { business: get(id), now, ...opts });
const chatsOf = (r) => r.sends.map((m) => String(m.body.chat_id)).sort();
const both = [String(OWNER), String(STAFF)].sort();
const supportOk = (m) => supportLinkOk(m.body, CFG.SUPPORT_TELEGRAM_URL);

/* BJ1 */
{
  fresh({ [A]: { paid_until: null } });
  const before = untouchable();
  const results = [];
  for (const d of [-2, 2, 6, 12, 30]) { newDay(); results.push(await job(at(d))); }
  line(results.every(quiet) && untouchable() === before && results.every((r) => r.out.ok && r.out.checked === 2),
    'BJ1', 'demo, unbilled and hand-suspended: never touched', results.map((r) => `${r.sends.length}/${r.w.length}`).join(' '));
  // A demo with a date the job would otherwise act on, read or not.
  fresh({ [A]: { status: 'demo' } });
  const r = await job(at(20));
  line(quiet(r) && state(A) === 'demo/0/false', 'BJ1b', 'a demo business with a paid_until is not enforced');
}

/* BJ2 */
{
  fresh();
  const r = await job(at(-10));
  set(A, { billing_warning_stage: 3 });
  const r2 = await job(at(-10));
  line(quiet(r) && r2.sends.length === 0 && r2.w.length === 1 && state(A) === 'active/0/false' && r2.out.reset === 1 && r2.operator.length === 0,
    'BJ2', 'paid: nothing; a leftover stage is reset', `${r.w.length} ${r2.w.length} ${state(A)}`);
}

/* BJ3 */
{
  fresh();
  const steps = [[-3, 'renewal_reminder', 1, 'Your payment is due soon'], [0, 'overdue', 2, 'Payment overdue'], [4, 'final_warning', 3, 'Final notice: payment overdue']];
  for (const [d, type, stage, subject] of steps) {
    newDay();
    const now = at(d);
    const want = notice(type, A, now);
    const r = await job(now);
    const tgOk = same(chatsOf(r), both) && r.sends.every((m) => textOf(m) === want.telegram.text
      && renewLinkOk(m.body, CFG.RENEW_URL) && !('reply_markup' in m.body) && !('parse_mode' in m.body));
    const mailOk = r.mail.length === 1 && toOf(r.mail[0]) === 'alder@fixture.invalid' && r.mail[0].body.subject === subject
      && r.mail[0].body.text === want.email.text && keyOf(r.mail[0]) === `${type}:${A}:${Math.floor(P / 1000)}:${iso(now).slice(0, 10)}`;
    const again = await job(now + HOUR, { keepMail: true });
    line(tgOk && mailOk && get(A).billing_warning_stage === stage && get(A).status === 'active' && quiet(again),
      'BJ3', `${type}: every phone + the owner address, once, stage ${stage}`, `tg=${tgOk} mail=${mailOk} ${state(A)} again=${quiet(again)}`);
  }
  newDay();
  const idle = await job(at(4, 6 * HOUR));
  line(quiet(idle), 'BJ3b', 'a later run in the same state sends nothing');
  const text = notice('overdue', A, at(0)).telegram.text;
  line(text.startsWith('Your payment was due on\nDec 14 and has not arrived.\n\nYour service works\nuntil Dec 19, then it is\nsuspended (5 days left).'), 'BJ3c', 'the overdue notice says the dates', text.slice(0, 90));
}

/* BJ4 */
{
  fresh({ [A]: { billing_warning_stage: 3 } });
  const now = at(5);
  const r = await job(now);
  const patch = r.w.filter((q) => q.table === 'businesses' && q.method === 'PATCH');
  const want = LT.ownerNotice('suspension', { business: { ...get(A), status: 'paused', suspended_for_billing: true }, now, reason: 'billing' });
  const statusWrite = patch[0] && same(patch[0].body, { status: 'paused', suspended_for_billing: true })
    && patch[0].params.some(([k, v]) => k === 'status' && v === 'in.(active)') && patch[0].params.some(([k, v]) => k === 'id' && v === `eq.${A}`);
  const tgOk = same(chatsOf(r), both) && r.sends.every((m) => textOf(m) === want.telegram.text && same(m.body.reply_markup, STATUS_KB) && supportOk(m));
  const mailOk = r.mail.length === 1 && r.mail[0].body.subject === 'Your service has been suspended' && r.mail[0].body.text === want.email.text
    && keyOf(r.mail[0]) === `suspension:${A}:${now}`;
  line(statusWrite && tgOk && mailOk && state(A) === 'paused/4/true' && r.out.suspended === 1 && world.store.chats.length === 6,
    'BJ4', 'D+5d: suspended, flag set, notice with the Status keyboard', `write=${statusWrite} tg=${tgOk} mail=${mailOk} ${state(A)}`);
  line(want.telegram.text.includes('Your service is suspended\nbecause payment was overdue.') && want.telegram.text.includes('The service terminates\non Dec 29 (10 days left).'),
    'BJ4b', 'the billing suspension notice: reason and termination date');

  // The operator's Suspend is the same function: same requests, other words, no flag.
  fresh();
  const manual = await during(() => SS.suspendBusiness({ business: get(B), rows: world.store.chats.filter((c) => c.business_id === B), now }, DEFAULT_IO));
  const mp = manual.w.filter((q) => q.table === 'businesses');
  const manualText = LT.ownerNotice('suspension', { business: get(B), now, reason: 'manual' }).telegram.text;
  line(manual.out.changed && mp.length === 1 && same(mp[0].body, { status: 'paused' }) && state(B) === 'paused/0/false'
    && manual.sends.length === 1 && textOf(manual.sends[0]) === manualText && same(manual.sends[0].body.reply_markup, STATUS_KB)
    && manualText.startsWith('Your service has been suspended.') && !/by support/i.test(manualText) && manual.mail.length === 1,
    'BJ4c', 'the operator\'s Suspend: same path, no "by support", flag stays false', `${state(B)} ${mp.length}`);
  const second = await during(() => SS.suspendBusiness({ business: get(B), rows: [], now }, DEFAULT_IO));
  line(!second.out.changed && second.sends.length === 0 && second.mail.length === 0, 'BJ4d', 'a second Suspend changes and sends nothing');
}

/* BJ5 */
{
  fresh({ [A]: { status: 'paused', suspended_for_billing: true, billing_warning_stage: 4 } });
  const early = await job(at(9));
  newDay();
  const warnAt = at(10);
  const w = await job(warnAt);
  const wantW = notice('termination_warning', A, warnAt);
  const warnOk = quiet(early) && same(chatsOf(w), both) && w.sends.every((m) => textOf(m) === wantW.telegram.text && same(m.body.reply_markup, STATUS_KB))
    && w.mail.length === 1 && state(A) === 'paused/5/true' && wantW.telegram.text.includes('It will be terminated\non Dec 29 (5 days left).');
  line(warnOk, 'BJ5', 'D+10d: the termination warning, once', `${state(A)} sends=${w.sends.length}`);
  newDay();
  const idle = await job(at(14));
  newDay();
  const termAt = at(15);
  const t = await job(termAt);
  const tp = t.w.filter((q) => q.table === 'businesses' && q.method === 'PATCH');
  const wantT = LT.ownerNotice('termination', { business: { ...get(A), status: 'churned', suspended_for_billing: true }, now: termAt, reason: 'billing' });
  const termOk = quiet(idle) && tp[0] && same(tp[0].body, { status: 'churned', suspended_for_billing: true })
    && tp[0].params.some(([k, v]) => k === 'status' && v === 'in.(active,paused)')
    && same(chatsOf(t), both) && t.sends.every((m) => textOf(m) === wantT.telegram.text && same(m.body.reply_markup, STATUS_KB) && supportOk(m))
    && t.mail.length === 1 && t.mail[0].body.subject === 'Your service has been terminated' && state(A) === 'churned/6/true' && t.out.terminated === 1;
  line(termOk, 'BJ5b', 'D+15d: terminated through the shared path, notice sent', `${state(A)} sends=${t.sends.length} mail=${t.mail.length}`);
  const noDelete = [early, w, idle, t].every((r) => r.sb.every((q) => q.method !== 'DELETE')) && world.store.chats.length === 6 && world.store.businesses.length === 8;
  line(noDelete, 'BJ5c', 'termination deletes nothing: business, phones and leads stay');
  newDay();
  const after = await job(at(40));
  line(quiet(after) && state(A) === 'churned/6/true', 'BJ5d', 'a terminated business is left alone');

  // Straight from active (the job did not run for weeks): terminated, one notice.
  fresh();
  const late = await job(at(40));
  line(state(A) === 'churned/6/true' && late.sends.length === 2 && late.sends.every((m) => textOf(m).startsWith('Your service has been terminated')),
    'BJ5e', 'missed days: terminated directly, only the termination notice', state(A));
}

/* BJ6 */
{
  fresh();
  const dirty = [];
  for (const d of [-3, 0, 4, 5, 10, 15]) {
    newDay();
    await job(at(d));
    const again = await job(at(d, HOUR), { keepMail: true });
    if (!quiet(again)) dirty.push(d);
  }
  line(dirty.length === 0 && state(A) === 'churned/6/true', 'BJ6', 'running twice changes nothing, at every stage of a life', `dirty=${dirty.join(',')} ${state(A)}`);
}

/* BJ7 */
{
  fresh();
  world.tgHook = ({ chat }) => (String(chat) === String(OP) ? null : tgRefuse());
  await mailCtl({ mode: '500' });
  const r = await job(at(0));
  const alert = r.operator.find((m) => textOf(m).startsWith('Notice not delivered'));
  const alertOk = !!alert && textOf(alert) === ['Notice not delivered', '', 'Alder Roofing', 'Notice: overdue notice', 'Telegram: http_403', 'Telegram: http_403', 'Email: http_500'].join('\n');
  line(state(A) === 'active/0/false' && r.out.undelivered === 1 && r.out.warned === 0 && alertOk,
    'BJ7', 'nothing delivered: the stage stays, the operator is alerted', `${state(A)} alert=${alertOk} ${alert ? '' : r.operator.map(textOf).join('|')}`);
  const sameDay = await job(at(0, HOUR));
  line(sameDay.sends.length === 0 && sameDay.mail.length === 0, 'BJ7b', 'no second attempt the same day');
  newDay();
  world.tgHook = null;
  await mailCtl({ mode: 'ok' });
  const next = await job(at(1));
  line(next.sends.length === 2 && next.mail.length === 1 && state(A) === 'active/2/false' && !next.operator.some((m) => textOf(m).startsWith('Notice not delivered')),
    'BJ7c', 'the next day sends it again and records the stage', state(A));

  // One phone failing does not hold the stage back, but the operator hears once.
  fresh();
  world.tgHook = ({ chat }) => (String(chat) === String(STAFF) ? tgRefuse() : null);
  const one = await job(at(0));
  const oneAlerts = one.operator.filter((m) => textOf(m).startsWith('Notice not delivered'));
  world.tgHook = null;
  line(state(A) === 'active/2/false' && oneAlerts.length === 1 && textOf(oneAlerts[0]).endsWith('Telegram: http_403'), 'BJ7d', 'one phone failing: stage recorded, one alert', state(A));

  // Nobody to tell at all: the stage advances. The email alone is a notice.
  fresh({ [A]: { paid_until: null }, [C]: { paid_until: PAID }, [D]: { paid_until: PAID } });
  const nobody = await job(at(0));
  line(state(D) === 'active/2/false' && state(C) === 'active/2/false' && nobody.mail.length === 1 && toOf(nobody.mail[0]) === 'cedar@fixture.invalid'
    && nobody.sends.length === 0 && world.store.events.some((e) => e.business_id === D && e.status === 'skipped' && e.error_class === 'no_recipient'),
    'BJ7e', 'nobody to tell: stage advances; the email alone counts', `${state(C)} ${state(D)}`);

  // A failed notice never blocks the suspension, and the notice is retried.
  fresh({ [A]: { billing_warning_stage: 3 } });
  world.tgHook = ({ chat }) => (String(chat) === String(OP) ? null : tgRefuse());
  await mailCtl({ mode: '500' });
  const blocked = await job(at(5));
  const suspendedAnyway = state(A) === 'paused/3/true' && blocked.out.suspended === 1 && blocked.out.undelivered === 1;
  newDay();
  world.tgHook = null;
  await mailCtl({ mode: 'ok' });
  const retry = await job(at(6));
  line(suspendedAnyway && retry.sends.length === 2 && retry.sends.every((m) => textOf(m).startsWith('Your service is suspended') && same(m.body.reply_markup, STATUS_KB))
    && state(A) === 'paused/4/true' && retry.w.filter((q) => 'status' in (q.body || {})).length === 0,
    'BJ7f', 'a failed notice never blocks the suspension; it is retried', `${suspendedAnyway} ${state(A)}`);
}

/* BJ8 */
{
  fresh({ [A]: { billing_warning_stage: 2 } });
  const f = await job(at(4, 20 * HOUR));                 // the final warning, late in the day
  const s = await job(at(5), { keepMail: true });        // D+5d on the same claim day
  const happened = f.sends.length === 2 && s.sends.length === 0 && s.mail.length === 0 && state(A) === 'paused/3/true';
  newDay();
  const n = await job(at(6));
  line(happened && n.sends.length === 2 && state(A) === 'paused/4/true', 'BJ8', 'one notice a day; the transition does not wait', `${happened} ${state(A)}`);
}

/* BJ9 */
{
  fresh({ [B]: { paid_until: PAID } });
  world.sbHook = ({ table, params }) => (table === 'business_chats' && params.some(([k, v]) => k === 'business_id' && v === `eq.${A}`) ? fail500() : null);
  const r = await job(at(0));
  world.sbHook = null;
  line(state(A) === 'active/0/false' && state(B) === 'active/2/false' && r.out.failed === 1 && r.out.warned === 1
    && r.operator.some((m) => textOf(m).includes('Not completed, retried tomorrow:\nAlder Roofing')),
    'BJ9', 'one business that fails does not stop the others', `${state(A)} ${state(B)} failed=${r.out.failed}`);
}

/* BJ10 */
{
  const heldLead = (n, when) => ({ id: `l${n}`, business_id: A, idempotency_key: `k${n}`, status: 'open', created_at: iso(when), held_at: iso(when) });
  fresh({
    [A]: { status: 'paused', suspended_for_billing: true, billing_warning_stage: 4 },
    [B]: { paid_until: iso(P + 2 * DAY) },        // overdue two days from the run: nothing new
    [C]: { paid_until: iso(P + 12 * DAY), billing_warning_stage: 1 },   // due soon, already reminded
    [D]: { paid_until: iso(P + 10 * DAY) },       // enters grace now -> a notice (nobody to tell)
  });
  world.store.leads.push(heldLead(1, P + 6 * DAY), heldLead(2, P + 7 * DAY), heldLead(3, P - DAY));
  set(B, { billing_warning_stage: 2, paid_until: iso(P + 8 * DAY) });
  const r = await job(at(10));
  const want = ['Billing today', '', 'Newly warned:', 'Alder Roofing', '', 'In grace:', 'Beta Roofing', 'Delta Roofs', '', 'Due within 3 days:', 'Cedar Co',
    '', 'Suspended, held leads:', 'Alder Roofing: 2'].join('\n');
  const summary = r.operator.map(textOf);
  line(summary.length === 1 && summary[0] === want && r.operatorMail.length === 0 && !('reply_markup' in r.operator[0].body),
    'BJ10', 'one summary: exact text, names only, held counts', summary[0] === want ? '' : summary.join(' || '));
  const again = await job(at(10, HOUR), { keepMail: true });
  line(again.operator.length === 0 && again.operatorMail.length === 0, 'BJ10b', 'a second run says nothing');
  newDay();
  const standing = await job(at(11));
  line(standing.operator.length === 0 && standing.out.grace === 2 && standing.out.held === 1, 'BJ10c', 'nothing new happened: no summary');
  // Telegram refused: the summary goes to the operator address instead.
  fresh();
  world.tgHook = ({ chat }) => (String(chat) === String(OP) ? tgRefuse() : null);
  const mailed = await job(at(0));
  world.tgHook = null;
  line(mailed.operatorMail.length === 1 && mailed.out.operator === 'email' && String(mailed.operatorMail[0].body.text).includes('Newly warned:'),
    'BJ10d', 'Telegram refused: the summary goes by email');
}

/* BJ11 */
{
  fresh();
  const bad = await Promise.all([
    applyPayment({ businessId: 'nope', paidUntil: P }), applyPayment({ businessId: A, paidUntil: 'x' }),
    applyPayment({ businessId: bizId(99), paidUntil: P + DAY }),
  ]);
  line(same(bad.map((r) => r.reason), ['bad_request', 'bad_request', 'not_found']), 'BJ11', 'bad input and an unknown business are refused');
  set(A, { billing_warning_stage: 3 });
  const target = P + 30 * DAY;
  const first = await during(() => applyPayment({ businessId: A, paidUntil: target }));
  const second = await during(() => applyPayment({ businessId: A, paidUntil: target }));
  const shorter = await during(() => applyPayment({ businessId: A, paidUntil: P + DAY }));
  line(first.out.changed && get(A).paid_until === iso(target) && get(A).billing_warning_stage === 0 && first.sends.length === 0
    && !second.out.changed && second.w.length === 0 && !shorter.out.changed && shorter.out.paidUntil === target && get(A).paid_until === iso(target),
    'BJ11b', 'forward only, idempotent, clears the stage', `${first.out.changed} ${second.out.changed} ${shorter.out.changed}`);

  const restoreCase = async (patch, mode, opts = {}) => {
    fresh({ [A]: patch });
    if (opts.leads) world.store.leads.push(...opts.leads);
    const now = at(8);
    const r = await during(() => applyPayment({ businessId: A, paidUntil: now + 30 * DAY, ...(mode ? { reactivate: mode } : {}), now }));
    return { r, now };
  };
  const held = [1, 2].map((n) => ({ id: `h${n}`, business_id: A, idempotency_key: `h${n}`, status: 'open', created_at: iso(P + 6 * DAY), held_at: iso(P + 6 * DAY) }));
  const paused = await restoreCase({ status: 'paused', suspended_for_billing: true, billing_warning_stage: 4 }, null, { leads: held });
  const text = textOf(paused.r.sends[0]);
  const keyboards = paused.r.sends.map((m) => (m.body.reply_markup && m.body.reply_markup.keyboard
    ? m.body.reply_markup.keyboard[0].map((k) => k.text).join('+')
    : 'inline')).sort().join(' ');
  // Message 1 says ONE thing, with the role keyboards. Message 2 (to each
  // phone) is the held leads themselves, in /leads' format.
  const firsts = paused.r.sends.filter((m) => textOf(m) === 'Your service is active again.');
  const seconds = paused.r.sends.filter((m) => textOf(m).startsWith('Recent requests\n\nReceived while suspended: 2'));
  line(paused.r.out.reactivated && state(A) === 'active/0/false'
    && firsts.length === 2 && firsts.every((m) => same(m.body.reply_markup, { keyboard: [[{ text: 'Invite' }, { text: 'Leads' }]], is_persistent: true, resize_keyboard: true })
      || same(m.body.reply_markup, { keyboard: [[{ text: 'Leads' }]], is_persistent: true, resize_keyboard: true }))
    && seconds.length === 2 && seconds.every((m) => m.body.reply_markup && m.body.reply_markup.inline_keyboard
      && m.body.reply_markup.inline_keyboard[0].length === 2)
    && paused.r.mail.length === 1 && paused.r.mail[0].body.subject === 'Your service is active again' && paused.r.out.held === 2,
    'BJ11c', 'a suspended business is restored: keyboards, held count', `${state(A)} kb=${keyboards} held=${paused.r.out.held} first=${firsts.length} second=${seconds.length}`);
  const churned = await restoreCase({ status: 'churned', suspended_for_billing: true, billing_warning_stage: 6 }, null);
  line(churned.r.out.reactivated && state(A) === 'active/0/false' && churned.r.sends.length === 2 && !textOf(churned.r.sends[0]).includes('came in while'),
    'BJ11d', 'a terminated business is restored; no held line when none', state(A));
  const byHand = await restoreCase({ status: 'paused' }, null);
  const byHandAny = await restoreCase({ status: 'paused' }, 'any');
  const churnedAny = await restoreCase({ status: 'churned' }, 'any');
  const never = await restoreCase({ status: 'paused', suspended_for_billing: true }, 'never');
  line(byHand.r.out.changed && !byHand.r.out.reactivated && byHand.r.sends.length === 0 && byHandAny.r.out.reactivated && churnedAny.r.out.reactivated
    && !never.r.out.reactivated && never.r.out.wasSuspended && state(A) === 'paused/0/true',
    'BJ11e', 'by hand: only with "any"; "never" leaves the status', `${byHand.r.out.reactivated} ${byHandAny.r.out.reactivated} ${churnedAny.r.out.reactivated} ${never.r.out.reactivated}`);
}

/* BJ12 */
{
  fresh({ [A]: { status: 'paused', suspended_for_billing: true, paid_until: iso(P + 40 * DAY), billing_warning_stage: 0 } });
  const r = await job(at(8));
  line(state(A) === 'active/0/false' && r.out.restored === 1 && r.sends.length === 2 && r.operator.some((m) => textOf(m).includes('Back in service:\nAlder Roofing')),
    'BJ12', 'the job restores a billing-suspended business that paid', state(A));
}

/* BJ13 */
{
  fresh();
  await job(at(0));
  const rows = world.store.events.filter((e) => e.business_id === A).map((e) => `${e.type}/${e.channel}/${e.status}/${e.error_class || ''}/${e.provider_id ? 'id' : ''}`);
  const want = ['overdue/none/expected//', 'overdue/telegram/sent//', 'overdue/telegram/sent//', 'overdue/email/sent//id'];
  const keys = new Set(world.store.events.flatMap((e) => Object.keys(e)));
  const onlyKnown = [...keys].every((k) => ['id', 'business_id', 'type', 'channel', 'status', 'error_class', 'provider_id', 'created_at'].includes(k));
  const dump = JSON.stringify(world.store.events);
  line(same(rows, want) && onlyKnown && !dump.includes('fixture.invalid') && !dump.includes(String(OWNER)) && !dump.includes('Your payment'),
    'BJ13', 'the notice log: expected + one row per attempt, no PII', rows.join(' '));
  // Without migration 0007 the job does everything the same.
  fresh();
  world.store.no0007 = true;
  const r = await job(at(5));
  line(state(A) === 'paused/4/true' && r.sends.length === 2 && r.mail.length === 1 && world.store.events.length === 0, 'BJ13b', 'without migration 0007 the job still works', state(A));
}

/* BJ14 */
{
  fresh();
  const rows = () => world.store.chats.filter((c) => c.business_id === A);
  const t1 = Date.parse('2026-11-16T10:00:00Z');
  const one = await during(() => SS.suspendBusiness({ business: get(A), rows: rows(), now: t1 }, DEFAULT_IO));
  await during(() => SS.reactivateBusiness({ business: get(A), rows: rows(), now: t1 + HOUR }, DEFAULT_IO), { keepMail: true });
  const two = await during(() => SS.suspendBusiness({ business: get(A), rows: rows(), now: t1 + 2 * HOUR }, DEFAULT_IO), { keepMail: true });
  const k1 = keyOf(one.mail[0] || { headers: {} });
  const k2 = keyOf(two.mail[0] || { headers: {} });
  line(one.mail.length === 1 && two.mail.length === 1 && k1 !== k2 && k1 === `suspension:${A}:${t1}` && k2 === `suspension:${A}:${t1 + 2 * HOUR}`
    && world.store.events.filter((e) => e.type === 'suspension' && e.channel === 'email' && e.status === 'sent').length === 2,
    'BJ14', 'two suspensions on one day: two emails, two keys', `${k1} ${k2}`);
  const m = one.mail[0];
  const replyTo = [].concat(m.body.reply_to || []).join(',');
  // Every paragraph's last two words are joined by a non-breaking space, so the
  // help line ends "we will\u00A0help."; the words are the same.
  const plainText = String(m.body.text).replace(/\u00A0/g, ' ');
  line(replyTo === OPERATOR_MAIL && plainText.endsWith('Reply to this email and we will help.') && !/<a\s/i.test(String(m.body.html).split('Sent by Lead Alerts')[0].split('</table>').pop() || '')
    && !/https?:\/\/t\.me/.test(String(m.body.text)), 'BJ14b', 'owner email: Reply-To support, help line, no button', replyTo);
}

/* BJ15 */
{
  fresh();
  world.sbHook = ({ table, method, params }) => (table === 'businesses' && method === 'GET' && params.some(([k, v]) => k === 'select' && v.includes('paid_until'))
    ? new Response(JSON.stringify({ code: '42703', message: 'column businesses.paid_until does not exist' }), { status: 400, headers: { 'content-type': 'application/json' } }) : null);
  const r = await job(at(5));
  world.sbHook = null;
  line(same(r.out, { ok: true, skipped: 'unavailable' }) && r.sends.length === 0 && r.w.length === 0, 'BJ15', 'no billing columns: "unavailable", nothing done');
  const selfcheck = fs.readFileSync(path.join(ROOT, 'api', 'selfcheck.js'), 'utf8');
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  line(/runBillingJob\(\)/.test(selfcheck) && (vercel.crons || []).length === 2 && !(vercel.crons || []).some((c) => /billing/.test(c.path)),
    'BJ15b', 'the job runs inside the daily self-check: no new cron', `crons=${(vercel.crons || []).length}`);
}

/* BJ16 */
{
  const { tg, mail } = await everything();
  const sends = tg.filter((x) => x.path.endsWith('/sendMessage'));
  const parse = sends.filter((x) => 'parse_mode' in (x.body || {})).length;
  const long = [...new Set(sends.filter((x) => String(x.body.chat_id) !== String(OP)).flatMap((x) => longLines(textOf(x))))];
  line(sends.length > 40 && parse === 0, 'BJ16', 'no request carried parse_mode', `sends=${sends.length} parse=${parse}`);
  line(long.length === 0, 'BJ16b', 'no line over 34 characters reached a business', long.slice(0, 3).join(' | '));
  const ownerMail = mail.filter((m) => toOf(m) !== OPERATOR_MAIL);
  // Every lifecycle email is Reply-To support. The help line is on every one
  // except the mails that deliberately offer no reply path: the reactivation
  // mail (the service is back) and the daily held-leads mail (a count only).
  const NO_HELP = /^(Your service is active again|New requests are waiting)$/;
  line(ownerMail.length > 10 && ownerMail.every((m) => [].concat(m.body.reply_to || []).join(',') === OPERATOR_MAIL
    && (String(m.body.text).replace(/\u00A0/g, ' ').includes('Reply to this email and we will help.') || NO_HELP.test(String(m.body.subject)))),
    'BJ16c', 'every owner email: Reply-To support and the help line', `mails=${ownerMail.length}`);
}

console.log(`\nGate BJ (billing job): ${total - failed}/${total} PASS`);
process.exit(failed ? 1 : 0);
