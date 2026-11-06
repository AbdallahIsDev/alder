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
// Default when no suites are named on the command line. outbound is LAST on purpose:
// its finally removes the .test-mode marker that the other suites rely on.
/* needsHttp: the suite makes real HTTP calls through `vercel dev` (platform
   behaviour). In-process-only suites skip starting the dev server entirely. */
const DEFAULT_SUITES = [
  { file: 'tests/db-wall.test.mjs', needsHttp: false },
  { file: 'tests/migrations.test.mjs', needsHttp: false },
  { file: 'tests/lead-api.test.mjs', needsHttp: true },
  { file: 'tests/notify.test.mjs', needsHttp: false },
  { file: 'tests/webhook.test.mjs', needsHttp: false },
  { file: 'tests/review.test.mjs', needsHttp: true },
  { file: 'tests/fallback.test.mjs', needsHttp: true },
  { file: 'tests/brand.test.mjs', needsHttp: false },
  { file: 'tests/outbound.test.mjs', needsHttp: false },
];
const cliArgs = process.argv.slice(2);
const RUN_SEED_CHECK = cliArgs.includes('--seed-check');
const suiteFiles = cliArgs.filter((a) => !a.startsWith('--'));
const SUITES_TO_RUN = (suiteFiles.length ? suiteFiles : DEFAULT_SUITES.map((s) => s.file)).map((f) => {
  const known = DEFAULT_SUITES.find((s) => s.file === f);
  return { file: f, needsHttp: known ? known.needsHttp : true };
});
const TIMING_TOTAL = Date.now();
const NEEDS_DEV = SUITES_TO_RUN.some((s) => s.needsHttp);

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

/** Kill the whole dev process tree (on Windows the child outlives the shell otherwise). */
function killTree(child) {
  if (!child || child.pid == null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    try { child.kill('SIGTERM'); } catch {}
  }
}

async function cleanup(svc) {
  if (canaryKey && svc) {
    try { await svc.from('leads').delete().eq('idempotency_key', canaryKey); } catch {}
  }
  if (dev) {
    killTree(dev);
    dev = null;
  }
  if (fs.existsSync(MARKER)) { try { fs.unlinkSync(MARKER); } catch {} }
  if (fakes) { try { await fakes.stop(); } catch {} fakes = null; }
  // Confirm nothing is left listening on port 3000.
  const stillUp = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 4000);
    fetch(API, { method: 'GET', signal: AbortSignal.timeout(1000) })
      .then(() => { clearTimeout(t); resolve(true); })
      .catch(() => { clearTimeout(t); resolve(false); });
  });
  out('runner  port 3000 ' + (stillUp ? 'STILL LISTENING (stale dev)' : 'free'));
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

/* ---------- seed check (quick, read-only; no tests run) ---------- */
if (RUN_SEED_CHECK) {
  const seed = {
    slug: 'alder-demo', name: 'Alder Roofing (demo)',
    owner_email: 'owner@alder-demo.example.com',
    google_review_url: 'https://g.page/r/alder-demo',
    timezone: 'America/Chicago', status: 'demo',
  };
  const { data: row, error } = await svc.from('businesses').select('*').eq('slug', 'alder-demo').maybeSingle();
  if (error) { out('seed-check  FAIL  ' + error.code); process.exit(1); }
  if (!row) { out('seed-check  FAIL  alder-demo row missing'); process.exit(1); }
  const differing = Object.keys(seed).filter((k) => String(row[k] ?? '') !== String(seed[k]));
  const { data: chats } = await svc.from('business_chats').select('id').eq('business_id', row.id);
  const chatsCount = (chats || []).length;
  out(`seed-check  differing-columns: ${differing.length ? differing.join(',') : '(none)'} business_chats-rows: ${chatsCount}`);
  if (differing.length || chatsCount > 0) {
    out('seed-check  FAIL  reset the alder-demo row to seed values and delete its business_chats rows');
    process.exit(1);
  }
  out('seed-check  OK  alder-demo matches seed, no chats bound');
  process.exit(0);
}

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

  // The pinned CLI is required: 65.x needs Windows Developer Mode and gets EPERM
  // creating symlinks. Confirm we got 48.12.1 before spawning anything.
  const verOut = await new Promise((resolve) => {
    const p = spawn('npx', ['vercel@48.12.1', '--version'], { cwd: ROOT, shell: true, windowsHide: true });
    let buf = '';
    p.stdout.on('data', (d) => { buf += d; });
    p.stderr.on('data', (d) => { buf += d; });
    p.on('error', () => resolve(''));
    p.on('close', () => resolve(buf));
  });
  if (!verOut.includes('48.12.1')) {
    throw new Error(`expected vercel CLI 48.12.1, got: ${verOut.trim().slice(0, 120) || '(no output)'}`);
  }
  out('runner  vercel CLI 48.12.1 confirmed');

  // Kill the dev tree on interrupt and on exit, so no stale server survives.
  process.on('SIGINT', async () => { await cleanup(svc); process.exit(130); });
  process.on('exit', () => { if (dev) killTree(dev); });

  fakes = await startFakes();
  const bases = { TELEGRAM_API_BASE: fakes.tg.url, RESEND_API_BASE: fakes.resend.url };
  for (const [k, v] of Object.entries(bases)) {
    if (!isLoopback(v)) throw new Error(`${k} is not loopback: ${v}`);
  }
  out(`runner  fakes: telegram ${fakes.tg.url}  resend ${fakes.resend.url}`);

  fs.writeFileSync(MARKER, 'tests/run.mjs active — lib/tg.js and lib/mail.js must refuse real sends\n');

  /* ---------- dev server (skipped when no selected suite needs HTTP) ---------- */
  if (NEEDS_DEV) {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    const logFd = fs.openSync(LOG, 'w');
    // Pinned 48.12.1: 65.x needs Windows Developer Mode (symlink EPERM without it).
    dev = spawn('npx', ['vercel@48.12.1', 'dev', '--listen', '3000'], {
      cwd: ROOT,
      env: { ...process.env, ...bases, VERCEL_ENV: 'development', OUTBOUND_TIMEOUT_MS: '1000' },
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
  } else {
    out('runner  no selected suite needs HTTP: vercel dev and canary skipped');
  }

  /* ---------- suites ---------- */
  let failed = 0;
  for (const suite of SUITES_TO_RUN) {
    out('');
    out(`=== ${suite.file} ===`);
    const abs = path.join(ROOT, suite.file);
    const suiteStart = Date.now();
    if (!fs.existsSync(abs)) { fail(`suite not found: ${suite.file}`); failed++; continue; }
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
          OUTBOUND_TIMEOUT_MS: '1000',
          TELEGRAM_API_BASE: fakes.tg.url,
          RESEND_API_BASE: fakes.resend.url,
        },
        stdio: 'inherit',
      });
      c.on('exit', (code) => resolve(code || 0));
    });
    out(`runner  ${suite.file} ${((Date.now() - suiteStart) / 1000).toFixed(1)}s`);
    if (rc !== 0) { failed++; fail(`${suite.file} exited ${rc}`); }
  }

  out('');
  out(`runner  total ${((Date.now() - TIMING_TOTAL) / 1000).toFixed(1)}s`);
  out(failed ? `RUNNER  ${failed} suite(s) FAILED` : 'RUNNER  all suites passed');
  if (failed) process.exitCode = 1;
} catch (e) {
  fail(e.message || String(e));
} finally {
  await cleanup(svc);
  out('runner  cleanup: dev stopped, .test-mode removed, fakes closed');
}
