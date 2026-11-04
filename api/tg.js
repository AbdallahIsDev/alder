// Vercel serverless function: POST /api/tg — Telegram webhook.
//
// Auth first. Tenancy is ALWAYS derived from the sender's chat id through
// business_chats, never from message text or callback data. Reads of leads go
// through public.v_client_leads. Nothing here touches the private schema.

import { timingSafeEqual, randomBytes } from 'node:crypto';
import {
  getChatBinding, bindChat, claimBindCode, getBusinessById,
  listClientLeads, transitionLead, addEvent,
} from '../lib/db.js';
import { sendMessage, answerCallbackQuery, editMessageText } from '../lib/tg.js';
import { sendReviewRequest } from '../lib/notify.js';

const GENERIC_UNBOUND = 'This chat is not linked to a business. Ask your administrator for a link.';
const GENERIC_BAD_CODE = 'That link is not valid. Ask for a new one.';
const GENERIC_HELP = 'Send /start followed by the link code you were given, or use /leads to see open requests.';
const GENERIC_NOT_FOUND = 'Not found.';
const ALREADY_BOUND = 'This chat is already linked to a business. Contact support to move it.';

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
  const lines = leads.map((l, i) =>
    `${i + 1}. ${l.name} — ${l.service} · ${l.phone} · ${relativeAge(l.created_at)} · ${l.status}`);
  return reply(chatId, 'Recent requests\n' + lines.join('\n'));
}

async function handleCallback(cb, binding) {
  const id = cb.id;
  const data = String(cb.data || '');
  const chatId = cb.message && cb.message.chat && cb.message.chat.id;
  const messageId = cb.message && cb.message.message_id;
  const originalText = (cb.message && cb.message.text) || '';
  const answer = (text) => answerCallbackQuery(id, text).catch(() => {});

  if (!binding) { await answer(GENERIC_NOT_FOUND); return; }
  const kind = data[0];
  if ((kind !== 'c' && kind !== 'd') || data[1] !== ':') { await answer(GENERIC_NOT_FOUND); return; }
  const leadId = data.slice(2);
  if (!/^[0-9a-f-]{36}$/i.test(leadId)) { await answer(GENERIC_NOT_FOUND); return; }

  const target = kind === 'c' ? 'contacted' : 'done';
  const token = kind === 'd' ? randomBytes(24).toString('base64url') : null;
  const result = await transitionLead(leadId, binding.business_id, target, token);
  if (!result.changed) { await answer(GENERIC_NOT_FOUND); return; }

  await answer('');
  try { await addEvent(leadId, 'status_changed', { status: target }); } catch (e) {
    console.error('tg_status_event_failed', (e && e.code) || 'no_code');
  }
  if (kind === 'c') {
    try { await addEvent(leadId, 'contacted', {}); } catch (e) {
      console.error('tg_contacted_event_failed', (e && e.code) || 'no_code');
    }
  }

  const mark = kind === 'c' ? 'Contacted' : 'Done';
  // After Contacted keep ONLY the "Job done" button so the natural order can
  // continue; after Done remove every button.
  const keyboard = kind === 'c'
    ? { inline_keyboard: [[{ text: 'Job done', callback_data: 'd:' + leadId }]] }
    : { inline_keyboard: [] };
  if (chatId && messageId) {
    await editMessageText(chatId, messageId, originalText + '\n' + mark, { reply_markup: keyboard }).catch(() => {});
  }

  // The review email is triggered only when the done-UPDATE actually returned a row.
  if (kind === 'd' && result.lead && result.lead.review_token) {
    const business = await getBusinessById(binding.business_id);
    if (business) {
      await sendReviewRequest({
        leadId, business,
        lead: { email: result.lead.email, name: result.lead.name, phone: result.lead.phone },
        token: result.lead.review_token,
      });
    }
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
      }
    } else if (u.callback_query) {
      await handleCallback(u.callback_query, binding);
    }
  } catch (e) {
    console.error('tg_update_failed', (e && e.code) || 'no_code');
  }
  return res.status(200).json({ ok: true });
}
