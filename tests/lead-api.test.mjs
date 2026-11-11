#!/usr/bin/env node
// tests/lead-api.test.mjs — end-to-end checks for POST /api/lead against a running dev server.
//
//   1. npx vercel login
//   2. npx vercel link
//   3. npx vercel dev --listen 3000 > _debug/vercel-dev.log 2>&1
//   4. node tests/lead-api.test.mjs
//
// Reads .env for SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (row assertions only) and for
// whether Telegram is configured. Prints PASS/FAIL per line; exits 1 on any failure.
// Cleans up every row it creates.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.LEAD_API_URL || 'http://localhost:3000/api/lead';
const ORIGIN = new URL(API).origin;
const LOG = path.resolve(ROOT, process.env.LEAD_API_LOG || '_debug/vercel-dev.log');
const RUN = Math.random().toString(36).slice(2, 10).padEnd(8, '0');

/* ---------- env, one shared loader ---------- */
// process.env > .env.test (TEST_ENV=1) > .env.local > .env, same as every other suite.
import { loadEnv } from '../lib/env.js';
import { fakeRes, ALDER_DEMO, sweepTestLeads, fixtureEmail } from './helpers.mjs';
import { FIXTURE_CHATS } from './fixture-ids.mjs';
loadEnv();
const FAKE_TG_URL = process.env.FAKE_TG_URL;
async function fakeTg(cfg) {
  if (!FAKE_TG_URL) throw new Error('FAKE_TG_URL is not set — run through tests/run.mjs');
  const r = await fetch(FAKE_TG_URL + '/__control', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg),
  });
  return r.json();
}

/* ---------- printer ---------- */
let failed = 0;
let total = 0;
function line(ok, id, what, detail) {
  total++;
  if (!ok) failed++;
  const d = detail ? '  ' + String(detail).replace(/\s+/g, ' ').slice(0, 96) : '';
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${what.padEnd(42)}${d}`);
}
function note(text) { console.log(`NOTE  ${' '.repeat(4)}${text}`); }

/* ---------- fixtures ---------- */
const NAME = 'Zzq Api Tester';
const PHONE = '5155550142';
const EMAIL = fixtureEmail('zzq.api');
const NOTES = 'zzq note marker';

function payload(over) {
  return {
    service: 'replacement', home: 'house', timing: 'asap', age: '10 to 20 years',
    zip: '50265', phone: PHONE, name: NAME, email: EMAIL, notes: NOTES,
    claim: false, website: '', elapsed: 5000,
    slug: ALDER_DEMO, idempotencyKey: `${RUN}-base`,
    ...over,
  };
}

let ipSeq = 10;
async function post(body, opts = {}) {
  if (!opts.http) return postInProcess(body, opts);
  const res = await fetch(opts.url || API, {
    method: opts.method || 'POST',
    headers: { 'Content-Type': 'application/json', 'x-real-ip': opts.ip || `203.0.113.${ipSeq++}` },
    body: opts.method === 'GET' ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

/* ---------- db ---------- */
const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const RUN_STARTED = new Date().toISOString();
{
  const { data: b } = await svc.from('businesses').select('id').eq('slug', ALDER_DEMO).single();
  if (b) await sweepTestLeads(svc, [b.id], RUN_STARTED).catch(() => 0);
}


/* The alert path no longer falls back to TELEGRAM_CHAT_ID: an unbound chat gets
   no alert with buttons. This suite asserts delivery, so it binds its OWN fixture
   chat (a reserved fixture id) for the duration. Never a real chat id: a cleanup that deletes
   by that id removes a real binding. */
const ALERT_CHAT = FIXTURE_CHATS.leadApiAlert;   // reserved fixture range, never a real chat
let SEED_BIZ = null;
{
  const { data: seedBiz } = await svc.from('businesses').select('id').eq('slug', ALDER_DEMO).single();
  SEED_BIZ = seedBiz ? seedBiz.id : null;
  if (seedBiz && ALERT_CHAT) {
    // A killed run leaves the row behind; clear it before binding.
    await svc.from('business_chats').delete().eq('tg_chat_id', ALERT_CHAT);
    await svc.from('business_chats').upsert(
      { business_id: seedBiz.id, tg_chat_id: ALERT_CHAT }, { onConflict: 'tg_chat_id' },
    );
  }
}

async function resetLimits() {
  await svc.from('rate_limits').delete().gte('window_start', '2000-01-01');
}
async function leadFor(key) {
  const { data } = await svc.from('leads').select('*').eq('idempotency_key', key);
  return data || [];
}
async function eventsFor(leadId) {
  const { data } = await svc.from('lead_events').select('kind, meta').eq('lead_id', leadId);
  return data || [];
}

/* ---------- in-process handler (most tests) vs real HTTP (kept tests) ----
   Moved from real HTTP through vercel dev: tests 1-9, 11, 15, M*, P* prove
   handler logic only (validation, phone, errors, limits, idempotency,
   events, notifications against the fake servers). Kept on real HTTP:
   test 10 (405 method), 12/12b (page estimateDeliver end-to-end), 13/14
   (dev-server LOG file assertions). 413/415 have no tests in this suite. */
const { default: leadHandler } = await import('../api/lead.js');
async function postInProcess(body, opts) {
  const res = fakeRes();
  await leadHandler({
    method: opts.method || 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': opts.ip || `203.0.113.${ipSeq++}` },
    body: body === null || body === undefined ? body : { ...body },
    socket: {},
  }, res);
  return { status: res.code, json: res.body && typeof res.body === 'object' ? res.body : null };
}


/* ---------- reachability ---------- */
try {
  const r = await fetch(API, { method: 'GET' });
  if (!r) throw new Error('no response');
} catch (e) {
  console.log(`FAIL  pre   cannot reach ${API}`);
  console.log('      start the dev server first:');
  console.log('      npx vercel dev --listen 3000 > _debug/vercel-dev.log 2>&1');
  process.exit(1);
}
if (!fs.existsSync(LOG)) {
  console.log(`FAIL  pre   log file not found: ${path.relative(ROOT, LOG)}`);
  console.log('      redirect the dev server output so check 13 can read it:');
  console.log('      npx vercel dev --listen 3000 > _debug/vercel-dev.log 2>&1');
  process.exit(1);
}
const logOffset = fs.statSync(LOG).size;

/* ---------- 1. happy path ---------- */
{
  await resetLimits();
  const key = `${RUN}-t1`;
  const { status } = await post(payload({ idempotencyKey: key, claim: true }));
  const rows = await leadFor(key);
  const evs = rows.length ? await eventsFor(rows[0].id) : [];
  const r = rows[0] || {};
  const mapped = r.roof_age === '10 to 20 years' && r.insurance_claim === true;
  line(status === 200 && rows.length === 1 && mapped && evs.filter((e) => e.kind === 'created').length === 1,
    '1', 'valid -> 200, one row, one created', `${status} rows=${rows.length} roof_age=${r.roof_age} claim=${r.insurance_claim} created=${evs.filter((e) => e.kind === 'created').length}`);
}

/* ---------- 2. bad zip ---------- */
{
  await resetLimits();
  const key = `${RUN}-t2`;
  const { status } = await post(payload({ idempotencyKey: key, zip: 'abcde' }));
  line(status === 400 && (await leadFor(key)).length === 0, '2', 'bad zip -> 400, nothing written', status);
}

/* ---------- 3. unknown service ---------- */
{
  await resetLimits();
  const key = `${RUN}-t3`;
  const { status } = await post(payload({ idempotencyKey: key, service: 'gold-plated' }));
  line(status === 400 && (await leadFor(key)).length === 0, '3', 'unknown service -> 400', status);
}

/* ---------- 4. unknown extra key ---------- */
{
  await resetLimits();
  const key = `${RUN}-t4`;
  const { status } = await post(payload({ idempotencyKey: key, evil: 'extra' }));
  line(status === 400 && (await leadFor(key)).length === 0, '4', 'unknown key -> 400', status);
}

/* ---------- 5. unknown slug ---------- */
{
  await resetLimits();
  const key = `${RUN}-t5`;
  const { status } = await post(payload({ idempotencyKey: key, slug: 'not-a-business' }));
  line(status === 400 && (await leadFor(key)).length === 0, '5', 'unknown slug -> 400', status);
}

/* ---------- 6. honeypot ---------- */
{
  await resetLimits();
  const key = `${RUN}-t6`;
  const { status } = await post(payload({ idempotencyKey: key, website: 'http://spam.example' }));
  line(status === 200 && (await leadFor(key)).length === 0, '6', 'honeypot -> 200, nothing written', status);
}

/* ---------- 7. too fast ---------- */
{
  await resetLimits();
  const key = `${RUN}-t7`;
  const { status } = await post(payload({ idempotencyKey: key, elapsed: 500 }));
  line(status === 200 && (await leadFor(key)).length === 0, '7', 'elapsed 500 -> 200, nothing written', status);
}

/* ---------- 8. idempotency ---------- */
{
  await resetLimits();
  const key = `${RUN}-t8`;
  const a = await post(payload({ idempotencyKey: key }));
  const b = await post(payload({ idempotencyKey: key }));
  const rows = await leadFor(key);
  const evs = rows.length ? await eventsFor(rows[0].id) : [];
  const created = evs.filter((e) => e.kind === 'created').length;
  line(a.status === 200 && b.status === 200 && rows.length === 1 && created === 1,
    '8', 'same key twice -> one row, one event', `${a.status},${b.status} rows=${rows.length} created=${created}`);
}

/* ---------- 9. per-IP rate limit ---------- */
{
  await resetLimits();
  const ip = '203.0.113.99';
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await post(payload({ idempotencyKey: `${RUN}-t9-${i}` }), { ip })).status);
  const ok = codes.slice(0, 10).every((c) => c === 200) && codes[10] === 429;
  line(ok, '9', '11 from one IP -> 11th is 429',
    `${codes.filter((c) => c === 200).length}x200 then ${codes[10]}`);
}

/* ---------- 10. GET ---------- */
{
  await resetLimits();
  const res = await fetch(API, { method: 'GET' });
  line(res.status === 405, '10', 'GET -> 405', res.status);
}

/* ---------- 11. Telegram failure path (fake server returns 500) ---------- */
{
  await resetLimits();
  const key = `${RUN}-t11`;
  await fakeTg({ mode: '500' });
  const { status } = await post(payload({ idempotencyKey: key }));
  await fakeTg({ mode: 'ok' });
  const rows = await leadFor(key);
  const evs = rows.length ? await eventsFor(rows[0].id) : [];
  const tgFail = evs.find((e) => e.kind === 'tg_failed');
  const ok = status === 200 && rows.length === 1 && !!tgFail
    && tgFail.meta && tgFail.meta.status === 500;
  line(ok, '11', 'telegram 500 -> 200, lead kept, tg_failed',
    `${status} rows=${rows.length} tg_failed=${tgFail ? JSON.stringify(tgFail.meta) : 'none'}`);
}

/* ---------- 12. the page's own estimateDeliver ---------- */
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m = /<!-- ESTIMATE DELIVERY[\s\S]*?<script>\n([\s\S]*?)\n<\/script>/.exec(html);
  if (!m) {
    line(false, '12', 'page estimateDeliver found in index.html', 'block missing');
  } else {
    const dom = new JSDOM('<!doctype html><html><body><form class="est-form" data-slug="alder-demo"></form></body></html>', {
      runScripts: 'dangerously',
      url: ORIGIN,
    });
    dom.window.fetch = (u, o) => {
      /* The page uses the window's AbortController, and undici refuses a signal
         from another realm (JSDOM here). Bridge it so a real request carries a
         real signal: this is the harness adapting, not the page relaxing. */
      const opts = { ...o };
      if (o && o.signal) {
        const bridged = new AbortController();
        if (o.signal.aborted) bridged.abort();
        else o.signal.addEventListener('abort', () => bridged.abort());
        opts.signal = bridged.signal;
      }
      return fetch(new URL(u, ORIGIN).href, opts);
    };
    Object.defineProperty(dom.window, 'crypto', { value: globalThis.crypto, configurable: true, writable: true });
    dom.window.eval(m[1]);

    // 12a: a real submit through the page's own code writes a row.
    await resetLimits();
    const key = `${RUN}-t12`;
    const marker = `${NOTES} via page ${key}`;
    const sent = payload({ idempotencyKey: key, notes: marker });
    delete sent.idempotencyKey;                       // the page must mint its own
    let threw = null;
    try { await dom.window.estimateDeliver(sent); } catch (e) { threw = e.message; }
    const { data: viaPage } = await svc.from('leads').select('id, business_id, notes').eq('notes', marker);
    line(!threw && (viaPage || []).length === 1, '12', 'page estimateDeliver -> row written',
      threw || `rows=${(viaPage || []).length}`);

    // 12b: the page forwards the honeypot. If it dropped "website", a row would appear.
    await resetLimits();
    const marker2 = `${NOTES} honeypot ${key}`;
    let threw2 = null;
    try { await dom.window.estimateDeliver({ ...sent, notes: marker2, website: 'http://spam.example' }); } catch (e) { threw2 = e.message; }
    const { data: viaBot } = await svc.from('leads').select('id').eq('notes', marker2);
    line(!threw2 && (viaBot || []).length === 0, '12b', 'page forwards website + elapsed',
      threw2 || `rows=${(viaBot || []).length}`);

    /* 12c: offline. Nothing is posted and the visitor is told immediately: the
       rejection carries the offline flag the modal turns into "You're offline." */
    const realFetch = dom.window.fetch, realSetTimeout = dom.window.setTimeout, realClearTimeout = dom.window.clearTimeout;
    let offlineCalls = 0;
    Object.defineProperty(dom.window.navigator, 'onLine', { value: false, configurable: true });
    dom.window.fetch = function () { offlineCalls++; return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } }); };
    let offlineErr = null;
    try { await dom.window.estimateDeliver({ ...sent, notes: `${NOTES} offline ${key}` }); } catch (e) { offlineErr = e; }
    Object.defineProperty(dom.window.navigator, 'onLine', { value: true, configurable: true });
    dom.window.fetch = realFetch;
    line(offlineCalls === 0 && !!offlineErr && offlineErr.offline === true,
      '12c', 'offline: no request, offline error surfaced',
      `calls=${offlineCalls} err=${offlineErr && offlineErr.message}`);

    /* 12d: a request that never answers. The AbortController fires, one retry is
       allowed under the SAME key, and then the error: the button cannot stay on
       "Sending..." forever. Timers are shortened; the key is the assertion. */
    const seen = [];
    dom.window.setTimeout = function (fn) { return realSetTimeout(fn, 0); };
    dom.window.clearTimeout = realClearTimeout;
    dom.window.fetch = function (u, o) {
      seen.push(o && o.body ? JSON.parse(o.body).idempotencyKey : null);
      return new Promise(function (ok, fail) {
        if (o && o.signal) o.signal.addEventListener('abort', function () { fail(new Error('aborted')); });
      });
    };
    let hangErr = null;
    try { await dom.window.estimateDeliver({ ...sent, notes: `${NOTES} hang ${key}` }); } catch (e) { hangErr = e; }
    line(seen.length === 2 && seen[0] === seen[1] && !!hangErr && hangErr.network === true,
      '12d', 'no answer: one retry, same idempotency key, then error',
      `attempts=${seen.length} sameKey=${seen.length === 2 && seen[0] === seen[1]} err=${hangErr && hangErr.message}`);

    /* 12e: the first attempt dies on the network, the retry gets through. Two
       posts, one key, one stored lead - the exact case the retry exists for. */
    dom.window.setTimeout = realSetTimeout;
    const seen2 = [];
    dom.window.fetch = function (u, o) {
      seen2.push(JSON.parse(o.body).idempotencyKey);
      if (seen2.length === 1) return Promise.reject(new TypeError('Failed to fetch'));
      return realFetch(u, o);
    };
    await resetLimits();
    const marker3 = `${NOTES} retry ${key}`;
    let retryOk = false, retryErr = null;
    try { await dom.window.estimateDeliver({ ...sent, notes: marker3 }); retryOk = true; } catch (e) { retryErr = e.message; }
    const { data: retried } = await svc.from('leads').select('id').eq('notes', marker3);
    dom.window.fetch = realFetch;
    line(retryOk && seen2.length === 2 && seen2[0] === seen2[1] && (retried || []).length === 1,
      '12e', 'network failure then success: one key, one lead',
      retryErr || `attempts=${seen2.length} sameKey=${seen2[0] === seen2[1]} rows=${(retried || []).length}`);
  }
}

/* ---------- 13. logs carry no personal data ---------- */
{
  const text = fs.readFileSync(LOG, 'utf8').slice(logOffset);
  const needles = [NAME, PHONE, EMAIL, NOTES, 'zzq'];
  const hits = needles.filter((n) => text.includes(n));
  line(hits.length === 0, '13', 'server log has no name/phone/email/notes',
    hits.length ? `found: ${hits.join(', ')}` : `${text.length} bytes scanned`);
}

/* ---------- 14. a honeypot drop is logged, and writes nothing ---------- */
{
  await resetLimits();
  const key = `${RUN}-t14`;
  const count = () => (fs.readFileSync(LOG, 'utf8').slice(logOffset).match(/lead_dropped_honeypot/g) || []).length;
  const before = count();
  const { status } = await post(payload({ idempotencyKey: key, website: 'http://spam.example' }), { http: true });
  let after = before;
  for (let i = 0; i < 24 && after <= before; i++) {
    await new Promise((r) => setTimeout(r, 125));
    after = count();
  }
  const rows = await leadFor(key);
  line(status === 200 && after > before && rows.length === 0, '14', 'honeypot drop logged, no row',
    `${status} log ${before}->${after} rows=${rows.length}`);
}

/* ---------- 15. response body exposes nothing ---------- */
{
  await resetLimits();
  const key = `${RUN}-t15`;
  const { status, json: body } = await post(payload({ idempotencyKey: key }));
  const exact = status === 200 && body && Object.keys(body).length === 1 && body.ok === true;
  line(exact, '15', 'POST /api/lead body is exactly {ok:true}',
    `${status} ${JSON.stringify(body)}`);
}

/* ---------- 16-18. modal static checks (markup in index.html, CSS in the stylesheet) ---------- */
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  /* The CSS moved to its own file on 2026-11-10; the assertions are unchanged,
     they just read the file that holds the rules now. */
  const cssPath = path.join(ROOT, 'assets', 'css', 'styles.css');
  const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : html;
  // M1: dialog caps at 680px
  const m1 = css.includes('width: min(680px, 100%)') && !css.includes('width: min(600px, 100%)');
  line(m1, 'M1', 'modal dialog width min(680px,100%)', `found=${m1}`);
  // M2: grid/input overflow fix
  const m2 = css.includes('grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)')
    && css.includes('min-width: 0') && css.includes('max-width: 100%');
  line(m2, 'M2', 'row2 grid + inputs cannot overflow', `found=${m2}`);
  // M3: the two ends of one row — Close at the far left, Call at the right.
  const m3block = (css.match(/\.est-actions\s*\{[^}]*\}/) || [''])[0];
  const m3actions = m3block.includes('justify-content: space-between') && /gap:\s*12px/.test(m3block);
  const m3order = /<button type="button" class="btn ghost" data-close[^>]*>Close<\/button>\s*<a class="btn phone" href="tel:\{\{tel\}\}/.test(html);
  line(m3actions && m3order, 'M3', 'success row: Close first at the far left, Call at the right', `align=${m3actions} order=${m3order}`);
  // M3b: both min-height 52px (was 48; the row grew when Call became the filled button)
  const m3b = /\.est-actions\s+\.btn\.ghost\s*\{[^}]*min-height:\s*52px/.test(css)
    && /\.est-actions\s+\.btn\.phone\s*\{[^}]*min-height:\s*52px/.test(css);
  line(m3b, 'M3b', 'success buttons min-height 52px', `found=${m3b}`);
  // M3c: Call IS the shared phone button — the same component as the header and
  // the CTA — so the old one-off .est-call style must be gone, not restyled.
  const m3cShared = /\.btn\.phone\s*\{[^}]*border-color:\s*rgb\(255 255 255\/\.15\)/.test(css)
    && html.includes('<a class="btn phone" href="tel:{{tel}}" aria-label="Call {{phone}}"');
  const m3cNoBespoke = !html.includes('est-call') && !css.includes('est-call');
  line(m3cShared && m3cNoBespoke, 'M3c', 'Call uses the shared phone button, no bespoke style left',
    `shared=${m3cShared} noBespoke=${m3cNoBespoke}`);
  // M3d: 375px stacks (media <=760 row2 single column)
  const m3d = /@media\s*\(max-width:\s*760px\)\s*\{[^}]*\.row2\s*\{\s*grid-template-columns:\s*1fr/.test(css);
  line(m3d, 'M3d', '375px Phone/Email stack in one column', `found=${m3d}`);
}

/* ---------- P: phone E.164 validation + storage ---------- */
{
  // P1: bare US number is stored as E.164
  await resetLimits();
  const k1 = `${RUN}-p1`;
  const s1 = await post(payload({ idempotencyKey: k1, phone: '5155550142' }));
  const r1 = await leadFor(k1);
  line(s1.status === 200 && r1.length === 1 && r1[0].phone === '+15155550142',
    'P1', 'US bare -> stored E.164', `${s1.status} stored=${r1[0] && r1[0].phone}`);
}
{
  // P2: international number is stored as E.164
  await resetLimits();
  const k2 = `${RUN}-p2`;
  const s2 = await post(payload({ idempotencyKey: k2, phone: '+44 20 7946 0958' }));
  const r2 = await leadFor(k2);
  line(s2.status === 200 && r2.length === 1 && r2[0].phone === '+442079460958',
    'P2', 'international -> stored E.164', `${s2.status} stored=${r2[0] && r2[0].phone}`);
}
{
  // P3: invalid number -> 400, nothing written
  await resetLimits();
  const k3 = `${RUN}-p3`;
  const s3 = await post(payload({ idempotencyKey: k3, phone: 'abc' }));
  line(s3.status === 400 && (await leadFor(k3)).length === 0,
    'P3', 'invalid phone -> 400, nothing written', s3.status);
}
{
  // P4: +20 followed by 9 digits (real manual-test value shape) -> 400, no row
  await resetLimits();
  const k4 = `${RUN}-p4`;
  const s4 = await post(payload({ idempotencyKey: k4, phone: '+20312345678' }));
  line(s4.status === 400 && (await leadFor(k4)).length === 0,
    'P4', '+20+9 digits -> 400, nothing written', s4.status);
}
{
  // P5: 16 digits -> 400, no row
  await resetLimits();
  const k5 = `${RUN}-p5`;
  const s5 = await post(payload({ idempotencyKey: k5, phone: '1234567890123456' }));
  line(s5.status === 400 && (await leadFor(k5)).length === 0,
    'P5', '16 digits -> 400, nothing written', s5.status);
}
{
  // P6: letters -> 400, no row
  await resetLimits();
  const k6 = `${RUN}-p6`;
  const s6 = await post(payload({ idempotencyKey: k6, phone: 'abcdefgh' }));
  line(s6.status === 400 && (await leadFor(k6)).length === 0,
    'P6', 'letters -> 400, nothing written', s6.status);
}
{
  // P7: one valid US number in three formats -> identical stored E.164
  const forms = ['(212) 555-0100', '212-555-0100', '+1 212 555 0100'];
  const stored = [];
  let statusesOk = true;
  for (let i = 0; i < forms.length; i++) {
    await resetLimits();
    const kk = `${RUN}-p7-${i}`;
    const ss = await post(payload({ idempotencyKey: kk, phone: forms[i] }));
    if (ss.status !== 200) statusesOk = false;
    const rr = await leadFor(kk);
    stored.push(rr.length ? rr[0].phone : 'missing');
  }
  line(statusesOk && stored.every((v) => v === '+12125550100'),
    'P7', 'US three formats -> identical E.164', stored.join(','));
}
{
  // P8: valid +20 mobile -> stored
  await resetLimits();
  const k8 = `${RUN}-p8`;
  const s8 = await post(payload({ idempotencyKey: k8, phone: '+201005408111' }));
  const r8 = await leadFor(k8);
  line(s8.status === 200 && r8.length === 1 && r8[0].phone === '+201005408111',
    'P8', 'valid +20 mobile -> stored E.164', `${s8.status} stored=${r8[0] && r8[0].phone}`);
}
{
  // P9: built HTML phone input has maxlength="20"
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const ok = /<input[^>]*id="e-phone"[^>]*maxlength="20"/.test(html);
  line(ok, 'P9', 'phone input maxlength 20 (static)', `found=${ok}`);
}

/* ---------- P10+: max-build phone validation + modal error handler ---------- */
{
  // P10: +20 with 8 national digits (mobile prefix needs 10) -> 400, no row.
  // The /min build accepted this; the /max build rejects it.
  await resetLimits();
  const k10 = `${RUN}-p10`;
  const s10 = await post(payload({ idempotencyKey: k10, phone: '+2010054083' }));
  line(s10.status === 400 && (await leadFor(k10)).length === 0,
    'P10', '+20+8 digits -> 400, nothing written (max build)', s10.status);
}
{
  // P11: +20 with 13 national digits -> 400, no row.
  await resetLimits();
  const k11 = `${RUN}-p11`;
  const s11 = await post(payload({ idempotencyKey: k11, phone: '+201005408345333' }));
  line(s11.status === 400 && (await leadFor(k11)).length === 0,
    'P11', '+20+13 digits -> 400, nothing written', s11.status);
}
{
  // P12: valid +20 mobile (10 national digits) -> stored E.164.
  await resetLimits();
  const k12 = `${RUN}-p12`;
  const s12 = await post(payload({ idempotencyKey: k12, phone: '+201005408345' }));
  const r12 = await leadFor(k12);
  line(s12.status === 200 && r12.length === 1 && r12[0].phone === '+201005408345',
    'P12', 'valid +20 mobile -> stored E.164', `${s12.status} stored=${r12[0] && r12[0].phone}`);
}
{
  // P13: the real 400 body for a bad phone, fed to the modal's plain handler:
  // the phone error is shown under the phone field and the generic panel is NOT.
  await resetLimits();
  const k13 = `${RUN}-p13`;
  const s13 = await post(payload({ idempotencyKey: k13, phone: '+2010054083' }));
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m13 = /function handleLeadError\(err, ui\) \{([\s\S]*?)\n  \}\n  window\.estimateHandleError/.exec(html);
  if (!m13 || s13.status !== 400 || !s13.json || !s13.json.errors) {
    line(false, 'P13', 'modal handler: real 400 body -> phone field error, no generic panel',
      `handlerFound=${!!m13} status=${s13.status} body=${JSON.stringify(s13.json)}`);
  } else {
    const { default: vm } = await import('node:vm');
    const fn = vm.runInNewContext('(function handleLeadError(err, ui) {' + m13[1] + '\n})', Object.create(null));
    const seen = { fields: {}, focused: null, generic: false };
    const ui = {
      setField: (k, msg) => { seen.fields[k] = msg; },
      focusField: (k) => { seen.focused = k; },
      showGeneric: () => { seen.generic = true; },
    };
    const kind = fn({ status: s13.status, body: s13.json }, ui);
    const ok = kind === 'field' && seen.fields.phone === 'Enter a valid phone number.'
      && seen.focused === 'phone' && seen.generic === false;
    line(ok, 'P13', 'modal handler: real 400 body -> phone field error, no generic panel',
      `kind=${kind} phone=${seen.fields.phone} focused=${seen.focused} generic=${seen.generic}`);
  }
}
{
  // P14: 5xx and network failure still show the generic panel, never a field error.
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m14 = /function handleLeadError\(err, ui\) \{([\s\S]*?)\n  \}\n  window\.estimateHandleError/.exec(html);
  if (!m14) {
    line(false, 'P14', 'modal handler: 5xx/network -> generic panel only', 'handler not found');
  } else {
    const { default: vm } = await import('node:vm');
    const fn = vm.runInNewContext('(function handleLeadError(err, ui) {' + m14[1] + '\n})', Object.create(null));
    const run = (err) => {
      const seen = { fields: {}, generic: false };
      const kind = fn(err, {
        setField: (k, msg) => { seen.fields[k] = msg; },
        focusField: () => {},
        showGeneric: () => { seen.generic = true; },
      });
      return kind === 'generic' && seen.generic === true && Object.keys(seen.fields).length === 0;
    };
    const ok = run({ status: 500, body: { ok: false } }) && run({ status: 503, body: {} }) && run(new Error('network'));
    line(ok, 'P14', 'modal handler: 5xx/network -> generic panel only', `ok=${ok}`);
  }
}
{
  /* B19 (source level, no browser): pressing send twice within 30 s used to fall
     into showError, so a visitor who simply pressed twice was told the form had
     failed. The second press now reaches the sent panel with the duplicate
     wording, and the generic error panel is not used at all. What this cannot
     check is how the panel looks in a real browser — the state machine needs a
     DOM and timers, which this suite does not drive. */
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dup = /if \(Date\.now\(\) - lastSent < 30000\) \{([^}]*)\}/.exec(html);
  const sentFn = /function showSent\(data, already\) \{([\s\S]*?)\n  \}/.exec(html);
  const hasState = !!sentFn && /already \? 'You already sent this request/.test(sentFn[1])
    && /Request already received/.test(sentFn[1]);
  const routes = !!dup && /showSent\(data, true\)/.test(dup[1]) && !/showError/.test(dup[1]);
  line(hasState && routes,
    'B19', 'in-page duplicate -> already-received state, not the error panel',
    `branch=${!!dup} showSentFlag=${routes} wording=${hasState}`);
}
{
  // P15: the built HTML inlines the calling-code table, under 6 KB, with the
  // known entries baked in. Runs the real build to a scratch output.
  const { spawnSync } = await import('node:child_process');
  const outFile = path.join(ROOT, '_debug', 'build-test', 'index.html');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'build-static.js'), 'index.html', '--out', outFile], { cwd: ROOT, encoding: 'utf8' });
  let ok = false, detail = '';
  if (r.status === 0 && fs.existsSync(outFile)) {
    const built = fs.readFileSync(outFile, 'utf8');
    const m = /var PHONE_CC = (\{[\s\S]*?\});/.exec(built);
    if (m) {
      let table = null;
      try { table = JSON.parse(m[1]); } catch {}
      // Before (build-static): '1': [7, 10] (metadata min covered a small
      // territory, letting 7-digit "US" numbers pass). After: NANP override
      // to [10, 10] — North American numbers have exactly 10 national digits.
      const want = { '1': [10, 10], '20': [8, 10], '44': [7, 10], '971': [5, 12] };
      const entriesOk = table && Object.entries(want).every(([k, v]) => JSON.stringify(table[k]) === JSON.stringify(v));
      ok = built.includes('var PHONE_CC = {') && !built.includes('/*__PHONE_CC__*/')
        && m[1].length < 6 * 1024 && entriesOk;
      detail = `bytes=${m[1].length} entries=${entriesOk} 1=${JSON.stringify(table && table['1'])} 20=${JSON.stringify(table && table['20'])} 44=${JSON.stringify(table && table['44'])} 971=${JSON.stringify(table && table['971'])}`;
    } else detail = 'table not found in built HTML';
  } else detail = `build failed: ${(r.stderr || r.stdout || '').slice(0, 80)}`;
  line(ok, 'P15', 'built HTML has calling-code table under 6 KB', detail);
}
{
  // P16: notes of 2001 chars -> 400 WITH errors.notes (never the bare
  // {ok:false} that showed the generic panel), and no row written.
  await resetLimits();
  const k16 = `${RUN}-p16`;
  const s16 = await post(payload({ idempotencyKey: k16, notes: 'x'.repeat(2001) }));
  line(s16.status === 400 && s16.json && s16.json.errors && s16.json.errors.notes === 'Keep notes under 2000 characters.'
    && (await leadFor(k16)).length === 0,
    'P16', 'notes 2001 chars -> 400 with errors.notes, no row',
    `${s16.status} ${JSON.stringify(s16.json)}`);
}
{
  // P17: the real notes 400 body through the modal handler (same node:vm
  // approach as P13): an inline message is set and generic stays false.
  // Plus a static check that the notes field has its own .err element.
  await resetLimits();
  const k17 = `${RUN}-p17`;
  const s17 = await post(payload({ idempotencyKey: k17, notes: 'y'.repeat(2001) }));
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m17 = /function handleLeadError\(err, ui\) \{([\s\S]*?)\n  \}\n  window\.estimateHandleError/.exec(html);
  const notesMarkup = /<div class="f" data-f="notes"[^>]*>[\s\S]*?<textarea id="e-notes"[^>]*><\/textarea><p class="err"/.test(html);
  if (!m17 || s17.status !== 400 || !s17.json || !s17.json.errors) {
    line(false, 'P17', 'modal handler: notes 400 -> inline message, no generic panel',
      `handler=${!!m17} status=${s17.status} markup=${notesMarkup}`);
  } else {
    const { default: vm } = await import('node:vm');
    const fn = vm.runInNewContext('(function handleLeadError(err, ui) {' + m17[1] + '\n})', Object.create(null));
    const seen = { fields: {}, focused: null, generic: false };
    const kind = fn({ status: s17.status, body: s17.json }, {
      setField: (k, msg) => { seen.fields[k] = msg; },
      focusField: (k) => { seen.focused = k; },
      showGeneric: () => { seen.generic = true; },
    });
    const ok = kind === 'field' && seen.fields.notes === 'Keep notes under 2000 characters.'
      && seen.focused === 'notes' && seen.generic === false && notesMarkup;
    line(ok, 'P17', 'modal handler: notes 400 -> inline message, no generic panel',
      `kind=${kind} notes=${seen.fields.notes} focused=${seen.focused} generic=${seen.generic} markup=${notesMarkup}`);
  }
}

{
  // P18: firstErrorStep (vm, same approach as P13/P17): earliest step in
  // step order wins; notes/unknown land on the last step.
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m18 = /function firstErrorStep\(errors\) \{([\s\S]*?)\n  \}\n  window\.estimateFirstErrorStep/.exec(html);
  const stepsMatch = /var STEPS = (\[[\s\S]*?\]);/.exec(html);
  if (!m18 || !stepsMatch) {
    line(false, 'P18', 'firstErrorStep: earliest errored step', `found=${!!m18}/${!!stepsMatch}`);
  } else {
    const { default: vm } = await import('node:vm');
    const STEPS = vm.runInNewContext('(' + stepsMatch[1] + ')', Object.create(null));
    const fn = vm.runInNewContext('(function firstErrorStep(errors) {' + m18[1] + '\n})', { STEPS });
    const cases = [
      [{ service: 'x' }, 0, 'service'],
      [{ zip: 'x', timing: 'x' }, 1, 'zip'],
      [{ timing: 'x' }, 2, 'timing'],
      [{ phone: 'x', service: 'x' }, 0, 'service'],
      [{ phone: 'x' }, 3, 'phone'],
      [{ notes: 'x' }, 3, 'notes'],
      [{}, null, null],
    ];
    const bad = cases.filter(([errors, step, field]) => {
      const r = fn(errors);
      return step === null ? r !== null : (!r || r.step !== step || r.field !== field);
    });
    line(bad.length === 0, 'P18', 'firstErrorStep: earliest errored step',
      bad.length ? 'bad: ' + JSON.stringify(bad) : `${cases.length} cases ok`);
  }
}

/* ---------- P19+: exhaustive countries, trunk/00, US strictness ---------- */
async function loadPhoneApi() {
  const built = fs.readFileSync(path.join(ROOT, '_debug', 'build-test', 'index.html'), 'utf8');
  const tableMatch = /var PHONE_CC = (\{[\s\S]*?\});/.exec(built);
  const defaultMatch = /var PHONE_DEFAULT_CC = "([^"]*)";/.exec(built);
  const fn = (name) => {
    const m = new RegExp('function ' + name + '\\([\\s\\S]*?\\n  \\}').exec(built);
    if (!m) throw new Error('not found: ' + name);
    return m[0];
  };
  const asciiLine = built.split('\n').find((l) => l.includes('var ascii ='));
  const sandbox = { PHONE_CC: JSON.parse(tableMatch[1]), PHONE_DEFAULT_CC: defaultMatch[1] };
  const { default: vm } = await import('node:vm');
  const src = [
    'var AR = ' + JSON.stringify('٠١٢٣٤٥٦٧٨٩') + ', FA = ' + JSON.stringify('۰۱۲۳۴۵۶۷۸۹') + ';',
    asciiLine.trim(), fn('matchCc'), fn('phoneOk'), fn('sanitizePhone'), fn('phoneSubmit'),
  ].join('\n');
  vm.runInNewContext(src + '\nthis._api = { sanitizePhone, phoneOk, phoneSubmit };', sandbox);
  return sandbox._api;
}
const digitsOnly = (s) => String(s).replace(/\D/g, '');
const typeSeqOf = (api) => (s) => { let v = ''; for (const ch of s) v = api.sanitizePhone(v + ch); return v; };

{
  // P19: exhaustive — every getCountries() region, mobile examples (the only
  // examples file shipped is examples.mobile.json), E.164 + INTERNATIONAL,
  // typed char-by-char through the real sanitizePhone.
  const api = await loadPhoneApi();
  const typeSeq = typeSeqOf(api);
  const { getCountries, getExampleNumber, isValidPhoneNumber } = await import('libphonenumber-js/max');
  const { default: examples } = await import('libphonenumber-js/mobile/examples');
  const regions = getCountries();
  let tested = 0;
  const failures = [];
  for (const region of regions) {
    const ex = getExampleNumber(region, examples);
    if (!ex) continue;
    for (const raw of [ex.number, ex.format('INTERNATIONAL')]) {
      if (!raw) continue;
      tested++;
      const typed = typeSeq(raw);
      const kept = digitsOnly(typed).length === digitsOnly(raw).length;
      const ok = api.phoneOk(typed);
      const server = isValidPhoneNumber(ex.number, 'US');
      if (!kept || !ok || !server) failures.push(`${region} raw=${raw} typed=${typed} kept=${kept} ok=${ok} srv=${server}`);
    }
  }
  line(failures.length === 0, 'P19', 'exhaustive: every region example, no digit dropped, valid',
    `regions=${regions.length} tested=${tested} failures=${failures.length}` + (failures.length ? ' | ' + failures.slice(0, 8).join(' ; ') : ''));
}
{
  // P20: trunk-zero and 00 cases — client (typed/submitted) + server stored E.164.
  const api = await loadPhoneApi();
  const typeSeq = typeSeqOf(api);
  const cases = [
    ['+44 (0)7911 123456', '+447911123456'],
    ['+44 07911 123456', '+447911123456'],
    ['+20 0100 540 8345', '+201005408345'],
    ['+49 (0)30 123456', '+4930123456'],
    ['+39 06 1234 5678', '+390612345678'],
    ['0044 7911 123456', '+447911123456'],
    ['00201005408345', '+201005408345'],
  ];
  const bad = [];
  for (let i = 0; i < cases.length; i++) {
    const [raw, want] = cases[i];
    const typed = typeSeq(raw);
    const intlRaw = raw.startsWith('00') ? '+' + raw.slice(2) : raw;
    // Client submit: trunk stripped exactly when it pushes past the max
    // (+44/+20); inside the cap (+49) the typed digits are kept and the
    // server's retry strips the trunk. Italy's zero is kept everywhere.
    const clientOk = digitsOnly(typed).length === digitsOnly(intlRaw).length && api.phoneOk(typed)
      && (api.phoneSubmit(typed) === want || digitsOnly(api.phoneSubmit(typed)) === digitsOnly(typed));
    await resetLimits();
    const kk = `${RUN}-p20-${i}`;
    const ss = await post(payload({ idempotencyKey: kk, phone: raw }));
    const rr = await leadFor(kk);
    const serverOk = ss.status === 200 && rr.length === 1 && rr[0].phone === want;
    if (!clientOk || !serverOk) bad.push(`${raw} typed=${typed} submit=${api.phoneSubmit(typed)} client=${clientOk} ${ss.status} stored=${rr[0] && rr[0].phone}`);
  }
  line(bad.length === 0, 'P20', 'trunk zero + 00: no drop, stored E.164 (Italy zero kept)',
    bad.length ? bad.join(' ; ') : `${cases.length} cases ok`);
}
{
  // P21: still-invalid numbers stay 400 with no row (no loosening).
  const badList = ['+20 0100 540 83', '+44 07911 123', '0020 100'];
  const results = [];
  for (let i = 0; i < badList.length; i++) {
    await resetLimits();
    const kk = `${RUN}-p21-${i}`;
    const ss = await post(payload({ idempotencyKey: kk, phone: badList[i] }));
    results.push(ss.status === 400 && (await leadFor(kk)).length === 0);
  }
  line(results.every(Boolean), 'P21', 'invalid trunk/00 numbers stay 400, no row', results.join(','));
}
{
  // P22: US strictness — client phoneOk and server agree on each length.
  const api = await loadPhoneApi();
  const clientCases = [
    ['5550142', false], ['51555014', false], ['515550142', false],
    ['5155550142', true], ['15155550142', true],
    ['+1515555014', false], ['+15155550142', true], ['+151555501420', false],
  ];
  const clientBad = clientCases.filter(([raw, want]) => api.phoneOk(raw) !== want);
  const serverCases = [['5550142', 400], ['5155550142', 200], ['15155550142', 200], ['+1515555014', 400], ['+151555501420', 400]];
  const serverBad = [];
  for (let i = 0; i < serverCases.length; i++) {
    await resetLimits();
    const kk = `${RUN}-p22-${i}`;
    const ss = await post(payload({ idempotencyKey: kk, phone: serverCases[i][0] }));
    if (ss.status !== serverCases[i][1]) serverBad.push(`${serverCases[i][0]}=${ss.status}`);
  }
  line(clientBad.length === 0 && serverBad.length === 0, 'P22', 'US strictness: client and server agree (10 digits)',
    `clientBad=${clientBad.map(([r]) => r).join(',')} serverBad=${serverBad.join(',')}`);
}

/* ---------- P23: the modal's error wiring, on the real markup ---------- */
{
  // The wiring runs once at init: every .err gets an id and the field's control
  // points at it with aria-describedby. The snippet is extracted from the page and
  // executed against the real DOM, so a change to the selector or to the loop is
  // caught here rather than only in a browser.
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const start = html.indexOf('  function fieldControl(f) {');
  const end = html.indexOf("  form.addEventListener('input'", start);
  const snippet = start > 0 && end > start ? html.slice(start, end) : '';
  const dom = new JSDOM(html);
  const { document } = dom.window;
  const form = document.querySelector('.est-form');
  let api = null;
  let err = '';
  try {
    const { default: vm } = await import('node:vm');
    const factory = vm.runInNewContext(
      `(function (form, R) {\n${snippet}\nreturn { check: check, fieldControl: fieldControl };\n})`,
      Object.create(null),
    );
    api = factory(form, { phone: () => 'Enter a valid phone number.', zip: () => '' });
  } catch (e) { err = e.message; }

  const alerts = form.querySelectorAll('.err[role="alert"]').length;
  const generic = form.querySelectorAll('.est-alert[role="alert"]').length;
  const groups = [].slice.call(form.querySelectorAll('[data-f]'));
  const unlinked = [];
  for (const f of groups) {
    const p = f.querySelector('.err');
    const c = api && api.fieldControl(f);
    if (!p || !p.id || !c || c.getAttribute('aria-describedby') !== p.id || document.getElementById(p.id) !== p) {
      unlinked.push(f.dataset.f);
    }
  }
  const linkedAll = groups.length === 9 && unlinked.length === 0;
  const roleOnlyOnPanel = alerts === 0 && generic === 1;

  // The inline validator writes into the element the control points at, and marks
  // that same control invalid.
  let writesRight = false;
  let detail = '';
  if (api) {
    api.check('phone');
    const input = form.querySelector('#e-phone');
    const id = input.getAttribute('aria-describedby');
    const target = id ? document.getElementById(id) : null;
    writesRight = !!target && target.textContent === 'Enter a valid phone number.'
      && input.getAttribute('aria-invalid') === 'true';
    detail = `target=${!!target} text=${target ? JSON.stringify(target.textContent) : 'none'} invalid=${input.getAttribute('aria-invalid')}`;
  }

  // The submit path must use the same helper, or a server-side error would land on
  // a different element than the inline one.
  const submitUsesHelper = /f\.querySelector\('\.err'\)\.textContent = msg;[\s\S]{0,200}var c = fieldControl\(f\);/.test(html);

  line(roleOnlyOnPanel && linkedAll && writesRight && submitUsesHelper && !err, 'P23',
    'modal errors: one live region, every field linked, message lands in it',
    err || `alerts=${alerts} generic=${generic} groups=${groups.length} unlinked=${unlinked.join(',') || 'none'} write=${writesRight} submit=${submitUsesHelper} ${detail}`);
}

/* ---------- cleanup ----------
   The fixture chat is removed in a finally: a throw in any delete above must not
   leave a binding behind (the runner would fail the next run for it). */
{
  let leftovers = 0;
  try {
    await svc.from('leads').delete().like('idempotency_key', `${RUN}-%`);
    if (SEED_BIZ) await sweepTestLeads(svc, [SEED_BIZ], new Date().toISOString()).catch(() => 0);
    await svc.from('leads').delete().like('notes', `${NOTES}%`);   // page-created uuid rows
    const { data } = await svc.from('leads').select('id').or(`idempotency_key.like.${RUN}-%,notes.like.${NOTES}%`);
    leftovers = (data || []).length;
    await svc.from('rate_limits').delete().gte('window_start', '2000-01-01');
  } finally {
    try { await svc.from('business_chats').delete().eq('tg_chat_id', ALERT_CHAT); } catch { /* the guard will report it */ }
    console.log('');
    console.log(`cleanup: leads left = ${leftovers}, rate_limits cleared, fixture chat removed`);
  }
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
