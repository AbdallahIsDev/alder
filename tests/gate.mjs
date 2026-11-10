// tests/gate.mjs — the decision that a suite run is allowed to start.
//
// It used to be "not production, unless ALLOW_PROD_TESTS=1". The escape hatch is
// gone: a suite run needs TEST_ENV=1 and a .env.test that points somewhere other
// than .env. Nothing in the runner can override that.
//
// Pure on purpose: the matrix is tested without spawning a runner, and the
// spawn test proves the runner actually calls it.

export const GATE = Object.freeze({
  OK: 'ok',
  NO_TEST_ENV: 'no-test-env',
  NO_ENV_FILE: 'no-env-file',
  NO_URL: 'no-url',
  SAME_AS_ENV: 'same-as-env',
});

/**
 * @param {object} input
 * @param {boolean} input.testEnv      TEST_ENV=1 was set
 * @param {boolean} input.hasEnvTest   .env.test exists
 * @param {string}  input.prodReason   checkNotProduction().reason: 'ok' | 'no-url' | 'same-as-env'
 * @returns {{ok: boolean, reason: string, detail: string}} detail never contains a URL or a value
 */
export function suiteRunGate({ testEnv, hasEnvTest, prodReason }) {
  if (!testEnv) return { ok: false, reason: GATE.NO_TEST_ENV, detail: 'TEST_ENV=1 is not set' };
  if (!hasEnvTest) return { ok: false, reason: GATE.NO_ENV_FILE, detail: '.env.test is missing' };
  if (prodReason === 'no-url') return { ok: false, reason: GATE.NO_URL, detail: 'SUPABASE_URL is not set' };
  if (prodReason !== 'ok') {
    return { ok: false, reason: GATE.SAME_AS_ENV, detail: 'SUPABASE_URL still matches .env (production)' };
  }
  return { ok: true, reason: GATE.OK, detail: 'test project' };
}
