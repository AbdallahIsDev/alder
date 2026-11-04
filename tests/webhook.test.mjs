#!/usr/bin/env node
// tests/webhook.test.mjs — Gate C.
// HARNESS: in-process handler call with fake Telegram server, real Supabase database.
// Run through tests/run.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.mjs';
import { createClient } from '@supabase/supabase-js';

loadEnv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TG = process.env.FAKE_TG_URL;
if (!TG) { console.log('FAIL  pre  run through tests/run.mjs'); process.exit(1); }

const { default: tgHandler } = await import('../api/tg.js');
const { createBindCode } = await import('../lib/db.js');
const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const RUN = Math.random().toString(36).slice(2, 10);
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

let failed = 0, total = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(5)}${String(what).padEnd(48)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};

async function control(cfg) {
  await fetch(TG + '/__control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
}
async function reset() { await fetch(TG + '/__reset', { method: 'POST' }); }
async function sent() {
  const r = await fetch(TG + '/__requests');
  const j = await r.json();
  return j.requests.filter((x) => x.path.includes('/sendMessage') || x.path.includes('/editMessageText') || x.path.includes('/answerCallbackQuery'));
}
async function resendCalls() {
  const r = await fetch(process.env.FAKE_RESEND_URL + '/__requests');
  const j = await r.json();
  return j.requests.filter((x) => x.path === '/emails');
}
async function resetResend() { await fetch(process.env.FAKE_RESEND_URL + '/__reset', { method: 'POST' }); }

function fakeRes() {
  return {
    code: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
    send(s) { this.body = s; return this; },
    end() { return this; },
  };
}
async function call(update, secret) {
  const res = fakeRes();
  await tgHandler({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(secret === undefined ? {} : { 'x-telegram-bot-api-secret-token': secret }) },
    body: update, socket: {},
  }, res);
  return res;
}
const good = (u) => call(u, SECRET);
const msg = (chatId, text, type = 'private') => ({ message: { message_id: 100, chat: { id: chatId, type }, text } });
const cb = (chatId, data, messageId = 100, text = 'Original alert') => ({
  callback_query: { id: 'cb-' + Math.random().toString(36).slice(2, 9), data,
    message: { message_id: messageId, chat: { id: chatId, type: 'private' }, text } },
});

const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const mkCode = (n) => { let s = ''; for (let i = 0; i < n; i++) s += ALPHA[Math.floor(Math.random() * ALPHA.length)]; return s; };

const { data: bizA } = await svc.from('businesses').select('id').eq('slug', 'alder-demo').single();
const { data: bizB } = await svc.from('businesses').select('id').eq('slug', 'second-demo').single();
const chatA = 880001, chatB = 880002, chatX = 880003;
const createdLeads = [];
const createdCodes = [];

async function seedLead(businessId, name, email) {
  const { data } = await svc.from('leads').insert({
    business_id: businessId, name, phone: '5155550100', email, zip: '50265',
    service: 'repair', home: 'house', timing: 'asap', roof_age: 'Not sure',
    insurance_claim: false, notes: null, idempotency_key: `${RUN}-${mkCode(8)}`,
  }).select('id').single();
  if (data) createdLeads.push(data.id);
  return data && data.id;
}

try {
  await control({ mode: 'ok' }); await reset(); await resetResend();

  /* auth */
  const before = (await svc.from('business_chats').select('*').eq('tg_chat_id', chatX)).data.length;
  const noSecret = await call(msg(chatX, '/start'), undefined);
  const wrongSecret = await call(msg(chatX, '/start'), 'wrong-secret-value');
  const after = (await svc.from('business_chats').select('*').eq('tg_chat_id', chatX)).data.length;
  line(noSecret.code === 401 && wrongSecret.code === 401 && before === after && after === 0,
    'C1', 'missing/wrong secret -> 401, no DB change', `${noSecret.code}/${wrongSecret.code} rows=${after}`);

  const saved = process.env.TELEGRAM_WEBHOOK_SECRET;
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  const noEnv = await call(msg(chatX, '/start'), saved);
  process.env.TELEGRAM_WEBHOOK_SECRET = saved;
  line(noEnv.code === 503, 'C2', 'missing env secret -> 503', noEnv.code);

  /* group chat ignored */
  await reset();
  const group = await good(msg(chatX, '/start BADCODE', 'group'));
  const msgs = await sent();
  line(group.code === 200 && msgs.length === 0, 'C3', 'group chat update ignored', `calls=${msgs.length}`);

  /* bind once */
  const code1 = mkCode(12); createdCodes.push(code1);
  await createBindCode(code1, bizA.id, new Date(Date.now() + 3600000).toISOString());
  await reset();
  await good(msg(chatA, '/start ' + code1));
  const bound1 = (await svc.from('business_chats').select('business_id').eq('tg_chat_id', chatA).maybeSingle()).data;
  const confirmation = (await sent()).map((x) => x.body && x.body.text).join(' ');
  line(group.code === 200 && !!bound1 && bound1.business_id === bizA.id && confirmation.includes('Alder Roofing'),
    'C4', 'valid /start CODE binds once and names business', `bound=${!!bound1}`);

  await reset();
  await good(msg(chatX, '/start ' + code1));
  const second = (await svc.from('bind_codes').select('used_at').eq('code', code1).single()).data;
  const secondText = (await sent()).map((x) => x.body && x.body.text).join(' ');
  line(!!second.used_at && secondText.includes('not valid'), 'C5', 'same code cannot be used twice', secondText.slice(0, 60));

  /* expired code */
  const expired = mkCode(12); createdCodes.push(expired);
  await createBindCode(expired, bizA.id, new Date(Date.now() - 60000).toISOString());
  await reset();
  await good(msg(chatX, '/start ' + expired));
  const expText = (await sent()).map((x) => x.body && x.body.text).join(' ');
  const expUsed = (await svc.from('bind_codes').select('used_at').eq('code', expired).single()).data;
  line(!expUsed.used_at && expText.includes('not valid'), 'C6', 'expired code rejected, not consumed');

  /* second business + /leads isolation */
  const code2 = mkCode(12); createdCodes.push(code2);
  await createBindCode(code2, bizB.id, new Date(Date.now() + 3600000).toISOString());
  await reset();
  await good(msg(chatB, '/start ' + code2));
  const aLead1 = await seedLead(bizA.id, 'Alpha Only', 'alpha@example.com');
  await seedLead(bizA.id, 'Alpha Two', 'alpha2@example.com');
  await seedLead(bizB.id, 'Beta Only', 'beta@example.com');
  await seedLead(bizB.id, 'Beta Two', 'beta2@example.com');

  await reset();
  await good(msg(chatA, '/leads'));
  const listA = (await sent()).map((x) => x.body && x.body.text).join('\n');
  await reset();
  await good(msg(chatB, '/leads'));
  const listB = (await sent()).map((x) => x.body && x.body.text).join('\n');
  line(listA.includes('Alpha Only') && !listA.includes('Beta Only') && listB.includes('Beta Only') && !listB.includes('Alpha Only'),
    'C7', 'each /leads shows only its own business', `A_hasB=${listA.includes('Beta Only')} B_hasA=${listB.includes('Alpha Only')}`);

  /* forged callback across businesses — every kind (c, d, y, n) */
  const statusBefore = (await svc.from('leads').select('status').eq('id', aLead1).single()).data.status;
  await reset();
  for (const kind of ['c', 'd', 'y', 'n']) await good(cb(chatB, kind + ':' + aLead1));
  const statusAfter = (await svc.from('leads').select('status').eq('id', aLead1).single()).data.status;
  const forged = await sent();
  line(statusBefore === statusAfter && statusAfter === 'open' && forged.some((x) => x.path.includes('/answerCallbackQuery')),
    'C8', 'forged cross-business callbacks (c/d/y/n) -> no DB change', `${statusBefore} -> ${statusAfter}`);

  /* malformed callback_data is ignored (never triggers a transition) */
  await reset();
  for (const bad of ['x:' + aLead1, 'c:not-a-uuid', 'cd:00000000-0000-0000-0000-000000000000', 'c:' + aLead1 + 'extra']) {
    await good(cb(chatB, bad));
  }
  const malformedStatus = (await svc.from('leads').select('status').eq('id', aLead1).single()).data.status;
  const malformedSent = await sent();
  line(malformedStatus === 'open' && malformedSent.every((x) => !x.path.includes('/editMessageText')),
    'C8b', 'malformed callback_data ignored, no edit', `status=${malformedStatus} edits=${malformedSent.filter((x) => x.path.includes('/editMessageText')).length}`);

  /* NEW FLOW (item 3): d: now only asks for confirmation; it never emails or changes status */
  await resetResend();
  const askLead = createdLeads[3];
  await reset();
  await good(cb(chatB, 'c:' + askLead));
  await reset();
  await good(cb(chatB, 'd:' + askLead));
  const askRow = (await svc.from('leads').select('status, review_token').eq('id', askLead).single()).data;
  const askEmails = (await resendCalls()).length;
  const askEdits = (await sent()).filter((x) => x.path.includes('/editMessageText'));
  const askKb = askEdits.length === 1 && askEdits[0].body.reply_markup.inline_keyboard[0].length === 2
    && askEdits[0].body.reply_markup.inline_keyboard[0][0].callback_data === 'y:' + askLead;
  line(askRow.status === 'contacted' && !askRow.review_token && askEmails === 0 && askKb,
    'C9', 'Job completed asks, does not email or change status', `status=${askRow.status} emails=${askEmails}`);

  /* NEW FLOW (item 3): full sequence c -> d (confirm) -> y sends exactly one email, empty keyboard */
  await resetResend();
  const seqLead = await seedLead(bizB.id, 'Seq Tester', 'seq@example.com');
  await reset();
  await good(cb(chatB, 'c:' + seqLead));
  const seqRow1 = (await svc.from('leads').select('status, review_token').eq('id', seqLead).single()).data;
  const edits1 = (await sent()).filter((x) => x.path.includes('/editMessageText'));
  const s1Kb = edits1.length === 1 && JSON.stringify(edits1[0].body.reply_markup)
    === JSON.stringify({ inline_keyboard: [[{ text: 'Job completed', callback_data: 'd:' + seqLead }]] })
    && edits1[0].body.text.includes('Status: Contacted');
  await reset();
  await good(cb(chatB, 'd:' + seqLead));
  const seqRow2 = (await svc.from('leads').select('status, review_token').eq('id', seqLead).single()).data;
  const edits2 = (await sent()).filter((x) => x.path.includes('/editMessageText'));
  const s2Kb = edits2.length === 1 && JSON.stringify(edits2[0].body.reply_markup)
    === JSON.stringify({ inline_keyboard: [[
      { text: 'Yes, send review request', callback_data: 'y:' + seqLead },
      { text: 'Cancel', callback_data: 'n:' + seqLead }]] })
    && edits2[0].body.text.includes('Send a review request to Seq');
  await reset();
  await good(cb(chatB, 'y:' + seqLead));
  const seqRow3 = (await svc.from('leads').select('status, review_token').eq('id', seqLead).single()).data;
  const edits3 = (await sent()).filter((x) => x.path.includes('/editMessageText'));
  const seqEmails = (await resendCalls()).length;
  const s3Kb = edits3.length === 1 && JSON.stringify(edits3[0].body.reply_markup)
    === JSON.stringify({ inline_keyboard: [] })
    && edits3[0].body.text.includes('Status: Done. Review request sent to seq@example.com.');
  line(seqRow1.status === 'contacted' && s1Kb && seqRow2.status === 'contacted' && s2Kb
    && seqRow3.status === 'done' && !!seqRow3.review_token && s3Kb && seqEmails === 1,
    'C11', 'c -> d -> y: done, one email, empty keyboard', `s1=${s1Kb} s2=${s2Kb} s3=${s3Kb} emails=${seqEmails}`);

  /* Cancel returns to the one-button contacted view with no DB change */
  await resetResend();
  const cancelLead = await seedLead(bizB.id, 'Cancel Tester', 'cancel@example.com');
  await good(cb(chatB, 'c:' + cancelLead));
  await good(cb(chatB, 'd:' + cancelLead));
  const cancelBefore = (await svc.from('leads').select('status, review_token').eq('id', cancelLead).single()).data;
  await reset();
  await good(cb(chatB, 'n:' + cancelLead));
  const cancelAfter = (await svc.from('leads').select('status, review_token').eq('id', cancelLead).single()).data;
  const cancelEdits = (await sent()).filter((x) => x.path.includes('/editMessageText'));
  const cancelEmails = (await resendCalls()).length;
  line(cancelAfter.status === 'contacted' && !cancelAfter.review_token
    && cancelEdits.length === 1 && JSON.stringify(cancelEdits[0].body.reply_markup)
      === JSON.stringify({ inline_keyboard: [[{ text: 'Job completed', callback_data: 'd:' + cancelLead }]] })
    && cancelEmails === 0,
    'C11b', 'Cancel returns to Job completed, no DB change, no email', `emails=${cancelEmails}`);

  /* d: and y: on an OPEN lead are refused with "Mark this lead as contacted first." */
  await resetResend();
  const openLead = await seedLead(bizB.id, 'Open Guard', 'openguard@example.com');
  for (const kind of ['d', 'y']) {
    await reset();
    await good(cb(chatB, kind + ':' + openLead));
    const refusal = (await sent()).filter((x) => x.path.includes('/answerCallbackQuery'));
    const refusedText = refusal.map((x) => x.body && x.body.text).join(' ');
    const row = (await svc.from('leads').select('status, review_token').eq('id', openLead).single()).data;
    const emails = (await resendCalls()).length;
    const editsN = (await sent()).filter((x) => x.path.includes('/editMessageText')).length;
    line(row.status === 'open' && !row.review_token && emails === 0 && editsN === 0
      && refusedText.includes('Mark this lead as contacted first.'),
      kind === 'd' ? 'C12d' : 'C12y', `${kind}: on open lead refused, no DB change, no email`,
      `status=${row.status} emails=${emails} edits=${editsN}`);
  }

  /* second y: tap changes nothing and sends nothing */
  await resetResend();
  await reset();
  await good(cb(chatB, 'y:' + seqLead));
  const seqSecond = (await svc.from('leads').select('status').eq('id', seqLead).single()).data;
  const secondEmails = (await resendCalls()).length;
  line(seqSecond.status === 'done' && secondEmails === 0,
    'C13', 'second y: changes nothing, no second email', `emails=${secondEmails}`);

  /* Contacted tap on a done lead changes nothing, still answers */
  const doneBefore = (await svc.from('leads').select('status, review_token').eq('id', seqLead).single()).data;
  const eventsBefore = (await svc.from('lead_events').select('kind').eq('lead_id', seqLead)).data.length;
  await reset();
  await good(cb(chatB, 'c:' + seqLead));
  const doneAfter = (await svc.from('leads').select('status, review_token').eq('id', seqLead).single()).data;
  const eventsAfter = (await svc.from('lead_events').select('kind').eq('lead_id', seqLead)).data.length;
  const guardSent = await sent();
  const guardEdits = guardSent.filter((x) => x.path.includes('/editMessageText'));
  const guardAnswered = guardSent.some((x) => x.path.includes('/answerCallbackQuery'));
  line(doneAfter.status === 'done' && doneAfter.review_token === doneBefore.review_token
    && eventsAfter === eventsBefore && guardEdits.length === 0 && guardAnswered,
    'C13b', 'Contacted on done lead -> no DB change, answers', `status=${doneAfter.status} edits=${guardEdits.length} answered=${guardAnswered}`);

  /* C14: double tap Contacted -> one transition, one edit, still answers twice */
  const ccLead = await seedLead(bizB.id, 'Double Tap C', 'doublec@example.com');
  await reset();
  await good(cb(chatB, 'c:' + ccLead));
  await good(cb(chatB, 'c:' + ccLead));
  const ccRow = (await svc.from('leads').select('status').eq('id', ccLead).single()).data;
  const ccEvents = (await svc.from('lead_events').select('kind').eq('lead_id', ccLead).eq('kind', 'contacted')).data.length;
  const ccSent = await sent();
  const ccEdits = ccSent.filter((x) => x.path.includes('/editMessageText'));
  const ccAnswers = ccSent.filter((x) => x.path.includes('/answerCallbackQuery'));
  line(ccRow.status === 'contacted' && ccEvents === 1 && ccEdits.length === 1 && ccAnswers.length === 2,
    'C14', 'double tap Contacted -> one change, answers twice', `status=${ccRow.status} events=${ccEvents} edits=${ccEdits.length} answers=${ccAnswers.length}`);

  /* static check on api/tg.js and everything it imports */
  const seen = new Set();
  const texts = [];
  function walk(file) {
    const abs = path.resolve(ROOT, file);
    if (seen.has(abs) || !fs.existsSync(abs)) return;
    seen.add(abs);
    const src = fs.readFileSync(abs, 'utf8');
    texts.push(src);
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      let p = path.resolve(path.dirname(abs), m[1]);
      if (!p.endsWith('.js')) p += '.js';
      walk(p);
    }
  }
  walk('api/tg.js');
  const all = texts.join('\n');
  const forbidden = /private\.|lead_financials/.test(all);
  const directLeadSelect = /\.from\(['"]leads['"]\)\s*\.select\s*\(/.test(all);
  line(!forbidden && !directLeadSelect, 'C10', 'no private schema, no direct lead SELECT',
    `files=${seen.size} forbidden=${forbidden} directSelect=${directLeadSelect}`);
} catch (e) {
  line(false, 'C0', 'webhook suite threw', e.message);
} finally {
  await svc.from('leads').delete().in('id', createdLeads);
  await svc.from('business_chats').delete().in('tg_chat_id', [chatA, chatB, chatX]);
  if (createdCodes.length) await svc.from('bind_codes').delete().in('code', createdCodes);
  await svc.from('rate_limits').delete().gte('window_start', '2000-01-01');
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
