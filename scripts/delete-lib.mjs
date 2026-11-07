// scripts/delete-lib.mjs — shared plumbing for the destructive scripts.
//
// Rules every caller follows:
//   - dry run unless --yes
//   - --yes additionally needs the target typed back, via --confirm <value>
//   - refuses to run against the project named in .env unless
//     --i-know-this-is-prod is given
//   - prints counts and table names only; never a name, phone, email or note
//
// Deletion order matters and is the same for both scripts: children first, so a
// failure part-way leaves a smaller, not a broken, dataset. The database also
// cascades leads -> lead_events / review_feedback / private.lead_financials and
// businesses -> business_chats / bind_codes, but the scripts delete explicitly
// rather than trusting a cascade they cannot see.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnv } from '../lib/env.js';
import { readEnvFile } from '../lib/env.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA_FILE = path.join(ROOT, 'supabase', 'prod-ca-2021.crt');

export function out(s = '') { process.stdout.write(s + '\n'); }
export function pad(s, n) { return String(s).padEnd(n); }

/** Resolve env, then refuse a production target unless explicitly acknowledged. */
export function resolveTarget(argv, { name }) {
  loadEnv();
  const dsn = process.env.DATABASE_URL;
  if (!dsn) fail(`${name}: no DATABASE_URL in process.env, .env.test (TEST_ENV=1), .env.local or .env.`);

  const prodDsn = readEnvFile('.env').DATABASE_URL;
  const sameAsEnv = !!prodDsn && String(dsn).trim() === String(prodDsn).trim();
  const acknowledged = argv.includes('--i-know-this-is-prod');
  if (sameAsEnv && !acknowledged) {
    fail(`${name}: DATABASE_URL is the database named in .env (production).\n`
      + '      Re-run with --i-know-this-is-prod if that is really what you want.');
  }
  return { dsn, isProd: sameAsEnv };
}

export async function connect(dsn) {
  const haveCA = fs.existsSync(CA_FILE);
  const client = new pg.Client({
    connectionString: dsn,
    ssl: haveCA
      ? { rejectUnauthorized: true, ca: fs.readFileSync(CA_FILE, 'utf8') }
      : { rejectUnauthorized: true },
    connectionTimeoutMillis: 20000,
    application_name: 'alder-delete',
  });
  await client.connect();
  return client;
}

export function fail(msg) {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

/** True when the caller passed --yes. */
export function hasYes(argv) {
  return argv.includes('--yes');
}

/**
 * The "type it again" gate. `--confirm <value>` must equal the target exactly.
 * (The scripts run non-interactively here; a prompt would be untestable.)
 */
export function confirmed(argv, expected, label) {
  const i = argv.indexOf('--confirm');
  const given = i > -1 ? argv[i + 1] : null;
  if (!given) return false;
  return String(given) === String(expected);
}

export async function count(client, sql, params) {
  const { rows } = await client.query(sql, params);
  return rows[0] ? Number(Object.values(rows[0])[0]) : 0;
}
