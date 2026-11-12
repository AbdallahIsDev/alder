// lib/notify.js — outbound notifications, one task per channel.
//
// Save first, notify second. Every task swallows its own failure and writes its own
// lead_events row. Nothing here can change the HTTP response.
// Owner email and Telegram run concurrently; the customer auto-reply runs after both settle.

import { addEvent, listBusinessChats, hitRateLimit } from './db.js';
import { sendMail } from './mail.js';
import { sendMessage } from './tg.js';
import { isDev } from './outbound.js';
import { telegramAlertText, alertKeyboard, displayPhone, operatorNoPhoneText, operatorUnreachableText } from './content.js';
import { operatorChatId } from './operator.js';
import { hashTelegramChat } from './hash.js';
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

/* The ceiling for one owner-alert round: both channels, every bound phone, plus
   the fallback round. It sits comfortably inside api/lead.js's 30 s maxDuration
   together with the customer auto-reply that runs after it, and
   above the 3 s per-send timeout so a single slow send is reported normally.
   The dev-only override is the same rule as OUTBOUND_TIMEOUT_MS: a deployed
   environment, or a misspelled VERCEL_ENV, always gets the default. */
const DEADLINE_DEFAULT_MS = 6000;

export function notifyDeadlineMs() {
  if (!isDev()) return DEADLINE_DEFAULT_MS;
  const v = Number(process.env.NOTIFY_DEADLINE_MS);
  return Number.isInteger(v) && v >= 100 && v <= DEADLINE_DEFAULT_MS ? v : DEADLINE_DEFAULT_MS;
}

/* ---------- owner email ---------- */

/** The idempotency key of a lead's owner email.
 *
 *  One key per lead, for every attempt: the fallback included. A same-payload
 *  replay returns Resend's original response without sending again. A second key
 *  (the old `:fallback` suffix) made a replay a fresh email instead. The primary
 *  and fallback build the same content and headers; neither 409 is delivery. */
export const ownerEmailKey = (leadId) => `${leadId}:owner`;

export async function sendOwnerEmail({ leadId, business, lead, fallback = false }) {
  const extra = fallback ? { fallback: true } : undefined;
  try {
    const c = ownerEmail({ business, lead });
    const r = await sendMail({
      to: business.owner_email,
      fromName: 'Lead Alerts',
      replyTo: lead.email || business.owner_email,
      subject: c.subject, html: c.html, text: c.text,
      idempotencyKey: ownerEmailKey(leadId),
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
async function operatorNotice(key, text) {
  const chat = operatorChatId();
  if (!chat) {
    console.error('operator_notice_unconfigured');
    return { ok: false, status: 'no_operator' };
  }
  try {
    // Fail open: telling the operator matters more than the lock.
    let first = true;
    try { first = await hitRateLimit(key, 86400, 1); } catch { first = true; }
    if (!first) return { ok: true, status: 'deduped' };
    const r = await sendMessage(chat, text);
    if (!r || !r.ok) console.error('operator_notice_failed');
    return r || { ok: false, status: 'timeout' };
  } catch {
    console.error('operator_notice_failed');
    return { ok: false, status: 'timeout' };
  }
}

/** One notice per lead: a retried alert must not send it twice. */
export async function notifyOperatorNoPhone({ business, lead }) {
  return operatorNotice('ops:nochat:' + lead.id, operatorNoPhoneText({ business, lead }));
}

/** One notice per business per day: a blocked phone fails on every lead. */
export async function notifyOperatorUnreachable({ business, chatId }) {
  return operatorNotice('ops:blocked:' + business.id, operatorUnreachableText({ business, chatId }));
}

export async function sendTelegramAlert({ leadId, business, lead, fallback = false, duplicate = false, deadlineAt = null, deliveredChatHashes = [], onlyChats = null }) {
  const extra = fallback ? { fallback: true } : undefined;
  try {
    const boundChats = await listBusinessChats(business.id);
    const confirmed = new Set(deliveredChatHashes);
    const chats = (onlyChats || boundChats).filter((chat) => {
      const hash = hashTelegramChat(chat);
      return !hash || !confirmed.has(hash);
    });
    if (!chats.length) {
      if (boundChats.length && (confirmed.size || onlyChats)) return { ok: true, status: 'already_delivered', pendingChats: [] };
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
    /* One send per bound phone, all at once. Five phones used to cost five 3 s
       timeouts one after another, which is what pushed a request past the
       function limit; the per-send 3 s timeout (lib/outbound.js) is unchanged. */
    const sendTo = async (chat) => {
      try {
        let r = await sendMessage(chat, text, withKeyboard ? { reply_markup: alertKeyboard(leadId) } : undefined);
        // A bad button must never lose the alert: retry once without the keyboard.
        if (!r.ok && Number(r.status) === 400 && withKeyboard) {
          r = await sendMessage(chat, text);
        }
        return r;
      } catch {
        return { ok: false, status: 'timeout' };
      }
    };
    // settled[i] stays undefined for a chat the deadline abandoned. Those sends
    // are still in flight when this returns — every one of them has its own 3 s
    // timeout, so nothing here outlives the function.
    const settled = new Array(chats.length).fill(undefined);
    const all = Promise.allSettled(chats.map((chat, i) => sendTo(chat).then((r) => { settled[i] = r; return r; })));
    const deadline = deadlineAt == null ? Date.now() + notifyDeadlineMs() : deadlineAt;
    let timer = null;
    await Promise.race([
      all,
      new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); }),
    ]);
    if (timer) clearTimeout(timer);
    const abandoned = settled.filter((r) => r === undefined).length;
    const failed = settled.find((r) => r && !r.ok);
    // A chat that never answered is a timeout even if every other phone got the
    // alert: the round is not complete. A definite status wins over the timeout.
    const st = failed ? statusOf(failed) : (abandoned ? 'timeout' : true);
    const chatOutcomes = chats.map((chat, i) => ({
      chat_hash: hashTelegramChat(chat), delivered: !!(settled[i] && settled[i].ok),
    })).filter((outcome) => outcome.chat_hash);
    const outcomeExtra = { ...(extra || {}), ...(abandoned ? { abandoned } : {}), chat_outcomes: chatOutcomes };
    await record(leadId, 'tg_sent', 'tg_failed', st, outcomeExtra);
    // 403 is "bot blocked by the user" (or the chat is gone). With one phone
    // that means this business cannot be reached at all, which nobody would
    // otherwise notice: the lead is still stored and the owner email still goes.
    if (st === 403 && chats.length === 1) {
      await notifyOperatorUnreachable({ business, chatId: chats[0] });
    }
    return {
      ok: st === true, status: st,
      // Raw ids stay in memory only, so the immediate fallback can target just
      // this round's unsuccessful phones. Persisted events carry hashes above.
      pendingChats: chats.filter((chat, i) => !(settled[i] && settled[i].ok)),
    };
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
    // Bound chats first. With no phone connected the operator gets it instead:
    // this message has no buttons, so it cannot create the "Not found." trap the
    // alert fallback did, and a 1-star rating with nobody told is worse.
    const bound = await listBusinessChats(business.id);
    const op = operatorChatId();
    const chats = bound.length ? bound : (op ? [op] : []);
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

/* Later replay is different from same-round fallback: missing configuration can
   be fixed between attempts, so missing_env/no_verified_sender MAY retry then.
   blocked_test_mode stays suppressed because the test interlock is deliberate. */
export function isOwnerEmailReplayRetryable(status) {
  return String(status) !== 'blocked_test_mode';
}

/* A timeout is not a failure, it is "unknown": the request may have been
   accepted and only the answer was lost. A concurrent 409 is likewise still
   in flight. Neither is retried inside this round. */
const NOT_RETRYABLE_UNKNOWN = new Set(['timeout', 'idempotency_concurrent']);
// Reusing a key with different content is a programming/configuration error:
// another immediate attempt with the same bytes cannot repair it.
NOT_RETRYABLE_UNKNOWN.add('idempotency_payload_mismatch');

/* Retry only while there is time budget left. */
const FALLBACK_BUDGET_MS = 2000;

const canRetry = (r) => !r.ok && !NOT_RETRYABLE.has(String(r.status))
  && !NOT_RETRYABLE_UNKNOWN.has(String(r.status));

/**
 * Owner email and Telegram run concurrently, as before, and the auto-reply runs
 * after both settle.
 *
 * Fallback: both channels always send, so when exactly one of them fails the
 * owner already has the alert and a second send would be a duplicate. The one
 * case that needs rescuing is when NEITHER delivered — then each channel that
 * could still work gets one more attempt, marked { fallback: true } in its
 * event meta. A timeout and concurrent 409 stay unknown; an owner-email 5xx is
 * retried once with the same key and byte-identical payload. Replays make only
 * one owner-email attempt so a stored lead can be safely tried again later.
 * Nothing here can change the HTTP response.
 */
export async function notifyAllAfterLead(ctx) {
  const started = Date.now();
  // One budget for the whole round, shared by the primary and the fallback, so
  // the fallback cannot start a second 6 s of work after the first one used it.
  const deadlineAt = started + notifyDeadlineMs();
  // Replay flags skip only channels with recorded delivery. If Telegram is
  // partial and owner email is missing, retry both missing paths once; if one
  // channel is fully confirmed, only the other channel is re-driven.
  const [mail, tg] = await Promise.all([
    ctx.retryTelegramOnly || ctx.skipOwnerEmail
      ? Promise.resolve({ ok: true, status: 'already_delivered' })
      : sendOwnerEmail(ctx),
    ctx.retryEmailOnly
      ? Promise.resolve({ ok: true, status: 'already_delivered' })
      : sendTelegramAlert({ ...ctx, deadlineAt }),
  ]);
  const elapsed = Date.now() - started;

  if (!mail.ok && !tg.ok && elapsed < FALLBACK_BUDGET_MS) {
    const again = [];
    if (!ctx.replay && canRetry(mail)) again.push(sendOwnerEmail({ ...ctx, fallback: true }));
    if (canRetry(tg)) again.push(sendTelegramAlert({
      ...ctx, fallback: true, deadlineAt, onlyChats: tg.pendingChats || [],
    }));
    if (again.length) {
      console.error('owner_alert_fallback', `mail=${mail.status}`, `tg=${tg.status}`);
      await Promise.allSettled(again);
    }
  }

  await sendAutoReply(ctx);
}
