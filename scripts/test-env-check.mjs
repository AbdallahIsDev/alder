#!/usr/bin/env node
// scripts/test-env-check.mjs — is .env.test ready for a test run?
//
//   npm run test:env-check
//
// Prints NAMES only: which required variables are present, which are missing, and
// whether the Supabase URLs point somewhere other than the production project in
// .env. Never prints a value, a URL, a key or a host.
//
// Exit 1 on any problem: no .env.test, a missing required name, a value that still
// matches production, or a forbidden override name.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDotEnvText } from '../lib/env.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* Everything the suites and the runner actually read. Verified by grepping
   process.env.* across tests/, api/, lib/ and scripts/. */
const REQUIRED = [
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
const OPTIONAL = ['AUTOREPLY_DAILY_CAP', 'HEALTH_SECRET'];
/* The runner refuses to start if a file defines these: they would shadow the
   loopback overrides that point the tests at the local fake servers. */
const FORBIDDEN = ['TELEGRAM_API_BASE', 'RESEND_API_BASE'];

const read = (name) => {
  const p = path.join(ROOT, name);
  return fs.existsSync(p) ? parseDotEnvText(fs.readFileSync(p, 'utf8')) : null;
};
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const norm = (v) => String(v || '').trim().replace(/\/+$/, '').toLowerCase();

const out = (s = '') => process.stdout.write(s + '\n');
let problems = 0;
const bad = (s) => { problems++; out('  FAIL  ' + s); };

out('test-env-check');
out('');

const test = read('.env.test');
if (!test) {
  out('  .env.test is missing.');
  out('');
  out('  Copy .env.test.example to .env.test and fill it in.');
  out('  See docs/TEST_PROJECT.md for the step-by-step.');
  process.exit(1);
}

const present = REQUIRED.filter((n) => nonEmpty(test[n]));
const missing = REQUIRED.filter((n) => !nonEmpty(test[n]));
out(`  required present   ${present.length}/${REQUIRED.length}`);
if (missing.length) bad('missing: ' + missing.join(', '));

const optionalPresent = OPTIONAL.filter((n) => nonEmpty(test[n]));
out(`  optional present   ${optionalPresent.length}/${OPTIONAL.length}${optionalPresent.length ? ' (' + optionalPresent.join(', ') + ')' : ''}`);

const forbidden = FORBIDDEN.filter((n) => nonEmpty(test[n]));
if (forbidden.length) bad('must not be set in a file: ' + forbidden.join(', ') + ' — the runner would refuse to start');

const prod = read('.env') || {};
const url = norm(test.SUPABASE_URL);
const prodUrl = norm(prod.SUPABASE_URL);
if (url && prodUrl && url === prodUrl) {
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

out('');
if (problems) {
  out(`RESULT  ${problems} problem(s) — fix them before running the suite.`);
  process.exit(1);
}
out('RESULT  OK — .env.test looks ready. Next: TEST_ENV=1 npm run db:apply, then TEST_ENV=1 node tests/run.mjs');
