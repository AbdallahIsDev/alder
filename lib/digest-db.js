// lib/digest-db.js — the reads /api/digest and /api/selfcheck need, in a module
// api/tg.js never imports.
//
// Kept out of lib/db.js on purpose: test C10 walks everything api/tg.js imports
// and fails on any direct SELECT from public.leads, because roofer-facing code
// must read v_client_leads. The digest is not roofer-facing, so its lead reads
// live here.

import { createClient } from '@supabase/supabase-js';
import { ACTIVE_STATUSES } from './db.js';

let client = null;
function db() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('db_not_configured');
  if (!client) {
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { 'x-application-name': 'alder-digest' } },
    });
  }
  return client;
}

const FAILED_KINDS = ['tg_failed', 'email_owner_failed', 'autoreply_failed', 'review_request_failed'];

/* PostgREST returns at most 1,000 rows per request by default and says nothing
   when it truncates. Everything below pages with range() until a short page
   arrives, and every .in() list is chunked: 250 uuids in one query string is
   already a ~9 KB URL, and the limit is on the server, not in the client. */
const PAGE = 1000;
// 80, not 100: a 36-char uuid plus its comma is 37 bytes, so 100 ids already put
// a 4 KB query string on the wire for this select. 80 keeps every URL near 3.3 KB.
const CHUNK = 80;

async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data || [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function fetchIn(column, ids, build) {
  const out = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    out.push(...await fetchAll(() => build().in(column, slice)));
  }
  return out;
}

const bump = (map, id, field, n = 1) => {
  const row = map.get(id) || { newLeads: 0, repeats: 0, untouched: 0, failed: 0 };
  row[field] += n;
  map.set(id, row);
  return row;
};

/**
 * Per-business counts for the window.
 *
 *   newLeads   leads created in the last 24 h
 *   repeats    those whose `created` event carries duplicate_of
 *   untouched  still-open leads older than the cutoff, newer than the floor,
 *              with no `contacted` event
 *   failed     failed-alert events in the last 24 h
 *
 * Six query shapes in total, not six per business. Counts only — no row content
 * ever leaves this function except ids it needs for the join.
 */
export async function digestCounts({ sinceIso, cutoffIso, floorIso }) {
  const out = new Map();

  const fresh = await fetchAll(() => db()
    .from('leads').select('id, business_id').gte('created_at', sinceIso).order('id'));
  const businessOfLead = new Map();
  for (const l of fresh) {
    businessOfLead.set(l.id, l.business_id);
    bump(out, l.business_id, 'newLeads');
  }

  const created = await fetchAll(() => db()
    .from('lead_events').select('lead_id, meta').eq('kind', 'created')
    .gte('created_at', sinceIso).order('id'));
  for (const ev of created) {
    if (!ev.meta || !ev.meta.duplicate_of) continue;
    const biz = businessOfLead.get(ev.lead_id);
    if (biz) bump(out, biz, 'repeats');
  }

  // "Untouched" is bounded on both sides: older than a day (so it has actually
  // been ignored) and newer than the lookback (so a two-year-old row is not
  // nagged about every morning for the rest of the account's life).
  const openOld = await fetchAll(() => db()
    .from('leads').select('id, business_id').eq('status', 'open')
    .lt('created_at', cutoffIso).gte('created_at', floorIso).order('id'));
  const openIds = openOld.map((l) => l.id);
  const contacted = new Set();
  if (openIds.length) {
    const evs = await fetchIn('lead_id', openIds, () => db()
      .from('lead_events').select('lead_id').eq('kind', 'contacted').order('id'));
    for (const ev of evs) contacted.add(ev.lead_id);
  }
  for (const l of openOld) {
    if (contacted.has(l.id)) continue;
    bump(out, l.business_id, 'untouched');
  }

  const failed = await fetchAll(() => db()
    .from('lead_events').select('lead_id, kind').in('kind', FAILED_KINDS)
    .gte('created_at', sinceIso).order('id'));
  const unknown = [...new Set(failed.map((e) => e.lead_id).filter((id) => !businessOfLead.has(id)))];
  if (unknown.length) {
    const leads = await fetchIn('id', unknown, () => db()
      .from('leads').select('id, business_id').order('id'));
    for (const l of leads) businessOfLead.set(l.id, l.business_id);
  }
  for (const ev of failed) {
    const biz = businessOfLead.get(ev.lead_id);
    if (biz) bump(out, biz, 'failed');
  }

  return out;
}

/**
 * Per-business counts for a fixed set of event kinds in the window.
 *
 * The self-check used to count globally, which is how a demo business ended up
 * being told about another business's failures. This returns
 * Map<business_id, { kind: count }> so each message can carry only its own
 * numbers. Two query shapes in total, both paged: the events, then the leads
 * they belong to. A lead that no longer exists is skipped, never guessed.
 */
export async function eventCountsByBusiness({ sinceIso, kinds }) {
  const events = await fetchAll(() => db()
    .from('lead_events').select('lead_id, kind').in('kind', kinds)
    .gte('created_at', sinceIso).order('id'));
  if (!events.length) return new Map();

  const ids = [...new Set(events.map((e) => e.lead_id))];
  const leads = await fetchIn('id', ids, () => db()
    .from('leads').select('id, business_id').order('id'));
  const businessOf = new Map(leads.map((l) => [l.id, l.business_id]));

  const out = new Map();
  for (const e of events) {
    const biz = businessOf.get(e.lead_id);
    if (!biz) continue;
    const row = out.get(biz) || Object.fromEntries(kinds.map((k) => [k, 0]));
    row[e.kind] = (row[e.kind] || 0) + 1;
    out.set(biz, row);
  }
  return out;
}

/** Every business that could be told something: a bound chat, or an owner email. */
export async function digestTargets() {
  // Active only: a paused or churned business keeps its rows but is not told
  // anything, and must not have its owner emailed either.
  const { data: businesses, error: e1 } = await db()
    .from('businesses').select('id, slug, name, owner_email, status').in('status', ACTIVE_STATUSES);
  if (e1) throw e1;
  const { data: chats, error: e2 } = await db()
    .from('business_chats').select('business_id, tg_chat_id');
  if (e2) throw e2;
  const byBusiness = new Map();
  for (const c of chats || []) {
    const list = byBusiness.get(c.business_id) || [];
    list.push(c.tg_chat_id);
    byBusiness.set(c.business_id, list);
  }
  return (businesses || []).map((b) => ({
    id: b.id,
    slug: b.slug,
    ownerEmail: b.owner_email || null,
    chats: byBusiness.get(b.id) || [],
  }));
}
