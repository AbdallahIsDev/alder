#!/usr/bin/env node
// tests/disk-preflight.test.mjs — Gate D.
// HARNESS: in-process matrix plus one spawn of the runner with a raised floor.
//
// What it proves:
//   D1  the gate: below the floor fails, at or above it passes
//   D2  the floor can be raised by DISK_MIN_BYTES and never lowered
//   D3  the runner refuses before any suite when the floor is not met
//   D4  the runner uses floorFromEnv, so the floor cannot be switched off
//
// Mutation: delete the preflight block from tests/run.mjs and D3 fails — the
// runner runs the suite instead of refusing.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { diskGate, floorFromEnv, DISK_FLOOR_BYTES } from './disk.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let total = 0;
let failed = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(52)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};

const GB = 1024 ** 3;

/* D1 */
{
  const below = diskGate(1.5 * GB, 2 * GB);
  const at = diskGate(2 * GB, 2 * GB);
  const above = diskGate(3 * GB, 2 * GB);
  line(!below.ok && at.ok && above.ok && /1\.5 GB/.test(below.detail),
    'D1', 'below the floor fails, at or above passes', `below=${below.ok} at=${at.ok} above=${above.ok}`);
}

/* D2 */
{
  const raised = floorFromEnv({ DISK_MIN_BYTES: String(50 * GB) });
  const lowered = floorFromEnv({ DISK_MIN_BYTES: '1' });
  const junk = floorFromEnv({ DISK_MIN_BYTES: 'lots' });
  line(raised === 50 * GB && lowered === DISK_FLOOR_BYTES && junk === DISK_FLOOR_BYTES,
    'D2', 'the floor can be raised, never lowered',
    `raised=${raised / GB}GB lowered=${lowered / GB}GB`);
}

/* D3: one petabyte floor, so the real disk cannot satisfy it. */
{
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'run.mjs'), 'tests/vercel-config.test.mjs'], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, TEST_ENV: '1', DISK_MIN_BYTES: String(1024 ** 5) },
  });
  const out = String(r.stdout || '');
  const refused = r.status === 1 && /free space is .* GB, under the .* GB minimum/.test(out);
  const ran = /^PASS/m.test(out);
  line(refused && !ran, 'D3', 'the runner refuses before any suite', `exit=${r.status} refused=${refused} ran=${ran}`);
}

/* D4: the floor comes from floorFromEnv, not a literal. */
{
  const src = fs.readFileSync(path.join(ROOT, 'tests', 'run.mjs'), 'utf8');
  const uses = /const floor = floorFromEnv\(\)/.test(src) && /diskGate\(free, floor\)/.test(src);
  line(uses, 'D4', 'the runner uses the shared floor', `uses=${uses}`);
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
