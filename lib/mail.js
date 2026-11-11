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
import { clientSender, resolveSender } from './client.js';
import { getBrand } from './brand.js';

const REAL_BASE = 'https://api.resend.com';
const DEFAULT_FROM = 'onboarding@resend.dev';

export function mailBase() {
  return baseFor('RESEND_API_BASE', REAL_BASE);
}

export function mailConfig() {
  /* A client file may name its own sender. Absent — which is Alder's case — the
     deployment's MAIL_FROM is used, exactly as before. */
  const from = resolveSender({ clientSender: clientSender(), envFrom: process.env.MAIL_FROM }) || DEFAULT_FROM;
  return {
    from,
    redirectTo: process.env.MAIL_REDIRECT_TO || null,
    defaultSender: from === DEFAULT_FROM,
  };
}

/* A redirect left on silently swallows every customer email: the auto-reply, the
   review request, the owner alert. Two questions, two answers — and one place
   that answers them, so /api/health and the daily check cannot drift apart:

   - is the redirect configured at all? (health flag: the state, any environment)
   - is it swallowing mail for real customers right now? (the warning: production
     only, because that is the only environment that serves them) */
export function mailRedirectConfigured() {
  return !!process.env.MAIL_REDIRECT_TO;
}

export function mailRedirectInProduction() {
  return mailRedirectConfigured() && process.env.VERCEL_ENV === 'production';
}

/* Sending is not changed — the point is to make the state impossible to miss in
   the logs. Once per instance, so a busy hour does not produce one line per
   email. */
let warnedRedirect = false;

function warnIfRedirectedInProduction(cfg) {
  if (warnedRedirect || !cfg.redirectTo) return;
  if (process.env.VERCEL_ENV !== 'production') return;
  warnedRedirect = true;
  console.warn('mail_redirect_active');
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
  warnIfRedirectedInProduction(cfg);
  // No verified domain: refuse rather than pretend the message was delivered.
  if (!cfg.redirectTo && cfg.defaultSender) return { ok: false, status: 'no_verified_sender' };

  const originalTo = to;
  const actualTo = cfg.redirectTo || to;
  const prefixOff = String(process.env.MAIL_REDIRECT_PREFIX || '').toLowerCase() === 'off';
  const actualSubject = cfg.redirectTo && !prefixOff ? `[TEST for ${safeHeader(originalTo)}] ${safeHeader(subject)}` : safeHeader(subject);

  const body = {
    from: `${safeName(fromName || 'Lead Alerts')} <${(from || cfg.from).replace(/[\r\n]/g, '')}>`,
    to: [actualTo],
    subject: actualSubject,
    reply_to: replyTo || undefined,
    html: String(html || ''),
    text: String(text || ''),
  };
  if (!body.reply_to) delete body.reply_to;
  // Logo as a CID inline image (the emails use <img src="cid:brand-logo">).
  // Single /emails send only: the batch endpoint does not support
  // attachments. Bytes come from lib/brand.generated.json (logo.onDarkB64),
  // bundled with the function; assets/ is never read at run time.
  const logoB64 = getBrand().logo && getBrand().logo.onDarkB64;
  if (logoB64) {
    body.attachments = [{
      filename: 'logo.png',
      content: logoB64,
      content_type: 'image/png',
      content_id: 'brand-logo',
    }];
  }

  const headers = { Authorization: 'Bearer ' + process.env.RESEND_API_KEY };
  // Resend documents an Idempotency-Key header (unique per request, 24 h expiry).
  if (idempotencyKey) headers['Idempotency-Key'] = safeHeader(idempotencyKey).slice(0, 256);

  const r = await postJson(mailBase() + '/emails', body, { headers });
  // Resend answers 409 when an Idempotency-Key was already used. Two cases share
  // the code and we cannot tell them apart without the body (which this client
  // never reads): a request still in flight, and a replay of the same key. Both
  // mean "this message is already being or has been delivered", so the caller
  // must treat it as success. A 409 without a key is not ours to reinterpret.
  if (idempotencyKey && r.status === 409) return { ok: true, status: 'duplicate' };
  return r;
}

/** Low-level helper retained for tests that need a different path. */
export async function resendPost(path, body, headers) {
  const guard = mailGuard();
  if (guard) return guard;
  return postJson(mailBase() + path, body, {
    headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, ...(headers || {}) },
  });
}
