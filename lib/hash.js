// lib/hash.js — the one salted IP hash.
//
// Used by the lead endpoint and the review endpoint for rate-limit keys. The salt
// is what makes the stored key a pseudonym: an unsalted sha256 of an IPv4 address
// is a 2^32 lookup, i.e. trivially reversible. Callers must treat `null` as
// "cannot rate limit safely" and decide what to do about it — they must not fall
// back to an unsalted hash.

import { createHash } from 'node:crypto';

/**
 * sha256(ip + salt) as hex, or null when no salt is configured.
 * @param {string} ip
 * @param {string} [salt] defaults to process.env.IP_HASH_SALT
 */
export function hashIp(ip, salt = process.env.IP_HASH_SALT) {
  if (!salt) return null;
  return createHash('sha256').update(String(ip || '') + salt).digest('hex');
}

/** The same salted SHA-256 for per-lead Telegram outcomes. The namespace keeps
 *  a chat-id hash distinct from an IP hash; the raw chat id is never persisted. */
export function hashTelegramChat(chatId, salt = process.env.IP_HASH_SALT) {
  return hashIp('telegram-chat:' + String(chatId), salt);
}
