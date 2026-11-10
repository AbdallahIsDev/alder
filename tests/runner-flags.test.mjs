#!/usr/bin/env node
// tests/runner-flags.test.mjs — Gate R.
// HARNESS: one spawn per case; the guard cases exit before any suite starts.
//
// What it proves:
//   R1  the gate matrix: TEST_ENV=1 and .env.test and a different project, or no run
//   R2  ALLOW_PROD_TESTS=1 no longer buys anything — the runner refuses
//   R3  --read-production-seed is the read-only production reader
//   R4  --seed-check still works and says it is deprecated
//   R5  the string ALLOW_PROD_TESTS is gone from the runner
//
// Mutation: restore the ALLOW_PROD_TESTS branch and R2 passes the run (exit 0)
// instead of refusing; delete the legacy flag alias and R4 fails.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { suiteRunGate, GATE } from './gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let total = 0;
let failed = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(52)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};

const baseEnv = () => {
  const env = { ...process.env };
  delete env.TEST_ENV;
  delete env.ALLOW_PROD_TESTS;
  return env;
};
const run = (args, env) => spawnSync(process.execPath, [path.join(ROOT, 'tests', 'run.mjs'), ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 60000, env,
});

/* R1: the matrix. */
{
  const cases = [
    [{ testEnv: true, hasEnvTest: true, prodReason: 'ok' }, true, GATE.OK],
    [{ testEnv: false, hasEnvTest: true, prodReason: 'ok' }, false, GATE.NO_TEST_ENV],
    [{ testEnv: true, hasEnvTest: false, prodReason: 'ok' }, false, GATE.NO_ENV_FILE],
    [{ testEnv: true, hasEnvTest: true, prodReason: 'no-url' }, false, GATE.NO_URL],
    [{ testEnv: true, hasEnvTest: true, prodReason: 'same-as-env' }, false, GATE.SAME_AS_ENV],
  ];
  const bad = cases.filter(([input, ok, reason]) => {
    const r = suiteRunGate(input);
    return r.ok !== ok || r.reason !== reason;
  });
  line(bad.length === 0, 'R1', 'the gate allows only a real test project',
    bad.length ? `wrong: ${bad.length}` : `${cases.length} cases`);
}

/* R2: the old escape hatch does nothing. */
{
  const r = run(['tests/vercel-config.test.mjs'], { ...baseEnv(), ALLOW_PROD_TESTS: '1' });
  const out = String(r.stdout || '');
  const refused = r.status === 1 && /refusing to run a suite/.test(out);
  const ran = /^PASS/m.test(out);
  line(refused && !ran, 'R2', 'ALLOW_PROD_TESTS=1 no longer starts a run',
    `exit=${r.status} refused=${refused} ran=${ran}`);
}

/* R3: the new flag reads production and exits. */
{
  const r = run(['--read-production-seed'], baseEnv());
  const out = String(r.stdout || '');
  line(r.status === 0 && /seed-check {2}OK/.test(out), 'R3',
    '--read-production-seed reads and exits 0', `exit=${r.status}`);
}

/* R4: the old name works and warns. */
{
  const r = run(['--seed-check'], baseEnv());
  const out = String(r.stdout || '');
  const dep = /--seed-check is deprecated; use --read-production-seed/.test(out);
  line(r.status === 0 && dep && /seed-check {2}OK/.test(out), 'R4',
    '--seed-check still works, with a deprecation line', `exit=${r.status} dep=${dep}`);
}

/* R5: the override is gone, not just ignored. */
{
  const src = fs.readFileSync(path.join(ROOT, 'tests', 'run.mjs'), 'utf8');
  line(!src.includes('ALLOW_PROD_TESTS'), 'R5', 'the runner never mentions ALLOW_PROD_TESTS',
    `mentions=${src.includes('ALLOW_PROD_TESTS')}`);
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
