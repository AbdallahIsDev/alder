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
//   LB1  /leads: one message, labeled rows, created_at desc + id desc order,
//       both nav ends always present, the unavailable one disabled
//   LB2  a row tap edits the SAME message to the detail; Back restores the
//       exact page it came from
//   LB3  status actions edit in place; a repeat tap says already updated
//   LB4  the confirm ask and its Cancel stay in the same message
//   LB5  a forced tap on a disabled end is a harmless no-op
//   LB6  /remove_lead: ask, cancel to the same page, confirm deletes and
//       refreshes that page
//   LB7  removing the last row of a page moves to a valid page
//   LB8  staff browses and acts; removal taps stay owner-only
//   LB9  cross-business taps find nothing and change nothing
//   LB10 old callback formats (o:, l:, rl:, RL:, rc:) keep working
//   LB11 the persistent keyboard per role; presses map onto commands through
//       the same permission checks; the operator keyboard never reaches a
//       business chat
//   LB12 an unbind sends one notice carrying ReplyKeyboardRemove (both paths)
//   LB13 a chat whose binding is gone fails closed on the next tap
//   LB14 the lead pages are queried created_at desc, id desc (deterministic)

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

  /* LB1: /leads — one message, labeled rows, deterministic order, nav ends. */
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
    line(out.length === 1
      && String(list.body.text).startsWith('Recent requests')
      && String(list.body.text).includes('Tied One') && String(list.body.text).includes('Older One')
      && kb.length === 6  // five rows + nav
      && flat[0].callback_data === `L:0:${ids[0]}` && flat[1].callback_data === `L:0:${ids[1]}`
      && flat[2].callback_data === `L:0:${l3}` && flat[3].callback_data === `L:0:${l4}` && flat[4].callback_data === `L:0:${l5}`
      && flat[0].text.includes('Tied') && flat[0].text.includes('Repair')
      && !flat.some((b) => b.copy_text)
      && kb[5][0].text === 'Newer' && kb[5][0].disabled === true && kb[5][0].callback_data === 'l:0'
      && kb[5][1].text === 'Older' && !('disabled' in kb[5][1]) && kb[5][1].callback_data === 'l:1',
      'LB1', '/leads: one message, labeled rows, order, disabled first end',
      `sends=${out.length} rows=${kb.length} first=${flat[0] && flat[0].text}`);

    /* LB2: a row tap edits the SAME message to the detail; Back restores the
       exact page it came from. Four newer leads push Tied One onto page 1:
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
      && dKb[0][0].text === 'Mark contacted' && dKb[0][0].callback_data === `C:1:${l1}`
      && dKb.some((r) => r.some((x) => x.callback_data === 'l:1'))
      && dKb.flat().some((x) => x.copy_text && x.copy_text.text === '+15155550100')
      && backEdits.length === 1 && bKb.length === 6
      && bKb[0][0].callback_data === `L:1:${l1}` && bKb[1][0].callback_data === `L:1:${l3}`
      && String(back.body.text).includes('Older One')
      && !String(back.body.text).includes('Page One 0'),
      'LB2', 'row tap edits the same message; Back restores the exact page',
      `edits=${detailEdits.length} sends=${detailSends.length} backRows=${bKb.length}`);

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
      && String(cancelEdits[0].body.text).includes('Status: Contacted')
      && nKb[0][0].text === 'Job completed' && nKb[0][0].callback_data === `D:1:${rest[3]}`,
      'LB4', 'confirm ask and Cancel stay in the same message',
      `ask=${askEdits.length} cancel=${cancelEdits.length}`);

    /* LB5: a forced tap on a disabled end is a harmless no-op. */
    const errors = [];
    const realError = console.error;
    console.error = (...args) => { errors.push(args.map(String).join(' ')); };
    try {
      await tgReset();
      await call(cb(OWNER, 'l:0'));
      const noopEdits = await edits();
      const noopAnswerBodies = (await tgReqs()).filter((x) => x.path.includes('/answerCallbackQuery')).map((x) => x.body);
      line(noopEdits.length === 1 && noopAnswerBodies.length === 1 && !noopAnswerBodies[0].text
        && !errors.some((l) => l.includes('tg_edit_failed')),
        'LB5', 'forced tap on a disabled end: one empty answer, one edit, no error',
        `edits=${noopEdits.length} answers=${noopAnswerBodies.length}`);
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
    line(String(list.body.text).startsWith(C.REMOVE_LEAD_TITLE)
      && kb.length === 6 && kb[0][0].callback_data === `Q:0:${rm[0]}` && kb[0][0].text.includes('Remove 0')
      && askKb[0][0].style === 'danger' && askKb[0][0].callback_data === `E:0:${rm[0]}`
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
      && String(lastPage.body.text).includes('Remove 1')
      && lKb[0][0].callback_data.startsWith('Q:0:')
      && !String(lastPage.body.text).includes('Remove 6'),
      'LB7', 'deleting the last rows of a page refreshes to a valid page',
      `first=${lKb[0] && lKb[0][0] && lKb[0][0].text}`);
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
    line(!!staffList && kbOf(staffList)[0][0].callback_data === `L:0:${s1}`
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

  /* LB11: the persistent keyboard per role; presses map onto commands. */
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
    const labels = (kb) => (kb && kb.keyboard ? kb.keyboard.flat().map((b) => b.text) : null);
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
    line(kbText(ownerHelp) && kbText(ownerHelp).is_persistent === true && kbText(ownerHelp).resize_keyboard === true
      && JSON.stringify(labels(kbText(ownerHelp))) === JSON.stringify(C.OWNER_KEYBOARD_LABELS)
      && JSON.stringify(labels(kbText(staffHelp))) === JSON.stringify(C.STAFF_KEYBOARD_LABELS)
      && JSON.stringify(labels(kbText(opHelp))) === JSON.stringify(C.OPERATOR_KEYBOARD_LABELS)
      && !labels(kbText(opHelp)).includes('Leads')
      && !labels(kbText(ownerHelp)).includes('Businesses')
      && kbText(unbound) && kbText(unbound).remove_keyboard === true
      && String(pressLeads.body.text).startsWith('Recent requests')
      && String(pressInvite.body.text) === C.BOT_OWNER_ONLY
      && /Alder Roofing/.test(String(pressBiz.body.text)),
      'LB11', 'keyboard per role; presses map onto the commands',
      `owner=${!!kbText(ownerHelp)} staff=${!!kbText(staffHelp)} op=${!!kbText(opHelp)} unbound=${!!kbText(unbound)}`);
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

  /* LB15: plain text only — no send or edit this whole suite carried
     parse_mode (the runnable half of the webhook's C40). */
  {
    const withParse = allTgRequests.filter((x) => x.body && x.body.parse_mode !== undefined);
    line(allTgRequests.length > 30 && withParse.length === 0,
      'LB15', 'no request carried parse_mode (plain text + entities only)',
      `requests=${allTgRequests.length} withParse=${withParse.length}`);
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
