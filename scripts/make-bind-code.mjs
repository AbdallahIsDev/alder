#!/usr/bin/env node
// scripts/make-bind-code.mjs <slug> — owner-only local script. No public endpoint mints codes.
//
// Usage: npm run bind -- <slug>
// Prints exactly four lines to stdout (business, code, expires, deep link) and
// nothing else. Every failure is one `bind: …` line to stderr with exit 1.
//
// Env files: lib/env.js loads them (process.env > .env.test when TEST_ENV=1 >
// .env.local > .env). `npm run bind` no longer passes --env-file-if-exists flags,
// so a direct `node scripts/...` run and `npm run` behave identically.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);

/* Env loading is lib/env.js — one loader for scripts and tests.
   Precedence: process.env > .env.test (TEST_ENV=1) > .env.local > .env. */
import { loadEnv, parseDotEnvText, applyDotEnvEntries, missingEnvNames } from '../lib/env.js';

export { parseDotEnvText, applyDotEnvEntries, missingEnvNames };

/** Back-compat shim: read the named files in precedence order onto `env`. */
export function loadDotEnvFiles({ env = process.env, root = ROOT, files = ['.env.local', '.env'] } = {}) {
  return loadEnv({ env, root, files, testEnv: false }).env;
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
