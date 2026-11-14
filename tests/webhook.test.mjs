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
import { FIXTURE_CHATS, fixtureId } from './fixture-ids.mjs';

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
const unboundKeyboardChat = fixtureId(33);
const bindA = FIXTURE_CHATS.webhookBindA, bindB = FIXTURE_CHATS.webhookBindB, bindX = FIXTURE_CHATS.webhookBindX;
// Every fixture id this suite may bind, for the start-of-suite and finally sweeps.
const WEBHOOK_CHATS = [chatA, chatB, chatX, bindA, bindB, bindX,
  FIXTURE_CHATS.webhookA2, FIXTURE_CHATS.webhookA3,
  FIXTURE_CHATS.webhookOpA, FIXTURE_CHATS.webhookOpB, FIXTURE_CHATS.webhookOperator,
  unboundKeyboardChat];

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
  // A killed run also leaves rate-limit buckets that make the plain-text hints
  // silent for an hour. Fixture ids all start with 5, so this cannot touch a
  // real chat's counter.
  try {
    for (const p of ['tghint:', 'open:', 'bindtry:', 'invite:', 'retry:', 'invitecancel:']) {
      await svc.from('rate_limits').delete().like('key', p + '5%');
    }
  } catch { /* best effort */ }
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
    // the claim has to be re-checked after it is taken and kept on success.
    // C33_LOOP repeats the race with a fresh lead to shake out timing.
    {
      const loops = Math.max(1, Number(process.env.C33_LOOP) || 1);
      let bad = 0, lastEmails = 0, lastStatus = '';
      for (let i = 0; i < loops; i++) {
        const raceLead = await seedLead(bizB.id, `Race Retry ${i}`, `raceretry${i}@example.com`);
        await resendCtrl({ mode: '500' });
        await good(cb(chatB, 'c:' + raceLead));
        await good(cb(chatB, 'd:' + raceLead));
        await good(cb(chatB, 'y:' + raceLead));            // email fails -> error view
        await resendCtrl({ mode: 'ok' });
        await resetResend();
        await svc.from('rate_limits').delete().like('key', 'retry:' + raceLead + '%');
        if (process.env.C33_BOUNDARY) {
          // Park just before a 10 s bucket edge, so the two claims can land in
          // different windows: the exact interleaving that produced the flake.
          for (;;) {
            const left = 10000 - (Date.now() % 10000);
            if (left <= 120) break;
            await new Promise((r) => setTimeout(r, Math.min(left - 100, 20)));
          }
        }
        await Promise.all([good(cb(chatB, 'r:' + raceLead)), good(cb(chatB, 'r:' + raceLead))]);
        lastEmails = (await resendCalls()).length;
        lastStatus = (await svc.from('leads').select('status').eq('id', raceLead).single()).data.status;
        if (lastEmails !== 1 || lastStatus !== 'done') bad++;
      }
      line(bad === 0, 'C33', `two r: at once -> exactly one send (${loops}x)`,
        `bad=${bad}/${loops} lastEmails=${lastEmails} status=${lastStatus}`);
    }

    // C34/C35: the retry lock is keyed by the failure generation. A claim left
    // behind by an invocation that died is cleared once it is 5 minutes old, so
    // a crash costs at most five minutes, not the lead.
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
      const staleKey = 'retry:' + staleLead + ':1';
      await svc.from('rate_limits').delete().eq('key', staleKey);
      await svc.from('rate_limits').insert({
        key: staleKey,
        window_start: new Date(Date.now() - 10 * 60000).toISOString(),
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
      // Claim through the same RPC the handler uses, with the same key shape
      // (failure generation 1) and the same 5-minute window, so it is live.
      const lockKey = 'retry:' + lockLead + ':1';
      await svc.from('rate_limits').delete().eq('key', lockKey);
      await svc.rpc('hit_rate_limit', { p_key: lockKey, p_window_seconds: 300, p_max: 1 });
      await good(cb(chatB, 'r:' + lockLead));
      const emails = (await resendCalls()).length;
      const sentFlag = await svc.from('lead_events').select('id').eq('lead_id', lockLead).eq('kind', 'review_requested');
      line(emails === 0 && (sentFlag.data || []).length === 0, 'C35',
        'live retry claim blocks the send', `emails=${emails}`);
    }

    // C38/C39: concurrent 409 means the original is still in progress, not
    // delivered. The review retry records the unknown outcome and shows failure;
    // a later manual retry can safely reuse that recorded key.
    {
      const { sendMail } = await import('../lib/mail.js');
      const savedRedirect = process.env.MAIL_REDIRECT_TO;
      process.env.MAIL_REDIRECT_TO = 'redirect@example.com';
      await resendCtrl({ mode: 'concurrent' });
      const dup = await sendMail({ to: 'x@example.com', subject: 'S', html: '<p>x</p>', text: 'x', idempotencyKey: 'test:key:1' });
      const noKey = await sendMail({ to: 'x@example.com', subject: 'S', html: '<p>x</p>', text: 'x' });
      await resendCtrl({ mode: 'ok' });
      if (savedRedirect === undefined) delete process.env.MAIL_REDIRECT_TO; else process.env.MAIL_REDIRECT_TO = savedRedirect;
      line(dup.ok === false && dup.status === 'idempotency_concurrent' && noKey.ok === false && Number(noKey.status) === 409,
        'C38', 'mail: concurrent 409 is unknown, never delivery',
        `keyed=${dup.status} noKey=${noKey.status}`);

      const dupLead = await mkFailedRetry('Dup 409', 'dup409@example.com');
      const failsBefore = (await svc.from('lead_events').select('id').eq('lead_id', dupLead).eq('kind', 'review_request_failed')).data.length;
      await resendCtrl({ mode: 'concurrent' });
      await reset();
      await good(cb(chatB, 'r:' + dupLead));
      const dupRow = (await svc.from('leads').select('status').eq('id', dupLead).single()).data;
      const dupEdits = (await sent()).filter((x) => x.path.includes('/editMessageText'));
      const dupSent = (await svc.from('lead_events').select('id').eq('lead_id', dupLead).eq('kind', 'review_requested')).data.length;
      const dupFails = (await svc.from('lead_events').select('id').eq('lead_id', dupLead).eq('kind', 'review_request_failed')).data.length;
      await resendCtrl({ mode: 'ok' });
      line(dupRow.status === 'done' && dupEdits.length === 1 && dupEdits[0].body.text.includes('Review email failed')
        && dupSent === 0 && dupFails === failsBefore + 1,
        'C39', 'review retry on concurrent 409: unknown failure, no sent event',
        `sent=${dupSent} fails=${failsBefore}->${dupFails} edits=${dupEdits.length}`);
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
    await resendCtrl({ mode: 'hang_once', hangMs: 400, hangStatus: 500 });
    await resetResend();
    await good(cb(chatB, 'y:' + cLead));
    await new Promise((resolve) => setTimeout(resolve, 450));
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
    const renderSignature = src.includes('const render = async (view, reviewResult = null) => {');
    const catchBlock = yBlock.slice(yBlock.lastIndexOf('} catch (e) {'));
    const recoveryViews = /if \(result\.lead && result\.lead\.email\) \{\s*await render\('error', 'failed'\);\s*\} else \{\s*await render\('done', 'no_email'\);\s*\}/.test(catchBlock);
    // Slice the catch body itself: a regex bounded by [^}] would stop at the first
    // inner brace and miss an answer() that sits after it.
    const noSecondAnswer = !catchBlock.includes('answer(');
    line(hasTry && renderSignature && recoveryViews && noSecondAnswer,
      'C31', 'y: post-transition wrap renders error (or no-email done) on throw',
      `try=${hasTry} renderSignature=${renderSignature} recovery=${recoveryViews} innerCatchAnswers=${!noSecondAnswer}`);
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
    const { BOT_NOT_CONNECTED, BOT_PLAIN_TEXT, BOT_ALREADY_CONNECTED_CODE, BOT_HELP } = await import('../lib/content.js');
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

    // C37: /command@botname. Only this bot's username is stripped; another
    // bot's suffix is not a command and gets the plain-text answer.
    {
      const savedUser = process.env.TELEGRAM_BOT_USERNAME;
      process.env.TELEGRAM_BOT_USERNAME = 'alder_test_bot';
      await reset();
      await good(msg(chatA, '/help@alder_test_bot'));
      const own = await textOf();
      await reset();
      await good(msg(chatA, '/help@other_bot'));
      const foreign = await textOf();
      await reset();
      await good(msg(chatX, '/help@alder_test_bot'));
      const unbound = await textOf();
      process.env.TELEGRAM_BOT_USERNAME = savedUser;
      line(own === BOT_HELP && foreign === BOT_PLAIN_TEXT && unbound === BOT_NOT_CONNECTED,
        'C37', '@botname: own suffix runs, another bot is plain text',
        `own=${own === BOT_HELP} foreign=${foreign === BOT_PLAIN_TEXT}`);
    }

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
  // OP21: OPERATOR_CHAT_ID unset (and no TELEGRAM_CHAT_ID fallback) must fail
  // closed: /code is not a command for anyone, and nothing is minted. This is
  // the state a fresh deployment is in until the owner sets it.
  {
    const savedOp = process.env.OPERATOR_CHAT_ID;
    const savedTg = process.env.TELEGRAM_CHAT_ID;
    delete process.env.OPERATOR_CHAT_ID;
    delete process.env.TELEGRAM_CHAT_ID;
    try {
      const C = await import('../lib/content.js');
      const codesBefore = (await svc.from('bind_codes').select('code').eq('business_id', bizA.id)).data.length;
      await reset();
      await good(msg(chatA, '/code alder-demo'));
      const text = (await sent()).filter((x) => x.path.includes('/sendMessage')).map((x) => x.body.text).join('\n');
      const codesAfter = (await svc.from('bind_codes').select('code').eq('business_id', bizA.id)).data.length;
      line(text === C.BOT_PLAIN_TEXT && codesAfter === codesBefore,
        'OP21', 'OPERATOR_CHAT_ID unset: /code is not a command, nothing minted',
        `codes ${codesBefore}->${codesAfter}`);
    } finally {
      if (savedOp === undefined) delete process.env.OPERATOR_CHAT_ID; else process.env.OPERATOR_CHAT_ID = savedOp;
      if (savedTg === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = savedTg;
    }
  }

  // W1-W6: who presses a client link, and what they are told. The code must
  // survive every refusal, and no reply may name the business that owns it.
  {
    const C = await import('../lib/content.js');
    const OP = FIXTURE_CHATS.webhookOperator;
    const chatA2 = FIXTURE_CHATS.webhookA2;
    const savedOp = process.env.OPERATOR_CHAT_ID;
    process.env.OPERATOR_CHAT_ID = String(OP);
    const live = mkCode(12), used = mkCode(12), expired = mkCode(12);
    createdCodes.push(live, used, expired);
    await createBindCode(live, bindBiz.id, new Date(Date.now() + 3600000).toISOString());
    await createBindCode(used, bindBiz.id, new Date(Date.now() + 3600000).toISOString());
    await createBindCode(expired, bindBiz.id, new Date(Date.now() - 60000).toISOString());
    await svc.from('bind_codes').update({ used_at: new Date().toISOString() }).eq('code', used);
    const codeState = async (c) => (await svc.from('bind_codes').select('used_at').eq('code', c).single()).data.used_at;
    const lastText = async () => ((await sent()).filter((x) => x.path.includes('/sendMessage')).pop() || {}).body?.text || '';

    // Unbound operator, /start CODE (a tapped link) and a pasted code.
    await svc.from('business_chats').delete().eq('tg_chat_id', OP);
    await reset();
    await good(msg(OP, '/start ' + live));
    const w1 = await lastText();
    await reset();
    await good(msg(OP, '  ' + live.slice(0, 4).toLowerCase() + '-' + live.slice(4).toLowerCase() + ' '));
    const w2 = await lastText();
    line(w1 === C.OPERATOR_DO_NOT_OPEN && w2 === C.OPERATOR_DO_NOT_OPEN && (await codeState(live)) === null,
      'W1', 'unbound operator: do not open it, code untouched', `start=${w1 === C.OPERATOR_DO_NOT_OPEN} paste=${w2 === C.OPERATOR_DO_NOT_OPEN}`);

    // Bound operator pressing a link: the operator wording, and the code state
    // is checked rather than assumed. No client advice, no business name.
    await svc.from('business_chats').insert({ business_id: codeBiz.id, tg_chat_id: OP, created_at: new Date().toISOString() });
    await reset();
    await good(msg(OP, '/start ' + live));
    const w3 = await lastText();
    await reset();
    await good(msg(OP, '/start ' + used));
    const w3used = await lastText();
    await reset();
    await good(msg(OP, '/start ' + expired));
    const w3exp = await lastText();
    await svc.from('business_chats').delete().eq('tg_chat_id', OP);
    line(w3 === C.OPERATOR_ALREADY_CONNECTED_CODE && w3used === C.OPERATOR_CODE_USED
      && w3exp === C.OPERATOR_CODE_EXPIRED
      && ![w3, w3used, w3exp].some((t) => /person who set up/i.test(t) || /ZZ|alder/i.test(t))
      && (await codeState(live)) === null,
      'W2', 'bound operator: live / used / expired wording, code untouched',
      `live=${w3 === C.OPERATOR_ALREADY_CONNECTED_CODE} used=${w3used === C.OPERATOR_CODE_USED} expired=${w3exp === C.OPERATOR_CODE_EXPIRED}`);

    // Bound client and staff phone: the existing client wording, code untouched.
    await reset();
    await good(msg(chatA, '/start ' + live));
    const w4 = await lastText();
    await reset();
    await good(msg(chatB, '/start ' + live));
    const w5 = await lastText();
    line(w4 === C.BOT_ALREADY_CONNECTED_CODE && w5 === C.BOT_ALREADY_CONNECTED_CODE && (await codeState(live)) === null,
      'W3', 'bound client and staff phone: already connected, code untouched',
      `owner=${w4 === C.BOT_ALREADY_CONNECTED_CODE} staff=${w5 === C.BOT_ALREADY_CONNECTED_CODE}`);

    // A bound chat pasting another business's code: no business name, no claim.
    await reset();
    await good(msg(chatA, '  ' + live.slice(0, 4).toLowerCase() + '-' + live.slice(4).toLowerCase() + ' '));
    const w6 = await lastText();
    line(w6 === C.BOT_ALREADY_CONNECTED_CODE && !w6.includes('ZZ') && !w6.includes('Alder')
      && !w6.includes('alder') && (await codeState(live)) === null,
      'W4', 'pasted another business code: no business name, code untouched', `len=${w6.length} t=${w6.slice(0, 26)}`);

    // Expired and used codes: one generic answer, no oracle.
    await reset();
    await good(msg(chatX, '/start ' + expired));
    const w7 = await lastText();
    await reset();
    await good(msg(chatX, '/start ' + used));
    const w8 = await lastText();
    line(w7 === C.BOT_BAD_CODE && w8 === C.BOT_BAD_CODE
      && !w7.includes('ZZ') && !w8.includes('ZZ') && !w7.includes('alder') && !w8.includes('alder'),
      'W5', 'expired / used code: one generic answer, no business named',
      `expired=${w7 === C.BOT_BAD_CODE} used=${w8 === C.BOT_BAD_CODE}`);

    if (savedOp === undefined) delete process.env.OPERATOR_CHAT_ID; else process.env.OPERATOR_CHAT_ID = savedOp;
  }

  // C40: no payload of ANY Telegram send or edit method in the whole suite
  // carries parse_mode. The bot sends plain text plus entities, and one stray
  // parse_mode would make Telegram parse the message instead. Before the
  // browser flow this checked sendMessage only; it now checks every recorded
  // API call, so a new method cannot dodge it.
  {
    const all = (await (await fetch(TG + '/__all')).json()).requests
      .filter((x) => x.body && typeof x.body === 'object');
    const sends = all.filter((x) => x.path.includes('/sendMessage'));
    const bad = all.filter((x) => 'parse_mode' in x.body);
    const methods = [...new Set(all.map((x) => String(x.path).split('/').pop()).filter((m) => /^[a-z][a-zA-Z]+$/.test(m)))];
    line(sends.length > 0 && bad.length === 0, 'C40', 'no send/edit payload of any method carries parse_mode',
      `sends=${sends.length} methods=${methods.join(',')} bad=${bad.length}`);
  }

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
      const pair = (await sent()).filter((x) => x.path.includes('/sendMessage'));
      const opLine = (pair[0] && pair[0].body.text) || '';
      const forward = (pair[1] && pair[1].body.text) || '';
      // Take the code from the forward text, then prove the database has it:
      // row order is not guaranteed, so picking "the last row" proved nothing.
      const linkEnt = ((pair[1] && pair[1].body.entities) || []).find((e) => e.type === 'text_link');
      const theCode = linkEnt ? ((linkEnt.url.match(/\?start=([A-Z2-9]{12})/) || [])[1] || '') : '';
      const stored = theCode
        ? (await svc.from('bind_codes').select('code, used_at').eq('code', theCode).eq('business_id', codeBiz.id)).data
        : [];
      line(pair.length === 2 && !!theCode && stored.length === 1 && stored[0].used_at === null
        && opLine.includes(CODE_SLUG) && /expires in 24 hours/i.test(opLine)
        && !opLine.includes('?start=') && forward.includes('send it the code below')
        && !forward.includes(CODE_SLUG) && !forward.includes('send me')
        && ((pair[0].body.entities) || []).some((e) => e.type === 'code'
          && opLine.slice(e.offset, e.offset + e.length) === theCode)
        && ((pair[1].body.entities) || []).some((e) => e.type === 'code'
          && forward.slice(e.offset, e.offset + e.length) === theCode)
        && pair.every((x) => !('parse_mode' in x.body)),
        'OP2', 'operator /code: two messages, slug only in the first',
        `messages=${pair.length} code=${theCode.slice(0, 4)}… stored=${stored.length}`);

      // OP3: cap per slug, fail closed at 10/hour. OP2 already used one slot,
      // so clear the bucket to measure the cap itself.
      // The cap is a fixed 3600 s bucket. If the burst straddles the boundary a
      // second row appears and the 11th mint is allowed; retry once in that
      // case so the test measures the cap, not the clock.
      let okCount = 0, capped = false, attempts = 0;
      for (attempts = 1; attempts <= 2; attempts++) {
        await svc.from('rate_limits').delete().eq('key', 'opcode:' + CODE_SLUG);
        okCount = 0; capped = false;
        for (let i = 0; i < 11; i++) {
          await reset();
          await good(msg(OP, `/code ${CODE_SLUG}`));
          const t = await allText();
          if (t === C.OPERATOR_CAPPED) capped = true; else okCount++;
        }
        const rows = (await svc.from('rate_limits').select('window_start').eq('key', 'opcode:' + CODE_SLUG)).data;
        if ((rows || []).length <= 1) break;
      }
      line(okCount === 10 && capped, 'OP3', 'operator /code capped at 10 per slug per hour',
        `ok=${okCount} capped=${capped} attempts=${attempts}`);

      // OP14: the second message fails. The code is still valid, so the
      // operator must be told the forward text did not send and get it again.
      await reset();
      await svc.from('rate_limits').delete().eq('key', 'opcode:' + CODE_SLUG);
      await control({ mode: 'fail_nth', nth: 2 });
      await good(msg(OP, `/code ${CODE_SLUG}`));
      const afterFail = (await sent()).filter((x) => x.path.includes('/sendMessage'));
      await control({ mode: 'ok' });
      const resendReq = afterFail[2] || {};
      const resend = (resendReq.body && resendReq.body.text) || '';
      const resendCode = (resend.match(/\b([A-Z2-9]{12})\b/) || [])[1] || '';
      const resendEnt = ((resendReq.body && resendReq.body.entities) || [])[0] || {};
      line(afterFail.length === 3 && /did not send/.test(resend) && !!resendCode
        && resendEnt.type === 'code'
        && resend.slice(resendEnt.offset, resendEnt.offset + resendEnt.length) === resendCode
        && !('parse_mode' in (resendReq.body || {})),
        'OP14', 'forward send fails: operator gets the code back as a code entity',
        `messages=${afterFail.length} ent=${resendEnt.type}`);

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
      const two = (await sent()).filter((x) => x.path.includes('/sendMessage')).map((x) => x.body);
      const codes = two.map((t) => {
        const e = (t.entities || []).find((x) => x.type === 'text_link');
        return e ? (e.url.match(/\?start=([A-Z2-9]{12})/) || [])[1] : null;
      }).filter(Boolean);
      line(codes.length === 2 && codes[0] !== codes[1] && two.length === 4,
        'OP16', 'two /code taps: two distinct codes, two messages each',
        `codes=${codes.length} unique=${new Set(codes).size} messages=${two.length}`);

      // OP22: /id speaks differently to the operator chat, and the id is a
      // code entity (tap to copy) in both cases.
      {
        const C2 = await import('../lib/content.js');
        const saved = process.env.OPERATOR_CHAT_ID;
        process.env.OPERATOR_CHAT_ID = String(OP);
        await reset();
        await good(msg(OP, '/id'));
        const opId = (await sent()).filter((x) => x.path.includes('/sendMessage')).pop();
        await reset();
        await good(msg(chatA, '/id'));
        const clientId = (await sent()).filter((x) => x.path.includes('/sendMessage')).pop();
        process.env.OPERATOR_CHAT_ID = saved;
        const opText = (opId && opId.body.text) || '';
        const clText = (clientId && clientId.body.text) || '';
        const ent = (opId && opId.body.entities && opId.body.entities[0]) || {};
        line(opText.includes('This chat is the operator chat.') && !opText.includes('Set OPERATOR_CHAT_ID')
          && clText.includes('Set OPERATOR_CHAT_ID')
          && opText.slice(ent.offset, ent.offset + ent.length) === String(OP)
          && ent.type === 'code',
          'OP22', '/id: operator says so, id is a code entity', `opEnt=${ent.type}`);
      }

      // OP23: a new /code expires the business's older UNUSED codes, leaves a
      // used code and another business alone, and says how many it cancelled.
      {
        await svc.from('rate_limits').delete().eq('key', 'opcode:' + CODE_SLUG);
        const oldA = 'OLDA' + mkCode(8), oldB = 'OLDB' + mkCode(8), usedC = 'OLDC' + mkCode(8), other = 'OTHR' + mkCode(8);
        for (const c of [oldA, oldB, usedC]) { createdCodes.push(c); await createBindCode(c, codeBiz.id, new Date(Date.now() + 3600000).toISOString()); }
        createdCodes.push(other);
        await createBindCode(other, bindBiz.id, new Date(Date.now() + 3600000).toISOString());
        await svc.from('bind_codes').update({ used_at: new Date().toISOString() }).eq('code', usedC);
        const liveBefore = (await svc.from('bind_codes').select('code').eq('business_id', codeBiz.id)
          .is('used_at', null).gt('expires_at', new Date().toISOString())).data.length;
        await reset();
        await good(msg(OP, `/code ${CODE_SLUG}`));
        const reqs = (await sent()).filter((x) => x.path.includes('/sendMessage'));
        const m1 = (reqs[0] && reqs[0].body.text) || '';
        const states = (await svc.from('bind_codes').select('code, used_at, expires_at').in('code', [oldA, oldB, usedC, other])).data;
        const by = new Map(states.map((r) => [r.code, r]));
        const expiredA = new Date(by.get(oldA).expires_at) <= new Date();
        const expiredB = new Date(by.get(oldB).expires_at) <= new Date();
        const usedKept = !!by.get(usedC).used_at && new Date(by.get(usedC).expires_at) > new Date();
        const otherKept = new Date(by.get(other).expires_at) > new Date();
        const phrase = `${liveBefore} older ${liveBefore === 1 ? 'invite was' : 'invites were'} cancelled`;
        line(expiredA && expiredB && usedKept && otherKept && m1.includes(phrase),
          'OP23', '/code cancels older unused codes, keeps used and other business',
          `n=${liveBefore} has=${m1.includes('cancelled')} m1=${m1.slice(60, 130)}`);
      }

      // OP26: the operator chat gets an operator welcome for /start, a dead
      // link and plain text — never the client "isn't connected" message.
      {
        const C2 = await import('../lib/content.js');
        const lastText = async () => ((await sent()).filter((x) => x.path.includes('/sendMessage')).pop() || {}).body?.text || '';
        await reset();
        await good(msg(OP, '/start'));
        const w1 = await lastText();
        await reset();
        await good(msg(OP, '/start ZZZZZZZZZZZZ'));
        const w2 = await lastText();
        await reset();
        await good(msg(OP, 'hello there'));
        const w3 = await lastText();
        await reset();
        await good(msg(chatX, '/start'));
        const client = await lastText();
        line(w1 === C2.OPERATOR_WELCOME && w2 === C2.OPERATOR_WELCOME && w3 === C2.OPERATOR_WELCOME
          && client === C2.BOT_NOT_CONNECTED,
          'OP26', 'operator welcome for start/dead link/plain text; client message unchanged',
          `op=${w1 === C2.OPERATOR_WELCOME}/${w2 === C2.OPERATOR_WELCOME}/${w3 === C2.OPERATOR_WELCOME} client=${client === C2.BOT_NOT_CONNECTED}`);
      }

      // OP27/OP28: /remove_lead. Owner only, five per page, scoped delete,
      // double tap is idempotent, stale taps are graceful.
      {
        const C2 = await import('../lib/content.js');
        const ids = [];
        for (let i = 0; i < 6; i++) ids.push(await seedLead(bindBiz.id, `Remove Me ${i + 1}`, `remove${i}@example.com`));
        const lastText = async () => ((await sent()).filter((x) => x.path.includes('/sendMessage')).pop() || {}).body?.text || '';
        await reset();
        await good(msg(bindA, '/remove_lead'));
        const list = (await sent()).filter((x) => x.path.includes('/sendMessage')).pop();
        const kb = (list && list.body.reply_markup && list.body.reply_markup.inline_keyboard) || [];
        const listText = (list && list.body.text) || '';
        // The compact layout: ONE row of number buttons (Q:page:leadId) matching
        // the numbers in the text, then one navigation row holding only the
        // useful end — six rows on one page of five means Older alone. (The
        // labeled row buttons, one per lead, are gone: kb was 6 rows, now 2.)
        const rowBtns = kb[0] || [];
        const nav = kb[1] || [];
        const numberedLines = listText.split('\n').filter((t) => /^\d+\. /.test(t));
        await reset();
        await good(cb(bindA, 'rl:' + ids[0]));
        const confirm = (await sent()).filter((x) => x.path.includes('/editMessageText')).pop();
        const ckb = (confirm && confirm.body.reply_markup && confirm.body.reply_markup.inline_keyboard[0]) || [];
        await reset();
        await good(cb(bindA, 'RL:' + ids[0]));
        const gone = (await svc.from('leads').select('id').eq('id', ids[0])).data.length;
        const afterText = ((await sent()).filter((x) => x.path.includes('/editMessageText')).pop() || {}).body?.text || '';
        const removedToast = (await sent()).filter((x) => x.path.includes('/answerCallbackQuery')).map((x) => String(x.body.text));
        await reset();
        await good(cb(bindA, 'RL:' + ids[0]));
        const second = (await sent()).filter((x) => x.path.includes('/answerCallbackQuery')).map((x) => String(x.body.text));
        await reset();
        await good(cb(bindA, 'rl:' + ids[0]));
        const stale = (await sent()).filter((x) => x.path.includes('/answerCallbackQuery')).map((x) => String(x.body.text));
        line(listText.startsWith(C2.REMOVE_LEAD_TITLE) && kb.length === 2 && rowBtns.length === 5
          && JSON.stringify(nav) === JSON.stringify([{ text: 'Older', callback_data: 'rm:1' }])
          && rowBtns.every((b, i) => /^Q:0:[0-9a-f-]{36}$/.test(b.callback_data) && b.text === String(i + 1))
          && numberedLines.length === 5 && numberedLines.every((t, i) => new RegExp(`^${i + 1}\\. Remove Me \\d$`).test(t))
          && !kb.flat().some((b) => 'disabled' in b)
          && confirm && confirm.body.text.includes('Remove Me 1') && ckb[0].style === 'danger'
          && ckb[1].text === 'Cancel' && gone === 0
          && afterText === 'Removed: Remove Me 1 · Repair' && removedToast.includes(afterText)
          && second.includes(C2.REMOVE_LEAD_GONE) && stale.includes(C2.REMOVE_LEAD_GONE),
          'OP27', '/remove_lead: list, confirm, scoped delete, double/stale taps',
          `rows=${rowBtns.length} gone=${gone} text=${JSON.stringify(afterText)}`);

        await reset();
        await good(msg(bindB, '/remove_lead'));
        const staff = await lastText();
        await reset();
        await good(cb(bindB, 'RL:' + ids[1]));
        const staffTap = (await sent()).filter((x) => x.path.includes('/answerCallbackQuery')).map((x) => String(x.body.text));
        const stillThere = (await svc.from('leads').select('id').eq('id', ids[1])).data.length;
        // A forged delete of another business's lead must fail on the scope.
        const foreign = await seedLead(bizB.id, 'Foreign Remove', 'foreignremove@example.com');
        await reset();
        await good(cb(bindA, 'RL:' + foreign));
        const foreignText = (await sent()).filter((x) => x.path.includes('/answerCallbackQuery')).map((x) => String(x.body.text));
        const foreignKept = (await svc.from('leads').select('id').eq('id', foreign)).data.length;
        line(staff === C2.BOT_OWNER_ONLY && staffTap.includes(C2.TOAST_OWNER_ONLY) && stillThere === 1
          && foreignText.includes(C2.REMOVE_LEAD_GONE) && foreignKept === 1,
          'OP28', 'staff cannot list or delete; another business lead is out of scope',
          `staff=${staff === C2.BOT_OWNER_ONLY} kept=${stillThere} foreign=${foreignKept}`);
      }

      // OP33: operator answers for the owner commands, no client text.
      {
        const C2 = await import('../lib/content.js');
        const lastText = async () => ((await sent()).filter((x) => x.path.includes('/sendMessage')).pop() || {}).body?.text || '';
        const lastKb = async () => ((await sent()).filter((x) => x.path.includes('/sendMessage')).pop() || {}).body?.reply_markup?.inline_keyboard || [];
        await reset(); await good(msg(OP, '/invite'));
        const inv = await lastText(); const invKb = await lastKb();
        await reset(); await good(msg(OP, '/recipients'));
        const rec = await lastText(); const recKb = await lastKb();
        await reset(); await good(msg(OP, '/help'));
        const help = await lastText();
        await reset(); await good(msg(OP, '/remove_lead'));
        const rm = await lastText();
        await reset(); await good(msg(OP, '/leads'));
        const leads1 = await lastText();
        await reset(); await good(msg(OP, '/leads second-demo'));
        const leads2 = await lastText();
        await reset(); await good(msg(chatX, '/leads'));
        const client = await lastText();
        await reset(); await good(msg(chatA, '/leads second-demo'));
        const own = await lastText();
        line(inv === C2.OPERATOR_PICK_TEXT && invKb.flat().some((b) => String(b.callback_data).startsWith('pc:'))
          && rec === C2.OPERATOR_PICK_TEXT && recKb.flat().some((b) => String(b.callback_data).startsWith('pb:'))
          && help === C2.OPERATOR_HELP && rm === C2.OPERATOR_REMOVE_LEAD
          && leads1 === C2.OPERATOR_LEADS_HINT && leads2 === C2.OPERATOR_LEADS_HINT
          && client === C2.BOT_NOT_CONNECTED && !/Beta|Second/.test(own),
          'OP33', 'operator answers for /invite /recipients /help /remove_lead /leads',
          `help=${help === C2.OPERATOR_HELP} rm=${JSON.stringify(rm)} client=${client === C2.BOT_NOT_CONNECTED} own=${!/Beta|Second/.test(own)}`);
      }

      // OP34: /businesses counts phones for a paused business, not 0.
      {
        const C2 = await import('../lib/content.js');
        const paused = await svc.from('businesses').insert({
          slug: 'zz-test-paused-' + CODE_SLUG.slice(-6), name: 'ZZ Paused Fixture',
          owner_email: 'paused@zz-test.invalid', google_review_url: 'https://g.page/r/zz', status: 'paused',
        }).select('id').single();
        await svc.from('business_chats').insert({ business_id: paused.data.id, tg_chat_id: FIXTURE_CHATS.webhookX });
        await reset();
        await good(msg(OP, '/businesses'));
        const text = ((await sent()).filter((x) => x.path.includes('/sendMessage')).pop() || {}).body?.text || '';
        await svc.from('businesses').delete().eq('id', paused.data.id);
        line(/ZZ Paused Fixture · Paused · 1 phone/.test(text), 'OP34',
          '/businesses counts a paused business phone', text.split('\n').find((l) => l.includes('ZZ Paused')) || 'missing');
      }

      // OP35: when the phone-count query fails, /businesses says "?" — never
      // "0 phones", which would tell the operator a live business has none.
      {
        const realFetch = globalThis.fetch;
        let seen = 0;
        globalThis.fetch = async (input, init) => {
          const u = typeof input === 'string' ? input : (input && input.url) || '';
          const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
          // countBusinessChats is the HEAD request; a GET on the same table is
          // the handler's own binding lookup and must keep working.
          if (method === 'HEAD' && u.includes('/rest/v1/business_chats')) {
            seen++;
            return new Response('{"message":"count failed"}', { status: 500, headers: { 'content-type': 'application/json' } });
          }
          return realFetch(input, init);
        };
        let text = '';
        try {
          await reset();
          await good(msg(OP, '/businesses'));
          text = ((await sent()).filter((x) => x.path.includes('/sendMessage')).pop() || {}).body?.text || '';
        } finally {
          globalThis.fetch = realFetch;
        }
        const alder = text.split('\n\n').find((l) => l.startsWith('Alder Roofing')) || '';
        line(seen > 0 && /·\s\?$/.test(alder.trim()) && !/0 phones/.test(alder),
          'OP35', '/businesses shows ? when the count fails', `seen=${seen} line=${JSON.stringify(alder)}`);
      }

      // OP25: the operator chat can never become a business phone, even via a
      // direct bindChat caller. No row is written.
      {
        const { bindChat } = await import('../lib/db.js');
        let err = null;
        try { await bindChat(bizA.id, OP); } catch (e) { err = e && e.code; }
        const rows = (await svc.from('business_chats').select('id').eq('tg_chat_id', OP)).data.length;
        line(err === 'operator_chat' && rows === 0, 'OP25',
          'bindChat refuses the operator chat', `code=${err} rows=${rows}`);
      }

      // OP24: pickers. No slug -> names as buttons; the tap runs the same
      // action; a forged or stale id is unknown; a non-operator gets nothing.
      {
        const C2 = await import('../lib/content.js');
        await reset();
        await good(msg(OP, '/phones'));
        const ph = (await sent()).filter((x) => x.path.includes('/sendMessage')).pop();
        const phKb = (ph && ph.body.reply_markup && ph.body.reply_markup.inline_keyboard) || [];
        const phBtn = phKb.flat().find((b) => b.callback_data === 'pb:' + bizA.id);
        const pickText = ph && ph.body && ph.body.text;
        const phKeys = ph && ph.body ? Object.keys(ph.body).join('+') : 'none';
        await reset();
        await good(cb(OP, 'pb:' + bizA.id));
        const phText = (await sent()).filter((x) => x.path.includes('/sendMessage')).pop();
        const phonesTitle = (phText && phText.body.text) || '';

        await svc.from('rate_limits').delete().eq('key', 'opcode:' + CODE_SLUG);
        await reset();
        await good(msg(OP, '/code'));
        const codeKb = ((await sent()).filter((x) => x.path.includes('/sendMessage')).pop() || {}).body.reply_markup.inline_keyboard;
        await reset();
        await good(cb(OP, 'pc:' + codeBiz.id));
        const codeMsgs = (await sent()).filter((x) => x.path.includes('/sendMessage'));

        await reset();
        await good(cb(OP, 'pc:00000000-0000-0000-0000-000000000000'));
        const stale = (await sent()).filter((x) => x.path.includes('/answerCallbackQuery')).map((x) => String(x.body.text));
        // A non-operator tap must not act. The same isOperatorChat gate is
        // exercised by OP6 (forged p: from a client), so this checks silence.
        await reset();
        await good(cb(chatA, 'pb:' + bizA.id));
        const foreignSends = (await sent()).filter((x) => x.path.includes('/sendMessage')).length;

        line(!!phBtn && phBtn.text.length <= 20 && pickText === C2.OPERATOR_PICK_TEXT
          && phonesTitle.startsWith('Alder Roofing') && !phonesTitle.includes('alder-demo')
          && !!codeKb && codeKb.flat().some((b) => b.callback_data === 'pc:' + codeBiz.id)
          && codeMsgs.length === 2
          && stale.includes(C2.OPERATOR_UNKNOWN_SLUG) && foreignSends === 0,
          'OP24', 'pickers: names, same action, forged/stale/foreign refused',
          `k=${codeKb ? codeKb.flat().map((b) => b.callback_data.slice(0,3)).join(',') : 'none'} pt=${JSON.stringify(pickText)} pk=${phKeys} ti=${phonesTitle.startsWith('Alder Roofing')} f=${foreignSends}`);
      }

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
        /* An hour and half an hour back, not seconds: bindChat writes created_at
           with the DATABASE clock while these two use this machine's, and the two
           differ by a few seconds here. A row written later must not sort as the
           older phone, or "the main phone" moves between requests. */
        const t0 = Date.now();
        await svc.from('business_chats').insert([
          { business_id: invBiz.id, tg_chat_id: invOwner, created_at: new Date(t0 - 3600000).toISOString() },
          { business_id: invBiz.id, tg_chat_id: invStaff, created_at: new Date(t0 - 1800000).toISOString() },
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

      // OP36-OP39: the lead list. Field order, and a page with nothing on it is
      // rewritten from current data: the toast explains the tap, the edit
      // repairs the message so no button is left that does nothing.
      {
        const C2 = await import('../lib/content.js');
        const sends = async () => (await sent()).filter((x) => x.path.includes('/sendMessage'));
        const edits = async () => (await sent()).filter((x) => x.path.includes('/editMessageText'));
        const answers = async () => (await sent()).filter((x) => x.path.includes('/answerCallbackQuery')).map((x) => String(x.body.text));

        // Explicit, distinct ages: one INSERT gives every row the same now(),
        // and the list order would then be arbitrary. Twelve rows: page 1 has a
        // full five AND an older page, which is the case that must keep Older.
        const t0 = Date.now();
        const ids = [];
        for (let i = 0; i < 12; i++) {
          const { data } = await svc.from('leads').insert({
            business_id: invBiz.id, name: `Paging ${i + 1}`, phone: '5155550100', email: `paging${i}@fixture.invalid`,
            zip: '50265', service: 'repair', home: 'house', timing: 'asap', roof_age: 'Not sure',
            insurance_claim: false, notes: null, idempotency_key: `${RUN}-pg${i}`,
            created_at: new Date(t0 - (12 - i) * 60000).toISOString(),
          }).select('id').single();
          if (data) { ids.push(data.id); createdLeads.push(data.id); }
        }

        await reset();
        await good(msg(invOwner, '/leads'));
        const first = (await sends()).pop();
        const lines = String(first.body.text).split('\n');
        const kb1 = (first.body.reply_markup && first.body.reply_markup.inline_keyboard) || [];
        // The compact layout: the text lists the leads; under it ONE row of
        // number buttons 1..5 (L:page:leadId, in the text's order) and one
        // navigation row. Page 0 of twelve has older rows and nothing newer,
        // so the navigation row is Older alone — no disabled Newer. (Layout
        // history: number row + nav with 'o:' callbacks; then one labeled
        // button per lead, 6 rows; now the number row again, 2 rows.)
        const numbered1 = lines.filter((t) => /^\d+\. /.test(t));
        line(ids.length === 12 && lines[2] === '1. Paging 12' && lines[3] === 'Repair · +15155550100'
          && /^\u{1F7E1} New · \d+m ago$/u.test(lines[4])
          && numbered1.length === 5 && numbered1.every((t, i) => t === `${i + 1}. Paging ${12 - i}`)
          && kb1.length === 2 && kb1[0].length === 5
          && kb1[0].every((b, i) => b.text === String(i + 1) && b.callback_data === 'L:0:' + ids[11 - i])
          && JSON.stringify(kb1[1]) === JSON.stringify([{ text: 'Older', callback_data: 'l:1' }])
          && !kb1.flat().some((b) => 'disabled' in b || b.copy_text),
          'OP36', '/leads: text rows in order, one number row, Older alone',
          `third=${JSON.stringify(lines[4])} rows=${kb1.length} numbers=${(kb1[0] || []).map((b) => b.text).join('')} nav=${(kb1[1] || []).map((b) => b.text).join('/')}`);

        // A page that still has an older one keeps the button after the tap.
        await reset();
        await good(cb(invOwner, 'l:1'));
        const page1 = (await edits()).pop();
        const page1Lines = String(page1 && page1.body.text).split('\n');
        const kb2 = (page1 && page1.body.reply_markup && page1.body.reply_markup.inline_keyboard) || [];
        // A middle page: Newer and Older side by side, in that order.
        line(/^1\. Paging 7$/.test(page1Lines[2] || '')
          && kb2.length === 2 && kb2[0].length === 5
          && kb2[0].every((b, i) => b.text === String(i + 1) && b.callback_data === 'L:1:' + ids[6 - i])
          && JSON.stringify(kb2[1]) === JSON.stringify([{ text: 'Newer', callback_data: 'l:0' }, { text: 'Older', callback_data: 'l:2' }])
          && !kb2.flat().some((b) => 'disabled' in b),
          'OP37', 'a middle page keeps Newer and Older side by side',
          `first=${JSON.stringify(page1Lines[2])} nav=${(kb2[1] || []).map((b) => b.text).join(',')}`);

        // The last page is deleted behind the message's back, then Older is
        // tapped: toast, then the message itself is rewritten with no buttons.
        await svc.from('leads').delete().in('id', ids.slice(0, 2));
        await reset();
        await good(cb(invOwner, 'l:2'));
        const staleAnswers = await answers();
        const staleEdits = await edits();
        const stale = staleEdits[0] || {};
        const staleKb = (stale.body && stale.body.reply_markup && stale.body.reply_markup.inline_keyboard) || [];
        line(staleEdits.length === 1 && stale.body && stale.body.text === 'No requests yet.' && staleKb.length === 0
          && staleAnswers.includes(C2.TOAST_NO_OLDER),
          'OP38', 'stale Older: toast, then the message is rewritten empty',
          `edits=${staleEdits.length} text=${JSON.stringify(stale.body && stale.body.text)} kb=${staleKb.length}`);

        // The list shrank to nothing: Newer answers, and the message is rewritten.
        await svc.from('leads').delete().in('id', ids);
        await reset();
        await good(cb(invOwner, 'l:0'));
        const emptyAnswers = await answers();
        const emptyEdits = await edits();
        const empty = emptyEdits[0] || {};
        const emptyKb = (empty.body && empty.body.reply_markup && empty.body.reply_markup.inline_keyboard) || [];
        line(emptyEdits.length === 1 && empty.body && empty.body.text === 'No requests yet.' && emptyKb.length === 0
          && emptyAnswers.includes(C2.TOAST_NO_LEADS),
          'OP39', 'list shrank to nothing: Newer rewrites the message empty',
          `edits=${emptyEdits.length} text=${JSON.stringify(empty.body && empty.body.text)}`);

        // The same rule on the /remove_lead list.
        await reset();
        await good(msg(invOwner, '/remove_lead'));
        const emptyList = String(((await sends()).pop() || {}).body?.text);
        await reset();
        await good(cb(invOwner, 'rm:1'));
        const rmAnswers = await answers();
        const rmEdits = await edits();
        const rm = rmEdits[0] || {};
        const rmKb = (rm.body && rm.body.reply_markup && rm.body.reply_markup.inline_keyboard) || [];
        line(emptyList === 'No requests to remove.' && rmEdits.length === 1
          && rm.body && rm.body.text === 'No requests to remove.' && rmKb.length === 0
          && rmAnswers.includes(C2.TOAST_NO_OLDER),
          'OP44', '/remove_lead: stale page is rewritten with no buttons',
          `edits=${rmEdits.length} kb=${rmKb.length} answers=${rmAnswers.join('|')}`);
      }

      /* OP46-OP60: the in-place /leads browser. One message: row taps edit it
         to the detail, Back restores the exact page, /remove_lead is the same
         browser in removal mode, and the persistent keyboard arrives per role.
         invBiz is empty here (OP39 deleted its rows), so the pages below are
         fully controlled. */
      {
        const C2 = await import('../lib/content.js');
        const sends = async () => (await sent()).filter((x) => x.path.includes('/sendMessage'));
        const edits = async () => (await sent()).filter((x) => x.path.includes('/editMessageText'));
        const answers = async () => (await sent()).filter((x) => x.path.includes('/answerCallbackQuery')).map((x) => String(x.body.text));
        const kbOf = (req) => (req && req.body.reply_markup && req.body.reply_markup.inline_keyboard) || [];

        // Seven rows plus one long-name row: page 0 has five plus an older
        // page, page 1 is the last. The long name is the NEWEST row, so page 0
        // is fully deterministic: [long, Browser 7, 6, 5, 4] then [3, 2, 1].
        const t0 = Date.now();
        const ids = [];
        for (let i = 0; i < 7; i++) {
          const { data } = await svc.from('leads').insert({
            business_id: invBiz.id, name: `Browser ${i + 1}`, phone: '5155550100', email: `browser${i}@fixture.invalid`,
            zip: '50265', service: 'repair', home: 'house', timing: 'asap', roof_age: 'Not sure',
            insurance_claim: false, notes: null, idempotency_key: `${RUN}-br${i}`,
            created_at: new Date(t0 - (7 - i) * 60000).toISOString(),
          }).select('id').single();
          if (data) { ids.push(data.id); createdLeads.push(data.id); }
        }
        // ids[6] is the newest Browser row (Browser 7); a very long name for
        // the label cap, newest of all so the page order never depends on a
        // uuid tie-break.
        const { data: longLead } = await svc.from('leads').insert({
          business_id: invBiz.id, name: 'Maximilian Constantine Vanderberg-Roofington The Third Esquire',
          phone: '5155550100', email: `browserlong@fixture.invalid`,
          zip: '50265', service: 'replacement', home: 'house', timing: 'asap', roof_age: 'Not sure',
          insurance_claim: false, notes: null, idempotency_key: `${RUN}-brlong`,
          created_at: new Date(t0 - 30000).toISOString(),
        }).select('id').single();
        if (longLead) createdLeads.push(longLead.id);
        const leadOnPage0 = ids[6];   // Browser 7, newest after the long name
        const leadOnPage1 = ids[1];   // Browser 2, on page 1

        // OP46: /leads opens ONE message; a number tap edits THAT message to
        // the detail (status, contact information, the status action, then
        // plain "Back") and sends nothing new. There is no "Copy phone" button
        // any more: the number in the text is already tappable.
        await reset();
        await good(msg(invOwner, '/leads'));
        const listMsg = (await sends()).pop();
        const listKb = kbOf(listMsg);
        await reset();
        await good(cb(invOwner, `L:0:${leadOnPage0}`));
        const detailEdits = await edits();
        const detailNew = await sends();
        const detail = detailEdits[0] || {};
        const dKb = kbOf(detail);
        const flat = dKb.flat();
        const copyBtn = flat.find((b) => b.copy_text);
        const backBtn = flat.find((b) => b.callback_data === 'l:0');
        // Eight rows: page 0 is the number row 1..5 (the long name first, then
        // Browser 7) and Older alone.
        line(listMsg && listKb.length === 2 && listKb[0].length === 5
          && listKb[0].every((b, i) => b.text === String(i + 1) && /^L:0:[0-9a-f-]{36}$/.test(b.callback_data))
          && listKb[0][0].callback_data === `L:0:${longLead.id}` && listKb[0][1].callback_data === `L:0:${leadOnPage0}`
          && JSON.stringify(listKb[1]) === JSON.stringify([{ text: 'Older', callback_data: 'l:1' }])
          && detailEdits.length === 1 && detailNew.length === 0
          && String(detail.body.text).includes('Browser 7')
          && String(detail.body.text).includes('Phone: +15155550100')
          && dKb.length === 2 && dKb[0].length === 1
          && dKb[0][0].text === 'Mark contacted' && dKb[0][0].callback_data === `C:0:${leadOnPage0}`
          && !copyBtn && !JSON.stringify(dKb).includes('Copy')
          && JSON.stringify(dKb[1]) === JSON.stringify([{ text: 'Back', callback_data: 'l:0' }])
          && backBtn && backBtn.text === 'Back'
          && !(await sends()).length,
          'OP46', 'number tap edits the same message to the detail; no second message',
          `edits=${detailEdits.length} sends=${detailNew.length} copy=${!!copyBtn} back=${JSON.stringify(backBtn && backBtn.text)}`);

        // OP47: Back restores the exact page it came from (page 1 = rows
        // Browser 3, 2, 1 of the eight seeded).
        await reset();
        await good(cb(invOwner, `L:1:${leadOnPage1}`));
        await reset();
        await good(cb(invOwner, 'l:1'));
        const backEdits = await edits();
        const back = backEdits[0] || {};
        const bKb = kbOf(back);
        const backText = String(back.body && back.body.text);
        // Page 1 is the last page: three numbers, then Newer alone (no
        // disabled Older).
        line(backEdits.length === 1 && backText.includes('1. Browser 3') && backText.includes('3. Browser 1')
          && bKb.length === 2 && bKb[0].length === 3
          && bKb[0].every((x, i) => x.text === String(i + 1) && x.callback_data === `L:1:${ids[2 - i]}`)
          && JSON.stringify(bKb[1]) === JSON.stringify([{ text: 'Newer', callback_data: 'l:0' }])
          && !bKb.flat().some((x) => 'disabled' in x),
          'OP47', 'Back restores the exact page it came from',
          `edits=${backEdits.length} first=${JSON.stringify((backText.split('\n')[2] || ''))} rows=${bKb.length}`);

        // OP48: a status change edits in place; the detail keeps Back. A second
        // tap of the same action answers "Already updated." and re-renders.
        await reset();
        await good(cb(invOwner, `C:0:${leadOnPage0}`));
        const cEdits = await edits();
        const cNew = await sends();
        const cKb = kbOf(cEdits[0]);
        await reset();
        await good(cb(invOwner, `C:0:${leadOnPage0}`));
        const twice = await answers();
        const twiceEdits = await edits();
        line(cEdits.length === 1 && cNew.length === 0
          && String(cEdits[0].body.text).includes('Status: Contacted')
          && cKb[0][0].text === 'Job completed' && cKb[0][0].callback_data === `D:0:${leadOnPage0}`
          && cKb.length === 2 && JSON.stringify(cKb[1]) === JSON.stringify([{ text: 'Back', callback_data: 'l:0' }])
          && twice.includes(C2.TOAST_ALREADY_UPDATED) && twiceEdits.length === 1,
          'OP48', 'status change edits in place; repeat tap says already updated',
          `edits=${cEdits.length} sends=${cNew.length} twice=${twice.join('|')}`);

        // OP49: D: asks in place, Y: completes and sends exactly one review
        // email, and the done detail keeps Back and nothing else.
        await resetResend();
        await reset();
        await good(cb(invOwner, `D:0:${leadOnPage0}`));
        const askEdits = await edits();
        const aKb = kbOf(askEdits[0]);
        await reset();
        await good(cb(invOwner, `Y:0:${leadOnPage0}`));
        const doneEdits = await edits();
        const doneNew = await sends();
        const doneEmails = (await resendCalls()).length;
        const row = (await svc.from('leads').select('status, review_token').eq('id', leadOnPage0).single()).data;
        line(askEdits.length === 1 && aKb[0][0].text === 'Send request' && aKb[0][0].callback_data === `Y:0:${leadOnPage0}`
          && aKb[0][1].text === 'Cancel' && aKb[0][1].callback_data === `N:0:${leadOnPage0}`
          && doneEdits.length === 1 && doneNew.length === 0 && doneEmails === 1
          && row.status === 'done' && !!row.review_token
          && String(doneEdits[0].body.text).includes('Status: Done')
          && aKb.length === 2 && JSON.stringify(aKb[1]) === JSON.stringify([{ text: 'Back', callback_data: 'l:0' }])
          && JSON.stringify(kbOf(doneEdits[0])) === JSON.stringify([[{ text: 'Back', callback_data: 'l:0' }]]),
          'OP49', 'browser confirm flow edits in place; done keeps Back only',
          `ask=${askEdits.length} done=${doneEdits.length} emails=${doneEmails}`);

        // OP50: /remove_lead is the same browser in removal mode. A row tap
        // asks; Cancel returns to the same page; Confirm re-checks, deletes,
        // and refreshes that page in removal mode.
        await reset();
        await good(msg(invOwner, '/remove_lead'));
        const rmList = (await sends()).pop();
        const rmKb0 = kbOf(rmList);
        await reset();
        await good(cb(invOwner, `Q:0:${ids[5]}`));
        const ask = (await edits())[0];
        const askKb = kbOf(ask);
        await reset();
        await good(cb(invOwner, 'rm:0'));
        const cancelled = (await edits())[0];
        await reset();
        await good(cb(invOwner, `Q:0:${ids[5]}`));
        await reset();
        await good(cb(invOwner, `E:0:${ids[5]}`));
        const removedNow = (await svc.from('leads').select('id').eq('id', ids[5])).data.length;
        const afterDel = (await edits())[0];
        const gone = (await answers());
        // The removal list is the same layout: one number row, Older alone.
        line(String(rmList.body.text).startsWith(C2.REMOVE_LEAD_TITLE)
          && rmKb0.length === 2 && rmKb0[0].length === 5
          && rmKb0[0].every((b, i) => b.text === String(i + 1) && /^Q:0:[0-9a-f-]{36}$/.test(b.callback_data))
          && JSON.stringify(rmKb0[1]) === JSON.stringify([{ text: 'Older', callback_data: 'rm:1' }])
          && rmKb0[0][0].callback_data === `Q:0:${longLead.id}`
          && askKb.length === 1 && askKb[0][0].text === 'Remove'
          && askKb[0][0].style === 'danger' && askKb[0][0].callback_data === `E:0:${ids[5]}`
          && askKb[0][1].text === 'Cancel' && askKb[0][1].callback_data === 'rm:0'
          && String(cancelled.body.text).startsWith(C2.REMOVE_LEAD_TITLE)
          && cancelled.body.reply_markup.inline_keyboard[0][0].callback_data.startsWith('Q:0:')
          && removedNow === 0
          && String(afterDel.body.text).startsWith(C2.REMOVE_LEAD_TITLE)
          && afterDel.body.reply_markup.inline_keyboard[0][0].callback_data.startsWith('Q:0:')
          && gone.some((t) => t.startsWith('Removed: Browser 6')),
          'OP50', 'removal browser: ask, cancel to page, confirm deletes and refreshes',
          `removed=${removedNow} toast=${gone.find((t) => t.startsWith('Removed:')) || ''}`);

        // OP51: removing the last row on a page moves to a valid page. Page 1
        // (the last) holds Browser 2 and Browser 1; delete both and the
        // refresh must land on page 0.
        await reset();
        await good(cb(invOwner, 'rm:1'));
        const p1 = (await edits())[0];
        await reset();
        await good(cb(invOwner, `Q:1:${ids[1]}`));
        await reset();
        await good(cb(invOwner, `E:1:${ids[1]}`));
        await reset();
        await good(cb(invOwner, `Q:1:${ids[0]}`));
        await reset();
        await good(cb(invOwner, `E:1:${ids[0]}`));
        const lastPage = (await edits())[0];
        const kept = (await svc.from('leads').select('id').in('id', ids)).data.length;
        line(String(p1.body.text).includes('Browser 2')
          && kept === 4  // of the Browser rows; longLead and Browser 7 sit above them
          && String(lastPage.body.text).includes('Browser 5')
          && String(lastPage.body.text).startsWith(C2.REMOVE_LEAD_TITLE)
          && lastPage.body.reply_markup.inline_keyboard[0][0].callback_data.startsWith('Q:0:'),
          'OP51', 'deleting the last rows of a page refreshes to a valid page',
          `kept=${kept} has5=${String(lastPage.body.text).includes('Browser 5')}`);

        // OP52: taps on a lead that is already gone answer and refresh the
        // page instead of leaving a dead button.
        await svc.from('leads').delete().eq('id', ids[4]);
        await reset();
        await good(cb(invOwner, `L:0:${ids[4]}`));
        const goneAnswers = await answers();
        const goneEdits = await edits();
        await reset();
        await good(cb(invOwner, `Q:0:${ids[4]}`));
        const goneQ = await answers();
        await reset();
        await good(cb(invOwner, `E:0:${ids[4]}`));
        const goneE = await answers();
        line(goneAnswers.includes(C2.TOAST_LEAD_GONE) && goneEdits.length === 1
          && String(goneEdits[0].body.text).startsWith('Recent requests')
          && goneQ.includes(C2.REMOVE_LEAD_GONE) && goneE.includes(C2.REMOVE_LEAD_GONE),
          'OP52', 'deleted lead: every browser tap answers and refreshes',
          `L=${goneAnswers.includes(C2.TOAST_LEAD_GONE)} Q=${goneQ.includes(C2.REMOVE_LEAD_GONE)} E=${goneE.includes(C2.REMOVE_LEAD_GONE)}`);

        // OP53: a stale detail tap shows the lead in its CURRENT state. The
        // lead on page 0 is done (OP49); the detail must say so and offer no
        // status action, only Back.
        await reset();
        await good(cb(invOwner, `L:0:${leadOnPage0}`));
        const staleDetail = (await edits())[0];
        const sKb = kbOf(staleDetail);
        line(String(staleDetail.body.text).includes('Status: Done')
          && JSON.stringify(sKb) === JSON.stringify([[{ text: 'Back', callback_data: 'l:0' }]]),
          'OP53', 'stale detail tap renders the current state',
          `actions=${sKb.flat().filter((x) => x.callback_data && x.callback_data !== 'l:0').length}`);

        // OP54: old-format callbacks from messages sent before the browser.
        // o: still opens the card as a NEW message; l: still pages in place.
        await reset();
        await good(cb(invOwner, 'o:' + leadOnPage0));
        const oldOpen = await sends();
        const oldOpenEdits = await edits();
        await reset();
        await good(cb(invOwner, 'l:0'));
        const oldPage = (await edits())[0];
        line(oldOpen.length === 1 && oldOpenEdits.length === 0
          && String(oldOpen[0].body.text).includes('Browser 7')
          && String(oldPage.body.text).startsWith('Recent requests'),
          'OP54', 'old o: opens a new message; old l: still pages in place',
          `sends=${oldOpen.length} edits=${oldOpenEdits.length}`);

        // OP55: staff can browse and act, but not remove. The staff phone gets
        // the browser list; its status action works; its removal taps are
        // refused by the owner gate.
        await reset();
        await good(msg(invStaff, '/leads'));
        const staffList = (await sends()).pop();
        await reset();
        await good(cb(invStaff, `C:0:${ids[3]}`));
        const staffAct = (await edits())[0];
        const staffRow = (await svc.from('leads').select('status').eq('id', ids[3]).single()).data;
        await reset();
        await good(cb(invStaff, `Q:0:${ids[3]}`));
        const staffQ = await answers();
        await reset();
        await good(cb(invStaff, `E:0:${ids[3]}`));
        const staffE = await answers();
        const staffKept = (await svc.from('leads').select('id').eq('id', ids[3])).data.length;
        line(!!staffList && kbOf(staffList)[0][0].callback_data.startsWith('L:0:')
          && staffRow.status === 'contacted' && String(staffAct.body.text).includes('Status: Contacted')
          && staffQ.includes(C2.TOAST_OWNER_ONLY) && staffE.includes(C2.TOAST_OWNER_ONLY) && staffKept === 1,
          'OP55', 'staff browses and acts; removal taps stay owner-only',
          `status=${staffRow.status} Q=${staffQ.includes(C2.TOAST_OWNER_ONLY)} E=${staffE.includes(C2.TOAST_OWNER_ONLY)}`);

        // OP56: cross-business attempts. chatB (owner of bizB) tapping the
        // browser callbacks of an invBiz lead finds nothing, changes nothing,
        // and its own refresh stays bizB's.
        await reset();
        await good(msg(chatB, '/leads'));
        const ownList = (await sends()).pop();
        const foreignBefore = (await svc.from('leads').select('*').eq('id', ids[2])).data || [];
        await reset();
        await good(cb(chatB, `L:0:${ids[2]}`));
        const foreignL = await answers();
        const foreignEdits = await edits();
        await reset();
        await good(cb(chatB, `Q:0:${ids[2]}`));
        await reset();
        await good(cb(chatB, `E:0:${ids[2]}`));
        const foreignKept = (await svc.from('leads').select('id').eq('id', ids[2])).data.length;
        const foreignAfter = (await svc.from('leads').select('*').eq('id', ids[2])).data || [];
        const stableListText = (text) => String(text || '').replace(/ · (?:just now|\d+[mhd] ago)$/gm, ' · age');
        const ownChat = !!ownList && foreignEdits.length === 1
          && String(foreignEdits[0].body.chat_id) === String(chatB);
        const ownText = !!ownList && foreignEdits.length === 1
          && stableListText(foreignEdits[0].body.text) === stableListText(ownList.body.text);
        // The number buttons carry no age (or any other lead detail), so the
        // refreshed keyboard must equal the chat's own list keyboard exactly —
        // the whole keyboard, navigation row included. Before: the row labels
        // held a relative age and were compared with the age normalized.
        const rowButtons = (req) => ((req && req.body.reply_markup && req.body.reply_markup.inline_keyboard) || [])
          .flat().filter((button) => /^L:0:/.test(button.callback_data || ''))
          .map((button) => [button.text, button.callback_data]);
        const wholeKeyboard = (req) => JSON.stringify((req && req.body.reply_markup && req.body.reply_markup.inline_keyboard) || []);
        const ownRows = rowButtons(ownList);
        const refreshedRows = rowButtons(foreignEdits[0]);
        const ownLeadButtons = ownRows.length > 0 && JSON.stringify(refreshedRows) === JSON.stringify(ownRows)
          && ownRows.every(([text], i) => text === String(i + 1))
          && wholeKeyboard(foreignEdits[0]) === wholeKeyboard(ownList)
          && !wholeKeyboard(foreignEdits[0]).includes(ids[2]);
        const ownRefresh = ownChat && ownText && ownLeadButtons;
        const foreignUnchanged = foreignBefore.length === 1 && foreignAfter.length === 1
          && JSON.stringify(foreignBefore[0]) === JSON.stringify(foreignAfter[0]);
        line(foreignL.some((text) => text.includes(C2.TOAST_LEAD_GONE)) && foreignEdits.length === 1
          && !String(foreignEdits[0].body.text).includes('Browser')
          && String(foreignEdits[0].body.text).startsWith('Recent requests')
          && ownRefresh && foreignKept === 1 && foreignUnchanged,
          'OP56', 'cross-business browser taps: not found, nothing changed',
          `toast=${foreignL.some((text) => text.includes(C2.TOAST_LEAD_GONE))} own=${ownRefresh}[chat=${ownChat},text=${ownText},rows=${ownLeadButtons}] kept=${foreignKept} unchanged=${foreignUnchanged}`);

        // OP57: a single page has NO navigation row. Four rows remain, so page
        // 0 is both the first and the last page: the keyboard is the number
        // row alone — no Newer, no Older, nothing disabled, no placeholder.
        // A message sent before this layout still carries a disabled end whose
        // callback is the CURRENT page (l:0); tapping it must stay a harmless
        // no-op (one empty answer, one refresh of the same message), and a tap
        // for a page past the end is answered with a short toast. Neither
        // changes a lead. (Before: both ends rendered disabled.)
        await reset();
        await good(cb(invOwner, 'l:0'));
        const firstPage = (await edits())[0];
        const fpKb = kbOf(firstPage);
        const noopLeadsBefore = (await svc.from('leads').select('*').eq('business_id', invBiz.id).order('id')).data || [];
        const errors = [];
        const realError = console.error;
        console.error = (...args) => { errors.push(args.map(String).join(' ')); };
        try {
          await reset();
          const noopCallback = cb(invOwner, 'l:0');
          await good(noopCallback);
          const noopRequests = await sent();
          const noop = noopRequests.filter((x) => x.path.includes('/editMessageText'));
          const noopAnswers = noopRequests.filter((x) => x.path.includes('/answerCallbackQuery'));
          const noopSends = noopRequests.filter((x) => x.path.includes('/sendMessage'));
          const noopLeadsAfter = (await svc.from('leads').select('*').eq('business_id', invBiz.id).order('id')).data || [];
          const answerBody = noopAnswers[0] && noopAnswers[0].body;
          const answeredExactlyOnce = noopAnswers.length === 1
            && answerBody.callback_query_id === noopCallback.callback_query.id;
          const noErrorText = !!answerBody && (!('text' in answerBody) || answerBody.text === '');
          const sameMessageRefreshedOnce = noop.length === 1
            && noop[0].body.chat_id === invOwner
            && noop[0].body.message_id === noopCallback.callback_query.message.message_id
            && noopSends.length === 0;
          const nothingChanged = JSON.stringify(noopLeadsBefore) === JSON.stringify(noopLeadsAfter);
          const noNavRow = fpKb.length === 1 && fpKb[0].length === 4
            && fpKb[0].every((x, i) => x.text === String(i + 1) && /^L:0:[0-9a-f-]{36}$/.test(x.callback_data))
            && !fpKb.flat().some((x) => x.text === 'Newer' || x.text === 'Older' || 'disabled' in x);
          const refreshedKb = (noop[0] && noop[0].body.reply_markup && noop[0].body.reply_markup.inline_keyboard) || [];
          const refreshSame = JSON.stringify(refreshedKb) === JSON.stringify(fpKb);
          // A stale Older: the page it asks for does not exist.
          await reset();
          await good(cb(invOwner, 'l:1'));
          const pastRequests = await sent();
          const pastAnswers = pastRequests.filter((x) => x.path.includes('/answerCallbackQuery')).map((x) => String(x.body.text));
          const pastSends = pastRequests.filter((x) => x.path.includes('/sendMessage'));
          const pastLeads = (await svc.from('leads').select('*').eq('business_id', invBiz.id).order('id')).data || [];
          const pastHarmless = pastAnswers.length === 1 && pastAnswers[0] === C2.TOAST_NO_OLDER && pastSends.length === 0
            && JSON.stringify(pastLeads) === JSON.stringify(noopLeadsBefore);
          line(noNavRow && refreshSame
            && answeredExactlyOnce && noErrorText && sameMessageRefreshedOnce && nothingChanged
            && pastHarmless
            && !errors.some((l) => l.includes('tg_edit_failed')),
            'OP57', 'single page: no nav row; stale nav taps are harmless',
            `noNav=${noNavRow} answer=${answeredExactlyOnce} noErrorText=${noErrorText} sameEdit=${sameMessageRefreshedOnce} unchanged=${nothingChanged} past=${pastHarmless}`);
        } finally {
          console.error = realError;
        }

        // OP58: a very long name never reaches a button. Its button is the
        // number "1" (it is the newest row), the callback is the plain lead
        // address, and the message text keeps its own truncation (27 chars
        // and an ellipsis). No button on the page repeats a name or a job.
        // (Before: the row label carried the shortened name and the job.)
        await reset();
        await good(cb(invOwner, 'l:0'));
        const longPage = (await edits())[0];
        const longBtn = kbOf(longPage).flat().find((b) => b.callback_data === `L:0:${longLead.id}`);
        const longShown = 'Maximilian Constantine Vanderberg-Roofington The Third Esquire'.slice(0, 27) + '…';
        const longLines = String(longPage && longPage.body.text).split('\n');
        const pageLabels = kbOf(longPage).flat().map((b) => String(b.text));
        line(!!longBtn && longBtn.text === '1'
          && longBtn.callback_data === `L:0:${longLead.id}`
          && longLines[2] === `1. ${longShown}` && /^Roof replacement · /.test(longLines[3] || '')
          && pageLabels.length > 0 && pageLabels.every((t) => /^[1-5]$/.test(t)),
          'OP58', 'long name: stays in the text, the button is its number',
          `label=${JSON.stringify(longBtn && longBtn.text)} line=${JSON.stringify(longLines[2])} cb=${longBtn && longBtn.callback_data.length}B`);

        // OP59: every callback the live flow emits fits Telegram's 64 bytes.
        await reset();
        await good(msg(invOwner, '/leads'));
        await good(msg(invOwner, '/remove_lead'));
        const liveCbs = (await sent()).flatMap((x) => (x.body.reply_markup && x.body.reply_markup.inline_keyboard) || [])
          .flat().filter((b) => b.callback_data).map((b) => b.callback_data);
        const tooLong = liveCbs.filter((d) => Buffer.byteLength(d, 'utf8') > 64);
        const longest = liveCbs.reduce((a, b) => (Buffer.byteLength(b) > Buffer.byteLength(a) ? b : a), '');
        // Four rows, one page: each list emits its four number buttons and no
        // navigation row, so eight callbacks. (Before: four row buttons plus
        // two navigation ends per list, twelve, and the floor was "> 10".)
        const liveShapes = liveCbs.filter((d) => !/^[LQ]:\d{1,3}:[0-9a-f-]{36}$/.test(d));
        line(liveCbs.length === 8 && tooLong.length === 0 && liveShapes.length === 0,
          'OP59', 'live flow: every callback_data is within 64 bytes',
          `callbacks=${liveCbs.length} longest=${longest} (${Buffer.byteLength(longest)}B)`);

        // OP60: the persistent keyboard per role, attached to /help, /start
        // and the bind confirmation: at most TWO plain-text buttons, side by
        // side in ONE row. A press arrives as text and maps onto the command
        // through the same permission checks. (Before: four buttons for the
        // owner and the operator, two for staff, one per row.)
        const kbText = (req) => (req && req.body.reply_markup) || null;
        await reset();
        await good(msg(invOwner, '/help'));
        const ownerHelp = (await sends()).pop();
        await reset();
        await good(msg(invStaff, '/help'));
        const staffHelp = (await sends()).pop();
        await reset();
        await good(msg(OP, '/help'));
        const opHelp = (await sends()).pop();
        await reset();
        await svc.from('business_chats').delete().eq('tg_chat_id', unboundKeyboardChat);
        const unboundRowsBefore = (await svc.from('business_chats').select('id').eq('tg_chat_id', unboundKeyboardChat)).data.length;
        await good(msg(unboundKeyboardChat, '/start'));
        const unboundStart = (await sends()).pop();
        const unboundRowsAfter = (await svc.from('business_chats').select('id').eq('tg_chat_id', unboundKeyboardChat)).data.length;
        await reset();
        await good(msg(chatA, '/start'));
        const boundStart = (await sends()).pop();
        const labels = (kb) => (kb && kb.keyboard ? kb.keyboard.flat().map((b) => b.text) : null);
        // The exact layout: the rows as sent, every button text-only, and the
        // two flags. Literal on purpose.
        const layoutIs = (kb, rows) => !!kb && kb.is_persistent === true && kb.resize_keyboard === true
          && JSON.stringify(kb.keyboard) === JSON.stringify(rows.map((row) => row.map((text) => ({ text }))));
        const OWNER_ROWS = [['Leads', 'Invite']];
        const STAFF_ROWS = [['Leads']];
        const OPERATOR_ROWS = [['Businesses', 'Code']];
        await reset();
        await good(msg(invStaff, 'Invite'));
        const staffPress = (await sends()).map((x) => x.body.text).join('|');
        line(layoutIs(kbText(ownerHelp), OWNER_ROWS)
          && layoutIs(kbText(staffHelp), STAFF_ROWS)
          && layoutIs(kbText(opHelp), OPERATOR_ROWS)
          && kbText(unboundStart) && kbText(unboundStart).remove_keyboard === true && !('keyboard' in kbText(unboundStart))
          && unboundRowsBefore === 0 && unboundRowsAfter === 0
          && layoutIs(kbText(boundStart), OWNER_ROWS)
          && !labels(kbText(opHelp)).includes('Leads')
          && !labels(kbText(ownerHelp)).includes('Businesses') && !labels(kbText(staffHelp)).includes('Invite')
          && staffPress === C2.BOT_OWNER_ONLY,
          'OP60', 'persistent keyboard per role; presses go through permission checks',
          `owner=${layoutIs(kbText(ownerHelp), OWNER_ROWS)} staff=${layoutIs(kbText(staffHelp), STAFF_ROWS)} op=${layoutIs(kbText(opHelp), OPERATOR_ROWS)} unbound=${unboundRowsBefore}/${unboundRowsAfter} press=${staffPress === C2.BOT_OWNER_ONLY}`);

        // OP62: a reply to free text carries the chat's own role keyboard, so
        // the keyboard reopens after the user typed. The operator chat gets
        // the operator keyboard, owner and staff their own, an unbound chat
        // ReplyKeyboardRemove; a business chat never gets an operator label.
        // The hint is rate limited per chat (3 an hour), so the counters are
        // cleared before and after: this block must neither depend on nor
        // spend another test's budget.
        const hintKeys = [invOwner, invStaff, unboundKeyboardChat].map((c) => 'tghint:' + c);
        await svc.from('rate_limits').delete().in('key', hintKeys);
        const freeText = async (chat) => {
          await reset();
          await good(msg(chat, 'hello there'));
          return sends();
        };
        const opFree = await freeText(OP);
        const ownerFree = await freeText(invOwner);
        const staffFree = await freeText(invStaff);
        const unboundFree = await freeText(unboundKeyboardChat);
        await svc.from('rate_limits').delete().in('key', hintKeys);
        const oneWith = (list, text) => list.length === 1 && String(list[0].body.text) === text;
        const unboundMarkup = kbText(unboundFree[0]);
        line(oneWith(opFree, C2.OPERATOR_WELCOME) && layoutIs(kbText(opFree[0]), OPERATOR_ROWS)
          && oneWith(ownerFree, C2.BOT_PLAIN_TEXT) && layoutIs(kbText(ownerFree[0]), OWNER_ROWS)
          && oneWith(staffFree, C2.BOT_PLAIN_TEXT) && layoutIs(kbText(staffFree[0]), STAFF_ROWS)
          && oneWith(unboundFree, C2.BOT_NOT_CONNECTED)
          && !!unboundMarkup && unboundMarkup.remove_keyboard === true && !('keyboard' in unboundMarkup)
          && ![ownerFree, staffFree, unboundFree].flat().some((x) => /Businesses|Code/.test(JSON.stringify(kbText(x))))
          && !/Leads|Invite/.test(JSON.stringify(kbText(opFree[0]))),
          'OP62', 'free text reply carries the role keyboard; unbound gets none',
          `op=${layoutIs(kbText(opFree[0]), OPERATOR_ROWS)} owner=${layoutIs(kbText(ownerFree[0]), OWNER_ROWS)} staff=${layoutIs(kbText(staffFree[0]), STAFF_ROWS)} unbound=${!!unboundMarkup && unboundMarkup.remove_keyboard === true}`);
      }

      // OP45: an edit that changes nothing is a success. Telegram answers 400
      // "message is not modified"; the bot must not log it as a failure, retry,
      // or send a second message.
      {
        const C2 = await import('../lib/content.js');
        const ids = [];
        for (let i = 0; i < 6; i++) ids.push(await seedLead(invBiz.id, `Repeat ${i + 1}`, `repeat${i}@example.com`));
        await control({ mode: 'not_modified' });
        await reset();
        await good(msg(invOwner, '/leads'));
        const errors = [];
        const realError = console.error;
        console.error = (...args) => { errors.push(args.map(String).join(' ')); };
        let first;
        let second;
        try {
          await reset();
          await good(cb(invOwner, 'l:1'));
          first = (await sent()).filter((x) => x.path.includes('/answerCallbackQuery')).map((x) => String(x.body.text));
          await reset();
          await good(cb(invOwner, 'l:1'));
          second = (await sent()).filter((x) => x.path.includes('/answerCallbackQuery')).map((x) => String(x.body.text));
        } finally {
          console.error = realError;
          await control({ mode: 'ok' });
        }
        const failures = errors.filter((l) => l.includes('tg_edit_failed'));
        line(first.length === 1 && second.length === 1 && failures.length === 0
          && !second.some((t) => t === C2.TOAST_GENERIC_ERROR),
          'OP45', 'identical edit: 400 not-modified is success, no log, no retry',
          `answers=${second.join('|')} logged=${failures.length}`);
      }

      // OP40: /invite is TWO messages, like the operator's /code. The first is an
      // instruction the owner must not forward; the second is the only text a
      // client may see.
      {
        const C2 = await import('../lib/content.js');
        await reset();
        await good(msg(invOwner, '/invite'));
        const pair = (await sent()).filter((x) => x.path.includes('/sendMessage')).map((x) => x.body);
        const hint = pair[0] || {};
        const forward = pair[1] || {};
        const codeEnt = ((forward.entities) || []).find((e) => e.type === 'code');
        const code = codeEnt
          ? String(forward.text).slice(codeEnt.offset, codeEnt.offset + codeEnt.length).replace(/^\/start\s+/, '')
          : '';
        if (code) createdCodes.push(code);
        const stored = code
          ? (await svc.from('bind_codes').select('code, used_at').eq('code', code).eq('business_id', invBiz.id)).data
          : [];
        line(pair.length === 2
          && hint.text === C2.BOT_INVITE_FORWARD_HINT
          && hint.text === 'Forward the next message to the person you want to add. Do not tap it yourself.'
          && !!code && forward.text !== hint.text
          && !String(forward.text).includes('Forward the next message')
          && stored.length === 1 && stored[0].used_at === null,
          'OP40', '/invite: instruction first, then the forwardable message',
          `messages=${pair.length} code=${code.slice(0, 3)}… stored=${stored.length}`);
      }

      // OP41: a bound chat that pastes or taps a code gets ONE sentence, and the
      // code stays unused.
      {
        const C2 = await import('../lib/content.js');
        const code = mkCode(12); createdCodes.push(code);
        await createBindCode(code, bindBiz.id, new Date(Date.now() + 3600000).toISOString());
        await reset();
        await good(msg(invStaff, code));
        const pasted = String(((await sent()).filter((x) => x.path.includes('/sendMessage')).pop() || {}).body?.text);
        await reset();
        await good(msg(invStaff, '/start ' + code));
        const tapped = String(((await sent()).filter((x) => x.path.includes('/sendMessage')).pop() || {}).body?.text);
        const row = (await svc.from('bind_codes').select('used_at').eq('code', code).maybeSingle()).data;
        line(pasted === C2.BOT_ALREADY_CONNECTED_CODE && tapped === pasted
          && pasted === 'This chat is already connected to a business, so that code was not used.'
          && !/To move it/i.test(pasted) && !!row && row.used_at === null,
          'OP41', 'bound chat: one sentence, no second instruction, code unused',
          `same=${pasted === tapped} used=${row && row.used_at}`);
      }

      // OP42/OP43: a staff phone reaches no owner command and no owner callback.
      // Every command is checked on its own: one refusal says nothing about the
      // next one.
      {
        const C2 = await import('../lib/content.js');
        const codesBefore = (await svc.from('bind_codes').select('code').eq('business_id', bizA.id)).data.length;
        const rowsBefore = (await svc.from('business_chats').select('id').eq('business_id', invBiz.id)).data.length;
        const replies = {};
        for (const cmd of ['/invite', '/recipients', '/remove_lead', '/code alder-demo', '/phones alder-demo', '/businesses', '/operator']) {
          // The plain-text hint is capped at three an hour per chat; this is a
          // test of the command gate, not of the counter.
          await svc.from('rate_limits').delete().eq('key', 'tghint:' + invStaff);
          await reset();
          await good(msg(invStaff, cmd));
          replies[cmd] = String(((await sent()).filter((x) => x.path.includes('/sendMessage')).pop() || {}).body?.text);
        }
        const codesAfter = (await svc.from('bind_codes').select('code').eq('business_id', bizA.id)).data.length;
        const rowsAfter = (await svc.from('business_chats').select('id').eq('business_id', invBiz.id)).data.length;
        const ownerOnly = ['/invite', '/recipients', '/remove_lead'].every((c) => replies[c] === C2.BOT_OWNER_ONLY);
        const plain = ['/code alder-demo', '/phones alder-demo', '/businesses', '/operator'].every((c) => replies[c] === C2.BOT_PLAIN_TEXT);
        line(ownerOnly && plain && codesAfter === codesBefore && rowsAfter === rowsBefore,
          'OP42', 'staff phone: no owner command answers, nothing minted or removed',
          `owner=${ownerOnly} plain=${plain} codes=${codesBefore}->${codesAfter}`);

        const ownerRow = (await svc.from('business_chats').select('id, tg_chat_id')
          .eq('business_id', invBiz.id).order('created_at').order('id')).data[0];
        const lead = await seedLead(invBiz.id, 'Staff Target', 'stafftarget@example.com');
        const liveCodes = async () => (await svc.from('bind_codes').select('code').eq('business_id', invBiz.id)
          .is('used_at', null).gt('expires_at', new Date().toISOString())).data.map((r) => r.code).sort().join(',');
        const liveBefore = await liveCodes();
        const rowsAtStart = (await svc.from('business_chats').select('id').eq('business_id', invBiz.id)).data.length;
        const answers = {};
        for (const data of ['x:' + ownerRow.id, 'X:' + ownerRow.id, 'v:' + ownerRow.id,
          'rl:' + lead, 'RL:' + lead, 'rc:' + lead, 'rm:1', 'Q:0:' + lead, 'E:0:' + lead,
          'i:c', 'pc:' + bizA.id, 'pb:' + bizA.id]) {
          await reset();
          await good(cb(invStaff, data));
          answers[data.split(':')[0]] = (await sent()).filter((x) => x.path.includes('/answerCallbackQuery')).map((x) => String(x.body.text));
        }
        const rowsKept = (await svc.from('business_chats').select('id').eq('business_id', invBiz.id)).data.length;
        const leadKept = (await svc.from('leads').select('id').eq('id', lead)).data.length;
        const liveAfter = await liveCodes();
        const refused = ['x', 'X', 'v', 'rl', 'RL', 'rc', 'rm', 'Q', 'E']
          .every((k) => (answers[k] || []).includes(C2.TOAST_OWNER_ONLY));
        const inviteRefused = (answers.i || []).includes(C2.BOT_OWNER_ONLY);
        const pickerRefused = (answers.pc || []).includes(C2.TOAST_NOT_FOUND)
          && (answers.pb || []).includes(C2.TOAST_NOT_FOUND);
        line(refused && inviteRefused && pickerRefused && rowsKept === rowsAtStart && leadKept === 1 && liveAfter === liveBefore,
          'OP43', 'staff forged callbacks: refused, owner row, lead and codes intact',
          `rows=${rowsKept} lead=${leadKept} live=${liveBefore === liveAfter}`);
      }

      // OP61: a chat that is disconnected gets its persistent keyboard taken
      // away — one short notice carrying ReplyKeyboardRemove — through both
      // removal paths: the operator's /phones P: and the owner's /recipients
      // X:. The staff phone is re-bound afterwards (later tests still use it).
      {
        const C2 = await import('../lib/content.js');
        const sends = async () => (await sent()).filter((x) => x.path.includes('/sendMessage'));
        const edits = async () => (await sent()).filter((x) => x.path.includes('/editMessageText'));
        await svc.from('business_chats').delete().eq('business_id', invBiz.id);
        await svc.from('business_chats').insert([
          { business_id: invBiz.id, tg_chat_id: invOwner, created_at: new Date(Date.now() - 3600000).toISOString() },
          { business_id: invBiz.id, tg_chat_id: invStaff, created_at: new Date(Date.now() - 1800000).toISOString() },
        ]);
        const startingBindings = (await svc.from('business_chats').select('id').eq('business_id', invBiz.id)).data.length;
        const staffRow = (await svc.from('business_chats').select('id, tg_chat_id')
          .eq('business_id', invBiz.id).order('created_at').order('id')).data.find((r) => String(r.tg_chat_id) === String(invStaff));

        // The operator's path.
        await reset();
        await good(cb(OP, 'P:' + staffRow.id));
        const opRemoved = (await svc.from('business_chats').select('id').eq('id', staffRow.id)).data.length;
        const opNotices = (await sends()).filter((x) => String(x.body.chat_id) === String(invStaff));
        // Re-bind as the newer phone (invOwner stays the main phone).
        await svc.from('business_chats').insert({ business_id: invBiz.id, tg_chat_id: invStaff, created_at: new Date().toISOString() });

        // The owner's path: ask, then confirm.
        const again = (await svc.from('business_chats').select('id, tg_chat_id')
          .eq('business_id', invBiz.id).order('created_at').order('id')).data.find((r) => String(r.tg_chat_id) === String(invStaff));
        await reset();
        await good(cb(invOwner, 'x:' + again.id));
        await reset();
        await good(cb(invOwner, 'X:' + again.id));
        const ownerRemoved = (await svc.from('business_chats').select('id').eq('id', again.id)).data.length;
        const ownerNotices = (await sends()).filter((x) => String(x.body.chat_id) === String(invStaff));
        // Re-bind once more for anything later that expects two phones.
        await svc.from('business_chats').insert({ business_id: invBiz.id, tg_chat_id: invStaff, created_at: new Date().toISOString() });
        const rebound = (await svc.from('business_chats').select('id').eq('business_id', invBiz.id)).data.length;

        const noticeOk = (req) => !!req && req.body.text === C2.BOT_DISCONNECTED
          && req.body.reply_markup && req.body.reply_markup.remove_keyboard === true;
        line(startingBindings === 2 && opRemoved === 0 && ownerRemoved === 0
          && opNotices.length === 1 && ownerNotices.length === 1
          && noticeOk(opNotices[0]) && noticeOk(ownerNotices[0]) && rebound === 2,
          'OP61', 'unbind: the removed chat gets one notice and ReplyKeyboardRemove',
          `start=${startingBindings} op=${opNotices.length}/${opNotices.every(noticeOk)} owner=${ownerNotices.length}/${ownerNotices.every(noticeOk)} rebound=${rebound}`);
      }

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
      line(/It will stop receiving alerts\./.test(confirmText) && gone === 0, 'OP5',
        'operator remove: confirm, then the row is gone', `confirm=${/stop receiving/.test(confirmText)} gone=${gone}`);

      // OP7: /businesses lists both slugs with a phone count.
      await reset();
      await good(msg(OP, '/businesses'));
      const bizText = await allText();
      line(bizText.includes('Alder Roofing · Demo ·') && bizText.includes('Second Demo Roofing · Demo ·'), 'OP7',
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

      // OP11: the operator removes the owner phone; the oldest remaining phone
      // becomes owner. (The owner can no longer remove itself from /recipients.)
      const ownerRows = (await svc.from('business_chats').select('id').eq('business_id', opBiz.id).order('created_at').order('id')).data;
      await good(cb(OP, 'p:' + ownerRows[0].id));
      await good(cb(OP, 'P:' + ownerRows[0].id));
      await reset();
      await good(msg(opChatB, '/invite'));
      const nowOwner = (await allText()) !== C.BOT_OWNER_ONLY;
      line(nowOwner, 'OP11', 'ownership moves to the oldest remaining phone', `owner=${nowOwner}`);
      await svc.from('businesses').delete().eq('id', opBiz.id);

      // OP12: /leads has number buttons (L:page:leadId); the old o: callback
      // still sends the current card as a new message; another business's
      // lead is "Not found.".
      const leadA = await seedLead(bizA.id, 'Open Me', 'open@example.com');
      await reset();
      await good(msg(chatA2, '/leads'));
      const listSent = (await sent()).filter((x) => x.path.includes('/sendMessage'));
      const kb = listSent.length ? JSON.stringify(listSent[listSent.length - 1].body.reply_markup || {}) : '';
      const openBtn = listSent.length
        ? ((listSent[listSent.length - 1].body.reply_markup || {}).inline_keyboard || []).flat().find((b) => b.callback_data === 'L:0:' + leadA)
        : null;
      await reset();
      await good(cb(chatA2, 'o:' + leadA));
      const card = await allText();
      const foreign = await seedLead(bizB.id, 'Foreign', 'foreign@example.com');
      await reset();
      await good(cb(chatA2, 'o:' + foreign));
      const foreignAnswer = await answersNow();
      line(kb.includes('L:0:' + leadA) && !!openBtn && /^[1-5]$/.test(String(openBtn.text))
        && card.includes('Open Me') && foreignAnswer.includes('no longer here'), 'OP12',
        '/leads number button opens the browser; old o: still works; foreign is Not found',
        `kb=${kb.includes('L:0:')} card=${card.includes('Open Me')}`);

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
