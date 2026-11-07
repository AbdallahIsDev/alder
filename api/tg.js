// Vercel serverless function: POST /api/tg — Telegram webhook.
//
// Auth first. Tenancy is ALWAYS derived from the sender's chat id through
// business_chats, never from message text or callback data. Reads of leads go
// through public.v_client_leads. Nothing here touches the private schema.

import { randomBytes } from 'node:crypto';
import {
  getChatBinding, bindChat, claimBindCode, getBusinessById, clearRateLimit,
  listClientLeads, getClientLead, transitionLead, getDoneLeadForRetry, hasReviewSent, getReviewFailureInfo, addEvent, hitRateLimit,
  countBusinessChats, countLiveBindCodes, listBusinessChatsDetailed, getBusinessChat, removeBusinessChat,
} from '../lib/db.js';
import { mintBindCode } from '../lib/bind-codes.js';
import { sendMessage, answerCallbackQuery, editMessageText, editMessageReplyMarkup } from '../lib/tg.js';
import { secretMatches } from '../lib/request.js';
import { sendReviewRequest } from '../lib/notify.js';
import {
  renderAlert, renderLeadList, jobDoneKeyboard, confirmKeyboard, tryAgainKeyboard,
  botLinkedText, BOT_HELP, BOT_ALREADY_CONNECTED, BOT_NOT_CONNECTED, BOT_BAD_CODE, BOT_PLAIN_TEXT,
  botInviteText, botRecipientsText, recipientsKeyboard, recipientConfirmText, recipientConfirmKeyboard,
  BOT_INVITE_CAPPED, BOT_INVITE_PENDING, BOT_RECIPIENT_LAST, BOT_RECIPIENT_REMOVED, BOT_RECIPIENT_GONE,
} from '../lib/content.js';

const GENERIC_NOT_FOUND = 'Not found.';

function secretOk(req) {
  const want = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!want) return 'missing_env';
  return secretMatches(req, 'x-telegram-bot-api-secret-token', want) ? null : 'bad';
}

async function reply(chatId, text) {
  // Best effort. A failed reply changes nothing about the update.
  await sendMessage(chatId, text);
}

async function handleStart(chatId, arg) {
  const existing = await getChatBinding(chatId);
  if (existing) return reply(chatId, BOT_ALREADY_CONNECTED);
  if (!arg) return reply(chatId, BOT_NOT_CONNECTED);

  const businessId = await claimBindCode(arg);
  if (!businessId) return reply(chatId, BOT_BAD_CODE);
  const business = await getBusinessById(businessId);
  if (!business) return reply(chatId, BOT_BAD_CODE);

  await bindChat(businessId, chatId);
  return reply(chatId, botLinkedText(business.name));
}

async function handleLeads(chatId, binding) {
  if (!binding) return reply(chatId, BOT_NOT_CONNECTED);
  const leads = await listClientLeads(binding.business_id, 10);
  if (!leads.length) return reply(chatId, 'No requests yet.');
  return reply(chatId, renderLeadList(leads));
}

/* ---------- recipients ----------
   One business, up to a handful of phones. Tenancy is always the caller's own
   binding: nothing here reads a business id from the message or the callback. */

const RECIPIENTS_MAX_DEFAULT = 5;
const INVITES_MAX_DEFAULT = 3;
const INVITES_PER_HOUR = 5;

const positiveInt = (raw, fallback) => {
  const n = Number(raw || fallback);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
export const recipientsMax = () => positiveInt(process.env.RECIPIENTS_MAX, RECIPIENTS_MAX_DEFAULT);
export const invitesMax = () => positiveInt(process.env.INVITES_MAX, INVITES_MAX_DEFAULT);

/** /invite — mint one single-use code for THIS chat's business. */
async function handleInvite(chatId, binding) {
  if (!binding) return reply(chatId, BOT_NOT_CONNECTED);
  // Fail closed, like the plain-text hint: no reply when the counter is unreachable.
  let within;
  try { within = await hitRateLimit('invite:' + chatId, 3600, INVITES_PER_HOUR); } catch { return; }
  if (!within) return;

  const [bound, pending] = await Promise.all([
    countBusinessChats(binding.business_id),
    countLiveBindCodes(binding.business_id),
  ]);
  if (bound >= recipientsMax()) return reply(chatId, BOT_INVITE_CAPPED);
  if (pending >= invitesMax()) return reply(chatId, BOT_INVITE_PENDING);

  const { code } = await mintBindCode(binding.business_id);
  return reply(chatId, botInviteText(code));
}

/** The list, as a new message or as an edit of the one the button lives on. */
async function sendRecipients(chatId, businessId, messageId) {
  const rows = await listBusinessChatsDetailed(businessId);
  const text = botRecipientsText(rows);
  const markup = { reply_markup: rows.length ? recipientsKeyboard(rows) : { inline_keyboard: [] } };
  if (messageId) return editMessageText(chatId, messageId, text, markup).catch(() => {});
  return sendMessage(chatId, text, markup);
}

/** /recipients — who receives alerts, with one Remove button per row. */
async function handleRecipients(chatId, binding) {
  if (!binding) return reply(chatId, BOT_NOT_CONNECTED);
  return sendRecipients(chatId, binding.business_id);
}

/**
 * x: ask before removing, X: remove, v: cancel.
 * Scoped by business AND row id, so a forged callback from another business
 * finds nothing. The confirm tap is idempotent: a second X removes nothing and
 * says so instead of throwing.
 */
async function handleRecipientCallback({ cb, kind, rowId, binding, answer }) {
  const chatId = cb.message && cb.message.chat && cb.message.chat.id;
  const messageId = cb.message && cb.message.message_id;
  const rows = await listBusinessChatsDetailed(binding.business_id);
  const index = rows.findIndex((r) => r.id === rowId);

  if (kind === 'x') {
    const row = index >= 0 ? rows[index] : await getBusinessChat(binding.business_id, rowId);
    if (!row) { await answer(BOT_RECIPIENT_GONE); return sendRecipients(chatId, binding.business_id, messageId); }
    await answer('');
    return editMessageText(chatId, messageId, recipientConfirmText(row, index < 0 ? rows.length : index), {
      reply_markup: recipientConfirmKeyboard(rowId),
    }).catch(() => {});
  }

  if (kind === 'v') {
    await answer('');
    return sendRecipients(chatId, binding.business_id, messageId);
  }

  // X: the confirm tap. Existence first: after a successful removal the list has
  // one row left, and a second tap must say "already removed", not "that is the
  // last phone". The delete is still scoped by business AND row, and reports 0
  // rows if two taps race.
  const row = index >= 0 ? rows[index] : await getBusinessChat(binding.business_id, rowId);
  if (!row) { await answer(BOT_RECIPIENT_GONE); return sendRecipients(chatId, binding.business_id, messageId); }
  if (rows.length <= 1) { await answer(BOT_RECIPIENT_LAST); return; }
  const removed = await removeBusinessChat(binding.business_id, rowId);
  await answer(removed ? BOT_RECIPIENT_REMOVED : BOT_RECIPIENT_GONE);
  return sendRecipients(chatId, binding.business_id, messageId);
}

/** Plain-text hint, at most 3 per chat per hour; fail closed (no reply). */
async function handlePlainText(chatId, binding) {
  let within;
  try {
    within = await hitRateLimit('tghint:' + chatId, 3600, 3);
  } catch { return; }
  if (!within) return;
  await reply(chatId, binding ? BOT_PLAIN_TEXT : BOT_NOT_CONNECTED);
}

/* ---------- callback handling ----------
   handleCallback authenticates, parses, reads the lead once, then dispatches on
   the first character of callback_data. One function per kind; the shared
   answer() answers at most once, so a handler that already answered and then
   throws does not produce a second toast. */

/** Everything a handler needs, including render(), which re-reads the lead. */
function makeContext({ cb, business, lead, leadId, businessId, answer }) {
  const chatId = cb.message && cb.message.chat && cb.message.chat.id;
  const messageId = cb.message && cb.message.message_id;

  // Re-render from the database through the roofer-facing path, never from the
  // previous message text. If the read fails, edit only the keyboard.
  const render = async (view, keyboardExtra, reviewResult = null) => {
    if (!chatId || !messageId) return;
    try {
      const fresh = await getClientLead(leadId, businessId);
      if (!fresh) throw new Error('lead_gone');
      const text = renderAlert({ business, lead: fresh, view, reviewResult });
      await editMessageText(chatId, messageId, text, keyboardExtra).catch(() => {});
    } catch (e) {
      console.error('tg_rerender_failed', (e && e.code) || 'no_code');
      await editMessageReplyMarkup(chatId, messageId, keyboardExtra && keyboardExtra.reply_markup).catch(() => {});
    }
  };

  return { answer, render, lead, leadId, businessId, business };
}

/** c: open -> contacted only. */
async function onContacted(ctx) {
  const { answer, render, leadId, businessId } = ctx;
  const result = await transitionLead(leadId, businessId, 'contacted', null);
  if (!result.changed) { await answer(GENERIC_NOT_FOUND); return; }
  await answer('');
  try { await addEvent(leadId, 'status_changed', { status: 'contacted' }); } catch (e) {
    console.error('tg_status_event_failed', (e && e.code) || 'no_code');
  }
  try { await addEvent(leadId, 'contacted', {}); } catch (e) {
    console.error('tg_contacted_event_failed', (e && e.code) || 'no_code');
  }
  await render('contacted', { reply_markup: jobDoneKeyboard(leadId) });
}

/** d: ask before emailing; no write, no email. */
async function onJobDone(ctx) {
  const { answer, render, lead, leadId } = ctx;
  if (lead.status === 'done') { await answer('This lead is already completed.'); return; }
  if (lead.status !== 'contacted' && lead.status !== 'quoted' && lead.status !== 'won') {
    await answer('Mark this lead as contacted first.');
    return;
  }
  await answer('');
  await render('confirm', { reply_markup: confirmKeyboard(leadId, !!lead.email) });
}

/** n: cancel back to step 2. No write. */
async function onCancel(ctx) {
  const { answer, render, leadId } = ctx;
  await answer('');
  await render('contacted', { reply_markup: jobDoneKeyboard(leadId) });
}

/** y: contacted/quoted/won -> done, then send the review request. */
async function onConfirm(ctx) {
  const { answer, render, lead, leadId, businessId, business } = ctx;
  if (lead.status === 'done') { await answer('This lead is already completed.'); return; }
  if (lead.status !== 'contacted' && lead.status !== 'quoted' && lead.status !== 'won') {
    await answer('Mark this lead as contacted first.');
    return;
  }
  const token = randomBytes(24).toString('base64url');
  const result = await transitionLead(leadId, businessId, 'done', token);
  if (!result.changed) { await answer('This lead is already completed.'); return; }
  // Post-transition: the lead is done, so a throw here must not leave the
  // old Yes/Cancel buttons on screen (Yes would only say "already
  // completed" and Try again would never be offered). Best-effort render
  // of the error view (or the no-email done view) instead; no second answer.
  try {
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
  } catch (e) {
    console.error('tg_callback_failed', (e && e.code) || 'no_code');
    if (result.lead && result.lead.email) {
      await render('error', { reply_markup: tryAgainKeyboard(leadId) }, 'failed');
    } else {
      await render('done', { reply_markup: { inline_keyboard: [] } }, 'no_email');
    }
  }
}

/** r: retry the failed review email only. */
async function onRetry(ctx) {
  const { answer, render, lead, leadId, businessId, business } = ctx;
  if (lead.status !== 'done') { await answer('Nothing to retry.'); return; }
  if (await hasReviewSent(leadId)) { await answer('Nothing to retry.'); return; }
  // Mutex for a double tap. Two concurrent r: callbacks both pass the checks
  // above; rate_limits is the only atomic primitive available without a schema
  // change, so the first tap claims the retry and the second becomes a no-op.
  // The claim is RELEASED when the attempt finishes (finally below), so this is
  // a lock for the duration of the send, not a debounce: a later retry after a
  // failure is allowed again. Fails open — a retry the owner asked for matters
  // more than the lock.
  let claimed = true;
  try { claimed = await hitRateLimit('retry:' + leadId, 10, 1); } catch { claimed = true; }
  if (!claimed) { await answer('Nothing to retry.'); return; }
  try {
    const retry = await getDoneLeadForRetry(leadId, businessId);
    if (!retry || !retry.review_token || !retry.email) { await answer('Nothing to retry.'); return; }
    // Idempotency key: Resend caches per key for 24 h. After a timeout the
    // timed-out attempt may have delivered, so reuse its EXACT key (recorded
    // in that failure's meta) and let Resend dedupe; after any other failure
    // the cached failure must not be replayed, so use a fresh suffixed key
    // named by the earlier failure count. A new suffixed key can never equal
    // an earlier one: earlier suffixes are r1..r(count-1), this one is r<count>.
    const failInfo = await getReviewFailureInfo(leadId);
    const retryKey = failInfo.lastStatus === 'timeout'
      ? (failInfo.lastKey || `${leadId}:review`)
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
  } finally {
    try { await clearRateLimit('retry:' + leadId); } catch { /* the window expires on its own */ }
  }
}

const CALLBACK_HANDLERS = {
  c: onContacted,
  d: onJobDone,
  n: onCancel,
  y: onConfirm,
  r: onRetry,
};

/**
 * An answerer that reaches Telegram at most once per callback query.
 *
 * Every branch answers exactly once (a spinner that never stops is worse than a
 * generic toast), and a handler that somehow answered and then threw must not
 * produce a second toast. Exported so the guard can be exercised on its own.
 */
export function createAnswerOnce(id) {
  let answered = false;
  return (text) => {
    if (answered) return Promise.resolve();
    answered = true;
    return answerCallbackQuery(id, text).catch(() => {});
  };
}

async function handleCallback(cb, binding) {
  const data = String(cb.data || '');
  const answer = createAnswerOnce(cb.id);

  if (!binding) { await answer(GENERIC_NOT_FOUND); return; }
  try {
    // x/X/v address a business_chats row; the rest address a lead.
    if (!/^[cdynrvxX]:[0-9a-f-]{36}$/.test(data)) { await answer(GENERIC_NOT_FOUND); return; }
    const kind = data[0];
    const leadId = data.slice(2);

    if (kind === 'x' || kind === 'X' || kind === 'v') {
      await handleRecipientCallback({ cb, kind, rowId: leadId, binding, answer });
      return;
    }

    const lead = await getClientLead(leadId, binding.business_id);
    if (!lead) { await answer(GENERIC_NOT_FOUND); return; }
    const business = await getBusinessById(binding.business_id);
    if (!business) { await answer(GENERIC_NOT_FOUND); return; }

    const handler = CALLBACK_HANDLERS[kind];
    if (!handler) { await answer(GENERIC_NOT_FOUND); return; }
    await handler(makeContext({ cb, business, lead, leadId, businessId: binding.business_id, answer }));
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
      } else if (text.startsWith('/invite')) {
        await handleInvite(chatId, binding);
      } else if (text.startsWith('/recipients')) {
        await handleRecipients(chatId, binding);
      } else if (text.startsWith('/help')) {
        await reply(chatId, binding ? BOT_HELP : BOT_NOT_CONNECTED);
      } else {
        await handlePlainText(chatId, binding);
      }
    } else if (u.callback_query) {
      await handleCallback(u.callback_query, binding);
    }
  } catch (e) {
    console.error('tg_update_failed', (e && e.code) || 'no_code');
  }
  return res.status(200).json({ ok: true });
}
