#!/usr/bin/env node
// tests/operator-browser.test.mjs — Gate OB (the operator's /businesses browser).
// HARNESS: in-process handler call, no HTTP server, no database. PostgREST is
// faked at the fetch layer with a small in-memory store (the same pattern as
// tests/lead-browser.test.mjs); Telegram is the loopback fake.
//
// The DB-backed half is the OP series in tests/webhook.test.mjs. This suite
// runs everywhere, so the invariants of the browser are pinned here.
//
// What it proves:
//   OB1  /businesses: ONE message, five per page as "N. Name · Status · N
//        phones" in name-then-id order, one number row and Older alone; the
//        phone counts of the page come from ONE query (no query per business);
//        a paused business shows its real count; more than eight businesses
//        are listed, not refused; /phones (with or without a word after it),
//        the operator's /recipients and both keyboard labels open the same
//        screen
//   OB2  paging edits the same message: middle page Newer and Older side by
//        side, last page Newer alone, a single page no navigation row, no
//        disabled button; a page that no longer exists becomes the first one;
//        a failed count says "?" and never "0 phones"
//   OB3  a number tap edits the same message into the business: name, status,
//        Telegram status with the phone lines, request count; Terminate
//        (danger) left, Leads right, Back to the exact list page
//   OB4  Leads is read-only: the owner's list and card text, numbers, the
//        navigation rule, Back; no status, remove or copy button; every lead
//        read is scoped by the validated business id and ordered created_at
//        desc, id desc; nothing is written; a lead of another business is
//        not found
//   OB5  Terminate asks first; Cancel returns to the business; nothing is
//        sent or changed by either
//   OB6  Confirm: every bound phone gets ONE notice with ReplyKeyboardRemove
//        BEFORE the bindings are deleted; the delete is one statement scoped
//        by the business; its unused invites are expired; the business row,
//        its status, its leads and every other business are untouched; the
//        operator's message becomes the result with Back
//   OB7  a second tap, and a business with no phone, are harmless: "already
//        not connected", nothing sent, nothing written
//   OB8  a notice that fails is counted and blocks nothing
//   OB9  the terminated chat gets today's "not connected" reply for every
//        command and "not found" for every tap; an old code cannot connect it
//        again; a new /code connects it as before
//   OB10 an unknown business in any callback answers and shows the list; a
//        malformed callback is not a callback at all; nothing is written
//   OB11 a chat that is not the operator (owner, staff, unbound, or the
//        operator id after OPERATOR_CHAT_ID changed) never reaches these
//        callbacks: one "not found", no read beyond the binding, no edit
//   OB12 buttons of the retired screens: pb: opens that business in the
//        browser, p:/P:/q: say "expired" and show the list and remove
//        NOTHING; pc: and the /code picker are unchanged
//   OB13 one "[tg-timing]" line per update with fixed handler and step names,
//        no business, lead or chat value; and the call budget of each flow
//   OB14 no request carried parse_mode; no button carries an emoji; every
//        callback is at most 64 bytes and matches one anchored pattern

import { loadEnv } from './env.mjs';
import { fakeRes } from './helpers.mjs';
import * as C from '../lib/content.js';
import { FIXTURE_CHATS } from './fixture-ids.mjs';

loadEnv();

let failed = 0, total = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(5)}${String(what).padEnd(56)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 110) : ''}`);
};

const SECRET = 'operator-browser-test-secret';
// In-memory only: the same chat ids as the lead-browser suite.
const OWNER = FIXTURE_CHATS.browserOwner;
const STAFF = FIXTURE_CHATS.browserStaff;
const CHAT_B = FIXTURE_CHATS.browserB;
const CHAT_X = FIXTURE_CHATS.browserX;
const OP = FIXTURE_CHATS.browserOperator;

const saved = {};
for (const k of ['TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_API_BASE', 'VERCEL_ENV', 'OPERATOR_CHAT_ID', 'TELEGRAM_BOT_USERNAME', 'TELEGRAM_CHAT_ID']) saved[k] = process.env[k];
process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
process.env.TELEGRAM_API_BASE = process.env.FAKE_TG_URL;
process.env.VERCEL_ENV = 'development';
process.env.OPERATOR_CHAT_ID = String(OP);
process.env.TELEGRAM_BOT_USERNAME = 'alder_test_bot';
delete process.env.TELEGRAM_CHAT_ID;

const TG = process.env.FAKE_TG_URL;
const realFetch = globalThis.fetch;
const tgCtl = (body) => realFetch(TG + '/__control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const allTg = []; // every Telegram request of the suite, for OB14
const tgReqs = async () => (await (await realFetch(TG + '/__requests')).json()).requests;
const tgReset = async () => {
  try { allTg.push(...(await tgReqs())); } catch {}
  await realFetch(TG + '/__reset', { method: 'POST' });
};

/* ---------- a very small PostgREST ---------- */

const uuid = (n) => `${String(n).padStart(8, '0')}-0000-0000-0000-${String(n).padStart(12, '0')}`;
const biz = (n) => `b${String(n).padStart(7, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BIZ_A = biz(1);   // Alder Roofing, two phones
const BIZ_B = biz(2);   // Beta Roofing, one phone
const BIZ_P = biz(3);   // paused, one phone
const BIZ_GONE = 'ffffffff-0000-4000-8000-00000000dead';

let store;
let sbRequests = [];
/** The order things happened in: a Telegram request is logged when it starts
 *  and again when its response is back; a database request when it starts. */
let trace = [];
let sbHook = null;

const business = (id, slug, name, status) => ({
  id, slug, name, status, timezone: 'America/Chicago', owner_email: `${slug}@fixture.invalid`, google_review_url: 'https://g.page/r/x',
});

/** Twelve businesses, so the list has three pages (5, 5, 2). Two share a name:
 *  the id decides between them. Sorted by name then id the order is:
 *   Alder Roofing, Beta Roofing, Cedar Co, Delta Roofs, Echo Roofing |
 *   Fir & Sons, Gable Works, Gable Works, Hail Pros, Iron Roofing |
 *   Juniper Roofing, Zz Paused */
const freshStore = () => ({
  businesses: [
    business(biz(10), 'juniper', 'Juniper Roofing', 'churned'),
    business(BIZ_P, 'zz-paused', 'Zz Paused', 'paused'),
    business(biz(8), 'gable-two', 'Gable Works', 'active'),
    business(BIZ_A, 'alder-demo', 'Alder Roofing', 'demo'),
    business(biz(7), 'gable-one', 'Gable Works', 'demo'),
    business(BIZ_B, 'beta', 'Beta Roofing', 'active'),
    business(biz(4), 'cedar', 'Cedar Co', 'active'),
    business(biz(5), 'delta', 'Delta Roofs', 'active'),
    business(biz(6), 'echo', 'Echo Roofing', 'active'),
    business(biz(9), 'fir', 'Fir & Sons', 'active'),
    business(biz(11), 'hail', 'Hail Pros', 'active'),
    business(biz(12), 'iron', 'Iron Roofing', 'active'),
  ],
  chats: [
    { id: uuid(1), business_id: BIZ_A, tg_chat_id: OWNER, label: null, created_at: '2026-11-01T10:00:00Z' },
    { id: uuid(2), business_id: BIZ_A, tg_chat_id: STAFF, label: 'Van', created_at: '2026-11-02T10:00:00Z' },
    { id: uuid(3), business_id: BIZ_B, tg_chat_id: CHAT_B, label: null, created_at: '2026-11-03T10:00:00Z' },
    { id: uuid(4), business_id: BIZ_P, tg_chat_id: 777000111, label: null, created_at: '2026-11-04T10:00:00Z' },
  ],
  codes: [],
  leads: [],
  events: [],
  claims: new Map(),
  seq: 100,
});

const countRequested = (init) => {
  const h = init.headers || {};
  const prefer = (typeof h.get === 'function' ? h.get('Prefer') : (h.Prefer || h.prefer)) || '';
  return String(prefer).includes('count=exact') || String(init.method || '').toUpperCase() === 'HEAD';
};

const match = (row, params) => {
  for (const [key, raw] of params) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(key)) continue;
    const v = row[key];
    if (raw.startsWith('eq.')) { if (String(v) !== raw.slice(3)) return false; continue; }
    if (raw === 'is.null') { if (v !== null && v !== undefined) return false; continue; }
    if (raw === 'not.is.null') { if (v === null || v === undefined) return false; continue; }
    if (raw.startsWith('gt.')) { if (!(new Date(v) > new Date(raw.slice(3)))) return false; continue; }
    if (raw.startsWith('lt.')) { if (!(new Date(v) < new Date(raw.slice(3)))) return false; continue; }
    if (raw.startsWith('in.(')) {
      const list = raw.slice(4, -1).split(',').map((x) => x.replace(/^"|"$/g, ''));
      if (!list.includes(String(v))) return false;
      continue;
    }
  }
  return true;
};

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
    if (!url.startsWith(SB)) {
      let chat = null;
      try { chat = JSON.parse(init.body || '{}').chat_id; } catch { chat = null; }
      const method = url.split('/').pop();
      trace.push({ kind: 'tg', method, chat: chat == null ? null : String(chat), phase: 'start' });
      try { return await realFetch(input, init); } finally {
        trace.push({ kind: 'tg', method, chat: chat == null ? null : String(chat), phase: 'end' });
      }
    }
    const u = new URL(url);
    const table = u.pathname.replace('/rest/v1/', '');
    const method = String(init.method || 'GET').toUpperCase();
    const params = [...u.searchParams.entries()];
    sbRequests.push({ table, method, params });
    trace.push({ kind: 'sb', table, method });
    if (sbHook) {
      const forced = await sbHook({ table, method, params });
      if (forced) return forced;
    }
    const json = (body, headers = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
    const countHeader = (n) => new Response(null, { status: 200, headers: { 'content-range': `0-${n ? n - 1 : 0}/${n}` } });
    const paged = (rows) => {
      const offset = Number(u.searchParams.get('offset') || 0);
      const limit = u.searchParams.get('limit');
      return limit === null ? rows : rows.slice(offset, offset + Number(limit));
    };

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
        return json(doomed.map((r) => ({ id: r.id, tg_chat_id: r.tg_chat_id })));
      }
      if (method === 'POST') {
        const body = JSON.parse(init.body || '{}');
        for (const r of (Array.isArray(body) ? body : [body])) {
          if (!store.chats.some((c) => String(c.tg_chat_id) === String(r.tg_chat_id))) {
            store.chats.push({ id: uuid(store.seq++), label: null, created_at: new Date().toISOString(), ...r });
          }
        }
        return json([]);
      }
      let rows = store.chats.filter((r) => match(r, params));
      rows = rows.slice().sort(byOrder(u.searchParams.get('order')));
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
        for (const r of hit) Object.assign(r, body);
        return json(hit.map((r) => ({ business_id: r.business_id, code: r.code })));
      }
      const rows = store.codes.filter((r) => match(r, params));
      if (countRequested(init)) return countHeader(rows.length);
      if (u.searchParams.get('code')) return json(rows[0] || null);
      return json(rows);
    }
    if (table === 'businesses') {
      if (method !== 'GET' && method !== 'HEAD') return json([]);
      let rows = store.businesses.filter((r) => match(r, params));
      rows = rows.slice().sort(byOrder(u.searchParams.get('order')));
      if (countRequested(init)) return countHeader(rows.length);
      if (u.searchParams.get('id') || u.searchParams.get('slug')) return json(rows[0] || null);
      return json(paged(rows).map((r) => ({ ...r })));
    }
    if (table === 'v_client_leads') {
      let rows = store.leads.filter((r) => match(r, params));
      if (countRequested(init)) return countHeader(rows.length);
      rows = rows.slice().sort(byOrder(u.searchParams.get('order')));
      if (u.searchParams.get('id')) return json(rows[0] ? { ...rows[0] } : null);
      return json(paged(rows).map((r) => ({ ...r })));
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

const of = (reqs, method) => reqs.filter((x) => x.path.endsWith('/' + method));
const kbOf = (req) => (req && req.body.reply_markup && req.body.reply_markup.inline_keyboard) || [];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const param = (r, key) => (r.params.find(([k]) => k === key) || [])[1];
const numbersOk = (row, n) => Array.isArray(row) && row.length === n
  && row.every((b, i) => b.text === String(i + 1) && same(Object.keys(b).sort(), ['callback_data', 'text']));
const snapshot = () => JSON.stringify({ b: store.businesses, c: store.chats, k: store.codes, l: store.leads, e: store.events });
const writes = (reqs) => reqs.filter((q) => !['GET', 'HEAD'].includes(q.method) && q.table !== 'rpc/hit_rate_limit');

/** One update: what Telegram received, what the database was asked, and the
 *  timing lines it printed. */
const TIMING = '[tg-timing] ';
const run = async (update) => {
  const lines = [];
  const realLog = console.log;
  console.log = (...args) => {
    const text = args.map(String).join(' ');
    if (text.startsWith(TIMING)) lines.push(text); else realLog(...args);
  };
  await tgReset();
  sbRequests = [];
  trace = [];
  try { await call(update); } finally { console.log = realLog; }
  const tg = await tgReqs();
  let obj = null;
  try { obj = lines.length === 1 ? JSON.parse(lines[0].slice(TIMING.length)) : null; } catch { obj = null; }
  return {
    tg, sb: sbRequests.slice(), trace: trace.slice(), lines, obj,
    sends: of(tg, 'sendMessage'), edits: of(tg, 'editMessageText'),
    // An empty toast is sent without a text at all.
    answers: of(tg, 'answerCallbackQuery').map((x) => (x.body.text === undefined ? '' : String(x.body.text))),
  };
};

let seq = 1;
function seedLead(businessId, { name = 'A Lead', status = 'open', created_at = null, phone = '5155550100', email = 'lead@fixture.invalid' } = {}) {
  const row = {
    id: uuid(1000 + seq), business_id: businessId, name, phone, email, zip: '50265',
    service: 'repair', home: 'house', timing: 'asap', roof_age: 'Not sure',
    insurance_claim: false, notes: null, status,
    created_at: created_at || new Date(Date.now() - seq * 60000).toISOString(),
  };
  seq++;
  store.leads.push(row);
  return row.id;
}
const seedSeven = () => {
  const ids = [];
  for (let i = 0; i < 7; i++) ids.push(seedLead(BIZ_A, { name: `Request ${i + 1}`, created_at: `2026-11-${String(12 - i).padStart(2, '0')}T09:00:00Z` }));
  seedLead(BIZ_B, { name: 'Beta Only', phone: '5155550999', created_at: '2026-11-12T10:00:00Z' });
  return ids;
};

const PAGE0 = ['Alder Roofing · Demo · 2 phones', 'Beta Roofing · Active · 1 phone', 'Cedar Co · Active · 0 phones',
  'Delta Roofs · Active · 0 phones', 'Echo Roofing · Active · 0 phones'];
const PAGE0_IDS = [BIZ_A, BIZ_B, biz(4), biz(5), biz(6)];
const PAGE1_IDS = [biz(9), biz(7), biz(8), biz(11), biz(12)];
const listText = (rows) => 'Businesses\n\n' + rows.map((r, i) => `${i + 1}. ${r}`).join('\n');
const DETAIL_A = 'Alder Roofing\nDemo · alder-demo\n\nTelegram: connected · 2 phones\nPhone 1 · main phone\nPhone 2 (Van)\n\nRequests: 7';
const detailKb = (id, page) => [
  [{ text: 'Terminate', callback_data: `bt:${page}:${id}`, style: 'danger' }, { text: 'Leads', callback_data: `bq:0:${page}:${id}` }],
  [{ text: 'Back', callback_data: `bl:${page}` }],
];
const backKb = (id, page) => [[{ text: 'Back', callback_data: `bd:${page}:${id}` }]];
const packed = (businessId, leadId) => C.packUuid(businessId) + C.packUuid(leadId);

try {
  install();
  await tgCtl({ mode: 'ok', failChat: null });
  // Whatever an earlier suite left in the fake's log is not this suite's.
  await realFetch(TG + '/__reset', { method: 'POST' });

  /* OB1: the list, as one message. */
  store = freshStore();
  {
    const r = await run(msg(OP, '/businesses'));
    const list = r.sends[0] || { body: {} };
    const kb = kbOf(list);
    const pageReads = r.sb.filter((q) => q.table === 'businesses');
    const counts = r.sb.filter((q) => q.table === 'business_chats' && param(q, 'business_id'));
    const inList = String(param(counts[0] || { params: [] }, 'business_id') || '');
    const oneCountQuery = counts.length === 1 && counts[0].method === 'GET'
      && PAGE0_IDS.every((id) => inList.includes(id)) && inList.startsWith('in.(')
      && r.sb.length === 3; // the binding, the page, the counts — never one per business
    const ordered = pageReads.length === 1 && param(pageReads[0], 'order') === 'name.asc,id.asc'
      && param(pageReads[0], 'limit') === '6' && param(pageReads[0], 'offset') === '0';
    line(r.sends.length === 1 && r.edits.length === 0 && r.tg.length === 1
      && list.body.text === listText(PAGE0)
      && kb.length === 2 && numbersOk(kb[0], 5)
      && PAGE0_IDS.every((id, i) => kb[0][i].callback_data === `bd:0:${id}`)
      && same(kb[1], [{ text: 'Older', callback_data: 'bl:1' }])
      && !kb.flat().some((b) => 'disabled' in b || b.copy_text)
      && oneCountQuery && ordered,
      'OB1', '/businesses: one message, 5 rows, counts in one query',
      `sends=${r.sends.length} db=${r.sb.length} countQueries=${counts.length} order=${ordered}`);

    // Every way in opens the same screen. A word after /phones changes nothing.
    const ways = ['/phones', '/phones alder-demo', '/recipients', 'Businesses', 'Phones', '/businesses@alder_test_bot'];
    const bad = [];
    for (const text of ways) {
      const w = await run(msg(OP, text));
      const m = w.sends[0];
      if (w.sends.length !== 1 || !m || m.body.text !== list.body.text || !same(kbOf(m), kb) || writes(w.sb).length) bad.push(text);
    }
    line(bad.length === 0, 'OB1b', '/phones, /recipients and the keyboard open the same list', `bad=${bad.join(',') || 'none'}`);

    // /code is as it was: with more than eight served businesses its picker
    // still answers with the usage line, and the list above did not refuse.
    const code = await run(msg(OP, '/code'));
    line(code.sends.length === 1 && code.sends[0].body.text === C.OPERATOR_USAGE_CODE,
      'OB1c', '/code picker unchanged (usage line above eight)', `text=${code.sends[0] && code.sends[0].body.text}`);
  }

  /* OB2: paging in place, the navigation rule, stale pages, a failed count. */
  store = freshStore();
  let page1Text = '';
  {
    const mid = await run(cb(OP, 'bl:1'));
    const midKb = kbOf(mid.edits[0]);
    page1Text = (mid.edits[0] || { body: {} }).body.text;
    // Two businesses are both called Gable Works: the slug tells them apart,
    // and the id (7 before 8) decides which is first.
    const midOk = mid.sends.length === 0 && mid.edits.length === 1 && mid.edits[0].body.message_id === 9
      && same(mid.answers, [''])
      && page1Text === listText(['Fir & Sons · Active · 0 phones', 'Gable Works (gable-one) · Demo · 0 phones',
        'Gable Works (gable-two) · Active · 0 phones', 'Hail Pros · Active · 0 phones', 'Iron Roofing · Active · 0 phones'])
      && midKb.length === 2 && numbersOk(midKb[0], 5)
      && PAGE1_IDS.every((id, i) => midKb[0][i].callback_data === `bd:1:${id}`)
      && same(midKb[1], [{ text: 'Newer', callback_data: 'bl:0' }, { text: 'Older', callback_data: 'bl:2' }])
      && mid.sb.length === 3;
    const last = await run(cb(OP, 'bl:2'));
    const lastKb = kbOf(last.edits[0]);
    // The paused business is on the last page and shows its real phone.
    const lastOk = last.sends.length === 0 && last.edits.length === 1
      && last.edits[0].body.text === listText(['Juniper Roofing · Churned · 0 phones', 'Zz Paused · Paused · 1 phone'])
      && lastKb.length === 2 && numbersOk(lastKb[0], 2)
      && same(lastKb[1], [{ text: 'Newer', callback_data: 'bl:1' }]);
    const first = await run(cb(OP, 'bl:0'));
    const firstOk = first.edits.length === 1 && first.edits[0].body.text === listText(PAGE0)
      && same(kbOf(first.edits[0])[1], [{ text: 'Older', callback_data: 'bl:1' }]);
    // A page that no longer exists: the first page, and a toast that says so.
    const stale = await run(cb(OP, 'bl:9'));
    const staleOk = same(stale.answers, [C.OPERATOR_PAGE_GONE]) && stale.sends.length === 0
      && stale.edits.length === 1 && stale.edits[0].body.text === listText(PAGE0);
    // The count query fails: "?" for every row of the page, never "0 phones".
    sbHook = ({ table, params }) => (table === 'business_chats' && String(param({ params }, 'business_id') || '').startsWith('in.(')
      ? new Response('{"message":"count failed"}', { status: 500, headers: { 'content-type': 'application/json' } }) : null);
    const unknown = await run(cb(OP, 'bl:0'));
    sbHook = null;
    const unknownText = String((unknown.edits[0] || { body: {} }).body.text);
    const unknownOk = unknown.edits.length === 1 && unknownText.split('\n').slice(2).length === 5
      && unknownText.split('\n').slice(2).every((l) => / · \?$/.test(l)) && !/\d phones?/.test(unknownText);
    // Five or fewer: no navigation row at all.
    store.businesses = store.businesses.filter((b) => PAGE0_IDS.includes(b.id));
    const single = await run(cb(OP, 'bl:0'));
    const singleKb = kbOf(single.edits[0]);
    const singleOk = singleKb.length === 1 && numbersOk(singleKb[0], 5);
    store.businesses = [];
    const none = await run(msg(OP, '/businesses'));
    const noneOk = none.sends.length === 1 && none.sends[0].body.text === C.OPERATOR_NO_BUSINESSES && kbOf(none.sends[0]).length === 0;
    line(midOk && lastOk && firstOk && staleOk && unknownOk && singleOk && noneOk,
      'OB2', 'paging in place; only useful ends; stale page; "?" count',
      `mid=${midOk} last=${lastOk} first=${firstOk} stale=${staleOk} unknown=${unknownOk} single=${singleOk} none=${noneOk}`);
  }

  /* OB3: one business, in the same message. */
  store = freshStore();
  let leadIds = seedSeven();
  {
    const open = await run(cb(OP, `bd:0:${BIZ_A}`));
    const openOk = open.sends.length === 0 && open.edits.length === 1 && open.edits[0].body.message_id === 9
      && same(open.answers, ['']) && open.edits[0].body.text === DETAIL_A
      && same(kbOf(open.edits[0]), detailKb(BIZ_A, 0))
      && writes(open.sb).length === 0
      // The request count is a count, scoped by the business; no lead row is read.
      && open.sb.filter((q) => q.table === 'v_client_leads').every((q) => q.method === 'HEAD' && param(q, 'business_id') === `eq.${BIZ_A}`);
    // From page 1, Back goes to page 1 — and that edit is the page-1 list again.
    const other = await run(cb(OP, `bd:1:${biz(9)}`));
    const otherOk = other.edits.length === 1
      && other.edits[0].body.text === 'Fir & Sons\nActive · fir\n\nTelegram: not connected\n\nRequests: 0'
      && same(kbOf(other.edits[0]), detailKb(biz(9), 1));
    const back = await run(cb(OP, 'bl:1'));
    const backOk = back.sends.length === 0 && back.edits.length === 1 && back.edits[0].body.text === page1Text;
    // A paused business is shown with its phones too.
    const paused = await run(cb(OP, `bd:2:${BIZ_P}`));
    const pausedOk = paused.edits.length === 1
      && paused.edits[0].body.text === 'Zz Paused\nPaused · zz-paused\n\nTelegram: connected · 1 phone\nPhone 1 · main phone\n\nRequests: 0';
    line(openOk && otherOk && backOk && pausedOk, 'OB3', 'business detail in place; Terminate left, Leads right, Back',
      `open=${openOk} notConnected=${otherOk} back=${backOk} paused=${pausedOk}`);
  }

  /* OB4: the business's requests, read-only. */
  {
    const before = snapshot();
    const reads = [];
    const p0 = await run(cb(OP, `bq:0:0:${BIZ_A}`));
    reads.push(...p0.sb);
    const kb0 = kbOf(p0.edits[0]);
    const text0 = String((p0.edits[0] || { body: {} }).body.text);
    const listOk = p0.sends.length === 0 && p0.edits.length === 1 && p0.edits[0].body.message_id === 9
      && text0 === `Alder Roofing\n${C.renderLeadList(store.leads.filter((l) => l.business_id === BIZ_A).slice(0, 5))}`
      && text0.includes('1. Request 1') && text0.includes('5. Request 5') && !text0.includes('Request 6') && !text0.includes('Beta Only')
      && kb0.length === 3 && numbersOk(kb0[0], 5)
      && leadIds.slice(0, 5).every((id, i) => kb0[0][i].callback_data === `bo:0:0:${packed(BIZ_A, id)}`)
      && same(kb0[1], [{ text: 'Older', callback_data: `bq:1:0:${BIZ_A}` }])
      && same(kb0[2], [{ text: 'Back', callback_data: `bd:0:${BIZ_A}` }]);
    const p1 = await run(cb(OP, `bq:1:0:${BIZ_A}`));
    reads.push(...p1.sb);
    const kb1 = kbOf(p1.edits[0]);
    const lastOk = p1.edits.length === 1 && kb1.length === 3 && numbersOk(kb1[0], 2)
      && same(kb1[1], [{ text: 'Newer', callback_data: `bq:0:0:${BIZ_A}` }])
      && same(kb1[2], [{ text: 'Back', callback_data: `bd:0:${BIZ_A}` }]);
    // One request: the owner's card text, and only Back under it.
    const lead = store.leads.find((l) => l.id === leadIds[5]);
    const det = await run(cb(OP, kb1[0][0].callback_data));
    reads.push(...det.sb);
    const detKb = kbOf(det.edits[0]);
    const detOk = det.sends.length === 0 && det.edits.length === 1 && det.edits[0].body.message_id === 9
      && det.edits[0].body.text === C.renderAlert({ business: store.businesses.find((b) => b.id === BIZ_A), lead, view: 'new' })
      && same(detKb, [[{ text: 'Back', callback_data: `bq:1:0:${BIZ_A}` }]]);
    const backToList = await run(cb(OP, detKb[0][0].callback_data));
    reads.push(...backToList.sb);
    const backOk = backToList.edits.length === 1 && backToList.edits[0].body.text === p1.edits[0].body.text;
    const toBusiness = await run(cb(OP, kb1[2][0].callback_data));
    const upOk = toBusiness.edits.length === 1 && toBusiness.edits[0].body.text === DETAIL_A;
    // An empty business: a toast, the name, and Back.
    const empty = await run(cb(OP, `bq:0:1:${biz(9)}`));
    const emptyOk = same(empty.answers, [C.TOAST_NO_LEADS]) && empty.edits.length === 1
      && empty.edits[0].body.text === 'Fir & Sons\nNo requests yet.'
      && same(kbOf(empty.edits[0]), [[{ text: 'Back', callback_data: `bd:1:${biz(9)}` }]]);
    // A request addressed under ANOTHER business is not found, and its text
    // never reaches the screen: the read is by id AND that business.
    const cross = await run(cb(OP, `bo:0:0:${packed(BIZ_B, leadIds[0])}`));
    reads.push(...cross.sb);
    const crossOk = same(cross.answers, [C.TOAST_LEAD_GONE]) && cross.edits.length === 1
      && !String(cross.edits[0].body.text).includes('Request 1') && String(cross.edits[0].body.text).startsWith('Beta Roofing\n');
    const leadReads = reads.filter((q) => q.table === 'v_client_leads');
    const scoped = leadReads.length >= 5 && leadReads.every((q) => /^eq\.b000000[12]-/.test(String(param(q, 'business_id'))));
    const ordered = leadReads.filter((q) => !param(q, 'id')).every((q) => param(q, 'order') === 'created_at.desc,id.desc');
    // Nothing a tap could change: no status, remove, copy or review button.
    const buttons = [kb0, kb1, detKb].flat(2);
    const actionFree = buttons.every((b) => /^(bo|bq|bd):/.test(b.callback_data) && !b.copy_text && !b.url && !b.style);
    line(listOk && lastOk && detOk && backOk && upOk && emptyOk && crossOk && scoped && ordered && actionFree
      && writes(reads).length === 0 && snapshot() === before,
      'OB4', 'Leads: read-only list and card, scoped and ordered, Back',
      `list=${listOk} last=${lastOk} detail=${detOk} back=${backOk}/${upOk} empty=${emptyOk} cross=${crossOk} scoped=${scoped} ordered=${ordered} free=${actionFree}`);
  }

  /* OB5: Terminate asks; Cancel goes back; nothing is sent or changed. */
  {
    const before = snapshot();
    const ask = await run(cb(OP, `bt:0:${BIZ_A}`));
    const askKb = kbOf(ask.edits[0]);
    const askOk = ask.sends.length === 0 && ask.edits.length === 1 && ask.edits[0].body.message_id === 9
      && ask.edits[0].body.text === `Terminate Telegram access for Alder Roofing? 2 phones will stop receiving alerts and can no longer use this bot.\n\n${C.OPERATOR_TERMINATE_STILL}`
      && same(askKb, [[
        { text: 'Confirm terminate', callback_data: `bT:0:${BIZ_A}`, style: 'danger' },
        { text: 'Cancel', callback_data: `bd:0:${BIZ_A}` },
      ]])
      && writes(ask.sb).length === 0;
    // A paused business takes no website requests: no promise about them.
    const askPaused = await run(cb(OP, `bt:2:${BIZ_P}`));
    const pausedOk = askPaused.edits.length === 1
      && askPaused.edits[0].body.text === 'Terminate Telegram access for Zz Paused? 1 phone will stop receiving alerts and can no longer use this bot.';
    const cancel = await run(cb(OP, askKb[0][1].callback_data));
    const cancelOk = cancel.sends.length === 0 && cancel.edits.length === 1 && cancel.edits[0].body.text === DETAIL_A
      && same(kbOf(cancel.edits[0]), detailKb(BIZ_A, 0)) && writes(cancel.sb).length === 0;
    line(askOk && pausedOk && cancelOk && snapshot() === before, 'OB5', 'Terminate asks first; Cancel returns; nothing changed',
      `ask=${askOk} paused=${pausedOk} cancel=${cancelOk} unchanged=${snapshot() === before}`);
  }

  /* OB6: Confirm. Notices first, then one scoped delete, invites expired. */
  const LIVE = new Date(Date.now() + 3600e3).toISOString();
  store = freshStore();
  leadIds = seedSeven();
  store.codes = [
    { code: 'ABCDEFGHJKMN', business_id: BIZ_A, expires_at: LIVE, used_at: null },
    { code: 'PQRSTUVWXYZ2', business_id: BIZ_A, expires_at: LIVE, used_at: '2026-11-01T10:00:00Z' },
    { code: 'MNPQRSTUVWXY', business_id: BIZ_B, expires_at: LIVE, used_at: null },
  ];
  {
    const bizBefore = JSON.stringify(store.businesses);
    const leadsBefore = JSON.stringify(store.leads);
    const r = await run(cb(OP, `bT:0:${BIZ_A}`));
    const notices = r.sends.filter((x) => [String(OWNER), String(STAFF)].includes(String(x.body.chat_id)));
    const noticeOk = r.sends.length === 2 && notices.length === 2
      && new Set(notices.map((x) => String(x.body.chat_id))).size === 2
      && notices.every((x) => x.body.text === 'Your Telegram access for Alder Roofing was ended. New requests will no longer be sent to this chat. Contact support if this is a mistake.'
        && same(x.body.reply_markup, { remove_keyboard: true }) && !('parse_mode' in x.body));
    // Order: both notices are answered before the DELETE is even started.
    const del = r.trace.findIndex((t) => t.kind === 'sb' && t.table === 'business_chats' && t.method === 'DELETE');
    const noticeEnds = r.trace.map((t, i) => (t.kind === 'tg' && t.method === 'sendMessage' && t.phase === 'end' ? i : -1)).filter((i) => i >= 0);
    const orderOk = del > 0 && noticeEnds.length === 2 && noticeEnds.every((i) => i < del);
    // One DELETE, addressed by the business and by nothing else.
    const deletes = r.sb.filter((q) => q.method === 'DELETE');
    const filters = (q) => q.params.filter(([k]) => k !== 'select').map(([k, v]) => `${k}=${v}`);
    const scopedDelete = deletes.length === 1 && deletes[0].table === 'business_chats'
      && same(filters(deletes[0]), [`business_id=eq.${BIZ_A}`]);
    const unbound = !store.chats.some((c) => c.business_id === BIZ_A)
      && store.chats.length === 2 && store.chats.some((c) => c.business_id === BIZ_B) && store.chats.some((c) => c.business_id === BIZ_P);
    // Invites: A's unused one is expired, its used one keeps its record, B's is untouched.
    const patches = r.sb.filter((q) => q.method === 'PATCH');
    const code = (c) => store.codes.find((x) => x.code === c);
    const invitesOk = patches.length === 1 && patches[0].table === 'bind_codes'
      && param(patches[0], 'business_id') === `eq.${BIZ_A}` && param(patches[0], 'used_at') === 'is.null'
      && new Date(code('ABCDEFGHJKMN').expires_at).getTime() <= Date.now() && code('ABCDEFGHJKMN').used_at === null
      && code('PQRSTUVWXYZ2').expires_at === LIVE && code('PQRSTUVWXYZ2').used_at === '2026-11-01T10:00:00Z'
      && code('MNPQRSTUVWXY').expires_at === LIVE && code('MNPQRSTUVWXY').used_at === null;
    // The business row (status included) and every lead are exactly as before,
    // and no request other than those two writes changed anything.
    const untouched = JSON.stringify(store.businesses) === bizBefore && JSON.stringify(store.leads) === leadsBefore
      && writes(r.sb).length === 2
      && !r.sb.some((q) => ['businesses', 'leads', 'v_client_leads', 'lead_events'].includes(q.table) && !['GET', 'HEAD'].includes(q.method));
    const resultOk = r.edits.length === 1 && r.edits[0].body.message_id === 9
      && r.edits[0].body.text === 'Alder Roofing terminated · 2 phones removed · 0 notices failed'
      && same(kbOf(r.edits[0]), backKb(BIZ_A, 0)) && same(r.answers, [C.OPERATOR_TERMINATED]);
    line(noticeOk && orderOk && scopedDelete && unbound && invitesOk && untouched && resultOk,
      'OB6', 'terminate: notices first, one scoped delete, invites expired',
      `notice=${noticeOk} order=${orderOk} delete=${scopedDelete} unbound=${unbound} invites=${invitesOk} untouched=${untouched} result=${resultOk}`);

    /* OB7: the second tap, and a business that never had a phone. */
    const before = snapshot();
    const again = await run(cb(OP, `bT:0:${BIZ_A}`));
    const againOk = same(again.answers, [C.OPERATOR_NOT_CONNECTED]) && again.sends.length === 0
      && again.edits.length === 1 && again.edits[0].body.text === 'Alder Roofing is already not connected.'
      && same(kbOf(again.edits[0]), backKb(BIZ_A, 0)) && writes(again.sb).length === 0;
    const askAgain = await run(cb(OP, `bt:0:${BIZ_A}`));
    const askOk = same(askAgain.answers, [C.OPERATOR_NOT_CONNECTED]) && askAgain.sends.length === 0
      && askAgain.edits.length === 1 && String(askAgain.edits[0].body.text).includes('Telegram: not connected')
      && same(kbOf(askAgain.edits[0]), detailKb(BIZ_A, 0)) && writes(askAgain.sb).length === 0;
    const never = await run(cb(OP, `bT:1:${biz(9)}`));
    const neverOk = same(never.answers, [C.OPERATOR_NOT_CONNECTED]) && never.sends.length === 0
      && never.edits.length === 1 && never.edits[0].body.text === 'Fir & Sons is already not connected.' && writes(never.sb).length === 0;
    line(againOk && askOk && neverOk && snapshot() === before, 'OB7', 'second tap and 0 phones: already not connected, no writes',
      `again=${againOk} ask=${askOk} never=${neverOk} unchanged=${snapshot() === before}`);

    /* OB9: the terminated chat, and reconnecting. */
    const replies = {};
    for (const text of ['/leads', '/invite', '/recipients', '/remove_lead', '/help', '/start', 'hello']) {
      const x = await run(msg(OWNER, text));
      replies[text] = x.sends.length === 1 ? x.sends[0].body.text : `sends=${x.sends.length}`;
    }
    const notConnected = Object.values(replies).every((t) => t === C.BOT_NOT_CONNECTED);
    const taps = [];
    for (const data of ['l:0', `L:0:${leadIds[0]}`, `c:${leadIds[0]}`, 'rm:0', 'i:c']) {
      const x = await run(cb(OWNER, data));
      if (!same(x.answers, [C.TOAST_NOT_FOUND]) || x.edits.length || x.sends.length || writes(x.sb).length) taps.push(data);
    }
    // The invite that was pending before the terminate no longer connects.
    const old = await run(msg(OWNER, 'ABCDEFGHJKMN'));
    const oldOk = old.sends.length === 1 && old.sends[0].body.text === C.BOT_CODE_BAD
      && !store.chats.some((c) => String(c.tg_chat_id) === String(OWNER));
    // The operator reconnects the business with /code, as before.
    const mint = await run(msg(OP, '/code alder-demo'));
    const fresh = store.codes.find((c) => c.business_id === BIZ_A && c.used_at === null && new Date(c.expires_at).getTime() > Date.now());
    const join = fresh ? await run(msg(OWNER, '/start ' + fresh.code)) : { sends: [] };
    const joined = store.chats.some((c) => String(c.tg_chat_id) === String(OWNER) && c.business_id === BIZ_A);
    line(notConnected && taps.length === 0 && oldOk && mint.sends.length === 2 && !!fresh && joined
      && join.sends.length === 1 && join.sends[0].body.text === C.botLinkedText('Alder Roofing'),
      'OB9', 'terminated chat: not connected; old code dead; /code reconnects',
      `replies=${notConnected} taps=${taps.join(',') || 'ok'} old=${oldOk} mint=${mint.sends.length} joined=${joined}`);
  }

  /* OB8: a notice that fails is counted and blocks nothing. */
  store = freshStore();
  {
    await tgCtl({ failChat: String(STAFF) });
    const r = await run(cb(OP, `bT:0:${BIZ_A}`));
    await tgCtl({ failChat: null });
    line(r.sends.length === 2 && !store.chats.some((c) => c.business_id === BIZ_A)
      && r.edits.length === 1 && r.edits[0].body.text === 'Alder Roofing terminated · 2 phones removed · 1 notice failed'
      && same(r.answers, [C.OPERATOR_TERMINATED]),
      'OB8', 'a failed notice is counted and never blocks the unbind',
      `sends=${r.sends.length} text=${r.edits[0] && r.edits[0].body.text}`);
    // The invites could not be expired: the result says so instead of hiding it.
    store = freshStore();
    sbHook = ({ table, method }) => (table === 'bind_codes' && method === 'PATCH'
      ? new Response('{"message":"nope"}', { status: 500, headers: { 'content-type': 'application/json' } }) : null);
    const kept = await run(cb(OP, `bT:0:${BIZ_A}`));
    // The bindings could not be deleted: nothing is reported as done.
    store = freshStore();
    sbHook = ({ table, method }) => (table === 'business_chats' && method === 'DELETE'
      ? new Response('{"message":"nope"}', { status: 500, headers: { 'content-type': 'application/json' } }) : null);
    const stuck = await run(cb(OP, `bT:0:${BIZ_A}`));
    sbHook = null;
    line(kept.edits.length === 1 && String(kept.edits[0].body.text).startsWith('Alder Roofing terminated · 2 phones removed · 0 notices failed\n\nPending invites could not be cancelled.')
      && same(stuck.answers, [C.TOAST_GENERIC_ERROR]) && stuck.edits.length === 0
      && store.chats.filter((c) => c.business_id === BIZ_A).length === 2,
      'OB8b', 'a failed write is said: invites kept, or nothing done',
      `kept=${kept.edits.length} stuck=${stuck.answers.join('|')} edits=${stuck.edits.length}`);
  }

  /* OB10: unknown and malformed references. */
  store = freshStore();
  leadIds = seedSeven();
  {
    const before = snapshot();
    const bad = [];
    for (const data of [`bd:0:${BIZ_GONE}`, `bt:0:${BIZ_GONE}`, `bT:0:${BIZ_GONE}`, `bq:0:0:${BIZ_GONE}`, `bo:0:0:${packed(BIZ_GONE, leadIds[0])}`]) {
      const x = await run(cb(OP, data));
      if (!same(x.answers, [C.OPERATOR_BUSINESS_GONE]) || x.sends.length || x.edits.length !== 1
        || x.edits[0].body.text !== listText(PAGE0) || writes(x.sb).length) bad.push(data.slice(0, 2));
    }
    // A request that is gone, under a real business: a toast and its list.
    const goneLead = await run(cb(OP, `bo:0:0:${packed(BIZ_A, uuid(999999))}`));
    const goneOk = same(goneLead.answers, [C.TOAST_LEAD_GONE]) && goneLead.edits.length === 1
      && String(goneLead.edits[0].body.text).startsWith('Alder Roofing\nRecent requests');
    // Not one of the anchored patterns: not a callback of this bot at all.
    const malformed = [];
    for (const data of ['bd:0:not-a-uuid', `bT:0:${BIZ_A}x`, `bT:${BIZ_A}`, 'bl:1000', 'bl:-1', `bq:100:0:${BIZ_A}`, 'bo:0:0:short',
      `bo:0:0:${packed(BIZ_A, leadIds[0])}=`, `bT:0:${BIZ_A}\n`, `bX:0:${BIZ_A}`, `BT:0:${BIZ_A}`]) {
      const x = await run(cb(OP, data));
      if (!same(x.answers, [C.TOAST_NOT_FOUND]) || x.sends.length || x.edits.length || writes(x.sb).length) malformed.push(JSON.stringify(data.slice(0, 8)));
    }
    line(bad.length === 0 && goneOk && malformed.length === 0 && snapshot() === before,
      'OB10', 'unknown business: toast and list; malformed: not found',
      `unknown=${bad.join(',') || 'ok'} lead=${goneOk} malformed=${malformed.join(',') || 'ok'} unchanged=${snapshot() === before}`);
  }

  /* OB11: only the operator chat, checked on every tap. */
  {
    const before = snapshot();
    const row = uuid(2);
    const taps = ['bl:0', `bd:0:${BIZ_A}`, `bt:0:${BIZ_A}`, `bT:0:${BIZ_A}`, `bq:0:0:${BIZ_A}`, `bo:0:0:${packed(BIZ_A, leadIds[0])}`,
      `bT:0:${BIZ_B}`, `bo:0:0:${packed(BIZ_B, leadIds[0])}`, `pb:${BIZ_A}`, `pb:${BIZ_B}`, `p:${row}`, `P:${row}`, `q:${row}`];
    const leaks = [];
    for (const chat of [OWNER, STAFF, CHAT_B, CHAT_X]) {
      for (const data of taps) {
        const x = await run(cb(chat, data));
        // One database request: the chat's own binding. Nothing else is read.
        const onlyBinding = x.sb.length === 1 && x.sb[0].table === 'business_chats' && param(x.sb[0], 'tg_chat_id') === `eq.${chat}`;
        if (!same(x.answers, [C.TOAST_NOT_FOUND]) || x.sends.length || x.edits.length || !onlyBinding) leaks.push(`${chat}:${data.slice(0, 2)}`);
      }
    }
    // The operator id is read on every tap: once it changes, the old chat is
    // just another chat, even for a button it was sent a moment ago.
    process.env.OPERATOR_CHAT_ID = '424242424242';
    const demoted = [];
    for (const data of taps) {
      const x = await run(cb(OP, data));
      if (!same(x.answers, [C.TOAST_NOT_FOUND]) || x.sends.length || x.edits.length || x.sb.length !== 1) demoted.push(data.slice(0, 2));
    }
    const typed = await run(msg(OP, '/businesses'));
    process.env.OPERATOR_CHAT_ID = String(OP);
    // Typed by a business chat or a stranger, the commands are not commands.
    const ownerTyped = await run(msg(OWNER, '/businesses'));
    const ownerPhones = await run(msg(OWNER, '/phones alder-demo'));
    const strangerTyped = await run(msg(CHAT_X, '/businesses'));
    const typedOk = typed.sends.length === 1 && typed.sends[0].body.text === C.BOT_NOT_CONNECTED
      && ownerTyped.sends.length === 1 && ownerTyped.sends[0].body.text === C.BOT_PLAIN_TEXT
      && ownerPhones.sends.length === 1 && ownerPhones.sends[0].body.text === C.BOT_PLAIN_TEXT
      && strangerTyped.sends.length === 1 && strangerTyped.sends[0].body.text === C.BOT_NOT_CONNECTED
      && [typed, ownerTyped, ownerPhones, strangerTyped].every((x) => !x.sb.some((q) => q.table === 'businesses'));
    line(leaks.length === 0 && demoted.length === 0 && typedOk && snapshot() === before,
      'OB11', 'non-operator chats never reach the operator callbacks',
      `taps=${taps.length * 4} leaks=${leaks.slice(0, 3).join(',') || 'none'} demoted=${demoted.join(',') || 'none'} typed=${typedOk}`);
  }

  /* OB12: buttons of the retired /phones screens, and /code as it was. */
  store = freshStore();
  seedSeven();
  store.businesses = store.businesses.filter((b) => [BIZ_A, BIZ_B, BIZ_P].includes(b.id));
  {
    const row = uuid(2);
    const pb = await run(cb(OP, `pb:${BIZ_A}`));
    const pbOk = pb.sends.length === 0 && pb.edits.length === 1 && pb.edits[0].body.text === DETAIL_A
      && same(kbOf(pb.edits[0]), detailKb(BIZ_A, 0)) && writes(pb.sb).length === 0;
    const pbGone = await run(cb(OP, `pb:${BIZ_GONE}`));
    const pbGoneOk = same(pbGone.answers, [C.OPERATOR_BUSINESS_GONE]) && pbGone.edits.length === 1
      && String(pbGone.edits[0].body.text).startsWith('Businesses\n\n1. Alder Roofing');
    const before = snapshot();
    const old = [];
    for (const kind of ['p', 'P', 'q']) {
      const x = await run(cb(OP, `${kind}:${row}`));
      if (!same(x.answers, [C.OPERATOR_SCREEN_EXPIRED]) || x.sends.length || x.edits.length !== 1
        || !String(x.edits[0].body.text).startsWith('Businesses\n\n1. Alder Roofing · Demo · 2 phones') || writes(x.sb).length) old.push(kind);
    }
    const kept = snapshot() === before && store.chats.some((c) => c.id === row);
    // /code: the picker, its pc: tap and the typed form, exactly as before.
    const picker = await run(msg(OP, '/code'));
    const pickKb = kbOf(picker.sends[0]);
    const pickerOk = picker.sends.length === 1 && picker.sends[0].body.text === C.OPERATOR_PICK_TEXT
      && same(pickKb, [[{ text: 'Alder Roofing', callback_data: `pc:${BIZ_A}` }], [{ text: 'Beta Roofing', callback_data: `pc:${BIZ_B}` }]]);
    const pc = await run(cb(OP, `pc:${BIZ_A}`));
    const pcOk = pc.sends.length === 2 && pc.edits.length === 0 && store.codes.filter((c) => c.business_id === BIZ_A).length === 1;
    const pcPaused = await run(cb(OP, `pc:${BIZ_P}`));
    const pcPausedOk = same(pcPaused.answers, [C.OPERATOR_UNKNOWN_SLUG]) && pcPaused.sends.length === 0;
    const invite = await run(msg(OP, '/invite'));
    const inviteOk = invite.sends.length === 1 && invite.sends[0].body.text === C.OPERATOR_PICK_TEXT && same(kbOf(invite.sends[0]), pickKb);
    const hint = await run(msg(OP, '/leads'));
    const help = await run(msg(OP, '/operator'));
    const copyOk = hint.sends[0].body.text === C.OPERATOR_LEADS_HINT && help.sends[0].body.text === C.OPERATOR_HELP
      && C.OPERATOR_LEADS_HINT === 'This is the operator chat. Send /businesses, open a business and tap Leads.'
      && /\/businesses · /.test(C.OPERATOR_HELP) && /\/phones · the same list/.test(C.OPERATOR_HELP)
      && !/Remove|\/phones \[slug\]/.test(C.OPERATOR_HELP);
    line(pbOk && pbGoneOk && old.length === 0 && kept && pickerOk && pcOk && pcPausedOk && inviteOk && copyOk,
      'OB12', 'old pb:/p:/P:/q: taps are harmless; /code unchanged',
      `pb=${pbOk}/${pbGoneOk} old=${old.join(',') || 'ok'} kept=${kept} picker=${pickerOk} pc=${pcOk}/${pcPausedOk} invite=${inviteOk} copy=${copyOk}`);
  }

  /* OB13: the timing line and the call budget of every new flow. The lists
     are literal on purpose: a new handler name or step label has to be added
     here by hand, which is the moment to ask what it carries. */
  store = freshStore();
  leadIds = seedSeven();
  {
    const STEPS = ['db.binding_lookup', 'db.business_page', 'db.chat_count_page', 'db.business_by_id', 'db.chat_list',
      'db.lead_count', 'db.lead_page', 'db.lead_by_id', 'db.chat_remove_all', 'db.invite_expire',
      'tg.send_message', 'tg.answer_callback', 'tg.edit_message_text'];
    const row = uuid(2);
    // [update, handler name, type, database calls, Telegram calls]
    const flows = [
      [msg(OP, '/businesses'), 'cmd.operator_businesses', 'message', 3, 1],
      [msg(OP, '/phones'), 'cmd.operator_phones', 'message', 3, 1],
      [cb(OP, 'bl:1'), 'cb.operator_business_page', 'callback', 3, 2],
      [cb(OP, `bd:0:${BIZ_A}`), 'cb.operator_business_open', 'callback', 4, 2],
      [cb(OP, `bq:0:0:${BIZ_A}`), 'cb.operator_leads_page', 'callback', 3, 2],
      [cb(OP, `bo:0:0:${packed(BIZ_A, leadIds[0])}`), 'cb.operator_lead_open', 'callback', 3, 2],
      [cb(OP, `pb:${BIZ_A}`), 'cb.operator_pick_phones', 'callback', 4, 2],
      [cb(OP, `P:${row}`), 'cb.operator_phone_legacy', 'callback', 3, 2],
      [cb(OP, `bt:0:${BIZ_A}`), 'cb.operator_terminate_ask', 'callback', 3, 2],
      // Binding, business, phones, one delete, one invite update; two notices, the toast, the edit.
      [cb(OP, `bT:0:${BIZ_A}`), 'cb.operator_terminate', 'callback', 5, 4],
      [cb(OP, `bT:0:${BIZ_A}`), 'cb.operator_terminate', 'callback', 3, 2],
      [cb(OWNER, `bT:0:${BIZ_B}`), 'cb.operator_terminate', 'callback', 1, 1],
    ];
    const problems = [];
    for (const [update, handlerName, type, db, tg] of flows) {
      const r = await run(update);
      const o = r.obj;
      if (r.lines.length !== 1 || !o) { problems.push(`${handlerName}: lines=${r.lines.length}`); continue; }
      if (o.handler !== handlerName || o.type !== type) problems.push(`${handlerName}: named ${o.handler}/${o.type}`);
      if (r.sb.length !== db || r.tg.length !== tg || o.db_calls !== db || o.tg_calls !== tg) {
        problems.push(`${handlerName}: fakes ${r.sb.length}/${r.tg.length} line ${o.db_calls}/${o.tg_calls} want ${db}/${tg}`);
      }
      if (!Array.isArray(o.steps) || o.steps.some((st) => !STEPS.includes(st.s))) {
        problems.push(`${handlerName}: step ${(o.steps || []).map((st) => st.s).filter((x) => !STEPS.includes(x)).join(',')}`);
      }
      // Every string in the line is a fixed name; none is a value of the request.
      const strings = [];
      JSON.stringify(o, (k, v) => { if (typeof v === 'string') strings.push(v); return v; });
      const allowed = new Set([handlerName, type, ...STEPS]);
      if (strings.some((x) => !allowed.has(x))) problems.push(`${handlerName}: free string`);
      const cbq = update.callback_query;
      const forbidden = [String(OP), String(OWNER), String(STAFF), BIZ_A, BIZ_B, 'Alder', 'alder-demo', 'Request 1', '5155550100',
        'fixture.invalid', SECRET, ...leadIds, C.packUuid(BIZ_A), ...(cbq ? [cbq.id, cbq.data] : [update.message.text])];
      if (forbidden.some((x) => x && r.lines[0].includes(x))) problems.push(`${handlerName}: leaked`);
    }
    line(problems.length === 0, 'OB13', 'timing line and call budget of every operator flow',
      `flows=${flows.length} problems=${problems.slice(0, 2).join('; ') || 'none'}`);
  }

  /* OB14: over the whole suite. */
  {
    await tgReset();
    const withParse = allTg.filter((x) => x.body && typeof x.body === 'object' && 'parse_mode' in x.body);
    const inline = allTg.flatMap((x) => kbOf(x).flat());
    const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE0F}\u{200D}\u{2190}-\u{21FF}]/u;
    const withEmoji = inline.filter((b) => EMOJI.test(String(b.text)));
    const PATTERNS = [/^bl:\d{1,3}$/, /^(bd|bt|bT):\d{1,3}:[0-9a-f-]{36}$/, /^bq:\d{1,2}:\d{1,3}:[0-9a-f-]{36}$/,
      /^bo:\d{1,2}:\d{1,3}:[A-Za-z0-9_-]{44}$/, /^pc:[0-9a-f-]{36}$/];
    const data = inline.map((b) => String(b.callback_data));
    const unshaped = data.filter((d) => Buffer.byteLength(d, 'utf8') > 64 || !PATTERNS.some((p) => p.test(d)));
    const styled = inline.filter((b) => b.style && !(b.style === 'danger' && ['Terminate', 'Confirm terminate'].includes(b.text)));
    line(allTg.length > 150 && withParse.length === 0 && inline.length > 150 && withEmoji.length === 0
      && unshaped.length === 0 && styled.length === 0
      && inline.filter((b) => b.text === 'Terminate').every((b) => b.style === 'danger')
      && inline.filter((b) => b.text === 'Confirm terminate').every((b) => b.style === 'danger'),
      'OB14', 'no parse_mode, no emoji, callbacks anchored and <= 64 bytes',
      `requests=${allTg.length} buttons=${inline.length} parse=${withParse.length} emoji=${withEmoji.length} unshaped=${unshaped.slice(0, 2).join(',') || 'none'}`);
  }
} catch (e) {
  line(false, 'OB0', 'operator-browser suite threw', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
} finally {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await tgCtl({ mode: 'ok', failChat: null }).catch(() => {});
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
