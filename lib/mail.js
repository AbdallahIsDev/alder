// lib/mail.js — Resend REST client.
//
// SKELETON for the Gate 0 interlock. The sending logic is added in Phase A; putting the
// interlock in now means no test can ever reach the real Resend API by accident.
//
// Rules come from lib/outbound.js: 3000 ms timeout, status-only results, a dev-only
// RESEND_API_BASE override, and refusal to send when .test-mode is present without
// that override. Never log a URL, a key, an error object or a response body.

import { baseFor, blockedByInterlock, postJson } from './outbound.js';

const REAL_BASE = 'https://api.resend.com';

export function mailBase() {
  return baseFor('RESEND_API_BASE', REAL_BASE);
}

export function mailGuard() {
  if (blockedByInterlock('RESEND_API_BASE')) return { ok: false, status: 'blocked_test_mode' };
  if (!process.env.RESEND_API_KEY) return { ok: false, status: 'missing_env' };
  return null;
}

/** Phase A fills this in. Until then no caller exists and no network call is possible. */
export async function sendMail(_args) {
  const g = mailGuard();
  if (g) return g;
  return { ok: false, status: 'not_wired' };
}

export async function resendPost(path, body, headers) {
  const g = mailGuard();
  if (g) return g;
  const url = mailBase() + path;
  return postJson(url, body, { headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, ...(headers || {}) } });
}
