#!/usr/bin/env node
// scripts/make-bind-code.mjs <slug> — owner-only local script. No public endpoint mints codes.
//
// Usage: npm run bind -- <slug>
// Prints exactly four lines to stdout (business, code, expires, deep link) and
// nothing else. Every failure is one `bind: …` line to stderr with exit 1.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Load .env / .env.local into process.env without overriding a value already set.
for (const f of ['.env', '.env.local']) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

function fail(msg) {
  console.error('bind: ' + msg);
  process.exit(1);
}

const slug = process.argv[2];
if (!slug || slug.startsWith('--')) fail('usage: npm run bind -- <slug>');
if (!/^[a-z0-9-]{2,60}$/.test(slug)) fail('invalid slug');

let getActiveBusinessBySlug, createBindCode, getMe;
try {
  ({ getActiveBusinessBySlug, createBindCode } = await import('../lib/db.js'));
  ({ getMe } = await import('../lib/tg.js'));
} catch { fail('db_not_configured'); }

// Unambiguous alphabet: no 0/O, 1/I/L, no lowercase/uppercase pairs that look alike.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeCode(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[randomInt(0, ALPHABET.length)];
  return s;
}

let business;
try {
  business = await getActiveBusinessBySlug(slug);
} catch { fail('db_not_configured'); }
if (!business) fail('no demo/active business with that slug');

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
