#!/usr/bin/env node
// tests/recipients.test.mjs — Gate R (multiple recipients).
// HARNESS: in-process, no HTTP server, no database writes. PostgREST is faked at
// the fetch layer with a small in-memory store; Telegram is the loopback fake.
//
// What it proves:
//   R1  An unbound chat cannot /invite and no code is minted.
//   R2  A bound chat mints a code for ITS business, never another.
//   R3  The bound-chat cap (5) refuses with a short message, no code.
//   R4  The pending-invite cap (3) refuses with a short message, no code.
//   R5  /invite is rate limited per chat, fail closed (no reply).
//   R6  A code is single use: the second chat to present it is refused.
//   R7  A chat already bound elsewhere is told so and does not move; the code
//       is not consumed.
//   R8  /recipients lists bind order with "Recipient N" and one Remove button.
//   R9  A forged callback from another business cannot remove a row.
//   R10 The last recipient cannot be removed.
//   R11 A double-tap remove is idempotent.
//   R12 An alert reaches every bound chat.

import { loadEnv } from './env.mjs';
import { fakeRes } from './helpers.mjs';
import * as C from '../lib/content.js';

loadEnv();

let failed = 0, total = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(54)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 100) : ''}`);
};

const SECRET = 'recipients-test-secret';
const BIZ_A = 'aaaaaaaa-0000-0000-0000-00000000000a';
const BIZ_B = 'bbbbbbbb-0000-0000-0000-00000000000b';
import { FIXTURE_CHATS } from './fixture-ids.mjs';
const CHAT_A = FIXTURE_CHATS.recipientsA;
const CHAT_A2 = FIXTURE_CHATS.recipientsA2;
const CHAT_B = FIXTURE_CHATS.recipientsB;

const saved = {
  TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET,
  TELEGRAM_API_BASE: process.env.TELEGRAM_API_BASE,
  VERCEL_ENV: process.env.VERCEL_ENV,
  RECIPIENTS_MAX: process.env.RECIPIENTS_MAX,
  INVITES_MAX: process.env.INVITES_MAX,
};
process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
process.env.TELEGRAM_API_BASE = process.env.FAKE_TG_URL;
process.env.VERCEL_ENV = 'development';
delete process.env.RECIPIENTS_MAX;
delete process.env.INVITES_MAX;

const TG = process.env.FAKE_TG_URL;
const realFetch = globalThis.fetch;
const tgCtl = (body) => realFetch(TG + '/__control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const tgReset = () => realFetch(TG + '/__reset', { method: 'POST' });
const tgReqs = async () => (await (await realFetch(TG + '/__requests')).json()).requests;

/* ---------- a very small PostgREST ---------- */

const uuid = (n) => `${String(n).padStart(8, '0')}-0000-0000-0000-000000000000`;
let store;
const freshStore = () => ({
  businesses: [
    { id: BIZ_A, slug: 'alder-demo', name: 'Alder Roofing', status: 'demo', timezone: 'America/Chicago', owner_email: 'owner@example.com', google_review_url: 'https://g.page/r/x' },
    { id: BIZ_B, slug: 'beta', name: 'Beta Roofing', status: 'active', timezone: 'America/Chicago', owner_email: 'beta@example.com', google_review_url: 'https://g.page/r/y' },
  ],
  chats: [],
  codes: [],
  events: [],
  claims: new Map(),
  seq: 100,
});

const countRequested = (init) => {
  const h = init.headers || {};
  const prefer = h.Prefer || h.prefer || '';
  return String(prefer).includes('count=exact') || String(init.method || '').toUpperCase() === 'HEAD';
};

const match = (row, params) => {
  for (const [key, raw] of params) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(key)) continue;
    const v = row[key];
    if (raw.startsWith('eq.')) { if (String(v) !== raw.slice(3)) return false; continue; }
    if (raw === 'is.null') { if (v !== null && v !== undefined) return false; continue; }
    if (raw.startsWith('gt.')) { if (!(new Date(v) > new Date(raw.slice(3)))) return false; continue; }
    if (raw.startsWith('lt.')) { if (!(new Date(v) < new Date(raw.slice(3)))) return false; continue; }
    if (raw.startsWith('in.(')) {
      const list = raw.slice(4, -1).split(',');
      if (!list.includes(String(v))) return false;
      continue;
    }
  }
  return true;
};

const install = () => {
  const SB = process.env.SUPABASE_URL;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith(SB)) return realFetch(input, init);
    const u = new URL(url);
    const table = u.pathname.replace('/rest/v1/', '');
    const method = String(init.method || 'GET').toUpperCase();
    const params = [...u.searchParams.entries()];
    const json = (body, headers = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
    const countHeader = (n) => new Response(null, { status: 200, headers: { 'content-range': `0-${n ? n - 1 : 0}/${n}` } });

    if (table === 'rpc/hit_rate_limit') {
      // A real counter: allow while the count is under p_max, like the SQL.
      const { p_key: key, p_max: max } = JSON.parse(init.body || '{}');
      const n = (store.claims.get(key) || 0) + 1;
      store.claims.set(key, n);
      return json(n <= Number(max || 1));
    }
    if (table === 'business_chats') {
      if (method === 'DELETE') {
        const doomed = store.chats.filter((r) => match(r, params));
        store.chats = store.chats.filter((r) => !match(r, params));
        return json(doomed.map((r) => ({ id: r.id })));
      }
      if (method === 'POST') {
        if (store.failBind) return new Response('{}', { status: 500 });
        const body = JSON.parse(init.body || '{}');
        const rows = Array.isArray(body) ? body : [body];
        for (const r of rows) {
          // Simulate a concurrent bind landing between the read and the write.
          if (store.raceBind && String(r.tg_chat_id) === String(store.raceBind.chatId)) {
            store.chats.push({ id: uuid(store.seq++), business_id: store.raceBind.businessId, tg_chat_id: r.tg_chat_id, label: null, created_at: new Date().toISOString() });
            store.raceBind = null;
            return json([]);
          }
          if (!store.chats.some((c) => String(c.tg_chat_id) === String(r.tg_chat_id))) {
            store.chats.push({ id: uuid(store.seq++), label: null, created_at: new Date().toISOString(), ...r });
          }
        }
        return json([]);
      }
      // Honour order= like PostgREST, or a reversed sort in the client looks correct.
      const order = u.searchParams.get('order') || '';
      const desc = order.endsWith('.desc');
      const rows = store.chats.filter((r) => match(r, params))
        .sort((a, b) => (desc ? -1 : 1) * (a.created_at < b.created_at ? -1 : 1));
      if (countRequested(init)) return countHeader(rows.length);
      return json(rows.map((r) => ({ ...r })));
    }
    if (table === 'bind_codes') {
      if (method === 'POST') {
        const body = JSON.parse(init.body || '{}');
        for (const r of (Array.isArray(body) ? body : [body])) store.codes.push({ used_at: null, ...r });
        return json([]);
      }
      if (method === 'PATCH') {
        const body = JSON.parse(init.body || '{}');
        const hit = store.codes.filter((r) => match(r, params));
        for (const r of hit) {
          if ('used_at' in body) r.used_at = body.used_at;
          if ('expires_at' in body) r.expires_at = body.expires_at;
        }
        return json(hit.map((r) => ({ business_id: r.business_id, code: r.code })));
      }
      let rows = store.codes.filter((r) => match(r, params));
      if ((u.searchParams.get('order') || '').startsWith('expires_at')) {
        rows = rows.slice().sort((a, b) => (a.expires_at < b.expires_at ? -1 : 1));
      }
      if (countRequested(init)) return countHeader(rows.length);
      return json(rows);
    }
    if (table === 'businesses') {
      const rows = store.businesses.filter((r) => match(r, params));
      if (u.searchParams.get('id')) return json(rows[0] || null);
      return json(rows);
    }
    if (table === 'lead_events') {
      if (method === 'POST') { store.events.push(JSON.parse(init.body || '{}')); return json([]); }
      return json([]);
    }
    return json([]);
  };
};

const call = async (update) => {
  const { default: tgHandler } = await import('../api/tg.js');
  const res = fakeRes();
  await tgHandler({
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
    body: update, socket: {},
  }, res);
  return res;
};
const msg = (chatId, text) => ({ message: { message_id: 1, chat: { id: chatId, type: 'private' }, text } });
const cb = (chatId, data) => ({ callback_query: { id: 'cb-' + Math.random().toString(36).slice(2, 8), data, message: { message_id: 9, chat: { id: chatId, type: 'private' } } } });

const texts = (reqs) => reqs.filter((r) => r.path.includes('/sendMessage')).map((r) => r.body.text);
const lastText = async () => { const t = texts(await tgReqs()); return t[t.length - 1] || ''; };

try {
  install();
  await tgCtl({ mode: 'ok' });

  /* R1: unbound chat */
  store = freshStore();
  await tgReset();
  await call(msg(CHAT_A, '/invite'));
  const r1 = await lastText();
  line(r1.includes("isn't connected") && store.codes.length === 0, 'R1',
    'unbound chat cannot /invite, no code minted', `codes=${store.codes.length} text=${r1.slice(0, 30)}`);

  /* R2: bound chat mints for its own business */
  store = freshStore();
  store.chats.push({ id: uuid(1), business_id: BIZ_A, tg_chat_id: CHAT_A, label: null, created_at: '2026-11-01T10:00:00Z' });
  await tgReset();
  await call(msg(CHAT_A, '/invite'));
  const r2 = await lastText();
  const minted = store.codes[0];
  line(store.codes.length === 1 && minted.business_id === BIZ_A && /^[A-HJ-NP-Z2-9]{12}$/.test(minted.code)
    && r2.includes('/start ' + minted.code), 'R2',
    'bound chat mints one code for its own business', `codes=${store.codes.length} biz=${minted && minted.business_id === BIZ_A} fmt=${minted && /^[A-HJ-NP-Z2-9]{12}$/.test(minted.code)}`);

  /* R3: bound-chat cap */
  store = freshStore();
  for (let i = 0; i < 5; i++) store.chats.push({ id: uuid(10 + i), business_id: BIZ_A, tg_chat_id: CHAT_A + i, label: null, created_at: `2026-11-0${i + 1}T10:00:00Z` });
  await tgReset();
  await call(msg(CHAT_A, '/invite'));
  const r3 = await lastText();
  line(store.codes.length === 0 && r3.includes('maximum number of phones'), 'R3',
    'bound-chat cap refuses, no code', `codes=${store.codes.length}`);

  /* R4: pending-invite cap — lists the invites, never the codes, one button */
  store = freshStore();
  store.chats.push({ id: uuid(1), business_id: BIZ_A, tg_chat_id: CHAT_A, label: null, created_at: '2026-11-01T10:00:00Z' });
  const soon = (h) => new Date(Date.now() + h * 3600000).toISOString();
  for (const h of [5, 12, 23]) store.codes.push({ code: `LIVE${h}CODE2345`, business_id: BIZ_A, expires_at: soon(h), used_at: null });
  await tgReset();
  await call(msg(CHAT_A, '/invite'));
  const r4 = await lastText();
  const r4send = (await tgReqs()).filter((r) => r.path.includes('/sendMessage')).pop();
  const r4btn = (r4send && r4send.body.reply_markup && r4send.body.reply_markup.inline_keyboard[0][0]) || {};
  const leaked = store.codes.some((c) => r4.includes(c.code));
  line(store.codes.length === 3 && /3 unused invites/.test(r4) && /Invite 1 · expires in 5 h/.test(r4)
    && !leaked && r4btn.callback_data === 'i:c' && String(r4btn.text).length > 10,
    'R4', 'pending-invite cap: counts and expiry, no code, one button',
    `codes=${store.codes.length} cb=${r4btn.callback_data} leaked=${leaked}`);

  /* R5: rate limit per chat. A cap of 10 keeps the pending cap out of the way,
     so the 6th call is the rate limit itself, and it says so. */
  store = freshStore();
  store.chats.push({ id: uuid(1), business_id: BIZ_A, tg_chat_id: CHAT_A, label: null, created_at: '2026-11-01T10:00:00Z' });
  process.env.INVITES_MAX = '10';
  await tgReset();
  for (let i = 0; i < 5; i++) await call(msg(CHAT_A, '/invite'));
  const before6 = texts(await tgReqs()).length;
  await call(msg(CHAT_A, '/invite'));
  const r5 = await lastText();
  delete process.env.INVITES_MAX;
  line(before6 === 5 && store.codes.length === 5 && r5 === C.BOT_INVITE_RATE_LIMIT,
    'R5', 'invite rate limit: 5 per hour, 6th says so, no code',
    `replies=${before6} codes=${store.codes.length}`);

  /* R6: single use */
  store = freshStore();
  store.codes.push({ code: 'ONLYONECODE2', business_id: BIZ_A, expires_at: '2099-01-01T00:00:00Z', used_at: null });
  await tgReset();
  await call(msg(CHAT_A, '/start ONLYONECODE2'));
  const firstBind = store.chats.length;
  await call(msg(CHAT_A2, '/start ONLYONECODE2'));
  const r6 = await lastText();
  line(firstBind === 1 && store.chats.length === 1 && r6.includes("isn't valid or has expired"), 'R6',
    'a code binds one chat, the second is refused', `chats=${store.chats.length} text=${r6.slice(0, 24)}`);

  /* R7: already bound elsewhere does not move */
  store = freshStore();
  store.chats.push({ id: uuid(1), business_id: BIZ_B, tg_chat_id: CHAT_B, label: null, created_at: '2026-11-01T10:00:00Z' });
  store.codes.push({ code: 'MOVEMECODE23', business_id: BIZ_A, expires_at: '2099-01-01T00:00:00Z', used_at: null });
  await tgReset();
  await call(msg(CHAT_B, '/start MOVEMECODE23'));
  const r7 = await lastText();
  const stillB = store.chats.find((c) => String(c.tg_chat_id) === String(CHAT_B));
  line(r7.includes("You're all set") && stillB.business_id === BIZ_B && store.codes[0].used_at === null
    && store.chats.length === 1, 'R7',
    'a chat bound elsewhere is told so, does not move, code intact',
    `biz=${stillB.business_id === BIZ_B} used=${!!store.codes[0].used_at} chats=${store.chats.length}`);

  /* R8: the list */
  store = freshStore();
  store.chats.push(
    { id: uuid(1), business_id: BIZ_A, tg_chat_id: CHAT_A, label: null, created_at: '2026-11-01T10:00:00Z' },
    { id: uuid(2), business_id: BIZ_A, tg_chat_id: CHAT_A2, label: null, created_at: '2026-11-02T10:00:00Z' },
    { id: uuid(3), business_id: BIZ_A, tg_chat_id: FIXTURE_CHATS.recipientsOffice, label: 'Office', created_at: '2026-11-03T10:00:00Z' },
  );
  await tgReset();
  await call(msg(CHAT_A, '/recipients'));
  const reqs8 = await tgReqs();
  const listMsg = reqs8.filter((r) => r.path.includes('/sendMessage')).pop();
  const kb = listMsg && listMsg.body.reply_markup && listMsg.body.reply_markup.inline_keyboard;
  const r8 = listMsg ? listMsg.body.text : '';
  const kbOk = Array.isArray(kb) && kb.length === 3 && kb[0][0].callback_data === 'x:' + uuid(1) && kb[2][0].callback_data === 'x:' + uuid(3);
  line(r8.includes('1. Recipient 1') && r8.includes('2. Recipient 2') && r8.includes('3. Office') && kbOk, 'R8',
    '/recipients lists bind order with one Remove button each',
    `rows=${kb ? kb.length : 0} labels=${r8.includes('Office')}`);

  /* R9: forged cross-business callback */
  store = freshStore();
  store.chats.push(
    { id: uuid(1), business_id: BIZ_A, tg_chat_id: CHAT_A, label: null, created_at: '2026-11-01T10:00:00Z' },
    { id: uuid(2), business_id: BIZ_A, tg_chat_id: CHAT_A2, label: null, created_at: '2026-11-02T10:00:00Z' },
    { id: uuid(3), business_id: BIZ_B, tg_chat_id: CHAT_B, label: null, created_at: '2026-11-03T10:00:00Z' },
  );
  await tgReset();
  await call(cb(CHAT_A, 'X:' + uuid(3)));     // chat A tries to remove B's row
  const victim = store.chats.find((c) => c.id === uuid(3));
  line(!!victim && store.chats.length === 3, 'R9', 'forged cross-business remove does nothing',
    `rows=${store.chats.length} victim=${!!victim}`);

  /* R10: last recipient */
  store = freshStore();
  store.chats.push({ id: uuid(1), business_id: BIZ_A, tg_chat_id: CHAT_A, label: null, created_at: '2026-11-01T10:00:00Z' });
  await tgReset();
  await call(cb(CHAT_A, 'X:' + uuid(1)));
  const answers10 = (await tgReqs()).filter((r) => r.path.includes('/answerCallbackQuery'));
  line(store.chats.length === 1 && answers10.length === 1 && String(answers10[0].body.text).includes('last phone'), 'R10',
    'the last recipient cannot be removed', `rows=${store.chats.length} toast=${answers10[0] && answers10[0].body.text}`);

  /* R11: double tap */
  store = freshStore();
  store.chats.push(
    { id: uuid(1), business_id: BIZ_A, tg_chat_id: CHAT_A, label: null, created_at: '2026-11-01T10:00:00Z' },
    { id: uuid(2), business_id: BIZ_A, tg_chat_id: CHAT_A2, label: null, created_at: '2026-11-02T10:00:00Z' },
  );
  await tgReset();
  await call(cb(CHAT_A, 'X:' + uuid(2)));
  await call(cb(CHAT_A, 'X:' + uuid(2)));
  const answers11 = (await tgReqs()).filter((r) => r.path.includes('/answerCallbackQuery')).map((r) => String(r.body.text));
  line(store.chats.length === 1 && answers11.length === 2 && answers11[0] !== answers11[1]
    && answers11[1].includes('already removed'), 'R11',
    'double-tap remove is idempotent', `rows=${store.chats.length} toasts=${answers11.join(' / ')}`);

  /* R13: the new copy is single-tenant too. "another phone" is fine; "another
     business", "other roofers" or "shared" are not. */
  {
    const C = await import('../lib/content.js');
    const all = [
      C.BOT_INVITE_CAPPED, C.botInvitePendingText({ hours: [5, 12, 23] }), C.BOT_INVITE_CANCEL_BUTTON,
      C.BOT_INVITE_CANCELLED, C.BOT_INVITE_CANCEL_ALREADY, C.BOT_INVITE_RATE_LIMIT, C.BOT_RECIPIENT_LAST,
      C.BOT_RECIPIENT_REMOVED, C.BOT_RECIPIENT_GONE, C.BOT_RECIPIENTS_EMPTY,
      C.botInviteText('K7M2QPX9RT4W'), C.botRecipientsText([{ id: 'a', label: null }]),
      C.recipientConfirmText({ id: 'a', label: null }, 0),
    ];
    const banned = /another (roofer|business|compan)|other (roofer|business|compan)|multiple|shared|administrator|provider/i;
    const hits = all.filter((t) => banned.test(t));
    line(hits.length === 0 && all.every((t) => !t.includes('{')), 'R13',
      'recipient copy is single-tenant, no placeholders', `strings=${all.length} banned=${hits.length}`);
  }

  /* R14: the phone list is ordered deterministically. The owner is the first
     row, so a tie on created_at must be broken by id or "main phone" flips. */
  {
    const src = await import('node:fs').then((fs) => fs.readFileSync('lib/db.js', 'utf8'));
    const fn = src.slice(src.indexOf('export async function listBusinessChatsDetailed'), src.indexOf('export async function getBusinessChat'));
    const ok = fn.includes(".order('created_at', { ascending: true })") && fn.includes(".order('id', { ascending: true })");
    line(ok, 'R14', 'listBusinessChatsDetailed orders by created_at then id', `ok=${ok}`);
  }

  /* R15: the owner taps the cap button. Old invites die, exactly one new code
     is minted, and the normal invite text is sent. */
  {
    store = freshStore();
    store.chats.push({ id: uuid(1), business_id: BIZ_A, tg_chat_id: CHAT_A, label: null, created_at: '2026-11-01T10:00:00Z' });
    for (const h of [5, 12, 23]) store.codes.push({ code: `OLD${h}CODE23456`, business_id: BIZ_A, expires_at: soon(h), used_at: null });
    await tgReset();
    await call(cb(CHAT_A, 'i:c'));
    const live = store.codes.filter((c) => !c.used_at && new Date(c.expires_at) > new Date());
    const inv = await lastText();
    line(store.codes.length === 4 && live.length === 1 && inv.includes('/start ' + live[0].code),
      'R15', 'cancel tap: old invites expire, one new code, invite text',
      `rows=${store.codes.length} live=${live.length}`);
  }

  /* R16: a second tap inside the mutex must not mint a second code. */
  {
    await tgReset();
    await call(cb(CHAT_A, 'i:c'));
    const live = store.codes.filter((c) => !c.used_at && new Date(c.expires_at) > new Date());
    const answers16 = (await tgReqs()).filter((r) => r.path.includes('/answerCallbackQuery')).map((r) => String(r.body.text));
    line(live.length === 1 && store.codes.length === 4 && answers16.includes(C.BOT_INVITE_CANCEL_ALREADY),
      'R16', 'double tap: no second code, says already cancelled',
      `live=${live.length} rows=${store.codes.length}`);
  }

  /* R17: a staff phone cannot cancel, and nothing changes. */
  {
    store = freshStore();
    store.chats.push(
      { id: uuid(1), business_id: BIZ_A, tg_chat_id: CHAT_A, label: null, created_at: '2026-11-01T10:00:00Z' },
      { id: uuid(2), business_id: BIZ_A, tg_chat_id: CHAT_A2, label: null, created_at: '2026-11-02T10:00:00Z' },
    );
    for (const h of [5, 12, 23]) store.codes.push({ code: `STF${h}CODE23456`, business_id: BIZ_A, expires_at: soon(h), used_at: null });
    await tgReset();
    await call(cb(CHAT_A2, 'i:c'));
    const answers17 = (await tgReqs()).filter((r) => r.path.includes('/answerCallbackQuery')).map((r) => String(r.body.text));
    const live = store.codes.filter((c) => !c.used_at && new Date(c.expires_at) > new Date());
    line(live.length === 3 && store.codes.length === 3 && answers17.includes(C.BOT_OWNER_ONLY),
      'R17', 'staff phone: owner-only, nothing expired or minted',
      `live=${live.length} toasts=${answers17.join('/')}`);
  }

  /* R18: an unbound chat tapping the button gets the generic answer. */
  {
    store = freshStore();
    await tgReset();
    await call(cb(CHAT_A, 'i:c'));
    const answers18 = (await tgReqs()).filter((r) => r.path.includes('/answerCallbackQuery')).map((r) => String(r.body.text));
    line(store.codes.length === 0 && answers18.includes(C.TOAST_NOT_FOUND),
      'R18', 'unbound chat: generic answer, nothing minted', `codes=${store.codes.length}`);
  }

  /* R19: a code redeemed between the list and the tap stays used and keeps its
     expiry; the tap only expires the codes nobody used. */
  {
    store = freshStore();
    store.chats.push({ id: uuid(1), business_id: BIZ_A, tg_chat_id: CHAT_A, label: null, created_at: '2026-11-01T10:00:00Z' });
    for (const h of [5, 12, 23]) store.codes.push({ code: `RED${h}CODE23456`, business_id: BIZ_A, expires_at: soon(h), used_at: null });
    await call(msg(CHAT_A2, '/start RED5CODE23456'));
    const redeemed = store.codes.find((c) => c.code === 'RED5CODE23456');
    const redeemedExpiry = redeemed.expires_at;
    await tgReset();
    await call(cb(CHAT_A, 'i:c'));
    const live = store.codes.filter((c) => !c.used_at && new Date(c.expires_at) > new Date());
    line(!!redeemed.used_at && redeemed.expires_at === redeemedExpiry && live.length === 1,
      'R19', 'code used between list and tap: kept used, not re-expired',
      `used=${!!redeemed.used_at} live=${live.length}`);
  }

  /* R20: /recipients states how many invites are waiting. */
  {
    store = freshStore();
    store.chats.push({ id: uuid(1), business_id: BIZ_A, tg_chat_id: CHAT_A, label: null, created_at: '2026-11-01T10:00:00Z' });
    for (const h of [5, 12]) store.codes.push({ code: `PND${h}CODE23456`, business_id: BIZ_A, expires_at: soon(h), used_at: null });
    await tgReset();
    await call(msg(CHAT_A, '/recipients'));
    const r20 = await lastText();
    line(r20.includes('Pending invites: 2.'), 'R20', '/recipients names the pending count', `has=${r20.includes('Pending invites: 2.')}`);
  }

  /* R21: a rate-limited tap must not destroy the old invites. */
  {
    store = freshStore();
    store.chats.push({ id: uuid(1), business_id: BIZ_A, tg_chat_id: CHAT_A, label: null, created_at: '2026-11-01T10:00:00Z' });
    for (const h of [5, 12, 23]) store.codes.push({ code: `RTL${h}CODE23456`, business_id: BIZ_A, expires_at: soon(h), used_at: null });
    process.env.INVITES_MAX = '10';
    for (let i = 0; i < 5; i++) await call(msg(CHAT_A, '/invite'));
    const before21 = store.codes.filter((c) => !c.used_at && new Date(c.expires_at) > new Date()).length;
    await tgReset();
    await call(cb(CHAT_A, 'i:c'));
    delete process.env.INVITES_MAX;
    const after21 = store.codes.filter((c) => !c.used_at && new Date(c.expires_at) > new Date()).length;
    const answers21 = (await tgReqs()).filter((r) => r.path.includes('/answerCallbackQuery')).map((r) => String(r.body.text));
    line(before21 === 8 && after21 === 8 && answers21.includes(C.BOT_INVITE_RATE_LIMIT),
      'R21', 'rate-limited tap: old invites survive, no mint',
      `live=${before21}->${after21}`);
  }

  /* R22: a bind that silently does nothing must not burn the code. */
  {
    store = freshStore();
    store.codes.push({ code: 'RACECDE23456', business_id: BIZ_A, expires_at: '2099-01-01T00:00:00Z', used_at: null });
    store.raceBind = { chatId: CHAT_A, businessId: BIZ_B };
    await tgReset();
    await call(msg(CHAT_A, 'RACECDE23456'));
    const r22 = await lastText();
    const row = store.chats.find((c) => String(c.tg_chat_id) === String(CHAT_A));
    line(r22 === C.BOT_BOUND_ELSEWHERE && store.codes[0].used_at === null && row.business_id === BIZ_B,
      'R22', 'race: bound elsewhere, told so, code restored',
      `text=${r22.slice(0, 24)} used=${!!store.codes[0].used_at}`);
  }

  /* R23: a throwing bind restores the claim and says so. */
  {
    store = freshStore();
    store.codes.push({ code: 'THRWCDE23456', business_id: BIZ_A, expires_at: '2099-01-01T00:00:00Z', used_at: null });
    store.failBind = true;
    await tgReset();
    await call(msg(CHAT_A, 'THRWCDE23456'));
    const r23 = await lastText();
    line(r23 === C.BOT_BIND_FAILED && store.codes[0].used_at === null && store.chats.length === 0,
      'R23', 'bind throws: code restored, "ask for a new code"',
      `used=${!!store.codes[0].used_at} chats=${store.chats.length}`);
  }

  /* R24: the global bind ceiling trips at 600 (1 here) and logs. */
  {
    store = freshStore();
    store.codes.push(
      { code: 'CECDEF234567', business_id: BIZ_A, expires_at: '2099-01-01T00:00:00Z', used_at: null },
      { code: 'CECDEF678923', business_id: BIZ_A, expires_at: '2099-01-01T00:00:00Z', used_at: null },
    );
    process.env.BIND_TRIES_GLOBAL_PER_HOUR = '1';
    await tgReset();
    await call(msg(CHAT_A, 'CECDEF234567'));
    const firstOk = store.chats.length === 1;
    await call(msg(CHAT_A2, 'CECDEF678923'));
    const r24 = await lastText();
    delete process.env.BIND_TRIES_GLOBAL_PER_HOUR;
    line(firstOk && r24 === C.BOT_CODE_BAD && store.chats.length === 1 && store.codes[1].used_at === null,
      'R24', 'global bind ceiling: second attempt refused, code intact',
      `chats=${store.chats.length} used2=${!!store.codes[1].used_at} text=${r24.slice(0,30)}`);
  }

  /* R12: an alert reaches every bound chat */
  store = freshStore();
  store.chats.push(
    { id: uuid(1), business_id: BIZ_A, tg_chat_id: CHAT_A, label: null, created_at: '2026-11-01T10:00:00Z' },
    { id: uuid(2), business_id: BIZ_A, tg_chat_id: CHAT_A2, label: null, created_at: '2026-11-02T10:00:00Z' },
  );
  await tgReset();
  {
    const { sendTelegramAlert } = await import('../lib/notify.js');
    const r = await sendTelegramAlert({
      leadId: uuid(77),
      business: store.businesses[0],
      lead: { name: 'Test', phone: '+15155550142', email: '', service: 'repair', timing: 'asap', home: 'house', roof_age: 'Not sure', insurance_claim: false, zip: '50265', notes: '' },
    });
    const sent = (await tgReqs()).filter((x) => x.path.includes('/sendMessage'));
    const ids = sent.map((x) => String(x.body.chat_id)).sort();
    line(r && r.ok === true && sent.length === 2 && ids.join(',') === [String(CHAT_A), String(CHAT_A2)].sort().join(','), 'R12',
      'one alert reaches both bound chats', `sends=${sent.length} ids=${ids.join(',')}`);
  }
} catch (e) {
  line(false, 'R0', 'recipients suite threw', e.message);
} finally {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await tgCtl({ mode: 'ok' }).catch(() => {});
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
