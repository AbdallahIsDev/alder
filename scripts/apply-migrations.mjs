#!/usr/bin/env node
// scripts/apply-migrations.mjs — one-shot, guarded schema apply.
//
//   npm run db:apply
//
// Reads DATABASE_URL through lib/env.js (process.env > .env.test when TEST_ENV=1 >
// .env.local > .env) and prints which source supplied it. A DATABASE_URL that comes
// from the shell is refused unless TEST_ENV=1, so a stray export cannot silently
// point this at another database. Verifies TLS against the pinned Supabase root —
// if the certificate does not verify, this stops and says so rather than quietly
// downgrading to an unverified connection.
//
// Safety: refuses to run if public.businesses already exists. It never drops,
// alters or truncates anything. Each file runs in its own transaction.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { APPLY_ORDER, unlistedMigrations, missingApplyFiles } from '../lib/migrations.js';
import { loadEnv } from '../lib/env.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* The list lives in lib/migrations.js so a test can prove it covers the directory.
   Checked here too, before connecting: a new .sql file that nobody listed is a
   silent schema gap on a fresh database. */
const UNLISTED = unlistedMigrations(ROOT);
const MISSING = missingApplyFiles(ROOT);
const ALL_FILES = APPLY_ORDER;

/* --only <path> applies a single later migration against an already-installed database.
   The "businesses must be absent" guard is deliberately skipped in that mode; nothing
   else changes: the file still runs in its own transaction and all post-checks still run. */
const onlyIdx = process.argv.indexOf('--only');
const ONLY = onlyIdx > -1 ? process.argv[onlyIdx + 1] : null;
const FILES = ONLY ? [ONLY] : ALL_FILES;

const out = (s = '') => process.stdout.write(s + '\n');
const pad = (s, n) => String(s).padEnd(n);
let failed = false;
const fail = (msg) => {
  failed = true;
  out('');
  out('FAIL  ' + msg);
};

/* ---------- env, one shared loader ---------- */
const { sources } = loadEnv();
const DSN = process.env.DATABASE_URL;

out('apply-migrations');
out('');

/* ---------- list integrity (no database needed) ---------- */
if (UNLISTED.length) {
  fail(`these migration files are not in lib/migrations.js APPLY_ORDER: ${UNLISTED.join(', ')}`);
  out('      A fresh database would be built without them. Add each one in order.');
  process.exit(1);
}
if (MISSING.length) {
  fail(`APPLY_ORDER lists files that do not exist: ${MISSING.join(', ')}`);
  process.exit(1);
}
out(`${pad('files', 26)}${ALL_FILES.length} in order, directory fully covered`);
out(`${pad('env source', 26)}${sources.DATABASE_URL || '(none)'}`);
out('');

/* A shell export is the one way to reach a database nobody meant to touch. */
if (DSN && sources.DATABASE_URL === 'process.env' && String(process.env.TEST_ENV || '') !== '1') {
  fail('DATABASE_URL came from the shell, not from an env file. Unset it, or set TEST_ENV=1 to allow it.');
  process.exit(1);
}

if (!DSN) {
  fail('no DATABASE_URL in process.env, .env.test (TEST_ENV=1), .env.local or .env.');
  process.exit(1);
}

let cfg;
try {
  const u = new URL(DSN);
  cfg = {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres',
  };
} catch {
  fail('DATABASE_URL is not a parseable URI.');
  process.exit(1);
}

// Supabase's pooler presents a chain anchored at its own private root
// ("Supabase Root 2021 CA"), which no public trust store contains. Verification stays
// on; we pin that root instead. Get it from the dashboard:
//   Project Settings -> Database -> SSL Configuration -> Download certificate
// and save it as supabase/prod-ca-2021.crt.
const CA_FILE = path.join(ROOT, 'supabase', 'prod-ca-2021.crt');
const haveCA = fs.existsSync(CA_FILE);

// Never echo the DSN, the user or the password. Host + database only.
out(`${pad('target', 26)}${cfg.host}:${cfg.port}/${cfg.database}`);
out(`${pad('tls', 26)}verify-full (rejectUnauthorized: true)`);
out(`${pad('trust store', 26)}${haveCA ? 'pinned: supabase/prod-ca-2021.crt' : 'system roots only'}`);
out('');

const client = new pg.Client({
  ...cfg,
  ssl: haveCA
    ? { rejectUnauthorized: true, ca: fs.readFileSync(CA_FILE, 'utf8') }
    : { rejectUnauthorized: true },
  connectionTimeoutMillis: 20000,
  statement_timeout: 60000,
  application_name: 'alder-apply-migrations',
});

/* ---------- connect ---------- */
const CERT_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

try {
  await client.connect();
} catch (e) {
  if (CERT_CODES.has(e.code) || /certificate/i.test(e.message || '')) {
    fail(`TLS certificate did not verify: ${e.code || e.message}`);
    out('');
    out('  This is expected against the Supabase pooler. Its chain is anchored at');
    out('  "Supabase Root 2021 CA", a private root that no public trust store carries:');
    out('');
    out('    *.pooler.supabase.com  <- Supabase Intermediate 2021 CA  <- Supabase Root 2021 CA');
    out('');
    out('  I will not turn verification off. Pin the root instead:');
    out('  1. Supabase dashboard -> Project Settings -> Database -> SSL Configuration');
    out('  2. Download certificate');
    out('  3. Save it as supabase/prod-ca-2021.crt in this repo');
    out('  4. npm run db:apply again');
    out('');
    out('  Verification stays rejectUnauthorized: true the whole time; step 3 only adds');
    out('  the one root this host actually chains to.');
    process.exit(1);
  }
  fail(`could not connect: ${e.code || ''} ${e.message || e}`);
  process.exit(1);
}

out(`${pad('connected', 26)}yes`);
out('');

/* ---------- guard ---------- */
if (ONLY) {
  out(`${pad('mode', 26)}--only ${ONLY}`);
  out(`${pad('guard', 26)}skipped (later migration on an installed database)`);
} else {
  try {
    const { rows } = await client.query(`select to_regclass('public.businesses') is not null as present`);
    if (rows[0].present) {
      out('FAIL  already applied, aborting');
      out('      public.businesses exists, so this database is past 0001. Nothing was touched.');
      await client.end();
      process.exit(1);
    }
    out(`${pad('guard', 26)}public.businesses absent — proceeding`);
  } catch (e) {
    fail(`guard query failed: ${e.message}`);
    await client.end();
    process.exit(1);
  }
}

/* Show the constraint this migration is about to change, when relevant. */
const constraintSql = `select pg_get_constraintdef(oid) as def from pg_constraint
  where conrelid = 'public.lead_events'::regclass and conname = 'lead_events_kind_check'`;
const showConstraint = async (label) => {
  if (!ONLY || !ONLY.includes('0004')) return;
  const { rows } = await client.query(constraintSql);
  out(`${pad(label, 26)}${rows.length ? rows[0].def : '(missing)'}`);
};
await showConstraint('constraint before');
out('');

/* ---------- apply ---------- */
for (const rel of FILES) {
  const abs = path.join(ROOT, rel);
  const name = path.basename(rel);
  if (!fs.existsSync(abs)) {
    out(`${pad(name, 34)}FAIL  file not found`);
    fail(`${rel} is missing.`);
    break;
  }
  const sql = fs.readFileSync(abs, 'utf8');
  try {
    await client.query('begin');
    await client.query(sql);
    await client.query('commit');
    out(`${pad(name, 34)}OK`);
  } catch (e) {
    try {
      await client.query('rollback');
    } catch {}
    out(`${pad(name, 34)}FAIL  rolled back`);
    out('');
    out('  exact error');
    out('  -----------');
    for (const k of ['severity', 'code', 'message', 'detail', 'hint', 'position', 'where']) {
      if (e[k] !== undefined) out(`  ${pad(k, 10)}${String(e[k]).replace(/\s+/g, ' ').trim()}`);
    }
    out('');
    fail(`${name} failed. Earlier files stay applied; this one was rolled back. Nothing after it ran.`);
    break;
  }
}

/* ---------- post-checks ---------- */
if (!failed) {
  await showConstraint('constraint after');
  out('');
  out('--- grants held by anon / authenticated (must be empty) ---');
  try {
    const { rows } = await client.query(`
      select grantee, table_schema, table_name, privilege_type
      from information_schema.role_table_grants
      where grantee in ('anon','authenticated') and table_schema in ('public','private')
      order by 1,2,3,4`);
    if (rows.length === 0) {
      out('(none)');
    } else {
      for (const r of rows) out(`${r.grantee}  ${r.table_schema}.${r.table_name}  ${r.privilege_type}`);
      out('');
      fail(`${rows.length} grant(s) above are still held by anon/authenticated.`);
    }
  } catch (e) {
    fail(`grant check failed: ${e.message}`);
  }

  // Independent sweep: role_table_grants only shows grants where the grantor or grantee
  // is a currently-enabled role, so it can under-report. has_table_privilege cannot.
  out('');
  out('--- independent sweep: has_table_privilege(anon|authenticated) ---');
  try {
    const { rows } = await client.query(`
      select n.nspname as schema, c.relname as name,
             has_table_privilege('anon', c.oid, 'SELECT')       as anon_sel,
             has_table_privilege('anon', c.oid, 'INSERT')       as anon_ins,
             has_table_privilege('authenticated', c.oid, 'SELECT') as auth_sel,
             has_table_privilege('authenticated', c.oid, 'INSERT') as auth_ins
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public','private') and c.relkind in ('r','v','m','p','f')
      order by 1,2`);
    const leaks = rows.filter((r) => r.anon_sel || r.anon_ins || r.auth_sel || r.auth_ins);
    out(`${pad('objects checked', 26)}${rows.length}`);
    out(`${pad('objects leaking', 26)}${leaks.length}`);
    if (leaks.length) {
      for (const r of leaks) out(`  ${r.schema}.${r.name}  anon(sel=${r.anon_sel},ins=${r.anon_ins})  auth(sel=${r.auth_sel},ins=${r.auth_ins})`);
      fail('the independent sweep found reachable objects the information_schema query did not.');
    }
    const { rows: sch } = await client.query(`
      select has_schema_privilege('anon','private','USAGE') as anon_usage,
             has_schema_privilege('authenticated','private','USAGE') as auth_usage`);
    out(`${pad('anon usage on private', 26)}${sch[0].anon_usage}`);
    out(`${pad('authenticated usage', 26)}${sch[0].auth_usage}`);
    if (sch[0].anon_usage || sch[0].auth_usage) fail('anon or authenticated still holds USAGE on the private schema.');
  } catch (e) {
    fail(`sweep failed: ${e.message}`);
  }

  out('');
  out('--- state ---');
  try {
    const { rows } = await client.query('select count(*)::int as n from public.businesses');
    const ok = rows[0].n === 2;
    out(`${pad('public.businesses rows', 26)}${rows[0].n}  (expected 2)  ${ok ? 'OK' : 'MISMATCH'}`);
    if (!ok) fail(`public.businesses has ${rows[0].n} rows, expected 2.`);
  } catch (e) {
    fail(`count failed: ${e.message}`);
  }

  try {
    const { rows } = await client.query(`
      select table_schema, table_name, table_type
      from information_schema.tables
      where table_schema in ('public','private')
      order by table_schema, table_type, table_name`);
    for (const s of ['public', 'private']) {
      const list = rows.filter((r) => r.table_schema === s);
      out('');
      out(`${s}  (${list.length})`);
      for (const r of list) out(`  ${pad(r.table_name, 24)}${r.table_type === 'VIEW' ? 'view' : 'table'}`);
    }
  } catch (e) {
    fail(`table list failed: ${e.message}`);
  }
}

await client.end();
out('');
out(failed ? 'RESULT  FAIL' : 'RESULT  OK');
process.exit(failed ? 1 : 0);
