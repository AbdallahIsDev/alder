#!/usr/bin/env node
// tests/webhook.test.mjs — Gate C.
// HARNESS: in-process handler call with fake Telegram server, real Supabase database.
// Run through tests/run.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.mjs';
import { createClient } from '@supabase/supabase-js';
import { fakeRes, ALDER_DEMO, sweepTestLeads, fixtureEmail } from './helpers.mjs';
import { FIXTURE_CHATS } from './fixture-ids.mjs';

loadEnv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TG = process.env.FAKE_TG_URL;
if (!TG) { console.log('FAIL  pre  run through tests/run.mjs'); process.exit(1); }

const { default: tgHandler } = await import('../api/tg.js');
const { createBindCode, claimBindCode, restoreBindCode, expireLiveBindCodes } = await import('../lib/db.js');
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

const RUN_STARTED = new Date().toISOString();
const chatA = FIXTURE_CHATS.webhookA, chatB = FIXTURE_CHATS.webhookB, chatX = FIXTURE_CHATS.webhookX;
const bindA = FIXTURE_CHATS.webhookBindA, bindB = FIXTURE_CHATS.webhookBindB, bindX = FIXTURE_CHATS.webhookBindX;
// Every fixture id this suite may bind, for the start-of-suite and finally sweeps.
const WEBHOOK_CHATS = [chatA, chatB, chatX, bindA, bindB, bindX,
  FIXTURE_CHATS.webhookA2, FIXTURE_CHATS.webhookA3,
  FIXTURE_CHATS.webhookOpA, FIXTURE_CHATS.webhookOpB, FIXTURE_CHATS.webhookOperator];

const { data: bizA } = await svc.from('businesses').select('id').eq('slug', ALDER_DEMO).single();
const { data: bizB } = await svc.from('businesses').select('id').eq('slug', 'second-demo').single();

// A throwaway business for every /code mint. Real businesses must never carry
// a suite-minted code: the owner's /invite cap counts live unused rows, and a
// killed run would leave ten of them behind. status must be demo/active because
// /code resolves through getActiveBusinessBySlug; it is deleted in the finally.
const CODE_SLUG = `zz-test-${RUN}`;
let codeBiz = null;
// A second throwaway for every bind test. No suite may mint a code on a real
// business: the code is what /invite's cap counts, and a killed run leaves it.
const BIND_SLUG = `zz-test-bind-${RUN}`;
let bindBiz = null;
const INV_SLUG = `zz-test-inv-${RUN}`;
let invBiz = null;
// Clear throwaways a killed run left behind (never a live one: the runner is
// sequential, and the predicate is the reserved slug prefix).
await svc.from('businesses').delete().like('slug', 'zz-test-%').lt('created_at', RUN_STARTED);
({ data: codeBiz } = await svc.from('businesses').insert({
  slug: CODE_SLUG, name: 'ZZ Code Fixture', owner_email: 'code@zz-test.invalid',
  google_review_url: 'https://g.page/r/zz-code', timezone: 'America/Chicago', status: 'demo',
}).select('id, slug, name').single());
if (!codeBiz) throw new Error('could not create the zz-test business');
({ data: bindBiz } = await svc.from('businesses').insert({
  slug: BIND_SLUG, name: 'ZZ Bind Fixture', owner_email: 'bind@zz-test.invalid',
  google_review_url: 'https://g.page/r/zz-bind', timezone: 'America/Chicago', status: 'demo',
}).select('id, slug, name').single());
if (!bindBiz) throw new Error('could not create the zz-test bind business');

const createdLeads = [];
const createdCodes = [];

async function seedLead(businessId, name, email) {
  // Every seeded lead carries the reserved fixture marker, so a sweep needs two
  // signals before deleting it. The empty-email case is deleted by exact key.
  const marked = email ? String(email).replace(/@example\.com$/, '@fixture.invalid') : email;
  const { data } = await svc.from('leads').insert({
    business_id: businessId, name, phone: '5155550100', email: marked, zip: '50265',
    service: 'repair', home: 'house', timing: 'asap', roof_age: 'Not sure',
    insurance_claim: false, notes: null, idempotency_key: `${RUN}-${mkCode(8)}`,
  }).select('id').single();
  if (data) createdLeads.push(data.id);
  return data && data.id;
}

try {
  // Clear what a killed run left behind, before adding anything of our own.
  await sweepTestLeads(svc, [bizA.id, bizB.id], RUN_STARTED).catch(() => 0);
  // Clear anything a killed run left bound, before this run binds its own.
  try { await svc.from('business_chats').delete().in('tg_chat_id', WEBHOOK_CHATS); } catch { /* best effort */ }
  await control({ mode: 'ok' }); await reset(); await resetResend();

  // chatA and chatB are bound up front: the bind tests below use their own
  // throwaway chats and business, so nothing here depends on a minted code.
  {
    const t0 = Date.now();
    await svc.from('business_chats').insert([
      { business_id: bizA.id, tg_chat_id: chatA, created_at: new Date(t0 - 5000).toISOString() },
      { business_id: bizB.id, tg_chat_id: chatB, created_at: new Date(t0 - 4000).toISOString() },
    ]);
  }

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
  await createBindCode(code1, bindBiz.id, new Date(Date.now() + 3600000).toISOString());
  await reset();
  await good(msg(bindA, '/start ' + code1));
  const bound1 = (await svc.from('business_chats').select('business_id').eq('tg_chat_id', bindA).maybeSingle()).data;
  const confirmation = (await sent()).map((x) => x.body && x.body.text).join(' ');
  line(group.code === 200 && !!bound1 && bound1.business_id === bindBiz.id && confirmation.includes('ZZ Bind Fixture'),
    'C4', 'valid /start CODE binds once and names business', `bound=${!!bound1}`);

  await reset();
  await good(msg(bindX, '/start ' + code1));
  const second = (await svc.from('bind_codes').select('used_at').eq('code', code1).single()).data;
  const secondText = (await sent()).map((x) => x.body && x.body.text).join(' ');
  // Before (bot copy): 'That link is not valid. Ask for a new one.'
  // After: "That setup link isn't valid or has expired.\n\nAsk for a new one."
  line(!!second.used_at && secondText.includes("isn't valid or has expired"), 'C5', 'same code cannot be used twice', secondText.slice(0, 60));

  /* expired code */
  const expired = mkCode(12); createdCodes.push(expired);
  await createBindCode(expired, bindBiz.id, new Date(Date.now() - 60000).toISOString());
  await reset();
  await good(msg(bindX, '/start ' + expired));
  const expText = (await sent()).map((x) => x.body && x.body.text).join(' ');
  const expUsed = (await svc.from('bind_codes').select('used_at').eq('code', expired).single()).data;
  line(!expUsed.used_at && expText.includes("isn't valid or has expired"), 'C6', 'expired code rejected, not consumed');

  /* second business + /leads isolation */
  const code2 = mkCode(12); createdCodes.push(code2);
  await createBindCode(code2, bindBiz.id, new Date(Date.now() + 3600000).toISOString());
  await reset();
  await good(msg(bindB, '/start ' + code2));
  // Seeds are order-independent (unique idempotency keys per lead).
  // Promise.all keeps the input order in its result, but the pushes into
  // createdLeads happen in completion order — so createdLeads[3] is a bizA lead
  // about half the time and C9's c: from chatB is then correctly refused.
  // Use the returned ids, which are deterministic.
  const [aLead1, , bLead1] = await Promise.all([
    seedLead(bizA.id, 'Alpha Only', 'alpha@example.com'),
    seedLead(bizA.id, 'Alpha Two', 'alpha2@example.com'),
    seedLead(bizB.id, 'Beta Only', 'beta@example.com'),
    seedLead(bizB.id, 'Beta Two', 'beta2@example.com'),
  ]);

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
  // 'q:' stands in for an unknown kind: 'x:' became a real recipient callback
  // when /recipients landed, so it is no longer a malformed example.
  for (const bad of ['q:' + aLead1, 'c:not-a-uuid', 'r:not-a-uuid', 'cd:00000000-0000-0000-0000-000000000000', 'c:' + aLead1 + 'extra']) {
    await good(cb(chatB, bad));
  }
  const malformedStatus = (await svc.from('leads').select('status').eq('id', aLead1).single()).data.status;
  const malformedSent = await sent();
  line(malformedStatus === 'open' && malformedSent.every((x) => !x.path.includes('/editMessageText')),
    'C8b', 'malformed callback_data ignored, no edit', `status=${malformedStatus} edits=${malformedSent.filter((x) => x.path.includes('/editMessageText')).length}`);

  /* NEW FLOW (item 3): d: now only asks for confirmation; it never emails or changes status */
  await resetResend();
  const askLead = bLead1;   // a bizB lead: chatB is bound to bizB
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
  // Before (26-char rule): label 'Yes, send review request' + text
  // 'Send a review request to Seq'. After: label 'Send request' (fits the
  // bubble) + nameless 'Send a review request?'.
  const s2Kb = edits2.length === 1 && JSON.stringify(edits2[0].body.reply_markup)
    === JSON.stringify({ inline_keyboard: [[
      { text: 'Send request', callback_data: 'y:' + seqLead, style: 'success' },
      { text: 'Cancel', callback_data: 'n:' + seqLead, style: 'danger' }]] })
    && edits2[0].body.text.includes('Send a review request?');
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
      // Before (26-char rule): '⚠️ Review request couldn't be sent' (34 chars).
      // After: '⚠️ Review email failed' (fits 26).
      && failEdits[0].body.text.includes('⚠️ Review email failed');
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

    // C33: two r: callbacks fired at the same time send exactly one email.
    // Both pass the "done and nothing sent yet" checks before either writes, so
    // without a compare-and-set both would send. rate_limits is the CAS.
    const raceLead = await seedLead(bizB.id, 'Race Retry', 'raceretry@example.com');
    await resendCtrl({ mode: '500' });
    await good(cb(chatB, 'c:' + raceLead));
    await good(cb(chatB, 'd:' + raceLead));
    await good(cb(chatB, 'y:' + raceLead));            // email fails -> error view
    await resendCtrl({ mode: 'ok' });
    await resetResend();
    await svc.from('rate_limits').delete().eq('key', 'retry:' + raceLead);
    await Promise.all([good(cb(chatB, 'r:' + raceLead)), good(cb(chatB, 'r:' + raceLead))]);
    const raceEmails = (await resendCalls()).length;
    const raceRow = (await svc.from('leads').select('status').eq('id', raceLead).single()).data;
    line(raceEmails === 1 && raceRow.status === 'done',
      'C33', 'two r: at once -> exactly one send', `emails=${raceEmails} status=${raceRow.status}`);

    // C34/C35: the retry mutex is a 10 s bucket in rate_limits. A claim left
    // behind by an invocation that died before its finally block stops blocking
    // as soon as the clock leaves that bucket, so a stale lock costs at most 10 s.
    const mkFailedRetry = async (label, email) => {
      const id = await seedLead(bizB.id, label, email);
      await resendCtrl({ mode: '500' });
      await good(cb(chatB, 'c:' + id));
      await good(cb(chatB, 'd:' + id));
      await good(cb(chatB, 'y:' + id));         // review email fails
      await resendCtrl({ mode: 'ok' });
      await resetResend();
      return id;
    };

    {
      const staleLead = await mkFailedRetry('Stale Lock', 'stalelock@example.com');
      await svc.from('rate_limits').delete().eq('key', 'retry:' + staleLead);
      await svc.from('rate_limits').insert({
        key: 'retry:' + staleLead,
        window_start: new Date(Date.now() - 60000).toISOString(),
        count: 1,
      });
      await good(cb(chatB, 'r:' + staleLead));
      const emails = (await resendCalls()).length;
      line(emails === 1, 'C34', 'stale retry claim (older bucket) does not block', `emails=${emails}`);
    }

    {
      const lockLead = await mkFailedRetry('Live Lock', 'livelock@example.com');
      // Same guard as db-wall test 6: do not straddle a bucket boundary.
      const msLeft = 10000 - (Date.now() % 10000);
      if (msLeft < 3000) await new Promise((r) => setTimeout(r, msLeft + 50));
      // Claim through the same RPC the handler uses, so the bucket comes from the
      // database clock rather than this machine's (they are not the same clock,
      // and a manual insert landed in a different bucket).
      await svc.from('rate_limits').delete().eq('key', 'retry:' + lockLead);
      await svc.rpc('hit_rate_limit', { p_key: 'retry:' + lockLead, p_window_seconds: 10, p_max: 1 });
      await good(cb(chatB, 'r:' + lockLead));
      const emails = (await resendCalls()).length;
      const sentFlag = await svc.from('lead_events').select('id').eq('lead_id', lockLead).eq('kind', 'review_requested');
      line(emails === 0 && (sentFlag.data || []).length === 0, 'C35',
        'live retry claim blocks the send', `emails=${emails}`);
    }

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
    await resendCtrl({ mode: 'hang_once', hangMs: 2500 });
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
    await resendCtrl({ mode: 'hang_once', hangMs: 2500 });
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
    await resendCtrl({ mode: 'hang_once', hangMs: 2500 });
    await resetResend();
    await good(cb(chatB, 'y:' + bLead));
    const bFirst = await keyOf();
    await resendCtrl({ mode: 'hang_once', hangMs: 2500 });
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
    await resendCtrl({ mode: 'hang_once', hangMs: 2500 });
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

  /* Post-transition failure (static): nothing between transitionLead and the
     email attempt can be made to throw without changing production code —
     the only query there (status_changed insert) is already caught, and
     render() swallows its own read. So assert the y: post-transition wrap
     exists in source: it logs tg_callback_failed, renders the error view
     with one r: button when the lead has an email, and the no-email done
     view otherwise, with no second answer. */
  {
    const src = fs.readFileSync(path.join(ROOT, 'api', 'tg.js'), 'utf8');
    // Anchors are the handler boundaries, not the old inline `if (kind === 'y')`
    // branches: the y: body now lives in onConfirm, the r: body in onRetry.
    const yBlock = src.slice(src.indexOf('async function onConfirm'), src.indexOf('async function onRetry'));
    const hasTry = yBlock.includes('} catch (e) {') && yBlock.includes("console.error('tg_callback_failed'");
    const errorView = yBlock.includes("render('error', { reply_markup: tryAgainKeyboard(leadId) }, 'failed')");
    const noEmailView = yBlock.includes("render('done', { reply_markup: { inline_keyboard: [] } }, 'no_email')");
    // Slice the catch body itself: a regex bounded by [^}] would stop at the first
    // inner brace and miss an answer() that sits after it.
    const noSecondAnswer = !yBlock.slice(yBlock.lastIndexOf('} catch (e) {')).includes('answer(');
    line(hasTry && errorView && noEmailView && noSecondAnswer,
      'C31', 'y: post-transition wrap renders error (or no-email done) on throw',
      `try=${hasTry} error=${errorView} noEmail=${noEmailView} innerCatchAnswers=${!noSecondAnswer}`);
  }

  /* C36: the answer-once guard, behaviourally. A callback whose handler would
     answer twice (a branch that answers, then an error path that answers again)
     must reach Telegram exactly once, and with the FIRST text. Exercised through
     the real answerCallbackQuery -> lib/tg.js -> fake server path, so removing
     the guard shows up as two requests, not as a source-text mismatch. */
  {
    const { createAnswerOnce } = await import('../api/tg.js');
    await reset();
    const answer = createAnswerOnce('cb-guard-' + Math.random().toString(36).slice(2, 8));
    await answer('');
    await answer('Something went wrong. Try again.');
    await answer('third');
    const calls = (await sent()).filter((r) => r.path.includes('/answerCallbackQuery'));
    const firstOnly = calls.length === 1 && calls[0].body && calls[0].body.callback_query_id.startsWith('cb-guard-');
    line(firstOnly, 'C36', 'answer-once: two answers reach Telegram once',
      `calls=${calls.length} first=${calls[0] && calls[0].body ? 'yes' : 'no'}`);
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

  /* No-email confirm flow: first button reads "Mark done", y: ends with the
     no-email done view (unchanged outcome, shorter copy). */
  {
    const noMailLead = await seedLead(bizB.id, 'No Mail Tester', '');
    await resetResend();
    await good(cb(chatB, 'c:' + noMailLead));
    await reset();
    await good(cb(chatB, 'd:' + noMailLead));
    const nmEdits = (await sent()).filter((x) => x.path.includes('/editMessageText'));
    const nmKbOk = nmEdits.length === 1 && JSON.stringify(nmEdits[0].body.reply_markup)
      === JSON.stringify({ inline_keyboard: [[
        { text: 'Mark done', callback_data: 'y:' + noMailLead, style: 'success' },
        { text: 'Cancel', callback_data: 'n:' + noMailLead, style: 'danger' }]] })
      && nmEdits[0].body.text.includes('No email on file.')
      && nmEdits[0].body.text.includes("Can't send a request.");
    await reset();
    await good(cb(chatB, 'y:' + noMailLead));
    const nmDone = (await sent()).filter((x) => x.path.includes('/editMessageText'));
    const nmDoneOk = nmDone.length === 1 && nmDone[0].body.text.includes('✅ Status: Done')
      && nmDone[0].body.text.includes('ℹ️ No email, none sent.');
    line(nmKbOk && nmDoneOk, 'C32', 'no-email confirm: Mark done label, y: ends done/no-email',
      `kb=${nmKbOk} done=${nmDoneOk}`);
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
  // The tap is refused (no DB change) but the card is refreshed in place and
  // the toast says "Already updated." instead of "Not found.".
  const guardToast = guardSent.filter((x) => x.path.includes('/answerCallbackQuery'))
    .map((x) => (x.body && x.body.text) || '').join('|');
  line(doneAfter.status === 'done' && doneAfter.review_token === doneBefore.review_token
    && eventsAfter === eventsBefore && guardEdits.length === 1 && guardAnswered
    && guardToast.includes('Already updated'),
    'C13b', 'Contacted on done lead -> no DB change, refreshed, Already updated',
    `status=${doneAfter.status} edits=${guardEdits.length} toast=${guardToast}`);

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
  // Second tap: one transition, and the stale card is refreshed to the current
  // state (one edit per tap), so both taps leave the same card on screen.
  line(ccRow.status === 'contacted' && ccEvents === 1 && ccEdits.length === 2 && ccAnswers.length === 2,
    'C14', 'double tap Contacted -> one change, both cards refreshed', `status=${ccRow.status} events=${ccEvents} edits=${ccEdits.length} answers=${ccAnswers.length}`);

  /* C11c: every button style is allowed and callback_data is unchanged */
  {
    const { alertKeyboard, jobDoneKeyboard, confirmKeyboard } = await import('../lib/content.js');
    const uid = '00000000-0000-4000-8000-000000000001';
    const allBtns = [
      ...alertKeyboard(uid).inline_keyboard[0],
      ...jobDoneKeyboard(uid).inline_keyboard[0],
      ...confirmKeyboard(uid, true).inline_keyboard[0],
    ];
    const allowed = new Set(['primary', 'success', 'danger']);
    // Before (26-char rule): 'Yes, send review request'. After: 'Send request'.
    const expect = {
      'Mark contacted': { cb: 'c:' + uid, style: 'primary' },
      'Job completed': { cb: 'd:' + uid, style: 'primary' },
      'Send request': { cb: 'y:' + uid, style: 'success' },
      'Cancel': { cb: 'n:' + uid, style: 'danger' },
    };
    const ok = allBtns.length === 4 && allBtns.every((b) => allowed.has(b.style) && expect[b.text] && b.callback_data === expect[b.text].cb && b.style === expect[b.text].style);
    line(ok, 'C11c', 'button styles allowed, callback_data unchanged', `btns=${allBtns.map((b) => b.text + ':' + b.style).join(',')}`);
  }

  /* C15: /help bound vs unbound, no lead data either way.
     Before (bot copy): identical COMMAND_HELP text for both, mentioning
     /leads. After: bound gets BOT_HELP, unbound gets BOT_NOT_CONNECTED
     (which deliberately does not mention /leads either). */
  {
    const { BOT_HELP, BOT_NOT_CONNECTED } = await import('../lib/content.js');
    await reset();
    await good(msg(chatB, '/help'));
    const helpLinked = await sent();
    const linkedText = helpLinked.filter((x) => x.path.includes('/sendMessage')).map((x) => x.body.text).join('\n');
    await reset();
    await good(msg(chatX, '/help'));
    const helpUnlinked = await sent();
    const unlinkedText = helpUnlinked.filter((x) => x.path.includes('/sendMessage')).map((x) => x.body.text).join('\n');
    const noLeadData = !/Recent requests|Status:/.test(linkedText) && !/Recent requests|Status:/.test(unlinkedText);
    line(linkedText === BOT_HELP && unlinkedText === BOT_NOT_CONNECTED && noLeadData,
      'C15', '/help bound/unbound get exact new copy, no lead data', `linked=${linkedText.length} unlinked=${unlinkedText.length}`);
  }

  /* C16: /leads from unlinked still returns no lead data (assert only).
     Before: "This chat is not linked…". After: BOT_NOT_CONNECTED; the security
     meaning (no business data) is unchanged. */
  {
    const { BOT_NOT_CONNECTED } = await import('../lib/content.js');
    await reset();
    await good(msg(chatX, '/leads'));
    const leadsSent = await sent();
    const unlinkedLeads = leadsSent.filter((x) => x.path.includes('/sendMessage')).map((x) => x.body.text).join('\n');
    line(unlinkedLeads === BOT_NOT_CONNECTED && !/Recent requests/.test(unlinkedLeads),
      'C16', '/leads unlinked returns NOT CONNECTED, no lead data', `textLen=${unlinkedLeads.length}`);
  }

  /* D: bot copy constants (exact text, no multi-tenant wording) + plain-text
     hint flows + sticker silence. */
  {
    const C = await import('../lib/content.js');
    const all = [
      C.botLinkedText('Alder Roofing (demo)'), C.BOT_HELP, C.BOT_ALREADY_CONNECTED,
      C.BOT_NOT_CONNECTED, C.BOT_BAD_CODE, C.BOT_PLAIN_TEXT,
      C.BOT_DESCRIPTION, C.BOT_SHORT_DESCRIPTION,
    ];
    const banned = /another|other (roofer|business|compan)|roofers|administrator|provider|move it|shared|multiple/i;
    const exactOk = C.botLinkedText('Alder Roofing (demo)') === `You're connected to Alder Roofing (demo). ✅\n\nNew estimate requests from your website will appear here the moment they come in.\n\nFor each request:\n• Tap Mark contacted after you call the customer.\n• Tap Job completed when the work is done. You can then send the customer a review request.\n\nSend /leads to see your latest requests, or /help any time.`
      && C.BOT_HELP === `How this works\n\nNew estimate requests from your website appear here as soon as they come in.\n\nFor each request:\n• Mark contacted after you call the customer.\n• Job completed when the work is done, to send a review request.\n\nCommands:\n/leads · your latest requests\n/invite · connect a second phone\n/recipients · who receives alerts\n/help · this message`
      && C.BOT_ALREADY_CONNECTED === `You're all set. New requests will appear here.\n\nSend /help to see what I can do.`
      && C.BOT_NOT_CONNECTED === `This chat isn't connected yet.\n\nIf you were sent a setup link, tap it and press Start. If you have a setup code, send it to me here.\n\nNo link or code? Ask the person who set up your lead alerts for a new one.`
      && C.BOT_BAD_CODE === `That setup link isn't valid or has expired.\n\nAsk for a new one.`
      && C.BOT_PLAIN_TEXT === `I only respond to commands.\n\nSend /leads to see your latest requests, or /help.`
      && C.BOT_DESCRIPTION === `Get your website's new estimate requests here the moment they arrive. To connect, open the setup link you were given.`
      && C.BOT_SHORT_DESCRIPTION === `New estimate requests from your website, delivered instantly.`;
    const bannedOk = all.every((t) => !banned.test(t)) && !banned.test('Alder Roofing (demo)');
    const lengthsOk = C.BOT_DESCRIPTION.length <= 512 && C.BOT_SHORT_DESCRIPTION.length <= 120;
    line(exactOk && bannedOk && lengthsOk, 'D1', 'bot strings exact, no multi-tenant wording, desc lengths',
      `exact=${exactOk} banned=${bannedOk} descLen=${C.BOT_DESCRIPTION.length}/${C.BOT_SHORT_DESCRIPTION.length}`);
  }
  {
    const { BOT_NOT_CONNECTED, BOT_PLAIN_TEXT, BOT_ALREADY_CONNECTED_CODE } = await import('../lib/content.js');
    const textOf = async () => (await sent()).filter((x) => x.path.includes('/sendMessage')).map((x) => x.body.text).join('\n');

    // Unbound /start with no code → NOT CONNECTED.
    await reset();
    await good(msg(chatX, '/start'));
    line((await textOf()) === BOT_NOT_CONNECTED, 'D2', 'unbound /start no code → NOT CONNECTED');

    // Bound /start with a fresh valid code → ALREADY CONNECTED, code NOT consumed.
    const fresh = mkCode(12); createdCodes.push(fresh);
    await createBindCode(fresh, bindBiz.id, new Date(Date.now() + 3600000).toISOString());
    await reset();
    await good(msg(bindB, '/start ' + fresh));
    const freshUsed = (await svc.from('bind_codes').select('used_at').eq('code', fresh).single()).data;
    line((await textOf()) === BOT_ALREADY_CONNECTED_CODE && !freshUsed.used_at,
      'D3', 'bound /start with code → already connected, code not consumed');

    // Plain text: bound → hint (max 3/hour), then silence; unbound → NOT CONNECTED.
    const hintCounts = [];
    for (let i = 0; i < 4; i++) {
      await reset();
      await good(msg(chatB, 'hello there ' + i));
      hintCounts.push((await textOf()).length > 0 ? 1 : 0);
    }
    await reset();
    await good(msg(chatX, 'hello there'));
    const unboundHint = await textOf();
    await reset();
    await good(msg(chatX, 'hello again'));
    const unboundHint2 = await textOf();
    line(hintCounts.join(',') === '1,1,1,0' && unboundHint === BOT_NOT_CONNECTED && unboundHint2 === BOT_NOT_CONNECTED,
      'D4', 'plain text: bound hint x3 then silent; unbound NOT CONNECTED',
      `bound=${hintCounts.join(',')}`);

    // Sticker/photo (no text) → no reply.
    await reset();
    await good({ message: { message_id: 101, chat: { id: chatB, type: 'private' }, sticker: { file_id: 'x' } } });
    await good({ message: { message_id: 102, chat: { id: chatB, type: 'private' }, photo: [{ file_id: 'y' }] } });
    const quiet = await sent();
    line(quiet.length === 0 && (await resendCalls()).length === 0,
      'D5', 'sticker/photo updates get no reply', `calls=${quiet.length}`);
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
  /* ---------- operator commands, owner role, lead recovery ---------- */
  {
    const OP = FIXTURE_CHATS.webhookOperator;
    const chatA2 = FIXTURE_CHATS.webhookA2;   // second phone on bizA
    const chatA3 = FIXTURE_CHATS.webhookA3;   // third phone, removed by the operator
    const savedOp = process.env.OPERATOR_CHAT_ID;
    const savedUser = process.env.TELEGRAM_BOT_USERNAME;
    process.env.OPERATOR_CHAT_ID = String(OP);
    process.env.TELEGRAM_BOT_USERNAME = 'alder_test_bot';
    // Edits matter as much as new messages here: the confirm screen and the
    // refreshed card are edits.
    const allText = async () => (await sent())
      .filter((x) => x.path.includes('/sendMessage') || x.path.includes('/editMessageText'))
      .map((x) => x.body.text).join('\n');
    const answersNow = async () => (await sent()).filter((x) => x.path.includes('/answerCallbackQuery'))
      .map((x) => (x.body && x.body.text) || '').join('|');
    try {
      // Ownership order, without minting a code on a real business. Explicit,
      // distinct created_at: one INSERT gives every row the same timestamp.
      await svc.from('business_chats').delete().in('tg_chat_id', [chatA, chatA2, chatA3]);
      {
        const t0 = Date.now();
        await svc.from('business_chats').insert([
          { business_id: bizA.id, tg_chat_id: chatA, created_at: new Date(t0 - 3000).toISOString() },
          { business_id: bizA.id, tg_chat_id: chatA2, created_at: new Date(t0 - 2000).toISOString() },
          { business_id: bizA.id, tg_chat_id: chatA3, created_at: new Date(t0 - 1000).toISOString() },
        ]);
      }
      const C = await import('../lib/content.js');

      // OP1: a non-operator gets exactly the unknown-text reply, and no code.
      await reset();
      const codesBefore = (await svc.from('bind_codes').select('code').eq('business_id', bizA.id)).data.length;
      await good(msg(chatA, '/code alder-demo'));
      const codesAfter = (await svc.from('bind_codes').select('code').eq('business_id', bizA.id)).data.length;
      line((await allText()) === C.BOT_PLAIN_TEXT && codesAfter === codesBefore, 'OP1',
        'non-operator /code gets the plain-text hint, mints nothing',
        `codes ${codesBefore}->${codesAfter}`);

      // OP2: exactly TWO messages. The first names the slug; the second is the
      // only forwardable text and must not name the business.
      await reset();
      await good(msg(OP, `/code ${CODE_SLUG}`));
      const pair = (await sent()).filter((x) => x.path.includes('/sendMessage')).map((x) => x.body.text);
      const opLine = pair[0] || '';
      const forward = pair[1] || '';
      // Take the code from the forward text, then prove the database has it:
      // row order is not guaranteed, so picking "the last row" proved nothing.
      const theCode = (forward.match(/\?start=([A-Z2-9]{12})/) || [])[1] || '';
      const stored = theCode
        ? (await svc.from('bind_codes').select('code, used_at').eq('code', theCode).eq('business_id', codeBiz.id)).data
        : [];
      line(pair.length === 2 && !!theCode && stored.length === 1 && stored[0].used_at === null
        && opLine.includes(CODE_SLUG) && /expires in 24 hours/i.test(opLine)
        && !opLine.includes('?start=') && forward.includes('send it this code')
        && !forward.includes(CODE_SLUG) && !forward.includes('send me'),
        'OP2', 'operator /code: two messages, slug only in the first',
        `messages=${pair.length} code=${theCode.slice(0, 4)}… stored=${stored.length}`);

      // OP3: cap per slug, fail closed at 10/hour. OP2 already used one slot,
      // so clear the bucket to measure the cap itself.
      await svc.from('rate_limits').delete().eq('key', 'opcode:' + CODE_SLUG);
      let okCount = 0, capped = false;
      for (let i = 0; i < 11; i++) {
        await reset();
        await good(msg(OP, `/code ${CODE_SLUG}`));
        const t = await allText();
        if (t === C.OPERATOR_CAPPED) capped = true; else okCount++;
      }
      line(okCount === 10 && capped, 'OP3', 'operator /code capped at 10 per slug per hour', `ok=${okCount} capped=${capped}`);

      // OP14: the second message fails. The code is still valid, so the
      // operator must be told the forward text did not send and get it again.
      await reset();
      await svc.from('rate_limits').delete().eq('key', 'opcode:' + CODE_SLUG);
      await control({ mode: 'fail_nth', nth: 2 });
      await good(msg(OP, `/code ${CODE_SLUG}`));
      const afterFail = (await sent()).filter((x) => x.path.includes('/sendMessage')).map((x) => x.body.text);
      await control({ mode: 'ok' });
      const resend = afterFail[2] || '';
      const resendCode = (resend.match(/\b([A-Z2-9]{12})\b/) || [])[1] || '';
      line(afterFail.length === 3 && /did not send/.test(resend) && !!resendCode
        && resend.includes(resendCode),
        'OP14', 'forward send fails: operator gets the code back', `messages=${afterFail.length}`);

      // OP15: a slug with injection characters is a usage error, and nothing
      // is minted. The slug regex is the only gate that matters here.
      await reset();
      const codesBeforeBad = (await svc.from('bind_codes').select('code').eq('business_id', bizA.id)).data.length;
      await good(msg(OP, '/code alder-demo;drop'));
      const badReply = await allText();
      const codesAfterBad = (await svc.from('bind_codes').select('code').eq('business_id', bizA.id)).data.length;
      line(badReply === C.OPERATOR_USAGE_CODE && codesAfterBad === codesBeforeBad,
        'OP15', 'injection-shaped slug: usage text, no code minted',
        `codes ${codesBeforeBad}->${codesAfterBad}`);

      // OP16: two /code taps mint two different, valid codes (the cap is the
      // only limit, and the bucket was cleared above).
      await reset();
      await svc.from('rate_limits').delete().eq('key', 'opcode:' + CODE_SLUG);
      await good(msg(OP, `/code ${CODE_SLUG}`));
      await good(msg(OP, `/code ${CODE_SLUG}`));
      const two = (await sent()).filter((x) => x.path.includes('/sendMessage')).map((x) => x.body.text);
      const codes = two.map((t) => (t.match(/\?start=([A-Z2-9]{12})/) || [])[1]).filter(Boolean);
      line(codes.length === 2 && codes[0] !== codes[1] && two.length === 4,
        'OP16', 'two /code taps: two distinct codes, two messages each',
        `codes=${codes.length} unique=${new Set(codes).size} messages=${two.length}`);

      // OP17-OP20 run against real rows on a throwaway business: the cancel
      // flow and the claim restore are SQL, and the in-memory fake cannot
      // prove the predicates.
      const invOwner = FIXTURE_CHATS.webhookInvOwner, invStaff = FIXTURE_CHATS.webhookInvStaff;
      await svc.from('business_chats').delete().in('tg_chat_id', [invOwner, invStaff]);
      if (!invBiz) {
        ({ data: invBiz } = await svc.from('businesses').insert({
          slug: INV_SLUG, name: 'ZZ Invite Fixture', owner_email: 'inv@zz-test.invalid',
          google_review_url: 'https://g.page/r/zz-inv', timezone: 'America/Chicago', status: 'demo',
        }).select('id').single());
        if (!invBiz) throw new Error('could not create the zz-test invite business');
      }
      {
        const t0 = Date.now();
        await svc.from('business_chats').insert([
          { business_id: invBiz.id, tg_chat_id: invOwner, created_at: new Date(t0 - 2000).toISOString() },
          { business_id: invBiz.id, tg_chat_id: invStaff, created_at: new Date(t0 - 1000).toISOString() },
        ]);
      }
      const liveInvites = async () => (await svc.from('bind_codes')
        .select('code, used_at, expires_at').eq('business_id', invBiz.id).is('used_at', null)
        .gt('expires_at', new Date().toISOString())).data || [];
      const soonIso = (h) => new Date(Date.now() + h * 3600000).toISOString();
      const invCodes = ['INVAA' + mkCode(7), 'INVBB' + mkCode(7), 'INVCC' + mkCode(7)];
      for (let i = 0; i < invCodes.length; i++) {
        createdCodes.push(invCodes[i]);
        await createBindCode(invCodes[i], invBiz.id, soonIso(5 + i * 6));
      }

      // OP17: cap lists three, the tap expires them and mints exactly one.
      await reset();
      await good(msg(invOwner, '/invite'));
      const capSend = (await sent()).filter((x) => x.path.includes('/sendMessage')).pop();
      const capText = (capSend && capSend.body.text) || '';
      const capBtn = (capSend && capSend.body.reply_markup && capSend.body.reply_markup.inline_keyboard[0][0]) || {};
      const cappedLive = (await liveInvites()).length;
      await reset();
      await good(cb(invOwner, 'i:c'));
      const afterTap = await liveInvites();
      const oldExpired = (await svc.from('bind_codes').select('code, expires_at')
        .in('code', invCodes)).data.every((r) => new Date(r.expires_at).getTime() <= Date.now() + 1000);
      line(cappedLive === 3 && /3 unused invites/.test(capText) && capBtn.callback_data === 'i:c'
        && afterTap.length === 1 && oldExpired,
        'OP17', 'real DB: cap lists three, tap expires them, one new code',
        `live=${cappedLive}->${afterTap.length} oldExpired=${oldExpired}`);

      // OP18: a second tap inside the mutex mints nothing.
      await reset();
      await good(cb(invOwner, 'i:c'));
      const afterSecond = await liveInvites();
      line(afterSecond.length === 1, 'OP18', 'real DB: double tap mints no second code',
        `live=${afterSecond.length}`);

      // OP19: the expire predicate itself, on real rows. A used code keeps its
      // expiry; only the live one is pushed past now. (The tap's use of this
      // helper is OP17; this pins the WHERE clause against the real database.)
      const usedCode = 'INVDD' + mkCode(7); createdCodes.push(usedCode);
      await createBindCode(usedCode, invBiz.id, soonIso(8));
      const usedBefore = (await svc.from('bind_codes').select('expires_at').eq('code', usedCode).single()).data;
      await reset();
      await good(msg(chatX, '/start ' + usedCode));
      await expireLiveBindCodes(invBiz.id);
      const usedAfter = (await svc.from('bind_codes').select('used_at, expires_at').eq('code', usedCode).single()).data;
      line(!!usedAfter.used_at && usedAfter.expires_at === usedBefore.expires_at && (await liveInvites()).length === 0,
        'OP19', 'real DB: expire leaves a used code and its expiry alone',
        `used=${!!usedAfter.used_at} live=${(await liveInvites()).length}`);

      // OP20: restore after a failed bind. Claim, restore, claim again.
      const restoreCode = 'INVEE' + mkCode(7); createdCodes.push(restoreCode);
      await createBindCode(restoreCode, invBiz.id, soonIso(9));
      const claimed = await claimBindCode(restoreCode);
      const restored = await restoreBindCode(restoreCode, invBiz.id);
      const reclaimed = await claimBindCode(restoreCode);
      line(claimed === invBiz.id && restored === 1 && reclaimed === invBiz.id,
        'OP20', 'real DB: a claim can be restored and claimed again',
        `claimed=${claimed === invBiz.id} restored=${restored}`);

      // OP4: /phones marks the owner (oldest) and lists the others.
      await reset();
      await good(msg(OP, '/phones alder-demo'));
      const phonesText = await allText();
      line(/Phone 1 · main phone/.test(phonesText) && /Phone 3/.test(phonesText), 'OP4',
        '/phones: owner marked, other phones listed', `lines=${phonesText.split('\n').length}`);

      // OP6: a forged p: from a client changes nothing.
      const rows = (await svc.from('business_chats').select('id, tg_chat_id').eq('business_id', bizA.id).order('created_at')).data;
      const thirdRow = rows[rows.length - 1].id;
      await reset();
      await good(cb(chatA2, 'p:' + thirdRow));
      const stillThere = (await svc.from('business_chats').select('id').eq('id', thirdRow)).data.length;
      line((await answersNow()).includes('Not found') && stillThere === 1, 'OP6',
        'forged operator callback from a client: Not found, nothing removed', `rows=${stillThere}`);

      // OP5: the operator asks, then removes.
      await reset();
      await good(cb(OP, 'p:' + thirdRow));
      const confirmText = await allText();
      await reset();
      await good(cb(OP, 'P:' + thirdRow));
      const gone = (await svc.from('business_chats').select('id').eq('id', thirdRow)).data.length;
      line(/Remove it\?/.test(confirmText) && gone === 0, 'OP5',
        'operator remove: confirm, then the row is gone', `confirm=${/Remove it/.test(confirmText)} gone=${gone}`);

      // OP7: /businesses lists both slugs with a phone count.
      await reset();
      await good(msg(OP, '/businesses'));
      const bizText = await allText();
      line(bizText.includes('alder-demo · demo ·') && bizText.includes('second-demo · demo ·'), 'OP7',
        '/businesses: slug, status, phone count', `len=${bizText.length}`);

      // OP8: /id works unbound and says nothing else.
      await svc.from('business_chats').delete().eq('tg_chat_id', chatX);
      await reset();
      await good(msg(chatX, '/id'));
      const idText = await allText();
      line(idText.includes(String(chatX)) && idText.includes('OPERATOR_CHAT_ID') && !idText.includes('alder'), 'OP8',
        '/id: this chat id, unbound, nothing else', `len=${idText.length}`);

      // OP9: paste the code instead of /start; then a bad code from an unbound
      // chat gets one generic answer.
      const pasteCode = mkCode(12); createdCodes.push(pasteCode);
      await createBindCode(pasteCode, bindBiz.id, new Date(Date.now() + 3600000).toISOString());
      await reset();
      await good(msg(bindX, '  ' + pasteCode.slice(0, 4).toLowerCase() + '-' + pasteCode.slice(4).toLowerCase() + ' '));
      const bound = (await svc.from('business_chats').select('business_id').eq('tg_chat_id', bindX).maybeSingle()).data;
      await reset();
      await good(msg(chatA3, mkCode(12)));
      line(!!bound && bound.business_id === bindBiz.id && (await allText()) === C.BOT_CODE_BAD, 'OP9',
        'pasted code binds (case/space/hyphen); a bad one gets one generic answer',
        `bound=${!!bound}`);

      // OP10/OP11 need a business whose ONLY phones are fixtures: on alder-demo
      // the owner's real phones are older, so they are the main phone and a
      // fixture can never exercise ownership transfer. A throwaway business keeps
      // the real binding out of it.
      const OP_SLUG = `op-${RUN}`;
      const { data: opBiz } = await svc.from('businesses').insert({
        slug: OP_SLUG, name: 'OP Fixture', owner_email: 'op@example.com',
        google_review_url: 'https://g.page/r/op', timezone: 'America/Chicago', status: 'demo',
      }).select('id').single();
      const opChatA = FIXTURE_CHATS.webhookOpA, opChatB = FIXTURE_CHATS.webhookOpB;
      // Explicit, distinct created_at: one INSERT gives both rows the same
      // now(), and the id tiebreak would then decide who the main phone is.
      const t0 = Date.now();
      await svc.from('business_chats').insert([
        { business_id: opBiz.id, tg_chat_id: opChatA, created_at: new Date(t0 - 2000).toISOString() },
        { business_id: opBiz.id, tg_chat_id: opChatB, created_at: new Date(t0 - 1000).toISOString() },
      ]);

      // OP10: the second phone cannot invite or list recipients.
      await reset();
      await good(msg(opChatB, '/invite'));
      const t1 = await allText();
      await reset();
      await good(msg(opChatB, '/recipients'));
      const t2 = await allText();
      line(t1 === C.BOT_OWNER_ONLY && t2 === C.BOT_OWNER_ONLY, 'OP10',
        'second phone: /invite and /recipients are owner-only', `invite=${t1.length} recipients=${t2.length}`);

      // OP11: the owner removes itself; the oldest remaining phone becomes owner.
      await reset();
      await good(msg(opChatA, '/recipients'));
      const ownerRows = (await svc.from('business_chats').select('id').eq('business_id', opBiz.id).order('created_at').order('id')).data;
      await good(cb(opChatA, 'x:' + ownerRows[0].id));
      await good(cb(opChatA, 'X:' + ownerRows[0].id));
      await reset();
      await good(msg(opChatB, '/invite'));
      const nowOwner = (await allText()) !== C.BOT_OWNER_ONLY;
      line(nowOwner, 'OP11', 'ownership moves to the oldest remaining phone', `owner=${nowOwner}`);
      await svc.from('businesses').delete().eq('id', opBiz.id);

      // OP12: /leads has Open buttons; o: sends the current card; another
      // business's lead is "Not found.".
      const leadA = await seedLead(bizA.id, 'Open Me', 'open@example.com');
      await reset();
      await good(msg(chatA2, '/leads'));
      const listSent = (await sent()).filter((x) => x.path.includes('/sendMessage'));
      const kb = listSent.length ? JSON.stringify(listSent[listSent.length - 1].body.reply_markup || {}) : '';
      await reset();
      await good(cb(chatA2, 'o:' + leadA));
      const card = await allText();
      const foreign = await seedLead(bizB.id, 'Foreign', 'foreign@example.com');
      await reset();
      await good(cb(chatA2, 'o:' + foreign));
      const foreignAnswer = await answersNow();
      line(kb.includes('o:' + leadA) && card.includes('Open Me') && foreignAnswer.includes('Not found'), 'OP12',
        '/leads Open button -> current card; another business\'s lead is Not found',
        `kb=${kb.includes('o:')} card=${card.includes('Open Me')}`);

      // OP13: my_chat_member (blocked) reaches the operator.
      await svc.from('rate_limits').delete().like('key', 'ops:blocked:%');
      await reset();
      await good({ my_chat_member: { chat: { id: chatA2, type: 'private' }, new_chat_member: { status: 'kicked' } } });
      const blockedText = await allText();
      line(/blocked/.test(blockedText) && blockedText.includes('alder-demo'), 'OP13',
        'blocked bot: one operator notice naming the business', `len=${blockedText.length}`);
    } finally {
      if (savedOp === undefined) delete process.env.OPERATOR_CHAT_ID; else process.env.OPERATOR_CHAT_ID = savedOp;
      if (savedUser === undefined) delete process.env.TELEGRAM_BOT_USERNAME; else process.env.TELEGRAM_BOT_USERNAME = savedUser;
      await svc.from('business_chats').delete().in('tg_chat_id', [chatA, chatA2, chatA3]);
    }
  }

} catch (e) {
  line(false, 'C0', 'webhook suite threw', e.message);
} finally {
  await svc.from('leads').delete().in('id', createdLeads);
  await sweepTestLeads(svc, [bizA.id, bizB.id], new Date().toISOString()).catch(() => 0);
  await svc.from('business_chats').delete().in('tg_chat_id', WEBHOOK_CHATS);
  if (createdCodes.length) await svc.from('bind_codes').delete().in('code', createdCodes);
  // The throwaways and every code minted on them go together (ON DELETE CASCADE).
  if (codeBiz) await svc.from('businesses').delete().eq('id', codeBiz.id);
  if (bindBiz) await svc.from('businesses').delete().eq('id', bindBiz.id);
  if (invBiz) await svc.from('businesses').delete().eq('id', invBiz.id);
  await svc.from('rate_limits').delete().gte('window_start', '2000-01-01');
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
