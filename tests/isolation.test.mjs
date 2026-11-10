#!/usr/bin/env node
// tests/isolation.test.mjs — Gate I.
// HARNESS: starts one `vercel dev` on port 3103 from a fixture project. No database.
//
// What it proves:
//   I1  a sentinel .env in the source directory does NOT reach the function when the
//       server runs from a dev root, and the pinned value does
//   I2  the dev root has no .env of its own
//   I3  removing the dev root does not follow the junctions into api/ (the source
//       file and its .env are still there afterwards)
//
// WHY. `vercel dev` gives .env in its project directory precedence over the
// environment it was started with. Measured 2026-11-09 with 48.12.1: a TEST_ENV=1
// run wrote its canary lead into the production database. The dev root is the fix.
//
// Mutation: make createDevRoot return the source directory (the old behaviour) and
// I1 fails — the function reports the sentinel.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createDevRoot, removeDevRoot } from './dev-root.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3103;
const SENTINEL = 'https://sentinel.invalid';
const PINNED = 'https://pinned.invalid';

let total = 0;
let failed = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(52)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};

const source = path.join(ROOT, '_debug', 'iso-source');
const devRoot = path.join(ROOT, '_debug', 'iso-root');
let child = null;

function killTree(c) {
  if (!c || c.pid == null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true });
  else { try { c.kill('SIGTERM'); } catch {} }
}

function buildSource() {
  fs.rmSync(source, { recursive: true, force: true });
  fs.mkdirSync(path.join(source, 'api'), { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'iso-fixture', private: true, type: 'module' }) + '\n');
  fs.writeFileSync(path.join(source, 'vercel.json'), '{}\n');
  fs.writeFileSync(path.join(source, 'api', 'env.js'),
    'export default function handler(req, res) {\n'
    + '  res.status(200).json({ u: process.env.SUPABASE_URL || "", m: process.env.MARKER || "" });\n'
    + '}\n');
  /* The sentinel is what a real repo's .env looks like to the function: a value
     that must never win. */
  fs.writeFileSync(path.join(source, '.env'), `SUPABASE_URL=${SENTINEL}\nMARKER=sentinel\n`);
  /* Reuse the real project link so `vercel dev` does not create a project on the
     account just to start a test server. */
  const link = path.join(ROOT, '.vercel', 'project.json');
  if (fs.existsSync(link)) {
    fs.mkdirSync(path.join(source, '.vercel'), { recursive: true });
    fs.copyFileSync(link, path.join(source, '.vercel', 'project.json'));
  }
}

async function waitFor() {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${PORT}/api/env`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

try {
  buildSource();
  const root = createDevRoot({ sourceRoot: source, name: 'iso-root' });
  const hasEnv = fs.existsSync(path.join(root, '.env')) || fs.existsSync(path.join(root, '.env.local'));

  child = spawn('npx', ['vercel@48.12.1', 'dev', '.', '--listen', String(PORT), '--yes'], {
    cwd: root,
    env: { ...process.env, SUPABASE_URL: PINNED, MARKER: 'pinned', VERCEL_ENV: 'development' },
    shell: true,
    stdio: 'ignore',
  });

  const body = await waitFor();
  line(!!body && body.u === PINNED && body.m === 'pinned', 'I1',
    'function sees the pinned value, not the source .env',
    body ? `u=${body.u === PINNED ? 'pinned' : body.u === SENTINEL ? 'SENTINEL' : 'other'} m=${body.m}` : 'no response');

  line(!hasEnv, 'I2', 'the dev root carries no .env or .env.local', `has=${hasEnv}`);

  killTree(child);
  child = null;
  removeDevRoot(root);
  const sourceIntact = fs.existsSync(path.join(source, 'api', 'env.js'))
    && fs.existsSync(path.join(source, '.env'));
  line(sourceIntact && !fs.existsSync(root), 'I3',
    'removing the dev root leaves the source untouched',
    `api=${fs.existsSync(path.join(source, 'api', 'env.js'))} env=${fs.existsSync(path.join(source, '.env'))} rootGone=${!fs.existsSync(root)}`);
} catch (e) {
  line(false, 'I0', 'isolation harness ran', e && e.message ? e.message.slice(0, 80) : 'threw');
} finally {
  if (child) killTree(child);
  removeDevRoot(path.join(ROOT, '_debug', 'iso-root'));
  fs.rmSync(path.join(ROOT, '_debug', 'iso-source'), { recursive: true, force: true });
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
