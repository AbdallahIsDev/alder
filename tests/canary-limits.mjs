// tests/canary-limits.mjs — clear the canary business's rate-limit rows.
//
// The canary posts one lead before any suite. The business limit is per hour, so a
// handful of runs in an hour makes the canary answer 429 and the runner aborts with
// "the fake Telegram server received 0 requests" — a test failure that is not one.
// Measured 2026-11-09.
//
// Two rules, both enforced here:
//   1. only when the host is known AND different from the production host in .env;
//   2. at most LIMIT_MAX rows, and only the exact key the lead endpoint uses.

export const LIMIT_MAX = 100;

/**
 * @param {{host?: string, prodHost?: string}} input  the resolved test host and .env's
 * @returns {{ok: boolean, reason: string}}
 */
export function canClearLimits({ host, prodHost }) {
  if (!host) return { ok: false, reason: 'no-host' };
  if (!prodHost) return { ok: false, reason: 'no-production-reference' };
  if (String(host).replace(/\/+$/, '').toLowerCase() === String(prodHost).replace(/\/+$/, '').toLowerCase()) {
    return { ok: false, reason: 'production' };
  }
  return { ok: true, reason: 'test' };
}

/**
 * Delete the rate-limit rows for one business. Returns the number removed.
 * Never throws: a failure here must not take down a run that has already passed
 * its canary.
 */
export async function clearCanaryLimits(svc, businessId, { host, prodHost, max = LIMIT_MAX } = {}) {
  const gate = canClearLimits({ host, prodHost });
  if (!gate.ok) return { cleared: 0, skipped: gate.reason };

  const key = 'biz:' + businessId;
  try {
    const { count, error } = await svc
      .from('rate_limits').select('key', { count: 'exact', head: true }).eq('key', key);
    if (error) return { cleared: 0, skipped: 'count-error' };
    if (!count) return { cleared: 0, skipped: 'none' };
    if (count > max) return { cleared: 0, skipped: 'too-many' };

    const { data, error: delErr } = await svc
      .from('rate_limits').delete().eq('key', key).select('key');
    if (delErr) return { cleared: 0, skipped: 'delete-error' };
    return { cleared: (data || []).length, skipped: null };
  } catch {
    return { cleared: 0, skipped: 'threw' };
  }
}
