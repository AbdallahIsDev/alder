// tests/lifecycle-harness.mjs — the in-memory world the lifecycle suites share.
//
// NOT a suite (no .test.mjs): tests/billing-job.test.mjs and
// tests/lifecycle.test.mjs import it. It needs the loopback Telegram and
// Resend fakes (FAKE_TG_URL, FAKE_RESEND_URL: started by tests/run.mjs) and
// replaces globalThis.fetch so that every Supabase request is answered from a
// small in-memory PostgREST. Nothing here can reach a real database: the
// Supabase URL is only ever matched as a prefix and answered locally.
//
// The store: businesses, chats (business_chats), leads (also v_client_leads),
// events (business_events), leadEvents (lead_events), claims (rate limits).
// store.no0007 = true makes it behave like a database WITHOUT migration 0007
// (no leads.held_at, no business_events).

import { loadEnv } from './env.mjs';
import { FIXTURE_CHATS } from './fixture-ids.mjs';

loadEnv();

export const OWNER = FIXTURE_CHATS.billingOwner;
export const STAFF = FIXTURE_CHATS.billingStaff;
export const CHAT_B = FIXTURE_CHATS.billingB;
export const OTHER = FIXTURE_CHATS.billingOther;
export const OP = FIXTURE_CHATS.billingOperator;
export const OPERATOR_MAIL = 'operator@fixture.invalid';

process.env.TELEGRAM_API_BASE = process.env.FAKE_TG_URL;
process.env.VERCEL_ENV = 'development';
process.env.OPERATOR_CHAT_ID = String(OP);
process.env.OPERATOR_EMAIL = OPERATOR_MAIL;
delete process.env.TELEGRAM_CHAT_ID;
process.env.RESEND_API_BASE = process.env.FAKE_RESEND_URL;
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'lifecycle-test-key';
process.env.MAIL_FROM = 'alerts@fixture.invalid';
delete process.env.MAIL_REDIRECT_TO;
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '1:lifecycle-test-token';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:9/fake-supabase';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'lifecycle-test-service-key';

const TG = process.env.FAKE_TG_URL;
const MAIL = process.env.FAKE_RESEND_URL;
export const realFetch = globalThis.fetch;
export const post = (url, body) => realFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
export const allTg = [];
export const allMail = [];
let started = false;
const tgReqs = async () => (await (await realFetch(TG + '/__requests')).json()).requests;
const mailReqs = async () => (await (await realFetch(MAIL + '/__requests')).json()).requests.filter((x) => x.path === '/emails');
export const mailCtl = (body) => post(MAIL + '/__control', body);
export const tgCtl = (body) => post(TG + '/__control', body);

export const DAY = 86400000;
export const HOUR = 3600000;
export const iso = (ms) => new Date(ms).toISOString();
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const bizId = (n) => `b${String(n).padStart(7, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const businessRow = (id, slug, name, status, patch = {}) => ({
  id, slug, name, status, timezone: 'America/Chicago', owner_email: `${slug}@fixture.invalid`, google_review_url: 'https://g.page/r/x',
  site_host: `${slug}.test`, paid_until: null, billing_warning_stage: 0, suspended_for_billing: false, ...patch,
});

export const world = { store: null, sbRequests: [], sbHook: null, tgHook: null, seq: 0 };
export const setStore = (s) => { world.store = { businesses: [], chats: [], leads: [], events: [], leadEvents: [], claims: new Map(), no0007: false, ...s }; return world.store; };
export const get = (id) => world.store.businesses.find((b) => b.id === id);
export const set = (id, patch) => Object.assign(get(id), patch);
/** The next UTC day, as the rate-limit function sees it. */
export const newDay = () => world.store.claims.clear();

export const tgRefuse = () => new Response(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: fake refusal' }),
  { status: 403, headers: { 'content-type': 'application/json' } });
export const fail500 = () => new Response('{"message":"fake failure"}', { status: 500, headers: { 'content-type': 'application/json' } });
const pgError = (status, code, message) => new Response(JSON.stringify({ code, message, details: null, hint: null }),
  { status, headers: { 'content-type': 'application/json' } });

const match = (r, params) => {
  for (const [key, raw] of params) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(key)) continue;
    const v = r[key];
    const date = (x) => new Date(x).getTime();
    if (raw.startsWith('eq.')) { if (String(v) !== raw.slice(3)) return false; continue; }
    if (raw.startsWith('neq.')) { if (String(v) === raw.slice(4)) return false; continue; }
    if (raw === 'is.null') { if (v !== null && v !== undefined) return false; continue; }
    if (raw === 'not.is.null') { if (v === null || v === undefined) return false; continue; }
    // As in SQL, NULL is not before or after anything.
    if (raw.startsWith('lt.')) { if (v == null || !(date(v) < date(raw.slice(3)))) return false; continue; }
    if (raw.startsWith('gt.')) { if (v == null || !(date(v) > date(raw.slice(3)))) return false; continue; }
    if (raw.startsWith('gte.')) { if (v == null || !(date(v) >= date(raw.slice(4)))) return false; continue; }
    if (raw.startsWith('in.(')) {
      const list = raw.slice(4, -1).split(',').map((x) => x.replace(/^"|"$/g, ''));
      if (!list.includes(String(v))) return false;
      continue;
    }
    throw new Error(`fake PostgREST: unknown filter ${key}=${raw}`);
  }
  return true;
};
const byOrder = (order) => {
  const cols = String(order || '').split(',').filter(Boolean).map((c) => { const [name, dir] = c.split('.'); return { name, desc: dir === 'desc' }; });
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

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const SB = process.env.SUPABASE_URL;
  if (!url.startsWith(SB)) {
    if (!(url.startsWith(TG) || url.startsWith(MAIL))) throw new Error('lifecycle harness: unexpected outbound request');
    let chat = null;
    try { chat = JSON.parse(init.body || '{}').chat_id; } catch { chat = null; }
    const method = url.split('/').pop();
    const forced = url.startsWith(TG) && world.tgHook ? world.tgHook({ method, chat }) : null;
    return forced || realFetch(input, init);
  }
  const { store } = world;
  const u = new URL(url);
  const table = u.pathname.replace(/^.*\/rest\/v1\//, '');
  const method = String(init.method || 'GET').toUpperCase();
  const params = [...u.searchParams.entries()];
  const headers = new Headers(init.headers || (typeof input === 'object' ? input.headers : undefined) || {});
  let sent = null;
  try { sent = init.body ? JSON.parse(init.body) : null; } catch { sent = null; }
  world.sbRequests.push({ table, method, params, body: sent });
  if (world.sbHook) {
    const forced = await world.sbHook({ table, method, params, body: sent });
    if (forced) return forced;
  }
  const select = u.searchParams.get('select') || '';
  const json = (rows) => {
    const h = { 'content-type': 'application/json' };
    if (String(headers.get('prefer') || '').includes('count=exact')) h['content-range'] = `${rows.length ? `0-${rows.length - 1}` : '*'}/${rows.length}`;
    let out = rows.slice().sort(byOrder(u.searchParams.get('order')));
    const range = /^(\d+)-(\d+)$/.exec(String(headers.get('range') || ''));
    const offset = range ? Number(range[1]) : Number(u.searchParams.get('offset') || 0);
    const limit = range ? Number(range[2]) - Number(range[1]) + 1 : (u.searchParams.get('limit') ? Number(u.searchParams.get('limit')) : Infinity);
    out = out.slice(offset, offset + limit);
    return new Response(method === 'HEAD' ? null : JSON.stringify(out), { status: 200, headers: h });
  };
  const id = () => { world.seq += 1; return `e${String(world.seq).padStart(7, '0')}-0000-4000-8000-000000000000`; };

  if (table === 'rpc/hit_rate_limit') {
    const n = (store.claims.get(sent.p_key) || 0) + 1;
    store.claims.set(sent.p_key, n);
    return new Response(JSON.stringify(n <= Number(sent.p_max || 1)), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (table === 'rate_limits') {
    if (method === 'DELETE') store.claims.delete(String(u.searchParams.get('key') || '').replace(/^eq\./, ''));
    return json([]);
  }
  if (table === 'business_chats') {
    const rows = store.chats.filter((r) => match(r, params));
    return json(rows.map((r) => ({ ...r, ...(select.includes('businesses(') ? { businesses: { status: (get(r.business_id) || {}).status } } : {}) })));
  }
  if (table === 'businesses') {
    if (method === 'PATCH') {
      const hit = store.businesses.filter((r) => match(r, params));
      for (const r of hit) Object.assign(r, sent || {});
      return json(hit.map((r) => ({ id: r.id })));
    }
    return json(store.businesses.filter((r) => match(r, params)).map((r) => ({ ...r })));
  }
  if (table === 'business_events') {
    if (store.no0007) return pgError(404, 'PGRST205', "Could not find the table 'public.business_events' in the schema cache");
    if (method === 'POST') {
      // One row or several in one insert (an array body).
      for (const row of Array.isArray(sent) ? sent : [sent]) {
        world.seq += 1;
        store.events.push({ id: id(), provider_id: null, error_class: null, ...row, created_at: row.created_at || iso((store.clock || Date.now()) + world.seq) });
      }
      return new Response(null, { status: 201 });
    }
    return json(store.events.filter((r) => match(r, params)).map((r) => ({ ...r })));
  }
  if (table === 'leads' || table === 'v_client_leads') {
    if (store.no0007 && (select.includes('held_at') || params.some(([k]) => k === 'held_at'))) return pgError(400, '42703', 'column held_at does not exist');
    if (method === 'POST') {
      if (store.no0007 && sent && 'held_at' in sent) return pgError(400, 'PGRST204', "Could not find the 'held_at' column of 'leads' in the schema cache");
      const dup = store.leads.find((l) => l.business_id === sent.business_id && l.idempotency_key === sent.idempotency_key);
      if (dup) return json([]);
      const row = { id: id(), status: 'open', held_at: null, created_at: iso(store.clock || Date.now()), ...sent };
      store.leads.push(row);
      return json([{ id: row.id }]);
    }
    if (method === 'PATCH') {
      const hit = store.leads.filter((r) => match(r, params));
      for (const r of hit) Object.assign(r, sent || {});
      return json(hit.map((r) => ({ ...r })));
    }
    return json(store.leads.filter((r) => match(r, params)).map((r) => ({ ...r })));
  }
  if (table === 'lead_events') {
    if (method === 'POST') { store.leadEvents.push({ id: id(), ...sent }); return new Response(null, { status: 201 }); }
    return json(store.leadEvents.filter((r) => match(r, params)).map((r) => ({ ...r })));
  }
  return json([]);
};

export const textOf = (req) => String((req && req.body && req.body.text) || '');
export const toOf = (m) => [].concat(m.body.to).join(',');
export const keyOf = (m) => String(m.headers['idempotency-key'] || '');
export const writes = (reqs) => reqs.filter((q) => !['GET', 'HEAD'].includes(q.method) && !['rpc/hit_rate_limit', 'rate_limits', 'business_events', 'lead_events'].includes(q.table));

/** One call of anything: what Telegram and the mail service received and what
 *  the database was asked. The operator's messages are kept apart from the
 *  businesses'. `keepMail` leaves the mail service's idempotency memory. */
export async function during(fn, { keepMail = false } = {}) {
  // The fakes are shared by every suite of a run: what an EARLIER suite left
  // in them is not this suite's, and must not reach its final scans.
  if (started) {
    try { allTg.push(...(await tgReqs())); } catch { /* nothing */ }
    try { allMail.push(...(await mailReqs())); } catch { /* nothing */ }
  }
  started = true;
  await post(TG + '/__reset');
  await post(MAIL + '/__reset');
  if (!keepMail) await mailCtl({ clearIdempotency: true });
  world.sbRequests = [];
  const out = await fn();
  const tg = (await tgReqs()).filter((x) => x.path.endsWith('/sendMessage'));
  const mail = await mailReqs();
  const sb = world.sbRequests.slice();
  return {
    out, tg, sb,
    sends: tg.filter((x) => String(x.body.chat_id) !== String(OP)),
    operator: tg.filter((x) => String(x.body.chat_id) === String(OP)),
    mail: mail.filter((m) => toOf(m) !== OPERATOR_MAIL),
    operatorMail: mail.filter((m) => toOf(m) === OPERATOR_MAIL),
    w: writes(sb),
  };
}

/** Every Telegram and mail request of the whole suite (for the final scans). */
export async function everything() {
  try { allTg.push(...(await tgReqs())); } catch { /* nothing */ }
  try { allMail.push(...(await mailReqs())); } catch { /* nothing */ }
  return { tg: allTg.slice(), mail: allMail.slice() };
}

/** No line of a message longer than the rule allows. */
export const longLines = (text, max = 34) => String(text || '').split('\n').filter((l) => l.length > max);
/** The support link: exactly one text_link entity over the words "Contact
 *  support", pointing at the configured address. */
export function supportLinkOk(body, url) {
  const e = body && body.entities;
  if (!Array.isArray(e) || e.length !== 1) return false;
  const text = String(body.text || '');
  return e[0].type === 'text_link' && e[0].url === url && text.slice(e[0].offset, e[0].offset + e[0].length) === 'Contact support'
    && e[0].offset + e[0].length === text.length;
}
