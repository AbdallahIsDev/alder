// Vercel serverless function: GET /api/selfcheck
//
// Daily operational self-check. Reads the event counts for the last 24 hours per
// business and sends ONE message to the businesses that need one. Clean state
// sends nothing.
//
// Who is told what:
//   demo    the operator's own businesses. Told when one of their sends failed
//           OR when the email redirect is on, because a redirect is an
//           operator-level fact and only a demo business may see it.
//   active  a client. Told only when one of ITS OWN sends failed, with only its
//           own counts, and never any operator text.
//
// Counts only — no names, no addresses, no lead data, no env values. The message
// is per business: a demo business is never told about another business's
// failures, which is what the old global counter did.
//
// Auth: x-health-secret (HEALTH_SECRET), or `Authorization: Bearer <CRON_SECRET>`
// so a Vercel cron can call it — Vercel sends its own CRON_SECRET as a bearer
// token. The two secrets are independent: the health secret is not accepted as a
// bearer and the cron secret is not accepted in the header. Both comparisons are
// constant time. 503 when HEALTH_SECRET is unset.

import { secretMatches } from '../lib/request.js';
import { listBusinessChats, listActiveBusinesses } from '../lib/db.js';
import { sendMessage } from '../lib/tg.js';
import { sendMail } from '../lib/mail.js';
import { deliverToBusinesses } from '../lib/ops-delivery.js';
import { selfCheckEmail } from '../lib/email-builders.js';
import { eventCountsByBusiness } from '../lib/digest-db.js';
import { selfCheckText, shouldAlertBusiness, failedTotal } from '../lib/ops-copy.js';

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

/* One delivery path, shared with /api/digest: Telegram first, the same text by
   email only when no chat received it. The name stays for the handler and the
   tests that drive it directly. */
export const deliverSelfCheck = deliverToBusinesses;

/**
 * Who gets a message. Kept as a pure function so the audience rule can be tested
 * without a database: `businesses` is a list of { id, status }, `counts` maps a
 * business id to its own per-kind counts.
 */
export function alertTargets({ businesses, counts, redirectActive }) {
  return businesses
    .filter((b) => shouldAlertBusiness({
      status: b.status,
      failed: failedTotal(counts.get(b.id) || {}),
      redirectActive,
    }))
    .map((b) => b.id);
}

/**
 * The message for one business. `operator` is true only for a demo business —
 * the one status that is allowed to see the redirect warning and the setting
 * name. Kept separate from the handler so the audience rule can be exercised
 * without an environment or a network.
 */
export function alertBodyFor(business, day, redirectActive) {
  return selfCheckText(day, { redirectActive, operator: !!business && business.status === 'demo' });
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
    // The redirect only matters where real customers are being served.
    const redirectActive = !!process.env.MAIL_REDIRECT_TO && process.env.VERCEL_ENV === 'production';

    // Every business that is being served, with its OWN counts. A paused or
    // churned client keeps its rows but is not messaged.
    const active = await listActiveBusinesses();
    const counts = await eventCountsByBusiness({ sinceIso: since, kinds: KINDS });
    const failed = active.reduce((a, b) => a + failedTotal(counts.get(b.id) || {}), 0);

    const targets = alertTargets({ businesses: active, counts, redirectActive });
    const dateKey = new Date().toISOString().slice(0, 10);
    if (!targets.length) {
      return res.status(200).json({ ok: true, sent: 0, emailed: 0, deduped: 0, failed, redirect_active: redirectActive });
    }

    const byId = new Map(active.map((b) => [b.id, b]));
    // Worst first: if two businesses share one inbox, the message that survives
    // de-duplication is the one with something wrong, not the quiet one.
    const ordered = [...targets].sort((a, b) => failedTotal(counts.get(b) || {}) - failedTotal(counts.get(a) || {}));

    const { sent, emailed, deduped } = await deliverSelfCheck({
      targets: ordered,
      textFor: (id) => alertBodyFor(byId.get(id), counts.get(id) || {}, redirectActive),
      chatsFor: (id) => listBusinessChats(id),
      sendTg: (chat, body) => sendMessage(chat, body),
      mailKeyFor: (id) => (byId.get(id) || {}).owner_email || null,
      sendMailFor: async (id) => {
        const b = byId.get(id);
        if (!b || !b.owner_email) return { ok: false, status: 'no_owner_email' };
        return sendMail({
          to: b.owner_email,
          fromName: 'Lead Alerts',
          ...selfCheckEmail(counts.get(id) || {}, dateKey, {
            redirectActive,
            operator: b.status === 'demo',
          }),
          idempotencyKey: `selfcheck:${id}:${dateKey}`,
        });
      },
    });
    return res.status(200).json({ ok: true, sent, emailed, deduped, failed, redirect_active: redirectActive });
  } catch (e) {
    console.error('selfcheck_failed', (e && e.code) || 'no_code');
    return res.status(500).json({ ok: false });
  }
}
