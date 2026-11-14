#!/usr/bin/env node
// tests/lead-browser.test.mjs — Gate LB (the in-place /leads browser).
// HARNESS: in-process handler call, no HTTP server, no database. PostgREST is
// faked at the fetch layer with a small in-memory store (the same pattern as
// tests/recipients.test.mjs); Telegram is the loopback fake.
//
// This is the DB-free half of the browser coverage: tests/webhook.test.mjs
// proves the same flows against the real database, and this suite runs
// everywhere, so the mutation checks for the new invariants live here.
//
// What it proves:
//   LB1  /leads: one message; the text lists the leads, ONE row of number
//       buttons 1..5 matches it (created_at desc + id desc order), nothing
//       from the text is repeated in a button; first page: Older alone
//   LB2  a number tap edits the SAME message to the detail (status action,
//       then plain "Back", no copy button); Back restores the exact page; the
//       last page has Newer alone
//   LB3  status actions edit in place; a repeat tap says already updated
//   LB4  the confirm ask and its Cancel stay in the same message
//   LB5  stale navigation taps are harmless: an old disabled end is an empty
//       answer and a refresh, a page past the end is a toast; no lead changes
//   LB6  /remove_lead: the same number row and navigation; ask, cancel to the
//       same page, confirm deletes and refreshes that page
//   LB7  removing the last row of a page moves to a valid page
//   LB8  staff browses and acts; removal taps stay owner-only
//   LB9  cross-business taps find nothing and change nothing
//   LB10 old callback formats (o:, l:, rl:, RL:, rc:) keep working
//   LB11 the persistent keyboard per role: one row, at most two plain-text
//       buttons; presses map onto commands through the same permission
//       checks; the operator keyboard never reaches a business chat
//   LB12 an unbind sends one notice carrying ReplyKeyboardRemove (both paths)
//   LB13 a chat whose binding is gone fails closed on the next tap
//   LB14 the lead pages are queried created_at desc, id desc (deterministic)
//   LB15 no request carried parse_mode
//   LB16 the navigation rule on both lists: first page Older alone, middle
//       pages Newer and Older, last page Newer alone, a single page no row;
//       the keyboard is never taller than two rows; no button is disabled
//   LB17 a reply to free text carries the chat's own role keyboard (operator,
//       owner, staff), an unbound chat gets ReplyKeyboardRemove, and a
//       business chat never gets the operator keyboard
//   LB18 no button label anywhere in the suite carries an emoji

import { loadEnv } from './env.mjs';
import { fakeRes } from './helpers.mjs';
import * as C from '../lib/content.js';
import { FIXTURE_CHATS } from './fixture-ids.mjs';

loadEnv();

let failed = 0, total = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(54)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 100) : ''}`);
};

const SECRET = 'lead-browser-test-secret';
const BIZ_A = 'aaaaaaaa-0000-0000-0000-00000000000a';
const BIZ_B = 'bbbbbbbb-0000-0000-0000-00000000000b';
const OWNER = FIXTURE_CHATS.browserOwner;
const STAFF = FIXTURE_CHATS.browserStaff;
const CHAT_B = FIXTURE_CHATS.browserB;
const CHAT_X = FIXTURE_CHATS.browserX;
const OP = FIXTURE_CHATS.browserOperator;

const saved = {
  TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET,
  TELEGRAM_API_BASE: process.env.TELEGRAM_API_BASE,
  VERCEL_ENV: process.env.VERCEL_ENV,
  OPERATOR_CHAT_ID: process.env.OPERATOR_CHAT_ID,
  TELEGRAM_BOT_USERNAME: process.env.TELEGRAM_BOT_USERNAME,
};
process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
process.env.TELEGRAM_API_BASE = process.env.FAKE_TG_URL;
process.env.VERCEL_ENV = 'development';
process.env.OPERATOR_CHAT_ID = String(OP);
process.env.TELEGRAM_BOT_USERNAME = 'alder_test_bot';

const TG = process.env.FAKE_TG_URL;
const realFetch = globalThis.fetch;
const tgCtl = (body) => realFetch(TG + '/__control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const allTgRequests = []; // every request seen since the last reset, stashed for the LB15 sweep
const tgReset = async () => {
  try {
    const r = await (await realFetch(TG + '/__requests')).json();
    allTgRequests.push(...(r.requests || []));
  } catch {}
  await realFetch(TG + '/__reset', { method: 'POST' });
};
const tgReqs = async () => (await (await realFetch(TG + '/__requests')).json()).requests;

/* ---------- a very small PostgREST ---------- */

const uuid = (n) => `${String(n).padStart(8, '0')}-0000-0000-0000-${String(n).padStart(12, '0')}`;
let store;
let sbRequests = [];
const freshStore = () => ({
  businesses: [
    { id: BIZ_A, slug: 'alder-demo', name: 'Alder Roofing', status: 'demo', timezone: 'America/Chicago', owner_email: 'owner@example.com', google_review_url: 'https://g.page/r/x' },
    { id: BIZ_B, slug: 'beta', name: 'Beta Roofing', status: 'active', timezone: 'America/Chicago', owner_email: 'beta@example.com', google_review_url: 'https://g.page/r/y' },
  ],
  chats: [
    { id: uuid(1), business_id: BIZ_A, tg_chat_id: OWNER, label: null, created_at: '2026-11-01T10:00:00Z' },
    { id: uuid(2), business_id: BIZ_A, tg_chat_id: STAFF, label: null, created_at: '2026-11-02T10:00:00Z' },
    { id: uuid(3), business_id: BIZ_B, tg_chat_id: CHAT_B, label: null, created_at: '2026-11-03T10:00:00Z' },
  ],
  leads: [],
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

/** PostgREST order=a,b.desc: honour every column and direction. */
const byOrder = (order) => {
  const cols = String(order || '').split(',').filter(Boolean).map((c) => {
    const [name, dir] = c.split('.');
    return { name, desc: dir === 'desc' };
  });
  return (a, b) => {
    for (const { name, desc } of cols) {
      const av = String(a[name] == null ? '' : a[name]);
      const bv = String(b[name] == null ? '' : b[name]);
      if (av < bv) return desc ? 1 : -1;
      if (av > bv) return desc ? -1 : 1;
    }
    return 0;
  };
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
    sbRequests.push({ table, method, params });
    const json = (body, headers = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
    const countHeader = (n) => new Response(null, { status: 200, headers: { 'content-range': `0-${n ? n - 1 : 0}/${n}` } });

    if (table === 'rpc/hit_rate_limit') {
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
        const body = JSON.parse(init.body || '{}');
        for (const r of (Array.isArray(body) ? body : [body])) store.chats.push({ id: uuid(store.seq++), label: null, created_at: new Date().toISOString(), ...r });
        return json([]);
      }
      let rows = store.chats.filter((r) => match(r, params));
      rows = rows.slice().sort(byOrder(u.searchParams.get('order')));
      if (countRequested(init)) return countHeader(rows.length);
      return json(rows.map((r) => ({ ...r })));
    }
    if (table === 'businesses') {
      let rows = store.businesses.filter((r) => match(r, params));
      rows = rows.slice().sort(byOrder(u.searchParams.get('order')));
      if (u.searchParams.get('id')) return json(rows[0] || null);
      return json(rows);
    }
    if (table === 'v_client_leads') {
      let rows = store.leads.filter((r) => match(r, params));
      rows = rows.slice().sort(byOrder(u.searchParams.get('order')));
      const offset = Number(u.searchParams.get('offset') || 0);
      const limit = u.searchParams.get('limit');
      if (limit !== null) rows = rows.slice(offset, offset + Number(limit));
      return json(rows.map((r) => ({ ...r })));
    }
    if (table === 'leads') {
      if (method === 'PATCH') {
        const body = JSON.parse(init.body || '{}');
        const hit = store.leads.filter((r) => match(r, params));
        for (const r of hit) Object.assign(r, body);
        return json(hit.map((r) => ({ ...r })));
      }
      if (method === 'DELETE') {
        const doomed = store.leads.filter((r) => match(r, params));
        store.leads = store.leads.filter((r) => !match(r, params));
        return json(doomed.map((r) => ({ id: r.id })));
      }
      return json(store.leads.filter((r) => match(r, params)));
    }
    if (table === 'lead_events') {
      if (method === 'POST') { store.events.push(JSON.parse(init.body || '{}')); return json([]); }
      return json(store.events.filter((r) => match(r, params)));
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

const sends = async () => (await tgReqs()).filter((x) => x.path.includes('/sendMessage'));
const edits = async () => (await tgReqs()).filter((x) => x.path.includes('/editMessageText'));
const answers = async () => (await tgReqs()).filter((x) => x.path.includes('/answerCallbackQuery')).map((x) => String(x.body.text));
const kbOf = (req) => (req && req.body.reply_markup && req.body.reply_markup.inline_keyboard) || [];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** The exact layouts. Literal on purpose: a changed constant must fail here. */
const OWNER_KB = { keyboard: [[{ text: 'Leads' }, { text: 'Invite' }]], is_persistent: true, resize_keyboard: true };
const STAFF_KB = { keyboard: [[{ text: 'Leads' }]], is_persistent: true, resize_keyboard: true };
const OPERATOR_KB = { keyboard: [[{ text: 'Businesses' }, { text: 'Code' }]], is_persistent: true, resize_keyboard: true };
const REMOVE_KB = { remove_keyboard: true };
/** A list keyboard's first row is the number row: "1".."N", nothing else. */
const numbersOk = (row, n) => Array.isArray(row) && row.length === n
  && row.every((b, i) => b.text === String(i + 1) && same(Object.keys(b).sort(), ['callback_data', 'text']));

let seq = 1;
function seedLead(businessId, { name = 'A Lead', service = 'repair', status = 'open', created_at = null, phone = '5155550100', email = 'lead@fixture.invalid' } = {}) {
  const row = {
    id: uuid(1000 + seq), business_id: businessId, name, phone, email, zip: '50265',
    service, home: 'house', timing: 'asap', roof_age: 'Not sure',
    insurance_claim: false, notes: null, status, review_token: null,
    created_at: created_at || new Date(Date.now() - seq * 60000).toISOString(),
    idempotency_key: `lb${String(seq).padStart(4, '0')}`,
  };
  seq++;
  store.leads.push(row);
  return row.id;
}

try {
  install();
  await tgCtl({ mode: 'ok' });

  /* LB1: /leads — one message, one number row matching the text,
     deterministic order, and only the useful navigation end. */
  store = freshStore();
  {
    // Two leads share a timestamp: the id desc tie-breaker must decide. Three
    // more, strictly older, make a second page, so the Older end is real.
    const t = '2026-11-10T09:00:00Z';
    const l1 = seedLead(BIZ_A, { name: 'Tied One', created_at: t });
    const l2 = seedLead(BIZ_A, { name: 'Tied Two', created_at: t });
    const l3 = seedLead(BIZ_A, { name: 'Older One', created_at: '2026-11-09T09:00:00Z' });
    const l4 = seedLead(BIZ_A, { name: 'Even Four', created_at: '2026-11-08T09:00:00Z' });
    const l5 = seedLead(BIZ_A, { name: 'Even Five', created_at: '2026-11-07T09:00:00Z' });
    const l6 = seedLead(BIZ_A, { name: 'Even Six', created_at: '2026-11-06T09:00:00Z' });
    await tgReset();
    await call(msg(OWNER, '/leads'));
    const out = await sends();
    const list = out[out.length - 1] || {};
    const kb = kbOf(list);
    const flat = kb.flat();
    const ids = [l1, l2].sort().reverse(); // uuid desc = lexicographic desc here
    const nameOf = { [l1]: 'Tied One', [l2]: 'Tied Two', [l3]: 'Older One', [l4]: 'Even Four', [l5]: 'Even Five', [l6]: 'Even Six' };
    const order = [ids[0], ids[1], l3, l4, l5];
    const listText = String(list.body && list.body.text);
    // The number on a button is the number in front of that lead in the text.
    const numbered = listText.split('\n').filter((t) => /^\d+\. /.test(t));
    const textMatches = numbered.length === 5 && order.every((id, i) => numbered[i] === `${i + 1}. ${nameOf[id]}`);
    // Nothing from the text is repeated in a button: no name, service, age.
    const duplicated = flat.filter((b) => /Tied|Older One|Even|Repair|ago|just now|·/.test(b.text));
    line(out.length === 1
      && listText.startsWith('Recent requests')
      && listText.includes('Repair · +15155550100') && !listText.includes('Even Six')
      && textMatches
      && kb.length === 2  // the number row + one navigation row
      && numbersOk(kb[0], 5)
      && order.every((id, i) => kb[0][i].callback_data === `L:0:${id}`)
      && duplicated.length === 0
      && !flat.some((b) => b.copy_text) && !flat.some((b) => 'disabled' in b)
      && same(kb[1], [{ text: 'Older', callback_data: 'l:1' }]),
      'LB1', '/leads: one message, number row matches the text, Older alone',
      `sends=${out.length} rows=${kb.length} numbers=${(kb[0] || []).map((b) => b.text).join('')} nav=${(kb[1] || []).map((b) => b.text).join('/')}`);

    /* LB2: a number tap edits the SAME message to the detail; Back restores
       the exact page it came from. Four newer leads push Tied One onto page 1:
       page 0 = [P3, P2, P1, P0, Tied Two], page 1 = [Tied One, Older One,
       Even Four, Even Five, Even Six]. */
    const rest = [];
    for (let i = 0; i < 4; i++) rest.push(seedLead(BIZ_A, { name: `Page One ${i}` }));
    await tgReset();
    await call(cb(OWNER, `L:1:${l1}`));
    let detailEdits = await edits();
    let detailSends = await sends();
    const detail = detailEdits[0] || {};
    const dKb = kbOf(detail);
    await tgReset();
    await call(cb(OWNER, 'l:1'));
    const backEdits = await edits();
    const back = backEdits[0] || {};
    const bKb = kbOf(back);
    line(detailEdits.length === 1 && detailSends.length === 0
      && String(detail.body.text).includes('Tied One')
      && String(detail.body.text).includes('Phone: +15155550100')
      // The detail: the status action row, then plain "Back" alone. No copy
      // button (the number in the text is already tappable), no emoji.
      && dKb.length === 2
      && same(dKb[0], [{ text: 'Mark contacted', callback_data: `C:1:${l1}`, style: 'primary' }])
      && same(dKb[1], [{ text: 'Back', callback_data: 'l:1' }])
      && !dKb.flat().some((x) => x.copy_text)
      // Back: the exact page, in the same layout. Page 1 is the last page, so
      // its navigation row is Newer alone.
      && backEdits.length === 1 && bKb.length === 2
      && numbersOk(bKb[0], 5)
      && bKb[0][0].callback_data === `L:1:${l1}` && bKb[0][1].callback_data === `L:1:${l3}`
      && same(bKb[1], [{ text: 'Newer', callback_data: 'l:0' }])
      && String(back.body.text).includes('1. Tied One') && String(back.body.text).includes('2. Older One')
      && !String(back.body.text).includes('Page One 0'),
      'LB2', 'number tap edits the same message; plain Back restores the page',
      `edits=${detailEdits.length} sends=${detailSends.length} detailRows=${dKb.length} backRows=${bKb.length}`);

    /* LB3: a status action edits in place; a repeat tap says already updated. */
    await tgReset();
    await call(cb(OWNER, `C:1:${rest[3]}`));
    let cEdits = await edits();
    let cSends = await sends();
    const cKb = kbOf(cEdits[0]);
    await tgReset();
    await call(cb(OWNER, `C:1:${rest[3]}`));
    const twiceAnswers = await answers();
    const twiceEdits = await edits();
    const row = store.leads.find((r) => r.id === rest[3]);
    line(cEdits.length === 1 && cSends.length === 0
      && row.status === 'contacted'
      && String(cEdits[0].body.text).includes('Status: Contacted')
      && cKb[0][0].text === 'Job completed' && cKb[0][0].callback_data === `D:1:${rest[3]}`
      && cKb.length === 2 && same(cKb[1], [{ text: 'Back', callback_data: 'l:1' }])
      && twiceAnswers.includes(C.TOAST_ALREADY_UPDATED) && twiceEdits.length === 1,
      'LB3', 'status action edits in place; repeat says already updated',
      `edits=${cEdits.length} sends=${cSends.length} twice=${twiceAnswers.join('|')}`);

    /* LB4: the confirm ask and its Cancel stay in the same message. */
    await tgReset();
    await call(cb(OWNER, `D:1:${rest[3]}`));
    const askEdits = await edits();
    const aKb = kbOf(askEdits[0]);
    await tgReset();
    await call(cb(OWNER, `N:1:${rest[3]}`));
    const cancelEdits = await edits();
    const nKb = kbOf(cancelEdits[0]);
    line(askEdits.length === 1 && cancelEdits.length === 1
      && aKb[0][0].text === 'Send request' && aKb[0][0].callback_data === `Y:1:${rest[3]}`
      && aKb[0][1].text === 'Cancel' && aKb[0][1].callback_data === `N:1:${rest[3]}`
      && aKb.length === 2 && same(aKb[1], [{ text: 'Back', callback_data: 'l:1' }])
      && String(cancelEdits[0].body.text).includes('Status: Contacted')
      && nKb[0][0].text === 'Job completed' && nKb[0][0].callback_data === `D:1:${rest[3]}`,
      'LB4', 'confirm ask and Cancel stay in the same message',
      `ask=${askEdits.length} cancel=${cancelEdits.length}`);

    /* LB5: stale navigation taps are harmless. No end is rendered disabled
       any more, but a message sent before this layout still carries one: its
       callback is the page it is already on (l:0 on page 0), and tapping it
       must be one empty answer and one refresh of the same message. A tap for
       a page past the end (a stale Older) is answered with a short toast. In
       both cases no lead changes. */
    const errors = [];
    const realError = console.error;
    console.error = (...args) => { errors.push(args.map(String).join(' ')); };
    try {
      const before = JSON.stringify(store.leads);
      await tgReset();
      await call(cb(OWNER, 'l:0'));
      const noopEdits = await edits();
      const noopSends = await sends();
      const noopAnswerBodies = (await tgReqs()).filter((x) => x.path.includes('/answerCallbackQuery')).map((x) => x.body);
      const noopKb = kbOf(noopEdits[0]);
      await tgReset();
      await call(cb(OWNER, 'l:7'));
      const pastAnswers = await answers();
      const pastSends = await sends();
      const unchanged = JSON.stringify(store.leads) === before;
      line(noopEdits.length === 1 && noopSends.length === 0
        && noopAnswerBodies.length === 1 && !noopAnswerBodies[0].text
        && numbersOk(noopKb[0], 5) && same(noopKb[1], [{ text: 'Older', callback_data: 'l:1' }])
        && pastAnswers.length === 1 && pastAnswers[0] === C.TOAST_NO_OLDER && pastSends.length === 0
        && unchanged
        && !errors.some((l) => l.includes('tg_edit_failed')),
        'LB5', 'stale nav taps: old disabled end refreshes, past-the-end toasts',
        `edits=${noopEdits.length} answers=${noopAnswerBodies.length} past=${pastAnswers.join('|')} unchanged=${unchanged}`);
    } finally {
      console.error = realError;
    }
  }

  /* LB6/LB7: /remove_lead in the browser. Seven rows: page 0 = Remove 0..4
     (newest first), page 1 = Remove 5, Remove 6. */
  store = freshStore();
  {
    const rm = [];
    for (let i = 0; i < 7; i++) rm.push(seedLead(BIZ_A, { name: `Remove ${i}` }));
    await tgReset();
    await call(msg(OWNER, '/remove_lead'));
    const list = (await sends()).pop();
    const kb = kbOf(list);
    await tgReset();
    await call(cb(OWNER, `Q:0:${rm[0]}`));
    const ask = (await edits())[0];
    const askKb = kbOf(ask);
    await tgReset();
    await call(cb(OWNER, 'rm:0'));
    const cancelled = (await edits())[0];
    await tgReset();
    await call(cb(OWNER, `Q:0:${rm[0]}`));
    await tgReset();
    await call(cb(OWNER, `E:0:${rm[0]}`));
    const doneAnswers = await answers();
    const after = (await edits())[0];
    const stillThere = store.leads.some((r) => r.id === rm[0]);
    const rmNumbered = String(list.body.text).split('\n').filter((t) => /^\d+\. /.test(t));
    line(String(list.body.text).startsWith(C.REMOVE_LEAD_TITLE)
      // The same layout as /leads: one number row matching the text, then the
      // navigation row with only the useful end.
      && kb.length === 2 && numbersOk(kb[0], 5)
      && [0, 1, 2, 3, 4].every((i) => kb[0][i].callback_data === `Q:0:${rm[i]}` && rmNumbered[i] === `${i + 1}. Remove ${i}`)
      && same(kb[1], [{ text: 'Older', callback_data: 'rm:1' }])
      && !kb.flat().some((b) => 'disabled' in b)
      && askKb.length === 1
      && askKb[0][0].text === 'Remove' && askKb[0][0].style === 'danger' && askKb[0][0].callback_data === `E:0:${rm[0]}`
      && askKb[0][1].text === 'Cancel' && askKb[0][1].callback_data === 'rm:0'
      && String(cancelled.body.text).startsWith(C.REMOVE_LEAD_TITLE)
      && kbOf(cancelled)[0][0].callback_data.startsWith('Q:0:')
      && stillThere === false
      && String(after.body.text).startsWith(C.REMOVE_LEAD_TITLE)
      && kbOf(after)[0][0].callback_data === `Q:0:${rm[1]}`
      && doneAnswers.some((t) => t.startsWith('Removed: Remove 0')),
      'LB6', 'removal browser: ask, cancel to page, confirm deletes and refreshes',
      `gone=${!stillThere} toast=${doneAnswers.find((t) => t.startsWith('Removed:')) || ''}`);

    /* LB7: page 1 now holds Remove 5 and Remove 6. Deleting BOTH must land the
       refresh on page 0, never on an emptied page 1. */
    await tgReset();
    await call(cb(OWNER, `Q:1:${rm[5]}`));
    await tgReset();
    await call(cb(OWNER, `E:1:${rm[5]}`));
    await tgReset();
    await call(cb(OWNER, `Q:1:${rm[6]}`));
    const ask6 = (await edits())[0];
    await tgReset();
    await call(cb(OWNER, `E:1:${rm[6]}`));
    const lastPage = (await edits())[0];
    const lKb = kbOf(lastPage);
    line(String(ask6.body.text).includes('Remove 6')
      && String(lastPage.body.text).startsWith(C.REMOVE_LEAD_TITLE)
      && String(lastPage.body.text).includes('1. Remove 1')
      && lKb[0][0].callback_data === `Q:0:${rm[1]}`
      // Four rows are left: one page, so the number row and no navigation.
      && lKb.length === 1 && numbersOk(lKb[0], 4)
      && !String(lastPage.body.text).includes('Remove 6'),
      'LB7', 'deleting the last rows of a page refreshes to a valid page',
      `rows=${lKb.length} numbers=${(lKb[0] || []).map((b) => b.text).join('')}`);
  }

  /* LB8: staff browses and acts; removal stays owner-only. */
  store = freshStore();
  {
    const s1 = seedLead(BIZ_A, { name: 'Staff Sees' });
    await tgReset();
    await call(msg(STAFF, '/leads'));
    const staffList = (await sends()).pop();
    await tgReset();
    await call(cb(STAFF, `C:0:${s1}`));
    const staffEdits = await edits();
    await tgReset();
    await call(cb(STAFF, `Q:0:${s1}`));
    const staffQ = await answers();
    await tgReset();
    await call(cb(STAFF, `E:0:${s1}`));
    const staffE = await answers();
    const kept = store.leads.some((r) => r.id === s1);
    const staffRow = store.leads.find((r) => r.id === s1);
    line(!!staffList && same(kbOf(staffList), [[{ text: '1', callback_data: `L:0:${s1}` }]])
      && !!staffRow && staffRow.status === 'contacted'
      && staffEdits.length === 1 && String(staffEdits[0].body.text).includes('Status: Contacted')
      && staffQ.includes(C.TOAST_OWNER_ONLY) && staffE.includes(C.TOAST_OWNER_ONLY) && kept,
      'LB8', 'staff browses and acts; removal taps stay owner-only',
      `status=${staffRow ? staffRow.status : 'deleted'} Q=${staffQ.includes(C.TOAST_OWNER_ONLY)} E=${staffE.includes(C.TOAST_OWNER_ONLY)}`);
  }

  /* LB9: cross-business taps find nothing and change nothing. */
  store = freshStore();
  {
    const a = seedLead(BIZ_A, { name: 'Alpha Only' });
    const b = seedLead(BIZ_B, { name: 'Beta Only' });
    await tgReset();
    await call(cb(CHAT_B, `L:0:${a}`));
    const lAnswers = await answers();
    const lEdits = await edits();
    await tgReset();
    await call(cb(CHAT_B, `Q:0:${a}`));
    await tgReset();
    await call(cb(CHAT_B, `E:0:${a}`));
    const rmAnswers = await answers();
    const keptA = store.leads.some((r) => r.id === a);
    line(lAnswers.includes(C.TOAST_LEAD_GONE) && lEdits.length === 1
      && !String(lEdits[0].body.text).includes('Alpha Only')
      && String(lEdits[0].body.text).includes('Beta Only')
      && rmAnswers.includes(C.REMOVE_LEAD_GONE)
      && keptA,
      'LB9', 'cross-business taps: not found, nothing changed',
      `L=${lAnswers.includes(C.TOAST_LEAD_GONE)} keptA=${keptA}`);
  }

  /* LB10: old callback formats keep working. */
  store = freshStore();
  {
    const olds = [];
    for (let i = 0; i < 6; i++) olds.push(seedLead(BIZ_A, { name: `Old Format ${i}` }));
    await tgReset();
    await call(cb(OWNER, 'o:' + olds[0]));
    const oldSends = await sends();
    const oldEdits = await edits();
    await tgReset();
    await call(cb(OWNER, 'l:1'));
    const oldPage = (await edits())[0];
    await tgReset();
    await call(cb(OWNER, 'rl:' + olds[0]));
    const oldConfirm = (await edits())[0];
    const ocKb = kbOf(oldConfirm);
    await tgReset();
    await call(cb(OWNER, 'rc:' + olds[0]));
    const oldCancel = (await edits())[0];
    await tgReset();
    await call(cb(OWNER, 'RL:' + olds[0]));
    const oldDeleteAnswers = await answers();
    const oldDelete = (await edits())[0];
    const gone = store.leads.some((r) => r.id === olds[0]);
    line(oldSends.length === 1 && oldEdits.length === 0
      && String(oldSends[0].body.text).includes('Old Format 0')
      && String(oldPage.body.text).includes('Old Format 5')
      && ocKb[0][0].callback_data === 'RL:' + olds[0] && ocKb[0][1].callback_data === 'rc:' + olds[0]
      && String(oldCancel.body.text).startsWith(C.REMOVE_LEAD_TITLE)
      && gone === false && String(oldDelete.body.text).startsWith('Removed: Old Format 0')
      && oldDeleteAnswers.some((t) => t.startsWith('Removed: Old Format 0')),
      'LB10', 'old o:/l:/rl:/rc:/RL: callbacks keep working',
      `sends=${oldSends.length} confirm=${ocKb[0][0] && ocKb[0][0].callback_data.slice(0, 2)} gone=${gone}`);
  }

  /* LB11: the persistent keyboard per role — one row, at most two plain-text
     buttons — and presses map onto commands through the same checks. */
  store = freshStore();
  {
    seedLead(BIZ_A, { name: 'Keyboard Row' });
    await tgReset();
    await call(msg(OWNER, '/help'));
    const ownerHelp = (await sends()).pop();
    await tgReset();
    await call(msg(STAFF, '/help'));
    const staffHelp = (await sends()).pop();
    await tgReset();
    await call(msg(OP, '/help'));
    const opHelp = (await sends()).pop();
    await tgReset();
    await call(msg(CHAT_X, '/start'));
    const unbound = (await sends()).pop();
    const kbText = (req) => (req && req.body.reply_markup) || null;
    // Presses arrive as plain text and must behave exactly like the command.
    await tgReset();
    await call(msg(OWNER, 'Leads'));
    const pressLeads = (await sends()).pop();
    await tgReset();
    await call(msg(STAFF, 'Invite'));
    const pressInvite = (await sends()).pop();
    await tgReset();
    await call(msg(OP, 'Businesses'));
    const pressBiz = (await sends()).pop();
    await tgReset();
    await call(msg(OP, 'Code'));
    const pressCode = (await sends()).pop();
    // The operator's labels are not commands in a business chat: the same
    // check as the typed command, so the owner gets the plain-text hint.
    await tgReset();
    await call(msg(OWNER, 'Businesses'));
    const ownerPressBiz = (await sends()).pop();
    // A label from the keyboard a phone was sent before the cut to two
    // buttons still does what it says, and its reply replaces that keyboard.
    await tgReset();
    await call(msg(OWNER, 'Help'));
    const legacyHelp = (await sends()).pop();
    const constantsOk = same(C.persistentKeyboard(C.OWNER_KEYBOARD_LABELS), OWNER_KB)
      && same(C.persistentKeyboard(C.STAFF_KEYBOARD_LABELS), STAFF_KB)
      && same(C.persistentKeyboard(C.OPERATOR_KEYBOARD_LABELS), OPERATOR_KB);
    line(constantsOk
      && same(kbText(ownerHelp), OWNER_KB)
      && same(kbText(staffHelp), STAFF_KB)
      && same(kbText(opHelp), OPERATOR_KB)
      && same(kbText(unbound), REMOVE_KB)
      && String(pressLeads.body.text).startsWith('Recent requests')
      && String(pressInvite.body.text) === C.BOT_OWNER_ONLY
      && /Alder Roofing/.test(String(pressBiz.body.text))
      && String(pressCode.body.text) === C.OPERATOR_PICK_TEXT
      && String(ownerPressBiz.body.text) === C.BOT_PLAIN_TEXT && same(kbText(ownerPressBiz), OWNER_KB)
      && String(legacyHelp.body.text) === C.BOT_HELP && same(kbText(legacyHelp), OWNER_KB),
      'LB11', 'keyboard per role: one row, <= 2 buttons; presses map onto commands',
      `owner=${same(kbText(ownerHelp), OWNER_KB)} staff=${same(kbText(staffHelp), STAFF_KB)} op=${same(kbText(opHelp), OPERATOR_KB)} unbound=${same(kbText(unbound), REMOVE_KB)}`);
  }

  /* LB12: an unbind sends one notice carrying ReplyKeyboardRemove. */
  store = freshStore();
  {
    // The operator's /phones P: path.
    const staffRow = store.chats.find((r) => String(r.tg_chat_id) === String(STAFF));
    await tgReset();
    await call(cb(OP, 'P:' + staffRow.id));
    const pSends = await sends();
    const pNotice = pSends.find((x) => String(x.body.chat_id) === String(STAFF));
    const opRemoved = !store.chats.some((r) => r.id === staffRow.id);
    // The owner's /recipients X: path (the staff row comes back first).
    store = freshStore();
    const again = store.chats.find((r) => String(r.tg_chat_id) === String(STAFF));
    await tgReset();
    await call(cb(OWNER, 'x:' + again.id));
    await tgReset();
    await call(cb(OWNER, 'X:' + again.id));
    const xSends = await sends();
    const xNotice = xSends.find((x) => String(x.body.chat_id) === String(STAFF));
    const ownerRemoved = !store.chats.some((r) => r.id === again.id);
    const noticeOk = (req) => !!req && req.body.text === C.BOT_DISCONNECTED
      && req.body.reply_markup && req.body.reply_markup.remove_keyboard === true;
    line(opRemoved && noticeOk(pNotice) && ownerRemoved && noticeOk(xNotice),
      'LB12', 'unbind: one notice and ReplyKeyboardRemove, both paths',
      `op=${noticeOk(pNotice)} owner=${noticeOk(xNotice)}`);
  }

  /* LB13: a chat whose binding is gone fails closed on the next tap. */
  store = freshStore();
  {
    const a = seedLead(BIZ_A, { name: 'Gone Binding' });
    store.chats = store.chats.filter((r) => String(r.tg_chat_id) !== String(OWNER));
    await tgReset();
    await call(cb(OWNER, `L:0:${a}`));
    const goneAnswers = await answers();
    const goneEdits = await edits();
    const kept = store.leads.some((r) => r.id === a);
    line(goneAnswers.includes(C.TOAST_NOT_FOUND) && goneEdits.length === 0 && kept
      && store.leads.find((r) => r.id === a).status === 'open',
      'LB13', 'a removed binding fails closed on the next tap',
      `answer=${goneAnswers.join('|')} edits=${goneEdits.length}`);
  }

  /* LB14: the pages are queried created_at desc, id desc (deterministic).
     Single-row reads address the lead by id and need no order; every paged
     read (offset/limit) must carry the full deterministic order. */
  {
    const pageQueries = sbRequests.filter((r) => r.table === 'v_client_leads' && r.method === 'GET' && r.params.some(([k]) => k === 'offset'));
    const off = pageQueries.filter((r) => (r.params.find(([k]) => k === 'order') || ['', ''])[1] !== 'created_at.desc,id.desc');
    line(pageQueries.length > 5 && off.length === 0,
      'LB14', 'lead pages are queried created_at desc, id desc',
      `pageQueries=${pageQueries.length} off=${off.length}`);
  }

  /* LB16: the navigation rule, on both lists. Eleven rows are three pages:
     the first has Older alone, the middle has Newer and Older side by side,
     the last has Newer alone. Three rows are one page: no navigation row at
     all. The keyboard is never taller than two rows and no button is
     disabled or a placeholder. */
  store = freshStore();
  {
    for (let i = 0; i < 11; i++) seedLead(BIZ_A, { name: `Nav ${i}` });
    const pageKb = async (data) => { await tgReset(); await call(cb(OWNER, data)); return kbOf((await edits())[0]); };
    await tgReset();
    await call(msg(OWNER, '/leads'));
    const l0 = kbOf((await sends()).pop());
    const l1 = await pageKb('l:1');
    const l2 = await pageKb('l:2');
    await tgReset();
    await call(msg(OWNER, '/remove_lead'));
    const r0 = kbOf((await sends()).pop());
    const r1 = await pageKb('rm:1');
    const r2 = await pageKb('rm:2');
    // One page only: BIZ_B has three rows.
    for (let i = 0; i < 3; i++) seedLead(BIZ_B, { name: `Single ${i}` });
    await tgReset();
    await call(msg(CHAT_B, '/leads'));
    const single = kbOf((await sends()).pop());
    await tgReset();
    await call(msg(CHAT_B, '/remove_lead'));
    const singleRm = kbOf((await sends()).pop());
    const every = [l0, l1, l2, r0, r1, r2, single, singleRm];
    const navOk = (kb, n, nav) => kb.length === (nav ? 2 : 1) && numbersOk(kb[0], n) && (nav ? same(kb[1], nav) : true);
    const ok = navOk(l0, 5, [{ text: 'Older', callback_data: 'l:1' }])
      && navOk(l1, 5, [{ text: 'Newer', callback_data: 'l:0' }, { text: 'Older', callback_data: 'l:2' }])
      && navOk(l2, 1, [{ text: 'Newer', callback_data: 'l:1' }])
      && navOk(r0, 5, [{ text: 'Older', callback_data: 'rm:1' }])
      && navOk(r1, 5, [{ text: 'Newer', callback_data: 'rm:0' }, { text: 'Older', callback_data: 'rm:2' }])
      && navOk(r2, 1, [{ text: 'Newer', callback_data: 'rm:1' }])
      && navOk(single, 3, null) && navOk(singleRm, 3, null)
      && l1[0].every((b) => /^L:1:/.test(b.callback_data)) && r1[0].every((b) => /^Q:1:/.test(b.callback_data))
      && every.every((kb) => kb.length <= 2 && !kb.flat().some((b) => 'disabled' in b || b.copy_text));
    line(ok, 'LB16', 'nav: Older / Newer+Older / Newer / none; never above two rows',
      `leads=${[l0, l1, l2, single].map((kb) => (kb[1] || []).map((b) => b.text).join('+') || 'none').join(' | ')} remove=${[r0, r1, r2, singleRm].map((kb) => (kb[1] || []).map((b) => b.text).join('+') || 'none').join(' | ')}`);
  }

  /* LB17: a reply to free text carries the chat's own role keyboard, so the
     keyboard reopens after the user typed. Operator chat: the operator
     keyboard. Owner and staff: their own. Unbound: ReplyKeyboardRemove and no
     keyboard. A business chat never gets the operator keyboard, even when
     its id is also OPERATOR_CHAT_ID. The hint stays rate limited (3 an hour):
     the fourth free text gets no message, so nothing can carry a keyboard. */
  store = freshStore();
  {
    const kbText = (req) => (req && req.body.reply_markup) || null;
    const say = async (chatId, text) => { await tgReset(); await call(msg(chatId, text)); return sends(); };
    const opFree = await say(OP, 'hello there');
    const ownerFree = await say(OWNER, 'hello there');
    const ownerUnknown = await say(OWNER, '/nosuchcommand');
    const ownerCode = await say(OWNER, 'K7M2QPX9RT4W');
    const staffFree = await say(STAFF, 'what is this');
    const unboundFree = await say(CHAT_X, 'hello there');
    const bChat = await say(CHAT_B, 'hello there');
    // The owner's third hint this hour, then the fourth: no message at all.
    const ownerThird = await say(OWNER, 'third');
    const ownerFourth = await say(OWNER, 'fourth');
    // The belt: OPERATOR_CHAT_ID pointing at a bound chat. The text is the
    // operator's, the keyboard is still the business one.
    const opEnv = process.env.OPERATOR_CHAT_ID;
    let boundOperator;
    try {
      process.env.OPERATOR_CHAT_ID = String(STAFF);
      boundOperator = await say(STAFF, 'hello again');
    } finally {
      process.env.OPERATOR_CHAT_ID = opEnv;
    }
    const one = (list, text, kb) => list.length === 1 && String(list[0].body.text) === text && same(kbText(list[0]), kb);
    const ok = one(opFree, C.OPERATOR_WELCOME, OPERATOR_KB)
      && one(ownerFree, C.BOT_PLAIN_TEXT, OWNER_KB)
      && one(ownerUnknown, C.BOT_PLAIN_TEXT, OWNER_KB)
      && one(ownerCode, C.BOT_ALREADY_CONNECTED_CODE, OWNER_KB)
      && one(staffFree, C.BOT_PLAIN_TEXT, STAFF_KB)
      && one(unboundFree, C.BOT_NOT_CONNECTED, REMOVE_KB)
      && one(bChat, C.BOT_PLAIN_TEXT, OWNER_KB)
      && one(ownerThird, C.BOT_PLAIN_TEXT, OWNER_KB)
      && ownerFourth.length === 0
      && one(boundOperator, C.OPERATOR_WELCOME, STAFF_KB)
      // No business chat was ever sent an operator label, and the operator
      // chat was never sent a business one.
      && [ownerFree, ownerUnknown, ownerCode, staffFree, bChat, ownerThird, boundOperator, unboundFree].flat()
        .every((x) => !/Businesses|Code/.test(JSON.stringify(kbText(x))))
      && !/Leads|Invite/.test(JSON.stringify(kbText(opFree[0])));
    line(ok, 'LB17', 'free text reply carries the role keyboard; unbound gets none',
      `op=${one(opFree, C.OPERATOR_WELCOME, OPERATOR_KB)} owner=${one(ownerFree, C.BOT_PLAIN_TEXT, OWNER_KB)} staff=${one(staffFree, C.BOT_PLAIN_TEXT, STAFF_KB)} unbound=${one(unboundFree, C.BOT_NOT_CONNECTED, REMOVE_KB)} fourth=${ownerFourth.length} boundOp=${one(boundOperator, C.OPERATOR_WELCOME, STAFF_KB)}`);
  }

  await tgReset(); // stash the last block's requests for the sweeps below

  /* LB15: plain text only — no send or edit this whole suite carried
     parse_mode (the runnable half of the webhook's C40). */
  {
    const withParse = allTgRequests.filter((x) => x.body && x.body.parse_mode !== undefined);
    line(allTgRequests.length > 30 && withParse.length === 0,
      'LB15', 'no request carried parse_mode (plain text + entities only)',
      `requests=${allTgRequests.length} withParse=${withParse.length}`);
  }

  /* LB18: no button label carries an emoji — every inline button and every
     reply-keyboard button the whole suite sent or edited. (Status dots inside
     the message TEXT are allowed and are not looked at here.) */
  {
    const buttons = allTgRequests.flatMap((x) => {
      const m = x.body && x.body.reply_markup;
      if (!m) return [];
      return [...(m.inline_keyboard || []), ...(m.keyboard || [])].flat();
    });
    const withEmoji = buttons.filter((b) => /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE0F}\u{200D}\u{2190}-\u{21FF}]/u.test(String(b.text)));
    const iconField = buttons.filter((b) => 'icon_custom_emoji_id' in b);
    line(buttons.length > 100 && withEmoji.length === 0 && iconField.length === 0,
      'LB18', 'no button label carries an emoji or a custom-emoji icon',
      `buttons=${buttons.length} emoji=${withEmoji.map((b) => b.text).slice(0, 3).join(',') || 'none'}`);
  }
} catch (e) {
  line(false, 'LB0', 'lead-browser suite threw', e.message);
} finally {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await tgCtl({ mode: 'ok' }).catch(() => {});
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
