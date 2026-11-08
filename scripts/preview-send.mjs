#!/usr/bin/env node
// scripts/preview-send.mjs --to <chat id> --yes [--email <addr>] [--allow-bound]
//
// Sends every Telegram preview text to ONE chat, each prefixed "PREVIEW", and
// optionally the product and ops emails through the real Resend path, so the
// owner sees the real rendering in Telegram and in Gmail.
//
// Refuses a chat id that is bound to a business unless --allow-bound: a preview
// dropped into a client's alert chat is indistinguishable from a real alert.
//
// Never imported by a test. It talks to the real Bot API and the real Resend.

import { loadEnv } from '../lib/env.js';
import { createClient } from '@supabase/supabase-js';
import { sendMessage } from '../lib/tg.js';
import { sendMail } from '../lib/mail.js';
import { sampleTelegramTexts } from '../lib/sample-texts.js';
import { ownerEmail, autoReply, reviewEmail, selfCheckEmail, digestEmail } from '../lib/email-builders.js';
import { sampleBusiness, sampleLead } from '../lib/sample-texts.js';

loadEnv();

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : null; };
function fail(msg) { console.error('preview-send: ' + msg); process.exit(1); }

if (!argv.includes('--yes')) fail('refusing to send without --yes');
const emailOnly = argv.includes('--email-only');
const redirect = String(process.env.MAIL_REDIRECT_TO || '').trim();
if (emailOnly && !redirect) fail('--email-only needs MAIL_REDIRECT_TO; refusing to guess a recipient');
const to = val('--to');
if (!emailOnly && (!to || !/^-?\d+$/.test(String(to)))) fail('--to <chat id> is required');
const email = emailOnly ? redirect : val('--email');

const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

if (!emailOnly && !argv.includes('--allow-bound')) {
  const { data } = await svc.from('business_chats').select('tg_chat_id').eq('tg_chat_id', Number(to));
  if (data && data.length) fail('that chat is bound to a business; pass --allow-bound if you really mean it');
}

let sent = 0;
if (!emailOnly) {
  for (const { name, text } of sampleTelegramTexts()) {
    const r = await sendMessage(to, `PREVIEW · ${name}\n\n${text}`);
    if (r && r.ok) sent++;
    else console.log('failed ' + name + ' status=' + (r && r.status !== undefined ? r.status : 'timeout'));
  }
  console.log('telegram previews sent ' + sent);
}

if (email) {
  const mails = [
    ['owner', ownerEmail({ business: sampleBusiness, lead: sampleLead })],
    ['auto-reply', autoReply({ business: sampleBusiness, lead: sampleLead })],
    ['review', reviewEmail({ business: sampleBusiness, token: 'preview-token', siteUrl: process.env.SITE_URL || 'http://localhost:3000' })],
    ['alert-check', selfCheckEmail({ created: 3, tg_sent: 2, email_owner_sent: 1, tg_failed: 1 }, new Date().toISOString().slice(0, 10), sampleBusiness)],
    ['lead-summary', digestEmail({ newLeads: 4, repeats: 1, untouched: 2, failed: 1 }, new Date().toISOString().slice(0, 10), sampleBusiness)],
  ];
  for (const [name, mail] of mails) {
    const r = await sendMail({
      to: email, fromName: 'Lead Alerts',
      subject: 'PREVIEW · ' + mail.subject,
      html: mail.html, text: mail.text,
      idempotencyKey: 'preview:' + name + ':' + Date.now(),
    });
    console.log('email ' + name + ' ' + (r && r.ok ? 'sent' : 'failed status=' + (r && r.status)));
  }
}
