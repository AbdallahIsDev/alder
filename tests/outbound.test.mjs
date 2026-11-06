#!/usr/bin/env node
// tests/outbound.test.mjs — Gate F.
// HARNESS: in-process, no network. global fetch is replaced by a stub that records
// the target URL and returns 200, so no real HTTP call can happen.
// Run through tests/run.mjs, and run it LAST: its finally removes the .test-mode
// marker that the other suites rely on while they run.
//
// What it proves about lib/outbound.js:
//   F1/F2  With VERCEL_ENV set to "production" or "preview", a .test-mode marker in
//          the project root and loopback *_API_BASE overrides, the overrides are
//          ignored (calls target the real Telegram and Resend hosts) and the
//          .test-mode block does NOT apply.
//   F3     With VERCEL_ENV unset, the loopback overrides are honoured again.
//   F4     With VERCEL_ENV unset and the overrides missing, the .test-mode block
//          applies and no fetch call happens at all.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.mjs';

loadEnv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = path.join(ROOT, '.test-mode');
const TG_LOOPBACK = 'http://127.0.0.1:9101';
const RS_LOOPBACK = 'http://127.0.0.1:9102';

let failed = 0, total = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(5)}${String(what).padEnd(48)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};

const { blockedByInterlock } = await import('../lib/outbound.js');
const { sendMessage } = await import('../lib/tg.js');
const { sendMail } = await import('../lib/mail.js');

const TG_REAL = 'https://api.telegram.org';
const RS_REAL = 'https://api.resend.com';

const recorded = [];
const realFetch = global.fetch;
const stubFetch = async (url) => {
  recorded.push(String(url));   // recorded URLs can contain tokens; only their origin is ever printed
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const originOf = (u) => { try { return new URL(u).origin; } catch { return 'bad-url'; } };
const mail = () => ({
  to: 'customer@example.com', fromName: 'Lead Alerts', replyTo: 'owner@example.com',
  subject: 't', html: '<p>t</p>', text: 't', idempotencyKey: 'outbound-test-0001',
});

let saved = null;
try {
  saved = {
    VERCEL_ENV: process.env.VERCEL_ENV,
    TELEGRAM_API_BASE: process.env.TELEGRAM_API_BASE,
    RESEND_API_BASE: process.env.RESEND_API_BASE,
    MAIL_REDIRECT_TO: process.env.MAIL_REDIRECT_TO,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
  };
  fs.writeFileSync(MARKER, 'tests/outbound.test.mjs active\n');
  process.env.TELEGRAM_API_BASE = TG_LOOPBACK;
  process.env.RESEND_API_BASE = RS_LOOPBACK;
  process.env.MAIL_REDIRECT_TO = 'redirect@example.com';           // lets sendMail reach postJson
  if (!process.env.TELEGRAM_BOT_TOKEN) process.env.TELEGRAM_BOT_TOKEN = 'presence-only';
  if (!process.env.RESEND_API_KEY) process.env.RESEND_API_KEY = 'presence-only';
  global.fetch = stubFetch;

  /* F1/F2: deployed environments ignore the overrides and the marker */
  for (const env of ['production', 'preview']) {
    process.env.VERCEL_ENV = env;
    recorded.length = 0;
    const m1 = await sendMessage('12345', 'hello');
    const m2 = await sendMail(mail());
    const tgReal = recorded.length >= 1 && originOf(recorded[0]) === TG_REAL;
    const rsReal = recorded.length >= 2 && originOf(recorded[1]) === RS_REAL;
    const unblocked = !blockedByInterlock('TELEGRAM_API_BASE') && !blockedByInterlock('RESEND_API_BASE');
    line(m1.ok === true && m2.ok === true && tgReal && rsReal && unblocked,
      env === 'production' ? 'F1' : 'F2', `${env}: overrides ignored, no marker block`,
      `tg=${tgReal} resend=${rsReal} blocked=${!unblocked} calls=${recorded.length}`);
  }

  /* F3: VERCEL_ENV unset — the loopback overrides are honoured */
  delete process.env.VERCEL_ENV;
  recorded.length = 0;
  const m3 = await sendMessage('12345', 'hello');
  const m4 = await sendMail(mail());
  const tgLoop = recorded.length >= 1 && originOf(recorded[0]) === TG_LOOPBACK;
  const rsLoop = recorded.length >= 2 && originOf(recorded[1]) === RS_LOOPBACK;
  line(m3.ok === true && m4.ok === true && tgLoop && rsLoop
    && !blockedByInterlock('TELEGRAM_API_BASE') && !blockedByInterlock('RESEND_API_BASE'),
    'F3', 'dev: loopback overrides honoured', `tg=${tgLoop} resend=${rsLoop} calls=${recorded.length}`);

  /* F4: VERCEL_ENV unset, overrides missing — the .test-mode block applies, no fetch */
  const before = recorded.length;
  delete process.env.TELEGRAM_API_BASE;
  delete process.env.RESEND_API_BASE;
  const blockedTg = blockedByInterlock('TELEGRAM_API_BASE');
  const blockedRs = blockedByInterlock('RESEND_API_BASE');
  const m5 = await sendMessage('12345', 'hello');
  const m6 = await sendMail(mail());
  line(blockedTg && blockedRs && m5.ok === false && m5.status === 'blocked_test_mode'
    && m6.ok === false && m6.status === 'blocked_test_mode' && recorded.length === before,
    'F4', 'dev without overrides: block applies, no fetch', `blocked=${blockedTg}/${blockedRs} newCalls=${recorded.length - before}`);
  /* F5-F7: dev-only OUTBOUND_TIMEOUT_MS override (honoured 200..3000 only). */
  const { effectiveTimeoutMs } = await import('../lib/outbound.js');
  const savedTimeout = process.env.OUTBOUND_TIMEOUT_MS;
  delete process.env.VERCEL_ENV;
  process.env.OUTBOUND_TIMEOUT_MS = '1000';
  line(effectiveTimeoutMs() === 1000, 'F5', 'override honoured in dev for 1000', `eff=${effectiveTimeoutMs()}`);

  const badVals = ['199', '3001', 'abc', ''];
  const badOk = badVals.every((v) => { process.env.OUTBOUND_TIMEOUT_MS = v; return effectiveTimeoutMs() === 3000; });
  process.env.OUTBOUND_TIMEOUT_MS = '1000';
  line(badOk, 'F6', 'override ignored for <200, >3000, non-numeric', `bad=${badVals.join(',')}`);

  const prodOk = ['production', 'preview'].every((env) => {
    process.env.VERCEL_ENV = env;
    const v = effectiveTimeoutMs();
    delete process.env.VERCEL_ENV;
    return v === 3000;
  });
  line(prodOk, 'F7', 'override ignored when VERCEL_ENV=production/preview', `ok=${prodOk}`);
  if (savedTimeout === undefined) delete process.env.OUTBOUND_TIMEOUT_MS; else process.env.OUTBOUND_TIMEOUT_MS = savedTimeout;
} catch (e) {
  line(false, 'F0', 'outbound suite threw', e.message);
} finally {
  global.fetch = realFetch;
  if (saved) for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { fs.unlinkSync(MARKER); } catch {}
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
