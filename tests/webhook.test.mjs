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

  /* forged callback across businesses — every kind (c, d, y, n, r).
     Before (item 3): kinds c/d/y/n. After: r: added with the retry button. */
  const statusBefore = (await svc.from('leads').select('status').eq('id', aLead1).single()).data.status;
  await reset();
  for (const kind of ['c', 'd', 'y', 'n', 'r']) await good(cb(chatB, kind + ':' + aLead1));
  const statusAfter = (await svc.from('leads').select('status').eq('id', aLead1).single()).data.status;
  const forged = await sent();
  line(statusBefore === statusAfter && statusAfter === 'open' && forged.some((x) => x.path.includes('/answerCallbackQuery')),
    'C8', 'forged cross-business callbacks (c/d/y/n/r) -> no DB change', `${statusBefore} -> ${statusAfter}`);

  /* malformed callback_data is ignored (never triggers a transition) */
  await reset();
  for (const bad of ['x:' + aLead1, 'c:not-a-uuid', 'r:not-a-uuid', 'cd:00000000-0000-0000-0000-000000000000', 'c:' + aLead1 + 'extra']) {
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
    === JSON.stringify({ inline_keyboard: [[{ text: 'Job completed', callback_data: 'd:' + seqLead, style: 'primary' }]] })
    && edits1[0].body.text.includes('Status: Contacted');
  await reset();
  await good(cb(chatB, 'd:' + seqLead));
  const seqRow2 = (await svc.from('leads').select('status, review_token').eq('id', seqLead).single()).data;
  const edits2 = (await sent()).filter((x) => x.path.includes('/editMessageText'));
  const s2Kb = edits2.length === 1 && JSON.stringify(edits2[0].body.reply_markup)
    === JSON.stringify({ inline_keyboard: [[
      { text: 'Yes, send review request', callback_data: 'y:' + seqLead, style: 'success' },
      { text: 'Cancel', callback_data: 'n:' + seqLead, style: 'danger' }]] })
    && edits2[0].body.text.includes('Send a review request to Seq');
  await reset();
  await good(cb(chatB, 'y:' + seqLead));
  const seqRow3 = (await svc.from('leads').select('status, review_token').eq('id', seqLead).single()).data;
  const edits3 = (await sent()).filter((x) => x.path.includes('/editMessageText'));
  const seqEmails = (await resendCalls()).length;
  // Before (item 3): 'Status: Done. Review request sent to seq@example.com.'
  // (one long line repeating the email). After: two short emoji lines, no email.
  const s3Kb = edits3.length === 1 && JSON.stringify(edits3[0].body.reply_markup)
    === JSON.stringify({ inline_keyboard: [] })
    && edits3[0].body.text.includes('✅ Status: Done')
    && edits3[0].body.text.includes('✉️ Review request sent')
    && !edits3[0].body.text.split('\n\n').pop().includes('seq@example.com');
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
      === JSON.stringify({ inline_keyboard: [[{ text: 'Job completed', callback_data: 'd:' + cancelLead, style: 'primary' }]] })
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

  /* Item 3 retry flow: y: with Resend 500 -> error view with one r: button;
     r: with Resend ok -> exactly one email, done view, no buttons, token kept. */
  {
    const resendCtrl = async (cfg) => {
      await fetch(process.env.FAKE_RESEND_URL + '/__control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
    };
    const retryLead = await seedLead(bizB.id, 'Retry Tester', 'retry@example.com');
    await resendCtrl({ mode: 'ok' });
    await good(cb(chatB, 'c:' + retryLead));
    await good(cb(chatB, 'd:' + retryLead));
    await resendCtrl({ mode: '500' });
    await resetResend();
    await reset();
    await good(cb(chatB, 'y:' + retryLead));
    const failRow = (await svc.from('leads').select('status, review_token').eq('id', retryLead).single()).data;
    const failEdits = (await sent()).filter((x) => x.path.includes('/editMessageText'));
    const failKbOk = failEdits.length === 1 && JSON.stringify(failEdits[0].body.reply_markup)
      === JSON.stringify({ inline_keyboard: [[{ text: 'Try again', callback_data: 'r:' + retryLead, style: 'primary' }]] })
      && failEdits[0].body.text.includes('❌ Status: Error')
      && failEdits[0].body.text.includes('⚠️ Review request couldn\'t be sent');
    line(failRow.status === 'done' && !!failRow.review_token && failKbOk,
      'C17', 'y: email fails -> error view, one Try again (r:) button', `status=${failRow.status} kb=${failKbOk}`);

    await resendCtrl({ mode: 'ok' });
    await resetResend();
    await reset();
    await good(cb(chatB, 'r:' + retryLead));
    const okRow = (await svc.from('leads').select('status, review_token').eq('id', retryLead).single()).data;
    const okEmails = (await resendCalls()).length;
    const okEdits = (await sent()).filter((x) => x.path.includes('/editMessageText'));
    const okKbOk = okEdits.length === 1 && JSON.stringify(okEdits[0].body.reply_markup)
      === JSON.stringify({ inline_keyboard: [] })
      && okEdits[0].body.text.includes('✅ Status: Done')
      && okEdits[0].body.text.includes('✉️ Review request sent');
    line(okRow.status === 'done' && okRow.review_token === failRow.review_token && okEmails === 1 && okKbOk,
      'C18', 'r: resends with existing token, one email, ends with no buttons',
      `emails=${okEmails} tokenKept=${okRow.review_token === failRow.review_token}`);

    // Second r: after the success sends nothing and changes nothing.
    await resetResend();
    await reset();
    await good(cb(chatB, 'r:' + retryLead));
    const againEmails = (await resendCalls()).length;
    const againEdits = (await sent()).filter((x) => x.path.includes('/editMessageText')).length;
    const againRow = (await svc.from('leads').select('status').eq('id', retryLead).single()).data;
    line(againEmails === 0 && againEdits === 0 && againRow.status === 'done',
      'C19', 'second r: after success sends nothing, changes nothing', `emails=${againEmails} edits=${againEdits}`);

    // r: on an open lead is refused with "Nothing to retry."
    const openRetry = await seedLead(bizB.id, 'Open Retry', 'openretry@example.com');
    await resetResend();
    await reset();
    await good(cb(chatB, 'r:' + openRetry));
    const refSent = await sent();
    const refText = refSent.filter((x) => x.path.includes('/answerCallbackQuery')).map((x) => x.body && x.body.text).join(' ');
    const refEdits = refSent.filter((x) => x.path.includes('/editMessageText')).length;
    const refEmails = (await resendCalls()).length;
    line(refText.includes('Nothing to retry.') && refEdits === 0 && refEmails === 0,
      'C20', 'r: on open lead refused, no edit, no email', `text=${refText.slice(0, 40)}`);
  }

  /* Item 1 (this bundle): retry idempotency keys, asserted at the fake
     Resend server's Idempotency-Key header. */
  {
    const resendCtrl = async (cfg) => {
      await fetch(process.env.FAKE_RESEND_URL + '/__control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
    };
    const keyOf = async () => {
      const calls = await resendCalls();
      return calls.length === 1 ? (calls[0].headers && calls[0].headers['idempotency-key']) : `calls=${calls.length}`;
    };
    const toContacted = async (leadId) => { await good(cb(chatB, 'c:' + leadId)); await good(cb(chatB, 'd:' + leadId)); };

    // C21: first send uses the plain key.
    const firstLead = await seedLead(bizB.id, 'Key First', 'keyfirst@example.com');
    await resendCtrl({ mode: 'ok' });
    await toContacted(firstLead);
    await resetResend();
    await good(cb(chatB, 'y:' + firstLead));
    const firstKey = await keyOf();
    line(firstKey === `${firstLead}:review`, 'C21', 'first review send uses plain <leadId>:review key',
      `header=${firstKey}`);

    // C22: retry after a non-timeout (HTTP 500) failure uses :review:r1.
    const httpLead = await seedLead(bizB.id, 'Key Http', 'keyhttp@example.com');
    await resendCtrl({ mode: 'ok' });
    await toContacted(httpLead);
    await resendCtrl({ mode: '500' });
    await resetResend();
    await good(cb(chatB, 'y:' + httpLead));
    const yKey = await keyOf();
    await resendCtrl({ mode: 'ok' });
    await resetResend();
    await good(cb(chatB, 'r:' + httpLead));
    const rKey = await keyOf();
    line(yKey === `${httpLead}:review` && rKey === `${httpLead}:review:r1`,
      'C22', 'retry after HTTP failure uses :review:r1',
      `y=${yKey} r=${rKey}`);

    // C23: retry after a timeout failure reuses the plain key (the first
    // request may have delivered; Resend dedupes on the same key).
    const slowLead = await seedLead(bizB.id, 'Key Slow', 'keyslow@example.com');
    await resendCtrl({ mode: 'ok' });
    await toContacted(slowLead);
    await resendCtrl({ mode: 'hang_once', hangMs: 6000 });
    await resetResend();
    await good(cb(chatB, 'y:' + slowLead));
    await resendCtrl({ mode: 'ok' });
    await resetResend();
    await good(cb(chatB, 'r:' + slowLead));
    const slowKey = await keyOf();
    line(slowKey === `${slowLead}:review`,
      'C23', 'retry after timeout reuses plain key',
      `header=${slowKey}`);

    // C24: two sequential failures then a retry yields :review:r2.
    const twoLead = await seedLead(bizB.id, 'Key Two', 'keytwo@example.com');
    await resendCtrl({ mode: 'ok' });
    await toContacted(twoLead);
    await resendCtrl({ mode: '500' });
    await resetResend();
    await good(cb(chatB, 'y:' + twoLead));
    await resetResend();
    await good(cb(chatB, 'r:' + twoLead));
    const secondKey = await keyOf();
    await resendCtrl({ mode: 'ok' });
    await resetResend();
    await good(cb(chatB, 'r:' + twoLead));
    const thirdKey = await keyOf();
    line(secondKey === `${twoLead}:review:r1` && thirdKey === `${twoLead}:review:r2`,
      'C24', 'two failures then retry yields :review:r2',
      `second=${secondKey} third=${thirdKey}`);
  }

  /* Retry-key follow-up: a timeout reuses the EXACT key of the timed-out
     attempt (which may be suffixed), never the plain key blindly. */
  {
    const resendCtrl = async (cfg) => {
      await fetch(process.env.FAKE_RESEND_URL + '/__control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
    };
    const keyOf = async () => {
      const calls = await resendCalls();
      return calls.length === 1 ? (calls[0].headers && calls[0].headers['idempotency-key']) : `calls=${calls.length}`;
    };
    const toContacted = async (leadId) => { await good(cb(chatB, 'c:' + leadId)); await good(cb(chatB, 'd:' + leadId)); };

    // C27 (a): 500 (plain) -> timeout on :r1 -> retry reuses :r1.
    const aLead = await seedLead(bizB.id, 'Key Seq A', 'keyseqa@example.com');
    await resendCtrl({ mode: 'ok' });
    await toContacted(aLead);
    await resendCtrl({ mode: '500' });
    await resetResend();
    await good(cb(chatB, 'y:' + aLead));
    await resendCtrl({ mode: 'hang_once', hangMs: 6000 });
    await resetResend();
    await good(cb(chatB, 'r:' + aLead));
    const aSecond = await keyOf();
    await resendCtrl({ mode: 'ok' });
    await resetResend();
    await good(cb(chatB, 'r:' + aLead));
    const aThird = await keyOf();
    line(aSecond === `${aLead}:review:r1` && aThird === `${aLead}:review:r1`,
      'C27', '500 -> timeout(:r1) -> retry reuses :r1',
      `second=${aSecond} third=${aThird}`);

    // C28 (b): timeout, timeout, retry -> all three plain.
    const bLead = await seedLead(bizB.id, 'Key Seq B', 'keyseqb@example.com');
    await resendCtrl({ mode: 'ok' });
    await toContacted(bLead);
    await resendCtrl({ mode: 'hang_once', hangMs: 6000 });
    await resetResend();
    await good(cb(chatB, 'y:' + bLead));
    const bFirst = await keyOf();
    await resendCtrl({ mode: 'hang_once', hangMs: 6000 });
    await resetResend();
    await good(cb(chatB, 'r:' + bLead));
    const bSecond = await keyOf();
    await resendCtrl({ mode: 'ok' });
    await resetResend();
    await good(cb(chatB, 'r:' + bLead));
    const bThird = await keyOf();
    line(bFirst === `${bLead}:review` && bSecond === `${bLead}:review` && bThird === `${bLead}:review`,
      'C28', 'timeout, timeout, retry -> all plain key',
      `keys=${bFirst},${bSecond},${bThird}`);

    // C29 (c): timeout (plain) -> 500 (plain reuse) -> retry :r2.
    const cLead = await seedLead(bizB.id, 'Key Seq C', 'keyseqc@example.com');
    await resendCtrl({ mode: 'ok' });
    await toContacted(cLead);
    await resendCtrl({ mode: 'hang_once', hangMs: 6000 });
    await resetResend();
    await good(cb(chatB, 'y:' + cLead));
    await resendCtrl({ mode: '500' });
    await resetResend();
    await good(cb(chatB, 'r:' + cLead));
    const cSecond = await keyOf();
    await resendCtrl({ mode: 'ok' });
    await resetResend();
    await good(cb(chatB, 'r:' + cLead));
    const cThird = await keyOf();
    line(cSecond === `${cLead}:review` && cThird === `${cLead}:review:r2`,
      'C29', 'timeout -> 500 -> retry yields :r2',
      `second=${cSecond} third=${cThird}`);

    // C30 (e): failure meta is exactly { status, key } — no PII.
    const failEvents = (await svc.from('lead_events').select('meta').eq('lead_id', aLead).eq('kind', 'review_request_failed')).data || [];
    const metaOk = failEvents.length > 0 && failEvents.every((e) => {
      const keys = Object.keys(e.meta || {}).sort();
      const s = JSON.stringify(e.meta || {});
      return keys.join(',') === 'key,status'
        && typeof e.meta.key === 'string' && e.meta.key.startsWith(aLead + ':review')
        && !s.includes('keyseqa@example.com') && !s.includes('Key Seq A');
    });
    line(metaOk, 'C30', 'review_request_failed meta is {status,key}, no PII',
      `events=${failEvents.length} keys=${failEvents.length ? Object.keys(failEvents[0].meta).sort().join(',') : 'none'}`);
  }

  /* Item 2 (this bundle): a thrown DB error answers once with
     "Something went wrong. Try again.", no edit, no email, still 200.
     How the throw is injected: wrap global fetch and return a 500
     PostgREST error for the targeted query only (v_client_leads for
     getClientLead; review_requested on lead_events for hasReviewSent),
     delegating everything else to the real fetch. */
  {
    const withDbFailure = async (match, fn) => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (url, opts) => {
        if (match(String(url))) {
          return new Response(JSON.stringify({ code: 'XX000', message: 'forced failure', details: '', hint: '' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } });
        }
        return realFetch(url, opts);
      };
      try { return await fn(); } finally { globalThis.fetch = realFetch; }
    };
    const checkOnce = async (label, data, match) => {
      await resetResend();
      await reset();
      let res;
      await withDbFailure(match, async () => { res = await good(cb(chatB, data)); });
      const s = await sent();
      const answers = s.filter((x) => x.path.includes('/answerCallbackQuery'));
      const edits = s.filter((x) => x.path.includes('/editMessageText'));
      const emails = (await resendCalls()).length;
      const ok = res.code === 200 && answers.length === 1
        && answers[0].body && answers[0].body.text === 'Something went wrong. Try again.'
        && edits.length === 0 && emails === 0;
      line(ok, label, `throw -> one "Something went wrong. Try again." answer, no edit/email, 200`,
        `code=${res.code} answers=${answers.length} edits=${edits.length} emails=${emails}`);
    };
    await checkOnce('C25', 'c:' + seqLead, (u) => u.includes('v_client_leads'));
    await checkOnce('C26', 'r:' + seqLead, (u) => u.includes('review_requested'));
  }

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

  /* C11c: every button style is allowed and callback_data is unchanged */
  {
    const { alertKeyboard, jobDoneKeyboard, confirmKeyboard } = await import('../lib/content.js');
    const uid = '00000000-0000-4000-8000-000000000001';
    const allBtns = [
      ...alertKeyboard(uid).inline_keyboard[0],
      ...jobDoneKeyboard(uid).inline_keyboard[0],
      ...confirmKeyboard(uid).inline_keyboard[0],
    ];
    const allowed = new Set(['primary', 'success', 'danger']);
    const expect = {
      'Mark contacted': { cb: 'c:' + uid, style: 'primary' },
      'Job completed': { cb: 'd:' + uid, style: 'primary' },
      'Yes, send review request': { cb: 'y:' + uid, style: 'success' },
      'Cancel': { cb: 'n:' + uid, style: 'danger' },
    };
    const ok = allBtns.length === 4 && allBtns.every((b) => allowed.has(b.style) && expect[b.text] && b.callback_data === expect[b.text].cb && b.style === expect[b.text].style);
    line(ok, 'C11c', 'button styles allowed, callback_data unchanged', `btns=${allBtns.map((b) => b.text + ':' + b.style).join(',')}`);
  }

  /* C15: /help same text linked + unlinked, no lead data */
  {
    await reset();
    await good(msg(chatB, '/help'));
    const helpLinked = await sent();
    const linkedText = helpLinked.filter((x) => x.path.includes('/sendMessage')).map((x) => x.body.text).join('\n');
    await reset();
    await good(msg(chatX, '/help'));
    const helpUnlinked = await sent();
    const unlinkedText = helpUnlinked.filter((x) => x.path.includes('/sendMessage')).map((x) => x.body.text).join('\n');
    const hasLeadsRef = linkedText.includes('/leads') && unlinkedText.includes('/leads');
    const noLeadData = !/Recent requests|Status:/.test(linkedText) && !/Recent requests|Status:/.test(unlinkedText);
    line(linkedText === unlinkedText && linkedText.length > 0 && hasLeadsRef && noLeadData,
      'C15', '/help same text linked + unlinked, no lead data', `linked=${linkedText.length} unlinked=${unlinkedText.length}`);
  }

  /* C16: /leads from unlinked still returns no lead data (assert only) */
  {
    await reset();
    await good(msg(chatX, '/leads'));
    const leadsSent = await sent();
    const unlinkedLeads = leadsSent.filter((x) => x.path.includes('/sendMessage')).map((x) => x.body.text).join('\n');
    line(unlinkedLeads.includes('not linked') && !/Recent requests/.test(unlinkedLeads),
      'C16', '/leads unlinked returns no lead data', `textLen=${unlinkedLeads.length}`);
  }

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
