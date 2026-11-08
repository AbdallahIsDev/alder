// Vercel serverless function: GET /api/selfcheck
//
// Daily operational self-check. Reads the event counts for the last 24 hours per
// business and produces two independent messages:
//
//   1. OWNER messages — one per business, only when that business's own failure
//      count is non-zero, carrying only its own numbers. Never an aggregate,
//      never a slug, never the redirect warning.
//   2. ONE OPERATOR alarm — problems first, every affected business by slug with
//      its own counts, the "no phone connected" list, and the mail-redirect
//      warning. Telegram to OPERATOR_CHAT_ID, email to OPERATOR_EMAIL as the
//      fallback. If neither is configured the alarm is undeliverable and that is
//      a logged event plus an /api/health flag, not silence.
//
// Counts only in owner messages: no names, no addresses, no lead data, no env
// values. The operator message may name a business by slug, and nothing else.
//
// Auth: x-health-secret (HEALTH_SECRET), or `Authorization: Bearer <CRON_SECRET>`
// so a Vercel cron can call it. The two secrets are independent and neither is
// accepted in the other's place. 503 when HEALTH_SECRET is unset.

import { secretMatches } from '../lib/request.js';
import { listBusinessChats, listActiveBusinesses, sweepExpired } from '../lib/db.js';
import { sendMessage } from '../lib/tg.js';
import { sendMail } from '../lib/mail.js';
import { deliverToBusinesses } from '../lib/ops-delivery.js';
import { selfCheckEmail, operatorAlarmEmail } from '../lib/email-builders.js';
import { eventCountsByBusiness } from '../lib/digest-db.js';
import { selfCheckText, operatorAlarmBody, operatorAlarmText, shouldAlertBusiness, failedTotal } from '../lib/ops-copy.js';
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
const DAY = 24 * 3600 * 1000;

/* One delivery path, shared with /api/digest. */
export const deliverSelfCheck = deliverToBusinesses;

/**
 * Who gets an owner message: a business whose OWN failure count is non-zero.
 * Same rule for demo and active — a demo row is the operator's test business,
 * not an audience for operator text.
 */
export function alertTargets({ businesses, counts }) {
  return businesses
    .filter((b) => shouldAlertBusiness({ status: b.status, failed: failedTotal(counts.get(b.id) || {}) }))
    .map((b) => b.id);
}

/**
 * The operator alarm for one run, or null when there is nothing to say.
 * Exported so the aggregation can be tested without a database.
 */
export function operatorAlarm({ businesses, counts, chatsByBusiness, recentLeadBusinesses, redirectActive }) {
  const rows = businesses
    .filter((b) => failedTotal(counts.get(b.id) || {}) > 0)
    .map((b) => ({ slug: b.slug, day: counts.get(b.id) || {} }));

  // "No phone connected" is a problem only when somebody is actually missing
  // alerts. An empty demo row that never receives a lead is a parked test
  // business, not an incident, and nagging about it every day trains the
  // operator to ignore the alarm.
  const noPhoneSlugs = businesses.filter((b) => {
    const chats = chatsByBusiness ? chatsByBusiness.get(b.id) : [];
    if (chats === null || chats === undefined) return false;   // unknown, not "no phone"
    if (chats.length) return false;
    if (b.status === 'active') return true;
    // Unknown (null) counts as "might have had a lead": say so rather than
    // assuming the business is parked.
    if (recentLeadBusinesses === null) return true;
    return recentLeadBusinesses.has(b.id);
  }).map((b) => b.slug);

  const body = operatorAlarmBody({ rows, redirectActive, noPhoneSlugs });
  return body ? { body, text: operatorAlarmText({ rows, redirectActive, noPhoneSlugs }) } : null;
}

function authorised(req, healthSecret, cronSecret) {
  if (secretMatches(req, HEADER, healthSecret)) return true;
  if (!cronSecret) return false;
  const auth = req && req.headers && req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return secretMatches({ headers: { 'x-bearer': auth.slice(7) } }, 'x-bearer', cronSecret);
  }
  return false;
}

/** Telegram, then email, then a loud log line. Never throws. */
async function deliverOperatorAlarm({ body, text, dateKey }) {
  const chat = operatorChatId();
  if (chat) {
    const r = await sendMessage(chat, text).catch(() => ({ ok: false }));
    if (r && r.ok) return 'telegram';
  }
  const to = operatorEmail();
  if (to) {
    const r = await sendMail({
      to, fromName: 'Lead Alerts', ...operatorAlarmEmail(body, dateKey),
      idempotencyKey: `selfcheck:operator:${dateKey}`,
    }).catch(() => ({ ok: false }));
    if (r && r.ok) return 'email';
  }
  console.error('operator_alarm_undelivered');
  return 'undelivered';
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  res.setHeader('Cache-Control', 'no-store');

  const healthSecret = process.env.HEALTH_SECRET;
  const cronSecret = process.env.CRON_SECRET;
  if (!healthSecret) return res.status(503).json({ ok: false });
  if (!authorised(req, healthSecret, cronSecret)) return res.status(401).json({ ok: false });

  try {
    const since = new Date(Date.now() - DAY).toISOString();
    const redirectActive = !!process.env.MAIL_REDIRECT_TO && process.env.VERCEL_ENV === 'production';

    const active = await listActiveBusinesses();
    const counts = await eventCountsByBusiness({ sinceIso: since, kinds: KINDS });
    const failed = active.reduce((a, b) => a + failedTotal(counts.get(b.id) || {}), 0);

    // One chat query per business; there are a handful, and the operator alarm
    // needs the empty ones to say "no phone connected".
    const chatsByBusiness = new Map();
    for (const b of active) {
      // null means "could not read", which is NOT the same as "no phone": an
      // unreachable query must never be reported as an empty business.
      let chats = null;
      try { chats = await listBusinessChats(b.id); } catch { console.error('operator_chats_unknown'); }
      chatsByBusiness.set(b.id, chats);
    }
    // A demo business with no chat is only worth mentioning if it actually got a
    // lead in the last week.
    // null means "could not tell", which is not the same as "no recent lead":
    // a demo row with no chat is then reported rather than silently excused.
    let recentLeadBusinesses = null;
    try {
      const recent = await eventCountsByBusiness({
        sinceIso: new Date(Date.now() - 7 * DAY).toISOString(), kinds: ['created'],
      });
      recentLeadBusinesses = new Set([...recent.keys()]);
    } catch { console.error('operator_recent_unknown'); }

    const dateKey = new Date().toISOString().slice(0, 10);
    const byId = new Map(active.map((b) => [b.id, b]));
    const targets = alertTargets({ businesses: active, counts });

    let sent = 0;
    let emailed = 0;
    if (targets.length) {
      const r = await deliverSelfCheck({
        targets,
        textFor: (id) => selfCheckText(counts.get(id) || {}),
        chatsFor: (id) => chatsByBusiness.get(id) || [],
        sendTg: (chat, body) => sendMessage(chat, body),
        // No de-duplication: each business's numbers are its own, and dropping
        // one message to protect a shared inbox loses a client's only warning.
        sendMailFor: async (id) => {
          const b = byId.get(id);
          if (!b || !b.owner_email) return { ok: false, status: 'no_owner_email' };
          return sendMail({
            to: b.owner_email,
            fromName: 'Lead Alerts',
            ...selfCheckEmail(counts.get(id) || {}, dateKey, b),
            idempotencyKey: `selfcheck:${id}:${dateKey}`,
          });
        },
      });
      sent = r.sent;
      emailed = r.emailed;
    }

    const alarm = operatorAlarm({ businesses: active, counts, chatsByBusiness, recentLeadBusinesses, redirectActive });
    let operator = 'none';
    if (alarm) operator = await deliverOperatorAlarm({ body: alarm.body, text: alarm.text, dateKey });

    // Housekeeping last, and never able to fail the run: bounded, counts only.
    // A sweep error is a number in the log, not a 500 on the daily check.
    let swept = { codes: 0, limits: 0, failed: 0 };
    try { swept = await sweepExpired(); } catch { swept.failed++; }
    console.error('housekeeping_swept', swept.codes, swept.limits, swept.failed);

    return res.status(200).json({
      ok: true, sent, emailed, failed, redirect_active: redirectActive,
      operator, operator_reachable: operatorReachable(),
    });
  } catch (e) {
    console.error('selfcheck_failed', (e && e.code) || 'no_code');
    return res.status(500).json({ ok: false });
  }
}
