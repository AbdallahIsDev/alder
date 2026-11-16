#!/usr/bin/env node
// tests/migrations.test.mjs — Gate M.
// HARNESS: in-process, no network, no database. Reads files only.
//
// What it proves:
//   M1  Every .sql under supabase/migrations/ appears in APPLY_ORDER. A migration
//       that exists but is not listed is a silent schema gap on a fresh database —
//       this is the check that would have caught 0004_lead_event_kinds.sql.
//   M2  Every APPLY_ORDER entry exists on disk (no stale path).
//   M3  The order is sane: 0001, then seed, then the later migrations.
//   M4  scripts/apply-migrations.mjs reads the list from lib/migrations.js and does
//       not re-inline its own array (which would let the two drift apart again).
//   M7  0006 (billing) is three guarded ADD COLUMNs on businesses and nothing
//       else, so it is safe on a database that already has it, and paid_until
//       stays nullable with no default (NULL = not billed).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPLY_ORDER, migrationFiles, unlistedMigrations, missingApplyFiles } from '../lib/migrations.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0, total = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(52)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};

/* M1: nothing on disk is left out of the apply list. */
{
  const unlisted = unlistedMigrations(ROOT);
  const onDisk = migrationFiles(ROOT);
  line(unlisted.length === 0 && onDisk.length > 0, 'M1',
    'every supabase/migrations/*.sql is in APPLY_ORDER',
    unlisted.length ? `unlisted: ${unlisted.join(', ')}` : `${onDisk.length} files, all listed`);
}

/* M2: nothing in the list is a dead path. */
{
  const missing = missingApplyFiles(ROOT);
  line(missing.length === 0, 'M2', 'every APPLY_ORDER entry exists', missing.length ? `missing: ${missing.join(', ')}` : `${APPLY_ORDER.length} entries ok`);
}

/* M3: order. 0001 first, seed second, then the numbered later migrations ascending. */
{
  const idx = (needle) => APPLY_ORDER.findIndex((f) => f.includes(needle));
  const i1 = idx('0001_init');
  const iseed = idx('seed.sql');
  const i2 = idx('0002_default');
  const i3 = idx('0003_service_role');
  const i4 = idx('0004_lead_event');
  const i5 = idx('0005_business_site_host');
  const i6 = idx('0006_business_billing');
  const numeric = APPLY_ORDER.map((f) => /(\d{4})_/.exec(path.basename(f))).filter(Boolean).map((m) => Number(m[1]));
  const ascending = numeric.every((n, i) => i === 0 || n > numeric[i - 1]);
  const ok = i1 === 0 && iseed === 1 && i2 > iseed && i3 > i2 && i4 > i3 && i5 > i4 && i6 > i5
    && i6 === APPLY_ORDER.length - 1 && ascending;
  line(ok, 'M3', 'apply order: 0001, seed, 0002, 0003, 0004, 0005, 0006',
    `i=${i1}/${iseed}/${i2}/${i3}/${i4}/${i5}/${i6} ascending=${ascending}`);
}

/* M7: 0006 (billing) is additive and safe to run twice: one ALTER TABLE on
   businesses, three ADD COLUMN IF NOT EXISTS, and nothing else: no drop, no
   update, no backfill, no NOT NULL without a default. paid_until must stay
   nullable with no default, because NULL is what "not billed" means and what
   every existing row must start as. */
{
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '0006_business_billing.sql'), 'utf8')
    .split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n').replace(/\s+/g, ' ').trim().toLowerCase();
  const statements = sql.split(';').map((x) => x.trim()).filter(Boolean);
  const want = 'alter table public.businesses'
    + ' add column if not exists paid_until timestamptz,'
    + ' add column if not exists billing_warning_stage smallint not null default 0,'
    + ' add column if not exists suspended_for_billing boolean not null default false';
  const adds = (sql.match(/add column/g) || []).length;
  const guarded = (sql.match(/add column if not exists/g) || []).length;
  const ok = statements.length === 1 && statements[0] === want && adds === 3 && guarded === 3
    && !/\b(drop|delete|update|truncate|insert|rename|create|grant|revoke)\b/.test(sql);
  line(ok, 'M7', '0006 billing: three guarded columns on businesses, nothing else',
    `statements=${statements.length} adds=${adds} guarded=${guarded}`);
}

/* M4: the script consumes the shared list instead of keeping its own copy. */
{
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'apply-migrations.mjs'), 'utf8');
  const importsList = /from\s+'\.\.\/lib\/migrations\.js'/.test(src) && /APPLY_ORDER/.test(src);
  const noLiteral = !/const\s+ALL_FILES\s*=\s*\[/.test(src);
  line(importsList && noLiteral, 'M4', 'apply-migrations reads APPLY_ORDER, no inline array',
    `imports=${importsList} noLiteral=${noLiteral}`);
}

/* M5: the SQL-editor copy of the seed is the same seed. Two files that must
   agree are one file with a copy — this is the check that fails when they drift.
   supabase/seed.sql is the single source. */
const SEED_FIELDS = ['name', 'owner_email', 'google_review_url', 'timezone', 'status'];
const parseSqlSeed = (text) => {
  const rows = {};
  const re = /\('([^']+)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)'\)/g;
  let m;
  while ((m = re.exec(String(text)))) {
    rows[m[1]] = { name: m[2], owner_email: m[3], google_review_url: m[4], timezone: m[5], status: m[6] };
  }
  return rows;
};
{
  const canonical = parseSqlSeed(fs.readFileSync(path.join(ROOT, 'supabase', 'seed.sql'), 'utf8'));
  const copy = parseSqlSeed(fs.readFileSync(path.join(ROOT, '_debug', 'test-project', 'seed.sql'), 'utf8'));
  const slugs = Object.keys(canonical);
  const differing = [];
  for (const slug of slugs) {
    if (!copy[slug]) { differing.push(slug + ':missing'); continue; }
    for (const f of SEED_FIELDS) {
      if (String(copy[slug][f]) !== String(canonical[slug][f])) differing.push(`${slug}.${f}`);
    }
  }
  line(slugs.length === 2 && differing.length === 0, 'M5',
    'test-project seed matches supabase/seed.sql',
    differing.length ? `differing: ${differing.join(',')}` : `${slugs.length} rows, ${SEED_FIELDS.length} fields each`);
}

/* M6: the runner's --seed-check expectation is the same seed, so the check that
   guards a production run cannot demand values the seed no longer has. */
{
  const canonical = parseSqlSeed(fs.readFileSync(path.join(ROOT, 'supabase', 'seed.sql'), 'utf8'))['alder-demo'];
  const src = fs.readFileSync(path.join(ROOT, 'tests', 'run.mjs'), 'utf8');
  const block = /const seed = \{([\s\S]*?)\n  \};/.exec(src);
  const runner = {};
  if (block) {
    const re = /(\w+):\s*'([^']*)'/g;
    let m;
    while ((m = re.exec(block[1]))) runner[m[1]] = m[2];
  }
  const differing = SEED_FIELDS.filter((f) => String(runner[f]) !== String(canonical[f]));
  line(!!canonical && !!block && differing.length === 0, 'M6',
    'runner --seed-check expectation matches supabase/seed.sql',
    differing.length ? `differing: ${differing.join(',')}` : SEED_FIELDS.map((f) => runner[f]).join('|').slice(0, 60));
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
