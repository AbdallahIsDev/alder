// lib/db.js — the only place in this codebase that talks to Supabase.
//
// Server-side only. It uses the service_role key, which bypasses row level security,
// so this file must never reach a browser bundle, a static build, or a public URL.
// Nothing under lib/ is copied into dist/.
//
// Roofer-facing READS of leads go through public.v_client_leads only. Writes use
// conditional UPDATEs so tenancy is enforced by the database, not by a prior read.

import { createClient } from '@supabase/supabase-js';
import { sweepExpired as sweepExpiredIo } from './housekeeping.js';
import { isOperatorChat } from './operator.js';

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

/**
 * Bounded housekeeping for the daily self-check. Predicates live in
 * lib/housekeeping.js; this wires them to the one Supabase client.
 */
export async function sweepExpired(opts) {
  const c = db();
  return sweepExpiredIo({
    listCodes: async (cutoff, n) => {
      const { data, error } = await c.from('bind_codes').select('code')
        .is('used_at', null).lt('expires_at', cutoff).limit(n);
      if (error) throw error;
      return (data || []).map((r) => r.code);
    },
    deleteCodes: async (codes, cutoff) => {
      const { data, error } = await c.from('bind_codes').delete()
        .in('code', codes).is('used_at', null).lt('expires_at', cutoff).select('code');
      if (error) throw error;
      return (data || []).length;
    },
    listLimits: async (cutoff, n) => {
      const { data, error } = await c.from('rate_limits').select('key')
        .lt('window_start', cutoff).limit(n);
      if (error) throw error;
      return (data || []).map((r) => r.key);
    },
    deleteLimits: async (keys, cutoff) => {
      const { data, error } = await c.from('rate_limits').delete()
        .in('key', keys).lt('window_start', cutoff).select('key');
      if (error) throw error;
      return (data || []).length;
    },
  }, opts);
}

/* ---------- businesses ---------- */

/** Demo/active businesses only. owner_email and google_review_url stay server-side. */
/** Statuses that are being served. `paused` and `churned` are not: an offboarded
 *  client must not keep receiving alerts or digests. One list, so the lead
 *  endpoint, the ops endpoints and the bind script cannot disagree. */
export const ACTIVE_STATUSES = ['demo', 'active'];

/** A business that exists but is not served: `paused` (what the operator's
 *  Suspend writes) or `churned`. An unknown or missing status is NOT
 *  suspended: this answers "is it switched off", not "is it switched on". */
export const SUSPENDED_STATUSES = ['paused', 'churned'];
export function isSuspendedStatus(status) {
  return SUSPENDED_STATUSES.includes(String(status || ''));
}

/** Every business that is being served, for the ops endpoints. `status` is part
 *  of the row because the self-check treats a demo business (the operator's own)
 *  differently from an active client. */
export async function listActiveBusinesses() {
  const { data, error } = await db()
    .from('businesses')
    .select('id, slug, name, owner_email, status')
    .in('status', ACTIVE_STATUSES)
    .order('slug');
  if (error) throw error;
  return data || [];
}

export async function getActiveBusinessByHost(siteHost) {
  const { data, error } = await db()
    .from('businesses')
    .select('id, slug, name, status, timezone, owner_email, google_review_url, site_host')
    .eq('site_host', siteHost)
    .in('status', ACTIVE_STATUSES)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * The business a public request's Host belongs to, WHATEVER its status. The
 * lead endpoint needs to tell a suspended business (the lead is held) and a
 * terminated one (nothing is stored) from a host nobody owns. Every other
 * public endpoint keeps using getActiveBusinessByHost.
 */
export async function getBusinessByHost(siteHost) {
  const { data, error } = await db()
    .from('businesses')
    .select('id, slug, name, status, timezone, owner_email, google_review_url, site_host')
    .eq('site_host', siteHost)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function getActiveBusinessBySlug(slug) {
  const { data, error } = await db()
    .from('businesses')
    .select('id, slug, name, status, timezone, owner_email, google_review_url')
    .eq('slug', slug)
    .in('status', ACTIVE_STATUSES)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

const BUSINESS_COLUMNS = 'id, slug, name, status, timezone, owner_email, google_review_url';
/** The billing columns of migration 0006. */
const BILLING_COLUMNS = 'paid_until, billing_warning_stage, suspended_for_billing';

/** The database said a column does not exist: 42703 on a read, PGRST204 on a
 *  write. For the billing columns that means migration 0006 is not applied. */
export function isMissingColumn(error) {
  const code = error && error.code;
  return code === '42703' || code === 'PGRST204';
}

/** The database said a table does not exist: 42P01 from Postgres, PGRST205
 *  from PostgREST's schema cache. For business_events that means migration
 *  0007 is not applied. */
export function isMissingRelation(error) {
  const code = error && error.code;
  return code === '42P01' || code === 'PGRST205';
}

/**
 * One business by id, with its billing columns. The code may be deployed
 * before migration 0006 is applied; a database without the columns must not
 * take the operator's screens (or anything else that reads a business) down.
 * So when the database says the columns do not exist, the row is read again
 * without them and marked `billing_unavailable`: every billing rule then
 * treats the business as not billed, and the operator is told billing is
 * unavailable. Any other error is thrown as before.
 */
export async function getBusinessById(id) {
  const read = (columns) => db().from('businesses').select(columns).eq('id', id).maybeSingle();
  let { data, error } = await read(`${BUSINESS_COLUMNS}, ${BILLING_COLUMNS}`);
  if (error && isMissingColumn(error)) {
    ({ data, error } = await read(BUSINESS_COLUMNS));
    if (!error && data) data = { ...data, billing_unavailable: true };
  }
  if (error) throw error;
  return data || null;
}

/** One business by slug, whatever its status: the operator's /invite <slug>
 *  must tell a suspended business from one that does not exist. */
export async function getBusinessBySlug(slug) {
  const { data, error } = await db()
    .from('businesses')
    .select('id, slug, name, status, timezone, owner_email, google_review_url')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * Operator suspend / reactivate: move ONE business to `to`, only if its status
 * is still one of `from`. Both the id and the source statuses are part of the
 * UPDATE's WHERE, so a second tap (or a race) changes nothing and reports 0.
 * Returns the number of rows changed. Nothing else on the row is written,
 * unless the caller passes `flags`: { suspended_for_billing } (and, for a
 * restore, { billing_warning_stage }) travels in the
 * SAME statement as the status, so "suspended" and "why" can never disagree.
 * No flags means the statement names no billing column, which is what keeps
 * Suspend and Reactivate working on a database without migration 0006.
 */
export async function setBusinessStatus(businessId, to, from, flags = null) {
  const patch = { status: to };
  if (flags && typeof flags.suspended_for_billing === 'boolean') patch.suspended_for_billing = flags.suspended_for_billing;
  if (flags && Number.isInteger(flags.billing_warning_stage)) patch.billing_warning_stage = flags.billing_warning_stage;
  const { data, error } = await db()
    .from('businesses')
    .update(patch)
    .eq('id', businessId)
    .in('status', from)
    .select('id');
  if (error) throw error;
  return (data || []).length;
}

/* ---------- billing (migration 0006) ---------- */

/** Every business the daily billing job looks at: a paid_until, and a status
 *  the lifecycle can still move (active, paused, churned). Demo businesses
 *  and businesses that are not billed are never read by the job at all;
 *  which of the rows it may ACT on is billingDecision() in lib/billing.js
 *  (never one that was suspended or terminated by hand). */
export async function listBilledBusinesses() {
  const { data, error } = await db()
    .from('businesses')
    .select(`id, slug, name, owner_email, status, ${BILLING_COLUMNS}`)
    .in('status', ['active', ...SUSPENDED_STATUSES])
    .not('paid_until', 'is', null)
    .order('name', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw error;
  return data || [];
}

/** Record what a business has been told: stage `from` -> `to`. The old stage
 *  is part of the WHERE, so two runs at once write once. Returns the number
 *  of rows changed. */
export async function setBillingStage(businessId, to, from) {
  const { data, error } = await db()
    .from('businesses')
    .update({ billing_warning_stage: to })
    .eq('id', businessId)
    .eq('billing_warning_stage', from)
    .select('id');
  if (error) throw error;
  return (data || []).length;
}

/**
 * Move paid_until FORWARD to `targetIso` and clear the warning stage, in one
 * statement. It can never shorten a paid period: the row is changed only when
 * it has no paid_until (`fromNull`, what the caller just read) or an earlier
 * one. The same target twice changes one row, then none. Returns the number of
 * rows changed.
 */
export async function extendPaidUntil(businessId, targetIso, { fromNull = false } = {}) {
  let query = db()
    .from('businesses')
    .update({ paid_until: targetIso, billing_warning_stage: 0 })
    .eq('id', businessId);
  query = fromNull ? query.is('paid_until', null) : query.lt('paid_until', targetIso);
  const { data, error } = await query.select('id');
  if (error) throw error;
  return (data || []).length;
}

/** Slugs + status only (for the bind script's unknown-slug hint). */
export async function listBusinessSlugs() {
  const { data, error } = await db()
    .from('businesses')
    .select('id, slug, name, status')
    .order('slug');
  if (error) throw error;
  return data || [];
}

/** One page of the operator's business browser: every status, name then id,
 *  so a page number means the same rows on every tap. `served` keeps only the
 *  businesses that are being served (the /invite list). */
export async function listBusinessesPage(limit = 5, offset = 0, { served = false } = {}) {
  let query = db()
    .from('businesses')
    .select('id, slug, name, status');
  if (served) query = query.in('status', ACTIVE_STATUSES);
  const { data, error } = await query
    .order('name', { ascending: true })
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return data || [];
}

/* ---------- leads ---------- */

/**
 * Insert one lead. Returns the new row's id, or null when (business_id, idempotency_key)
 * already exists. Uses ON CONFLICT DO NOTHING so a duplicate is resolved by the database.
 */
export async function insertLead(row) {
  const write = (r) => db()
    .from('leads')
    .upsert(r, { onConflict: 'business_id,idempotency_key', ignoreDuplicates: true })
    .select('id');
  let { data, error } = await write(row);
  // A held lead on a database without leads.held_at (migration 0007 not
  // applied): the lead matters more than its mark, so it is stored without.
  if (error && isMissingColumn(error) && row && 'held_at' in row) {
    const { held_at: _dropped, ...rest } = row;
    console.error('lead_held_mark_unavailable');
    ({ data, error } = await write(rest));
  }
  if (error) throw error;
  return data && data.length ? data[0].id : null;
}

/**
 * The stored lead a retried request is about, or null.
 *
 * A no-op UPDATE rather than a SELECT, for the same reason getDoneLeadForRetry
 * uses one: roofer-facing code never reads `leads` directly (the view is the only
 * read path, see tests/source-rules), and this keeps that true. The WHERE clause
 * scopes the write to the business and to the key, and the only column written is
 * the one in the predicate — the row keeps its value, so nothing observable changes.
 *
 * Used only by the idempotent-replay path in api/lead.js: insertLead has just
 * reported that the row exists, and the retry has to know what it holds before
 * deciding whether the lead was ever announced.
 */
export async function getLeadForReplay(businessId, idempotencyKey) {
  const { data, error } = await db()
    .from('leads')
    .update({ idempotency_key: idempotencyKey })
    .eq('business_id', businessId)
    .eq('idempotency_key', idempotencyKey)
    .select('id, held_at, name, phone, email, zip, service, home, timing, roof_age, insurance_claim, notes');
  if (error) throw error;
  return data && data.length ? data[0] : null;
}

/**
 * What has been recorded for one lead, for the replay path.
 *
 * `delivered` is true when ANY channel succeeded: a lead the owner already has on
 * one channel must not get a second copy on the other just because that failed.
 * Telegram outcomes also carry salted chat hashes. A replay can therefore target
 * only chats whose latest recorded outcome is not a success, without a raw chat
 * id or a schema change. An owner-email failure can be retried on replay while
 * no successful owner-email event exists, unless its last recorded status is
 * structurally non-retryable.
 * `duplicateOf` preserves the original advisory.
 */
export async function getLeadDeliveryState(leadId) {
  const { data, error } = await db()
    .from('lead_events')
    .select('kind, meta')
    .eq('lead_id', leadId)
    .in('kind', ['created', 'tg_sent', 'tg_failed', 'email_owner_sent', 'email_owner_failed'])
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw error;
  const rows = data || [];
  const created = rows.find((r) => r.kind === 'created');
  const deliveredChats = new Set();
  const failedChats = new Set();
  let emailOwnerFailureRecorded = false;
  let lastEmailOwnerFailureStatus = null;
  for (const row of rows) {
    if (row.kind === 'email_owner_failed') {
      emailOwnerFailureRecorded = true;
      lastEmailOwnerFailureStatus = row.meta && typeof row.meta.status === 'string' ? row.meta.status : null;
    }
    if (row.kind !== 'tg_sent' && row.kind !== 'tg_failed') continue;
    const outcomes = row.meta && Array.isArray(row.meta.chat_outcomes) ? row.meta.chat_outcomes : [];
    for (const outcome of outcomes) {
      if (!outcome || typeof outcome.chat_hash !== 'string' || !/^[a-f0-9]{64}$/.test(outcome.chat_hash)) continue;
      if (outcome.delivered === true) { deliveredChats.add(outcome.chat_hash); failedChats.delete(outcome.chat_hash); }
      else if (!deliveredChats.has(outcome.chat_hash)) failedChats.add(outcome.chat_hash);
    }
  }
  return {
    created: !!created,
    delivered: deliveredChats.size > 0 || rows.some((r) => r.kind === 'tg_sent' || r.kind === 'email_owner_sent'),
    emailOwnerSent: rows.some((r) => r.kind === 'email_owner_sent'),
    emailOwnerFailureRecorded,
    lastEmailOwnerFailureStatus,
    deliveredChatHashes: [...deliveredChats],
    failedChatHashes: [...failedChats],
    duplicateOf: (created && created.meta && created.meta.duplicate_of) || null,
  };
}

/* ---------- the "someone is announcing this lead" claim ---------- */

/* A claim is a rate_limits row: hit_rate_limit is the only atomic primitive
   available without a schema change (the same trick as the review retry lock in
   api/tg.js). It is keyed by the LEAD, not by an attempt: a second request for
   the same lead that lands while the first one is still sending has to hit the
   same row, or both of them would send. A generation in the key would give the
   second request a fresh row — the exact duplicate this is here to stop.

   This is a FIXED-window bucket, not a hard lock or a 10 s lifetime. A claim can
   live for nearly 10 s or almost 0 s depending on where it lands in the bucket.
   Two callers separated by d seconds (d < 10) can both win when their claims
   straddle an edge; for uniform edge timing that chance is d/10. The replay
   recheck catches already-recorded delivery, not a first request still in flight.

   hit_rate_limit buckets by floor(epoch / window) on the DATABASE clock, so a
   stale row stops matching at the next edge: no stale sweep, and no unsafe local
   clock arithmetic. The maximum bucket width is shorter than the form's 12.7 s
   retry cycle, but that does not make the claim mutually exclusive at an edge. */
export const NOTIFY_CLAIM_WINDOW_SECONDS = 10;

/** True when this caller may announce the lead: the first one in this window wins. */
export async function claimLeadNotification(leadId) {
  return hitRateLimit('notify:' + leadId, NOTIFY_CLAIM_WINDOW_SECONDS, 1);
}

/** Give the claim back once the attempt is over, success or failure, so a later
 *  retry is allowed again. A crash leaves the row; the next window clears it. */
export async function releaseLeadNotification(leadId) {
  await clearRateLimit('notify:' + leadId);
}

/** Roofer-facing list. Reads the view, never the table. Ordered by
 *  created_at desc with id desc as the tie-breaker: equal timestamps (a bulk
 *  insert, a batch import) otherwise have no deterministic order, and page
 *  numbers are only meaningful when the order is stable. Offset paging stays.
 *  business_id is the filter, not a selected column: the caller already holds
 *  it (it is the chat binding's), and nothing reads it back from a row. */
export async function listClientLeads(businessId, limit = 10, offset = 0) {
  const read = (columns) => db()
    .from('v_client_leads')
    .select(columns)
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1);
  // held_at marks a lead that arrived while the business was suspended
  // (migration 0007). Without the column the list reads as before.
  let { data, error } = await read('id, name, phone, service, status, created_at, held_at');
  if (error && isMissingColumn(error)) ({ data, error } = await read('id, name, phone, service, status, created_at'));
  if (error) throw error;
  return data || [];
}

/**
 * The leads a business received while it was suspended, oldest first, so the
 * second message of a reactivation reads in the order they arrived. Scoped by
 * the business id; `sinceIso` (the suspension round) is optional. An empty
 * list on a database without leads.held_at.
 */
export async function listHeldLeads(businessId, { sinceIso = null, limit = 50 } = {}) {
  let query = db()
    .from('v_client_leads')
    .select('id, name, phone, service, status, created_at, held_at')
    .eq('business_id', businessId)
    .not('held_at', 'is', null);
  if (sinceIso) query = query.gte('held_at', sinceIso);
  const { data, error } = await query.order('created_at', { ascending: true }).order('id', { ascending: true }).limit(limit);
  if (error) {
    if (isMissingColumn(error)) return [];
    throw error;
  }
  return data || [];
}

/** How many of a business's leads were HELD (stored while it was suspended),
 *  optionally only those held at or after `sinceIso`. A count, never a row.
 *  0 on a database without leads.held_at. */
export async function countHeldLeads(businessId, sinceIso = null) {
  let query = db()
    .from('v_client_leads')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .not('held_at', 'is', null);
  if (sinceIso) query = query.gte('held_at', sinceIso);
  const { count, error } = await query;
  if (error) {
    if (isMissingColumn(error)) return 0;
    throw error;
  }
  return count || 0;
}

/* ---------- business_events (migration 0007): the owner-notice log ---------- */

/** One row per notice attempt, or several rows in ONE insert (an array).
 *  Fixed vocabulary only: no text, no address. Returns false (and logs one
 *  fixed line) when the rows could not be written, including on a database
 *  without the table; it never throws. */
export async function addBusinessEvent(rowOrRows) {
  const rows = (Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows]).filter(Boolean).map(({ businessId, type, channel, status, errorClass = null, providerId = null }) => ({
    business_id: businessId, type, channel, status,
    error_class: errorClass ? String(errorClass).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40) : null,
    provider_id: providerId ? String(providerId).slice(0, 80) : null,
  }));
  if (!rows.length) return true;
  try {
    const { error } = await db().from('business_events').insert(rows.length === 1 ? rows[0] : rows);
    if (!error) return true;
    console.error(isMissingRelation(error) ? 'business_events_unavailable' : 'business_event_failed', error.code || 'no_code');
  } catch (e) {
    console.error('business_event_failed', (e && e.code) || 'no_code');
  }
  return false;
}

/** Every notice-log row since `sinceIso`, oldest first (the self-check's
 *  "expected but missing" read). null on a database without the table. */
export async function listBusinessEventsSince(sinceIso, limit = 2000) {
  const { data, error } = await db()
    .from('business_events')
    .select('business_id, type, channel, status, created_at')
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) {
    if (isMissingRelation(error)) return null;
    throw error;
  }
  return data || [];
}

/** When the newest notice round of `type` started for a business, or null
 *  (none, or no table). Used to count the leads held since a suspension. */
export async function lastBusinessEventAt(businessId, type) {
  const { data, error } = await db()
    .from('business_events')
    .select('created_at')
    .eq('business_id', businessId)
    .eq('type', type)
    .eq('status', 'expected')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) {
    if (isMissingRelation(error)) return null;
    throw error;
  }
  return (data && data[0] && data[0].created_at) || null;
}

/**
 * Delete one lead, scoped by id AND business. The caller never passes a
 * business from the payload: it comes from the chat binding. Children cascade.
 */
export async function deleteLeadScoped(leadId, businessId) {
  const { data, error } = await db()
    .from('leads').delete().eq('id', leadId).eq('business_id', businessId).select('id');
  if (error) throw error;
  return (data || []).length;
}

/** One lead, scoped by id AND business (both are filters). business_id is not
 *  selected for the same reason as in listClientLeads. */
export async function getClientLead(id, businessId) {
  const read = (columns) => db()
    .from('v_client_leads')
    .select(columns)
    .eq('id', id)
    .eq('business_id', businessId)
    .maybeSingle();
  // As in listClientLeads: a detail must still open on a database without
  // migration 0007. The held mark is simply absent there.
  let { data, error } = await read('id, name, phone, email, zip, service, home, timing, roof_age, insurance_claim, notes, status, created_at, held_at');
  if (error && isMissingColumn(error)) ({ data, error } = await read('id, name, phone, email, zip, service, home, timing, roof_age, insurance_claim, notes, status, created_at'));
  if (error) throw error;
  return data || null;
}

/**
 * The operator's lead reads. The column list is the caller's (it is derived
 * from the one constant that says what the operator may see), and it is
 * checked here against the names a lead column can have, so nothing but a
 * plain column list ever reaches the query. Same order as the owner's list.
 */
const LEAD_COLUMN = /^[a-z_]{1,32}$/;
function leadColumns(columns) {
  const list = [...new Set(['id', ...(columns || [])].map(String))];
  if (!list.every((c) => LEAD_COLUMN.test(c))) throw new Error('lead_columns_invalid');
  return list.join(', ');
}

export async function listLeadsColumns(businessId, columns, limit = 5, offset = 0) {
  const { data, error } = await db()
    .from('v_client_leads')
    .select(leadColumns(columns))
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return data || [];
}

/** One lead with only the named columns, scoped by id AND business. */
export async function getLeadColumns(id, businessId, columns) {
  const { data, error } = await db()
    .from('v_client_leads')
    .select(leadColumns(columns))
    .eq('id', id)
    .eq('business_id', businessId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * How many leads a business has, and when the newest one arrived: ONE query on
 * the client view, scoped by the business. The exact count rides on the
 * response header; the only column read is created_at of the newest row.
 */
export async function getLeadTotals(businessId) {
  const { data, count, error } = await db()
    .from('v_client_leads')
    .select('created_at', { count: 'exact' })
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return { total: count || 0, lastAt: (data && data[0] && data[0].created_at) || null };
}

/** How many of a business's leads arrived at or after `sinceIso`: a count,
 *  never a row. */
export async function countClientLeadsSince(businessId, sinceIso) {
  const { count, error } = await db()
    .from('v_client_leads')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .gte('created_at', sinceIso);
  if (error) throw error;
  return count || 0;
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

/**
 * The review-token row for a done lead, for the Try again resend. The no-op
 * UPDATE is used as a tenancy-scoped read: the leads table is touched only
 * through this conditional pattern (WHERE id + business + status), never a
 * direct SELECT. Conditional no-op UPDATE ... RETURNING (status stays
 * 'done'), the same tenancy pattern as transitionLead: the WHERE clause
 * scopes to the business and to status 'done', so a forged or not-done lead
 * returns null. There is no updated_at column on leads, so the write
 * changes nothing observable.
 */
export async function getDoneLeadForRetry(id, businessId) {
  const { data, error } = await db()
    .from('leads')
    .update({ status: 'done' })
    .eq('id', id)
    .eq('business_id', businessId)
    .eq('status', 'done')
    .select('id, review_token, name, phone, email');
  if (error) throw error;
  return data && data.length ? data[0] : null;
}

/**
 * Earlier review-email failures for the Try again idempotency-key rule:
 * { count, lastStatus, lastKey } — the number of review_request_failed rows,
 * the status and the idempotency key in the most recent one's meta
 * ({ status, key } is written by sendReviewRequest: an HTTP status number
 * or 'timeout', plus the "<uuid>:review[:rN]" key used for that attempt;
 * lastKey is null for legacy rows written before the key was recorded).
 * Rows only, no new tables or columns.
 */
export async function getReviewFailureInfo(leadId) {
  const { data, error } = await db()
    .from('lead_events')
    .select('meta, created_at')
    .eq('lead_id', leadId)
    .eq('kind', 'review_request_failed')
    .order('created_at', { ascending: false });
  if (error) throw error;
  const rows = data || [];
  const last = rows.length ? (rows[0].meta || {}) : {};
  return {
    count: rows.length,
    lastStatus: rows.length ? last.status : null,
    lastKey: rows.length && typeof last.key === 'string' ? last.key : null,
  };
}

/** True once a review email was successfully sent: a review_requested event
 *  row exists (sendReviewRequest writes review_request_failed instead when
 *  the send fails, so the token alone does not prove a send). */
export async function hasReviewSent(leadId) {
  const { data, error } = await db()
    .from('lead_events')
    .select('id')
    .eq('lead_id', leadId)
    .eq('kind', 'review_requested')
    .limit(1);
  if (error) throw error;
  return (data || []).length > 0;
}

/* ---------- events / rate limits ---------- */

export async function addEvent(leadId, kind, meta) {
  const { error } = await db().from('lead_events').insert({ lead_id: leadId, kind, meta: meta || {} });
  if (error) throw error;
}

/** Drop one rate-limit key. Used as the release half of a mutex: the claim is
 *  held only while the guarded work runs, so a later call is allowed again. */
export async function clearRateLimit(key) {
  const { error } = await db().from('rate_limits').delete().eq('key', key);
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

/* ---------- recipients (one business, several phones) ---------- */

/** How many chats are bound to a business. */
export async function countBusinessChats(businessId) {
  const { count, error } = await db()
    .from('business_chats')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', businessId);
  if (error) throw error;
  return count || 0;
}

/** Phone counts for several businesses in ONE query: Map(business id -> count).
 *  A business with no phone is simply absent from the rows and counts as 0. */
export async function countChatsForBusinesses(businessIds) {
  const ids = [...new Set((businessIds || []).map(String))];
  const out = new Map(ids.map((id) => [id, 0]));
  if (!ids.length) return out;
  const { data, error } = await db()
    .from('business_chats')
    .select('business_id')
    .in('business_id', ids);
  if (error) throw error;
  for (const r of data || []) out.set(String(r.business_id), (out.get(String(r.business_id)) || 0) + 1);
  return out;
}

/** Unused codes that have not expired yet — the "pending invites" a business has out. */
export async function countLiveBindCodes(businessId) {
  const { count, error } = await db()
    .from('bind_codes')
    .select('code', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString());
  if (error) throw error;
  return count || 0;
}

/** Pending invites, soonest expiry first. Never selects the code itself: the
    caller only needs to say how many there are and when each one lapses. */
export async function listLiveBindCodes(businessId) {
  const { data, error } = await db()
    .from('bind_codes')
    .select('expires_at')
    .eq('business_id', businessId)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('expires_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

/**
 * Expire every unused code for one business, scoped by business_id. Used only
 * by the owner's "cancel old invites" tap. A code redeemed between the list and
 * the tap is already used, so the used_at predicate leaves it alone.
 */
export async function expireLiveBindCodes(businessId) {
  const { data, error } = await db()
    .from('bind_codes')
    .update({ expires_at: new Date().toISOString() })
    .eq('business_id', businessId)
    .is('used_at', null)
    .select('code');
  if (error) throw error;
  return (data || []).length;
}

/**
 * Expire every LIVE unused code of one business except `keepCode`, scoped by
 * business_id. Used right after the operator's new invite is stored, so the
 * new code is the only one that can still connect a phone. Only codes that
 * were still live are touched, so the returned number is the number of
 * invites that were actually cancelled. A used code is never touched.
 */
export async function expireOtherBindCodes(businessId, keepCode) {
  const now = new Date().toISOString();
  const { data, error } = await db()
    .from('bind_codes')
    .update({ expires_at: now })
    .eq('business_id', businessId)
    .neq('code', keepCode)
    .is('used_at', null)
    .gt('expires_at', now)
    .select('code');
  if (error) throw error;
  return (data || []).length;
}

/** Expire ONE unused code, scoped by BOTH the business and the code. Used to
 *  take back an invite that was stored for a step that then did not happen. */
export async function expireBindCode(businessId, code) {
  const { data, error } = await db()
    .from('bind_codes')
    .update({ expires_at: new Date().toISOString() })
    .eq('business_id', businessId)
    .eq('code', code)
    .is('used_at', null)
    .select('code');
  if (error) throw error;
  return (data || []).length;
}

/** Bind order, oldest first, with the row id so it can be addressed in a callback. */
export async function listBusinessChatsDetailed(businessId) {
  const { data, error } = await db()
    .from('business_chats')
    .select('id, tg_chat_id, label, created_at')
    .eq('business_id', businessId)
    // created_at first (the owner is the oldest phone), id as a deterministic
    // tiebreak: two rows written in the same millisecond must not swap order
    // between requests, or "the main phone" changes at random.
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw error;
  return data || [];
}

/** One chat row, scoped by business. Never by id alone. */
export async function getBusinessChat(businessId, rowId) {
  const { data, error } = await db()
    .from('business_chats')
    .select('id, tg_chat_id, label')
    .eq('business_id', businessId)
    .eq('id', rowId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * Delete one chat row, scoped by BOTH the business and the row id.
 * Returns the number of rows removed, so a second tap can tell "already gone"
 * from "removed now" without a read-then-write race.
 */
export async function removeBusinessChat(businessId, rowId) {
  const { data, error } = await db()
    .from('business_chats')
    .delete()
    .eq('business_id', businessId)
    .eq('id', rowId)
    .select('id');
  if (error) throw error;
  return (data || []).length;
}

/**
 * Operator "Replace phone": every chat of ONE business, in one statement
 * scoped by that business id. Returns the chat ids that were actually
 * deleted, so a second call (or a race) reports nothing removed.
 */
export async function removeAllBusinessChats(businessId) {
  const { data, error } = await db()
    .from('business_chats')
    .delete()
    .eq('business_id', businessId)
    .select('tg_chat_id');
  if (error) throw error;
  return (data || []).map((r) => r.tg_chat_id);
}

/**
 * The chat's binding, with the status of the business it belongs to in the
 * SAME query (the foreign key business_chats.business_id -> businesses.id is
 * embedded), so knowing whether the business is suspended costs no extra
 * round trip. Returns { business_id, business_status } or null.
 *
 * If the embed itself is refused (PostgREST cannot see the relationship), the
 * binding is read without it and business_status is null: the bot keeps
 * working and the failure is logged, because losing every chat is worse than
 * not knowing one status. Any other error is thrown as before.
 */
const EMBED_REFUSED = new Set(['PGRST200', 'PGRST201']);
export async function getChatBinding(chatId) {
  const first = await db()
    .from('business_chats')
    .select('business_id, businesses(status)')
    .eq('tg_chat_id', chatId)
    .maybeSingle();
  if (!first.error) {
    if (!first.data) return null;
    const b = Array.isArray(first.data.businesses) ? first.data.businesses[0] : first.data.businesses;
    return { business_id: first.data.business_id, business_status: (b && b.status) || null };
  }
  if (!EMBED_REFUSED.has(String(first.error.code))) throw first.error;
  console.error('binding_status_embed_refused', first.error.code);
  const { data, error } = await db()
    .from('business_chats')
    .select('business_id')
    .eq('tg_chat_id', chatId)
    .maybeSingle();
  if (error) throw error;
  return data ? { business_id: data.business_id, business_status: null } : null;
}

export async function bindChat(businessId, chatId) {
  // Last guard: the operator chat must never become a business phone. The
  // command paths refuse earlier; this catches any new caller.
  if (isOperatorChat(chatId)) {
    const err = new Error('operator_chat');
    err.code = 'operator_chat';
    throw err;
  }
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

/**
 * Undo a claim when the bind that followed it did not take. Scoped by code AND
 * business_id, and only while the row is still used: if anything else already
 * consumed or expired it, this changes nothing.
 */
export async function restoreBindCode(code, businessId) {
  const { data, error } = await db()
    .from('bind_codes')
    .update({ used_at: null })
    .eq('code', code)
    .eq('business_id', businessId)
    .not('used_at', 'is', null)
    .select('code');
  if (error) throw error;
  return (data || []).length;
}

/** Drop a retry lock older than the cutoff, so a crashed attempt cannot block a lead. */
export async function clearStaleRetryLock(key, olderThanIso) {
  const { error } = await db()
    .from('rate_limits')
    .delete()
    .eq('key', key)
    .lt('window_start', olderThanIso);
  if (error) throw error;
}

/**
 * The state of a code without claiming it. Used to tell the operator the truth
 * when they open a client's link: live, used, expired, or not a code at all.
 */
export async function getBindCodeState(code) {
  const { data, error } = await db()
    .from('bind_codes')
    .select('used_at, expires_at')
    .eq('code', code)
    .maybeSingle();
  if (error) throw error;
  if (!data) return 'unknown';
  if (data.used_at) return 'used';
  if (new Date(data.expires_at).getTime() <= Date.now()) return 'expired';
  return 'live';
}

export async function createBindCode(code, businessId, expiresAt) {
  const { error } = await db().from('bind_codes').insert({ code, business_id: businessId, expires_at: expiresAt });
  if (error) throw error;
}
