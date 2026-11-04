#!/usr/bin/env node
// scripts/tg-webhook.mjs — webhook registration helper.
//
//   node scripts/tg-webhook.mjs set <url>
//   node scripts/tg-webhook.mjs info
//   node scripts/tg-webhook.mjs delete
//
// Prints only ok / a Telegram description and, for info, the URL HOST. Never the
// full URL, the query string, the token or a response body.

import { setWebhook, getWebhookInfo, deleteWebhook } from '../lib/tg.js';

const [cmd, arg] = process.argv.slice(2);
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

function show(r, extra) {
  const parts = [`ok=${r.ok === true}`, `status=${r.status}`];
  if (r.description) parts.push(`description=${r.description}`);
  if (extra) parts.push(extra);
  console.log(parts.join('  '));
}

if (cmd === 'set') {
  if (!arg) { console.log('usage: node scripts/tg-webhook.mjs set <url>'); process.exit(1); }
  if (!secret) { console.log('ok=false  status=missing_env'); process.exit(1); }
  // allowed_updates and drop_pending_updates are set inside lib/tg.js.
  show(await setWebhook(arg, secret));
} else if (cmd === 'info') {
  const r = await getWebhookInfo();
  let host = '(none)';
  if (r.ok && r.result && r.result.url) {
    try { host = new URL(r.result.url).hostname; } catch { host = '(unparseable)'; }
  }
  show(r, `url_host=${host}`);
} else if (cmd === 'delete') {
  show(await deleteWebhook());
} else {
  console.log('usage: node scripts/tg-webhook.mjs set <url> | info | delete');
  process.exit(1);
}
