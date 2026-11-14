#!/usr/bin/env node
// tests/operator-browser.test.mjs — Gate OB (the operator chat: /businesses,
// /invite, the minimised leads view, Suspend and Reactivate).
// HARNESS: in-process handler call, no HTTP server, no database. PostgREST is
// faked at the fetch layer with a small in-memory store (the same pattern as
// tests/lead-browser.test.mjs); Telegram and Resend are the loopback fakes.
//
// The DB-backed half is the OP series in tests/webhook.test.mjs. This suite
// runs everywhere, so the invariants of the operator chat are pinned here.
//
// What it proves:
//   OB1  /businesses: ONE message, five per page as "N. Name · Status · N
//        phones" in name-then-id order, one number row and Older alone; the
//        phone counts of the page come from ONE query; the keyboard label and
//        the old "Phones" label open the same screen
//   OB1b the retired operator commands (/phones, /recipients, /leads, /code,
//        /remove_lead, with or without a word after them) get ONLY the
//        fallback line, which points to /help: nothing is read, nothing is
//        written; /help and /operator list exactly the four commands; /id is
//        unchanged
//   OB2  paging edits the same message; only the ends that lead somewhere; a
//        page that is gone becomes the first; a failed count says "?"
//   OB3  the business screen, exact text, for connected / not connected /
//        suspended: no line twice, no "Requests", the phone count nowhere on
//        the Telegram line; the lead numbers are two aggregates (no lead row
//        content is read); the button rows and styles of each state
//   OB4  the operator's leads: every row and card shows ONLY service, status
//        and age; the name, phone, email, ZIP and notes of a lead never reach
//        the operator chat, and are not even asked of the database; the
//        allowed fields are one constant; scoped, ordered, read-only
//   OB5  Suspend asks first (exact text, Confirm suspend danger left, Cancel
//        right); Cancel returns to the business; nothing sent or changed
//   OB6  Confirm: every bound phone gets ONE notice with ReplyKeyboardRemove
//        and the owner address ONE email, all BEFORE the status is written;
//        the write is one UPDATE scoped by the id and the served statuses;
//        bindings, invites, leads and every other business are untouched
//   OB7  a second tap is harmless: "already suspended", nothing sent or written
//   OB8  a notice that fails is counted and blocks nothing; a phone list that
//        cannot be read sends and changes nothing; a status that cannot be
//        written is not reported as done
//   OB9  a suspended business: every command and keyboard press of its phones
//        answers the one neutral line with no data and nothing read beyond
//        the binding; every button answers the same line as a toast; free
//        text is rate limited; /id still answers; a new phone cannot connect
//        and its invite stays unused; the website form's request is refused
//        with a plain 404 before anything is stored or sent; another business
//        is unaffected
//   OB10 Reactivate: one scoped UPDATE to active (a demo business comes back
//        as active); every bound phone is told, with its own role keyboard;
//        a second tap is harmless; the phones work again
//   OB11 an unknown business in any callback answers and shows the current
//        list; a malformed callback is not a callback at all; the retired
//        Terminate (bt/bT), picker (pb) and Remove Phone (p/P/q) buttons say
//        the screen expired, show the current screen and change NOTHING
//   OB12 a chat that is not the operator (owner, staff, unbound, or the
//        operator id after OPERATOR_CHAT_ID changed) never reaches these
//        callbacks: one "not found", no read beyond the binding, no edit
//   OB13 /invite: the list (served businesses only, 5 per page, numbers,
//        Newer/Older) as one message; a number edits it into the invite:
//        name, single-use link, one forward line, Back to the list page; the
//        same from the business screen (Back to the business); connected or
//        not; the older unused invite is cancelled; a suspended business gets
//        one line and no code; 10 per business per hour; /invite <slug> is
//        the old two-message shortcut; the old "Code" label and the old pc:
//        button still make an invite
//   OB14 one "[tg-timing]" line per update with fixed handler and step names,
//        no business, lead or chat value; and the call budget of each flow
//   OB15 no request carried parse_mode; no button carries an emoji; every
//        callback is at most 64 bytes and matches one anchored pattern;
//        danger only on Suspend / Confirm suspend, primary only on Invite /
//        Reactivate
//   OB16 the owner's rules did not move: a phone that is not the main phone
//        cannot use /invite, cannot cancel an invite, cannot open /recipients
//        and cannot remove a phone
//   OB17 a new lead's alert goes to EVERY bound phone of its business, once
//        each, and to nobody else; a retry targets only the phone that failed

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
for (const k of ['TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_API_BASE', 'VERCEL_ENV', 'OPERATOR_CHAT_ID', 'TELEGRAM_BOT_USERNAME', 'TELEGRAM_CHAT_ID',
  'RESEND_API_BASE', 'RESEND_API_KEY', 'MAIL_FROM', 'MAIL_REDIRECT_TO', 'IP_HASH_SALT']) saved[k] = process.env[k];
process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
process.env.TELEGRAM_API_BASE = process.env.FAKE_TG_URL;
process.env.VERCEL_ENV = 'development';
process.env.OPERATOR_CHAT_ID = String(OP);
process.env.TELEGRAM_BOT_USERNAME = 'alder_test_bot';
delete process.env.TELEGRAM_CHAT_ID;
// The suspension email goes to the loopback Resend fake, from a sender that
// is not the unverified default, to the address it was written for.
process.env.RESEND_API_BASE = process.env.FAKE_RESEND_URL;
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'operator-browser-test-key';
process.env.MAIL_FROM = 'alerts@fixture.invalid';
delete process.env.MAIL_REDIRECT_TO;
// The lead intake check (OB9) hashes the caller's address; it never stores it.
process.env.IP_HASH_SALT = process.env.IP_HASH_SALT || 'operator-browser-test-salt-0123456789';

const TG = process.env.FAKE_TG_URL;
const MAIL = process.env.FAKE_RESEND_URL;
const realFetch = globalThis.fetch;
const tgCtl = (body) => realFetch(TG + '/__control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const allTg = []; // every Telegram request of the suite, for OB14
const tgReqs = async () => (await (await realFetch(TG + '/__requests')).json()).requests;
const tgReset = async () => {
  try { allTg.push(...(await tgReqs())); } catch {}
  await realFetch(TG + '/__reset', { method: 'POST' });
};
const mailReqs = async () => (await (await realFetch(MAIL + '/__requests')).json()).requests.filter((x) => x.path === '/emails');
const mailReset = () => realFetch(MAIL + '/__reset', { method: 'POST' });
const mailCtl = (body) => realFetch(MAIL + '/__control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/* ---------- a very small PostgREST ---------- */

const uuid = (n) => `${String(n).padStart(8, '0')}-0000-0000-0000-${String(n).padStart(12, '0')}`;
const biz = (n) => `b${String(n).padStart(7, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BIZ_A = biz(1);   // Alder Roofing, two phones
const BIZ_B = biz(2);   // Beta Roofing, one phone
const BIZ_P = biz(3);   // paused (suspended), one phone
const BIZ_G = biz(7);   // Gable Works (gable-one), demo, no phone
const BIZ_C = biz(10);  // Juniper Roofing, churned
const BIZ_GONE = 'ffffffff-0000-4000-8000-00000000dead';

let store;
let sbRequests = [];
/** The order things happened in: a Telegram request is logged when it starts
 *  and again when its response is back; a database request when it starts. */
let trace = [];
let sbHook = null;
/** Answers a Telegram request in place of the fake, to fail one method only. */
let tgHook = null;
const tgRefuse = () => new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: fake refusal' }),
  { status: 400, headers: { 'content-type': 'application/json' } });

const business = (id, slug, name, status) => ({
  id, slug, name, status, timezone: 'America/Chicago', owner_email: `${slug}@fixture.invalid`, google_review_url: 'https://g.page/r/x',
  site_host: `${slug}.test`,
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
    if (raw.startsWith('neq.')) { if (String(v) === raw.slice(4)) return false; continue; }
    if (raw === 'is.null') { if (v !== null && v !== undefined) return false; continue; }
    if (raw === 'not.is.null') { if (v === null || v === undefined) return false; continue; }
    if (raw.startsWith('gt.')) { if (!(new Date(v) > new Date(raw.slice(3)))) return false; continue; }
    if (raw.startsWith('gte.')) { if (!(new Date(v) >= new Date(raw.slice(4)))) return false; continue; }
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
      const kind = url.startsWith(MAIL) ? 'mail' : 'tg';
      trace.push({ kind, method, chat: chat == null ? null : String(chat), phase: 'start' });
      try {
        const forced = kind === 'tg' && tgHook ? tgHook({ method, chat }) : null;
        return forced || await realFetch(input, init);
      } finally {
        trace.push({ kind, method, chat: chat == null ? null : String(chat), phase: 'end' });
      }
    }
    const u = new URL(url);
    const table = u.pathname.replace('/rest/v1/', '');
    const method = String(init.method || 'GET').toUpperCase();
    const params = [...u.searchParams.entries()];
    let sent = null;
    try { sent = init.body ? JSON.parse(init.body) : null; } catch { sent = null; }
    sbRequests.push({ table, method, params, body: sent });
    trace.push({ kind: 'sb', table, method });
    if (sbHook) {
      const forced = await sbHook({ table, method, params, body: sent });
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
    if (table === 'rate_limits') {
      if (method === 'DELETE') {
        const key = String(u.searchParams.get('key') || '').replace(/^eq\./, '');
        store.claims.delete(key);
      }
      return json([]);
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
      // The binding lookup embeds the business status through the foreign key.
      const embed = String(u.searchParams.get('select') || '').includes('businesses(');
      const out = rows.map((r) => {
        const b = store.businesses.find((x) => x.id === r.business_id);
        return embed ? { ...r, businesses: b ? { status: b.status } : null } : { ...r };
      });
      return json(out);
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
      if (method === 'PATCH') {
        const hit = store.businesses.filter((r) => match(r, params));
        for (const r of hit) Object.assign(r, sent || {});
        return json(hit.map((r) => ({ id: r.id })));
      }
      if (method !== 'GET' && method !== 'HEAD') return json([]);
      let rows = store.businesses.filter((r) => match(r, params));
      rows = rows.slice().sort(byOrder(u.searchParams.get('order')));
      if (countRequested(init)) return countHeader(rows.length);
      if (u.searchParams.get('id') || u.searchParams.get('slug')) return json(rows[0] || null);
      return json(paged(rows).map((r) => ({ ...r })));
    }
    if (table === 'v_client_leads') {
      let rows = store.leads.filter((r) => match(r, params));
      if (method === 'HEAD') return countHeader(rows.length);
      rows = rows.slice().sort(byOrder(u.searchParams.get('order')));
      if (u.searchParams.get('id')) return json(rows[0] ? { ...rows[0] } : null);
      // The fake answers with WHOLE rows whatever was selected, on purpose:
      // what the operator sees must not depend on the database being asked
      // for less. (What it IS asked for is checked on the request itself.)
      const total = rows.length;
      return json(paged(rows).map((r) => ({ ...r })), countRequested(init) ? { 'content-range': `0-0/${total}` } : {});
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
  await mailReset();
  sbRequests = [];
  trace = [];
  try { await call(update); } finally { console.log = realLog; }
  const tg = await tgReqs();
  const mail = await mailReqs();
  let obj = null;
  try { obj = lines.length === 1 ? JSON.parse(lines[0].slice(TIMING.length)) : null; } catch { obj = null; }
  return {
    tg, mail, sb: sbRequests.slice(), trace: trace.slice(), lines, obj,
    sends: of(tg, 'sendMessage'), edits: of(tg, 'editMessageText'),
    // An empty toast is sent without a text at all.
    answers: of(tg, 'answerCallbackQuery').map((x) => (x.body.text === undefined ? '' : String(x.body.text))),
  };
};

/* ---------- fixtures ---------- */

const DAY = 86400000;
/** `d` days and one hour ago: "Nd ago" whatever the minute the suite runs. */
const daysAgo = (d) => new Date(Date.now() - d * DAY - 3600000).toISOString();

// Everything a customer typed. None of it may reach the operator chat.
const PII = {
  name: 'Zed Customer', phone: '5155550100', email: 'zed.customer@fixture.invalid',
  zip: '50265', notes: 'gate code 4471', address: '12 Elm Street',
};
let seq = 1;
function seedLead(businessId, { name = PII.name, status = 'open', created_at = null, phone = PII.phone, email = PII.email, service = 'repair' } = {}) {
  const row = {
    id: uuid(1000 + seq), business_id: businessId, name, phone, email, zip: PII.zip, address: PII.address,
    service, home: 'house', timing: 'asap', roof_age: 'Not sure',
    insurance_claim: false, notes: PII.notes, status,
    created_at: created_at || new Date(Date.now() - seq * 60000).toISOString(),
  };
  seq++;
  store.leads.push(row);
  return row.id;
}
/** Seven leads of Alder Roofing: three in the last 30 days, the newest two
 *  days old. One lead of Beta Roofing, which must never show under Alder. */
const AGES = [2, 10, 20, 40, 50, 60, 70];
const seedSeven = () => {
  const ids = AGES.map((d, i) => seedLead(BIZ_A, { name: `${PII.name} ${i + 1}`, created_at: daysAgo(d), status: i === 1 ? 'contacted' : 'open' }));
  seedLead(BIZ_B, { name: 'Beta Only', phone: '5155550999', created_at: daysAgo(1), service: 'replacement' });
  return ids;
};
const seedCode = (businessId, code) => {
  store.codes.push({ code, business_id: businessId, used_at: null, expires_at: new Date(Date.now() + 3600000).toISOString(), created_at: new Date().toISOString() });
};
const liveCodes = (businessId) => store.codes.filter((c) => c.business_id === businessId && !c.used_at && new Date(c.expires_at) > new Date());

const PAGE0 = ['Alder Roofing · Demo · 2 phones', 'Beta Roofing · Active · 1 phone', 'Cedar Co · Active · 0 phones',
  'Delta Roofs · Active · 0 phones', 'Echo Roofing · Active · 0 phones'];
const PAGE0_IDS = [BIZ_A, BIZ_B, biz(4), biz(5), biz(6)];
const PAGE1_IDS = [biz(9), biz(7), biz(8), biz(11), biz(12)];
const listText = (rows) => 'Businesses\n\n' + rows.map((r, i) => `${i + 1}. ${r}`).join('\n');
const DETAIL_A = 'Alder Roofing\nDemo · alder-demo\n\nTelegram: Connected\nPhone 1 · main phone\nPhone 2 (Van)\n\nLeads: 7 total · 3 in the last 30 days\nLast lead: 2d ago';
const DETAIL_FIR = 'Fir & Sons\nActive · fir\n\nTelegram: Not connected\n\nLeads: 0 total · 0 in the last 30 days';
const DETAIL_P = 'Zz Paused\nSuspended · zz-paused\n\nTelegram: Connected\nPhone 1 · main phone\n\nLeads: 0 total · 0 in the last 30 days';
const detailKb = (id, page) => [
  [{ text: 'Suspend', callback_data: `bs:${page}:${id}`, style: 'danger' }, { text: 'Leads', callback_data: `bq:0:${page}:${id}` }],
  [{ text: 'Invite', callback_data: `bv:${page}:${id}`, style: 'primary' }, { text: 'Back', callback_data: `bl:${page}` }],
];
const suspendedKb = (id, page) => [
  [{ text: 'Reactivate', callback_data: `br:${page}:${id}`, style: 'primary' }, { text: 'Leads', callback_data: `bq:0:${page}:${id}` }],
  [{ text: 'Back', callback_data: `bl:${page}` }],
];
const backKb = (id, page) => [[{ text: 'Back', callback_data: `bd:${page}:${id}` }]];
const packed = (businessId, leadId) => C.packUuid(businessId) + C.packUuid(leadId);
const OPERATOR_KB = { keyboard: [[{ text: 'Invite' }, { text: 'Businesses' }]], is_persistent: true, resize_keyboard: true };
const OWNER_KB = { keyboard: [[{ text: 'Invite' }, { text: 'Leads' }]], is_persistent: true, resize_keyboard: true };
const STAFF_KB = { keyboard: [[{ text: 'Leads' }]], is_persistent: true, resize_keyboard: true };
const REMOVED_KB = { remove_keyboard: true };
const fail500 = () => new Response('{"message":"fake failure"}', { status: 500, headers: { 'content-type': 'application/json' } });
const textOf = (req) => String((req && req.body && req.body.text) || '');
const SUSPEND_ASK = 'Suspend Alder Roofing? Telegram alerts, emails and the website form stop for this business. Data is kept and you can reactivate at any time.';
const NOTICE = 'Your service has been suspended. Contact support if this is a mistake.';
const SUSPENDED_LINE = 'This service is suspended. Contact support.';
const EXPIRED = 'That screen expired. Here is the current screen.';
/** Every text the operator chat was shown, across the suite (for OB4). */
const operatorTexts = [];
const seen = (r) => { for (const m of [...r.sends, ...r.edits]) if (String(m.body.chat_id) === String(OP)) operatorTexts.push(textOf(m)); return r; };

try {
  install();
  await tgCtl({ mode: 'ok', failChat: null });
  // Whatever an earlier suite left in the fakes' logs is not this suite's.
  await realFetch(TG + '/__reset', { method: 'POST' });
  await mailReset();

  /* OB1: the list, as one message. */
  store = freshStore();
  {
    const r = seen(await run(msg(OP, '/businesses')));
    const list = r.sends[0] || { body: {} };
    const kb = kbOf(list);
    const pageReads = r.sb.filter((q) => q.table === 'businesses');
    const counts = r.sb.filter((q) => q.table === 'business_chats' && param(q, 'business_id'));
    const inList = String(param(counts[0] || { params: [] }, 'business_id') || '');
    const oneCountQuery = counts.length === 1 && counts[0].method === 'GET'
      && PAGE0_IDS.every((id) => inList.includes(id)) && inList.startsWith('in.(')
      && r.sb.length === 3; // the binding, the page, the counts — never one per business
    const ordered = pageReads.length === 1 && param(pageReads[0], 'order') === 'name.asc,id.asc'
      && param(pageReads[0], 'limit') === '6' && param(pageReads[0], 'offset') === '0'
      && !param(pageReads[0], 'status'); // every status is listed
    line(r.sends.length === 1 && r.edits.length === 0 && r.tg.length === 1
      && list.body.text === listText(PAGE0)
      && kb.length === 2 && numbersOk(kb[0], 5)
      && PAGE0_IDS.every((id, i) => kb[0][i].callback_data === `bd:0:${id}`)
      && same(kb[1], [{ text: 'Older', callback_data: 'bl:1' }])
      && !kb.flat().some((b) => 'disabled' in b || b.copy_text)
      && oneCountQuery && ordered,
      'OB1', '/businesses: one message, 5 rows, counts in one query',
      `sends=${r.sends.length} db=${r.sb.length} countQueries=${counts.length} order=${ordered}`);

    // The keyboard label, the label of the keyboard before it, and the
    // command with the bot's name all open the same screen.
    const bad = [];
    for (const text of ['Businesses', 'Phones', '/businesses@alder_test_bot']) {
      const w = await run(msg(OP, text));
      const m = w.sends[0];
      if (w.sends.length !== 1 || !m || m.body.text !== list.body.text || !same(kbOf(m), kb) || writes(w.sb).length) bad.push(text);
    }
    line(bad.length === 0, 'OB1a', 'the Businesses label and the old Phones label open it', `bad=${bad.join(',') || 'none'}`);
  }

  /* OB1b: the retired commands. One fallback line, nothing read or written. */
  store = freshStore();
  seedSeven();
  {
    const before = snapshot();
    const retired = ['/phones', '/phones alder-demo', '/recipients', '/leads', '/code', '/code alder-demo', '/remove_lead',
      '/terminate', '/code@alder_test_bot', 'Recipients', 'Leads', 'hello'];
    const bad = [];
    for (const text of retired) {
      const r = seen(await run(msg(OP, text)));
      const m = r.sends[0];
      const onlyBinding = r.sb.length === 1 && r.sb[0].table === 'business_chats' && param(r.sb[0], 'tg_chat_id') === `eq.${OP}`;
      if (r.tg.length !== 1 || r.sends.length !== 1 || textOf(m) !== C.OPERATOR_WELCOME
        || !same(m.body.reply_markup, OPERATOR_KB) || !onlyBinding) bad.push(text);
    }
    const fallbackOk = C.OPERATOR_WELCOME === 'This is the operator chat. Send /help for the commands.';
    // /help and its alias, typed or pressed on an old keyboard.
    const helps = [];
    for (const text of ['/help', '/operator', 'Help', 'Operator']) {
      const r = seen(await run(msg(OP, text)));
      if (r.sends.length !== 1 || textOf(r.sends[0]) !== C.OPERATOR_HELP || !same(r.sends[0].body.reply_markup, OPERATOR_KB) || r.sb.length !== 1) helps.push(text);
    }
    const commands = (C.OPERATOR_HELP.match(/^\/[a-z_]+/gm) || []);
    const helpOk = same(commands, ['/businesses', '/invite', '/help', '/id'])
      && !/\/phones|\/code|\/recipients|\/leads|\/remove_lead|Terminate|Requests/.test(C.OPERATOR_HELP);
    const id = await run(msg(OP, '/id'));
    const idOk = id.sends.length === 1 && textOf(id.sends[0]) === C.operatorIdMessage(OP, { operator: true }).text;
    line(bad.length === 0 && fallbackOk && helps.length === 0 && helpOk && idOk && snapshot() === before && store.codes.length === 0,
      'OB1b', 'retired commands: only the fallback, which points to /help',
      `bad=${bad.join(',') || 'none'} fallback=${fallbackOk} help=${helps.join(',') || 'ok'}/${helpOk} id=${idOk}`);
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
    // The suspended business is on the last page and shows its real phone.
    const lastOk = last.sends.length === 0 && last.edits.length === 1
      && last.edits[0].body.text === listText(['Juniper Roofing · Churned · 0 phones', 'Zz Paused · Suspended · 1 phone'])
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
    sbHook = ({ table, params }) => (table === 'business_chats' && String(param({ params }, 'business_id') || '').startsWith('in.(') ? fail500() : null);
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
    const noneOk = none.sends.length === 1 && none.sends[0].body.text === 'No businesses yet.' && kbOf(none.sends[0]).length === 0;
    line(midOk && lastOk && firstOk && staleOk && unknownOk && singleOk && noneOk,
      'OB2', 'paging in place; only useful ends; stale page; "?" count',
      `mid=${midOk} last=${lastOk} first=${firstOk} stale=${staleOk} unknown=${unknownOk} single=${singleOk} none=${noneOk}`);
  }

  /* OB3: one business, in the same message. The three states, exactly. */
  store = freshStore();
  let leadIds = seedSeven();
  {
    const open = seen(await run(cb(OP, `bd:0:${BIZ_A}`)));
    const leadReads = open.sb.filter((q) => q.table === 'v_client_leads');
    // Two aggregates and nothing else: a count with the newest created_at
    // (one row, one column), and a count since a date (no row at all).
    const head = leadReads.find((q) => q.method === 'HEAD');
    const newest = leadReads.find((q) => q.method === 'GET');
    const sinceMs = head ? Date.now() - new Date(String(param(head, 'created_at')).replace(/^gte\./, '')).getTime() : 0;
    const aggregates = leadReads.length === 2 && !!head && !!newest
      && leadReads.every((q) => param(q, 'business_id') === `eq.${BIZ_A}`)
      && param(newest, 'select') === 'created_at' && param(newest, 'limit') === '1' && param(newest, 'order') === 'created_at.desc'
      && String(param(head, 'created_at')).startsWith('gte.') && Math.abs(sinceMs - 30 * DAY) < 60000;
    const openOk = open.sends.length === 0 && open.edits.length === 1 && open.edits[0].body.message_id === 9
      && same(open.answers, ['']) && open.edits[0].body.text === DETAIL_A
      && same(kbOf(open.edits[0]), detailKb(BIZ_A, 0))
      && writes(open.sb).length === 0 && open.sb.length === 5; // binding, business, phones, two aggregates
    // From page 1, Back goes to page 1 — and that edit is the page-1 list again.
    const other = seen(await run(cb(OP, `bd:1:${biz(9)}`)));
    const otherOk = other.edits.length === 1 && other.edits[0].body.text === DETAIL_FIR
      && same(kbOf(other.edits[0]), detailKb(biz(9), 1));
    const back = await run(cb(OP, 'bl:1'));
    const backOk = back.sends.length === 0 && back.edits.length === 1 && back.edits[0].body.text === page1Text;
    // Suspended: Reactivate where Suspend was, no Invite; its phones still shown.
    const paused = seen(await run(cb(OP, `bd:2:${BIZ_P}`)));
    const pausedOk = paused.edits.length === 1 && paused.edits[0].body.text === DETAIL_P
      && same(kbOf(paused.edits[0]), suspendedKb(BIZ_P, 2));
    // No line twice, the word "Requests" nowhere, nothing after the Telegram
    // status on its line, and each number once.
    const texts = [open, other, paused].map((x) => textOf(x.edits[0]));
    const clean = texts.every((t) => {
      const lines = t.split('\n').filter(Boolean);
      const telegram = lines.filter((l) => l.startsWith('Telegram:'));
      return new Set(lines).size === lines.length && !/Requests?/i.test(t) && !/\d phones?/.test(t)
        && telegram.length === 1 && ['Telegram: Connected', 'Telegram: Not connected'].includes(telegram[0])
        && lines.filter((l) => l.startsWith('Leads:')).length === 1 && lines.filter((l) => l.startsWith('Last lead:')).length <= 1;
    }) && !texts[1].includes('Last lead') && !texts[1].includes('Phone 1');
    // A number that could not be read is "?", never 0.
    sbHook = ({ table }) => (table === 'v_client_leads' ? fail500() : null);
    const blind = await run(cb(OP, `bd:0:${BIZ_A}`));
    sbHook = null;
    const blindOk = blind.edits.length === 1 && textOf(blind.edits[0]).endsWith('Leads: ? total · ? in the last 30 days');
    line(openOk && aggregates && otherOk && backOk && pausedOk && clean && blindOk,
      'OB3', 'business screen: three states, exact text, rows and styles',
      `open=${openOk} aggregates=${aggregates} notConnected=${otherOk} back=${backOk} suspended=${pausedOk} clean=${clean} unknown=${blindOk}`);
  }

  /* OB4: the business's leads, read-only and minimal. */
  {
    const before = snapshot();
    const reads = [];
    const p0 = seen(await run(cb(OP, `bq:0:0:${BIZ_A}`)));
    reads.push(...p0.sb);
    const kb0 = kbOf(p0.edits[0]);
    const text0 = textOf(p0.edits[0]);
    const listOk = p0.sends.length === 0 && p0.edits.length === 1 && p0.edits[0].body.message_id === 9
      && text0 === 'Alder Roofing\nLeads\n\n1. Repair · New · 2d ago\n2. Repair · Contacted · 10d ago\n3. Repair · New · 20d ago\n4. Repair · New · 40d ago\n5. Repair · New · 50d ago'
      && kb0.length === 3 && numbersOk(kb0[0], 5)
      && leadIds.slice(0, 5).every((id, i) => kb0[0][i].callback_data === `bo:0:0:${packed(BIZ_A, id)}`)
      && same(kb0[1], [{ text: 'Older', callback_data: `bq:1:0:${BIZ_A}` }])
      && same(kb0[2], [{ text: 'Back', callback_data: `bd:0:${BIZ_A}` }]);
    const p1 = seen(await run(cb(OP, `bq:1:0:${BIZ_A}`)));
    reads.push(...p1.sb);
    const kb1 = kbOf(p1.edits[0]);
    const lastOk = p1.edits.length === 1 && textOf(p1.edits[0]) === 'Alder Roofing\nLeads\n\n1. Repair · New · 60d ago\n2. Repair · New · 70d ago'
      && kb1.length === 3 && numbersOk(kb1[0], 2)
      && same(kb1[1], [{ text: 'Newer', callback_data: `bq:0:0:${BIZ_A}` }])
      && same(kb1[2], [{ text: 'Back', callback_data: `bd:0:${BIZ_A}` }]);
    // One lead: one line per allowed field, and only Back under it.
    const det = seen(await run(cb(OP, kb0[0][1].callback_data)));
    reads.push(...det.sb);
    const detKb = kbOf(det.edits[0]);
    const detOk = det.sends.length === 0 && det.edits.length === 1 && det.edits[0].body.message_id === 9
      && textOf(det.edits[0]) === 'Alder Roofing\nLead\n\nService: Repair\nStatus: Contacted\nReceived: 10d ago'
      && same(detKb, [[{ text: 'Back', callback_data: `bq:0:0:${BIZ_A}` }]]);
    const backToList = seen(await run(cb(OP, detKb[0][0].callback_data)));
    reads.push(...backToList.sb);
    const backOk = backToList.edits.length === 1 && textOf(backToList.edits[0]) === text0;
    const toBusiness = await run(cb(OP, kb1[2][0].callback_data));
    const upOk = toBusiness.edits.length === 1 && toBusiness.edits[0].body.text === DETAIL_A;
    // An empty business: a toast, the name, and Back.
    const empty = seen(await run(cb(OP, `bq:0:1:${biz(9)}`)));
    const emptyOk = same(empty.answers, ['No leads yet.']) && empty.edits.length === 1
      && empty.edits[0].body.text === 'Fir & Sons\nNo leads yet.'
      && same(kbOf(empty.edits[0]), [[{ text: 'Back', callback_data: `bd:1:${biz(9)}` }]]);
    // A lead addressed under ANOTHER business is not found: the read is by id
    // AND that business.
    const cross = seen(await run(cb(OP, `bo:0:0:${packed(BIZ_B, leadIds[0])}`)));
    reads.push(...cross.sb);
    const crossOk = same(cross.answers, ['That lead is no longer here.']) && cross.edits.length === 1
      && textOf(cross.edits[0]) === 'Beta Roofing\nLeads\n\n1. Roof replacement · New · 1d ago';
    const leadReads = reads.filter((q) => q.table === 'v_client_leads');
    const scoped = leadReads.length >= 5 && leadReads.every((q) => /^eq\.b000000[12]-/.test(String(param(q, 'business_id'))));
    const ordered = leadReads.filter((q) => !param(q, 'id')).every((q) => param(q, 'order') === 'created_at.desc,id.desc');
    // The database is asked for these columns and no other. (The fake answers
    // with whole rows all the same, so the screens are tested on their own.)
    const columns = leadReads.every((q) => String(param(q, 'select')).replace(/\s/g, '') === 'id,service,status,created_at');
    // Nothing a customer typed, on any screen the operator was shown so far.
    const forbidden = [PII.name, 'Zed', 'Customer', PII.phone, '515', PII.email, '@', PII.zip, PII.notes, '4471', PII.address, 'Elm', 'Beta Only', '5155550999'];
    const shown = [p0, p1, det, backToList, empty, cross].flatMap((x) => [...x.sends, ...x.edits].map(textOf));
    const leaked = forbidden.filter((x) => shown.some((t) => t.includes(x)));
    // The one constant, and what adding the name to it would do.
    const withName = [...C.OPERATOR_LEAD_FIELDS, 'name'];
    const sample = store.leads.find((l) => l.id === leadIds[0]);
    const constantOk = same([...C.OPERATOR_LEAD_FIELDS], ['service', 'status', 'age'])
      && same(C.operatorLeadColumns(), ['service', 'status', 'created_at'])
      && same(C.operatorLeadColumns(withName), ['service', 'status', 'created_at', 'name'])
      && C.operatorLeadCardText({ name: 'Alder Roofing' }, sample, Date.now(), withName).endsWith(`Name: ${PII.name} 1`)
      && !C.operatorLeadCardText({ name: 'Alder Roofing' }, sample).includes(PII.name)
      && same(C.operatorLeadColumns(['phone', 'email', 'notes', 'zip']), []);
    // Nothing a tap could change: no status, remove, copy or review button.
    const buttons = [kb0, kb1, detKb].flat(2);
    const actionFree = buttons.every((b) => /^(bo|bq|bd):/.test(b.callback_data) && !b.copy_text && !b.url && !b.style);
    line(listOk && lastOk && detOk && backOk && upOk && emptyOk && crossOk && scoped && ordered && columns && leaked.length === 0
      && constantOk && actionFree && writes(reads).length === 0 && snapshot() === before,
      'OB4', 'leads: only service, status, age; scoped, ordered, read-only',
      `list=${listOk} last=${lastOk} card=${detOk} back=${backOk}/${upOk} empty=${emptyOk} cross=${crossOk} scoped=${scoped} ordered=${ordered} columns=${columns} leaked=${leaked.join(',') || 'none'} constant=${constantOk} free=${actionFree}`);
  }

  /* OB5: Suspend asks; Cancel goes back; nothing is sent or changed. */
  seedCode(BIZ_A, 'KEEPKEEPKEEP');
  {
    const before = snapshot();
    const ask = seen(await run(cb(OP, `bs:0:${BIZ_A}`)));
    const askKb = kbOf(ask.edits[0]);
    const askOk = ask.sends.length === 0 && ask.edits.length === 1 && ask.edits[0].body.message_id === 9
      && ask.edits[0].body.text === SUSPEND_ASK && same(ask.answers, [''])
      && same(askKb, [[
        { text: 'Confirm suspend', callback_data: `bS:0:${BIZ_A}`, style: 'danger' },
        { text: 'Cancel', callback_data: `bd:0:${BIZ_A}` },
      ]])
      && writes(ask.sb).length === 0 && ask.mail.length === 0
      // The question needs no phone list: the binding and the business.
      && ask.sb.length === 2;
    const cancel = await run(cb(OP, askKb[0][1].callback_data));
    const cancelOk = cancel.sends.length === 0 && cancel.edits.length === 1 && cancel.edits[0].body.text === DETAIL_A
      && same(kbOf(cancel.edits[0]), detailKb(BIZ_A, 0)) && writes(cancel.sb).length === 0 && cancel.mail.length === 0;
    line(askOk && cancelOk && snapshot() === before, 'OB5', 'Suspend asks first; Cancel returns; nothing changed',
      `ask=${askOk} cancel=${cancelOk} unchanged=${snapshot() === before}`);
  }

  /* OB6: Confirm. Notices and the email first, then one scoped UPDATE. */
  {
    const others = () => JSON.stringify({
      b: store.businesses.filter((b) => b.id !== BIZ_A), c: store.chats, k: store.codes, l: store.leads, e: store.events,
    });
    const before = others();
    const r = seen(await run(cb(OP, `bS:0:${BIZ_A}`)));
    const notices = r.sends.filter((m) => m.body.text === NOTICE);
    const noticeOk = r.sends.length === 2 && notices.length === 2
      && same(notices.map((m) => String(m.body.chat_id)).sort(), [String(OWNER), String(STAFF)].sort())
      && notices.every((m) => same(m.body.reply_markup, REMOVED_KB) && !('parse_mode' in m.body));
    // One plain email to the owner address, with the same sentence.
    const mail = r.mail[0] && r.mail[0].body;
    const mailOk = r.mail.length === 1 && same([].concat(mail.to), ['alder-demo@fixture.invalid'])
      && mail.subject === 'Your service has been suspended' && String(mail.text).includes(NOTICE)
      && !/alder-demo|Suspend Alder/.test(String(mail.text));
    // Order: every notice and the email were answered before the status write began.
    const patchAt = r.trace.findIndex((t) => t.kind === 'sb' && t.table === 'businesses' && t.method === 'PATCH');
    const lastNotice = r.trace.map((t, i) => (((t.kind === 'tg' && t.method === 'sendMessage') || t.kind === 'mail') && t.phase === 'end' ? i : -1))
      .reduce((a, b) => Math.max(a, b), -1);
    const orderOk = patchAt > 0 && lastNotice >= 0 && lastNotice < patchAt;
    // The write: one statement, by the id and the served statuses.
    const w = writes(r.sb);
    const status = String(param(w[0] || { params: [] }, 'status') || '');
    const writeOk = w.length === 1 && w[0].table === 'businesses' && w[0].method === 'PATCH'
      && param(w[0], 'id') === `eq.${BIZ_A}` && /^in\.\("?demo"?,"?active"?\)$/.test(status)
      && same(w[0].body, { status: 'paused' })
      && store.businesses.find((b) => b.id === BIZ_A).status === 'paused';
    // Bindings, invites, leads, every other business: as they were.
    const untouched = others() === before && store.chats.filter((c) => c.business_id === BIZ_A).length === 2
      && liveCodes(BIZ_A).length === 1 && store.leads.filter((l) => l.business_id === BIZ_A).length === 7;
    const resultOk = r.edits.length === 1 && r.edits[0].body.message_id === 9
      && r.edits[0].body.text === 'Alder Roofing suspended · 0 notices failed'
      && same(kbOf(r.edits[0]), backKb(BIZ_A, 0)) && same(r.answers, ['Suspended.']);
    line(noticeOk && mailOk && orderOk && writeOk && untouched && resultOk,
      'OB6', 'suspend: notices and email first, one scoped update',
      `notice=${noticeOk} mail=${mailOk} order=${orderOk} write=${writeOk} untouched=${untouched} result=${resultOk}`);
  }

  /* OB7: a second tap changes nothing and tells nobody. */
  {
    const before = snapshot();
    const again = await run(cb(OP, `bS:0:${BIZ_A}`));
    const againOk = again.sends.length === 0 && again.mail.length === 0 && writes(again.sb).length === 0
      && again.edits.length === 1 && again.edits[0].body.text === 'Alder Roofing is already suspended.'
      && same(kbOf(again.edits[0]), backKb(BIZ_A, 0)) && same(again.answers, ['Already suspended.']);
    // The question, asked from a screen that is out of date: the business as it is now.
    const ask = await run(cb(OP, `bs:0:${BIZ_A}`));
    const askOk = ask.sends.length === 0 && ask.mail.length === 0 && writes(ask.sb).length === 0 && ask.edits.length === 1
      && textOf(ask.edits[0]).startsWith('Alder Roofing\nSuspended · alder-demo\n\nTelegram: Connected\nPhone 1 · main phone\nPhone 2 (Van)\n')
      && same(kbOf(ask.edits[0]), suspendedKb(BIZ_A, 0)) && same(ask.answers, ['Already suspended.']);
    // A business that was suspended by hand, and one that has churned.
    const paused = await run(cb(OP, `bS:2:${BIZ_P}`));
    const churned = await run(cb(OP, `bS:2:${BIZ_C}`));
    const neverOk = [paused, churned].every((x) => x.sends.length === 0 && x.mail.length === 0 && writes(x.sb).length === 0
      && same(x.answers, ['Already suspended.']));
    line(againOk && askOk && neverOk && snapshot() === before, 'OB7', 'second tap: already suspended, nothing sent or written',
      `again=${againOk} ask=${askOk} others=${neverOk} unchanged=${snapshot() === before}`);
  }

  /* OB9: what a suspended business's phones, new phones and website get. */
  {
    const before = snapshot();
    const lead = leadIds[0];
    const row = uuid(2);
    const onlyBinding = (x, chat) => x.sb.length === 1 && x.sb[0].table === 'business_chats' && param(x.sb[0], 'tg_chat_id') === `eq.${chat}`;
    // Every command and every keyboard press: the one line, the keyboard
    // removed, and nothing read beyond the chat's own binding.
    const bad = [];
    for (const chat of [OWNER, STAFF]) {
      for (const text of ['/leads', '/invite', '/recipients', '/remove_lead', '/help', '/start', '/start KEEPKEEPKEEP', 'Leads', 'Invite', 'Recipients', 'Help']) {
        const x = await run(msg(chat, text));
        if (x.tg.length !== 1 || x.sends.length !== 1 || textOf(x.sends[0]) !== SUSPENDED_LINE
          || !same(x.sends[0].body.reply_markup, REMOVED_KB) || !onlyBinding(x, chat)) bad.push(`${chat === OWNER ? 'owner' : 'staff'}:${text}`);
      }
    }
    // Every button of a message sent before the suspension: the same line as
    // a toast; nothing drawn, nothing read, nothing changed.
    const taps = [];
    for (const chat of [OWNER, STAFF]) {
      for (const data of ['l:0', `L:0:${lead}`, `c:${lead}`, `d:${lead}`, `C:0:${lead}`, `D:0:${lead}`, `Y:0:${lead}`, `o:${lead}`,
        'rm:0', `Q:0:${lead}`, `E:0:${lead}`, `rl:${lead}`, `RL:${lead}`, 'i:c', `x:${row}`, `X:${row}`, `v:${row}`, 'nonsense']) {
        const x = await run(cb(chat, data));
        if (!same(x.answers, [SUSPENDED_LINE]) || x.sends.length || x.edits.length || x.mail.length || !onlyBinding(x, chat)) taps.push(data.slice(0, 2));
      }
    }
    // Free text: the same line, at most three times an hour.
    let replies = 0;
    for (let i = 0; i < 5; i++) {
      const x = await run(msg(STAFF, 'is anyone there'));
      replies += x.sends.filter((m) => textOf(m) === SUSPENDED_LINE && same(m.body.reply_markup, REMOVED_KB)).length;
      if (x.sends.some((m) => textOf(m) !== SUSPENDED_LINE)) replies = -99;
    }
    // /id is the chat's own id and nothing else: still answered.
    const id = await run(msg(OWNER, '/id'));
    const idOk = id.sends.length === 1 && textOf(id.sends[0]) === C.operatorIdMessage(OWNER, { operator: false }).text;
    // A new phone with a live invite of the suspended business: not connected,
    // and the invite is still unused for the day the business is reactivated.
    const link = await run(msg(CHAT_X, '/start KEEPKEEPKEEP'));
    const pasted = await run(msg(CHAT_X, 'KEEPKEEPKEEP'));
    const bindOk = [link, pasted].every((x) => x.sends.length === 1 && textOf(x.sends[0]) === SUSPENDED_LINE)
      && !store.chats.some((c) => String(c.tg_chat_id) === String(CHAT_X))
      && liveCodes(BIZ_A).length === 1 && liveCodes(BIZ_A)[0].code === 'KEEPKEEPKEEP';
    // The website form. Host picks the tenant, and only a served one: the
    // request is refused before anything is stored, alerted or mailed.
    const { default: leadHandler } = await import('../api/lead.js');
    const post = async (host, type = 'application/json') => {
      await tgReset(); await mailReset(); sbRequests = [];
      const body = {
        service: 'repair', home: 'house', timing: 'asap', age: 'Not sure', zip: '50265', phone: '5155550142', name: 'Form Visitor',
        email: 'visitor@fixture.invalid', notes: '', claim: false, website: '', elapsed: 5000, idempotencyKey: 'ob9-' + Math.random().toString(36).slice(2, 12),
      };
      const res = fakeRes();
      await leadHandler({ method: 'POST', headers: { 'content-type': type, 'x-real-ip': '203.0.113.9', host }, body, socket: {} }, res);
      return { res, sb: sbRequests.slice(), tg: await tgReqs(), mail: await mailReqs() };
    };
    const refused = await post('alder-demo.test');
    const lookup = refused.sb.find((q) => q.table === 'businesses');
    const refusedOk = refused.res.code === 404 && same(refused.res.body, { ok: false })
      && !!lookup && param(lookup, 'site_host') === 'eq.alder-demo.test' && /^in\.\("?demo"?,"?active"?\)$/.test(String(param(lookup, 'status')))
      && refused.sb.every((q) => q.table === 'businesses' || q.table === 'rpc/hit_rate_limit')
      && refused.tg.length === 0 && refused.mail.length === 0;
    const form = await post('alder-demo.test', 'application/x-www-form-urlencoded');
    const formOk = form.res.code === 404 && /Not found/.test(String(form.res.body)) && !/suspend|Alder/i.test(String(form.res.body))
      && form.tg.length === 0 && form.mail.length === 0;
    // The same request for a served business gets past that check.
    const served = await post('beta.test');
    const servedOk = served.res.code !== 404 && served.sb.some((q) => q.table !== 'businesses' && q.table !== 'rpc/hit_rate_limit');
    // Another business never notices.
    const other = await run(msg(CHAT_B, '/leads'));
    const otherOk = other.sends.length === 1 && textOf(other.sends[0]) !== SUSPENDED_LINE && textOf(other.sends[0]).includes('Beta Only')
      && other.sb.some((q) => q.table === 'v_client_leads');
    store.leads = store.leads.filter((l) => l.name !== 'Form Visitor');
    store.events = [];
    const unchanged = JSON.stringify({ b: store.businesses, c: store.chats, k: store.codes, l: store.leads }) === JSON.stringify((({ b, c, k, l }) => ({ b, c, k, l }))(JSON.parse(before)));
    line(bad.length === 0 && taps.length === 0 && replies === 3 && idOk && bindOk && refusedOk && formOk && servedOk && otherOk && unchanged,
      'OB9', 'suspended: one neutral line, no data, form refused',
      `commands=${bad.slice(0, 3).join(',') || 'ok'} taps=${taps.join(',') || 'ok'} free=${replies} id=${idOk} bind=${bindOk} intake=${refusedOk}/${formOk}/${servedOk} other=${otherOk} unchanged=${unchanged}`);
  }

  /* OB10: Reactivate. */
  {
    const others = () => JSON.stringify({
      b: store.businesses.filter((b) => b.id !== BIZ_A), c: store.chats, k: store.codes, l: store.leads,
    });
    const before = others();
    const r = seen(await run(cb(OP, `br:0:${BIZ_A}`)));
    const w = writes(r.sb);
    const status = String(param(w[0] || { params: [] }, 'status') || '');
    // A business that was demo before it was suspended comes back as active.
    const writeOk = w.length === 1 && w[0].table === 'businesses' && w[0].method === 'PATCH'
      && param(w[0], 'id') === `eq.${BIZ_A}` && /^in\.\("?paused"?,"?churned"?\)$/.test(status)
      && same(w[0].body, { status: 'active' }) && store.businesses.find((b) => b.id === BIZ_A).status === 'active';
    const told = (chat) => r.sends.filter((m) => String(m.body.chat_id) === String(chat));
    const noticeOk = r.sends.length === 2 && r.mail.length === 0
      && told(OWNER).length === 1 && textOf(told(OWNER)[0]) === 'Your service is active again.' && same(told(OWNER)[0].body.reply_markup, OWNER_KB)
      && told(STAFF).length === 1 && textOf(told(STAFF)[0]) === 'Your service is active again.' && same(told(STAFF)[0].body.reply_markup, STAFF_KB);
    const resultOk = r.edits.length === 1 && r.edits[0].body.text === 'Alder Roofing reactivated'
      && same(kbOf(r.edits[0]), backKb(BIZ_A, 0)) && same(r.answers, ['Reactivated.']) && others() === before;
    // Twice, and for a business that was never suspended: nothing.
    const again = await run(cb(OP, `br:0:${BIZ_A}`));
    const never = await run(cb(OP, `br:0:${BIZ_B}`));
    const againOk = [again, never].every((x) => x.sends.length === 0 && x.mail.length === 0 && writes(x.sb).length === 0
      && same(x.answers, ['Already active.']) && x.edits.length === 1)
      && again.edits[0].body.text === 'Alder Roofing is already active.' && never.edits[0].body.text === 'Beta Roofing is already active.'
      && same(kbOf(never.edits[0]), backKb(BIZ_B, 0));
    // The business screen and the phones are back to normal.
    const detail = await run(cb(OP, `bd:0:${BIZ_A}`));
    const leads = await run(msg(OWNER, '/leads'));
    const backOk = textOf(detail.edits[0]).startsWith('Alder Roofing\nActive · alder-demo\n') && same(kbOf(detail.edits[0]), detailKb(BIZ_A, 0))
      && leads.sends.length === 1 && textOf(leads.sends[0]) !== SUSPENDED_LINE && leads.sb.some((q) => q.table === 'v_client_leads');
    // A churned business is reactivated the same way.
    const churned = await run(cb(OP, `br:2:${BIZ_C}`));
    const churnedOk = churned.edits.length === 1 && churned.edits[0].body.text === 'Juniper Roofing reactivated'
      && store.businesses.find((b) => b.id === BIZ_C).status === 'active' && churned.sends.length === 0;
    line(writeOk && noticeOk && resultOk && againOk && backOk && churnedOk, 'OB10', 'reactivate: one scoped update, phones told with their keyboards',
      `write=${writeOk} notice=${noticeOk} result=${resultOk} again=${againOk} back=${backOk} churned=${churnedOk}`);
  }

  /* OB8: failures on the way. */
  {
    // One phone cannot be reached: counted, and the suspension goes through.
    store = freshStore();
    leadIds = seedSeven();
    await tgCtl({ mode: 'ok', failChat: String(STAFF) });
    const one = await run(cb(OP, `bS:0:${BIZ_A}`));
    await tgCtl({ mode: 'ok', failChat: null });
    const oneOk = one.sends.length === 2 && one.edits.length === 1 && one.edits[0].body.text === 'Alder Roofing suspended · 1 notice failed'
      && store.businesses.find((b) => b.id === BIZ_A).status === 'paused';
    // The email cannot be sent: counted like a phone, and the suspension goes
    // through. No owner address: there is no email to fail, so nothing is counted.
    store = freshStore();
    // (The Resend fake replays the first answer for a repeated idempotency
    // key, as Resend does; this business was suspended earlier in the run.)
    await mailCtl({ mode: '500', clearIdempotency: true });
    const noMail = await run(cb(OP, `bS:0:${BIZ_A}`));
    await mailCtl({ mode: 'ok', clearIdempotency: true });
    store.businesses.find((b) => b.id === BIZ_B).owner_email = null;
    const noAddress = await run(cb(OP, `bS:0:${BIZ_B}`));
    const mailOk = noMail.edits.length === 1 && noMail.edits[0].body.text === 'Alder Roofing suspended · 1 notice failed'
      && noMail.mail.length === 1 && noMail.sends.length === 2
      && store.businesses.find((b) => b.id === BIZ_A).status === 'paused'
      && noAddress.mail.length === 0 && noAddress.sends.length === 1 && noAddress.edits[0].body.text === 'Beta Roofing suspended · 0 notices failed'
      && store.businesses.find((b) => b.id === BIZ_B).status === 'paused';
    // The phone list cannot be read: nobody is told and nothing is changed.
    store = freshStore();
    const before = snapshot();
    sbHook = ({ table, params }) => (table === 'business_chats' && param({ params }, 'business_id') === `eq.${BIZ_A}` ? fail500() : null);
    const blind = await run(cb(OP, `bS:0:${BIZ_A}`));
    sbHook = null;
    const blindOk = blind.sends.length === 0 && blind.mail.length === 0 && blind.edits.length === 0 && writes(blind.sb).length === 0
      && same(blind.answers, [C.TOAST_GENERIC_ERROR]) && snapshot() === before;
    // The status cannot be written: it is not reported as done.
    sbHook = ({ table, method }) => (table === 'businesses' && method === 'PATCH' ? fail500() : null);
    const stuck = await run(cb(OP, `bS:0:${BIZ_A}`));
    sbHook = null;
    const stuckOk = stuck.edits.length === 0 && same(stuck.answers, [C.TOAST_GENERIC_ERROR])
      && store.businesses.find((b) => b.id === BIZ_A).status === 'demo';
    line(oneOk && mailOk && blindOk && stuckOk, 'OB8', 'a failed notice or email never blocks; a failed read or write is said',
      `phone=${oneOk} mail=${mailOk} read=${blindOk} write=${stuckOk}`);
  }

  /* OB11: unknown businesses, malformed data, and the retired buttons. */
  store = freshStore();
  leadIds = seedSeven();
  seedCode(BIZ_A, 'KEEPKEEPKEEP');
  {
    const before = snapshot();
    const bad = [];
    for (const data of [`bd:0:${BIZ_GONE}`, `bs:0:${BIZ_GONE}`, `bS:0:${BIZ_GONE}`, `br:0:${BIZ_GONE}`, `bv:0:${BIZ_GONE}`,
      `bq:0:0:${BIZ_GONE}`, `bo:0:0:${packed(BIZ_GONE, leadIds[0])}`, `bt:0:${BIZ_GONE}`, `pb:${BIZ_GONE}`,
      `bw:0:${BIZ_GONE}`, `bW:0:${BIZ_GONE}`, `bu:0:${BIZ_GONE}`]) {
      const x = await run(cb(OP, data));
      if (!same(x.answers, [C.OPERATOR_BUSINESS_GONE]) || x.sends.length || x.mail.length || x.edits.length !== 1
        || x.edits[0].body.text !== listText(PAGE0) || writes(x.sb).length) bad.push(data.slice(0, 2));
    }
    // From the /invite list (or the old /code picker) the current /invite list.
    for (const data of [`bi:0:${BIZ_GONE}`, `pc:${BIZ_GONE}`, `bp:0:${BIZ_GONE}`, `bP:0:${BIZ_GONE}`, `bc:0:${BIZ_GONE}`]) {
      const x = await run(cb(OP, data));
      if (!same(x.answers, [C.OPERATOR_BUSINESS_GONE]) || x.sends.length || x.edits.length !== 1
        || !textOf(x.edits[0]).startsWith('Invite: pick a business\n\n1. Alder Roofing · Demo') || writes(x.sb).length) bad.push(data.slice(0, 2));
    }
    // A lead that is gone, under a real business: a toast and its list.
    const goneLead = await run(cb(OP, `bo:0:0:${packed(BIZ_A, uuid(999999))}`));
    const goneOk = same(goneLead.answers, ['That lead is no longer here.']) && goneLead.edits.length === 1
      && textOf(goneLead.edits[0]).startsWith('Alder Roofing\nLeads\n\n1. Repair · New · 2d ago');
    // Not one of the anchored patterns: not a callback of this bot at all.
    const malformed = [];
    for (const data of ['bd:0:not-a-uuid', `bS:0:${BIZ_A}x`, `bS:${BIZ_A}`, 'bl:1000', 'bl:-1', 'bn:1000', 'bn:', `bq:100:0:${BIZ_A}`, 'bo:0:0:short',
      `bo:0:0:${packed(BIZ_A, leadIds[0])}=`, `bS:0:${BIZ_A}\n`, `bX:0:${BIZ_A}`, `BS:0:${BIZ_A}`, `br:0:${BIZ_A} `, `bi:${BIZ_A}`, `bv:0:0:${BIZ_A}`, `bs:0:${BIZ_A.toUpperCase()}`,
      `bP:${BIZ_A}`, `bP:0:${BIZ_A}x`, `bW:0:${BIZ_A}\n`, `bp:1000:${BIZ_A}`, `Bp:0:${BIZ_A}`, `bP:0:0:${BIZ_A}`, `bW:0:${BIZ_A.toUpperCase()}`]) {
      const x = await run(cb(OP, data));
      if (!same(x.answers, [C.TOAST_NOT_FOUND]) || x.sends.length || x.edits.length || x.mail.length || writes(x.sb).length) malformed.push(JSON.stringify(data.slice(0, 8)));
    }
    // Buttons of messages sent before this version. Terminate and its confirm
    // end nothing now; the old pickers remove nothing. Each says the screen
    // expired and shows the current one.
    const row = uuid(2);
    const retired = [];
    for (const data of [`bt:0:${BIZ_A}`, `bT:0:${BIZ_A}`, `pb:${BIZ_A}`]) {
      const x = seen(await run(cb(OP, data)));
      if (!same(x.answers, [EXPIRED]) || x.sends.length || x.mail.length || writes(x.sb).length || x.edits.length !== 1
        || x.edits[0].body.text !== DETAIL_A || !same(kbOf(x.edits[0]), detailKb(BIZ_A, 0))) retired.push(data.slice(0, 2));
    }
    for (const kind of ['p', 'P', 'q']) {
      const x = await run(cb(OP, `${kind}:${row}`));
      if (!same(x.answers, [EXPIRED]) || x.sends.length || x.edits.length !== 1
        || x.edits[0].body.text !== listText(PAGE0) || writes(x.sb).length) retired.push(kind);
    }
    const expiredOk = C.OPERATOR_SCREEN_EXPIRED === EXPIRED;
    line(bad.length === 0 && goneOk && malformed.length === 0 && retired.length === 0 && expiredOk && snapshot() === before
      && store.chats.length === 4 && liveCodes(BIZ_A).length === 1,
      'OB11', 'unknown: toast and list; malformed: not found; retired: expired',
      `unknown=${bad.join(',') || 'ok'} lead=${goneOk} malformed=${malformed.join(',') || 'ok'} retired=${retired.join(',') || 'ok'} unchanged=${snapshot() === before}`);
  }

  /* OB12: only the operator chat, checked on every tap. */
  {
    const before = snapshot();
    const row = uuid(2);
    const taps = ['bl:0', 'bn:0', `bd:0:${BIZ_A}`, `bs:0:${BIZ_A}`, `bS:0:${BIZ_A}`, `br:0:${BIZ_P}`, `bv:0:${BIZ_A}`, `bi:0:${BIZ_A}`,
      `bq:0:0:${BIZ_A}`, `bo:0:0:${packed(BIZ_A, leadIds[0])}`, `bS:0:${BIZ_B}`, `bi:0:${BIZ_B}`, `bo:0:0:${packed(BIZ_B, leadIds[0])}`,
      `bt:0:${BIZ_A}`, `bT:0:${BIZ_A}`, `pb:${BIZ_A}`, `pc:${BIZ_A}`, `pc:${BIZ_B}`, `p:${row}`, `P:${row}`, `q:${row}`,
      // Replace phone: the question, the confirm and Cancel, from both origins,
      // for the chat's own business and for another one.
      `bp:0:${BIZ_A}`, `bP:0:${BIZ_A}`, `bc:0:${BIZ_A}`, `bw:0:${BIZ_A}`, `bW:0:${BIZ_A}`, `bu:0:${BIZ_A}`, `bP:0:${BIZ_B}`, `bW:0:${BIZ_B}`,
      `bi:0:${biz(4)}`, `bv:0:${biz(4)}`];
    const leaks = [];
    for (const chat of [OWNER, STAFF, CHAT_B, CHAT_X]) {
      for (const data of taps) {
        const x = await run(cb(chat, data));
        // One database request: the chat's own binding. Nothing else is read.
        const onlyBinding = x.sb.length === 1 && x.sb[0].table === 'business_chats' && param(x.sb[0], 'tg_chat_id') === `eq.${chat}`;
        if (!same(x.answers, [C.TOAST_NOT_FOUND]) || x.sends.length || x.edits.length || x.mail.length || !onlyBinding) leaks.push(`${chat}:${data.slice(0, 2)}`);
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
    const typedInvite = await run(msg(OP, '/invite alder-demo'));
    process.env.OPERATOR_CHAT_ID = String(OP);
    // Typed by a business chat or a stranger, the commands are not commands;
    // /invite in a business chat is the owner's own invite, never the list.
    const ownerTyped = await run(msg(OWNER, '/businesses'));
    const ownerSlug = await run(msg(OWNER, '/invite beta'));
    const strangerTyped = await run(msg(CHAT_X, '/businesses'));
    const typedOk = typed.sends.length === 1 && typed.sends[0].body.text === C.BOT_NOT_CONNECTED
      && typedInvite.sends.length === 1 && typedInvite.sends[0].body.text === C.BOT_NOT_CONNECTED
      && ownerTyped.sends.length === 1 && ownerTyped.sends[0].body.text === C.BOT_PLAIN_TEXT
      && strangerTyped.sends.length === 1 && strangerTyped.sends[0].body.text === C.BOT_NOT_CONNECTED
      && [typed, typedInvite, ownerTyped, ownerSlug, strangerTyped].every((x) => !x.sb.some((q) => q.table === 'businesses'))
      && !ownerSlug.sends.some((m) => /Invite: pick a business|Beta Roofing/.test(textOf(m)))
      && store.codes.every((c) => c.business_id === BIZ_A);
    store.codes = store.codes.filter((c) => c.code === 'KEEPKEEPKEEP');
    store.claims = new Map();
    line(leaks.length === 0 && demoted.length === 0 && typedOk && snapshot() === before,
      'OB12', 'non-operator chats never reach the operator callbacks',
      `taps=${taps.length * 4} leaks=${leaks.slice(0, 3).join(',') || 'none'} demoted=${demoted.join(',') || 'none'} typed=${typedOk} unchanged=${snapshot() === before}`);
  }

  /* OB13: /invite. The list, its pages, the old ways in. */
  store = freshStore();
  leadIds = seedSeven();
  {
    const INVITE0 = 'Invite: pick a business\n\n1. Alder Roofing · Demo\n2. Beta Roofing · Active\n3. Cedar Co · Active\n4. Delta Roofs · Active\n5. Echo Roofing · Active';
    const INVITE1 = 'Invite: pick a business\n\n1. Fir & Sons · Active\n2. Gable Works (gable-one) · Demo\n3. Gable Works (gable-two) · Active\n4. Hail Pros · Active\n5. Iron Roofing · Active';
    const r = seen(await run(msg(OP, '/invite')));
    const list = r.sends[0] || { body: {} };
    const kb = kbOf(list);
    const read = r.sb.filter((q) => q.table === 'businesses');
    // Served businesses only, one query, and no phone count: whether a
    // business is connected is read when it is picked, not for the list.
    const listOk = r.tg.length === 1 && r.sends.length === 1 && list.body.text === INVITE0
      && kb.length === 2 && numbersOk(kb[0], 5) && PAGE0_IDS.every((id, i) => kb[0][i].callback_data === `bi:0:${id}`)
      && same(kb[1], [{ text: 'Older', callback_data: 'bn:1' }])
      && r.sb.length === 2 && read.length === 1 && /^in\.\("?demo"?,"?active"?\)$/.test(String(param(read[0], 'status')))
      && param(read[0], 'order') === 'name.asc,id.asc' && param(read[0], 'limit') === '6' && writes(r.sb).length === 0;
    // The keyboard's Invite, and the "Code" label of the keyboard before it.
    const ways = [];
    for (const text of ['Invite', 'Code', '/invite@alder_test_bot']) {
      const w = await run(msg(OP, text));
      if (w.sends.length !== 1 || w.sends[0].body.text !== INVITE0 || !same(kbOf(w.sends[0]), kb) || writes(w.sb).length) ways.push(text);
    }
    const keyboardOk = same(C.OPERATOR_KEYBOARD_LABELS, ['Invite', 'Businesses']) && same(C.persistentKeyboard(C.OPERATOR_KEYBOARD_LABELS), OPERATOR_KB);
    const p1 = await run(cb(OP, 'bn:1'));
    const kb1 = kbOf(p1.edits[0]);
    // Ten served businesses: the second page is the last. Newer alone.
    const pageOk = p1.sends.length === 0 && p1.edits.length === 1 && p1.edits[0].body.message_id === 9 && p1.edits[0].body.text === INVITE1
      && kb1.length === 2 && numbersOk(kb1[0], 5) && PAGE1_IDS.every((id, i) => kb1[0][i].callback_data === `bi:1:${id}`)
      && same(kb1[1], [{ text: 'Newer', callback_data: 'bn:0' }]);
    const gone = await run(cb(OP, 'bn:7'));
    const goneOk = same(gone.answers, [C.OPERATOR_PAGE_GONE]) && gone.edits.length === 1 && gone.edits[0].body.text === INVITE0;
    store.businesses = store.businesses.filter((b) => ['paused', 'churned'].includes(b.status));
    const none = await run(msg(OP, '/invite'));
    const noneOk = none.sends.length === 1 && none.sends[0].body.text === 'No business to invite.' && kbOf(none.sends[0]).length === 0;
    store.businesses = freshStore().businesses;

    // "/invite <slug>" names a business by its slug: an unknown or malformed
    // one gets one line and nothing is read beyond the lookup or written.
    const unknown = await run(msg(OP, '/invite no-such-business'));
    const usage = await run(msg(OP, '/invite Not_A_Slug'));
    const wordsOk = unknown.sends.length === 1 && textOf(unknown.sends[0]) === 'No business with that slug. Send /businesses to see the list.'
      && usage.sends.length === 1 && textOf(usage.sends[0]) === 'Usage: /invite [slug]'
      && writes(unknown.sb).length === 0 && writes(usage.sb).length === 0 && store.claims.size === 0;
    line(listOk && ways.length === 0 && keyboardOk && pageOk && goneOk && noneOk && wordsOk && store.codes.length === 0,
      'OB13', '/invite: the list, its pages, the old Code label',
      `list=${listOk} ways=${ways.join(',') || 'ok'} kb=${keyboardOk} page=${pageOk}/${goneOk}/${noneOk} slug=${wordsOk}`);
  }

  /* ----- the invite rules (OB18-OB23) -----
     The same rules for a number in the /invite list (bi), the Invite button
     under a business (bv), "/invite <slug>" and the old /code picker (pc). */
  const GUIDE = (slug, code, note = '') => `Code for ${slug}: ${code}\n\nExpires in 24 hours.${note} The next message is for the client — forward it as it is.`;
  const CLIENT = (code) => `Tap here to connect your lead alerts on Telegram, then press Start.\n\nIt works once and expires in 24 hours. If the link does not open the bot, open the bot and send it the code below:\n\n${code}`;
  const LINK_WORDS = 'connect your lead alerts';
  const listBack = (page) => [[{ text: 'Back', callback_data: `bn:${page}` }]];
  /** The guidance message, exactly: text, ONE code entity on the code, Back. */
  const guideOk = (req, { slug, code, back, note = '' }) => !!req && textOf(req) === GUIDE(slug, code, note)
    && same(req.body.entities, [{ type: 'code', offset: `Code for ${slug}: `.length, length: code.length }])
    && req.body.text.substr(req.body.entities[0].offset, req.body.entities[0].length) === code
    && same(kbOf(req), back) && !('parse_mode' in req.body) && String(req.body.chat_id) === String(OP);
  /** The client message, exactly: a text_link on the three words, a code
   *  entity on the code, no visible URL, no button, and nothing of the operator's. */
  const clientOk = (req, { code, names = [] }) => {
    if (!req) return false;
    const text = textOf(req);
    const ents = req.body.entities || [];
    return text === CLIENT(code)
      && same(ents, [
        { type: 'text_link', offset: text.indexOf(LINK_WORDS), length: LINK_WORDS.length, url: `https://t.me/alder_test_bot?start=${code}` },
        { type: 'code', offset: text.length - code.length, length: code.length },
      ])
      && text.substr(ents[0].offset, ents[0].length) === LINK_WORDS && text.substr(ents[1].offset, ents[1].length) === code
      && text.split(code).length === 2
      && !/https?:|t\.me|www\./i.test(text)
      && !/Code for|forward|operator|removed|cancelled|next message|slug|\/invite|\/businesses/i.test(text)
      && names.every((n) => !text.includes(n))
      && !('parse_mode' in req.body) && !('reply_markup' in req.body) && String(req.body.chat_id) === String(OP);
  };
  /** Telegram requests in the order they were started, as "method" strings. */
  const tgOrder = (r) => r.trace.filter((t) => t.kind === 'tg' && t.phase === 'start').map((t) => t.method);
  const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/;
  const CONNECTED = (name, n) => `${name} · Already connected · ${n} phone${n === 1 ? '' : 's'}`;
  const connectedKb = (id, page, from) => [[
    { text: 'Replace phone', callback_data: `${from === 'business' ? 'bw' : 'bp'}:${page}:${id}`, style: 'danger' },
    { text: 'Back', callback_data: from === 'business' ? `bd:${page}:${id}` : `bn:${page}` },
  ]];
  const REPLACE_ASK_2 = 'Replace the phones of Alder Roofing? The 2 current phones stop receiving alerts and lose access immediately, and a new invite is created. Alerts on Telegram stay off until the new phone connects; new leads are still saved and emailed.';
  const REPLACE_ASK_1 = 'Replace the phone of Beta Roofing? The 1 current phone stops receiving alerts and loses access immediately, and a new invite is created. Alerts on Telegram stay off until the new phone connects; new leads are still saved and emailed.';
  const replaceKb = (id, page, from) => [[
    { text: 'Confirm replace', callback_data: `${from === 'business' ? 'bW' : 'bP'}:${page}:${id}`, style: 'danger' },
    { text: 'Cancel', callback_data: `${from === 'business' ? 'bu' : 'bc'}:${page}:${id}` },
  ]];
  const ENDED = 'Your access to lead alerts for this business was ended by support.';
  const noWrite = (r) => r.sb.every((q) => ['GET', 'HEAD'].includes(q.method));
  const INVITE_LIST_0 = 'Invite: pick a business\n\n1. Alder Roofing · Demo\n2. Beta Roofing · Active\n3. Cedar Co · Active\n4. Delta Roofs · Active\n5. Echo Roofing · Active';

  /* OB18: a business with no phone. One invite, shown as two messages. */
  store = freshStore();
  leadIds = seedSeven();
  {
    const FIR = biz(9);
    // From the list: the browser message becomes the guidance, and the client
    // message is a NEW message sent after it.
    const tap = seen(await run(cb(OP, `bi:1:${FIR}`)));
    const first = store.codes[0] || {};
    const hours = (new Date(first.expires_at).getTime() - Date.now()) / 3600000;
    const order = tgOrder(tap);
    const listOk = tap.edits.length === 1 && tap.sends.length === 1 && tap.tg.length === 3 && same(tap.answers, [''])
      && tap.edits[0].body.message_id === 9
      && store.codes.length === 1 && first.business_id === FIR && !first.used_at && CODE_RE.test(String(first.code)) && hours > 23.9 && hours <= 24
      && guideOk(tap.edits[0], { slug: 'fir', code: first.code, back: listBack(1) })
      && clientOk(tap.sends[0], { code: first.code, names: ['Fir', 'fir'] })
      && order.indexOf('editMessageText') < order.indexOf('sendMessage') && order[order.length - 1] === 'sendMessage'
      && store.claims.get('opcode:fir') === 1;
    // Back is the page of the list the tap came from.
    const backTap = await run(cb(OP, 'bn:1'));
    const backOk = backTap.edits.length === 1 && textOf(backTap.edits[0]).startsWith('Invite: pick a business\n\n1. Fir & Sons · Active') && noWrite(backTap);
    // From the business screen: a new code, the older unused one is cancelled
    // and said so, and Back is the business.
    const fromBusiness = seen(await run(cb(OP, `bv:1:${FIR}`)));
    const live = liveCodes(FIR);
    const second = live[0] || {};
    const again = fromBusiness.edits.length === 1 && fromBusiness.sends.length === 1 && store.codes.length === 2 && live.length === 1
      && second.code !== first.code
      && guideOk(fromBusiness.edits[0], { slug: 'fir', code: second.code, back: backKb(FIR, 1), note: ' 1 older invite was cancelled.' })
      && clientOk(fromBusiness.sends[0], { code: second.code, names: ['Fir', 'fir'] });
    const backBusiness = await run(cb(OP, `bd:1:${FIR}`));
    const backBusinessOk = backBusiness.edits.length === 1 && backBusiness.edits[0].body.text === DETAIL_FIR;
    // The cancelled code connects nobody; the new one connects a phone, and
    // that phone is the main phone (the owner's keyboard).
    const stale = await run(msg(CHAT_X, '/start ' + first.code));
    const staleOk = stale.sends.length === 1 && textOf(stale.sends[0]) === C.BOT_BAD_CODE && !store.chats.some((c) => String(c.tg_chat_id) === String(CHAT_X));
    const redeem = await run(msg(CHAT_X, '/start ' + second.code));
    const redeemOk = store.chats.filter((c) => c.business_id === FIR).length === 1
      && String(store.chats.find((c) => c.business_id === FIR).tg_chat_id) === String(CHAT_X)
      && redeem.sends.length === 1 && same(redeem.sends[0].body.reply_markup, OWNER_KB) && liveCodes(FIR).length === 0;
    // Typed: the same two messages, both new, Back to the first list page.
    const typed = seen(await run(msg(OP, '/invite cedar')));
    const cedar = liveCodes(biz(4))[0] || {};
    const typedOk = typed.sends.length === 2 && typed.edits.length === 0 && typed.tg.length === 2
      && store.codes.filter((c) => c.business_id === biz(4)).length === 1
      && guideOk(typed.sends[0], { slug: 'cedar', code: cedar.code, back: listBack(0) })
      && clientOk(typed.sends[1], { code: cedar.code, names: ['Cedar', 'cedar'] });
    // A button of the old /code picker: a pick from the first list page.
    const pc = await run(cb(OP, `pc:${biz(5)}`));
    const delta = liveCodes(biz(5))[0] || {};
    const pcOk = pc.edits.length === 1 && pc.sends.length === 1
      && guideOk(pc.edits[0], { slug: 'delta', code: delta.code, back: listBack(0) }) && clientOk(pc.sends[0], { code: delta.code, names: ['Delta', 'delta'] });

    // The client message cannot be sent: the guidance says so and repeats the code.
    const RESEND = (code) => `The forward text did not send. The code is ${code} and it expires in 24 hours. Send it to the client yourself.`;
    await tgCtl({ mode: 'ok', failChat: null });
    tgHook = ({ method }) => (method === 'sendMessage' ? tgRefuse() : null);
    const lost = seen(await run(cb(OP, `bi:1:${biz(11)}`)));
    tgHook = null;
    const hail = liveCodes(biz(11))[0] || {};
    const lostOk = lost.edits.length === 2 && lost.sends.length === 0 && !!hail.code
      && guideOk(lost.edits[0], { slug: 'hail', code: hail.code, back: listBack(1) })
      && textOf(lost.edits[1]) === RESEND(hail.code)
      && same(lost.edits[1].body.entities, [{ type: 'code', offset: RESEND(hail.code).indexOf(hail.code), length: 12 }])
      && same(kbOf(lost.edits[1]), listBack(1)) && lost.edits[1].body.message_id === 9;
    // The edit does not land: the guidance is sent as a new message instead,
    // before the client message, so the operator is never left without the code.
    tgHook = ({ method }) => (method === 'editMessageText' ? tgRefuse() : null);
    const noEdit = await run(cb(OP, `bi:1:${biz(12)}`));
    tgHook = null;
    const iron = liveCodes(biz(12))[0] || {};
    const noEditOk = noEdit.sends.length === 2 && guideOk(noEdit.sends[0], { slug: 'iron', code: iron.code, back: listBack(1) })
      && clientOk(noEdit.sends[1], { code: iron.code, names: ['Iron', 'iron'] });

    // Ten an hour for one business, by any way in; then nothing is created
    // and the screen says so. The same when the counter, the insert, or the
    // expiry of the older codes fails: no usable new code is left behind.
    const ECHO = biz(6);
    const count = (id) => store.codes.filter((c) => c.business_id === id).length;
    for (let i = 0; i < 10; i++) await run(cb(OP, `bi:0:${ECHO}`));
    const atCap = count(ECHO);
    const CAPPED = 'Too many invites for that business in the last hour. Wait, then try again.';
    const over = await run(cb(OP, `bi:0:${ECHO}`));
    const overTyped = await run(msg(OP, '/invite echo'));
    const capOk = atCap === 10 && count(ECHO) === 10 && liveCodes(ECHO).length === 1
      && over.edits.length === 1 && over.sends.length === 0 && textOf(over.edits[0]) === CAPPED && same(kbOf(over.edits[0]), listBack(0))
      && overTyped.sends.length === 1 && textOf(overTyped.sends[0]) === CAPPED && same(kbOf(overTyped.sends[0]), listBack(0))
      && store.claims.get('opcode:echo') === 12;
    const GABLE = biz(8);
    const FAILED = 'Could not create an invite for Gable Works. Try again.';
    seedCode(GABLE, 'KEEPKEEPKEEP');
    const failures = [];
    for (const [name, hook] of [
      ['counter', ({ table }) => (table === 'rpc/hit_rate_limit' ? fail500() : null)],
      ['insert', ({ table, method }) => (table === 'bind_codes' && method === 'POST' ? fail500() : null)],
      ['expiry', ({ table, method, params }) => (table === 'bind_codes' && method === 'PATCH' && String(param({ params }, 'code')).startsWith('neq.') ? fail500() : null)],
    ]) {
      sbHook = hook;
      const x = await run(cb(OP, `bv:1:${GABLE}`));
      sbHook = null;
      const liveNow = liveCodes(GABLE).map((c) => c.code);
      if (x.edits.length !== 1 || x.sends.length !== 0 || textOf(x.edits[0]) !== FAILED || !same(kbOf(x.edits[0]), backKb(GABLE, 1))
        || !same(liveNow, ['KEEPKEEPKEEP'])) failures.push(name);
    }
    // The phone count cannot be read: nothing is created on a guess.
    sbHook = ({ table, method }) => (table === 'business_chats' && method === 'HEAD' ? fail500() : null);
    const blind = await run(cb(OP, `bi:0:${GABLE}`));
    const blindTyped = await run(msg(OP, '/invite gable-two'));
    sbHook = null;
    const blindOk = same(blind.answers, [C.TOAST_GENERIC_ERROR]) && blind.edits.length === 0 && blind.sends.length === 0
      && blindTyped.sends.length === 1 && textOf(blindTyped.sends[0]) === C.TOAST_GENERIC_ERROR
      && same(liveCodes(GABLE).map((c) => c.code), ['KEEPKEEPKEEP']);
    // Nothing but invites and one new binding was written.
    const fresh = freshStore();
    const onlyCodes = JSON.stringify(store.businesses) === JSON.stringify(fresh.businesses) && store.leads.length === 8
      && JSON.stringify(store.chats.filter((c) => String(c.tg_chat_id) !== String(CHAT_X))) === JSON.stringify(fresh.chats);
    line(listOk && backOk && again && backBusinessOk && staleOk && redeemOk && typedOk && pcOk && lostOk && noEditOk && capOk
      && failures.length === 0 && blindOk && onlyCodes,
      'OB18', 'no phone: one invite, guidance + client message, entities',
      `list=${listOk} back=${backOk}/${backBusinessOk} again=${again} old=${staleOk} redeem=${redeemOk} typed=${typedOk} pc=${pcOk} lost=${lostOk} noedit=${noEditOk} cap=${capOk} fail=${failures.join(',') || 'ok'} blind=${blindOk} only=${onlyCodes}`);
  }

  /* OB19: a business with a phone. Nothing is created and nothing is written. */
  store = freshStore();
  leadIds = seedSeven();
  seedCode(BIZ_A, 'KEEPKEEPKEEP');
  {
    const before = snapshot();
    const bad = [];
    const check = (name, r, req, kb) => {
      if (!req || textOf(req) !== CONNECTED('Alder Roofing', 2) || !same(kbOf(req), kb) || 'entities' in req.body || 'parse_mode' in req.body
        || !noWrite(r) || r.sb.some((q) => q.table === 'bind_codes' || q.table.startsWith('rpc/')) || r.tg.length !== (r.edits.length ? 2 : 1)) bad.push(name);
    };
    const fromList = seen(await run(cb(OP, `bi:0:${BIZ_A}`)));
    check('bi', fromList, fromList.edits[0], connectedKb(BIZ_A, 0, 'list'));
    const fromBusiness = seen(await run(cb(OP, `bv:3:${BIZ_A}`)));
    check('bv', fromBusiness, fromBusiness.edits[0], connectedKb(BIZ_A, 3, 'business'));
    const fromPicker = await run(cb(OP, `pc:${BIZ_A}`));
    check('pc', fromPicker, fromPicker.edits[0], connectedKb(BIZ_A, 0, 'list'));
    const typed = seen(await run(msg(OP, '/invite alder-demo')));
    check('typed', typed, typed.sends[0], connectedKb(BIZ_A, 0, 'list'));
    const shapeOk = [fromList, fromBusiness, fromPicker].every((x) => x.edits.length === 1 && x.sends.length === 0 && same(x.answers, ['']) && x.edits[0].body.message_id === 9)
      && typed.sends.length === 1 && typed.edits.length === 0;
    // One phone: the singular.
    const beta = await run(cb(OP, `bi:0:${BIZ_B}`));
    const betaOk = beta.edits.length === 1 && textOf(beta.edits[0]) === 'Beta Roofing · Already connected · 1 phone' && noWrite(beta);
    // Back: the list page, or the business.
    const backList = await run(cb(OP, 'bn:0'));
    const backBusiness = await run(cb(OP, `bd:3:${BIZ_A}`));
    const backOk = textOf(backList.edits[0]) === INVITE_LIST_0 && backBusiness.edits[0].body.text === DETAIL_A && same(kbOf(backBusiness.edits[0]), detailKb(BIZ_A, 3));
    line(bad.length === 0 && shapeOk && betaOk && backOk && snapshot() === before && store.claims.size === 0 && store.codes.length === 1,
      'OB19', 'connected: "Already connected", no invite, nothing written',
      `bad=${bad.join(',') || 'none'} shape=${shapeOk} one=${betaOk} back=${backOk} unchanged=${snapshot() === before} counters=${store.claims.size} codes=${store.codes.length}`);
  }

  /* OB20: Replace phone asks first; Cancel goes back and never creates. */
  {
    const before = snapshot();
    const ask = seen(await run(cb(OP, `bp:0:${BIZ_A}`)));
    const askBusiness = seen(await run(cb(OP, `bw:2:${BIZ_B}`)));
    const askOk = ask.edits.length === 1 && ask.sends.length === 0 && same(ask.answers, ['']) && ask.edits[0].body.text === REPLACE_ASK_2
      && same(kbOf(ask.edits[0]), replaceKb(BIZ_A, 0, 'list'))
      && askBusiness.edits.length === 1 && askBusiness.edits[0].body.text === REPLACE_ASK_1 && same(kbOf(askBusiness.edits[0]), replaceKb(BIZ_B, 2, 'business'))
      && noWrite(ask) && noWrite(askBusiness) && C.operatorReplaceConfirmText({ business: { name: 'Alder Roofing' }, phones: 2 }) === REPLACE_ASK_2;
    const cancel = await run(cb(OP, `bc:0:${BIZ_A}`));
    const cancelBusiness = await run(cb(OP, `bu:2:${BIZ_B}`));
    const cancelOk = cancel.edits.length === 1 && cancel.sends.length === 0 && textOf(cancel.edits[0]) === CONNECTED('Alder Roofing', 2)
      && same(kbOf(cancel.edits[0]), connectedKb(BIZ_A, 0, 'list'))
      && textOf(cancelBusiness.edits[0]) === CONNECTED('Beta Roofing', 1) && same(kbOf(cancelBusiness.edits[0]), connectedKb(BIZ_B, 2, 'business'))
      && noWrite(cancel) && noWrite(cancelBusiness);
    // With no phone left there is nothing to replace: the question and Cancel
    // show the screen they were opened from, and NEVER create an invite.
    const FIR = biz(9);
    const none = [];
    for (const [data, wantText] of [[`bp:1:${FIR}`, null], [`bc:1:${FIR}`, null], [`bw:1:${FIR}`, DETAIL_FIR], [`bu:1:${FIR}`, DETAIL_FIR]]) {
      const x = await run(cb(OP, data));
      const text = textOf(x.edits[0]);
      if (!same(x.answers, ['No phone is connected now.']) || x.sends.length || x.edits.length !== 1 || !noWrite(x)
        || (wantText ? text !== wantText : !text.startsWith('Invite: pick a business\n\n1. Fir & Sons · Active'))) none.push(data.slice(0, 2));
    }
    line(askOk && cancelOk && none.length === 0 && snapshot() === before && store.claims.size === 0,
      'OB20', 'Replace phone asks first; Cancel returns, creates nothing',
      `ask=${askOk} cancel=${cancelOk} nophone=${none.join(',') || 'ok'} unchanged=${snapshot() === before}`);
  }

  /* OB21: Confirm replace. The new invite first, then the other invites, then
     every binding of THAT business in one statement, then the notices, then
     the two messages. */
  store = freshStore();
  leadIds = seedSeven();
  seedCode(BIZ_A, 'PASTPASTPAST');
  seedCode(BIZ_B, 'BETABETABETA');
  store.codes.push({ code: 'USEDUSEDUSED', business_id: BIZ_A, used_at: '2026-11-01T10:00:00Z', expires_at: '2026-11-02T10:00:00Z' });
  {
    const others = () => JSON.stringify({
      b: store.businesses, l: store.leads, e: store.events,
      c: store.chats.filter((c) => c.business_id !== BIZ_A), k: store.codes.filter((c) => c.business_id !== BIZ_A || c.used_at),
    });
    const othersBefore = others();
    const r = seen(await run(cb(OP, `bP:0:${BIZ_A}`)));
    const fresh = liveCodes(BIZ_A)[0] || {};
    // The order things happened in.
    const at = (pred) => r.trace.findIndex(pred);
    const lastAt = (pred) => r.trace.map((t, i) => (pred(t) ? i : -1)).filter((i) => i >= 0).pop();
    const mintAt = at((t) => t.kind === 'sb' && t.table === 'bind_codes' && t.method === 'POST');
    const expireAt = at((t) => t.kind === 'sb' && t.table === 'bind_codes' && t.method === 'PATCH');
    const deleteAt = at((t) => t.kind === 'sb' && t.table === 'business_chats' && t.method === 'DELETE');
    const firstNotice = at((t) => t.kind === 'tg' && t.method === 'sendMessage' && t.chat !== String(OP) && t.phase === 'start');
    const lastNoticeEnd = lastAt((t) => t.kind === 'tg' && t.method === 'sendMessage' && t.chat !== String(OP) && t.phase === 'end');
    const editAt = at((t) => t.kind === 'tg' && t.method === 'editMessageText' && t.phase === 'start');
    const clientAt = at((t) => t.kind === 'tg' && t.method === 'sendMessage' && t.chat === String(OP) && t.phase === 'start');
    const orderOk = mintAt >= 0 && mintAt < expireAt && expireAt < deleteAt && deleteAt < firstNotice && lastNoticeEnd < editAt && editAt < clientAt;
    // (a) one new invite; (b) the other pending invite of this business is
    // expired, a used code and another business's invite are not touched.
    const past = store.codes.find((c) => c.code === 'PASTPASTPAST');
    const used = store.codes.find((c) => c.code === 'USEDUSEDUSED');
    const expire = r.sb.filter((q) => q.table === 'bind_codes' && q.method === 'PATCH');
    const inviteOk = liveCodes(BIZ_A).length === 1 && CODE_RE.test(String(fresh.code)) && fresh.code !== 'PASTPASTPAST'
      && new Date(past.expires_at) <= new Date() && used.expires_at === '2026-11-02T10:00:00Z' && liveCodes(BIZ_B).length === 1
      && expire.length === 1 && param(expire[0], 'business_id') === `eq.${BIZ_A}` && param(expire[0], 'code') === `neq.${fresh.code}`
      && param(expire[0], 'used_at') === 'is.null'
      && store.claims.get('opcode:alder-demo') === 1;
    // (c) ONE delete, scoped by the business id and by nothing else.
    const deletes = r.sb.filter((q) => q.method === 'DELETE' && q.table === 'business_chats');
    const removeOk = deletes.length === 1 && param(deletes[0], 'business_id') === `eq.${BIZ_A}`
      && same(deletes[0].params.map(([k]) => k).filter((k) => k !== 'select').sort(), ['business_id'])
      && !store.chats.some((c) => c.business_id === BIZ_A) && store.chats.length === 2
      && !r.sb.some((q) => q.table === 'businesses' && q.method !== 'GET')
      && others() === othersBefore && store.businesses.find((b) => b.id === BIZ_A).status === 'demo';
    // (d) one plain notice each, with the keyboard removed.
    const notices = r.sends.filter((m) => String(m.body.chat_id) !== String(OP));
    const noticeOk = notices.length === 2 && [OWNER, STAFF].every((chat) => notices.filter((m) => String(m.body.chat_id) === String(chat)).length === 1)
      && notices.every((m) => m.body.text === ENDED && same(m.body.reply_markup, REMOVED_KB) && !('parse_mode' in m.body) && !('entities' in m.body))
      && C.BOT_ACCESS_ENDED === ENDED && !/Alder|alder/.test(ENDED);
    // (e) the two messages; the guidance says what was done.
    const toOp = r.sends.filter((m) => String(m.body.chat_id) === String(OP));
    const outputOk = r.edits.length === 1 && toOp.length === 1 && same(r.answers, [''])
      && guideOk(r.edits[0], { slug: 'alder-demo', code: fresh.code, back: listBack(0), note: ' 2 phones removed. 1 older invite was cancelled.' })
      && clientOk(toOp[0], { code: fresh.code, names: ['Alder', 'alder'] });
    // The claim that keeps two confirms apart is taken and released.
    const lock = r.sb.filter((q) => q.table === 'rate_limits' && q.method === 'DELETE');
    const lockOk = lock.length === 1 && param(lock[0], 'key') === `eq.opreplace:${BIZ_A}` && !store.claims.has(`opreplace:${BIZ_A}`);

    // A second tap: nothing left to replace. One toast, and NOTHING else: the
    // message (which now shows the new invite) is not touched.
    const afterFirst = snapshot();
    const again = await run(cb(OP, `bP:0:${BIZ_A}`));
    const againOk = same(again.answers, ['Already replaced.']) && again.edits.length === 0 && again.sends.length === 0 && noWrite(again)
      && snapshot() === afterFirst && liveCodes(BIZ_A)[0].code === fresh.code && C.OPERATOR_ALREADY_REPLACED === 'Already replaced.';

    // The replaced phones: the normal "not connected" reply, a dead button,
    // and no way back in through the old invite.
    const exOwner = await run(msg(OWNER, '/leads'));
    const exStaff = await run(msg(STAFF, 'Leads'));
    const exTap = await run(cb(OWNER, `L:0:${leadIds[0]}`));
    await run(msg(STAFF, '/start PASTPASTPAST'));
    const exOk = [exOwner, exStaff].every((x) => x.sends.length === 1 && textOf(x.sends[0]) === C.BOT_NOT_CONNECTED && x.sb.length === 1
      && !x.sb.some((q) => q.table === 'v_client_leads'))
      && same(exTap.answers, [C.TOAST_NOT_FOUND]) && exTap.edits.length === 0
      && !store.chats.some((c) => [String(OWNER), String(STAFF)].includes(String(c.tg_chat_id)));
    // The first phone to redeem the new invite is the main phone.
    const redeem = await run(msg(CHAT_X, '/start ' + fresh.code));
    const newRows = store.chats.filter((c) => c.business_id === BIZ_A);
    const invite = await run(msg(CHAT_X, '/invite'));
    const redeemOk = newRows.length === 1 && String(newRows[0].tg_chat_id) === String(CHAT_X) && same(redeem.sends[0].body.reply_markup, OWNER_KB)
      && invite.sends.length >= 1 && !invite.sends.some((m) => textOf(m) === C.BOT_OWNER_ONLY) && liveCodes(BIZ_A).length === 1;

    // From the business screen, one phone: Back is the business.
    const one = await run(cb(OP, `bW:2:${BIZ_B}`));
    const betaCode = liveCodes(BIZ_B)[0] || {};
    const oneOk = one.edits.length === 1 && guideOk(one.edits[0], { slug: 'beta', code: betaCode.code, back: backKb(BIZ_B, 2), note: ' 1 phone removed. 1 older invite was cancelled.' })
      && betaCode.code !== 'BETABETABETA' && !store.chats.some((c) => c.business_id === BIZ_B)
      && one.sends.filter((m) => String(m.body.chat_id) === String(CHAT_B)).length === 1
      && store.chats.filter((c) => c.business_id === BIZ_A).length === 1 && store.chats.some((c) => c.business_id === BIZ_P);
    line(orderOk && inviteOk && removeOk && noticeOk && outputOk && lockOk && againOk && exOk && redeemOk && oneOk,
      'OB21', 'Confirm replace: invite first, one scoped delete, notices',
      `order=${orderOk} invite=${inviteOk} remove=${removeOk} notice=${noticeOk} output=${outputOk} lock=${lockOk} again=${againOk} old=${exOk} new=${redeemOk} business=${oneOk}`);
  }

  /* OB22: Confirm replace when something fails. No phone is removed unless
     the new invite exists; a failed notice blocks nothing. */
  {
    const NOT_REMOVED = ' No phone was removed.';
    const setup = () => { store = freshStore(); seedCode(BIZ_A, 'PASTPASTPAST'); };
    const intact = () => store.chats.filter((c) => c.business_id === BIZ_A).length === 2;
    const bad = [];
    const cases = [
      // [name, before, hook, text on screen, the live codes afterwards]
      ['cap', () => store.claims.set('opcode:alder-demo', 10), null,
        'Too many invites for that business in the last hour. Wait, then try again.' + NOT_REMOVED, ['PASTPASTPAST']],
      ['counter', null, ({ table, body }) => (table === 'rpc/hit_rate_limit' && String(body && body.p_key).startsWith('opcode:') ? fail500() : null),
        'Could not create an invite for Alder Roofing. Try again.' + NOT_REMOVED, ['PASTPASTPAST']],
      ['insert', null, ({ table, method }) => (table === 'bind_codes' && method === 'POST' ? fail500() : null),
        'Could not create an invite for Alder Roofing. Try again.' + NOT_REMOVED, ['PASTPASTPAST']],
      ['expiry', null, ({ table, method, params }) => (table === 'bind_codes' && method === 'PATCH' && String(param({ params }, 'code')).startsWith('neq.') ? fail500() : null),
        'Could not create an invite for Alder Roofing. Try again.' + NOT_REMOVED, ['PASTPASTPAST']],
      // The older invite is already expired by then; the new one is taken back.
      ['delete', null, ({ table, method }) => (table === 'business_chats' && method === 'DELETE' ? fail500() : null),
        'Could not replace the phones of Alder Roofing. No phone was removed. Try again.', []],
    ];
    for (const [name, prepare, hook, text, liveAfter] of cases) {
      setup();
      if (prepare) prepare();
      sbHook = hook;
      const x = seen(await run(cb(OP, `bP:0:${BIZ_A}`)));
      sbHook = null;
      if (x.edits.length !== 1 || x.sends.length !== 0 || textOf(x.edits[0]) !== text || !same(kbOf(x.edits[0]), listBack(0)) || !intact()
        || !same(liveCodes(BIZ_A).map((c) => c.code), liveAfter) || store.claims.has(`opreplace:${BIZ_A}`)
        || store.businesses.find((b) => b.id === BIZ_A).status !== 'demo') bad.push(name);
    }
    // The claim or the phone count cannot be read: one toast, nothing at all.
    for (const [name, hook] of [
      ['claim', ({ table, body }) => (table === 'rpc/hit_rate_limit' && String(body && body.p_key).startsWith('opreplace:') ? fail500() : null)],
      ['count', ({ table, method }) => (table === 'business_chats' && method === 'HEAD' ? fail500() : null)],
    ]) {
      setup();
      const before = snapshot();
      sbHook = hook;
      const x = await run(cb(OP, `bP:0:${BIZ_A}`));
      sbHook = null;
      if (!same(x.answers, [C.TOAST_GENERIC_ERROR]) || x.edits.length || x.sends.length || snapshot() !== before) bad.push(name);
    }
    // Another confirm holds the claim: this tap changes nothing.
    setup();
    store.claims.set(`opreplace:${BIZ_A}`, 1);
    const held = snapshot();
    const second = await run(cb(OP, `bP:0:${BIZ_A}`));
    const heldOk = same(second.answers, ['Already replaced.']) && second.edits.length === 0 && second.sends.length === 0 && snapshot() === held
      && !second.sb.some((q) => q.table === 'bind_codes' || q.method === 'DELETE');
    // A phone that cannot be told: counted, and the replacement goes through.
    setup();
    await tgCtl({ mode: 'ok', failChat: String(STAFF) });
    const deaf = await run(cb(OP, `bP:0:${BIZ_A}`));
    await tgCtl({ mode: 'ok', failChat: null });
    const code = (liveCodes(BIZ_A)[0] || {}).code;
    const deafOk = !store.chats.some((c) => c.business_id === BIZ_A) && deaf.edits.length === 1
      && guideOk(deaf.edits[0], { slug: 'alder-demo', code, back: listBack(0), note: ' 2 phones removed (1 notice not delivered). 1 older invite was cancelled.' })
      && clientOk(deaf.sends.find((m) => String(m.body.chat_id) === String(OP)), { code, names: ['Alder'] });
    line(bad.length === 0 && heldOk && deafOk, 'OB22', 'replace failures: no invite, no removal; a notice never blocks',
      `bad=${bad.join(',') || 'none'} held=${heldOk} notice=${deafOk}`);
  }

  /* OB23: a suspended business. One short line and Back, on every way in and
     on every step; nothing is created, removed or written. */
  store = freshStore();
  {
    const before = snapshot();
    const LINE = 'Zz Paused is suspended. Reactivate it first.';
    const bad = [];
    for (const [data, back] of [
      [`bi:2:${BIZ_P}`, listBack(2)], [`pc:${BIZ_P}`, listBack(0)], [`bp:2:${BIZ_P}`, listBack(2)], [`bP:2:${BIZ_P}`, listBack(2)], [`bc:2:${BIZ_P}`, listBack(2)],
      [`bv:2:${BIZ_P}`, backKb(BIZ_P, 2)], [`bw:2:${BIZ_P}`, backKb(BIZ_P, 2)], [`bW:2:${BIZ_P}`, backKb(BIZ_P, 2)], [`bu:2:${BIZ_P}`, backKb(BIZ_P, 2)],
      [`bP:0:${BIZ_C}`, listBack(0)],
    ]) {
      const x = seen(await run(cb(OP, data)));
      const want = data.endsWith(BIZ_C) ? 'Juniper Roofing is suspended. Reactivate it first.' : LINE;
      if (!same(x.answers, ['']) || x.sends.length || x.edits.length !== 1 || textOf(x.edits[0]) !== want || !same(kbOf(x.edits[0]), back) || !noWrite(x)) bad.push(data.slice(0, 2));
    }
    const typed = seen(await run(msg(OP, '/invite zz-paused')));
    const typedOk = typed.sends.length === 1 && typed.edits.length === 0 && textOf(typed.sends[0]) === LINE && same(kbOf(typed.sends[0]), listBack(0)) && noWrite(typed);
    // Back from the business origin is the suspended business's own screen.
    const backTap = await run(cb(OP, `bd:2:${BIZ_P}`));
    const backOk = backTap.edits[0].body.text === DETAIL_P && same(kbOf(backTap.edits[0]), suspendedKb(BIZ_P, 2));
    line(bad.length === 0 && typedOk && backOk && snapshot() === before && store.codes.length === 0 && store.claims.size === 0
      && store.chats.some((c) => c.business_id === BIZ_P),
      'OB23', 'suspended: one line and Back, nothing created or removed',
      `bad=${bad.join(',') || 'none'} typed=${typedOk} back=${backOk} unchanged=${snapshot() === before}`);
  }

  /* OB14: the timing line and the call budget of every flow. The lists are
     literal on purpose: a new handler name or step label has to be added here
     by hand, which is the moment to ask what it carries. */
  store = freshStore();
  leadIds = seedSeven();
  {
    const STEPS = ['db.binding_lookup', 'db.business_page', 'db.chat_count_page', 'db.business_by_id', 'db.business_by_slug', 'db.chat_list',
      'db.lead_totals', 'db.lead_count_recent', 'db.operator_lead_page', 'db.operator_lead_by_id', 'db.business_status_update',
      'db.rate_limit', 'db.rate_limit_clear', 'db.chat_count', 'db.chat_remove_all', 'db.invite_mint', 'db.invite_expire_others',
      'db.invite_take_back', 'lookup.bot_username',
      'mail.suspension_notice', 'tg.send_message', 'tg.answer_callback', 'tg.edit_message_text'];
    const row = uuid(2);
    // [update, handler name, type, database calls, Telegram calls]
    const flows = [
      [msg(OP, '/businesses'), 'cmd.operator_businesses', 'message', 3, 1],
      [msg(OP, '/invite'), 'cmd.operator_invite', 'message', 2, 1],
      [msg(OP, 'Code'), 'cmd.operator_invite', 'message', 2, 1],
      [msg(OP, '/help'), 'cmd.operator_help', 'message', 1, 1],
      [msg(OP, '/phones alder-demo'), 'text.operator_fallback', 'message', 1, 1],
      [msg(OP, '/code'), 'text.operator_fallback', 'message', 1, 1],
      [cb(OP, 'bl:1'), 'cb.operator_business_page', 'callback', 3, 2],
      [cb(OP, 'bn:1'), 'cb.operator_invite_page', 'callback', 2, 2],
      // Binding, business, phones, the two lead aggregates.
      [cb(OP, `bd:0:${BIZ_A}`), 'cb.operator_business_open', 'callback', 5, 2],
      [cb(OP, `bq:0:0:${BIZ_A}`), 'cb.operator_leads_page', 'callback', 3, 2],
      [cb(OP, `bo:0:0:${packed(BIZ_A, leadIds[0])}`), 'cb.operator_lead_open', 'callback', 3, 2],
      // Connected: binding, business, the phone count. Nothing else.
      [cb(OP, `bi:0:${BIZ_A}`), 'cb.operator_invite_open', 'callback', 3, 2],
      [cb(OP, `bv:0:${BIZ_A}`), 'cb.operator_invite_business', 'callback', 3, 2],
      [cb(OP, `pc:${BIZ_B}`), 'cb.operator_pick_code', 'callback', 3, 2],
      [cb(OP, `bp:0:${BIZ_A}`), 'cb.operator_replace_ask', 'callback', 3, 2],
      [cb(OP, `bw:0:${BIZ_A}`), 'cb.operator_replace_ask', 'callback', 3, 2],
      [cb(OP, `bc:0:${BIZ_A}`), 'cb.operator_replace_cancel', 'callback', 3, 2],
      [cb(OP, `bu:0:${BIZ_A}`), 'cb.operator_replace_cancel', 'callback', 3, 2],
      [msg(OP, '/invite alder-demo'), 'cmd.operator_invite', 'message', 3, 1],
      // No phone: those three, the counter, the new invite, the older ones;
      // the toast, the guidance, the client message.
      [cb(OP, `bi:0:${biz(4)}`), 'cb.operator_invite_open', 'callback', 6, 3],
      [cb(OP, `bv:0:${biz(5)}`), 'cb.operator_invite_business', 'callback', 6, 3],
      [msg(OP, '/invite echo'), 'cmd.operator_invite', 'message', 6, 2],
      // Replace: those three, the claim, the counter, the new invite, the
      // older ones, the delete, the claim released; one notice, the toast,
      // the guidance, the client message.
      [cb(OP, `bP:0:${BIZ_B}`), 'cb.operator_replace', 'callback', 9, 4],
      [cb(OP, `bP:0:${BIZ_B}`), 'cb.operator_replace', 'callback', 3, 1],
      [cb(OWNER, `bP:0:${BIZ_A}`), 'cb.operator_replace', 'callback', 1, 1],
      [cb(OP, `bt:0:${BIZ_A}`), 'cb.operator_expired', 'callback', 5, 2],
      [cb(OP, `pb:${BIZ_A}`), 'cb.operator_expired', 'callback', 5, 2],
      [cb(OP, `P:${row}`), 'cb.operator_expired', 'callback', 3, 2],
      [cb(OP, `bs:0:${BIZ_A}`), 'cb.operator_suspend_ask', 'callback', 2, 2],
      // Binding, business, phones, one update; two notices, the toast, the edit.
      [cb(OP, `bS:0:${BIZ_A}`), 'cb.operator_suspend', 'callback', 4, 4],
      [cb(OP, `bS:0:${BIZ_A}`), 'cb.operator_suspend', 'callback', 3, 2],
      [msg(OWNER, '/leads'), 'cmd.suspended', 'message', 1, 1],
      [msg(OWNER, 'Invite'), 'cmd.suspended', 'message', 1, 1],
      [msg(OWNER, 'good morning'), 'text.suspended', 'message', 2, 1],
      [cb(OWNER, `L:0:${leadIds[0]}`), 'cb.suspended', 'callback', 1, 1],
      // Binding, business, phones, one update; two notices, the toast, the edit.
      [cb(OP, `br:0:${BIZ_A}`), 'cb.operator_reactivate', 'callback', 4, 4],
      [cb(OP, `br:0:${BIZ_A}`), 'cb.operator_reactivate', 'callback', 3, 2],
      [cb(OWNER, `bS:0:${BIZ_B}`), 'cb.operator_suspend', 'callback', 1, 1],
      // Replace, from the business screen: two phones, so two notices.
      [cb(OP, `bW:0:${BIZ_A}`), 'cb.operator_replace', 'callback', 9, 5],
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
      const forbidden = [String(OP), String(OWNER), String(STAFF), BIZ_A, BIZ_B, 'Alder', 'alder-demo', PII.name, PII.phone,
        'fixture.invalid', SECRET, ...leadIds, C.packUuid(BIZ_A), ...store.codes.map((c) => c.code), ...(cbq ? [cbq.id, cbq.data] : [update.message.text])];
      if (forbidden.some((x) => x && r.lines[0].includes(x))) problems.push(`${handlerName}: leaked`);
    }
    line(problems.length === 0, 'OB14', 'timing line and call budget of every operator flow',
      `flows=${flows.length} problems=${problems.slice(0, 4).join('; ') || 'none'}`);
    if (problems.length > 4) console.log('NOTE       ' + problems.slice(4).join('; '));
  }

  /* OB16: the owner's own rules did not move. A phone that is not the main
     phone cannot invite and cannot remove a phone. */
  store = freshStore();
  {
    const before = snapshot();
    const ownerRow = uuid(1);
    const staffRow = uuid(2);
    const typed = [];
    for (const text of ['/invite', 'Invite', '/recipients', 'Recipients']) {
      const x = await run(msg(STAFF, text));
      if (x.sends.length !== 1 || textOf(x.sends[0]) !== C.BOT_OWNER_ONLY || kbOf(x.sends[0]).length || writes(x.sb).length) typed.push(text);
    }
    const taps = [];
    for (const data of [`x:${ownerRow}`, `X:${ownerRow}`, `x:${staffRow}`, `X:${staffRow}`, `v:${ownerRow}`, 'i:c']) {
      const x = await run(cb(STAFF, data));
      const toast = x.answers.length === 1 && [C.TOAST_OWNER_ONLY, C.BOT_OWNER_ONLY].includes(x.answers[0]);
      if (!toast || x.sends.length || x.edits.length || writes(x.sb).length) taps.push(data.slice(0, 3));
    }
    const refusedOk = typed.length === 0 && taps.length === 0 && snapshot() === before && store.codes.length === 0;
    // The same taps by the main phone do work: the refusal above is the role.
    const invite = await run(msg(OWNER, '/invite'));
    const remove = await run(cb(OWNER, `X:${staffRow}`));
    const ownerOk = store.codes.length === 1 && store.codes[0].business_id === BIZ_A && invite.sends.length === 2
      && !store.chats.some((c) => c.id === staffRow) && store.chats.some((c) => c.id === ownerRow)
      && writes(remove.sb).some((q) => q.table === 'business_chats' && q.method === 'DELETE' && param(q, 'business_id') === `eq.${BIZ_A}`);
    line(refusedOk && ownerOk, 'OB16', 'a guest phone cannot invite or remove phones; the main phone can',
      `typed=${typed.join(',') || 'ok'} taps=${taps.join(',') || 'ok'} refused=${refusedOk} owner=${ownerOk}`);
  }

  /* OB17: a new lead's alert reaches every bound phone of its business. */
  store = freshStore();
  {
    const { sendTelegramAlert } = await import('../lib/notify.js');
    store.chats.push({ id: uuid(5), business_id: BIZ_A, tg_chat_id: CHAT_X, label: 'Office', created_at: '2026-11-05T10:00:00Z' });
    const leadId = seedLead(BIZ_A, { name: 'Fan Out' });
    const lead = store.leads.find((l) => l.id === leadId);
    const business = store.businesses.find((b) => b.id === BIZ_A);
    const bound = [OWNER, STAFF, CHAT_X].map(String).sort();
    const alert = async (extra = {}) => {
      await tgReset(); sbRequests = [];
      const result = await sendTelegramAlert({ leadId, business, lead, ...extra });
      const sent = of(await tgReqs(), 'sendMessage');
      return { result, sent, to: sent.map((m) => String(m.body.chat_id)).sort(), sb: sbRequests.slice() };
    };
    const all = await alert();
    const phones = all.sb.filter((q) => q.table === 'business_chats');
    const allOk = all.result.ok === true && same(all.to, bound) && all.sent.every((m) => textOf(m).includes('Fan Out'))
      && phones.length === 1 && param(phones[0], 'business_id') === `eq.${BIZ_A}`
      && !all.to.includes(String(CHAT_B)) && !all.to.includes(String(OP));
    // One phone fails: the others still got theirs once, and the retry goes
    // to the failed phone alone.
    await tgCtl({ mode: 'ok', failChat: String(STAFF) });
    const partial = await alert();
    await tgCtl({ mode: 'ok', failChat: null });
    const pending = (partial.result.pendingChats || []).map(String);
    const retry = await alert({ fallback: true, onlyChats: partial.result.pendingChats });
    const retryOk = partial.result.ok === false && same(partial.to, bound) && same(pending, [String(STAFF)])
      && retry.result.ok === true && same(retry.to, [String(STAFF)]);
    // No phone bound: nobody is sent the lead card.
    const none = await (async () => {
      await tgReset();
      const result = await sendTelegramAlert({ leadId, business: store.businesses.find((b) => b.id === biz(4)), lead });
      return { result, sent: of(await tgReqs(), 'sendMessage') };
    })();
    const noneOk = none.result.ok === false && none.result.status === 'no_chat' && !none.sent.some((m) => [...bound, String(CHAT_B)].includes(String(m.body.chat_id)));
    line(allOk && retryOk && noneOk, 'OB17', 'lead alert: every bound phone once, nobody else',
      `all=${allOk} to=${all.to.length} retry=${retryOk} pending=${pending.length} none=${noneOk}`);
  }

  /* OB15: over the whole suite, every message the operator chat was sent. */
  {
    await tgReset();
    const withParse = allTg.filter((x) => x.body && typeof x.body === 'object' && 'parse_mode' in x.body);
    const toOperator = allTg.filter((x) => x.body && String(x.body.chat_id) === String(OP));
    const inline = toOperator.flatMap((x) => kbOf(x).flat());
    const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE0F}\u{200D}\u{2190}-\u{21FF}]/u;
    const withEmoji = allTg.flatMap((x) => kbOf(x).flat()).filter((b) => EMOJI.test(String(b.text)));
    const PATTERNS = [/^(bl|bn):\d{1,3}$/, /^(bd|bs|bS|br|bv|bi|bp|bP|bc|bw|bW|bu):\d{1,3}:[0-9a-f-]{36}$/, /^bq:\d{1,2}:\d{1,3}:[0-9a-f-]{36}$/,
      /^bo:\d{1,2}:\d{1,3}:[A-Za-z0-9_-]{44}$/];
    const data = inline.map((b) => String(b.callback_data));
    const unshaped = data.filter((d) => Buffer.byteLength(d, 'utf8') > 64 || !PATTERNS.some((p) => p.test(d)));
    const STYLES = { Suspend: 'danger', 'Confirm suspend': 'danger', 'Replace phone': 'danger', 'Confirm replace': 'danger', Invite: 'primary', Reactivate: 'primary' };
    const styled = inline.filter((b) => (b.style || null) !== (STYLES[b.text] || null));
    const labels = [...new Set(inline.map((b) => b.text))].filter((t) => !/^\d$/.test(t)).sort();
    const labelsOk = same(labels, ['Back', 'Cancel', 'Confirm replace', 'Confirm suspend', 'Invite', 'Leads', 'Newer', 'Older', 'Reactivate', 'Replace phone', 'Suspend']);
    // Nothing a customer typed, and no retired word, in anything the operator
    // chat was shown by the flows above.
    const words = operatorTexts.filter((t) => /Requests?\b|Terminate|\/phones|\/code\b/.test(t)
      || [PII.name, PII.phone, PII.email, PII.notes, PII.address].some((x) => t.includes(x)));
    line(allTg.length > 400 && withParse.length === 0 && inline.length > 150 && withEmoji.length === 0
      && unshaped.length === 0 && styled.length === 0 && labelsOk && operatorTexts.length > 30 && words.length === 0,
      'OB15', 'no parse_mode, no emoji, anchored callbacks <= 64 bytes, styles',
      `requests=${allTg.length} buttons=${inline.length} parse=${withParse.length} emoji=${withEmoji.length} unshaped=${unshaped.slice(0, 2).join(',') || 'none'} styled=${styled.slice(0, 2).map((b) => b.text).join(',') || 'none'} labels=${labelsOk} words=${words.length}`);
  }
} catch (e) {
  line(false, 'OB0', 'operator-browser suite threw', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
} finally {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await tgCtl({ mode: 'ok', failChat: null }).catch(() => {});
  await mailCtl({ mode: 'ok' }).catch(() => {});
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
