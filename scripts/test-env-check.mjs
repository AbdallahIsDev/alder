#!/usr/bin/env node
// scripts/test-env-check.mjs — two read-only checks for a test Supabase project.
//
//   npm run test:env-check            readiness: names only, never a value
//   npm run test:env-check -- --db    posture: connects, prints the host name only
//
// Default mode prints NAMES only: which required variables are present, which
// are missing, and whether the Supabase URLs point somewhere other than the
// production project in .env. Never prints a value, a URL, a key or a host.
//
// Exit 1 on any problem: no .env.test, a missing required name, a value that
// still matches production, or a forbidden override name.
//
// --db mode is the newer, optional report: host name, whether it is production,
// row counts per table, and the security posture (RLS, anon/authenticated
// grants, rls_auto_enable). It prints the host name and nothing else that could
// identify the project.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDotEnvText, readEnvFile, sameSupabaseUrl } from '../lib/env.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* Everything the suites and the runner actually read. Verified by grepping
   process.env.* across tests/, api/, lib/ and scripts/. */
export const REQUIRED = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'DATABASE_URL',
  'IP_HASH_SALT',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'TELEGRAM_WEBHOOK_SECRET',
  'RESEND_API_KEY',
  'MAIL_FROM',
  'MAIL_REDIRECT_TO',
  'SITE_URL',
];
export const OPTIONAL = ['AUTOREPLY_DAILY_CAP', 'HEALTH_SECRET'];
/* The runner refuses to start if a file defines these: they would shadow the
   loopback overrides that point the tests at the local fake servers. */
export const FORBIDDEN = ['TELEGRAM_API_BASE', 'RESEND_API_BASE'];

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const norm = (v) => String(v || '').trim().replace(/\/+$/, '').toLowerCase();

/**
 * Readiness of a .env.test against .env. Pure: takes parsed objects, returns
 * { lines, problems }. Never returns or prints a value.
 */
export function readinessReport({ test, prod = {} }) {
  const lines = [];
  let problems = 0;
  const out = (s = '') => lines.push(s);
  const bad = (s) => { problems++; out('  FAIL  ' + s); };

  const present = REQUIRED.filter((n) => nonEmpty(test[n]));
  const missing = REQUIRED.filter((n) => !nonEmpty(test[n]));
  out(`  required present   ${present.length}/${REQUIRED.length}`);
  if (missing.length) bad('missing: ' + missing.join(', '));

  const optionalPresent = OPTIONAL.filter((n) => nonEmpty(test[n]));
  out(`  optional present   ${optionalPresent.length}/${OPTIONAL.length}${optionalPresent.length ? ' (' + optionalPresent.join(', ') + ')' : ''}`);

  const forbidden = FORBIDDEN.filter((n) => nonEmpty(test[n]));
  if (forbidden.length) bad('must not be set in a file: ' + forbidden.join(', ') + ' — the runner would refuse to start');

  const url = norm(test.SUPABASE_URL);
  const prodUrl = norm(prod.SUPABASE_URL);
  if (url && prodUrl && sameSupabaseUrl(url, prodUrl)) {
    bad('SUPABASE_URL is the same project as .env (production)');
  } else if (url && prodUrl) {
    out('  SUPABASE_URL       differs from .env: yes');
  } else if (!prodUrl) {
    out('  SUPABASE_URL       differs from .env: cannot compare (.env has no SUPABASE_URL)');
  }

  const dsn = norm(test.DATABASE_URL);
  const prodDsn = norm(prod.DATABASE_URL);
  if (dsn && prodDsn && dsn === prodDsn) {
    bad('DATABASE_URL is the same database as .env (production)');
  } else if (dsn && prodDsn) {
    out('  DATABASE_URL       differs from .env: yes');
  }

  /* The two secrets must be distinct values, but they are compared, never shown. */
  if (nonEmpty(test.TELEGRAM_WEBHOOK_SECRET) && nonEmpty(prod.TELEGRAM_WEBHOOK_SECRET)
    && test.TELEGRAM_WEBHOOK_SECRET === prod.TELEGRAM_WEBHOOK_SECRET) {
    out('  note               TELEGRAM_WEBHOOK_SECRET is the production value (harmless, but not what a dummy is for)');
  }

  return { lines, problems };
}

const read = (name, root = ROOT) => {
  const p = path.join(root, name);
  return fs.existsSync(p) ? parseDotEnvText(fs.readFileSync(p, 'utf8')) : null;
};

/**
 * Print the readiness report for `root` and return the exit code. Returns
 * instead of calling process.exit so the suite can drive it against fixture
 * files without killing the test process.
 */
export function runReadiness({ root = ROOT, write = (s) => process.stdout.write(s) } = {}) {
  write('test-env-check\n\n');
  const test = read('.env.test', root);
  if (!test) {
    write('  .env.test is missing.\n\n');
    write('  Copy .env.test.example to .env.test and fill it in.\n');
    write('  See docs/TEST_PROJECT.md for the step-by-step.\n');
    return 1;
  }
  const report = readinessReport({ test, prod: read('.env', root) || {} });
  write(report.lines.join('\n') + '\n\n');
  if (report.problems) {
    write(`RESULT  ${report.problems} problem(s) — fix them before running the suite.\n`);
    return 1;
  }
  write('RESULT  OK — .env.test looks ready. Next: npm run db:apply with TEST_ENV=1, then node tests/run.mjs with TEST_ENV=1\n');
  return 0;
}

async function runPosture() {
  const { loadEnv } = await import('../lib/env.js');
  const { createClient } = await import('@supabase/supabase-js');
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
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  if (process.argv.includes('--db')) await runPosture();
  else process.exit(runReadiness());
}
