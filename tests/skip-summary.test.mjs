#!/usr/bin/env node
// tests/skip-summary.test.mjs — Gate K.
// HARNESS: in-process plus one spawn of delete-scripts in production mode.
//
// What it proves:
//   K1  countSkips counts SKIP lines and nothing else
//   K2  skipLine emits the exact shape the counter looks for
//   K3  delete-scripts, run without TEST_ENV=1, prints four SKIP lines (X1-X4)
//       and still runs X5 — the real production path, no database touched
//   K4  the runner prints the count in its summary
//
// Mutation: make countSkips count every line and K1 fails.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { countSkips, skipLine } from './skip-count.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let total = 0;
let failed = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(52)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};

/* K1 */
{
  const text = [
    'PASS  X5  sweep counts canary- rows as debris',
    'SKIP  X1  no .env.test',
    'SKIP  X2  no .env.test',
    '',
    'FAIL  Y1  something',
    'SKIP  X3  no .env.test',
    'SKIP  X4  no .env.test',
  ].join('\n');
  line(countSkips(text) === 4, 'K1', 'counts SKIP lines only', `n=${countSkips(text)}`);
}

/* K2 */
{
  const l = skipLine('X1', 'reason');
  line(l.startsWith('SKIP') && l.includes('X1') && countSkips(l) === 1,
    'K2', 'skipLine emits a countable line', JSON.stringify(l.slice(0, 40)));
}

/* K3: the production path, no database. */
{
  const env = { ...process.env };
  delete env.TEST_ENV;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'delete-scripts.test.mjs')], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000, env,
  });
  const out = String(r.stdout || '');
  const skips = countSkips(out);
  const x5 = /^PASS\s+X5\b/m.test(out);
  line(r.status === 0 && skips === 4 && x5, 'K3',
    'delete-scripts skips X1-X4 and still runs X5', `exit=${r.status} skips=${skips} x5=${x5}`);
}

/* K4: the runner has to print what it counted. */
{
  const src = fs.readFileSync(path.join(ROOT, 'tests', 'run.mjs'), 'utf8');
  const imports = /import \{ countSkips \} from '\.\/skip-count\.mjs'/.test(src);
  const counts = /skips \+= countSkips\(/.test(src);
  const prints = /runner {2}skips: \$\{skips\}/.test(src);
  line(imports && counts && prints, 'K4', 'the runner counts and prints skips',
    `import=${imports} count=${counts} print=${prints}`);
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
