// lib/housekeeping.js — bounded deletion of rows nobody needs any more.
//
// Two tables grow without bound and neither has a retention rule in the schema:
//
//   bind_codes  unused codes whose expiry is more than 7 days past. A USED code
//               is never touched: it is the audit trail for who connected when.
//   rate_limits (key, window_start) rows whose window ended more than 2 days
//               ago. hit_rate_limit() already prunes these on every call; this
//               is a belt-and-braces sweep for quiet deployments.
//
// The I/O is injected so the rules can be tested without a database, and so the
// only file that talks to Supabase stays lib/db.js. Every run is bounded: at
// most 1000 rows are read, deletes go in chunks of 100, and a failure in one
// table never stops the other or throws to the caller.

export const CODE_RETENTION_DAYS = 7;
export const LIMIT_RETENTION_DAYS = 2;
export const SWEEP_BATCH = 1000;
const CHUNK = 100;
const DAY = 86400000;

export async function sweepExpired(io, { now = Date.now(), batch = SWEEP_BATCH } = {}) {
  const out = { codes: 0, limits: 0, failed: 0 };
  const codeCutoff = new Date(now - CODE_RETENTION_DAYS * DAY).toISOString();
  const limitCutoff = new Date(now - LIMIT_RETENTION_DAYS * DAY).toISOString();

  try {
    const codes = (await io.listCodes(codeCutoff, batch)).slice(0, batch);
    for (let i = 0; i < codes.length; i += CHUNK) {
      out.codes += await io.deleteCodes(codes.slice(i, i + CHUNK), codeCutoff);
    }
  } catch {
    out.failed++;
  }

  try {
    const keys = [...new Set(await io.listLimits(limitCutoff, batch))].slice(0, batch);
    for (let i = 0; i < keys.length; i += CHUNK) {
      out.limits += await io.deleteLimits(keys.slice(i, i + CHUNK), limitCutoff);
    }
  } catch {
    out.failed++;
  }

  return out;
}
