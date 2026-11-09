#!/usr/bin/env node
// tests/db-wall.test.mjs — proves the money wall and the schema constraints.
//
//   node tests/db-wall.test.mjs
//
// Reads SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY through lib/env.js
// (process.env > .env.test when TEST_ENV=1 > .env.local > .env). Prints PASS/FAIL per
// line, exits 1 if anything failed. Creates a few rows, then deletes every one of them
// and verifies the table is clean.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from '../lib/env.js';
import { ALDER_DEMO } from './helpers.mjs';
import { isWallProof, isSchemaProof, classifyAnonDenial } from './denial.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN = Math.random().toString(36).slice(2, 8);
const TAG = `dbtest-${RUN}`;

/* ---------- env, one shared loader ---------- */
loadEnv();

/* ---------- result printer ---------- */
let failed = 0;
const results = [];
function line(ok, id, what, detail) {
  if (!ok) failed++;
  const tag = ok ? 'PASS' : 'FAIL';
  const d = detail ? '  ' + String(detail).replace(/\s+/g, ' ').slice(0, 110) : '';
  const out = `${tag}  ${id.padEnd(4)}${what}${d}`;
  results.push(out);
  console.log(out);
}
function note(text) {
  console.log(`NOTE  ${' '.repeat(4)}${text}`);
}

/* ---------- clients ---------- */
const URL_ = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL_ || !ANON || !SERVICE) {
  console.log('FAIL  env  SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  process.exit(1);
}

const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const anon = createClient(URL_, ANON, opts);
const svc = createClient(URL_, SERVICE, opts);

const PUBLIC_TABLES = ['businesses', 'business_chats', 'bind_codes', 'leads', 'lead_events', 'review_feedback', 'rate_limits'];

/* ---------- 1. anon cannot read or write public tables ---------- */
for (const t of PUBLIC_TABLES) {
  const { data, error } = await anon.from(t).select('*').limit(1);
  const ok = isWallProof({ error, rows: data });
  line(ok, '1', `anon SELECT ${t}`.padEnd(34), error ? classifyAnonDenial(error) : `${data.length} rows`);
}

{
  const { data, error } = await anon.from('v_client_leads').select('*').limit(1);
  const ok = isWallProof({ error, rows: data });
  line(ok, '1', 'anon SELECT v_client_leads'.padEnd(34), error ? classifyAnonDenial(error) : `${data.length} rows`);
}

{
  const { error } = await anon.from('businesses').insert({ slug: `anon-${RUN}`, name: 'x', owner_email: 'x@example.com' });
  line(isWallProof({ error }), '1', 'anon INSERT businesses rejected'.padEnd(34),
    error ? classifyAnonDenial(error) : 'INSERT SUCCEEDED');
}

/* ---------- 2. anon cannot call the rate-limit function ---------- */
{
  const { error } = await anon.rpc('hit_rate_limit', { p_key: `anon-${RUN}`, p_window_seconds: 60, p_max: 3 });
  line(isWallProof({ error }), '2', 'anon rpc hit_rate_limit denied'.padEnd(34),
    error ? classifyAnonDenial(error) : 'RPC SUCCEEDED');
}

/* ---------- 3. anon cannot read private.lead_financials ---------- */
{
  const { error } = await anon.schema('private').from('lead_financials').select('*').limit(1);
  line(isSchemaProof({ error }), '3', 'schema not exposed (weak check)'.padEnd(34),
    error ? classifyAnonDenial(error) : 'READ SUCCEEDED');
  note('test 3 is weak: PostgREST only proves the private schema is not exposed over HTTP.');
  note('the real proof of that wall was the earlier local Postgres run, where anon held');
  note('no USAGE on schema private and was refused at the parser, not at the HTTP layer.');
}

/* ---------- business row ---------- */
const { data: biz, error: bizErr } = await svc.from('businesses').select('id,slug,status').eq('slug', ALDER_DEMO).maybeSingle();
if (bizErr || !biz) {
  console.log(`FAIL  seed  'alder-demo' business missing — run supabase/seed.sql  (${bizErr?.message || 'no row'})`);
  process.exit(1);
}
const BIZ_ID = biz.id;

/* ---------- 4. service_role insert + idempotency ---------- */
const baseLead = {
  business_id: BIZ_ID,
  name: 'Wall Test',
  phone: '5155550100',
  email: 'wall@example.com',
  zip: '50265',
  service: 'replacement',
  home: 'house',
  timing: 'asap',
  roof_age: '10 to 20 years',
  insurance_claim: false,
  notes: 'db-wall test row',
  idempotency_key: `${TAG}-dup`,
};

let leadId = null;
{
  const { data, error } = await svc.from('leads').insert(baseLead).select('id').single();
  leadId = data?.id || null;
  line(!error && !!leadId, '4', 'service_role INSERT lead'.padEnd(34), error ? error.code || error.message : leadId);
}
{
  const { error } = await svc.from('leads').insert({ ...baseLead, idempotency_key: `${TAG}-dup` }).select('id');
  line(!!error, '4', 'duplicate (business,idempotency) rejected'.padEnd(34), error ? error.code || error.message : 'INSERT SUCCEEDED');
}

/* ---------- 5b. 0004 extended the allow-list but did not remove the wall ---------- */
if (leadId) {
  const { error } = await svc.from('lead_events').insert({ lead_id: leadId, kind: 'definitely_not_a_kind', meta: {} });
  line(!!error, '5b', 'unknown event kind still rejected'.padEnd(34), error ? error.code || error.message : 'INSERT SUCCEEDED');
}

/* ---------- 5. constraints ---------- */
const bad = [
  ['zip abcde', { zip: 'abcde' }],
  ['name 81 chars', { name: 'n'.repeat(81) }],
  ['notes 2001 chars', { notes: 'x'.repeat(2001) }],
  ['status banana', { status: 'banana' }],
  ['name 1 char', { name: 'n' }],
];
for (const [label, over] of bad) {
  const { error } = await svc.from('leads').insert({ ...baseLead, ...over, idempotency_key: `${TAG}-bad-${label.replace(/\W+/g, '')}` }).select('id');
  line(!!error, '5', `reject ${label}`.padEnd(34), error ? error.code || error.message : 'INSERT SUCCEEDED');
}

/* ---------- 6. hit_rate_limit ---------- */
{
  await svc.from('rate_limits').delete().eq('key', 'test');
  // hit_rate_limit buckets by floor(epoch / p_window_seconds). Four calls that
  // straddle a minute boundary start a fresh counter, so the 4th would be allowed
  // and the test would fail at random. Wait out a boundary that is too close.
  const msLeft = 60000 - (Date.now() % 60000);
  if (msLeft < 3000) await new Promise((r) => setTimeout(r, msLeft + 50));
  const seq = [];
  for (let i = 0; i < 4; i++) {
    const { data, error } = await svc.rpc('hit_rate_limit', { p_key: 'test', p_window_seconds: 60, p_max: 3 });
    seq.push(error ? 'err' : data);
  }
  const ok = seq[0] === true && seq[1] === true && seq[2] === true && seq[3] === false;
  line(ok, '6', 'hit_rate_limit true x3 then false'.padEnd(34), seq.join(','));
}

/* ---------- 7. the view carries no money columns ---------- */
{
  const { data, error } = await svc.from('v_client_leads').select('*').eq('id', leadId).single();
  const cols = data ? Object.keys(data) : [];
  const banned = ['quoted_cents', 'won_cents', 'quoted', 'won', 'amount', 'price', 'revenue', 'margin'];
  const hits = cols.filter((c) => banned.includes(c));
  const ok = !error && cols.length > 0 && hits.length === 0;
  line(ok, '7', 'v_client_leads has no money columns'.padEnd(34), error ? error.code || error.message : `${cols.length} cols: ${cols.join(',')}`);
}

/* ---------- 9. bind_codes wall + lifecycle ---------- */
const BIND_CODE = ('DBTEST' + RUN).replace(/[^A-Z0-9]/g, '').toUpperCase().slice(0, 12).padEnd(12, '7');
{
  const { error } = await anon.from('bind_codes').insert({ code: BIND_CODE, business_id: BIZ_ID, expires_at: new Date(Date.now() + 3600 * 1000).toISOString() });
  line(!!error, '9', 'anon INSERT bind_codes rejected'.padEnd(34), error ? error.code || error.message : 'INSERT SUCCEEDED');
}
{
  const expires = new Date(Date.now() + 3600 * 1000).toISOString();
  const ins = await svc.from('bind_codes').insert({ code: BIND_CODE, business_id: BIZ_ID, expires_at: expires });
  const sel = ins.error ? { data: null } : await svc.from('bind_codes').select('code, business_id').eq('code', BIND_CODE).maybeSingle();
  const del = await svc.from('bind_codes').delete().eq('code', BIND_CODE);
  const gone = await svc.from('bind_codes').select('code').eq('code', BIND_CODE);
  const ok = !ins.error && sel.data && sel.data.business_id === BIZ_ID && !del.error && (gone.data || []).length === 0;
  line(ok, '9', 'service_role bind_code create/read/delete'.padEnd(34), ok ? 'lifecycle ok' : `ins=${ins.error ? ins.error.code : 'ok'} del=${del.error ? del.error.code : 'ok'}`);
}

/* ---------- 8. cleanup ---------- */
{
  await svc.from('leads').delete().like('idempotency_key', `${TAG}-%`);
  await svc.from('rate_limits').delete().eq('key', 'test');
  await svc.from('bind_codes').delete().eq('code', BIND_CODE);
  const { data: left, error } = await svc.from('leads').select('id').like('idempotency_key', `${TAG}-%`);
  const { data: rl } = await svc.from('rate_limits').select('key').eq('key', 'test');
  const { data: ev } = leadId ? await svc.from('lead_events').select('id').eq('lead_id', leadId) : { data: [] };
  const { data: bc } = await svc.from('bind_codes').select('code').eq('code', BIND_CODE);
  const ok = !error && (left || []).length === 0 && (rl || []).length === 0 && (ev || []).length === 0 && (bc || []).length === 0;
  line(ok, '8', 'test rows cleaned up'.padEnd(34), `leads=${(left || []).length} rate_limits=${(rl || []).length} events=${(ev || []).length} bind=${(bc || []).length}`);
}

/* ---------- E: env loading through the REAL loader (temp files, no DB) ----------
   Every case below writes actual .env* files into a temp root and calls the same
   loadEnv() the runner and the scripts use. No hand-ordered entry lists: if the
   loader's precedence changes, these fail. */
{
  const { loadEnv, missingEnvNames, checkNotProduction } = await import('../lib/env.js');
  const base = path.join(ROOT, '_debug', 'envtest-' + RUN);
  const mk = (name, files) => {
    const dir = path.join(base, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
    return dir;
  };

  // E1: only .env.local present — it supplies its own key and the shared one.
  {
    const dir = mk('e1', { '.env.local': 'ONLY_LOCAL=local_val\nSHARED=local_val\n', '.env': 'ONLY_BASE=base_val\n' });
    const env = {};
    const { sources } = loadEnv({ env, root: dir, testEnv: false });
    const ok = env.ONLY_LOCAL === 'local_val' && env.ONLY_BASE === 'base_val'
      && sources.ONLY_LOCAL === '.env.local' && sources.ONLY_BASE === '.env';
    line(ok, 'E1', 'env loader: each file supplies its own keys', `local=${sources.ONLY_LOCAL} base=${sources.ONLY_BASE}`);
  }

  // E2: all three files define SHARED; TEST_ENV decides, and process.env always wins.
  {
    const dir = mk('e2', {
      '.env.test': 'SHARED=test_val\nALREADY=test_val\n',
      '.env.local': 'SHARED=local_val\nALREADY=local_val\n',
      '.env': 'SHARED=base_val\nALREADY=base_val\n',
    });
    const withTest = loadEnv({ env: { ALREADY: 'proc_val' }, root: dir, testEnv: true }).env;
    const withoutTest = loadEnv({ env: { ALREADY: 'proc_val' }, root: dir, testEnv: false }).env;
    const ok = withTest.SHARED === 'test_val' && withoutTest.SHARED === 'local_val'
      && withTest.ALREADY === 'proc_val' && withoutTest.ALREADY === 'proc_val';
    line(ok, 'E2', 'precedence: process > .env.test > .env.local > .env',
      `test=${withTest.SHARED} noTest=${withoutTest.SHARED} proc=${withTest.ALREADY}`);
  }

  // E3: nothing present — nothing filled, and the missing names are reported in order.
  {
    const dir = mk('e3', {});
    const env = {};
    const { sources } = loadEnv({ env, root: dir, testEnv: true });
    const ok = Object.keys(env).length === 0
      && missingEnvNames(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']).join(',') === 'SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY'
      && Object.keys(sources).length === 0;
    line(ok, 'E3', 'no files: nothing filled, missing names listed', `keys=${Object.keys(env).length}`);
  }

  // E4: .env.test is ignored unless TEST_ENV=1 — the file must not leak into normal runs.
  {
    const dir = mk('e4', { '.env.test': 'ONLY_TEST=test_val\n' });
    const off = loadEnv({ env: {}, root: dir, testEnv: false }).env;
    const on = loadEnv({ env: {}, root: dir, testEnv: true }).env;
    line(off.ONLY_TEST === undefined && on.ONLY_TEST === 'test_val', 'E4',
      '.env.test ignored unless TEST_ENV=1', `off=${off.ONLY_TEST === undefined} on=${on.ONLY_TEST === 'test_val'}`);
  }

  // E5: the production guard compares values and never prints them.
  {
    const dir = mk('e5', { '.env': 'SUPABASE_URL=https://prod-project.example.co/\n' });
    const same = checkNotProduction({ SUPABASE_URL: 'https://prod-project.example.co' }, dir);
    const other = checkNotProduction({ SUPABASE_URL: 'https://test-project.example.co' }, dir);
    const none = checkNotProduction({}, dir);
    line(same.reason === 'same-as-env' && other.reason === 'ok' && none.reason === 'no-url', 'E5',
      'guard: same URL refused, different allowed, missing reported',
      `same=${same.reason} other=${other.reason} none=${none.reason}`);
  }

  fs.rmSync(base, { recursive: true, force: true });
}

/* ---------- E7: the IP hash refuses to exist without a salt ----------
   An unsalted sha256 of an IPv4 address is a 2^32 lookup, so a "pseudonymous"
   rate-limit key with no salt is really the address. hashIp returns null and the
   callers decide; neither endpoint may fall back to an unsalted hash. */
{
  const { hashIp } = await import('../lib/hash.js');
  const a = hashIp('203.0.113.9', 'salt-a');
  const b = hashIp('203.0.113.9', 'salt-b');
  const c = hashIp('203.0.113.9', 'salt-a');
  const saved = process.env.IP_HASH_SALT;
  delete process.env.IP_HASH_SALT;
  const noSalt = hashIp('203.0.113.9');
  process.env.IP_HASH_SALT = 'from-env';
  const fromEnv = hashIp('203.0.113.9');
  if (saved === undefined) delete process.env.IP_HASH_SALT; else process.env.IP_HASH_SALT = saved;
  const ok = typeof a === 'string' && a.length === 64 && a === c && a !== b
    && noSalt === null && fromEnv === hashIp('203.0.113.9', 'from-env');
  line(ok, 'E7', 'IP hash: salted, salt-dependent, null without a salt',
    `len=${a && a.length} stable=${a === c} saltMatters=${a !== b} noSalt=${noSalt === null} env=${!!fromEnv}`);
}

/* ---------- E10: the auto-reply cap default and its parsing ----------
   40 is sized against Resend's free plan: 100 emails/day, and a capped lead can
   still cost one uncapped owner email, so the cap must stay under half of it. */
{
  const { autoReplyCap } = await import('../lib/notify.js');
  const saved = process.env.AUTOREPLY_DAILY_CAP;
  delete process.env.AUTOREPLY_DAILY_CAP;
  const def = autoReplyCap();
  process.env.AUTOREPLY_DAILY_CAP = '7';
  const seven = autoReplyCap();
  const bad = ['0', '-3', 'abc', ''].every((v) => { process.env.AUTOREPLY_DAILY_CAP = v; return autoReplyCap() === 40; });
  if (saved === undefined) delete process.env.AUTOREPLY_DAILY_CAP; else process.env.AUTOREPLY_DAILY_CAP = saved;
  line(def === 40 && seven === 7 && bad, 'E10', 'auto-reply cap: default 40, invalid falls back',
    `default=${def} explicit=${seven} invalid=${bad}`);
}

/* ---------- E9: clientIp trusts the Vercel headers before x-forwarded-for ----------
   On Vercel the edge sets x-real-ip and x-vercel-forwarded-for; x-forwarded-for's
   left-most entry is whatever the client sent. If the order ever flips, a caller
   can rotate that header and walk past the per-IP rate limit. */
{
  const { clientIp } = await import('../lib/request.js');
  const h = (o) => ({ headers: o });
  const realWins = clientIp(h({ 'x-real-ip': '1.1.1.1', 'x-forwarded-for': '9.9.9.9' })) === '1.1.1.1';
  const vercelWins = clientIp(h({ 'x-vercel-forwarded-for': '2.2.2.2', 'x-forwarded-for': '9.9.9.9' })) === '2.2.2.2';
  const firstOfList = clientIp(h({ 'x-forwarded-for': '3.3.3.3, 4.4.4.4' })) === '3.3.3.3';
  const socketFallback = clientIp({ headers: {}, socket: { remoteAddress: '5.5.5.5' } }) === '5.5.5.5';
  const empty = clientIp({ headers: {} }) === '';
  line(realWins && vercelWins && firstOfList && socketFallback && empty, 'E9',
    'clientIp: real-ip, then vercel, then xff, then socket',
    `real=${realWins} vercel=${vercelWins} xff=${firstOfList} socket=${socketFallback} empty=${empty}`);
}

/* ---------- E8: --seed-check is read-only and exempt from the production guard ----------
   The guard protects suites. --seed-check runs two SELECTs and exits, and it is the
   command the handoff recommends instead of a full run, so refusing it would make
   the documented workflow unusable against production. Exit code is not asserted:
   it is 0 when the row matches seed and 1 when it does not, and both are fine here. */
{
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'run.mjs'), '--seed-check'], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000, env: { ...process.env, ALLOW_PROD_TESTS: '' },
  });
  const refused = /refusing to run/.test(r.stdout || '');
  const ran = /seed-check\s+(OK|FAIL|differing-columns)/.test(r.stdout || '');
  line(!refused && ran, 'E8', 'seed-check runs without ALLOW_PROD_TESTS', `refused=${refused} ran=${ran} exit=${r.status}`);
}

/* ---------- E6: the runner rejects unknown flags ----------
   `--timing` used to be dropped silently, so it looked like a working flag.
   The child is given a real suite so that, if the check regresses, it exits 0
   after a 0.1 s run instead of starting the whole default suite. */
{
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'run.mjs'), '--timing', 'tests/migrations.test.mjs'], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000,
  });
  const ok = r.status === 1 && /unknown flag\(s\): --timing/.test(r.stdout || '');
  line(ok, 'E6', 'runner rejects an unknown flag', `exit=${r.status} msg=${ok}`);
}

console.log('');
console.log(`${results.length - failed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
