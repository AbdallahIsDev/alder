#!/usr/bin/env node
// scripts/test-env-check.mjs — read-only report for a test Supabase project.
//
// Prints the host name only (never the URL or a key), whether it is the
// production host, that every table the suites use is reachable (counts only),
// and the security posture: RLS per public table, anon/authenticated grants,
// and whether public.rls_auto_enable exists.
//
// Reads .env.test when present, else .env. Never writes.

import { loadEnv, readEnvFile } from '../lib/env.js';
import { parseDotEnvText } from '../lib/env.js';
import { createClient } from '@supabase/supabase-js';

const TABLES = ['businesses', 'business_chats', 'bind_codes', 'leads', 'lead_events', 'review_feedback', 'rate_limits'];

const env = loadEnv({ testEnv: true }).env;
const url = String(env.SUPABASE_URL || '');
const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
// The production host comes from .env, read directly so a loaded .env.test
// cannot hide it. Only the host name is used.
const prodHost = (() => {
  try {
    const parsed = readEnvFile('.env');
    return new URL(String(parsed.SUPABASE_URL || '')).hostname;
  } catch { return ''; }
})();

console.log('host:', host || '(missing SUPABASE_URL)');
console.log('is production host:', prodHost ? String(host === prodHost) : 'unknown (no .env SUPABASE_URL)');
console.log('test env file:', env.TEST_ENV === '1' ? 'TEST_ENV=1' : 'not set');

const svc = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const missing = [];
for (const t of TABLES) {
  const { count, error } = await svc.from(t).select('*', { count: 'exact', head: true });
  if (error) missing.push(t);
  else console.log(`table ${t}: ${count} rows`);
}
console.log('tables unreachable:', missing.length ? missing.join(',') : 'none');

const dbUrl = String(env.DATABASE_URL || '');
if (!dbUrl) {
  console.log('posture: skipped (no DATABASE_URL)');
  process.exit(missing.length ? 1 : 0);
}

const { default: pg } = await import('pg');
const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
try {
  await client.connect();
  const rls = await client.query(`select tablename, rowsecurity from pg_tables where schemaname='public' order by 1`);
  const on = rls.rows.filter((r) => r.rowsecurity).map((r) => r.tablename);
  console.log('rls enabled:', `${on.length}/${rls.rows.length}`, on.join(','));
  const grants = await client.query(`select grantee, count(*)::int as n from information_schema.role_table_grants where table_schema='public' and grantee in ('anon','authenticated') group by grantee order by 1`);
  console.log('anon/authenticated table grants:', grants.rows.length ? grants.rows.map((r) => `${r.grantee}=${r.n}`).join(',') : 'none');
  const auto = await client.query(`select exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='rls_auto_enable') as present`);
  console.log('rls_auto_enable:', String(auto.rows[0].present));
} catch (e) {
  console.log('posture: failed', e && e.code ? e.code : 'error');
} finally {
  await client.end().catch(() => {});
}
process.exit(missing.length ? 1 : 0);
