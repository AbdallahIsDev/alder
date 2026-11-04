// lib/notify.js — outbound notifications, one task per channel.
//
// Save first, notify second. Every task swallows its own failure and writes its own
// lead_events row. Nothing here can change the HTTP response.
// Owner email and Telegram run concurrently; the customer auto-reply runs after both settle.

import { createHash } from 'node:crypto';
import { addEvent, listBusinessChats } from './db.js';
import { sendMail } from './mail.js';
import { sendMessage } from './tg.js';
import { ownerEmail, autoReply, telegramAlertText, alertKeyboard, reviewEmail } from './content.js';

async function record(leadId, okKind, errKind, status) {
  try {
    await addEvent(leadId, status === true ? okKind : errKind, status === true ? {} : { status });
  } catch (e) {
    console.error(okKind === 'email_owner_sent' ? 'email_owner_event_failed' : 'tg_event_failed', (e && e.code) || 'no_code');
  }
}

function statusOf(r) {
  return r && r.ok ? true : (r && r.status !== undefined ? r.status : 'timeout');
}

/* ---------- owner email ---------- */

export async function sendOwnerEmail({ leadId, business, lead }) {
  try {
    const c = ownerEmail({ business, lead });
    const r = await sendMail({
      to: business.owner_email,
      fromName: 'Lead Alerts',
      replyTo: lead.email || business.owner_email,
      subject: c.subject, html: c.html, text: c.text,
      idempotencyKey: `${leadId}:owner`,
    });
    await record(leadId, 'email_owner_sent', 'email_owner_failed', statusOf(r));
  } catch (e) {
    console.error('email_owner_failed', (e && e.code) || 'no_code');
    await record(leadId, 'email_owner_sent', 'email_owner_failed', 'timeout');
  }
}

/* ---------- Telegram lead alert ---------- */

export async function sendTelegramAlert({ leadId, business, lead }) {
  try {
    const bound = await listBusinessChats(business.id);
    let chats = bound;
    if (!chats.length) {
      // The global dev chat is for demo businesses only. A real client's leads must
      // never reach it.
      if (business.status === 'demo' && process.env.TELEGRAM_CHAT_ID) {
        chats = [process.env.TELEGRAM_CHAT_ID];
      } else {
        await record(leadId, 'tg_sent', 'tg_failed', 'no_chat');
        return;
      }
    }

    const text = telegramAlertText({ business, lead });
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
    await record(leadId, 'tg_sent', 'tg_failed', firstFailure === null ? true : firstFailure);
  } catch (e) {
    console.error('tg_failed', (e && e.code) || 'no_code');
    await record(leadId, 'tg_sent', 'tg_failed', 'timeout');
  }
}

/* ---------- customer auto-reply ---------- */

export async function sendAutoReply({ leadId, business, lead }) {
  if (!lead.email) return;                       // nothing to reply to
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

export async function sendReviewRequest({ leadId, business, lead, token }) {
  if (!lead.email) return;
  const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
  try {
    const c = reviewEmail({ business, token, siteUrl });
    const r = await sendMail({
      to: lead.email,
      fromName: business.name,
      replyTo: business.owner_email,
      subject: c.subject, html: c.html, text: c.text,
      idempotencyKey: `${leadId}:review`,
    });
    await record(leadId, 'review_requested', 'review_request_failed', statusOf(r));
  } catch (e) {
    console.error('review_request_failed', (e && e.code) || 'no_code');
    await record(leadId, 'review_requested', 'review_request_failed', 'timeout');
  }
}

/** Owner email and Telegram concurrently; auto-reply only after both have settled. */
export async function notifyAllAfterLead(ctx) {
  await Promise.allSettled([sendOwnerEmail(ctx), sendTelegramAlert(ctx)]);
  await sendAutoReply(ctx);
}

/** Salted hash of an IP, for rate limits on public review routes. */
export function hashIp(ip) {
  const salt = process.env.IP_HASH_SALT || '';
  return createHash('sha256').update(String(ip || '') + salt).digest('hex');
}
