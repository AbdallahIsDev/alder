#!/usr/bin/env node
// tests/run.mjs — starts the fake outbound servers and a vercel dev server, then runs suites.
//
//   node tests/run.mjs tests/db-wall.test.mjs tests/lead-api.test.mjs
//
// Refuses to start unless both *_API_BASE overrides are loopback and neither name is
// present in .env or .env.local (a file value would shadow the override). Writes the
// .test-mode marker so lib/tg.js and lib/mail.js refuse real outbound calls even if
// the env is shadowed anyway. Always cleans up, including on failure.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startFakes } from './fakes.mjs';
import { isLoopback } from '../lib/outbound.js';
import { createClient } from '@supabase/supabase-js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = path.join(ROOT, '.test-mode');
const LOG = path.join(ROOT, '_debug', 'vercel-dev.log');
const API = 'http://localhost:3000/api/lead';
const SUITES = process.argv.slice(2);

const out = (s) => process.stdout.write(s + '\n');
const FORBIDDEN = ['TELEGRAM_API_BASE', 'RESEND_API_BASE'];

function envNames(file) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return [];
  const names = [];
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = /^\s*([A-Za-z0-9_]+)\s*=/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

let fakes = null;
let dev = null;
let canaryKey = null;

async function cleanup(svc) {
  if (canaryKey && svc) {
    try { await svc.from('leads').delete().eq('idempotency_key', canaryKey); } catch {}
  }
  if (dev) {
    try { dev.kill('SIGTERM'); } catch {}
    dev = null;
  }
  if (fs.existsSync(MARKER)) { try { fs.unlinkSync(MARKER); } catch {} }
  if (fakes) { try { await fakes.stop(); } catch {} fakes = null; }
}

function fail(msg) {
  out('FAIL  runner  ' + msg);
  process.exitCode = 1;
}

/* ---------- env / values ---------- */
const dotenv = {};
for (const f of ['.env', '.env.local']) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) dotenv[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const svc = createClient(dotenv.SUPABASE_URL, dotenv.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

try {
  /* ---------- refusals ---------- */
  for (const f of ['.env', '.env.local']) {
    const found = envNames(f).filter((n) => FORBIDDEN.includes(n));
    if (found.length) throw new Error(`${f} defines ${found.join(', ')} — it would shadow the loopback override. Remove it.`);
  }

  // Refuse to "reuse" a stale dev server: its env would not point at our fakes.
  try {
    const probe = await fetch(API, { method: 'GET', signal: AbortSignal.timeout(1200) });
    throw new Error(`port 3000 is already answering (${probe.status}) — a stale vercel dev is running. Stop it first.`);
  } catch (e) {
    if (e.message && e.message.startsWith('port 3000')) throw e;
  }

  fakes = await startFakes();
  const bases = { TELEGRAM_API_BASE: fakes.tg.url, RESEND_API_BASE: fakes.resend.url };
  for (const [k, v] of Object.entries(bases)) {
    if (!isLoopback(v)) throw new Error(`${k} is not loopback: ${v}`);
  }
  out(`runner  fakes: telegram ${fakes.tg.url}  resend ${fakes.resend.url}`);

  fs.writeFileSync(MARKER, 'tests/run.mjs active — lib/tg.js and lib/mail.js must refuse real sends\n');

  /* ---------- dev server ---------- */
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  const logFd = fs.openSync(LOG, 'w');
  // Pinned 48.12.1: 65.x needs Windows Developer Mode (symlink EPERM without it).
  dev = spawn('npx', ['vercel@48.12.1', 'dev', '--listen', '3000'], {
    cwd: ROOT,
    env: { ...process.env, ...bases, VERCEL_ENV: 'development' },
    shell: true,
    stdio: ['ignore', logFd, logFd],
  });

  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(API, { method: 'GET', signal: AbortSignal.timeout(1500) });
      if (r.status === 405) { ready = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ready) throw new Error('vercel dev did not answer on port 3000 within 60 s');
  out('runner  vercel dev ready');

  /* ---------- canary ---------- */
  await fakes.tg.reset();
  canaryKey = 'canary-' + Math.random().toString(36).slice(2, 12);
  const payload = {
    service: 'repair', home: 'house', timing: 'asap', age: 'Not sure', zip: '50265',
    phone: '5155550100', name: 'Canary User', email: 'canary@example.com', notes: '',
    claim: false, website: '', elapsed: 5000, slug: 'alder-demo', idempotencyKey: canaryKey,
  };
  const r = await fetch(API, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-real-ip': '198.51.100.250' },
    body: JSON.stringify(payload),
  });
  const tgReqs = await fakes.tg.requests();
  out(`runner  canary: POST ${r.status}, fake telegram requests = ${tgReqs.length}`);
  if (r.status !== 200 || tgReqs.length !== 1) {
    throw new Error(`canary failed: the fake Telegram server received ${tgReqs.length} requests. `
      + 'The loopback override did not reach the function. Aborting before any real send.');
  }
  await svc.from('leads').delete().eq('idempotency_key', canaryKey);
  canaryKey = null;
  await fakes.tg.reset();

  /* ---------- suites ---------- */
  let failed = 0;
  for (const suite of SUITES) {
    out('');
    out(`=== ${suite} ===`);
    const abs = path.join(ROOT, suite);
    if (!fs.existsSync(abs)) { fail(`suite not found: ${suite}`); failed++; continue; }
    const rc = await new Promise((resolve) => {
      const c = spawn(process.execPath, [abs], {
        cwd: ROOT,
        env: {
          ...process.env,
          LEAD_API_URL: API,
          LEAD_API_LOG: LOG,
          FAKE_TG_URL: fakes.tg.url,
          FAKE_RESEND_URL: fakes.resend.url,
          VERCEL_ENV: 'development',
          TELEGRAM_API_BASE: fakes.tg.url,
          RESEND_API_BASE: fakes.resend.url,
        },
        stdio: 'inherit',
      });
      c.on('exit', (code) => resolve(code || 0));
    });
    if (rc !== 0) { failed++; fail(`${suite} exited ${rc}`); }
  }

  out('');
  out(failed ? `RUNNER  ${failed} suite(s) FAILED` : 'RUNNER  all suites passed');
  if (failed) process.exitCode = 1;
} catch (e) {
  fail(e.message || String(e));
} finally {
  await cleanup(svc);
  out('runner  cleanup: dev stopped, .test-mode removed, fakes closed');
}
