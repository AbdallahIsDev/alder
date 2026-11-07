// tests/env.mjs — suite-side shim over lib/env.js, plus the network guard.
//
// The loader itself lives in lib/env.js so scripts and tests cannot drift apart.
// loadEnv() fills process.env in place and is safe to call twice.
//
// Precedence: process.env > .env.test (only when TEST_ENV=1) > .env.local > .env
// Values are never printed.
//
// NETWORK GUARD
// -------------
// Importing this file replaces globalThis.fetch with a wrapper that throws on any
// request whose host is not loopback and not the Supabase project's host. It is
// installed here, not in a suite, because every suite imports this module and a
// suite that forgets to opt in is exactly the suite that reaches production.
//
// Why: a test once set VERCEL_ENV=production to exercise a flag. That switches
// off every loopback override in lib/outbound.js, so two requests went to
// api.telegram.org and api.resend.com. Both were rejected upstream, but the guard
// should have made the mistake impossible rather than merely unlucky.
//
// What is allowed: 127.0.0.1, localhost, ::1 (the fakes and `vercel dev`), and
// the exact host of SUPABASE_URL (the suites read a real database). Everything
// else throws `network_guard_blocked` before a socket is opened.
//
// Scripts do NOT import this file, so live-smoke, tg-commands, send-test-lead and
// the other operator tools are unaffected.

import { loadEnv as loadEnvShared } from '../lib/env.js';

export {
  parseDotEnvText,
  applyDotEnvEntries,
  envFileNames,
  readEnvFile,
  checkNotProduction,
  sameSupabaseUrl,
} from '../lib/env.js';

export function loadEnv(opts) {
  return loadEnvShared(opts);
}

/** Marks a fetch function as the guarded wrapper, so a test can prove it is on. */
export const GUARDED = Symbol.for('alder.networkGuard');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function hostOf(value) {
  try {
    const u = new URL(typeof value === 'string' ? value : (value && value.url) || String(value));
    return u.hostname;
  } catch {
    return null;
  }
}

/**
 * The predicate, pure and exported so a test can check it without a socket.
 * A relative URL (no host) is not blocked: it can only reach the page's origin.
 */
export function isBlockedUrl(value, supabaseUrl = process.env.SUPABASE_URL) {
  const host = hostOf(value);
  if (!host) return false;
  if (LOOPBACK.has(host)) return false;
  const sb = hostOf(supabaseUrl || '');
  if (sb && host === sb) return false;
  return true;
}

/**
 * Install the guard. Idempotent: a second call is a no-op, so a suite that
 * imports this module twice does not wrap the wrapper.
 * Returns the uninstall function.
 */
export function installNetworkGuard({ supabaseUrl } = {}) {
  if (globalThis.fetch && globalThis.fetch[GUARDED]) {
    return () => { /* already installed by another import */ };
  }
  const real = globalThis.fetch;
  const guarded = function guardedFetch(input, init) {
    // Resolved per call, not at install time: this module is imported before
    // any suite calls loadEnv(), so SUPABASE_URL may not be set yet.
    if (isBlockedUrl(input, supabaseUrl || process.env.SUPABASE_URL)) {
      // Thrown, not returned: a blocked request must look like a bug in the
      // test, not like a network timeout the code under test can swallow.
      throw new Error('network_guard_blocked');
    }
    return real.call(globalThis, input, init);
  };
  guarded[GUARDED] = true;
  guarded.real = real;
  globalThis.fetch = guarded;
  return () => {
    if (globalThis.fetch === guarded) globalThis.fetch = real;
  };
}

installNetworkGuard();
