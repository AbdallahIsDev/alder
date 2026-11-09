#!/usr/bin/env node
// tests/build-cleanup.test.mjs — Gate C.
// HARNESS: creates two folders under _debug, runs one fast suite through the
// runner, and checks what the runner left behind.
//
// What it proves:
//   C1  a finished run removes _debug/build-test
//   C2  it removes that path only — a sibling folder is untouched
//   C3  the run itself still passes
//
// WHY. P15 builds into _debug/build-test (about 120 MB). Leaving it behind costs
// disk on every run and made "stray folder" checks noisy.
//
// Mutation: delete the rmSync line from cleanup() and C1 fails.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, '_debug', 'build-test');
const SIBLING = path.join(ROOT, '_debug', 'build-test-sibling');

let total = 0;
let failed = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(52)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};

const seed = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'marker.txt'), 'x\n');
};

try {
  seed(TARGET);
  seed(SIBLING);

  const r = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'run.mjs'), 'tests/vercel-config.test.mjs'], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, TEST_ENV: '1' },
  });
  const out = String(r.stdout || '');

  const why = (String(r.stdout || '').split('\n').filter((l) => /^FAIL/.test(l))[0] || '').slice(0, 80);
  line(r.status === 0, 'C3', 'the nested run still passes', `exit=${r.status}${why ? ' ' + why : ''}`);
  line(!fs.existsSync(TARGET), 'C1', 'the run removed _debug/build-test', `exists=${fs.existsSync(TARGET)}`);
  line(fs.existsSync(path.join(SIBLING, 'marker.txt')), 'C2', 'a sibling folder is untouched',
    `exists=${fs.existsSync(path.join(SIBLING, 'marker.txt'))}`);
} catch (e) {
  line(false, 'C0', 'cleanup harness ran', e && e.message ? e.message.slice(0, 80) : 'threw');
} finally {
  try { fs.rmSync(TARGET, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(SIBLING, { recursive: true, force: true }); } catch {}
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
