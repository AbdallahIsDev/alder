// Vercel serverless function: POST /api/tg — Telegram webhook.
//
// Auth first. Tenancy is ALWAYS derived from the sender's chat id through
// business_chats, never from message text or callback data. Reads of leads go
// through public.v_client_leads. Nothing here touches the private schema.

import { timingSafeEqual, randomBytes } from 'node:crypto';
import {
  getChatBinding, bindChat, claimBindCode, getBusinessById,
  listClientLeads, getClientLead, transitionLead, getDoneLeadForRetry, hasReviewSent, getReviewFailureInfo, addEvent,
} from '../lib/db.js';
import { sendMessage, answerCallbackQuery, editMessageText, editMessageReplyMarkup } from '../lib/tg.js';
import { sendReviewRequest } from '../lib/notify.js';
import { renderAlert, jobDoneKeyboard, confirmKeyboard, tryAgainKeyboard } from '../lib/content.js';

const GENERIC_UNBOUND = 'This chat is not linked to a business. Ask your administrator for a link.';
const GENERIC_BAD_CODE = 'That link is not valid. Ask for a new one.';
const GENERIC_HELP = 'Send /start followed by the link code you were given, or use /leads to see open requests.';
const GENERIC_NOT_FOUND = 'Not found.';
const ALREADY_BOUND = 'This chat is already linked to a business. Contact support to move it.';
const COMMAND_HELP = 'This bot sends new lead requests here. Use /leads to see recent requests. A new roofer links their chat with the link their provider sends, then sends /start with the code.';

function secretOk(req) {
  const want = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!want) return 'missing_env';
  const got = req.headers['x-telegram-bot-api-secret-token'];
  if (typeof got !== 'string' || got.length !== want.length) return 'bad';
  try {
    return timingSafeEqual(Buffer.from(got, 'utf8'), Buffer.from(want, 'utf8')) ? null : 'bad';
  } catch { return 'bad'; }
}

function relativeAge(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (!Number.isFinite(m) || m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

async function reply(chatId, text) {
  // Best effort. A failed reply changes nothing about the update.
  await sendMessage(chatId, text);
}

async function handleStart(chatId, arg) {
  const existing = await getChatBinding(chatId);
  if (existing) return reply(chatId, ALREADY_BOUND);
  if (!arg) return reply(chatId, GENERIC_HELP);

  const businessId = await claimBindCode(arg);
  if (!businessId) return reply(chatId, GENERIC_BAD_CODE);
  const business = await getBusinessById(businessId);
  if (!business) return reply(chatId, GENERIC_BAD_CODE);

  await bindChat(businessId, chatId);
  return reply(chatId, `Linked to ${business.name}. You will receive new lead alerts here.`);
}

async function handleLeads(chatId, binding) {
  if (!binding) return reply(chatId, GENERIC_UNBOUND);
  const leads = await listClientLeads(binding.business_id, 10);
  if (!leads.length) return reply(chatId, 'No requests yet.');
  const STATUS_WORD = { open: 'New', contacted: 'Contacted', quoted: 'Quoted', won: 'Won', lost: 'Lost', done: 'Done' };
  const lines = leads.map((l, i) =>
    `${i + 1}. ${l.name} — ${l.service} · ${l.phone} · ${relativeAge(l.created_at)} · ${STATUS_WORD[l.status] || l.status}`);
  return reply(chatId, 'Recent requests\n' + lines.join('\n'));
}

async function handleCallback(cb, binding) {
  const id = cb.id;
  const data = String(cb.data || '');
  const chatId = cb.message && cb.message.chat && cb.message.chat.id;
  const messageId = cb.message && cb.message.message_id;
  let answered = false;
  const answer = (text) => {
    if (answered) return Promise.resolve();
    answered = true;
    return answerCallbackQuery(id, text).catch(() => {});
  };

  if (!binding) { await answer(GENERIC_NOT_FOUND); return; }
  try {
  if (!/^[cdynr]:[0-9a-f-]{36}$/.test(data)) { await answer(GENERIC_NOT_FOUND); return; }
  const kind = data[0];
  const leadId = data.slice(2);

  const lead = await getClientLead(leadId, binding.business_id);
  if (!lead) { await answer(GENERIC_NOT_FOUND); return; }
  const business = await getBusinessById(binding.business_id);
  if (!business) { await answer(GENERIC_NOT_FOUND); return; }

  // Re-render from the database through the roofer-facing path, never from the
  // previous message text. If the read fails, edit only the keyboard.
  const render = async (view, keyboardExtra, reviewResult = null) => {
    if (!chatId || !messageId) return;
    try {
      const fresh = await getClientLead(leadId, binding.business_id);
      if (!fresh) throw new Error('lead_gone');
      const text = renderAlert({ business, lead: fresh, view, reviewResult });
      await editMessageText(chatId, messageId, text, keyboardExtra).catch(() => {});
    } catch (e) {
      console.error('tg_rerender_failed', (e && e.code) || 'no_code');
      await editMessageReplyMarkup(chatId, messageId, keyboardExtra && keyboardExtra.reply_markup).catch(() => {});
    }
  };

  if (kind === 'c') {                                   // open -> contacted only
    const result = await transitionLead(leadId, binding.business_id, 'contacted', null);
    if (!result.changed) { await answer(GENERIC_NOT_FOUND); return; }
    await answer('');
    try { await addEvent(leadId, 'status_changed', { status: 'contacted' }); } catch (e) {
      console.error('tg_status_event_failed', (e && e.code) || 'no_code');
    }
    try { await addEvent(leadId, 'contacted', {}); } catch (e) {
      console.error('tg_contacted_event_failed', (e && e.code) || 'no_code');
    }
    await render('contacted', { reply_markup: jobDoneKeyboard(leadId) });
    return;
  }

  if (kind === 'd') {                                   // ask before emailing
    if (lead.status === 'done') { await answer('This lead is already completed.'); return; }
    if (lead.status !== 'contacted' && lead.status !== 'quoted' && lead.status !== 'won') {
      await answer('Mark this lead as contacted first.');
      return;
    }
    await answer('');
    await render('confirm', { reply_markup: confirmKeyboard(leadId) });
    return;
  }

  if (kind === 'n') {                                   // cancel back to step 2
    await answer('');
    await render('contacted', { reply_markup: jobDoneKeyboard(leadId) });
    return;
  }

  if (kind === 'y') {                                   // contacted/quoted/won -> done
    if (lead.status === 'done') { await answer('This lead is already completed.'); return; }
    if (lead.status !== 'contacted' && lead.status !== 'quoted' && lead.status !== 'won') {
      await answer('Mark this lead as contacted first.');
      return;
    }
    const token = randomBytes(24).toString('base64url');
    const result = await transitionLead(leadId, binding.business_id, 'done', token);
    if (!result.changed) { await answer('This lead is already completed.'); return; }
    await answer('');
    try { await addEvent(leadId, 'status_changed', { status: 'done' }); } catch (e) {
      console.error('tg_status_event_failed', (e && e.code) || 'no_code');
    }
    let reviewResult = 'no_email';
    if (result.lead && result.lead.email) {
      const r = await sendReviewRequest({
        leadId, business,
        lead: { email: result.lead.email, name: result.lead.name, phone: result.lead.phone },
        token: result.lead.review_token || token,
      });
      reviewResult = r && r.ok ? 'sent' : 'failed';
    }
    if (reviewResult === 'failed') {
      await render('error', { reply_markup: tryAgainKeyboard(leadId) }, 'failed');
    } else {
      await render('done', { reply_markup: { inline_keyboard: [] } }, reviewResult);
    }
    return;
  }

  if (kind === 'r') {                                   // retry the failed review email only
    if (lead.status !== 'done') { await answer('Nothing to retry.'); return; }
    if (await hasReviewSent(leadId)) { await answer('Nothing to retry.'); return; }
    const retry = await getDoneLeadForRetry(leadId, binding.business_id);
    if (!retry || !retry.review_token || !retry.email) { await answer('Nothing to retry.'); return; }
    // Idempotency key: Resend caches per key for 24 h. After a timeout the
    // first request may have delivered, so reuse the plain key and let
    // Resend dedupe; after an HTTP error the cached failure must not be
    // replayed, so use a fresh suffixed key per earlier failure count.
    const failInfo = await getReviewFailureInfo(leadId);
    const retryKey = failInfo.lastStatus === 'timeout'
      ? `${leadId}:review`
      : `${leadId}:review:r${failInfo.count}`;
    await answer('');
    const r = await sendReviewRequest({
      leadId, business,
      lead: { email: retry.email, name: retry.name, phone: retry.phone },
      token: retry.review_token,
      idempotencyKey: retryKey,
    });
    if (r && r.ok) {
      await render('done', { reply_markup: { inline_keyboard: [] } }, 'sent');
    } else {
      await render('error', { reply_markup: tryAgainKeyboard(leadId) }, 'failed');
    }
    return;
  }
  } catch (e) {
    // A stuck spinner is worse than a generic error: whatever threw (lead
    // read, business read, sent-check, retry read, transition, email send),
    // log the code only and answer once.
    console.error('tg_callback_failed', (e && e.code) || 'no_code');
    await answer('Something went wrong. Try again.');
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  res.setHeader('Cache-Control', 'no-store');

  const auth = secretOk(req);
  if (auth === 'missing_env') return res.status(503).json({ ok: false });
  if (auth === 'bad') return res.status(401).json({ ok: false });

  // Authenticated: always answer 200 so Telegram does not retry in a storm.
  try {
    let u = req.body;
    if (typeof u === 'string') { try { u = JSON.parse(u); } catch { u = null; } }
    if (!u || typeof u !== 'object') return res.status(200).json({ ok: true });

    const msg = u.message || (u.callback_query && u.callback_query.message);
    const chat = msg && msg.chat;
    if (!chat || chat.type !== 'private') return res.status(200).json({ ok: true });
    const chatId = chat.id;
    const binding = await getChatBinding(chatId);

    if (u.message && typeof u.message.text === 'string') {
      const text = u.message.text.trim();
      if (text.startsWith('/start')) {
        await handleStart(chatId, text.slice(6).trim());
      } else if (text.startsWith('/leads')) {
        await handleLeads(chatId, binding);
      } else if (text.startsWith('/help')) {
        await reply(chatId, COMMAND_HELP);
      }
    } else if (u.callback_query) {
      await handleCallback(u.callback_query, binding);
    }
  } catch (e) {
    console.error('tg_update_failed', (e && e.code) || 'no_code');
  }
  return res.status(200).json({ ok: true });
}
