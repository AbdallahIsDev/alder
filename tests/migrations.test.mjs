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
  const numeric = APPLY_ORDER.map((f) => /(\d{4})_/.exec(path.basename(f))).filter(Boolean).map((m) => Number(m[1]));
  const ascending = numeric.every((n, i) => i === 0 || n > numeric[i - 1]);
  const ok = i1 === 0 && iseed === 1 && i2 > iseed && i3 > i2 && i4 > i3 && ascending;
  line(ok, 'M3', 'apply order: 0001, seed, 0002, 0003, 0004',
    `i=${i1}/${iseed}/${i2}/${i3}/${i4} ascending=${ascending}`);
}

/* M4: the script consumes the shared list instead of keeping its own copy. */
{
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'apply-migrations.mjs'), 'utf8');
  const importsList = /from\s+'\.\.\/lib\/migrations\.js'/.test(src) && /APPLY_ORDER/.test(src);
  const noLiteral = !/const\s+ALL_FILES\s*=\s*\[/.test(src);
  line(importsList && noLiteral, 'M4', 'apply-migrations reads APPLY_ORDER, no inline array',
    `imports=${importsList} noLiteral=${noLiteral}`);
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
