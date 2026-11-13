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
import { loadEnv, isTestEnv, checkNotProduction, readEnvFile, sameSupabaseUrl } from '../lib/env.js';
import { createClient } from '@supabase/supabase-js';
import { ALDER_DEMO, isFixtureLead, fetchAllRows } from './helpers.mjs';
import { FIXTURE_ID_BASE } from './fixture-ids.mjs';
import { createDevRoot, removeDevRoot } from './dev-root.mjs';
import { countSkips } from './skip-count.mjs';
import { clearCanaryLimits, limitLine } from './canary-limits.mjs';
import { suiteRunGate } from './gate.mjs';
import { freeBytes, diskGate, floorFromEnv } from './disk.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = path.join(ROOT, '.test-mode');
const LOG = path.join(ROOT, '_debug', 'vercel-dev.log');
const API = 'http://localhost:3000/api/lead';
// Default when no suites are named on the command line. outbound is LAST on purpose:
// its finally removes the .test-mode marker that the other suites rely on.
/* needsHttp: the suite makes real HTTP calls through `vercel dev` (platform
   behaviour). In-process-only suites skip starting the dev server entirely. */
const DEFAULT_SUITES = [
  { file: 'tests/network-guard.test.mjs', needsHttp: false },
  { file: 'tests/isolation.test.mjs', needsHttp: false },
  { file: 'tests/build-linked-assets.test.mjs', needsHttp: false },
  { file: 'tests/css.test.mjs', needsHttp: false },
  { file: 'tests/client-config.test.mjs', needsHttp: false },
  { file: 'tests/dev-root-removal.test.mjs', needsHttp: false },
  { file: 'tests/build-cleanup.test.mjs', needsHttp: false },
  { file: 'tests/build-test-probe.test.mjs', needsHttp: false },
  { file: 'tests/startup-sweep.test.mjs', needsHttp: false },
  { file: 'tests/canary-limits.test.mjs', needsHttp: false },
  { file: 'tests/suite-list.test.mjs', needsHttp: false },
  { file: 'tests/fixture-safety.test.mjs', needsHttp: false },
  { file: 'tests/housekeeping.test.mjs', needsHttp: false },
  { file: 'tests/bot-text.test.mjs', needsHttp: false },
  { file: 'tests/db-wall.test.mjs', needsHttp: false },
  { file: 'tests/db-wall-guard.test.mjs', needsHttp: false },
  { file: 'tests/migrations.test.mjs', needsHttp: false },
  { file: 'tests/test-env-check.test.mjs', needsHttp: false },
  { file: 'tests/vercel-config.test.mjs', needsHttp: false },
  { file: 'tests/tenant.test.mjs', needsHttp: false },
  { file: 'tests/replay-policy.test.mjs', needsHttp: false },
  { file: 'tests/health.test.mjs', needsHttp: false },
  { file: 'tests/email-layout.test.mjs', needsHttp: false },
  { file: 'tests/digest.test.mjs', needsHttp: false },
  { file: 'tests/recipients.test.mjs', needsHttp: false },
  { file: 'tests/lead-browser.test.mjs', needsHttp: false },
  { file: 'tests/runner-flags.test.mjs', needsHttp: false },
  { file: 'tests/disk-preflight.test.mjs', needsHttp: false },
  { file: 'tests/skip-summary.test.mjs', needsHttp: false },
  { file: 'tests/delete-scripts.test.mjs', needsHttp: false },
  { file: 'tests/lead-api.test.mjs', needsHttp: true },
  { file: 'tests/notify.test.mjs', needsHttp: false },
  { file: 'tests/webhook.test.mjs', needsHttp: false },
  { file: 'tests/review.test.mjs', needsHttp: true },
  { file: 'tests/fallback.test.mjs', needsHttp: true },
  { file: 'tests/brand.test.mjs', needsHttp: false },
  { file: 'tests/outbound.test.mjs', needsHttp: false },
];
const cliArgs = process.argv.slice(2);
const LEGACY_SEED_FLAG = '--seed-check';
const SEED_FLAG = '--read-production-seed';
const KNOWN_FLAGS = new Set([SEED_FLAG, LEGACY_SEED_FLAG]);
const unknownFlags = cliArgs.filter((a) => a.startsWith('--') && !KNOWN_FLAGS.has(a));
if (unknownFlags.length) {
  // Unknown flags used to be dropped silently, so `--timing` looked like it worked.
  console.log(`FAIL  runner  unknown flag(s): ${unknownFlags.join(', ')}`);
  console.log(`      known flags: ${[...KNOWN_FLAGS].join(', ')} — anything else is a typo, not a no-op`);
  process.exit(1);
}
const RUN_SEED_CHECK = cliArgs.includes(SEED_FLAG) || cliArgs.includes(LEGACY_SEED_FLAG);
const SEED_FLAG_DEPRECATED = cliArgs.includes(LEGACY_SEED_FLAG);
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
let devRoot = null;
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

/**
 * Every bound chat id, sorted. Tails are printed, never the full id.
 * The result carries `ok`: an error must not compare equal to another error and
 * let the run pass — a snapshot nobody could take proves nothing.
 */
/**
 * Test-shaped leads and everything hanging off them. A real submission has a
 * UUID key, so a customer arriving mid-run does not move these numbers; a suite
 * that leaks a row does.
 */
async function debrisSnapshot(businessIds) {
  let rows;
  try {
    // Scoped to this deployment's businesses and paged: an unbounded select
    // stops at 1000 rows without saying so, and a global scan would count a
    // fixture in another project.
    rows = await fetchAllRows(() => svc.from('leads')
      .select('id, idempotency_key, email').in('business_id', businessIds));
  } catch (e) {
    return { ok: false, code: e.code || 'no_code', n: 0, events: 0, feedback: 0 };
  }
  // Both signals: the suite key shape AND the reserved fixture email marker.
  // A manual-test- lead the owner submits mid-run has neither.
  const ids = rows.filter(isFixtureLead).map((r) => r.id);
  if (!ids.length) return { ok: true, n: 0, events: 0, feedback: 0 };
  const CHUNK = 80;
  const countIn = async (table, column) => {
    let total = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const { count, error } = await svc.from(table)
        .select(column, { count: 'exact', head: true }).in(column, slice);
      if (error) throw error;
      total += count || 0;
    }
    return total;
  };
  try {
    const [events, feedback] = await Promise.all([
      countIn('lead_events', 'lead_id'),
      countIn('review_feedback', 'lead_id'),
    ]);
    return { ok: true, n: ids.length, events, feedback };
  } catch (e) {
    return { ok: false, code: e.code || 'no_code', n: 0, events: 0, feedback: 0 };
  }
}

/**
 * Live unused bind codes for the real businesses. A suite may mint one to test a
 * bind, but it must delete it by exact code; a leak here is what filled the
 * owner's /invite cap (INVITES_MAX counts live unused rows). The owner must not
 * mint a code while a run is in progress, or this looks like a leak.
 */
async function unusedCodeCount(businessIds) {
  const { count, error } = await svc.from('bind_codes')
    .select('code', { count: 'exact', head: true })
    .in('business_id', businessIds)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString());
  if (error) return { ok: false, code: error.code, n: 0 };
  return { ok: true, code: null, n: count || 0 };
}

async function chatSnapshot() {
  const { data, error } = await svc
    .from('business_chats').select('tg_chat_id').order('tg_chat_id');
  if (error) return { ok: false, code: error.code, ids: [] };
  return { ok: true, code: null, ids: (data || []).map((r) => String(r.tg_chat_id)) };
}

async function cleanup(svc) {
  if (canaryKey && svc) {
    try { await svc.from('leads').delete().eq('idempotency_key', canaryKey); } catch {}
  }
  if (dev) {
    killTree(dev);
    dev = null;
  }
  /* removeDevRoot already reports instead of throwing; this is the second belt.
     A cleanup that throws would fail a run that passed every assertion. */
  if (devRoot) { try { removeDevRoot(devRoot); } catch {} devRoot = null; }
  if (fs.existsSync(MARKER)) { try { fs.unlinkSync(MARKER); } catch {} }
  if (fakes) { try { await fakes.stop(); } catch {} fakes = null; }
  /* P15 builds into _debug/build-test (about 120 MB). It is a build output, not a
     fixture, so it goes with the run. Exact path only: no glob, no parent sweep. */
  try { fs.rmSync(path.join(ROOT, '_debug', 'build-test'), { recursive: true, force: true }); } catch {}
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
// One loader for every script and suite: process.env > .env.test (TEST_ENV=1)
// > .env.local > .env. Values are never printed — only which file supplied them.
const { sources: envSources, files: envFiles } = loadEnv();
out(`runner  env files: ${envFiles.join(', ')}${isTestEnv() ? '' : ' (TEST_ENV=1 would add .env.test)'}`);
out(`runner  SUPABASE_URL from ${envSources.SUPABASE_URL || '(unset)'}`);

const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/* Refuse to run suites unless the run is demonstrably pointed at a test project.
   The comparison is by value, and neither URL is ever printed. There is no
   opt-out. Deliberately placed AFTER --read-production-seed: that path runs two
   SELECTs and exits, and it is the only production reader left. */
/* No escape hatch. A suite run needs TEST_ENV=1 and a .env.test that points at
   another project; the only production reader left is --read-production-seed,
   which exits before this is called. */
function assertTestProject() {
  const gate = suiteRunGate({
    testEnv: isTestEnv(),
    hasEnvTest: fs.existsSync(path.join(ROOT, '.env.test')),
    prodReason: checkNotProduction().reason,
  });
  if (gate.ok) return;
  out('FAIL  runner  refusing to run a suite');
  out(`      ${gate.detail}.`);
  out('      A suite run needs TEST_ENV=1 and a .env.test pointing at a test');
  out('      project. See docs/TEST_PROJECT.md. There is no override.');
  process.exit(1);
}

/* ---------- seed check (quick, read-only; no tests run) ---------- */
if (RUN_SEED_CHECK) {
  if (SEED_FLAG_DEPRECATED) {
    out('runner  --seed-check is deprecated; use --read-production-seed');
  }
  const seed = {
    slug: ALDER_DEMO, name: 'Alder Roofing',
    owner_email: 'owner@alder-demo.example.com',
    google_review_url: 'https://g.page/r/alder-demo',
    timezone: 'America/Chicago', status: 'demo',
  };
  const { data: row, error } = await svc.from('businesses').select('*').eq('slug', ALDER_DEMO).maybeSingle();
  if (error) { out('seed-check  FAIL  ' + error.code); process.exit(1); }
  if (!row) { out('seed-check  FAIL  alder-demo row missing'); process.exit(1); }
  const differing = Object.keys(seed).filter((k) => String(row[k] ?? '') !== String(seed[k]));
  // business_chats is reported, never required to be empty: a connected phone is
  // a real binding and the ritual must not touch it. Suites bind their own ids.
  const { data: chats } = await svc.from('business_chats').select('id').eq('business_id', row.id);
  const chatsCount = (chats || []).length;
  out(`seed-check  differing-columns: ${differing.length ? differing.join(',') : '(none)'} business_chats-rows: ${chatsCount}`);
  if (differing.length) {
    out('seed-check  FAIL  reset the alder-demo row to seed values');
    process.exit(1);
  }
  out(`seed-check  OK  alder-demo matches seed, business_chats=${chatsCount}`);
  process.exit(0);
}

assertTestProject();

// Public endpoints require a real canonical site_host. TEST only: seed the demo
// host and map loopback HTTP to it; production can never enable this alias.
{
  const { error } = await svc.from('businesses').update({ site_host: 'alder-demo.test' }).eq('slug', ALDER_DEMO);
  if (error) { out(`FAIL  runner  could not assign TEST site_host: ${error.code || 'no_code'}`); process.exit(1); }
  process.env.TENANT_HOST_MAP = JSON.stringify({ localhost: 'alder-demo.test', '127.0.0.1': 'alder-demo.test' });
}

/* A full run writes two 124 MB build trees. Running out of space mid-suite looks
   like a test failure and is not one, so refuse up front. Fail-open only if the
   platform cannot report free space; the note says so. */
{
  const floor = floorFromEnv();
  let free = null;
  try { free = freeBytes(ROOT); } catch {}
  if (free === null) {
    out('runner  disk preflight skipped: this platform cannot report free space');
  } else {
    const gate = diskGate(free, floor);
    if (!gate.ok) {
      out(`FAIL  runner  ${gate.detail}`);
      out('      free space and run again');
      process.exit(1);
    }
  }
}

/* A killed run (SIGKILL, a closed terminal) never reaches cleanup, so P15's build
   output survives into the next run. Clear it before the first suite: a stale
   120 MB tree must not be mistaken for this run's. Exact path only. */
try { fs.rmSync(path.join(ROOT, '_debug', 'build-test'), { recursive: true, force: true }); } catch {}

try {
  /* ---------- refusals ---------- */
  for (const f of envFiles) {
    const found = envNames(f).filter((n) => FORBIDDEN.includes(n));
    if (found.length) throw new Error(`${f} defines ${found.join(', ')} — it would shadow the loopback override. Remove it.`);
  }

  // Refuse to "reuse" a stale dev server: its env would not point at our fakes.
  // Only when this run starts one — a suite set with no HTTP suites never touches
  // port 3000, and a nested run (tests/build-cleanup.test.mjs) must be able to
  // run while the outer one holds the port.
  if (NEEDS_DEV) {
    try {
      const probe = await fetch(API, { method: 'GET', signal: AbortSignal.timeout(1200) });
      throw new Error(`port 3000 is already answering (${probe.status}) — a stale vercel dev is running. Stop it first.`);
    } catch (e) {
      if (e.message && e.message.startsWith('port 3000')) throw e;
    }
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
    //
    // The resolved DB/secret values are passed explicitly and spread LAST — but that
    // alone does NOT make them win. Measured 2026-11-09 with 48.12.1: a .env file in
    // the project directory beats the inherited environment inside the function, so a
    // TEST_ENV=1 run wrote its canary into production. What makes these values win is
    // the dev root: a project directory with no .env files at all (tests/dev-root.mjs).
    // The earlier note here claimed the opposite; it was wrong.
    const PINNED = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
      'IP_HASH_SALT', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_WEBHOOK_SECRET',
      'RESEND_API_KEY', 'MAIL_FROM', 'MAIL_REDIRECT_TO', 'MAIL_REDIRECT_PREFIX', 'SITE_URL'];
    const pinned = {};
    for (const k of PINNED) if (process.env[k]) pinned[k] = process.env[k];
    out(`runner  pinned into dev child: ${Object.keys(pinned).length}/${PINNED.length} keys`);
    devRoot = createDevRoot({ sourceRoot: ROOT, name: 'dev-root' });
    out(`runner  dev root: ${path.relative(ROOT, devRoot)} (no .env, so the pinned values cannot be overridden)`);
    dev = spawn('npx', ['vercel@48.12.1', 'dev', '--listen', '3000'], {
      cwd: devRoot,
      env: { ...process.env, ...bases, ...pinned, VERCEL_ENV: 'development', OUTBOUND_TIMEOUT_MS: '200' },
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
    if (!ready) throw new Error('vercel dev did not answer on port 3000 within 150 s (60 probes: up to 1.5 s each plus a 1 s gap)');
    out('runner  vercel dev ready');

    /* ---------- canary ---------- */
    await fakes.tg.reset();
    canaryKey = 'canary-' + Math.random().toString(36).slice(2, 12);
    const payload = {
      service: 'repair', home: 'house', timing: 'asap', age: 'Not sure', zip: '50265',
      phone: '5155550100', name: 'Canary User', email: 'canary@example.com', notes: '',
      claim: false, website: '', elapsed: 5000, slug: ALDER_DEMO, idempotencyKey: canaryKey,
    };
    const r = await fetch(API, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-real-ip': '198.51.100.250' },
      body: JSON.stringify(payload),
    });
    const tgReqs = await fakes.tg.requests();
    out(`runner  canary: POST ${r.status}, fake telegram requests = ${tgReqs.length}`);
    // One request per bound chat. A real business may have several phones
    // connected, so the point is "the fake received the traffic", not "exactly
    // one": zero means the loopback override never reached the function.
    if (r.status !== 200 || tgReqs.length < 1) {
      throw new Error(`canary failed: the fake Telegram server received ${tgReqs.length} requests. `
        + 'The loopback override did not reach the function. Aborting before any real send.');
    }
    /* The row must NOT be in production. This is the check that catches the failure
       mode the dev root exists to prevent: a function that read .env instead of the
       pinned values writes there and still returns 200. Clean it up first, then abort,
       so a failed run does not leave a lead behind. */
    {
      const prod = readEnvFile('.env');
      if (prod.SUPABASE_URL && prod.SUPABASE_SERVICE_ROLE_KEY
        && !sameSupabaseUrl(prod.SUPABASE_URL, process.env.SUPABASE_URL)) {
        const prodClient = createClient(prod.SUPABASE_URL, prod.SUPABASE_SERVICE_ROLE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data: leaked } = await prodClient.from('leads').select('id').eq('idempotency_key', canaryKey);
        if (leaked && leaked.length) {
          await prodClient.from('leads').delete().eq('idempotency_key', canaryKey);
          throw new Error('canary landed in the PRODUCTION database — the function did not see the pinned '
            + 'SUPABASE_URL. The row was deleted; no suite ran.');
        }
        out('runner  canary: not in production');
      } else {
        out('runner  canary: production check skipped (.env has no other project to compare)');
      }
    }

    /* The canary must be in the SAME database the runner reads. If the function was
       pointed somewhere else (a stale .env, a half-applied .env.test), the delete
       finds nothing and every later assertion would be measuring the wrong project. */
    const { data: removed, error: rmErr } = await svc.from('leads').delete()
      .eq('idempotency_key', canaryKey).select('id');
    if (rmErr || !removed || removed.length !== 1) {
      throw new Error(`canary row not found in the runner's database (deleted ${removed ? removed.length : 0}, `
        + `error ${rmErr ? rmErr.code : 'none'}) — the function is writing to a different project`);
    }
    canaryKey = null;

    /* The canary has just proved this host is the test project: the row landed in
       this database and not in production. Only now may the canary business's
       rate-limit rows be cleared — a few runs in an hour otherwise make the next
       canary answer 429 and the runner abort for the wrong reason. */
    {
      const { data: canaryBiz } = await svc.from('businesses').select('id').eq('slug', ALDER_DEMO).maybeSingle();
      if (canaryBiz && canaryBiz.id) {
        const cleared = await clearCanaryLimits(svc, canaryBiz.id, {
          host: process.env.SUPABASE_URL,
          prodHost: readEnvFile('.env').SUPABASE_URL,
        });
        out(limitLine(cleared));
      }
    }
    await fakes.tg.reset();
  } else {
    out('runner  no selected suite needs HTTP: vercel dev and canary skipped');
  }

  /* ---------- business_chats guard ----------
     A suite must never add or remove a binding. A cleanup that deletes by
     tg_chat_id (the real operator chat) would silently unbind a client, so the
     runner takes a snapshot before the suites and refuses the run if it moved.
     Tails only: the full id is never printed. */
  /* A killed run can leave a fixture binding behind. Every fixture id is at or
     above FIXTURE_ID_BASE, a range no real Telegram chat can occupy, so this
     delete can never touch a customer. It runs BEFORE the snapshot, so the run
     starts from a clean, known state instead of failing on the last run's row. */
  {
    const { data: stale, error } = await svc.from('business_chats')
      .delete().gte('tg_chat_id', FIXTURE_ID_BASE).select('tg_chat_id');
    if (error) {
      out(`FAIL  runner  could not pre-clean fixture chats (${error.code || 'no_code'})`);
      process.exit(1);
    }
    if ((stale || []).length) out(`runner  pre-clean: removed ${stale.length} leftover fixture chat(s)`);
  }

  const businessIds = (await fetchAllRows(() => svc.from('businesses').select('id'))).map((r) => r.id);
  const chatsBefore = await chatSnapshot();
  if (!chatsBefore.ok) {
    // A guard that cannot read the table before the run proves nothing after it.
    out(`FAIL  runner  could not read business_chats before the run (${chatsBefore.code})`);
    process.exit(1);
  }
  const debrisBefore = await debrisSnapshot(businessIds);
  const codesBefore = await unusedCodeCount(businessIds);
  const tail = (ids) => ids.map((x) => x.slice(-4)).join(',') || '(none)';

  /* ---------- suites ---------- */
  let failed = 0;
  let skips = 0;
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
          OUTBOUND_TIMEOUT_MS: '200',
          TELEGRAM_API_BASE: fakes.tg.url,
          RESEND_API_BASE: fakes.resend.url,
        },
        // Piped, not inherited: the summary has to count SKIP lines, and a run that
        // says "all passed" while skipping checks is the thing this count exists for.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const scan = (stream, outStream) => {
        let buf = '';
        return (chunk) => {
          outStream.write(chunk);
          buf += chunk.toString('utf8');
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const l = buf.slice(0, i);
            buf = buf.slice(i + 1);
            skips += countSkips(l);
          }
        };
      };
      c.stdout.on('data', scan('stdout', process.stdout));
      c.stderr.on('data', scan('stderr', process.stderr));
      c.on('exit', (code) => resolve(code || 0));
    });
    out(`runner  ${suite.file} ${((Date.now() - suiteStart) / 1000).toFixed(1)}s`);
    if (rc !== 0) { failed++; fail(`${suite.file} exited ${rc}`); }
  }

  out('');
  {
    const chatsAfter = await chatSnapshot();
    if (!chatsBefore.ok || !chatsAfter.ok) {
      out('FAIL  runner  could not snapshot business_chats');
      out(`      before=${chatsBefore.ok ? 'ok' : chatsBefore.code} after=${chatsAfter.ok ? 'ok' : chatsAfter.code}`);
      out('      a guard that cannot read the table must fail the run, not pass it');
      process.exitCode = 1;
    } else if (JSON.stringify(chatsAfter.ids) !== JSON.stringify(chatsBefore.ids)) {
      out(`FAIL  runner  business_chats changed during the run`);
      out(`      before ${chatsBefore.ids.length}: ${tail(chatsBefore.ids)}`);
      out(`      after  ${chatsAfter.ids.length}: ${tail(chatsAfter.ids)}`);
      out('      a suite added or removed a binding; every test fixture must use its own id');
      process.exitCode = 1;
    } else {
      out(`runner  business_chats unchanged (${chatsBefore.ids.length}: ${tail(chatsBefore.ids)})`);
    }
  }

  {
    const codesAfter = await unusedCodeCount(businessIds);
    if (!codesBefore.ok || !codesAfter.ok) {
      out('FAIL  runner  could not count unused bind codes');
      out(`      before=${codesBefore.ok ? 'ok' : codesBefore.code} after=${codesAfter.ok ? 'ok' : codesAfter.code}`);
      process.exitCode = 1;
    } else if (codesAfter.n > codesBefore.n) {
      out('FAIL  runner  unused bind codes grew during the run');
      out(`      before ${codesBefore.n}, after ${codesAfter.n}`);
      out('      a suite minted a code on a real business and did not delete it;');
      out('      the owner /invite cap counts exactly these rows');
      process.exitCode = 1;
    } else {
      out(`runner  unused bind codes unchanged (${codesBefore.n})`);
    }
  }

  {
    const debrisAfter = await debrisSnapshot(businessIds);
    // A leak is an INCREASE. A decrease is a suite's start sweep clearing what a
    // killed run left behind, which is the behaviour we asked for.
    const grew = debrisAfter.n > debrisBefore.n
      || debrisAfter.events > debrisBefore.events
      || debrisAfter.feedback > debrisBefore.feedback;
    const shrank = debrisAfter.n < debrisBefore.n;
    const same = debrisBefore.ok && debrisAfter.ok && !grew && !shrank
      && debrisBefore.n === debrisAfter.n
      && debrisBefore.events === debrisAfter.events
      && debrisBefore.feedback === debrisAfter.feedback;
    if (!debrisBefore.ok || !debrisAfter.ok || grew) {
      out('FAIL  runner  test-shaped leads changed during the run');
      out(`      before leads=${debrisBefore.n} events=${debrisBefore.events} feedback=${debrisBefore.feedback}`);
      out(`      after  leads=${debrisAfter.n} events=${debrisAfter.events} feedback=${debrisAfter.feedback}`);
      out('      a suite leaked a row (or could not be counted); clean it and fix the suite');
      process.exitCode = 1;
    } else if (shrank) {
      out(`runner  test-shaped leads cleaned (${debrisBefore.n} -> ${debrisAfter.n} leads)`);
    } else {
      out(`runner  test-shaped leads unchanged (${debrisBefore.n} leads, ${debrisBefore.events} events, ${debrisBefore.feedback} feedback)`);
    }
  }

  out(`runner  skips: ${skips}`);
  out(`runner  total ${((Date.now() - TIMING_TOTAL) / 1000).toFixed(1)}s`);
  // exitCode can be set by the business_chats guard without a suite failing.
  const runnerFailed = failed || process.exitCode === 1;
  out(runnerFailed ? `RUNNER  ${failed || 1} suite(s) FAILED` : 'RUNNER  all suites passed');
  if (failed) process.exitCode = 1;
} catch (e) {
  fail(e.message || String(e));
} finally {
  await cleanup(svc);
  out('runner  cleanup: dev stopped, .test-mode removed, fakes closed');
}
