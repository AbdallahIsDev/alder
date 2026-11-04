// lib/db.js — the only place in this codebase that talks to Supabase.
//
// Server-side only. It uses the service_role key, which bypasses row level security,
// so this file must never reach a browser bundle, a static build, or a public URL.
// Nothing under lib/ is copied into dist/.
//
// Roofer-facing READS of leads go through public.v_client_leads only. Writes use
// conditional UPDATEs so tenancy is enforced by the database, not by a prior read.

import { createClient } from '@supabase/supabase-js';

let client = null;

function db() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('db_not_configured');
  if (!client) {
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { 'x-application-name': 'alder-lead-api' } },
    });
  }
  return client;
}

/* ---------- businesses ---------- */

/** Demo/active businesses only. owner_email and google_review_url stay server-side. */
export async function getActiveBusinessBySlug(slug) {
  const { data, error } = await db()
    .from('businesses')
    .select('id, slug, name, status, timezone, owner_email, google_review_url')
    .eq('slug', slug)
    .in('status', ['demo', 'active'])
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function getBusinessById(id) {
  const { data, error } = await db()
    .from('businesses')
    .select('id, slug, name, status, timezone, owner_email, google_review_url')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/* ---------- leads ---------- */

/**
 * Insert one lead. Returns the new row's id, or null when (business_id, idempotency_key)
 * already exists. Uses ON CONFLICT DO NOTHING so a duplicate is resolved by the database.
 */
export async function insertLead(row) {
  const { data, error } = await db()
    .from('leads')
    .upsert(row, { onConflict: 'business_id,idempotency_key', ignoreDuplicates: true })
    .select('id');
  if (error) throw error;
  return data && data.length ? data[0].id : null;
}

/** Roofer-facing list. Reads the view, never the table. */
export async function listClientLeads(businessId, limit = 10) {
  const { data, error } = await db()
    .from('v_client_leads')
    .select('id, business_id, name, phone, service, status, created_at')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function getClientLead(id, businessId) {
  const { data, error } = await db()
    .from('v_client_leads')
    .select('id, business_id, name, phone, email, zip, service, home, timing, roof_age, insurance_claim, notes, status, created_at')
    .eq('id', id)
    .eq('business_id', businessId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * Conditional status transition. Returns { changed, lead } — changed is false on a
 * second tap or any backward or sideways move. Forward-only: open -> contacted, and
 * any of contacted/quoted/won -> done (quoted and won are allowed so future richer
 * states stay compatible). The allowed SOURCE statuses are part of each UPDATE's
 * WHERE clause, so a stale or repeated tap is refused by the database, not the UI.
 * For a transition to done, a missing review_token is filled by a separate
 * conditional UPDATE with "IS NULL", which is the COALESCE behaviour without raw SQL:
 * two concurrent taps can set it, but neither can rotate a token that already exists.
 */
export async function transitionLead(id, businessId, target, newToken) {
  const sources = { contacted: ['open'], done: ['contacted', 'quoted', 'won'] }[target];
  if (!sources) return { changed: false, lead: null };
  if (target === 'done' && newToken) {
    const { error: tokenErr } = await db()
      .from('leads')
      .update({ review_token: newToken })
      .eq('id', id)
      .eq('business_id', businessId)
      .is('review_token', null)
      .in('status', sources);
    if (tokenErr) throw tokenErr;
  }
  const { data, error } = await db()
    .from('leads')
    .update({ status: target })
    .eq('id', id)
    .eq('business_id', businessId)
    .in('status', sources)
    .select('id, review_token, name, phone, email');
  if (error) throw error;
  return data && data.length ? { changed: true, lead: data[0] } : { changed: false, lead: null };
}

/* ---------- events / rate limits ---------- */

export async function addEvent(leadId, kind, meta) {
  const { error } = await db().from('lead_events').insert({ lead_id: leadId, kind, meta: meta || {} });
  if (error) throw error;
}

export async function hitRateLimit(key, windowSeconds, max) {
  const { data, error } = await db().rpc('hit_rate_limit', {
    p_key: key, p_window_seconds: windowSeconds, p_max: max,
  });
  if (error) throw error;
  return data === true;
}

/* ---------- telegram bindings ---------- */

export async function listBusinessChats(businessId) {
  const { data, error } = await db()
    .from('business_chats')
    .select('tg_chat_id')
    .eq('business_id', businessId);
  if (error) throw error;
  return (data || []).map((r) => r.tg_chat_id);
}

export async function getChatBinding(chatId) {
  const { data, error } = await db()
    .from('business_chats')
    .select('business_id')
    .eq('tg_chat_id', chatId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function bindChat(businessId, chatId) {
  const { error } = await db()
    .from('business_chats')
    .upsert({ business_id: businessId, tg_chat_id: chatId }, { onConflict: 'tg_chat_id', ignoreDuplicates: true });
  if (error) throw error;
}

/** Atomic single-use claim: one UPDATE ... WHERE ... RETURNING. No read-then-write race. */
export async function claimBindCode(code) {
  const { data, error } = await db()
    .from('bind_codes')
    .update({ used_at: new Date().toISOString() })
    .eq('code', code)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('business_id');
  if (error) throw error;
  return data && data.length ? data[0].business_id : null;
}

export async function createBindCode(code, businessId, expiresAt) {
  const { error } = await db().from('bind_codes').insert({ code, business_id: businessId, expires_at: expiresAt });
  if (error) throw error;
}
