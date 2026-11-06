// lib/outbound.js — shared safety rules for every outbound HTTP call.
//
// Three rules, enforced here so no caller can forget one:
//   1. A 3000 ms AbortController timeout on every request.
//   2. Only a short code and a status number ever reach a log. Never a URL, a token,
//      an error object, an error message, or a response body. A Telegram URL contains
//      the bot token, so a logged URL is a leaked token.
//   3. *_API_BASE overrides are honoured ONLY when VERCEL_ENV is unset or "development".
//      A deployed function (preview or production) always uses the real host.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = path.join(ROOT, '.test-mode');

export const TIMEOUT_MS = 3000;

/** Dev-only override for the outbound timeout (tests): an integer
 *  OUTBOUND_TIMEOUT_MS between 200 and 3000 is honoured only when isDev()
 *  is true; anything else (or any deployed VERCEL_ENV) gets TIMEOUT_MS. */
export function effectiveTimeoutMs() {
  if (!isDev()) return TIMEOUT_MS;
  const v = Number(process.env.OUTBOUND_TIMEOUT_MS);
  return Number.isInteger(v) && v >= 200 && v <= 3000 ? v : TIMEOUT_MS;
}

export function isDev() {
  const v = process.env.VERCEL_ENV;
  return !v || v === 'development';
}

/** The marker is deliberately a file: it survives env shadowing by `vercel dev`. */
export function testModeActive() {
  return isDev() && fs.existsSync(MARKER);
}

export function overrideActive(envName) {
  return isDev() && !!process.env[envName];
}

/** True when tests are running but this channel has no fake base URL. Callers must refuse to send. */
export function blockedByInterlock(envName) {
  return testModeActive() && !overrideActive(envName);
}

export function isLoopback(url) {
  try {
    const u = new URL(url);
    return (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1')
      && (u.protocol === 'http:' || u.protocol === 'https:');
  } catch { return false; }
}

export function baseFor(envName, realBase) {
  if (!isDev()) return realBase;
  const v = process.env[envName];
  if (!v) return realBase;
  if (!isLoopback(v)) return realBase;                 // refuse a non-loopback override
  return v.replace(/\/+$/, '');
}

/**
 * POST JSON. Returns { ok, status } and nothing else by default.
 * `parse: 'result'` returns the successful JSON `result` field (needed by getMe).
 * `parse: 'description'` returns the error description string (used only by the
 * live smoke, which is allowed to print that one string). Error bodies are never
 * retained otherwise.
 */
export async function postJson(url, body, { headers, timeoutMs, parse = 'none' } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs === undefined ? effectiveTimeoutMs() : timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      body: JSON.stringify(body == null ? {} : body),
      signal: ac.signal,
    });
    const out = { ok: r.ok, status: r.status };
    if (parse !== 'none') {
      try {
        const j = await r.json();
        if (parse === 'result' && r.ok) out.result = j.result;
        if (parse === 'description' && !r.ok) out.description = typeof j.description === 'string' ? j.description : undefined;
      } catch { /* an unreadable body stays unread */ }
    }
    return out;
  } catch {
    return { ok: false, status: 'timeout' };
  } finally {
    clearTimeout(timer);
  }
}
