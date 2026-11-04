#!/usr/bin/env node
// scripts/live-smoke.mjs --live
//
// Sends real outbound calls. Never part of the automated suite. Refuses to run if the
// test interlock is active or either base URL is overridden, so it cannot be pointed
// at a fake by accident.
//
// Prints only HTTP statuses, ok true/false, Telegram's error description when a call
// was rejected, and elapsed ms of the Telegram API call. No tokens, no bodies, no URLs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv.includes('--live')) {
  console.log('refusing: pass --live to send real messages');
  process.exit(1);
}
if (fs.existsSync(path.join(ROOT, '.test-mode'))) {
  console.log('refusing: .test-mode is active');
  process.exit(1);
}
if (process.env.TELEGRAM_API_BASE || process.env.RESEND_API_BASE) {
  console.log('refusing: a base URL override is set');
  process.exit(1);
}

for (const f of ['.env', '.env.local']) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { sendMessageWithDescription } = await import('../lib/tg.js');
const { sendMail } = await import('../lib/mail.js');
const { telegramAlertText, alertKeyboard } = await import('../lib/content.js');

const chat = process.env.TELEGRAM_CHAT_ID;
const to = process.env.MAIL_REDIRECT_TO;
const biz = { name: 'Alder Roofing (demo)' };
const lead = {
  name: 'Live Smoke', phone: '5155550100', service: 'repair', home: 'house',
  timing: 'asap', roof_age: 'Not sure', insurance_claim: false, zip: '50265', notes: '',
};
const show = (label, r, ms) => {
  const bits = [`${label} status=${r.status}`, `ok=${r.ok === true}`];
  if (r.description) bits.push(`description=${r.description}`);
  if (ms !== undefined) bits.push(`elapsed_ms=${ms}`);
  console.log(bits.join('  '));
};

const t0 = Date.now();
const alert = await sendMessageWithDescription(chat, telegramAlertText({ business: biz, lead }), {
  reply_markup: alertKeyboard('00000000-0000-0000-0000-000000000000'),
});
show('alert', alert, Date.now() - t0);

const mail = await sendMail({
  to, fromName: 'Lead Alerts', replyTo: undefined,
  subject: 'Live smoke: new estimate request, ZIP 50265',
  html: '<p>Live smoke.</p>', text: 'Live smoke.',
  idempotencyKey: 'live-smoke-' + Date.now(),
});
show('email', mail);

const buttons = await sendMessageWithDescription(chat, 'Live smoke: button support check.', {
  reply_markup: { inline_keyboard: [[
    { text: 'Call', url: 'tel:+15155550100' },
    { text: 'Text', url: 'sms:+15155550100' },
  ]] },
});
show('url_buttons', buttons);
