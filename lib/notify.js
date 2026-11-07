// lib/notify.js — outbound notifications, one task per channel.
//
// Save first, notify second. Every task swallows its own failure and writes its own
// lead_events row. Nothing here can change the HTTP response.
// Owner email and Telegram run concurrently; the customer auto-reply runs after both settle.

import { addEvent, listBusinessChats, hitRateLimit } from './db.js';
import { sendMail } from './mail.js';
import { sendMessage } from './tg.js';
import { telegramAlertText, alertKeyboard, displayPhone, operatorNoPhoneText } from './content.js';
import { operatorChatId } from './operator.js';
// The email bodies come from the registry, not straight from content.js: that is
// what makes "every sender goes through the shared layout" a checkable rule
// rather than a convention (see tests/email-layout.test.mjs).
import { ownerEmail, autoReply, reviewEmail } from './email-builders.js';

async function record(leadId, okKind, errKind, status, extra) {
  try {
    // `extra` rides along on success too: a fallback send has to be identifiable
    // as one, or the event log cannot tell it from the primary attempt.
    await addEvent(leadId, status === true ? okKind : errKind, status === true ? (extra || {}) : { status, ...(extra || {}) });
  } catch (e) {
    console.error(okKind === 'email_owner_sent' ? 'email_owner_event_failed' : 'tg_event_failed', (e && e.code) || 'no_code');
  }
}

function statusOf(r) {
  return r && r.ok ? true : (r && r.status !== undefined ? r.status : 'timeout');
}

/* ---------- owner email ---------- */

export async function sendOwnerEmail({ leadId, business, lead, fallback = false }) {
  const extra = fallback ? { fallback: true } : undefined;
  try {
    const c = ownerEmail({ business, lead });
    const r = await sendMail({
      to: business.owner_email,
      fromName: 'Lead Alerts',
      replyTo: lead.email || business.owner_email,
      subject: c.subject, html: c.html, text: c.text,
      idempotencyKey: `${leadId}:owner${fallback ? ':fallback' : ''}`,
    });
    const st = statusOf(r);
    await record(leadId, 'email_owner_sent', 'email_owner_failed', st, extra);
    return { ok: st === true, status: st };
  } catch (e) {
    console.error('email_owner_failed', (e && e.code) || 'no_code');
    await record(leadId, 'email_owner_sent', 'email_owner_failed', 'timeout', extra);
    return { ok: false, status: 'timeout' };
  }
}

/* ---------- Telegram lead alert ---------- */

/**
 * Tell the operator that a lead arrived for a business with no phone connected.
 *
 * No buttons: this chat is not bound to the business, so a callback from it
 * would answer "Not found." — that is the trap the old TELEGRAM_CHAT_ID fallback
 * created. Deduped per lead, so a retried alert does not send it twice. Never
 * throws and never changes the lead response.
 */
export async function notifyOperatorNoPhone({ business, lead }) {
  const chat = operatorChatId();
  if (!chat) {
    console.error('operator_nochat_unconfigured');
    return { ok: false, status: 'no_operator' };
  }
  try {
    // Fail open: telling the operator matters more than the lock.
    let first = true;
    try { first = await hitRateLimit('ops:nochat:' + lead.id, 86400, 1); } catch { first = true; }
    if (!first) return { ok: true, status: 'deduped' };
    const r = await sendMessage(chat, operatorNoPhoneText({ business, lead }));
    if (!r || !r.ok) console.error('operator_nochat_failed');
    return r || { ok: false, status: 'timeout' };
  } catch {
    console.error('operator_nochat_failed');
    return { ok: false, status: 'timeout' };
  }
}

export async function sendTelegramAlert({ leadId, business, lead, fallback = false, duplicate = false }) {
  const extra = fallback ? { fallback: true } : undefined;
  try {
    const chats = await listBusinessChats(business.id);
    if (!chats.length) {
      // No bound chat means no buttons: an alert sent anywhere else would show
      // Mark contacted / Job completed and every tap would answer "Not found."
      // because the chat has no binding. The lead is still stored and the owner
      // email still goes out; the operator gets one plain notice instead.
      await record(leadId, 'tg_sent', 'tg_failed', 'no_chat', extra);
      await notifyOperatorNoPhone({ business, lead });
      return { ok: false, status: 'no_chat' };
    }

    const text = telegramAlertText({ business, lead, duplicate });
    const withKeyboard = !!process.env.TELEGRAM_WEBHOOK_SECRET;
    let firstFailure = null;
    for (const chat of chats) {
      let r = await sendMessage(chat, text, withKeyboard ? { reply_markup: alertKeyboard(leadId) } : undefined);
      // A bad button must never lose the alert: retry once without the keyboard.
      if (!r.ok && Number(r.status) === 400 && withKeyboard) {
        r = await sendMessage(chat, text);
      }
      if (!r.ok && firstFailure === null) firstFailure = statusOf(r);
    }
    const st = firstFailure === null ? true : firstFailure;
    await record(leadId, 'tg_sent', 'tg_failed', st, extra);
    return { ok: st === true, status: st };
  } catch (e) {
    console.error('tg_failed', (e && e.code) || 'no_code');
    await record(leadId, 'tg_sent', 'tg_failed', 'timeout', extra);
    return { ok: false, status: 'timeout' };
  }
}

/* ---------- customer auto-reply ---------- */

/* Per-business daily ceiling on customer auto-replies. Not a security control —
   it is there so one flooded site cannot burn a whole email quota in an hour.
   The owner email and the Telegram alert are never capped by it.
   hit_rate_limit takes the window as an argument, so a 24 h bucket needs no
   schema change; it resets at UTC midnight, not the business's local midnight. */
const AUTOREPLY_WINDOW_SECONDS = 86400;
/* 40, not 60. Resend's free plan allows 100 emails per day (resend.com/pricing,
   read 2026-11-07). Each lead can cost two emails — the owner alert and the
   auto-reply — and the owner alert is deliberately never capped, so a cap of N
   can cost up to 2N emails. 40 keeps the worst case at 80, leaving ~20 a day for
   review requests and the self-check. 60 would put the worst case at 120, over
   the free daily limit on its own. */
const AUTOREPLY_DEFAULT_CAP = 40;

export function autoReplyCap() {
  const n = Number(process.env.AUTOREPLY_DAILY_CAP || AUTOREPLY_DEFAULT_CAP);
  return Number.isInteger(n) && n > 0 ? n : AUTOREPLY_DEFAULT_CAP;
}

export async function sendAutoReply({ leadId, business, lead }) {
  if (!lead.email) return;                       // nothing to reply to
  // Fail open: if the counter itself is unreachable, a real customer's reply
  // matters more than the ceiling.
  let allowed = true;
  try {
    allowed = await hitRateLimit('autoreply:' + business.id, AUTOREPLY_WINDOW_SECONDS, autoReplyCap());
  } catch { allowed = true; }
  if (!allowed) {
    console.warn('autoreply_capped');
    return;
  }
  try {
    const c = autoReply({ business, lead });
    const r = await sendMail({
      to: lead.email,
      fromName: business.name,
      replyTo: business.owner_email,
      subject: c.subject, html: c.html, text: c.text,
      idempotencyKey: `${leadId}:autoreply`,
    });
    await record(leadId, 'autoreply_sent', 'autoreply_failed', statusOf(r));
  } catch (e) {
    console.error('autoreply_failed', (e && e.code) || 'no_code');
    await record(leadId, 'autoreply_sent', 'autoreply_failed', 'timeout');
  }
}

/* ---------- review request ---------- */

export async function sendReviewRequest({ leadId, business, lead, token, variant, idempotencyKey }) {
  if (!lead.email) return { ok: false, status: 'no_email' };
  const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
  // First send: "<leadId>:review" (default, unchanged). A Try again retry
  // passes the key of the timed-out attempt, or a fresh suffixed key after
  // any other failure (see api/tg.js kind r). The key is recorded in the
  // failure event meta so the next retry can reuse it exactly.
  const key = idempotencyKey || `${leadId}:review`;
  try {
    const c = reviewEmail({ business, token, siteUrl, variant });
    const r = await sendMail({
      to: lead.email,
      fromName: business.name,
      replyTo: business.owner_email,
      subject: c.subject, html: c.html, text: c.text,
      idempotencyKey: key,
    });
    await record(leadId, 'review_requested', 'review_request_failed', statusOf(r), { key });
    return r;
  } catch (e) {
    console.error('review_request_failed', (e && e.code) || 'no_code');
    await record(leadId, 'review_requested', 'review_request_failed', 'timeout', { key });
    return { ok: false, status: 'timeout' };
  }
}

/** A 1- or 2-star private rating goes to the roofer as a plain-text alert. */
export async function sendLowRatingAlert({ business, lead, stars, comment }) {
  try {
    // Bound chats only: this message has no buttons, but it carries a lead's
    // name and phone, so it belongs to the business that owns the lead.
    const chats = await listBusinessChats(business.id);
    if (!chats.length) return;
    const first = String(lead.name || '').trim().split(/\s+/)[0] || 'A customer';
    const text = [
      'Private feedback for ' + business.name,
      `Name: ${first}`,
      `Phone: ${displayPhone(lead.phone)}`,
      `Rating: ${stars} star${stars === 1 ? '' : 's'}`,
      comment ? `Comment: ${String(comment).slice(0, 300)}` : '',
    ].filter(Boolean).join('\n');
    for (const chat of chats) await sendMessage(chat, text);
  } catch (e) {
    console.error('rating_alert_failed', (e && e.code) || 'no_code');
  }
}

/* A failure that a second attempt cannot fix: there is no chat to send to, no
   key to send with, or the interlock is deliberately blocking. Retrying those
   only doubles the failure events. */
const NOT_RETRYABLE = new Set(['no_chat', 'missing_env', 'no_verified_sender', 'blocked_test_mode']);

/* Retry only while there is time budget left. A timeout costs the full 3 s
   outbound budget, so a retry after one would push the whole request past the
   function limit; an immediate 5xx costs ~100 ms and is worth one more try. */
const FALLBACK_BUDGET_MS = 2000;

const canRetry = (r) => !r.ok && !NOT_RETRYABLE.has(String(r.status));

/**
 * Owner email and Telegram run concurrently, as before, and the auto-reply runs
 * after both settle.
 *
 * Fallback: both channels always send, so when exactly one of them fails the
 * owner already has the alert and a second send would be a duplicate. The one
 * case that needs rescuing is when NEITHER delivered — then each channel that
 * could still work gets one more attempt, marked { fallback: true } in its
 * event meta. Nothing here can change the HTTP response.
 */
export async function notifyAllAfterLead(ctx) {
  const started = Date.now();
  const [mail, tg] = await Promise.all([sendOwnerEmail(ctx), sendTelegramAlert(ctx)]);
  const elapsed = Date.now() - started;

  if (!mail.ok && !tg.ok && elapsed < FALLBACK_BUDGET_MS) {
    const again = [];
    if (canRetry(mail)) again.push(sendOwnerEmail({ ...ctx, fallback: true }));
    if (canRetry(tg)) again.push(sendTelegramAlert({ ...ctx, fallback: true }));
    if (again.length) {
      console.error('owner_alert_fallback', `mail=${mail.status}`, `tg=${tg.status}`);
      await Promise.allSettled(again);
    }
  }

  await sendAutoReply(ctx);
}
