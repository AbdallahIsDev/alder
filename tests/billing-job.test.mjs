#!/usr/bin/env node
// tests/billing-job.test.mjs — Gate BJ (the daily billing job and applyPayment).
// HARNESS: in-process, no HTTP server, no database. PostgREST is faked at the
// fetch layer with a small in-memory store (the pattern of
// tests/operator-browser.test.mjs); Telegram and Resend are the loopback fakes.
// The clock is passed in: every run names its own `now`.
//
// The rules themselves (dates, boundaries, texts) are tests/billing.test.mjs;
// the operator's screens and the Extend button are OB24–OB28 in
// tests/operator-browser.test.mjs. This suite is what the job DOES.
//
// THE FAKE'S ONE SHORTCUT: hit_rate_limit buckets a key by the database's own
// clock. The fake keeps one bucket per key until newDay() empties it, which is
// what "the next UTC day" is to the real function.
//
// What it proves:
//   BJ1  GET /api/billing: 405 for another method; 503 without HEALTH_SECRET;
//        401 for no or a wrong secret; x-health-secret and the cron bearer
//        each work and neither is accepted in the other's place; the answer
//        is counts only and is never cached
//   BJ2  the job reads ONLY businesses with status 'active' and a paid_until:
//        a demo, paused, churned or unbilled business is never read, warned,
//        suspended or written, however overdue; and even a database that
//        returned them anyway would change nothing
//   BJ3  paid: a leftover warning stage is reset to 0 in one scoped update;
//        stage 0 writes nothing; nobody is told
//   BJ4  grace, stage 0: ONE overdue warning to every bound phone and one
//        plain email to the owner, THEN stage 1; the same day again: nothing
//        sent, nothing written; the following days: nothing until the final
//   BJ5  a day or less of grace left: ONE final warning, stage 2, from stage
//        1 or straight from stage 0; once only; and never a second billing
//        notice on the same day (a suspension that falls due later that day
//        waits for the next day's run)
//   BJ6  expired: suspended through the operator's Suspend code path: the
//        same requests in the same order (notice with ReplyKeyboardRemove to
//        every phone and the owner email BEFORE one scoped status update),
//        differing only in the words, the email key, and
//        suspended_for_billing; bindings untouched; a second run does nothing
//   BJ7  failed notices: one phone failing does not hold the stage back;
//        when NOTHING could be delivered and there was somebody to tell, the
//        stage stays, nothing is retried that day, and the next day tries
//        again; nobody to tell at all: the stage advances; the email alone
//        counts as a notice; a failed notice never blocks a suspension
//   BJ8  one business that cannot be processed does not stop the others, and
//        nothing is recorded for it
//   BJ9  the operator summary: one message, to the operator chat only, only
//        when something happened; exact text; business names only; at most
//        one standing summary a day; email when Telegram is refused; the
//        day's slot is given back when nobody could be told
//   BJ10 applyPayment, the seam: bad input and unknown business refused;
//        forward only (never shortens); the same payment twice writes once;
//        clears the stage; reactivates only a business the billing job
//        suspended unless told 'any'; 'never' leaves the status alone
//   BJ11 a whole life: paid, overdue, warned, final, suspended, paid again
//        (reactivated with notices), and a second overdue period warns again
//   BJ12 a database without the billing columns: the job reports
//        "unavailable" and does nothing; and the job runs inside the daily
//        self-check, after housekeeping, without changing its answer or
//        adding a cron
//   BJ13 over the whole suite: no request carried parse_mode; every billing
//        text is plain
//
// Mutation: set the stage before sending in runBillingJob and BJ4's order
// check fails; drop the `.eq('status', 'active')` of listBilledBusinesses and
// BJ2 fails; make applyPayment write without the forward-only filter and BJ10
// fails.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.mjs';
import { fakeRes } from './helpers.mjs';
import { FIXTURE_CHATS } from './fixture-ids.mjs';

loadEnv();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0, total = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(5)}${String(what).padEnd(56)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 130) : ''}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// In-memory only.
const OWNER = FIXTURE_CHATS.billingOwner;
const STAFF = FIXTURE_CHATS.billingStaff;
const CHAT_B = FIXTURE_CHATS.billingB;
const OTHER = FIXTURE_CHATS.billingOther;
const OP = FIXTURE_CHATS.billingOperator;

const saved = {};
for (const k of ['TELEGRAM_API_BASE', 'VERCEL_ENV', 'OPERATOR_CHAT_ID', 'OPERATOR_EMAIL', 'TELEGRAM_CHAT_ID', 'RESEND_API_BASE', 'RESEND_API_KEY',
  'MAIL_FROM', 'MAIL_REDIRECT_TO', 'HEALTH_SECRET', 'CRON_SECRET', 'TELEGRAM_WEBHOOK_SECRET']) saved[k] = process.env[k];
process.env.TELEGRAM_API_BASE = process.env.FAKE_TG_URL;
process.env.VERCEL_ENV = 'development';
process.env.OPERATOR_CHAT_ID = String(OP);
process.env.OPERATOR_EMAIL = 'operator@fixture.invalid';
delete process.env.TELEGRAM_CHAT_ID;
process.env.RESEND_API_BASE = process.env.FAKE_RESEND_URL;
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'billing-job-test-key';
process.env.MAIL_FROM = 'alerts@fixture.invalid';
delete process.env.MAIL_REDIRECT_TO;

const TG = process.env.FAKE_TG_URL;
const MAIL = process.env.FAKE_RESEND_URL;
const realFetch = globalThis.fetch;
const post = (url, body) => realFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const allTg = [];
const tgReqs = async () => (await (await realFetch(TG + '/__requests')).json()).requests;
const tgReset = async () => { try { allTg.push(...(await tgReqs())); } catch {} await post(TG + '/__reset'); };
const mailReqs = async () => (await (await realFetch(MAIL + '/__requests')).json()).requests.filter((x) => x.path === '/emails');
const mailCtl = (body) => post(MAIL + '/__control', body);

/* ---------- a very small PostgREST ---------- */

const biz = (n) => `b${String(n).padStart(7, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = biz(1);       // Alder Roofing: active, two phones, an owner address
const B = biz(2);       // Beta Roofing: active, one phone
const C = biz(3);       // Cedar Co: active, no phone, an owner address
const D = biz(4);       // Delta Roofs: active, no phone, no owner address
const DEMO = biz(5);    // demo, one phone
const PAUSED = biz(6);  // suspended by hand, one phone
const CHURNED = biz(7);
const NEVER = biz(8);   // active, never billed, one phone

const DAY = 86400000;
const HOUR = 3600000;
const PAID = '2026-12-14T09:00:00.000Z';
const P = Date.parse(PAID);
const END = P + 7 * DAY;                     // Dec 21, 09:00 UTC
const iso = (ms) => new Date(ms).toISOString();

const row = (id, slug, name, status, patch = {}) => ({
  id, slug, name, status, timezone: 'America/Chicago', owner_email: `${slug}@fixture.invalid`, google_review_url: 'https://g.page/r/x',
  site_host: `${slug}.test`, paid_until: null, billing_warning_stage: 0, suspended_for_billing: false, ...patch,
});

let store;
let sbRequests = [];
let trace = [];
let sbHook = null;
let tgHook = null;
const tgRefuse = () => new Response(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: fake refusal' }),
  { status: 403, headers: { 'content-type': 'application/json' } });
const fail500 = () => new Response('{"message":"fake failure"}', { status: 500, headers: { 'content-type': 'application/json' } });

/** Every business the job could meet. The four it must never touch are long
 *  past any grace period, so an unscoped job would act on all of them. */
const fresh = (patches = {}) => {
  const longAgo = iso(P - 60 * DAY);
  const rows = [
    row(A, 'alder', 'Alder Roofing', 'active', { paid_until: PAID }),
    row(B, 'beta', 'Beta Roofing', 'active'),
    row(C, 'cedar', 'Cedar Co', 'active'),
    row(D, 'delta', 'Delta Roofs', 'active', { owner_email: null }),
    row(DEMO, 'demo-co', 'Demo Roofing', 'demo', { paid_until: longAgo }),
    row(PAUSED, 'paused-co', 'Paused Co', 'paused', { paid_until: longAgo }),
    row(CHURNED, 'churned-co', 'Churned Co', 'churned', { paid_until: longAgo }),
    row(NEVER, 'never', 'Never Billed', 'active'),
  ];
  for (const r of rows) Object.assign(r, patches[r.id] || {});
  return {
    businesses: rows,
    chats: [
      { id: 'c1', business_id: A, tg_chat_id: OWNER, label: null, created_at: '2026-11-01T10:00:00Z' },
      { id: 'c2', business_id: A, tg_chat_id: STAFF, label: 'Van', created_at: '2026-11-02T10:00:00Z' },
      { id: 'c3', business_id: B, tg_chat_id: CHAT_B, label: null, created_at: '2026-11-03T10:00:00Z' },
      { id: 'c4', business_id: DEMO, tg_chat_id: OTHER, label: null, created_at: '2026-11-04T10:00:00Z' },
      { id: 'c5', business_id: PAUSED, tg_chat_id: OTHER + 1, label: null, created_at: '2026-11-04T10:00:00Z' },
      { id: 'c6', business_id: NEVER, tg_chat_id: OTHER + 2, label: null, created_at: '2026-11-04T10:00:00Z' },
    ],
    claims: new Map(),
  };
};
const get = (id) => store.businesses.find((b) => b.id === id);
const set = (id, patch) => Object.assign(get(id), patch);
/** The next UTC day, as the rate-limit function sees it. */
const newDay = () => store.claims.clear();
const snapshot = () => JSON.stringify({ b: store.businesses, c: store.chats });
const untouchable = () => JSON.stringify(store.businesses.filter((b) => [DEMO, PAUSED, CHURNED, NEVER].includes(b.id)));

const match = (r, params) => {
  for (const [key, raw] of params) {
    if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
    const v = r[key];
    if (raw.startsWith('eq.')) { if (String(v) !== raw.slice(3)) return false; continue; }
    if (raw === 'is.null') { if (v !== null && v !== undefined) return false; continue; }
    if (raw === 'not.is.null') { if (v === null || v === undefined) return false; continue; }
    // As in SQL, NULL is not before anything.
    if (raw.startsWith('lt.')) { if (v === null || v === undefined || !(new Date(v) < new Date(raw.slice(3)))) return false; continue; }
    if (raw.startsWith('in.(')) {
      const list = raw.slice(4, -1).split(',').map((x) => x.replace(/^"|"$/g, ''));
      if (!list.includes(String(v))) return false;
      continue;
    }
    throw new Error(`fake PostgREST: unknown filter ${key}=${raw}`);
  }
  return true;
};
const byOrder = (order) => {
  const cols = String(order || '').split(',').filter(Boolean).map((c) => c.split('.')[0]);
  return (a, b) => {
    for (const name of cols) {
      const av = String(a[name] == null ? '' : a[name]);
      const bv = String(b[name] == null ? '' : b[name]);
      if (av < bv) return -1;
      if (av > bv) return 1;
    }
    return 0;
  };
};

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const SB = process.env.SUPABASE_URL;
  if (!url.startsWith(SB)) {
    let chat = null;
    try { chat = JSON.parse(init.body || '{}').chat_id; } catch { chat = null; }
    const method = url.split('/').pop();
    const kind = url.startsWith(MAIL) ? 'mail' : 'tg';
    trace.push({ kind, method, chat: chat == null ? null : String(chat), phase: 'start' });
    try {
      const forced = kind === 'tg' && tgHook ? tgHook({ method, chat }) : null;
      return forced || await realFetch(input, init);
    } finally {
      trace.push({ kind, method, chat: chat == null ? null : String(chat), phase: 'end' });
    }
  }
  const u = new URL(url);
  const table = u.pathname.replace('/rest/v1/', '');
  const method = String(init.method || 'GET').toUpperCase();
  const params = [...u.searchParams.entries()];
  let sent = null;
  try { sent = init.body ? JSON.parse(init.body) : null; } catch { sent = null; }
  sbRequests.push({ table, method, params, body: sent });
  trace.push({ kind: 'sb', table, method, phase: 'start' });
  if (sbHook) {
    const forced = await sbHook({ table, method, params, body: sent });
    if (forced) return forced;
  }
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  if (table === 'rpc/hit_rate_limit') {
    const n = (store.claims.get(sent.p_key) || 0) + 1;
    store.claims.set(sent.p_key, n);
    return json(n <= Number(sent.p_max || 1));
  }
  if (table === 'rate_limits') {
    if (method === 'DELETE') store.claims.delete(String(u.searchParams.get('key') || '').replace(/^eq\./, ''));
    return json([]);
  }
  if (table === 'business_chats') {
    const rows = store.chats.filter((r) => match(r, params)).sort(byOrder(u.searchParams.get('order')));
    return json(rows.map((r) => ({ ...r })));
  }
  if (table === 'businesses') {
    if (method === 'PATCH') {
      const hit = store.businesses.filter((r) => match(r, params));
      for (const r of hit) Object.assign(r, sent || {});
      return json(hit.map((r) => ({ id: r.id })));
    }
    const rows = store.businesses.filter((r) => match(r, params)).sort(byOrder(u.searchParams.get('order')));
    if (u.searchParams.get('id')) return json(rows[0] ? { ...rows[0] } : null);
    return json(rows.map((r) => ({ ...r })));
  }
  return json([]);
};

const { runBillingJob, applyPayment } = await import('../lib/billing-ops.js');
const BL = await import('../lib/billing.js');
const C2 = await import('../lib/content.js');

const param = (r, key) => (r.params.find(([k]) => k === key) || [])[1];
const writes = (reqs) => reqs.filter((q) => !['GET', 'HEAD'].includes(q.method) && q.table !== 'rpc/hit_rate_limit' && q.table !== 'rate_limits');
const textOf = (req) => String((req && req.body && req.body.text) || '');
const toOf = (m) => [].concat(m.body.to).join(',');
const keyOf = (m) => String(m.headers['idempotency-key'] || '');

/** One call of anything: what Telegram and the mail service received, what
 *  the database was asked, and in which order. The operator's messages are
 *  kept apart from the businesses'. */
const during = async (fn) => {
  await tgReset();
  await post(MAIL + '/__reset');
  await mailCtl({ clearIdempotency: true });
  sbRequests = [];
  trace = [];
  const out = await fn();
  const tg = (await tgReqs()).filter((x) => x.path.endsWith('/sendMessage'));
  const mail = await mailReqs();
  return {
    out, tg, sb: sbRequests.slice(), trace: trace.slice(),
    sends: tg.filter((x) => String(x.body.chat_id) !== String(OP)),
    operator: tg.filter((x) => String(x.body.chat_id) === String(OP)),
    mail: mail.filter((m) => toOf(m) !== 'operator@fixture.invalid'),
    operatorMail: mail.filter((m) => toOf(m) === 'operator@fixture.invalid'),
    w: writes(sbRequests),
  };
};
const job = (now) => during(() => runBillingJob({ now }));
const quiet = (r) => r.sends.length === 0 && r.mail.length === 0 && r.w.length === 0;
const counts = (out, want) => same(
  { checked: out.checked, reset: out.reset, warned: out.warned, final_warned: out.final_warned, suspended: out.suspended, unwarned: out.unwarned, failed: out.failed, grace: out.grace, due: out.due },
  { checked: 1, reset: 0, warned: 0, final_warned: 0, suspended: 0, unwarned: 0, failed: 0, grace: 0, due: 0, ...want });
/** Whether every send and mail of the trace had finished before the first
 *  database write started. */
const noticesBeforeWrite = (tr) => {
  const firstWrite = tr.findIndex((e) => e.kind === 'sb' && e.table === 'businesses' && e.method === 'PATCH');
  const lastNotice = tr.reduce((acc, e, i) => ((e.kind === 'tg' || e.kind === 'mail') && e.chat !== String(OP) ? i : acc), -1);
  return firstWrite > 0 && lastNotice >= 0 && lastNotice < firstWrite;
};

const OVERDUE_A = 'Payment for Alder Roofing is overdue. Your service will be suspended on Dec 21 unless payment is received. Contact support.';
const FINAL_A = 'Final notice: payment for Alder Roofing is overdue. Your service will be suspended on Dec 21 unless payment is received. Contact support.';
const SUSPENDED_NOTICE = 'Your service has been suspended because payment was not received. Contact support.';

try {
  /* BJ1: the endpoint. */
  store = fresh({ [A]: { paid_until: iso(Date.now() - 2 * DAY) } });
  {
    const { default: handler } = await import('../api/billing.js');
    const call = async (headers, method = 'GET') => {
      const res = fakeRes();
      const r = await during(() => handler({ method, headers: headers || {}, query: {} }, res));
      return { res, r };
    };
    process.env.HEALTH_SECRET = 'billing-health-secret-value';
    process.env.CRON_SECRET = 'billing-cron-secret-value';
    const before = snapshot();
    const wrongMethod = await call({ 'x-health-secret': 'billing-health-secret-value' }, 'POST');
    const none = await call({});
    const wrong = await call({ 'x-health-secret': 'nope-nope-nope-nope-nope-nope' });
    // Neither secret opens the other's door.
    const crossed = await call({ 'x-health-secret': 'billing-cron-secret-value' });
    const crossed2 = await call({ authorization: 'Bearer billing-health-secret-value' });
    const notBearer = await call({ authorization: 'billing-cron-secret-value' });
    delete process.env.HEALTH_SECRET;
    const noEnv = await call({ authorization: 'Bearer billing-cron-secret-value' });
    process.env.HEALTH_SECRET = 'billing-health-secret-value';
    const refusedOk = wrongMethod.res.code === 405 && wrongMethod.res.headers.Allow === 'GET'
      && [none, wrong, crossed, crossed2, notBearer].every((x) => x.res.code === 401 && same(x.res.body, { ok: false }))
      && noEnv.res.code === 503 && same(noEnv.res.body, { ok: false })
      && [wrongMethod, none, wrong, crossed, crossed2, notBearer, noEnv].every((x) => x.r.sb.length === 0 && x.r.tg.length === 0 && x.r.mail.length === 0)
      && snapshot() === before;
    // Authorised: the job runs (Alder is two days overdue) and answers in counts.
    const viaHeader = await call({ 'x-health-secret': 'billing-health-secret-value' });
    const body = viaHeader.res.body || {};
    const ranOk = viaHeader.res.code === 200 && viaHeader.res.headers['Cache-Control'] === 'no-store'
      && same(body, { ok: true, checked: 1, reset: 0, warned: 1, final_warned: 0, suspended: 0, unwarned: 0, failed: 0, grace: 1, due: 0, operator: 'telegram' })
      && get(A).billing_warning_stage === 1 && viaHeader.r.sends.length === 2;
    // Nothing in the answer but fixed words and numbers.
    const countsOnly = Object.values(body).every((v) => typeof v === 'number' || typeof v === 'boolean' || ['telegram', 'email', 'undelivered', 'none'].includes(v))
      && !/Alder|fixture|@/.test(JSON.stringify(body));
    // The cron's bearer works too; the job has nothing left to do today.
    const viaCron = await call({ authorization: 'Bearer billing-cron-secret-value' });
    const cronOk = viaCron.res.code === 200 && viaCron.res.body.ok === true && viaCron.res.body.warned === 0 && quiet(viaCron.r);
    // No CRON_SECRET configured: a bearer opens nothing, the header still does.
    delete process.env.CRON_SECRET;
    const noCron = await call({ authorization: 'Bearer ' });
    const noCron2 = await call({ authorization: 'Bearer undefined' });
    const stillHeader = await call({ 'x-health-secret': 'billing-health-secret-value' });
    const noCronOk = noCron.res.code === 401 && noCron2.res.code === 401 && stillHeader.res.code === 200;
    line(refusedOk && ranOk && countsOnly && cronOk && noCronOk, 'BJ1', '/api/billing: auth as the other daily jobs, counts only',
      `refused=${refusedOk} ran=${ranOk} counts=${countsOnly} cron=${cronOk} nocron=${noCronOk}`);
  }

  /* BJ2: who the job may touch. */
  store = fresh({ [A]: { paid_until: null } });
  {
    const before = snapshot();
    const r = await job(END + 30 * DAY);
    const read = r.sb.filter((q) => q.table === 'businesses');
    // One read, scoped to served-and-billed.
    const scoped = read.length === 1 && read[0].method === 'GET'
      && param(read[0], 'status') === 'eq.active' && param(read[0], 'paid_until') === 'not.is.null';
    const nothing = r.tg.length === 0 && r.mail.length === 0 && r.operatorMail.length === 0 && r.w.length === 0 && r.sb.length === 1
      && snapshot() === before && r.out.checked === 0 && r.out.operator === 'none';
    // A database that hands them over anyway (a filter lost in a refactor):
    // the decision itself still refuses every one of them.
    sbHook = ({ table, method }) => (table === 'businesses' && method === 'GET'
      ? new Response(JSON.stringify(store.businesses.map((b) => ({ ...b }))), { status: 200, headers: { 'content-type': 'application/json' } }) : null);
    const leaky = await job(END + 30 * DAY);
    sbHook = null;
    const leakyOk = leaky.tg.length === 0 && leaky.mail.length === 0 && leaky.w.length === 0 && snapshot() === before && leaky.out.checked === 8;
    // With a business that IS due, the others still see nothing.
    set(A, { paid_until: PAID });
    const mixed = await job(P + DAY);
    const others = [OTHER, OTHER + 1, OTHER + 2, CHAT_B].map(String);
    const mixedOk = mixed.sends.length === 2 && !mixed.sends.some((m) => others.includes(String(m.body.chat_id)))
      && mixed.mail.length === 1 && toOf(mixed.mail[0]) === 'alder@fixture.invalid'
      && mixed.w.every((q) => param(q, 'id') === `eq.${A}`);
    line(scoped && nothing && leakyOk && mixedOk && untouchable() === JSON.stringify(JSON.parse(before).b.filter((b) => [DEMO, PAUSED, CHURNED, NEVER].includes(b.id))),
      'BJ2', 'only active + billed is read; demo/paused/churned untouched',
      `scoped=${scoped} nothing=${nothing} leaky=${leakyOk} mixed=${mixedOk}`);
  }

  /* BJ3: paid. */
  store = fresh();
  {
    // Paid, stage 0: not a single write, nobody told, no summary (13 days to go).
    const clean = await job(P - 13 * DAY);
    const cleanOk = quiet(clean) && clean.operator.length === 0 && counts(clean.out, {}) && clean.sb.length === 1;
    // Paid again after warnings (the stage was left behind): reset, quietly.
    const resets = [];
    for (const stage of [1, 2]) {
      set(A, { billing_warning_stage: stage });
      const r = await job(P - 13 * DAY);
      const ok = r.sends.length === 0 && r.mail.length === 0 && r.operator.length === 0 && r.w.length === 1
        && r.w[0].table === 'businesses' && r.w[0].method === 'PATCH' && same(r.w[0].body, { billing_warning_stage: 0 })
        && param(r.w[0], 'id') === `eq.${A}` && param(r.w[0], 'status') === 'eq.active' && param(r.w[0], 'billing_warning_stage') === `eq.${stage}`
        && get(A).billing_warning_stage === 0 && counts(r.out, { reset: 1 });
      if (!ok) resets.push(stage);
    }
    // Due within three days: the operator hears it (once a day), nothing else moves.
    const soon = await job(P - 2 * DAY);
    const soonAgain = await job(P - 2 * DAY + HOUR);
    const soonOk = quiet(soon) && soon.operator.length === 1 && textOf(soon.operator[0]) === 'Billing\n\nDue within 3 days: Alder Roofing (Dec 14)'
      && counts(soon.out, { due: 1 }) && soon.out.operator === 'telegram'
      && quiet(soonAgain) && soonAgain.operator.length === 0 && soonAgain.out.operator === 'none';
    line(cleanOk && resets.length === 0 && soonOk, 'BJ3', 'paid: stage reset in one scoped update; due soon is said once',
      `clean=${cleanOk} reset=${resets.join(',') || 'ok'} soon=${soonOk}`);
  }

  /* BJ4: the overdue warning, once. */
  store = fresh();
  {
    const before = untouchable();
    const now = P + DAY;
    const r = await job(now);
    const phones = r.sends.map((m) => String(m.body.chat_id)).sort();
    const noticeOk = same(phones, [String(OWNER), String(STAFF)].sort())
      && r.sends.every((m) => textOf(m) === OVERDUE_A && !('reply_markup' in m.body) && !('parse_mode' in m.body) && !('entities' in m.body));
    const mailOk = r.mail.length === 1 && toOf(r.mail[0]) === 'alder@fixture.invalid' && r.mail[0].body.subject === 'Payment overdue'
      && r.mail[0].body.text === OVERDUE_A && keyOf(r.mail[0]) === `billing:overdue:${A}:2026-12-15`
      && String(r.mail[0].body.html).includes('Payment for Alder Roofing is overdue.');
    const writeOk = r.w.length === 1 && r.w[0].method === 'PATCH' && same(r.w[0].body, { billing_warning_stage: 1 })
      && param(r.w[0], 'id') === `eq.${A}` && param(r.w[0], 'status') === 'eq.active' && param(r.w[0], 'billing_warning_stage') === 'eq.0'
      && get(A).billing_warning_stage === 1 && get(A).status === 'active' && get(A).paid_until === PAID && get(A).suspended_for_billing === false;
    const orderOk = noticesBeforeWrite(r.trace);
    const summaryOk = r.operator.length === 1 && textOf(r.operator[0]) === 'Billing\n\nOverdue warning sent: Alder Roofing\nOverdue: Alder Roofing (suspends Dec 21)'
      && counts(r.out, { warned: 1, grace: 1 }) && r.out.operator === 'telegram';
    // Twice on the same day: nothing new is sent and nothing changes.
    const afterFirst = snapshot();
    const again = await job(now + 2 * HOUR);
    const third = await job(now + 5 * HOUR);
    const againOk = [again, third].every((x) => quiet(x) && x.operator.length === 0 && x.operatorMail.length === 0 && counts(x.out, { grace: 1 }) && x.out.operator === 'none')
      && snapshot() === afterFirst;
    // The days that follow, until a day is left: the business is not told
    // again; the operator gets the one standing line a day.
    const quietDays = [];
    for (const d of [2, 3, 4, 5]) {
      newDay();
      const x = await job(P + d * DAY);
      if (!(quiet(x) && x.operator.length === 1 && textOf(x.operator[0]) === 'Billing\n\nOverdue: Alder Roofing (suspends Dec 21)')) quietDays.push(d);
    }
    line(noticeOk && mailOk && writeOk && orderOk && summaryOk && againOk && quietDays.length === 0 && snapshot() === afterFirst && untouchable() === before,
      'BJ4', 'grace: one overdue warning to every phone + owner, then stage 1',
      `notice=${noticeOk} mail=${mailOk} write=${writeOk} order=${orderOk} summary=${summaryOk} again=${againOk} later=${quietDays.join(',') || 'quiet'}`);
  }

  /* BJ5: the final warning, once. */
  store = fresh({ [A]: { billing_warning_stage: 1 } });
  {
    // More than the window left: not yet.
    const early = await job(END - BL.FINAL_WARNING_MS - 60000);
    const earlyOk = quiet(early) && get(A).billing_warning_stage === 1;
    newDay();
    const now = END - 20 * HOUR;
    const r = await job(now);
    const noticeOk = r.sends.length === 2 && r.sends.every((m) => textOf(m) === FINAL_A && !('reply_markup' in m.body))
      && r.mail.length === 1 && r.mail[0].body.subject === 'Final notice: payment overdue' && r.mail[0].body.text === FINAL_A
      && keyOf(r.mail[0]) === `billing:final:${A}:2026-12-20`;
    const writeOk = r.w.length === 1 && same(r.w[0].body, { billing_warning_stage: 2 }) && param(r.w[0], 'billing_warning_stage') === 'eq.1'
      && get(A).billing_warning_stage === 2 && get(A).status === 'active' && noticesBeforeWrite(r.trace);
    const summaryOk = r.operator.length === 1 && textOf(r.operator[0]) === 'Billing\n\nFinal warning sent: Alder Roofing\nOverdue: Alder Roofing (suspends Dec 21)'
      && counts(r.out, { final_warned: 1, grace: 1 });
    const again = await job(now + HOUR);
    // A run later the SAME day, after the grace period has ended: the
    // business was already sent a notice today, so the suspension waits for
    // tomorrow's run. Never two billing notices in one day.
    const sameDay = await job(END + HOUR);
    const sameDayOk = quiet(sameDay) && get(A).status === 'active' && sameDay.out.suspended === 0;
    newDay();
    // The last hours of the grace period, on another day: still nothing more.
    const lastHours = await job(END - 60000);
    const onceOk = quiet(again) && again.operator.length === 0 && sameDayOk && quiet(lastHours) && get(A).billing_warning_stage === 2 && get(A).status === 'active';
    // Straight from stage 0 (the job did not run while the first warning was
    // due): the final warning, and stage 2.
    set(A, { billing_warning_stage: 0 });
    newDay();
    const direct = await job(END - 3 * HOUR);
    const directOk = direct.sends.length === 2 && direct.sends.every((m) => textOf(m) === FINAL_A)
      && direct.w.length === 1 && same(direct.w[0].body, { billing_warning_stage: 2 }) && param(direct.w[0], 'billing_warning_stage') === 'eq.0'
      && get(A).billing_warning_stage === 2;
    line(earlyOk && noticeOk && writeOk && summaryOk && onceOk && directOk, 'BJ5', 'a day or less left: one final warning, then stage 2',
      `early=${earlyOk} notice=${noticeOk} write=${writeOk} summary=${summaryOk} once=${onceOk} direct=${directOk}`);
  }

  /* BJ6: expired -> suspended, through the operator's Suspend path. */
  store = fresh({ [A]: { billing_warning_stage: 2 } });
  {
    const before = untouchable();
    const chatsBefore = JSON.stringify(store.chats);
    const r = await job(END);   // the exact end of the grace period
    const noticeOk = same(r.sends.map((m) => String(m.body.chat_id)).sort(), [String(OWNER), String(STAFF)].sort())
      && r.sends.every((m) => textOf(m) === SUSPENDED_NOTICE && same(m.body.reply_markup, { remove_keyboard: true }) && !('parse_mode' in m.body));
    const mailOk = r.mail.length === 1 && toOf(r.mail[0]) === 'alder@fixture.invalid' && r.mail[0].body.subject === C2.SUSPENDED_EMAIL_SUBJECT
      && r.mail[0].body.text === SUSPENDED_NOTICE && keyOf(r.mail[0]).startsWith(`suspended:billing:${A}:`);
    const status = r.w[0] ? String(param(r.w[0], 'status')) : '';
    const writeOk = r.w.length === 1 && r.w[0].table === 'businesses' && r.w[0].method === 'PATCH'
      && param(r.w[0], 'id') === `eq.${A}` && /^in\.\("?active"?\)$/.test(status)
      && same(r.w[0].body, { status: 'paused', suspended_for_billing: true })
      && get(A).status === 'paused' && get(A).suspended_for_billing === true && get(A).paid_until === PAID;
    const orderOk = noticesBeforeWrite(r.trace);
    const keptOk = JSON.stringify(store.chats) === chatsBefore && untouchable() === before;
    const summaryOk = r.operator.length === 1 && textOf(r.operator[0]) === 'Billing\n\nSuspended for non-payment: Alder Roofing'
      && counts(r.out, { suspended: 1 });
    // Again, the same day and the next: it is no longer a served business,
    // so it is not even read.
    const again = await job(END + HOUR);
    newDay();
    const nextDay = await job(END + DAY);
    const againOk = [again, nextDay].every((x) => quiet(x) && x.operator.length === 0 && x.out.checked === 0);

    // THE SAME PATH. The operator's Suspend, on a twin business, through the
    // function api/tg.js calls: request for request the same, in the same
    // order; only the words, the email key and the flag differ.
    const { suspendBusiness } = await import('../lib/service-status.js');
    const dbApi = await import('../lib/db.js');
    const tgApi = await import('../lib/tg.js');
    const notifyApi = await import('../lib/notify.js');
    set(A, { status: 'active', suspended_for_billing: false });
    const manual = await during(() => suspendBusiness(
      { business: { ...get(A) }, rows: store.chats.filter((c) => c.business_id === A) },
      { sendMessage: tgApi.sendMessage, sendSuspensionEmail: notifyApi.sendSuspensionEmail, setBusinessStatus: dbApi.setBusinessStatus }));
    const shape = (x) => x.trace.filter((e) => !(e.kind === 'sb' && e.method === 'GET') && e.chat !== String(OP) && !(e.kind === 'sb' && e.table !== 'businesses'))
      .map((e) => `${e.kind}:${e.method}:${e.phase}`).sort().join(' ');
    const manualStatus = manual.w[0] ? String(param(manual.w[0], 'status')) : '';
    const twinOk = shape(manual) === shape(r) && noticesBeforeWrite(manual.trace)
      && manual.sends.length === 2 && manual.sends.every((m) => textOf(m) === C2.BOT_SUSPENDED_NOTICE && same(m.body.reply_markup, { remove_keyboard: true }))
      && same(manual.sends.map((m) => Object.keys(m.body).sort()), r.sends.map((m) => Object.keys(m.body).sort()))
      && manual.mail.length === 1 && manual.mail[0].body.subject === r.mail[0].body.subject && keyOf(manual.mail[0]).startsWith(`suspended:${A}:`)
      && manual.w.length === 1 && same(manual.w[0].body, { status: 'paused' }) && /^in\.\("?demo"?,"?active"?\)$/.test(manualStatus)
      && same(manual.out, { changed: true, failed: 0, phones: 2 }) && get(A).suspended_for_billing === false;
    // And in the code: nobody but lib/service-status.js writes 'paused'.
    const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const onePath = /suspendBusiness\(/.test(src('api/tg.js')) && /suspendBusiness\(/.test(src('lib/billing-ops.js'))
      && [src('api/tg.js'), src('lib/billing-ops.js'), src('api/billing.js'), src('api/selfcheck.js')].every((s) => !/setBusinessStatus\([^)]*'paused'/.test(s))
      && /setBusinessStatus\(business\.id, 'paused'/.test(src('lib/service-status.js'));

    // Never warned at all (the dates were set long past): still suspended.
    set(B, { paid_until: iso(P - 40 * DAY), billing_warning_stage: 0 });
    newDay();
    const unwarned = await job(END + 2 * DAY);
    const unwarnedOk = get(B).status === 'paused' && get(B).suspended_for_billing === true
      && unwarned.sends.length === 1 && String(unwarned.sends[0].body.chat_id) === String(CHAT_B) && textOf(unwarned.sends[0]) === SUSPENDED_NOTICE;
    line(noticeOk && mailOk && writeOk && orderOk && keptOk && summaryOk && againOk && twinOk && onePath && unwarnedOk,
      'BJ6', 'expired: suspended through the operator Suspend path',
      `notice=${noticeOk} mail=${mailOk} write=${writeOk} order=${orderOk} kept=${keptOk} summary=${summaryOk} again=${againOk} twin=${twinOk} onePath=${onePath} unwarned=${unwarnedOk}`);
  }

  /* BJ7: notices that fail. */
  store = fresh();
  {
    const now = P + DAY;
    // One of two phones refuses: the other and the email got it; stage 1.
    tgHook = ({ method, chat }) => (method === 'sendMessage' && String(chat) === String(STAFF) ? tgRefuse() : null);
    const partial = await job(now);
    tgHook = null;
    const partialOk = get(A).billing_warning_stage === 1 && counts(partial.out, { warned: 1, grace: 1 }) && partial.mail.length === 1
      && textOf(partial.operator[0]) === 'Billing\n\nOverdue warning sent: Alder Roofing\nOverdue: Alder Roofing (suspends Dec 21)';

    // Every phone refuses AND the email fails: nobody was told, so the stage
    // stays where it is and the operator is told the warning did not land.
    store = fresh();
    tgHook = ({ method, chat }) => (method === 'sendMessage' && String(chat) !== String(OP) ? tgRefuse() : null);
    const dead = await during(async () => { await mailCtl({ mode: '500' }); return runBillingJob({ now }); });
    const deadOk = get(A).billing_warning_stage === 0 && dead.w.length === 0 && get(A).status === 'active'
      && counts(dead.out, { unwarned: 1, grace: 1 })
      && dead.operator.length === 1 && textOf(dead.operator[0]) === 'Billing\n\nCould not be warned (no notice delivered): Alder Roofing\nOverdue: Alder Roofing (suspends Dec 21)';
    // The same day again: not retried (one attempt a day), nothing changes.
    const sameDay = await during(async () => { await mailCtl({ mode: '500' }); return runBillingJob({ now: now + 3 * HOUR }); });
    const sameDayOk = sameDay.tg.length === 0 && sameDay.mail.length === 0 && sameDay.w.length === 0 && get(A).billing_warning_stage === 0;
    // The next day, with the phones answering again: the warning goes out and
    // the stage moves. The failure cost a day, not the warning.
    tgHook = null;
    await mailCtl({ mode: 'ok' });
    newDay();
    const retry = await job(now + DAY);
    const retryOk = retry.sends.length === 2 && retry.sends.every((m) => textOf(m) === OVERDUE_A) && get(A).billing_warning_stage === 1
      && counts(retry.out, { warned: 1, grace: 1 });

    // The phones refuse, the email is accepted: that is a notice.
    store = fresh();
    tgHook = ({ method, chat }) => (method === 'sendMessage' && String(chat) !== String(OP) ? tgRefuse() : null);
    const mailOnly = await job(now);
    tgHook = null;
    const mailOnlyOk = get(A).billing_warning_stage === 1 && mailOnly.mail.length === 1 && counts(mailOnly.out, { warned: 1, grace: 1 });
    // The email fails, one phone is reached: that is a notice too.
    store = fresh();
    const tgOnly = await during(async () => { await mailCtl({ mode: '500' }); return runBillingJob({ now }); });
    await mailCtl({ mode: 'ok' });
    const tgOnlyOk = get(A).billing_warning_stage === 1 && tgOnly.sends.length === 2 && counts(tgOnly.out, { warned: 1, grace: 1 });

    // No phone, but an owner address (Cedar): warned by email.
    store = fresh({ [A]: { paid_until: null }, [C]: { paid_until: PAID } });
    const noPhone = await job(now);
    const noPhoneOk = noPhone.sends.length === 0 && noPhone.mail.length === 1 && toOf(noPhone.mail[0]) === 'cedar@fixture.invalid'
      && get(C).billing_warning_stage === 1 && counts(noPhone.out, { warned: 1, grace: 1 });
    // No phone and no owner address (Delta): there is nobody to tell and
    // nothing to retry, so the stage advances and the operator is told once.
    store = fresh({ [A]: { paid_until: null }, [D]: { paid_until: PAID } });
    const nobody = await job(now);
    newDay();
    const nobodyNext = await job(now + DAY);
    const nobodyOk = nobody.sends.length === 0 && nobody.mail.length === 0 && nobody.w.length === 1 && get(D).billing_warning_stage === 1
      && counts(nobody.out, { unwarned: 1, grace: 1 })
      && textOf(nobody.operator[0]) === 'Billing\n\nCould not be warned (no notice delivered): Delta Roofs\nOverdue: Delta Roofs (suspends Dec 21)'
      && quiet(nobodyNext) && textOf(nobodyNext.operator[0]) === 'Billing\n\nOverdue: Delta Roofs (suspends Dec 21)';

    // A warning that never landed does not postpone the end: the dates decide.
    store = fresh();
    tgHook = ({ method, chat }) => (method === 'sendMessage' && String(chat) !== String(OP) ? tgRefuse() : null);
    const deadSuspend = await during(async () => { await mailCtl({ mode: '500' }); return runBillingJob({ now: END + HOUR }); });
    tgHook = null;
    await mailCtl({ mode: 'ok' });
    const blockOk = get(A).status === 'paused' && get(A).suspended_for_billing === true && get(A).billing_warning_stage === 0
      && counts(deadSuspend.out, { suspended: 1 }) && textOf(deadSuspend.operator[0]) === 'Billing\n\nSuspended for non-payment: Alder Roofing';
    line(partialOk && deadOk && sameDayOk && retryOk && mailOnlyOk && tgOnlyOk && noPhoneOk && nobodyOk && blockOk,
      'BJ7', 'failed notices: stage held only when nobody was reached',
      `partial=${partialOk} dead=${deadOk} sameDay=${sameDayOk} retry=${retryOk} mailOnly=${mailOnlyOk} tgOnly=${tgOnlyOk} noPhone=${noPhoneOk} nobody=${nobodyOk} suspend=${blockOk}`);
  }

  /* BJ8: one business that cannot be processed. */
  store = fresh({ [B]: { paid_until: PAID }, [C]: { paid_until: iso(P - 30 * DAY) } });
  {
    // Alder's phones cannot be read. Beta (warn) and Cedar (suspend) still go.
    sbHook = ({ table, params }) => (table === 'business_chats' && param({ params }, 'business_id') === `eq.${A}` ? fail500() : null);
    const r = await job(P + DAY);
    sbHook = null;
    const othersOk = get(B).billing_warning_stage === 1 && get(C).status === 'paused' && get(C).suspended_for_billing === true;
    const heldOk = get(A).billing_warning_stage === 0 && get(A).status === 'active' && !r.sends.some((m) => [OWNER, STAFF].map(String).includes(String(m.body.chat_id)))
      && !r.mail.some((m) => toOf(m) === 'alder@fixture.invalid');
    const reportOk = r.out.ok === true && r.out.checked === 3 && r.out.failed === 1 && r.out.warned === 1 && r.out.suspended === 1
      && textOf(r.operator[0]) === ['Billing', '', 'Suspended for non-payment: Cedar Co', 'Overdue warning sent: Beta Roofing',
        'Not completed, tried again tomorrow: Alder Roofing', 'Overdue: Alder Roofing (suspends Dec 21), Beta Roofing (suspends Dec 21)'].join('\n');
    // The status cannot be written: not reported as suspended, and done the next day.
    store = fresh();
    sbHook = ({ table, method }) => (table === 'businesses' && method === 'PATCH' ? fail500() : null);
    const stuck = await job(END + HOUR);
    sbHook = null;
    newDay();
    const next = await job(END + DAY);
    const stuckOk = stuck.out.suspended === 0 && stuck.out.failed === 1 && next.out.suspended === 1 && get(A).status === 'paused';
    // The list itself cannot be read: the job fails as a whole, loudly.
    sbHook = ({ table, method }) => (table === 'businesses' && method === 'GET' ? fail500() : null);
    let threw = false;
    try { await runBillingJob({ now: P }); } catch { threw = true; }
    sbHook = null;
    line(othersOk && heldOk && reportOk && stuckOk && threw, 'BJ8', 'one failing business never stops the others',
      `others=${othersOk} held=${heldOk} report=${reportOk} stuck=${stuckOk} threw=${threw}`);
  }

  /* BJ9: the operator's summary. */
  store = fresh({ [B]: { paid_until: iso(P + 8 * DAY) }, [C]: { paid_until: iso(P - 30 * DAY) } });
  {
    // Alder overdue (warn), Beta due in 2 days, Cedar expired (suspend).
    const now = P + 7 * DAY - 30 * HOUR;
    const r = await job(now);
    const text = r.operator.length === 1 ? textOf(r.operator[0]) : '';
    const exact = text === ['Billing', '', 'Suspended for non-payment: Cedar Co', 'Overdue warning sent: Alder Roofing',
      'Overdue: Alder Roofing (suspends Dec 21)', 'Due within 3 days: Beta Roofing (Dec 22)'].join('\n');
    const plain = r.operator.length === 1 && !('parse_mode' in r.operator[0].body) && !('reply_markup' in r.operator[0].body) && !('entities' in r.operator[0].body);
    // Names and dates. No address, no chat id, no business id, no slug.
    const lean = !/fixture\.invalid|@/.test(text) && ![OWNER, STAFF, CHAT_B, OP].some((c) => text.includes(String(c)))
      && ![A, B, C].some((id) => text.includes(id)) && !/\balder\b|\bbeta\b|\bcedar\b/.test(text);
    // Only the operator chat got it, and only once.
    const onlyOp = r.tg.filter((m) => textOf(m).startsWith('Billing')).every((m) => String(m.body.chat_id) === String(OP)) && r.operatorMail.length === 0;
    // Nothing happened: no message at all.
    store = fresh({ [A]: { paid_until: iso(P + 60 * DAY) } });
    const calm = await job(P);
    const calmOk = calm.tg.length === 0 && calm.operatorMail.length === 0 && calm.out.operator === 'none' && !store.claims.has('billing:summary');
    // A second run that newly did something speaks only of that.
    store = fresh();
    const first = await job(P + DAY);
    set(B, { paid_until: iso(P - 30 * DAY) });
    const second = await job(P + DAY + HOUR);
    const secondOk = first.operator.length === 1 && second.operator.length === 1 && textOf(second.operator[0]) === 'Billing\n\nSuspended for non-payment: Beta Roofing';
    // Telegram refuses the operator chat: the same words by email, once a day.
    store = fresh();
    tgHook = ({ method, chat }) => (method === 'sendMessage' && String(chat) === String(OP) ? tgRefuse() : null);
    const byMail = await job(P + DAY);
    tgHook = null;
    const mailOk = byMail.out.operator === 'email' && byMail.operatorMail.length === 1
      && String(byMail.operatorMail[0].body.text).includes('Overdue warning sent: Alder Roofing')
      && keyOf(byMail.operatorMail[0]) === 'billing:operator:2026-12-15' && store.claims.has('billing:summary');
    // Neither channel: the day's slot is given back, so the next run says it.
    store = fresh();
    tgHook = ({ method, chat }) => (method === 'sendMessage' && String(chat) === String(OP) ? tgRefuse() : null);
    const savedMail = process.env.OPERATOR_EMAIL;
    delete process.env.OPERATOR_EMAIL;
    const lost = await job(P + DAY);
    process.env.OPERATOR_EMAIL = savedMail;
    tgHook = null;
    const later = await job(P + DAY + HOUR);
    const lostOk = lost.out.operator === 'undelivered' && get(A).billing_warning_stage === 1
      && later.operator.length === 1 && textOf(later.operator[0]) === 'Billing\n\nOverdue: Alder Roofing (suspends Dec 21)';
    line(exact && plain && lean && onlyOp && calmOk && secondOk && mailOk && lostOk, 'BJ9', 'operator summary: once, names only, only when needed',
      `exact=${exact} plain=${plain} lean=${lean} onlyOp=${onlyOp} calm=${calmOk} second=${secondOk} mail=${mailOk} lost=${lostOk}`);
  }

  /* BJ10: applyPayment, the seam. */
  store = fresh({ [A]: { billing_warning_stage: 2 } });
  {
    const pay = (args) => during(() => applyPayment(args));
    const before = snapshot();
    // Refused before anything is read.
    const bad = [];
    for (const args of [{ businessId: 'nope', paidUntil: END }, { businessId: A, paidUntil: 'not a date' }, { businessId: A, paidUntil: null },
      { businessId: null, paidUntil: END }, { businessId: A.toUpperCase() + 'x', paidUntil: END }]) {
      const x = await pay(args);
      if (!same(x.out, { ok: false, reason: 'bad_request' }) || x.sb.length || x.tg.length) bad.push(String(args.businessId).slice(0, 6));
    }
    const gone = await pay({ businessId: biz(99), paidUntil: END });
    const refusedOk = bad.length === 0 && same(gone.out, { ok: false, reason: 'not_found' }) && gone.w.length === 0 && snapshot() === before;

    // Forward: one update, the date and the stage together, scoped so that it
    // can only move the date later.
    const target = P + 30 * DAY;
    const first = await pay({ businessId: A, paidUntil: target, source: 'operator' });
    const writeOk = same(first.out, { ok: true, changed: true, paidUntil: target, wasSuspended: false, reactivated: false, noticesFailed: 0 })
      && first.w.length === 1 && first.w[0].method === 'PATCH' && param(first.w[0], 'id') === `eq.${A}`
      && param(first.w[0], 'paid_until') === `lt.${iso(target)}` && same(first.w[0].body, { paid_until: iso(target), billing_warning_stage: 0 })
      && get(A).paid_until === iso(target) && get(A).billing_warning_stage === 0 && first.tg.length === 0 && first.mail.length === 0;
    // The same payment again (a provider redelivers): nothing.
    const again = await pay({ businessId: A, paidUntil: target, source: 'operator' });
    const againOk = same(again.out, { ok: true, changed: false, paidUntil: target }) && again.w.length === 0 && again.tg.length === 0;
    // An EARLIER date never shortens what is paid.
    const shorter = await pay({ businessId: A, paidUntil: target - 10 * DAY });
    const shorterOk = same(shorter.out, { ok: true, changed: false, paidUntil: target }) && shorter.w.length === 0 && get(A).paid_until === iso(target);
    // Even if the read was stale (someone else paid further in between), the
    // update itself refuses to go backwards.
    sbHook = ({ table, method }) => {
      if (table === 'businesses' && method === 'GET' && !sbHook.used) {
        sbHook.used = true;
        const stale = { ...get(A), paid_until: PAID };
        set(A, { paid_until: iso(target + 20 * DAY) });
        return new Response(JSON.stringify(stale), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return null;
    };
    const raced = await pay({ businessId: A, paidUntil: target + 5 * DAY });
    sbHook = null;
    const racedOk = same(raced.out, { ok: true, changed: false, paidUntil: target + 20 * DAY }) && get(A).paid_until === iso(target + 20 * DAY)
      && raced.w.length === 1 && raced.tg.length === 0;
    // The date may be an ISO string or a Date; a business never billed is
    // written under "still not billed".
    const fromNull = await pay({ businessId: B, paidUntil: new Date(target) });
    const nullOk = fromNull.out.changed === true && param(fromNull.w[0], 'paid_until') === 'is.null' && get(B).paid_until === iso(target);

    // Suspended BY THE BILLING JOB: a payment brings it back, through
    // Reactivate (status scoped to the suspended statuses, the flag cleared,
    // every phone told with its own keyboard).
    set(A, { status: 'paused', suspended_for_billing: true, paid_until: PAID, billing_warning_stage: 2 });
    const back = await pay({ businessId: A, paidUntil: target, source: 'whop' });
    const status = back.w[1] ? String(param(back.w[1], 'status')) : '';
    const backOk = same(back.out, { ok: true, changed: true, paidUntil: target, wasSuspended: true, reactivated: true, noticesFailed: 0 })
      && back.w.length === 2 && same(back.w[1].body, { status: 'active', suspended_for_billing: false }) && /^in\.\("?paused"?,"?churned"?\)$/.test(status)
      && get(A).status === 'active' && get(A).suspended_for_billing === false && get(A).billing_warning_stage === 0
      && back.sends.length === 2 && back.sends.every((m) => textOf(m) === C2.BOT_REACTIVATED)
      && same(back.sends.find((m) => String(m.body.chat_id) === String(OWNER)).body.reply_markup, C2.persistentKeyboard(C2.OWNER_KEYBOARD_LABELS))
      && same(back.sends.find((m) => String(m.body.chat_id) === String(STAFF)).body.reply_markup, C2.persistentKeyboard(C2.STAFF_KEYBOARD_LABELS));
    // Redelivered: no second notice.
    const backAgain = await pay({ businessId: A, paidUntil: target, source: 'whop' });
    const backAgainOk = backAgain.out.changed === false && backAgain.tg.length === 0 && backAgain.w.length === 0;
    // Suspended BY HAND: a payment does not undo the operator's decision...
    set(A, { status: 'paused', suspended_for_billing: false, paid_until: PAID });
    const byHand = await pay({ businessId: A, paidUntil: target });
    const byHandOk = same(byHand.out, { ok: true, changed: true, paidUntil: target, wasSuspended: true, reactivated: false, noticesFailed: 0 })
      && get(A).status === 'paused' && byHand.tg.length === 0 && byHand.w.length === 1;
    // ...unless the caller is the operator's own Extend, which says 'any'.
    set(A, { paid_until: PAID });
    const any = await pay({ businessId: A, paidUntil: target, reactivate: 'any' });
    const anyOk = any.out.reactivated === true && get(A).status === 'active' && any.sends.length === 2 && same(any.w[1].body, { status: 'active' });
    // 'never': the date only.
    set(A, { status: 'paused', suspended_for_billing: true, paid_until: PAID });
    const never = await pay({ businessId: A, paidUntil: target, reactivate: 'never' });
    const neverOk = never.out.changed === true && never.out.reactivated === false && get(A).status === 'paused' && never.tg.length === 0;
    // After a payment the job has nothing to say about that business.
    set(A, { status: 'active', suspended_for_billing: false });
    const after = await job(P + 2 * DAY);
    const afterOk = !after.sends.some((m) => [OWNER, STAFF].map(String).includes(String(m.body.chat_id))) && after.w.length === 0;
    line(refusedOk && writeOk && againOk && shorterOk && racedOk && nullOk && backOk && backAgainOk && byHandOk && anyOk && neverOk && afterOk,
      'BJ10', 'applyPayment: idempotent, forward only, clears stage, reactivates',
      `refused=${refusedOk} write=${writeOk} again=${againOk} shorter=${shorterOk} raced=${racedOk} null=${nullOk} back=${backOk}/${backAgainOk} byHand=${byHandOk} any=${anyOk} never=${neverOk} after=${afterOk}`);
  }

  /* BJ11: a whole life, one run a day at 09:30 UTC. */
  store = fresh();
  {
    const log = [];
    const told = [];
    const day = async (d) => {
      newDay();
      const r = await job(Date.parse('2026-12-10T09:30:00Z') + d * DAY);
      const a = get(A);
      for (const m of r.sends) told.push(`${d}:${textOf(m).slice(0, 12)}`);
      log.push(`${d}:${a.status}/${a.billing_warning_stage}/${a.suspended_for_billing ? 'b' : '-'}:${r.sends.length}`);
      return r;
    };
    // Dec 10..13 paid; Dec 14 09:30 is 30 minutes past paid_until: overdue.
    for (let d = 0; d <= 3; d++) await day(d);
    for (let d = 4; d <= 12; d++) await day(d);
    const want = [
      '0:active/0/-:0', '1:active/0/-:0', '2:active/0/-:0', '3:active/0/-:0',
      '4:active/1/-:2',                                       // Dec 14: the overdue warning
      '5:active/1/-:0', '6:active/1/-:0', '7:active/1/-:0', '8:active/1/-:0', '9:active/1/-:0',
      '10:active/2/-:2',                                      // Dec 20: 23.5 hours left, the final warning
      '11:paused/2/b:2',                                      // Dec 21 09:30: suspended
      '12:paused/2/b:0',
    ];
    const lifeOk = same(log, want);
    const toldOk = same([...new Set(told)], ['4:Payment for ', '10:Final notice', '11:Your service']);
    // The operator records the payment (Dec 22): paid 30 days from now, back on.
    const now = Date.parse('2026-12-22T15:00:00Z');
    const target = BL.nextPaidUntil(get(A).paid_until, now);
    const paid = await during(() => applyPayment({ businessId: A, paidUntil: target, reactivate: 'any' }));
    const paidOk = paid.out.reactivated === true && get(A).status === 'active' && get(A).billing_warning_stage === 0
      && get(A).suspended_for_billing === false && target === now + 30 * DAY && BL.billingDate(target) === 'Jan 21'
      && paid.sends.length === 2;
    // The next period ends unpaid too: the warnings start over from the first.
    newDay();
    const calm = await job(target - 10 * DAY);
    newDay();
    const overdueAgain = await job(target + HOUR);
    const againOk = quiet(calm) && overdueAgain.sends.length === 2
      && overdueAgain.sends.every((m) => textOf(m) === 'Payment for Alder Roofing is overdue. Your service will be suspended on Jan 28 unless payment is received. Contact support.')
      && get(A).billing_warning_stage === 1;
    line(lifeOk && toldOk && paidOk && againOk, 'BJ11', 'a whole life: warned, final, suspended, paid, warned again',
      `life=${lifeOk} told=${toldOk} paid=${paidOk} again=${againOk}${lifeOk ? '' : ' got=' + log.join(' ')}`);
  }

  /* BJ12: no billing columns yet; and where the job is scheduled. */
  store = fresh();
  {
    const before = snapshot();
    const missing = () => new Response(JSON.stringify({ code: '42703', message: 'column businesses.paid_until does not exist' }),
      { status: 400, headers: { 'content-type': 'application/json' } });
    // Any read that names a billing column is refused, as Postgres would.
    const namesBilling = (params) => String(param({ params }, 'select') || '').includes('paid_until') || params.some(([k]) => k === 'paid_until');
    sbHook = ({ table, method, params }) => (table === 'businesses' && method === 'GET' && namesBilling(params) ? missing() : null);
    const r = await job(END + DAY);
    const pay = await during(() => applyPayment({ businessId: A, paidUntil: END + 30 * DAY }));
    sbHook = null;
    const bareOk = same(r.out, { ok: true, skipped: 'unavailable' }) && r.tg.length === 0 && r.mail.length === 0 && r.w.length === 0
      && same(pay.out, { ok: false, reason: 'unavailable' }) && pay.w.length === 0 && snapshot() === before;
    // A write that reports the missing column (a stale schema cache).
    sbHook = ({ table, method }) => {
      if (table !== 'businesses') return null;
      if (method === 'PATCH') return new Response(JSON.stringify({ code: 'PGRST204', message: "Could not find the 'paid_until' column of 'businesses' in the schema cache" }), { status: 400, headers: { 'content-type': 'application/json' } });
      return null;
    };
    const pay2 = await during(() => applyPayment({ businessId: A, paidUntil: END + 30 * DAY }));
    sbHook = null;
    const bare2Ok = same(pay2.out, { ok: false, reason: 'unavailable' }) && snapshot() === before;

    // Scheduling: the job rides the daily self-check; vercel.json still has
    // exactly the two crons it had, and /api/billing is not one of them.
    const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    const cronOk = same(vercel.crons.map((c) => c.path).sort(), ['/api/digest', '/api/selfcheck'])
      && vercel.crons.every((c) => /^\d+ \d+ \* \* \*$/.test(c.schedule));
    const src = fs.readFileSync(path.join(ROOT, 'api', 'selfcheck.js'), 'utf8');
    const wired = src.indexOf('runBillingJob()') > src.indexOf('sweepExpired()') && src.indexOf('sweepExpired()') > 0
      && /if \(!requestedBusiness\) \{\s*try \{\s*const b = await runBillingJob\(\);/.test(src)
      && src.indexOf('runBillingJob()') < src.lastIndexOf('res.status(200).json(');
    // And in practice: one authorised self-check call runs the job, a second
    // one the same day does not repeat it, and the self-check's answer keeps
    // exactly the keys it had.
    const { default: selfcheck } = await import('../api/selfcheck.js');
    store = fresh({ [A]: { paid_until: iso(Date.now() - 2 * DAY) } });
    process.env.HEALTH_SECRET = 'billing-health-secret-value';
    const callCheck = async (query = {}) => {
      const res = fakeRes();
      const x = await during(() => selfcheck({ method: 'GET', headers: { 'x-health-secret': 'billing-health-secret-value' }, query }, res));
      return { res, x };
    };
    const one = await callCheck();
    const warnings = (x) => x.tg.filter((m) => textOf(m).startsWith('Payment for Alder Roofing is overdue.'));
    const two = await callCheck();
    const ranOk = one.res.code === 200 && get(A).billing_warning_stage === 1 && warnings(one.x).length === 2 && warnings(two.x).length === 0
      && same(Object.keys(one.res.body).sort(), ['emailed', 'failed', 'ok', 'operator', 'operator_reachable', 'redirect_active', 'sent']);
    // A self-check scoped to one business is a manual probe: no billing run.
    store = fresh({ [A]: { paid_until: iso(Date.now() - 2 * DAY) } });
    const scopedCall = await callCheck({ business_id: B });
    const scopedOk = scopedCall.res.code === 200 && get(A).billing_warning_stage === 0 && warnings(scopedCall.x).length === 0;
    // A billing failure never fails the self-check.
    store = fresh({ [A]: { paid_until: iso(Date.now() - 2 * DAY) } });
    sbHook = ({ table, method, params }) => (table === 'businesses' && method === 'GET' && param({ params }, 'paid_until') === 'not.is.null' ? fail500() : null);
    const broken = await callCheck();
    sbHook = null;
    const brokenOk = broken.res.code === 200 && broken.res.body.ok === true;
    line(bareOk && bare2Ok && cronOk && wired && ranOk && scopedOk && brokenOk, 'BJ12', 'no columns: skipped; runs inside the daily self-check',
      `bare=${bareOk}/${bare2Ok} cron=${cronOk} wired=${wired} ran=${ranOk} scoped=${scopedOk} broken=${brokenOk}`);
  }

  /* BJ13: over the whole suite. */
  {
    await tgReset();
    const withParse = allTg.filter((x) => x.body && typeof x.body === 'object' && 'parse_mode' in x.body);
    const billingTexts = allTg.filter((x) => x.path.endsWith('/sendMessage')).map((x) => textOf(x))
      .filter((t) => /^(Payment for|Final notice|Your service has been suspended because|Billing\n)/.test(t));
    const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE0F}\u{200D}]/u;
    const fancy = billingTexts.filter((t) => EMOJI.test(t) || /[<>*_`]/.test(t));
    const inline = allTg.filter((x) => x.body && x.body.reply_markup && x.body.reply_markup.inline_keyboard);
    line(allTg.length > 60 && withParse.length === 0 && billingTexts.length > 30 && fancy.length === 0 && inline.length === 0,
      'BJ13', 'no parse_mode, no markup, no button in any billing message',
      `requests=${allTg.length} parse=${withParse.length} texts=${billingTexts.length} fancy=${fancy.length} inline=${inline.length}`);
  }
} catch (e) {
  line(false, 'BJ0', 'billing-job suite threw', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : JSON.stringify(e));
} finally {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await post(TG + '/__control', { mode: 'ok', failChat: null }).catch(() => {});
  await mailCtl({ mode: 'ok' }).catch(() => {});
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
