// lib/request.js — request helpers shared by the endpoints.
//
// One copy of clientIp(): api/lead.js and api/review.js each had their own, and
// the two must agree or a caller could be rate-limited on one route and not the
// other.

import { timingSafeEqual } from 'node:crypto';

/**
 * The caller's IP, for rate-limit keys only. Never logged, never stored raw.
 *
 * Order matters. On Vercel the edge sets `x-real-ip` (and `x-vercel-forwarded-for`)
 * and a client cannot overwrite them, so the first two are trustworthy there.
 * `x-forwarded-for` is the LAST resort because its left-most entry is whatever the
 * client sent: if this code ever runs off Vercel (self-hosted, behind a plain proxy),
 * an attacker can rotate that header and walk straight past the per-IP limit. The
 * per-business limit and the daily auto-reply cap still apply in that case.
 */
export function clientIp(req) {
  const first = (v) => String(v || '').split(',')[0].trim();
  const headers = (req && req.headers) || {};
  return (
    first(headers['x-real-ip']) ||
    first(headers['x-vercel-forwarded-for']) ||
    first(headers['x-forwarded-for']) ||
    String((req && req.socket && req.socket.remoteAddress) || '')
  );
}

/**
 * Constant-time comparison of a secret carried in a header.
 * Length is compared first (timingSafeEqual throws on a length mismatch); the
 * length of a shared secret is not itself a secret worth hiding.
 * Returns false when either side is missing — callers decide what that means.
 */
export function secretMatches(req, headerName, expected) {
  const got = req && req.headers && req.headers[headerName];
  if (typeof got !== 'string' || typeof expected !== 'string' || expected.length === 0) return false;
  if (got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * The scheduled endpoints' one rule: `x-health-secret` equal to HEALTH_SECRET,
 * or `Authorization: Bearer <CRON_SECRET>` so a Vercel cron can call them. The
 * two secrets are independent and neither is accepted in the other's place.
 * Returns 'missing_env' when HEALTH_SECRET is unset (the caller answers 503),
 * 'ok', or 'refused'.
 */
export function scheduledAuth(req, env = process.env) {
  const healthSecret = env.HEALTH_SECRET;
  const cronSecret = env.CRON_SECRET;
  if (!healthSecret) return 'missing_env';
  if (secretMatches(req, 'x-health-secret', healthSecret)) return 'ok';
  const auth = req && req.headers && req.headers.authorization;
  if (cronSecret && typeof auth === 'string' && auth.startsWith('Bearer ')
    && secretMatches({ headers: { 'x-bearer': auth.slice(7) } }, 'x-bearer', cronSecret)) return 'ok';
  return 'refused';
}
