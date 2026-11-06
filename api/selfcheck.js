// Vercel serverless function: GET /api/selfcheck
//
// Daily operational self-check. Reads the same event counts as /api/health and,
// only when something is wrong, sends ONE plain-text Telegram message to the
// bound chat(s) of the affected business(es). Clean state sends nothing.
//
// "Wrong" means: any *_failed event in the last 24 h, or MAIL_REDIRECT_TO set
// while VERCEL_ENV is production (every customer email is going to the test
// address). Counts only — no names, no addresses, no env values.
//
// Auth: x-health-secret, or `Authorization: Bearer <HEALTH_SECRET>` so a Vercel
// cron can call it (Vercel sends CRON_SECRET as a bearer token; set CRON_SECRET
// to the same value as HEALTH_SECRET). Both are compared in constant time.

import { createClient } from '@supabase/supabase-js';
import { secretMatches } from '../lib/request.js';
import { listBusinessChats } from '../lib/db.js';
import { sendMessage } from '../lib/tg.js';

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
const FAILED_KINDS = ['tg_failed', 'email_owner_failed', 'autoreply_failed', 'review_request_failed'];
const DAY = 24 * 3600 * 1000;

let client = null;
function db() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('db_not_configured');
  if (!client) {
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { 'x-application-name': 'alder-selfcheck' } },
    });
  }
  return client;
}

/** The rule, kept separate so it can be tested without a database. */
export function shouldAlert({ failedTotal, redirectActive }) {
  return failedTotal > 0 || redirectActive;
}

/** The message. Counts only: no business name, no lead data, no env values. */
export function selfCheckText(day, { redirectActive }) {
  const lines = ['Lead alerts self-check', '', 'Last 24 hours'];
  for (const k of KINDS) lines.push(`${k} ${day[k] || 0}`);
  const failed = FAILED_KINDS.reduce((a, k) => a + (day[k] || 0), 0);
  if (failed) {
    lines.push('');
    lines.push(failed === 1 ? '1 alert did not go out.' : `${failed} alerts did not go out.`);
  }
  if (redirectActive) {
    lines.push('');
    lines.push('Email redirect is ON in production: customer email is going to the test address.');
  }
  return lines.join('\n');
}

/** Who gets told: everyone when the redirect is swallowing all mail, otherwise
 *  only the businesses that own a failed event. */
export function alertTargets({ redirectActive, failedByBusiness, allBusinessIds }) {
  return redirectActive ? [...allBusinessIds] : [...failedByBusiness.keys()];
}

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

/** business_id -> { kind: count } for the failed kinds in the window. */
async function failuresByBusiness(iso) {
  const { data: evs, error } = await db()
    .from('lead_events')
    .select('lead_id, kind')
    .in('kind', FAILED_KINDS)
    .gte('created_at', iso)
    .limit(5000);
  if (error) throw error;
  const ids = [...new Set((evs || []).map((e) => e.lead_id))];
  if (!ids.length) return new Map();

  const { data: leads, error: leadErr } = await db()
    .from('leads')
    .select('id, business_id')
    .in('id', ids);
  if (leadErr) throw leadErr;
  const businessOf = new Map((leads || []).map((l) => [l.id, l.business_id]));

  const out = new Map();
  for (const e of evs) {
    const biz = businessOf.get(e.lead_id);
    if (!biz) continue;
    const m = out.get(biz) || {};
    m[e.kind] = (m[e.kind] || 0) + 1;
    out.set(biz, m);
  }
  return out;
}

function authorised(req, expected) {
  if (secretMatches(req, HEADER, expected)) return true;
  const auth = req && req.headers && req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return secretMatches({ headers: { 'x-bearer': auth.slice(7) } }, 'x-bearer', expected);
  }
  return false;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  res.setHeader('Cache-Control', 'no-store');

  const expected = process.env.HEALTH_SECRET;
  if (!expected) return res.status(503).json({ ok: false });
  if (!authorised(req, expected)) return res.status(401).json({ ok: false });

  try {
    const since = new Date(Date.now() - DAY).toISOString();
    const day = await countsSince(since);
    const failedTotal = FAILED_KINDS.reduce((a, k) => a + (day[k] || 0), 0);
    // The redirect only matters where real customers are being served.
    const redirectActive = !!process.env.MAIL_REDIRECT_TO && process.env.VERCEL_ENV === 'production';

    if (!shouldAlert({ failedTotal, redirectActive })) {
      return res.status(200).json({ ok: true, sent: 0, failed: 0, redirect_active: redirectActive });
    }

    // Who to tell: the businesses that own the failed events, or every business
    // with a bound chat when the redirect is swallowing everyone's mail.
    let allBusinessIds = [];
    if (redirectActive) {
      const { data: biz } = await db().from('businesses').select('id');
      allBusinessIds = (biz || []).map((b) => b.id);
    }
    const targets = alertTargets({
      redirectActive,
      failedByBusiness: redirectActive ? new Map() : await failuresByBusiness(since),
      allBusinessIds,
    });

    const text = selfCheckText(day, { redirectActive });
    let sent = 0;
    for (const id of targets) {
      const chats = await listBusinessChats(id).catch(() => []);
      for (const chat of chats) {
        const r = await sendMessage(chat, text).catch(() => ({ ok: false }));
        if (r && r.ok) sent++;
      }
    }
    return res.status(200).json({ ok: true, sent, failed: failedTotal, redirect_active: redirectActive });
  } catch (e) {
    console.error('selfcheck_failed', (e && e.code) || 'no_code');
    return res.status(500).json({ ok: false });
  }
}
