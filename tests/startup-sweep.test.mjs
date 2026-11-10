#!/usr/bin/env node
// tests/startup-sweep.test.mjs — Gate T.
// HARNESS: plants _debug/build-test, then runs one probe suite through the runner.
//
// What it proves:
//   T1  the runner clears a stale _debug/build-test BEFORE the first suite, not
//       only in its end-of-run cleanup
//   T2  the probe suite passes, which is the only way to observe the start state
//       (after the run the folder is gone either way)
//
// WHY. A SIGKILL or a closed terminal never reaches cleanup, so P15's build
// output survives into the next run.
//
// Mutation: delete the start sweep from tests/run.mjs and the probe sees the
// planted folder, fails, and T1 fails.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, '_debug', 'build-test');

let total = 0;
let failed = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(52)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};

try {
  fs.mkdirSync(TARGET, { recursive: true });
  fs.writeFileSync(path.join(TARGET, 'marker.txt'), 'stale\n');

  const r = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'run.mjs'), 'tests/build-test-probe.test.mjs'], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, TEST_ENV: '1' },
  });
  const out = String(r.stdout || '');
  const probeSawStale = /FAIL {2}S1/.test(out);

  line(r.status === 0 && !probeSawStale, 'T1', 'a stale build-test is gone before the first suite',
    `exit=${r.status} sawStale=${probeSawStale}`);
  line(!fs.existsSync(TARGET), 'T2', 'the folder is gone after the run too', `exists=${fs.existsSync(TARGET)}`);
} catch (e) {
  line(false, 'T0', 'sweep harness ran', e && e.message ? e.message.slice(0, 80) : 'threw');
} finally {
  try { fs.rmSync(TARGET, { recursive: true, force: true }); } catch {}
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
