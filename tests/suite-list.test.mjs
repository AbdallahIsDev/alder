#!/usr/bin/env node
// tests/suite-list.test.mjs — Gate N.
// HARNESS: reads tests/run.mjs. No network, no database.
//
// What it proves:
//   N1  no suite path appears twice in DEFAULT_SUITES — a duplicate runs that
//       suite twice per full run and inflates the assertion count
//   N2  every listed file exists
//
// WHY. A duplicated edit registered build-cleanup and disk-preflight twice; two
// full runs reported 430 assertions instead of 426 and nobody noticed.
//
// Mutation: add a second entry for any suite and N1 fails.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'tests', 'run.mjs'), 'utf8');

let total = 0;
let failed = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(52)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};

const start = SRC.indexOf('const DEFAULT_SUITES = [');
const end = SRC.indexOf('];', start);
const block = start >= 0 && end > start ? SRC.slice(start, end) : '';
const files = [...block.matchAll(/file: '([^']+)'/g)].map((m) => m[1]);
const dupes = files.filter((f, i) => files.indexOf(f) !== i);

line(files.length > 0 && dupes.length === 0, 'N1', 'no suite is listed twice',
  dupes.length ? `dupes: ${[...new Set(dupes)].join(',')}` : `${files.length} suites`);

const missing = files.filter((f) => !fs.existsSync(path.join(ROOT, f)));
line(missing.length === 0, 'N2', 'every listed suite file exists',
  missing.length ? `missing: ${missing.join(',')}` : `${files.length} files`);

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
