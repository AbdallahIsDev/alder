// Vercel serverless function: GET /api/digest
//
// Daily owner digest, off by default. For every business that has a bound chat
// or an owner email it counts the last 24 h — new leads, possible repeats,
// leads still untouched after a day, failed alerts — and sends one message.
//
// COUNTS ONLY. No name, phone, email, note or business name appears in the text,
// which is what makes the same body safe to send by email as a fallback.
//
// Time zone: the window is the last 24 h and the date key is the UTC day. A
// roofer in America/Chicago therefore gets "yesterday evening to this evening"
// labelled with the UTC date; that is deliberate (no per-business timezone
// arithmetic in a function that must stay cheap) and documented in the handoff.
//
// Auth is identical to /api/selfcheck: x-health-secret (HEALTH_SECRET) or
// `Authorization: Bearer <CRON_SECRET>`, never one in the other's place, both
// constant time, 503 when HEALTH_SECRET is unset.

import { secretMatches } from '../lib/request.js';
import { hitRateLimit, clearRateLimit } from '../lib/db.js';
import { digestCounts, digestTargets } from '../lib/digest-db.js';
import { deliverToBusinesses } from '../lib/ops-delivery.js';
import { sendMessage } from '../lib/tg.js';
import { sendMail } from '../lib/mail.js';
import { digestEmail } from '../lib/email-builders.js';
import { digestText } from '../lib/ops-copy.js';

// Re-exported so the preview script and the tests keep one import site.
export { digestText };

const HEADER = 'x-health-secret';
const DAY = 24 * 3600 * 1000;
const UNTOUCHED_DEFAULT_DAYS = 14;

/** How far back "untouched" looks. A lead older than this is left alone: it is
 *  either dead or deliberately parked, and a daily nag about it is noise.
 *  Same fallback shape as AUTOREPLY_DAILY_CAP: anything invalid means the default. */
export function digestUntouchedDays() {
  const n = Number(process.env.DIGEST_UNTOUCHED_DAYS || UNTOUCHED_DEFAULT_DAYS);
  return Number.isInteger(n) && n > 0 ? n : UNTOUCHED_DEFAULT_DAYS;
}

/** Off unless explicitly switched on. A cron that fires into a disabled
 *  deployment must be a no-op, not a stream of empty digests. */
export function digestEnabled() {
  return String(process.env.DIGEST_ENABLED || '') === '1';
}

/** A business with nothing to report gets no message at all. */
export function digestHasSomething(day) {
  return day.newLeads > 0 || day.untouched > 0 || day.failed > 0;
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

  if (!digestEnabled()) return res.status(200).json({ ok: true, enabled: false });

  try {
    const now = Date.now();
    const since = new Date(now - DAY).toISOString();
    const cutoff = new Date(now - DAY).toISOString();
    const floor = new Date(now - digestUntouchedDays() * DAY).toISOString();
    const counts = await digestCounts({ sinceIso: since, cutoffIso: cutoff, floorIso: floor });
    const targets = await digestTargets();
    const dateKey = new Date(now).toISOString().slice(0, 10);

    const due = [];
    const chatMap = new Map();
    let skipped = 0;
    for (const t of targets) {
      const day = counts.get(t.id);
      if (!day || !digestHasSomething(day)) continue;
      if (!t.chats.length && !t.ownerEmail) continue;
      // One claim per business per UTC day. A cron retry, or a second scheduler
      // hitting the endpoint, finds the slot taken and sends nothing.
      let claimed = true;
      try { claimed = await hitRateLimit('digest:' + t.id, 86400, 1); } catch { claimed = true; }
      if (!claimed) { skipped++; continue; }
      due.push(t.id);
      chatMap.set(t.id, t.chats);
    }

    if (!due.length) {
      return res.status(200).json({ ok: true, enabled: true, businesses: 0, sent: 0, emailed: 0, skipped });
    }

    const byId = new Map(targets.map((t) => [t.id, t]));
    const { sent, emailed, perTarget } = await deliverToBusinesses({
      targets: due,
      // Per business: the counts differ, even though no count identifies anyone.
      textFor: (id) => digestText(counts.get(id)),
      chatsFor: (id) => chatMap.get(id) || [],
      sendTg: (chat, body) => sendMessage(chat, body),
      sendMailFor: async (id) => {
        const owner = byId.get(id) && byId.get(id).ownerEmail;
        if (!owner) return { ok: false, status: 'no_owner_email' };
        return sendMail({
          to: owner, fromName: 'Lead Alerts', ...digestEmail(counts.get(id), dateKey),
          idempotencyKey: `digest:${id}:${dateKey}`,
        });
      },
    });

    // Nothing reached a business, so the claim is released: the cron retry (or a
    // second scheduler run) may try again the same day. Only an exact key is
    // deleted — never a range, never a prefix.
    let released = 0;
    for (const id of due) {
      const r = perTarget.get(id);
      if (!r || r.sent || r.emailed) continue;
      try { await clearRateLimit('digest:' + id); released++; } catch { /* the day's slot stays taken */ }
    }

    return res.status(200).json({ ok: true, enabled: true, businesses: due.length, sent, emailed, released, skipped });
  } catch (e) {
    console.error('digest_failed', (e && e.code) || 'no_code');
    return res.status(500).json({ ok: false });
  }
}
