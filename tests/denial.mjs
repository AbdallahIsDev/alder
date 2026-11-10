// tests/denial.mjs — why did the anon read fail?
//
// db-wall exists to prove the public key can read nothing. "It returned an error"
// is not proof: a retired or mistyped key also returns an error, and the suite
// would go green while proving nothing. This classifier separates the two.
//
// The shapes come from PostgREST: a denied table returns 403 with code 42501 and
// "permission denied for table ..."; a bad key returns 401 with "Invalid API key"
// (or an expired JWT). A network failure has neither.

export const DENIAL = Object.freeze({
  NONE: 'none',
  RLS: 'rls',
  INVALID_KEY: 'invalid-key',
  NETWORK: 'network',
  SCHEMA: 'schema',
  UNKNOWN: 'unknown',
});

/** Classify a supabase-js error object (or a thrown fetch error). */
export function classifyAnonDenial(error) {
  if (!error) return DENIAL.NONE;
  const code = String(error.code || '');
  const msg = String(error.message || error || '');
  if (/invalid api key|invalid jwt|jwt expired|no api key|missing api key|unauthorized/i.test(msg)) {
    return DENIAL.INVALID_KEY;
  }
  if (code === '42501' || /permission denied|row-level security|rls/i.test(msg)) {
    return DENIAL.RLS;
  }
  if (code === 'PGRST106' || /schema must be one of|invalid schema|schema .* not exposed/i.test(msg)) {
    return DENIAL.SCHEMA;
  }
  if (/fetch failed|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg)) {
    return DENIAL.NETWORK;
  }
  return DENIAL.UNKNOWN;
}

/**
 * The only two outcomes that prove a table wall: a permission denial, or a read
 * that succeeded and returned no rows. Everything else is a failure.
 */
export function isWallProof({ error, rows }) {
  if (error) return classifyAnonDenial(error) === DENIAL.RLS;
  return Array.isArray(rows) && rows.length === 0;
}

/**
 * A private schema is proven by PostgREST refusing the schema itself (PGRST106),
 * which is a different rejection from a table-level denial. Kept separate so the
 * broader category can never make a table check pass.
 */
export function isSchemaProof({ error }) {
  return classifyAnonDenial(error) === DENIAL.SCHEMA;
}
