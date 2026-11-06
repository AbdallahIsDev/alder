// lib/env.js — the one env loader. Scripts and tests all go through this.
//
// Precedence, highest first:
//   process.env  >  .env.test (only when TEST_ENV=1)  >  .env.local  >  .env
//
// Why a single loader: four different copies used to disagree. tests/run.mjs let
// .env.local win, tests/env.mjs let .env win, lead-api read .env only, and
// apply-migrations read .env only on purpose. The moment .env.test exists that
// divergence silently points half the suite at one project and half at another.
//
// "First file that has the key wins" is implemented by filling only missing or
// empty keys, and passing the files in precedence order.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** True when the caller declared test mode: TEST_ENV=1. */
export function isTestEnv(env = process.env) {
  return String(env.TEST_ENV || '') === '1';
}

/** File names in precedence order (highest first). */
export function envFileNames({ testEnv = false } = {}) {
  return testEnv ? ['.env.test', '.env.local', '.env'] : ['.env.local', '.env'];
}

/** Parse one .env text. Returns a fresh object; never prints values. */
export function parseDotEnvText(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/**
 * Apply parsed entries in order, filling only missing/empty keys.
 * Entries must be in precedence order (highest first). A non-empty value already
 * in `env` always wins.
 */
export function applyDotEnvEntries(env, entries) {
  for (const entry of entries || []) {
    const parsed = parseDotEnvText(entry && entry.text);
    for (const [k, v] of Object.entries(parsed)) {
      const cur = env[k];
      if (cur === undefined || cur === null || String(cur).length === 0) env[k] = v;
    }
  }
  return env;
}

function readText(root, name) {
  const p = path.join(root, name);
  try {
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  } catch {
    return '';
  }
}

/** One file's parsed contents, by name. Never throws, never prints. */
export function readEnvFile(name, root = ROOT) {
  return parseDotEnvText(readText(root, name));
}

/**
 * Fill `env` (default process.env) from the env files, in precedence order.
 * Returns { env, sources, files } where sources maps a key to 'process.env' or
 * the file name that supplied it. Values are never returned in `sources`.
 */
export function loadEnv({ env = process.env, root = ROOT, testEnv = isTestEnv(env), files } = {}) {
  const names = files || envFileNames({ testEnv });
  const sources = {};
  for (const k of Object.keys(env)) {
    if (env[k] !== undefined && env[k] !== null && String(env[k]).length > 0) sources[k] = 'process.env';
  }
  const entries = names.map((file) => ({ file, text: readText(root, file) }));
  applyDotEnvEntries(env, entries);
  for (const { file, text } of entries) {
    for (const k of Object.keys(parseDotEnvText(text))) {
      if (sources[k] === undefined) sources[k] = file;
    }
  }
  return { env, sources, files: names };
}

/** Names from `required` (in order) missing or empty in `env`. */
export function missingEnvNames(env, required) {
  return (required || []).filter((n) => !env || !env[n] || String(env[n]).length === 0);
}

/** Compare two project URLs without caring about a trailing slash. Never prints them. */
export function sameSupabaseUrl(a, b) {
  const norm = (v) => String(v || '').trim().replace(/\/+$/, '').toLowerCase();
  if (!norm(a) || !norm(b)) return false;
  return norm(a) === norm(b);
}

/**
 * Refuse to run tests against the project named in .env.
 *
 * Returns { ok, reason } — the caller decides whether to throw. `reason` is a
 * short label ('same-as-env', 'no-url', 'ok'), never a URL, never a key.
 */
export function checkNotProduction(env = process.env, root = ROOT) {
  const prod = readEnvFile('.env', root).SUPABASE_URL;
  if (!env.SUPABASE_URL) return { ok: false, reason: 'no-url' };
  if (sameSupabaseUrl(env.SUPABASE_URL, prod)) return { ok: false, reason: 'same-as-env' };
  return { ok: true, reason: 'ok' };
}
