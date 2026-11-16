// Vercel serverless function: GET /api/billing
//
// The daily billing job, on its own: warnings to overdue businesses, the final
// warning, automatic suspension at the end of the grace period, and one
// summary for the operator. The rules are lib/billing.js; the job is
// runBillingJob() in lib/billing-ops.js.
//
// It is NOT scheduled from here. The same job runs inside the daily
// /api/selfcheck cron (see vercel.json), so billing adds no cron job to the
// project. This endpoint exists to run the job by hand, and so that a cron
// entry can be pointed at it later without touching code. Running it twice a
// day is harmless: the job is idempotent.
//
// Auth: the scheduled endpoints' rule (lib/request.js scheduledAuth):
// x-health-secret (HEALTH_SECRET), or `Authorization: Bearer <CRON_SECRET>`.
// 503 when HEALTH_SECRET is unset. The response is counts only: no business
// name, no chat id, no address.

import { scheduledAuth } from '../lib/request.js';
import { runBillingJob } from '../lib/billing-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  res.setHeader('Cache-Control', 'no-store');
  const auth = scheduledAuth(req);
  if (auth === 'missing_env') return res.status(503).json({ ok: false });
  if (auth !== 'ok') return res.status(401).json({ ok: false });
  try {
    return res.status(200).json(await runBillingJob());
  } catch (e) {
    console.error('billing_job_failed', (e && e.code) || 'no_code');
    return res.status(500).json({ ok: false });
  }
}
