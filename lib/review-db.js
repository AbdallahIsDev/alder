// lib/review-db.js — server-side database work for the customer review page.
//
// Deliberately separate from lib/db.js so roofer-facing code (api/tg.js and its
// imports) never contains a direct SELECT from public.leads. The review page is
// customer-facing, not roofer-facing, and it needs review_token which the view omits.

import { createClient } from '@supabase/supabase-js';

let client = null;
function db() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('db_not_configured');
  if (!client) {
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { 'x-application-name': 'alder-review' } },
    });
  }
  return client;
}

export async function getLeadByReviewToken(token, businessId) {
  const { data, error } = await db()
    .from('leads')
    .select('id, business_id, name, phone, email, status, review_token')
    .eq('review_token', token)
    .eq('business_id', businessId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function getFeedback(leadId) {
  const { data, error } = await db()
    .from('review_feedback')
    .select('rating, comment, google_clicked')
    .eq('lead_id', leadId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/** Idempotent per lead: a second submit updates the same row. */
export async function upsertFeedback(leadId, rating, comment) {
  const { error } = await db()
    .from('review_feedback')
    .upsert({ lead_id: leadId, rating, comment }, { onConflict: 'lead_id' });
  if (error) throw error;
}

export async function markGoogleClicked(leadId) {
  // Upsert creates the row on the first click and only updates google_clicked later,
  // so a rating already stored on this lead is never overwritten.
  const { error } = await db()
    .from('review_feedback')
    .upsert({ lead_id: leadId, google_clicked: true }, { onConflict: 'lead_id' });
  if (error) throw error;
}
