#!/usr/bin/env node
// tests/port-guard.test.mjs — Gate P. STANDALONE ONLY.
//
// Not in DEFAULT_SUITES on purpose: it binds port 3000, and during a full run the
// runner itself is listening there. Run it by hand:
//   node tests/port-guard.test.mjs
//
// What it proves:
//   P1  with an HTTP suite selected and port 3000 busy, the runner refuses with
//       the existing names-only message and starts nothing
//   P2  with only DB suites it does not refuse — the port is irrelevant to them
//
// The child is spawned asynchronously: spawnSync would block this process's event
// loop, so the listener could never answer the runner's probe and the guard would
// look broken when it is not.
//
// Mutation: force NEEDS_DEV to false in tests/run.mjs and P1 fails (the runner
// tries to start a server on a busy port instead of refusing).

import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let total = 0;
let failed = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(52)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};

function run(suite, timeoutMs) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'tests', 'run.mjs'), suite], {
      cwd: ROOT, env: { ...process.env, TEST_ENV: '1' },
    });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch {} }, timeoutMs);
    c.on('exit', (code) => { clearTimeout(t); resolve({ status: code, out }); });
  });
}

const listener = http.createServer((req, res) => { res.writeHead(405); res.end(); });

try {
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(3000, '127.0.0.1', resolve);
  });

  /* P1: an HTTP suite must be refused before it starts. 30 s is enough for the
     refusal and far too short for a run, so a non-refusal shows up as a kill. */
  const p1 = await run('tests/lead-api.test.mjs', 30000);
  const refused = /port 3000 is already answering/.test(p1.out) && !/^PASS/m.test(p1.out);
  line(p1.status === 1 && refused, 'P1', 'an HTTP run refuses a busy port',
    `exit=${p1.status} refused=${refused}`);

  /* P2: a DB-only set never touches the port, so it proceeds. */
  const p2 = await run('tests/vercel-config.test.mjs', 60000);
  line(p2.status === 0, 'P2', 'a DB-only run proceeds with the port busy', `exit=${p2.status}`);
} catch (e) {
  line(false, 'P0', 'port harness ran', `${e.code || e.message}`.slice(0, 80));
} finally {
  listener.close();
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
