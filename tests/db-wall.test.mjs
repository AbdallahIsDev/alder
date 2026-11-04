#!/usr/bin/env node
// tests/db-wall.test.mjs — proves the money wall and the schema constraints.
//
//   node tests/db-wall.test.mjs
//
// Reads SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY from .env (or the
// real environment). Prints PASS/FAIL per line, exits 1 if anything failed.
// Creates a few rows, then deletes every one of them and verifies the table is clean.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN = Math.random().toString(36).slice(2, 8);
const TAG = `dbtest-${RUN}`;

/* ---------- .env, no dependency ---------- */
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadEnv(path.join(ROOT, '.env'));
loadEnv(path.join(ROOT, '.env.local'));

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
  const ok = !!error || (Array.isArray(data) && data.length === 0);
  line(ok, '1', `anon SELECT ${t}`.padEnd(34), error ? error.code || error.message : `${data.length} rows`);
}

{
  const { data, error } = await anon.from('v_client_leads').select('*').limit(1);
  const ok = !!error || (Array.isArray(data) && data.length === 0);
  line(ok, '1', 'anon SELECT v_client_leads'.padEnd(34), error ? error.code || error.message : `${data.length} rows`);
}

{
  const { error } = await anon.from('businesses').insert({ slug: `anon-${RUN}`, name: 'x', owner_email: 'x@example.com' });
  line(!!error, '1', 'anon INSERT businesses rejected'.padEnd(34), error ? error.code || error.message : 'INSERT SUCCEEDED');
}

/* ---------- 2. anon cannot call the rate-limit function ---------- */
{
  const { error } = await anon.rpc('hit_rate_limit', { p_key: `anon-${RUN}`, p_window_seconds: 60, p_max: 3 });
  line(!!error, '2', 'anon rpc hit_rate_limit denied'.padEnd(34), error ? error.code || error.message : 'RPC SUCCEEDED');
}

/* ---------- 3. anon cannot read private.lead_financials ---------- */
{
  const { error } = await anon.schema('private').from('lead_financials').select('*').limit(1);
  line(!!error, '3', 'schema not exposed (weak check)'.padEnd(34), error ? error.code || error.message : 'READ SUCCEEDED');
  note('test 3 is weak: PostgREST only proves the private schema is not exposed over HTTP.');
  note('the real proof of that wall was the earlier local Postgres run, where anon held');
  note('no USAGE on schema private and was refused at the parser, not at the HTTP layer.');
}

/* ---------- business row ---------- */
const { data: biz, error: bizErr } = await svc.from('businesses').select('id,slug,status').eq('slug', 'alder-demo').maybeSingle();
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

/* ---------- 8. cleanup ---------- */
{
  await svc.from('leads').delete().like('idempotency_key', `${TAG}-%`);
  await svc.from('rate_limits').delete().eq('key', 'test');
  const { data: left, error } = await svc.from('leads').select('id').like('idempotency_key', `${TAG}-%`);
  const { data: rl } = await svc.from('rate_limits').select('key').eq('key', 'test');
  const { data: ev } = leadId ? await svc.from('lead_events').select('id').eq('lead_id', leadId) : { data: [] };
  const ok = !error && (left || []).length === 0 && (rl || []).length === 0 && (ev || []).length === 0;
  line(ok, '8', 'test rows cleaned up'.padEnd(34), `leads=${(left || []).length} rate_limits=${(rl || []).length} events=${(ev || []).length}`);
}

console.log('');
console.log(`${results.length - failed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
