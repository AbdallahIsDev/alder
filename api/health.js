// Vercel serverless function: GET /api/health
//
// Operational counts only. No PII, no business names, no env values — every
// field is a number or a boolean. Protected by a shared secret in a header,
// compared in constant time; 503 when the secret is not configured so an
// unprotected deployment is obvious rather than silently open.
//
// Counts come from public.lead_events. Note: there is no index on
// (kind, created_at) today, so each count is a sequential scan. That is
// microseconds at the current table size; see the handoff for the proposed index.

import { createClient } from '@supabase/supabase-js';
import { secretMatches } from '../lib/request.js';
import { operatorChatId, operatorEmail, operatorReachable } from '../lib/operator.js';

const HEADER = 'x-health-secret';
const KINDS = [
  'created',
  'tg_sent',
  'tg_failed',
  'email_owner_sent',
  'email_owner_failed',
  'autoreply_failed',
  'review_request_failed',
];
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

let client = null;
function db() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('db_not_configured');
  if (!client) {
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { 'x-application-name': 'alder-health' } },
    });
  }
  return client;
}

/** One head-only count per kind, in parallel. Rows never leave the database. */
async function countsSince(iso) {
  const out = {};
  await Promise.all(KINDS.map(async (kind) => {
    const { count, error } = await db()
      .from('lead_events')
      .select('id', { count: 'exact', head: true })
      .eq('kind', kind)
      .gte('created_at', iso);
    if (error) throw error;
    out[kind] = count || 0;
  }));
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  res.setHeader('Cache-Control', 'no-store');

  const expected = process.env.HEALTH_SECRET;
  if (!expected) return res.status(503).json({ ok: false });
  if (!secretMatches(req, HEADER, expected)) return res.status(401).json({ ok: false });

  try {
    const now = Date.now();
    const [lastHour, lastDay] = await Promise.all([
      countsSince(new Date(now - HOUR).toISOString()),
      countsSince(new Date(now - DAY).toISOString()),
    ]);
    return res.status(200).json({
      ok: true,
      last_hour: lastHour,
      last_24h: lastDay,
      mail_redirect_active: !!process.env.MAIL_REDIRECT_TO,
      webhook_secret_set: !!process.env.TELEGRAM_WEBHOOK_SECRET,
      salt_set: !!process.env.IP_HASH_SALT,
      // The operator alarm has nowhere to go when both are unset, which is the
      // one failure mode that would otherwise be silent (the log line is
      // operator_alarm_undelivered; this is the durable flag).
      operator_chat_set: !!operatorChatId(),
      operator_email_set: !!operatorEmail(),
      operator_reachable: operatorReachable(),
    });
  } catch (e) {
    console.error('health_query_failed', (e && e.code) || 'no_code');
    return res.status(500).json({ ok: false });
  }
}
