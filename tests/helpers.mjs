// tests/helpers.mjs — shared test scaffolding.
//
// Two things used to be copy-pasted into four suites each:
//   fakeRes()   the minimal Vercel response object the in-process handler calls write to
//   'alder-demo' the slug every suite resolves to a business row
//
// Keeping one copy means a change to the stub, or to the seed slug, happens once.
// (A dedicated test business, seeded by the suite itself, is still the better answer;
// that is what the fixture work replaces this constant with.)

/** The seed business every suite resolves through. */
export const ALDER_DEMO = 'alder-demo';

/**
 * Minimal response object: setHeader/status/json/send/end, recording the last body.
 * `body` starts as null unless a suite needs '' (review's page reads it as text).
 */
export function fakeRes({ body = null } = {}) {
  return {
    code: 0,
    body,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
    send(s) { this.body = s; return this; },
    end() { return this; },
  };
}

/** A page-minted key is a UUID; anything else is a test key. */
export const UUID_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Delete test-shaped leads older than `beforeIso` for the given businesses.
 *
 * A suite calls this at start AND in its finally: a run killed mid-way (a shell
 * timeout, a crash) never reaches the finally, so the next run must clear what
 * the last one left. Real submissions always carry a UUID key, so they are never
 * matched.
 */
export async function sweepTestLeads(svc, businessIds, beforeIso) {
  const { data } = await svc.from('leads')
    .select('id, idempotency_key').in('business_id', businessIds).lt('created_at', beforeIso);
  const ids = (data || []).filter((r) => r.idempotency_key && !UUID_KEY.test(r.idempotency_key)).map((r) => r.id);
  if (ids.length) await svc.from('leads').delete().in('id', ids);
  return ids.length;
}
