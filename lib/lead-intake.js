// lib/lead-intake.js — database work that only the lead endpoint needs.
//
// Separate from lib/db.js on purpose: lib/db.js is imported by api/tg.js, and the
// roofer-facing code must never contain a direct SELECT from public.leads (test
// C10 enforces that statically). Duplicate detection reads leads directly, so it
// lives here, where only api/lead.js reaches it.

import { createClient } from '@supabase/supabase-js';

let client = null;
function db() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('db_not_configured');
  if (!client) {
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { 'x-application-name': 'alder-lead-intake' } },
    });
  }
  return client;
}

/**
 * A lead for the same business with the same phone or the same email inside the
 * window, excluding the lead just created. Returns its id or null.
 *
 * Two separate eq() queries rather than one or(): .or() takes a filter STRING, and
 * a customer-supplied email can contain commas, so building one would be an
 * injection surface for no gain. Phone is already E.164, so equality is exact;
 * email is compared exactly as stored, which means a differently-cased address is
 * not detected (documented, not a bug).
 *
 * Advisory only: the caller records it and mentions it in the alert. It never
 * blocks or merges a lead.
 */
export async function findRecentDuplicate(businessId, phone, email, sinceIso, excludeId) {
  const base = () => db().from('leads').select('id').eq('business_id', businessId)
    .gte('created_at', sinceIso).neq('id', excludeId).limit(1);
  const queries = [];
  if (phone) queries.push(base().eq('phone', phone));
  if (email) queries.push(base().eq('email', email));
  if (!queries.length) return null;
  const results = await Promise.all(queries);
  for (const r of results) {
    if (r.error) throw r.error;
    if (r.data && r.data.length) return r.data[0].id;
  }
  return null;
}
