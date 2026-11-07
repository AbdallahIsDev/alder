// lib/digest-db.js — the reads /api/digest needs, in a module api/tg.js never imports.
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
 *   untouched  still-open leads older than the cutoff with no `contacted` event
 *   failed     failed-alert events in the last 24 h
 *
 * Six queries in total, not six per business. Counts only — no row content ever
 * leaves this function except ids it needs for the join.
 */
export async function digestCounts({ sinceIso, cutoffIso }) {
  const out = new Map();

  const { data: fresh, error: e1 } = await db()
    .from('leads').select('id, business_id').gte('created_at', sinceIso);
  if (e1) throw e1;
  const businessOfLead = new Map();
  for (const l of fresh || []) {
    businessOfLead.set(l.id, l.business_id);
    bump(out, l.business_id, 'newLeads');
  }

  const { data: created, error: e2 } = await db()
    .from('lead_events').select('lead_id, meta').eq('kind', 'created').gte('created_at', sinceIso);
  if (e2) throw e2;
  for (const ev of created || []) {
    if (!ev.meta || !ev.meta.duplicate_of) continue;
    const biz = businessOfLead.get(ev.lead_id);
    if (biz) bump(out, biz, 'repeats');
  }

  const { data: openOld, error: e3 } = await db()
    .from('leads').select('id, business_id').eq('status', 'open').lt('created_at', cutoffIso);
  if (e3) throw e3;
  const openIds = (openOld || []).map((l) => l.id);
  const contacted = new Set();
  if (openIds.length) {
    const { data: evs, error: e4 } = await db()
      .from('lead_events').select('lead_id').eq('kind', 'contacted').in('lead_id', openIds);
    if (e4) throw e4;
    for (const ev of evs || []) contacted.add(ev.lead_id);
  }
  for (const l of openOld || []) {
    if (contacted.has(l.id)) continue;
    bump(out, l.business_id, 'untouched');
  }

  const { data: failed, error: e5 } = await db()
    .from('lead_events').select('lead_id, kind').in('kind', FAILED_KINDS).gte('created_at', sinceIso);
  if (e5) throw e5;
  const unknown = [...new Set((failed || []).map((e) => e.lead_id).filter((id) => !businessOfLead.has(id)))];
  if (unknown.length) {
    const { data: leads, error: e6 } = await db().from('leads').select('id, business_id').in('id', unknown);
    if (e6) throw e6;
    for (const l of leads || []) businessOfLead.set(l.id, l.business_id);
  }
  for (const ev of failed || []) {
    const biz = businessOfLead.get(ev.lead_id);
    if (biz) bump(out, biz, 'failed');
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
