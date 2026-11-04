// lib/mail.js — Resend REST client.
//
// Rules come from lib/outbound.js: 3000 ms timeout, status-only results, a dev-only
// RESEND_API_BASE override, and refusal to send when .test-mode is present without
// that override. Never log a URL, a key, an error object or a response body.
//
// Resend's API reference lists the body field as `replyTo` in the SDK-shaped table but
// calls it `reply_to` in the template paragraph. We talk to the raw REST endpoint, so
// `reply_to` is what we send. This is an assumption, not a verified fact.
//
// Deliverability constraint: onboarding@resend.dev only reaches the account owner.
// MAIL_REDIRECT_TO replaces EVERY recipient and marks the subject; with no redirect
// and the default sender we do not call Resend at all.

import { baseFor, blockedByInterlock, postJson } from './outbound.js';

const REAL_BASE = 'https://api.resend.com';
const DEFAULT_FROM = 'onboarding@resend.dev';

export function mailBase() {
  return baseFor('RESEND_API_BASE', REAL_BASE);
}

export function mailConfig() {
  return {
    from: process.env.MAIL_FROM || DEFAULT_FROM,
    redirectTo: process.env.MAIL_REDIRECT_TO || null,
    defaultSender: (process.env.MAIL_FROM || DEFAULT_FROM) === DEFAULT_FROM,
  };
}

function mailGuard() {
  if (blockedByInterlock('RESEND_API_BASE')) return { ok: false, status: 'blocked_test_mode' };
  if (!process.env.RESEND_API_KEY) return { ok: false, status: 'missing_env' };
  return null;
}

/** Escape customer text for an HTML part. Never used for attributes other than our own. */
export function escHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Anything that reaches a subject or a header must not carry CR/LF. */
export function safeHeader(v) {
  return String(v == null ? '' : v).replace(/[\r\n\u0000-\u001F\u007F]/g, ' ').trim();
}

/** Strip CR/LF from a display name so it cannot inject a header. */
function safeName(v) {
  return safeHeader(v).replace(/[<>,]/g, '');
}

/**
 * Send one email. Returns { ok, status } and never throws.
 * Both an HTML part and a text/plain part are always present.
 */
export async function sendMail({ to, from, fromName, replyTo, subject, html, text, idempotencyKey }) {
  const guard = mailGuard();
  if (guard) return guard;

  const cfg = mailConfig();
  // No verified domain: refuse rather than pretend the message was delivered.
  if (!cfg.redirectTo && cfg.defaultSender) return { ok: false, status: 'no_verified_sender' };

  const originalTo = to;
  const actualTo = cfg.redirectTo || to;
  const actualSubject = cfg.redirectTo ? `[TEST for ${safeHeader(originalTo)}] ${safeHeader(subject)}` : safeHeader(subject);

  const body = {
    from: `${safeName(fromName || 'Lead Alerts')} <${(from || cfg.from).replace(/[\r\n]/g, '')}>`,
    to: [actualTo],
    subject: actualSubject,
    reply_to: replyTo || undefined,
    html: String(html || ''),
    text: String(text || ''),
  };
  if (!body.reply_to) delete body.reply_to;

  const headers = { Authorization: 'Bearer ' + process.env.RESEND_API_KEY };
  // Resend documents an Idempotency-Key header (unique per request, 24 h expiry).
  if (idempotencyKey) headers['Idempotency-Key'] = safeHeader(idempotencyKey).slice(0, 256);

  return postJson(mailBase() + '/emails', body, { headers });
}

/** Low-level helper retained for tests that need a different path. */
export async function resendPost(path, body, headers) {
  const guard = mailGuard();
  if (guard) return guard;
  return postJson(mailBase() + path, body, {
    headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, ...(headers || {}) },
  });
}
