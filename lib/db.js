// lib/db.js — the only place in this codebase that talks to Supabase.
//
// Server-side only. It uses the service_role key, which bypasses row level security,
// so this file must never reach a browser bundle, a static build, or a public URL.
// Nothing under lib/ is copied into dist/ (build-static.js copies assets/, robots.txt,
// sitemap.xml and site.webmanifest only), and no page script references it.

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

/** A business that may receive leads: demo or active only. Null when unknown or paused/churned. */
export async function getActiveBusinessBySlug(slug) {
  const { data, error } = await db()
    .from('businesses')
    .select('id, slug, name, status, timezone')
    .eq('slug', slug)
    .in('status', ['demo', 'active'])
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * Insert one lead. Returns the new row's id, or null when (business_id, idempotency_key)
 * already exists — the caller treats null as "already stored, do nothing else".
 * Uses ON CONFLICT DO NOTHING so a duplicate is resolved by the database, not by a
 * read-then-write race between two concurrent submissions.
 */
export async function insertLead(row) {
  const { data, error } = await db()
    .from('leads')
    .upsert(row, { onConflict: 'business_id,idempotency_key', ignoreDuplicates: true })
    .select('id');
  if (error) throw error;
  return data && data.length ? data[0].id : null;
}

/** Append to the lead's audit trail. Throws so the caller can decide what a failure means. */
export async function addEvent(leadId, kind, meta) {
  const { error } = await db().from('lead_events').insert({ lead_id: leadId, kind, meta: meta || {} });
  if (error) throw error;
}

/** True while the caller is still under the limit. Fixed window, counted in Postgres. */
export async function hitRateLimit(key, windowSeconds, max) {
  const { data, error } = await db().rpc('hit_rate_limit', {
    p_key: key,
    p_window_seconds: windowSeconds,
    p_max: max,
  });
  if (error) throw error;
  return data === true;
}
