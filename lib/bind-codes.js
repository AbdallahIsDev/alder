// lib/bind-codes.js — one place that mints a chat-binding code.
//
// Used by `npm run bind` (an operator minting a code from a terminal) and by
// /invite in the bot (a bound roofer adding a second phone). Same alphabet, same
// length, same 24 h life, so a code from either path behaves identically.

import { randomInt } from 'node:crypto';
import { createBindCode } from './db.js';

// Unambiguous alphabet: no 0/O, 1/I/L, no lowercase/uppercase pairs that look alike.
export const BIND_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const BIND_CODE_LENGTH = 12;
export const BIND_CODE_HOURS = 24;

/** 31^12 ≈ 7.9e17 — guessing one inside 24 h is not a practical attack. */
export function makeBindCode(n = BIND_CODE_LENGTH) {
  let s = '';
  for (let i = 0; i < n; i++) s += BIND_ALPHABET[randomInt(0, BIND_ALPHABET.length)];
  return s;
}

export function bindCodeExpiry(hours = BIND_CODE_HOURS, now = Date.now()) {
  return new Date(now + hours * 3600 * 1000).toISOString();
}

/** Mint and store one single-use code for a business. */
export async function mintBindCode(businessId, { hours = BIND_CODE_HOURS } = {}) {
  const code = makeBindCode();
  const expiresAt = bindCodeExpiry(hours);
  await createBindCode(code, businessId, expiresAt);
  return { code, expiresAt };
}
