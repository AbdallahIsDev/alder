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
 * The ONLY keys a suite may sweep: its own "<8 alnum>-<suffix>" run keys and the
 * runner's "canary-". Deliberately narrow:
 *   manual-test-  the owner's scripts/send-test-lead.mjs leads, never swept
 *   form-         a real no-JS visitor gets the same shape
 *   measure-      a one-off manual probe, not a suite run
 */
export const TEST_KEY = /^([a-z0-9]{8}|canary)-/;
// A UUID's first segment is 8 hex characters, so it ALSO matches TEST_KEY. The
// exclusion is not optional: without it a sweep would delete page-minted leads.
export const isTestKey = (k) => typeof k === 'string' && !UUID_KEY.test(k) && TEST_KEY.test(k);

/**
 * The reserved marker every suite-seeded lead carries: an address at the
 * RFC 2606 `.invalid` TLD, which can never receive mail. A test-shaped key is
 * already impossible for a real submission (the page mints UUIDs), but a sweep
 * should need two independent signals before deleting a row from a production
 * table. This is the second one.
 */
export const FIXTURE_EMAIL_DOMAIN = 'fixture.invalid';
export const fixtureEmail = (local) => `${local}@${FIXTURE_EMAIL_DOMAIN}`;
export const hasFixtureMarker = (row) =>
  typeof (row && row.email) === 'string'
  && row.email.toLowerCase().endsWith('@' + FIXTURE_EMAIL_DOMAIN);

/** Both signals: the suite key shape AND the reserved email marker. */
export const isFixtureLead = (row) => isTestKey(row && row.idempotency_key) && hasFixtureMarker(row);

/**
 * PostgREST returns at most 1000 rows per request and says nothing when it
 * truncates. A sweep that reads only the first page leaves the rest behind
 * forever, so every unbounded select goes through this.
 */
export async function fetchAllRows(build, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = data || [];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

/**
 * Delete test-shaped leads older than `beforeIso` for the given businesses.
 *
 * A suite calls this at start AND in its finally: a run killed mid-way (a shell
 * timeout, a crash) never reaches the finally, so the next run must clear what
 * the last one left. Real submissions always carry a UUID key, so they are never
 * matched; the reserved email marker is the second, independent condition.
 */
export async function sweepTestLeads(svc, businessIds, beforeIso) {
  const rows = await fetchAllRows(() => svc.from('leads')
    .select('id, idempotency_key, email').in('business_id', businessIds).lt('created_at', beforeIso));
  const ids = rows.filter(isFixtureLead).map((r) => r.id);
  if (!ids.length) return 0;
  const { data: gone, error } = await svc.from('leads').delete().in('id', ids).select('id');
  if (error) {
    // Report what actually happened; never pretend the rows are gone.
    console.error('sweep_test_leads_failed', error.code || 'no_code');
    return 0;
  }
  return (gone || []).length;
}
