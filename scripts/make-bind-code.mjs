#!/usr/bin/env node
// scripts/make-bind-code.mjs <slug> — owner-only local script. No public endpoint mints codes.
//
// Usage: npm run bind -- <slug>
// Prints exactly four lines to stdout (business, code, expires, deep link) and
// nothing else. Every failure is one `bind: …` line to stderr with exit 1.
//
// Env files: `npm run bind` loads both .env and .env.local through Node's
// --env-file-if-exists flags (last wins, so .env.local over .env; a non-empty
// value already in the environment always wins — see `applyDotEnvEntries`).
// This file also parses both itself for direct `node scripts/...` runs,
// with the same precedence, so the behaviour is identical either way.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);

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
 * Entries must be in precedence order: .env.local first, then .env.
 * A non-empty value already in `env` always wins.
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

/** Read .env.local then .env from `root` and apply onto `env` (default process.env). */
export function loadDotEnvFiles({ env = process.env, root = ROOT, files = ['.env.local', '.env'] } = {}) {
  const entries = files.map((f) => {
    const p = path.join(root, f);
    let text = '';
    try { text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; } catch { text = ''; }
    return { file: f, text };
  });
  return applyDotEnvEntries(env, entries);
}

/** Names from `required` (in order) missing or empty in `env`. */
export function missingEnvNames(env, required) {
  return (required || []).filter((n) => !env || !env[n] || String(env[n]).length === 0);
}

const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const SLUG_RE = /^[a-z0-9-]{2,60}$/;

// Unambiguous alphabet: no 0/O, 1/I/L, no lowercase/uppercase pairs that look alike.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeCode(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[randomInt(0, ALPHABET.length)];
  return s;
}

function fail(msg) {
  console.error('bind: ' + msg);
  process.exit(1);
}

async function main() {
  loadDotEnvFiles({ env: process.env, root: ROOT });
  const missing = missingEnvNames(process.env, REQUIRED_ENV);
  if (missing.length) fail('missing env: ' + missing.join(', '));

  const slug = process.argv[2];
  if (!slug || slug.startsWith('--')) fail('usage: npm run bind -- <slug>');
  if (!SLUG_RE.test(slug)) fail('invalid slug');

  let getActiveBusinessBySlug, createBindCode, listBusinessSlugs, getMe;
  try {
    ({ getActiveBusinessBySlug, createBindCode, listBusinessSlugs } = await import('../lib/db.js'));
    ({ getMe } = await import('../lib/tg.js'));
  } catch { fail('db_not_configured'); }

  let business;
  try {
    business = await getActiveBusinessBySlug(slug);
  } catch { fail('db_not_configured'); }
  if (!business) {
    let valid = '';
    try {
      const rows = await listBusinessSlugs();
      valid = (rows || []).map((r) => `${r.slug} (${r.status})`).join(', ');
    } catch { valid = ''; }
    fail(valid ? `unknown slug; valid: ${valid}` : 'unknown slug');
  }

  const code = makeCode(12);
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  try {
    await createBindCode(code, business.id, expiresAt);
  } catch { fail('db_not_configured'); }

  let username = '<bot-username>';
  try {
    const me = await getMe();
    if (me.ok && me.result && me.result.username) username = me.result.username;
  } catch { /* keep the placeholder; the code is already minted */ }

  console.log('business   ' + business.name);
  console.log('code       ' + code);
  console.log('expires    ' + expiresAt);
  console.log('deep link  https://t.me/' + username + '?start=' + code);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === path.resolve(SELF)) {
  main().catch(() => fail('db_not_configured'));
}
