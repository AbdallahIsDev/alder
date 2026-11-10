#!/usr/bin/env node
// tests/test-env-check.test.mjs — Gate E.
// HARNESS: in-process, no network, no database. Fixture files in a temp dir.
//
// What it proves:
//   E1  a complete, distinct .env.test passes with 0 problems
//   E2  a missing required name fails and is named
//   E3  SUPABASE_URL that still points at production fails
//   E4  DATABASE_URL that still points at production fails
//   E5  TELEGRAM_API_BASE in the file fails (it would shadow the loopback fake)
//   E6  RESEND_API_BASE in the file fails (same reason)
//   E7  no .env.test at all fails, and says so
//   E8  no value, URL, key or host is ever printed — the canaries stay out
//
// Mutation: drop the missing-name branch in readinessReport and E2 fails;
// drop the FORBIDDEN loop and E5/E6 fail; drop sameSupabaseUrl and E3 fails.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  REQUIRED, OPTIONAL, FORBIDDEN, readinessReport, runReadiness,
} from '../scripts/test-env-check.mjs';

let total = 0;
let failed = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(52)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};

/** A .env.test that should pass, with a distinct value for every name. */
function readyEnv() {
  const env = {
    SUPABASE_URL: 'https://testrefaaaaaaaaaaaa.supabase.co',
    SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.fake-signature',
    SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.fake-signature',
    DATABASE_URL: 'postgresql://postgres.test:pw@aws-0-eu-west-3.pooler.supabase.com:5432/postgres',
    IP_HASH_SALT: 'test-salt',
    TELEGRAM_BOT_TOKEN: '123:test-token',
    TELEGRAM_CHAT_ID: '5000000000000099',
    TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
    RESEND_API_KEY: 're_test_key',
    MAIL_FROM: 'alerts@test.invalid',
    MAIL_REDIRECT_TO: 'inbox@test.invalid',
    SITE_URL: 'http://localhost:3000',
    AUTOREPLY_DAILY_CAP: '5',
  };
  return env;
}
const prodEnv = () => ({
  SUPABASE_URL: 'https://prodrefaaaaaaaaaaaa.supabase.co',
  DATABASE_URL: 'postgresql://postgres:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres',
  TELEGRAM_WEBHOOK_SECRET: 'prod-webhook-secret',
});

const problemText = (r) => r.lines.join('\n');

/* E1: the happy path. */
{
  const r = readinessReport({ test: readyEnv(), prod: prodEnv() });
  line(r.problems === 0
    && problemText(r).includes(`required present   ${REQUIRED.length}/${REQUIRED.length}`)
    && problemText(r).includes('SUPABASE_URL       differs from .env: yes')
    && problemText(r).includes('DATABASE_URL       differs from .env: yes'),
  'E1', 'complete .env.test: no problems, both URLs differ', `problems=${r.problems}`);
}

/* E2: one name missing is enough. */
{
  const env = readyEnv();
  delete env.SITE_URL;
  const r = readinessReport({ test: env, prod: prodEnv() });
  line(r.problems === 1 && problemText(r).includes('missing: SITE_URL'),
    'E2', 'a missing required name fails and is named', `problems=${r.problems}`);
}

/* E3: the URL still points at production. Trailing slash and case must not hide it. */
{
  const env = readyEnv();
  env.SUPABASE_URL = 'HTTPS://PRODREFAAAAAAAAAAAA.supabase.co/';
  const r = readinessReport({ test: env, prod: prodEnv() });
  line(r.problems === 1 && problemText(r).includes('SUPABASE_URL is the same project as .env (production)'),
    'E3', 'production SUPABASE_URL fails (slash/case insensitive)', `problems=${r.problems}`);
}

/* E4: the DSN still points at production. */
{
  const env = readyEnv();
  env.DATABASE_URL = prodEnv().DATABASE_URL;
  const r = readinessReport({ test: env, prod: prodEnv() });
  line(r.problems === 1 && problemText(r).includes('DATABASE_URL is the same database as .env (production)'),
    'E4', 'production DATABASE_URL fails', `problems=${r.problems}`);
}

/* E5 / E6: the two loopback overrides must never come from a file. */
{
  const a = readyEnv();
  a.TELEGRAM_API_BASE = 'http://127.0.0.1:9';
  const r1 = readinessReport({ test: a, prod: prodEnv() });
  const b = readyEnv();
  b.RESEND_API_BASE = 'http://127.0.0.1:9';
  const r2 = readinessReport({ test: b, prod: prodEnv() });
  const named = (r, n) => problemText(r).includes('must not be set in a file: ' + n);
  line(r1.problems === 1 && named(r1, 'TELEGRAM_API_BASE')
    && r2.problems === 1 && named(r2, 'RESEND_API_BASE'),
  'E5', 'forbidden overrides fail, each named',
  `tg=${r1.problems} resend=${r2.problems}`);
}

/* E11: the exact swap the owner made — a DSN in the URL field, a URL in the DSN
   field. Both names present, both differ from production, and nothing else
   complains, so this is the only check that catches it. */
{
  const env = readyEnv();
  env.SUPABASE_URL = 'postgresql://postgres:pw@aws-0-eu-west-3.pooler.supabase.com:5432/postgres';
  env.DATABASE_URL = 'https://testrefaaaaaaaaaaaa.supabase.co';
  const r = readinessReport({ test: env, prod: prodEnv() });
  line(r.problems === 1 && problemText(r).includes('look swapped'),
    'E11', 'a swapped URL/DSN pair fails with one clear line', `problems=${r.problems}`);
}

/* E12 / E13: shape of each value on its own. */
{
  const a = readyEnv();
  a.SUPABASE_URL = 'https://example.com';
  const r1 = readinessReport({ test: a, prod: prodEnv() });
  const b = readyEnv();
  b.DATABASE_URL = 'https://testrefaaaaaaaaaaaa.supabase.co';
  const r2 = readinessReport({ test: b, prod: prodEnv() });
  line(r1.problems === 1 && problemText(r1).includes('SUPABASE_URL is not https://<ref>.supabase.co')
    && r2.problems === 1 && problemText(r2).includes('DATABASE_URL is not a postgres'),
  'E12', 'URL and DSN shapes are checked separately',
  `url=${r1.problems} dsn=${r2.problems}`);
}

/* E14 / E15: a key that is neither a JWT nor an sb_ key. */
{
  const a = readyEnv();
  a.SUPABASE_ANON_KEY = 'test-anon-key';
  const r1 = readinessReport({ test: a, prod: prodEnv() });
  const b = readyEnv();
  b.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  const r2 = readinessReport({ test: b, prod: prodEnv() });
  line(r1.problems === 1 && problemText(r1).includes('SUPABASE_ANON_KEY is neither')
    && r2.problems === 1 && problemText(r2).includes('SUPABASE_SERVICE_ROLE_KEY is neither'),
  'E14', 'both keys must be a JWT or an sb_ key', `anon=${r1.problems} svc=${r2.problems}`);
}

/* E16: the new key format is accepted, so the early-2027 migration does not have
   to change this script. */
{
  const env = readyEnv();
  env.SUPABASE_ANON_KEY = 'sb_publishable_abc123';
  env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_xyz789';
  const r = readinessReport({ test: env, prod: prodEnv() });
  line(r.problems === 0, 'E16', 'sb_publishable_ / sb_secret_ keys pass', `problems=${r.problems}`);
}

/* E7: no .env.test at all. */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envcheck-empty-'));
  let text = '';
  const code = runReadiness({ root: dir, write: (s) => { text += s; } });
  fs.rmSync(dir, { recursive: true, force: true });
  line(code === 1 && text.includes('.env.test is missing.') && text.includes('docs/TEST_PROJECT.md'),
    'E7', 'no .env.test: exit 1 and the doc pointer', `code=${code}`);
}

/* E8: a passing report prints names and verdicts, never a value, URL, key or host. */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envcheck-canary-'));
  const canary = 'CANARY7f3a9c';
  const env = readyEnv();
  env.SUPABASE_URL = `https://${canary}aaaaaaaa.supabase.co`;
  env.DATABASE_URL = `postgresql://postgres:${canary}@${canary}-db.pooler.supabase.com:5432/postgres`;
  env.SUPABASE_SERVICE_ROLE_KEY = `eyJhbGciOiJIUzI1NiJ9.${canary}.sig`;
  env.TELEGRAM_WEBHOOK_SECRET = canary + '-hook';
  const writeFile = (name, obj) => fs.writeFileSync(path.join(dir, name),
    Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  writeFile('.env', { SUPABASE_URL: 'https://prodrefaaaaaaaaaaaa.supabase.co', DATABASE_URL: prodEnv().DATABASE_URL });
  writeFile('.env.test', env);
  let text = '';
  const code = runReadiness({ root: dir, write: (s) => { text += s; } });
  fs.rmSync(dir, { recursive: true, force: true });
  const leaked = text.toLowerCase().includes(canary.toLowerCase())
    || text.includes('supabase.co') || /host:/i.test(text) || /table \w+:/.test(text);
  line(code === 0 && !leaked,
    'E8', 'passing output leaks no value, URL, key or host', `code=${code} leaked=${leaked}`);
}

/* The default mode must not be the posture report: those names are the --db ones. */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envcheck-mode-'));
  fs.writeFileSync(path.join(dir, '.env.test'), 'SUPABASE_URL=https://x.supabase.co\n');
  let text = '';
  runReadiness({ root: dir, write: (s) => { text += s; } });
  fs.rmSync(dir, { recursive: true, force: true });
  line(!/rls enabled|tables unreachable|is production host/i.test(text),
    'E9', 'default mode is readiness, not the --db posture', `len=${text.length}`);
}

/* The constants the runner and the doc both rely on. */
{
  const ok = REQUIRED.length === 12 && OPTIONAL.length === 2
    && FORBIDDEN.join(',') === 'TELEGRAM_API_BASE,RESEND_API_BASE'
    && REQUIRED.includes('DATABASE_URL') && REQUIRED.includes('MAIL_FROM');
  line(ok, 'E10', 'required/optional/forbidden lists are intact',
    `required=${REQUIRED.length} optional=${OPTIONAL.length}`);
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
