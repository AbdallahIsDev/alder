#!/usr/bin/env node
// scripts/make-bind-code.mjs <slug> — owner-only local script. No public endpoint mints codes.

import { randomInt } from 'node:crypto';
import { getActiveBusinessBySlug, createBindCode } from '../lib/db.js';
import { getMe } from '../lib/tg.js';

const slug = process.argv[2];
if (!slug) { console.log('usage: node scripts/make-bind-code.mjs <slug>'); process.exit(1); }

// Unambiguous alphabet: no 0/O, 1/I/L, no lowercase/uppercase pairs that look alike.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeCode(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[randomInt(0, ALPHABET.length)];
  return s;
}

const business = await getActiveBusinessBySlug(slug);
if (!business) { console.log('no demo/active business with that slug'); process.exit(1); }

const code = makeCode(12);
const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
await createBindCode(code, business.id, expiresAt);

let username = '<bot-username>';
const me = await getMe();
if (me.ok && me.result && me.result.username) username = me.result.username;

console.log('business   ' + business.name);
console.log('code       ' + code);
console.log('expires    ' + expiresAt);
console.log('deep link  https://t.me/' + username + '?start=' + code);
