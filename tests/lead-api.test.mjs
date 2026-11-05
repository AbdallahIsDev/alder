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

/* ---------- .env ---------- */
const env = {};
if (fs.existsSync(path.join(ROOT, '.env'))) {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
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
const EMAIL = 'zzq.api@example.com';
const NOTES = 'zzq note marker';

function payload(over) {
  return {
    service: 'replacement', home: 'house', timing: 'asap', age: '10 to 20 years',
    zip: '50265', phone: PHONE, name: NAME, email: EMAIL, notes: NOTES,
    claim: false, website: '', elapsed: 5000,
    slug: 'alder-demo', idempotencyKey: `${RUN}-base`,
    ...over,
  };
}

let ipSeq = 10;
async function post(body, opts = {}) {
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
const svc = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

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
    dom.window.fetch = (u, o) => fetch(new URL(u, ORIGIN).href, o);
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
  const { status } = await post(payload({ idempotencyKey: key, website: 'http://spam.example' }));
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
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-real-ip': `203.0.113.${ipSeq++}` },
    body: JSON.stringify(payload({ idempotencyKey: key })),
  });
  let body = null;
  try { body = await res.json(); } catch {}
  const exact = res.status === 200 && body && Object.keys(body).length === 1 && body.ok === true;
  line(exact, '15', 'POST /api/lead body is exactly {ok:true}',
    `${res.status} ${JSON.stringify(body)}`);
}

/* ---------- 16-18. modal static checks (index.html text only) ---------- */
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  // M1: dialog caps at 680px
  const m1 = html.includes('width: min(680px, 100%)') && !html.includes('width: min(600px, 100%)');
  line(m1, 'M1', 'modal dialog width min(680px,100%)', `found=${m1}`);
  // M2: grid/input overflow fix
  const m2 = html.includes('grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)')
    && html.includes('min-width: 0') && html.includes('max-width: 100%');
  line(m2, 'M2', 'row2 grid + inputs cannot overflow', `found=${m2}`);
  // M3: success actions right-aligned
  const m3 = /\.est-actions\s*\{[^}]*justify-content:\s*flex-end[^}]*\}/.test(html);
  line(m3, 'M3', 'success Close/Call row right-aligned', `found=${m3}`);
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

/* ---------- cleanup ---------- */
{
  await svc.from('leads').delete().like('idempotency_key', `${RUN}-%`);
  await svc.from('leads').delete().like('notes', `${NOTES}%`);          // rows the page created with its own uuid key
  const { data: leftovers } = await svc.from('leads').select('id').or(`idempotency_key.like.${RUN}-%,notes.like.${NOTES}%`);
  await svc.from('rate_limits').delete().gte('window_start', '2000-01-01');
  console.log('');
  console.log(`cleanup: leads left = ${(leftovers || []).length}, rate_limits cleared`);
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
