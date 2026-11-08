// Vercel serverless function: POST /api/tg — Telegram webhook.
//
// Auth first. Tenancy is ALWAYS derived from the sender's chat id through
// business_chats, never from message text or callback data. Reads of leads go
// through public.v_client_leads. Nothing here touches the private schema.

import { randomBytes } from 'node:crypto';
import {
  getChatBinding, bindChat, claimBindCode, restoreBindCode, getBusinessById, clearRateLimit,
  listClientLeads, getClientLead, transitionLead, getDoneLeadForRetry, hasReviewSent, getReviewFailureInfo, addEvent, hitRateLimit,
  countBusinessChats, countLiveBindCodes, listLiveBindCodes, expireLiveBindCodes, clearStaleRetryLock,
  listBusinessChatsDetailed, getBusinessChat, removeBusinessChat,
  getActiveBusinessBySlug, listBusinessSlugs, getChatById, removeChatById,
} from '../lib/db.js';
import { isOperatorChat } from '../lib/operator.js';
import { mintBindCode, BIND_CODE_HOURS } from '../lib/bind-codes.js';
import { sendMessage, answerCallbackQuery, editMessageText, editMessageReplyMarkup, botUsername } from '../lib/tg.js';
import { secretMatches } from '../lib/request.js';
import { sendReviewRequest, notifyOperatorUnreachable } from '../lib/notify.js';
import {
  renderAlert, renderLeadList, jobDoneKeyboard, confirmKeyboard, tryAgainKeyboard,
  botLinkedText, BOT_HELP, BOT_ALREADY_CONNECTED, BOT_NOT_CONNECTED, BOT_BAD_CODE, BOT_PLAIN_TEXT,
  botInviteText, botRecipientsText, recipientsKeyboard, recipientConfirmText, recipientConfirmKeyboard,
  BOT_INVITE_CAPPED, BOT_INVITE_CANCEL_BUTTON, BOT_INVITE_CANCEL_ALREADY, BOT_INVITE_RATE_LIMIT,
  botInvitePendingText, BOT_RECIPIENTS_PENDING, BOT_RECIPIENT_LAST, BOT_RECIPIENT_REMOVED, BOT_RECIPIENT_GONE,
  TOAST_NOT_FOUND, TOAST_ALREADY_DONE, TOAST_CONTACT_FIRST, TOAST_NOTHING_TO_RETRY, TOAST_GENERIC_ERROR,
  TOAST_ALREADY_UPDATED, TOAST_TOO_MANY_OPENS, TOAST_OWNER_ONLY, leadListKeyboard, alertKeyboard,
  BOT_CODE_BAD, BOT_ALREADY_CONNECTED_CODE, BOT_BOUND_ELSEWHERE, BOT_BIND_FAILED,
  BOT_OWNER_ONLY, BOT_RECIPIENTS_OWNER_NOTE, botForwardText,
  operatorCodeText, operatorCodeResendText, operatorPhonesText, operatorPhonesKeyboard,
  operatorConfirmRemoveText, operatorConfirmRemoveKeyboard, operatorBusinessesText,
  OPERATOR_USAGE_CODE, OPERATOR_USAGE_PHONES, OPERATOR_UNKNOWN_SLUG, OPERATOR_CAPPED, OPERATOR_NO_PHONES,
  OPERATOR_PHONE_REMOVED, OPERATOR_PHONE_GONE, OPERATOR_ID_TEXT, OPERATOR_HELP,
} from '../lib/content.js';

const GENERIC_NOT_FOUND = TOAST_NOT_FOUND;

function secretOk(req) {
  const want = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!want) return 'missing_env';
  return secretMatches(req, 'x-telegram-bot-api-secret-token', want) ? null : 'bad';
}

async function reply(chatId, text) {
  // Best effort. A failed reply changes nothing about the update.
  await sendMessage(chatId, text);
}

/* ---------- binding by pasted code ----------
   An unbound private chat that sends a code-shaped string is trying to connect.
   The claim is the same atomic single-use UPDATE as /start, and every failure
   gets one identical answer, so the reply cannot be used to tell "expired" from
   "already used" from "never existed". */

const CODE_SHAPE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/;
const BIND_TRIES_PER_HOUR = 10;
const BIND_TRIES_GLOBAL_PER_HOUR_DEFAULT = 600;
const bindTriesGlobal = () => positiveInt(process.env.BIND_TRIES_GLOBAL_PER_HOUR, BIND_TRIES_GLOBAL_PER_HOUR_DEFAULT);

/** Spaces and hyphens are ignored, case does not matter. Null when not code-shaped. */
function bindCodeShape(text) {
  const s = String(text || '').trim().replace(/[\s-]+/g, '').toUpperCase();
  return CODE_SHAPE.test(s) ? s : null;
}

/**
 * Claim, bind, then look at the real binding. A unique tg_chat_id turns a
 * second business's upsert into a silent no-op, so "no error" never means
 * "connected": only a read-back does. On any mismatch the claim is restored,
 * so the client is never charged a code for a bind that did not happen.
 */
async function finishBind(chatId, code, badText = BOT_CODE_BAD) {
  const businessId = await claimBindCode(code).catch(() => null);
  if (!businessId) return reply(chatId, badText);
  const business = await getBusinessById(businessId).catch(() => null);
  if (!business) {
    await restoreBindCode(code, businessId).catch(() => {});
    return reply(chatId, badText);
  }

  try {
    await bindChat(businessId, chatId);
  } catch (e) {
    await restoreBindCode(code, businessId).catch(() => {});
    console.error('bind_after_claim_failed', (e && e.code) || 'no_code');
    return reply(chatId, BOT_BIND_FAILED);
  }

  const actual = await getChatBinding(chatId).catch(() => null);
  if (!actual || String(actual.business_id) !== String(businessId)) {
    await restoreBindCode(code, businessId).catch(() => {});
    return reply(chatId, BOT_BOUND_ELSEWHERE);
  }

  return reply(chatId, botLinkedText(business.name));
}

async function handlePastedCode(chatId, code) {
  let within;
  try { within = await hitRateLimit('bindtry:' + chatId, 3600, BIND_TRIES_PER_HOUR); } catch { return; }
  if (!within) return reply(chatId, BOT_CODE_BAD);
  let global;
  try { global = await hitRateLimit('bindtry:all', 3600, bindTriesGlobal()); } catch { return; }
  if (!global) {
    // A global ceiling protects the table from a distributed guessing run. It
    // is not a per-chat answer, so say nothing new to the chat and log it.
    console.error('bind_ceiling_hit');
    return reply(chatId, BOT_CODE_BAD);
  }
  return finishBind(chatId, code);
}

/**
 * The owner phone is the oldest connected phone (no schema change). It is the
 * only one that may invite or remove; every phone keeps alerts, buttons and
 * /leads.
 */
async function isOwnerChat(businessId, chatId) {
  const rows = await listBusinessChatsDetailed(businessId);
  return rows.length > 0 && String(rows[0].tg_chat_id) === String(chatId);
}

async function handleStart(chatId, arg) {
  const existing = await getChatBinding(chatId);
  if (existing) {
    return reply(chatId, bindCodeShape(arg) ? BOT_ALREADY_CONNECTED_CODE : BOT_ALREADY_CONNECTED);
  }
  if (!arg) return reply(chatId, BOT_NOT_CONNECTED);

  return finishBind(chatId, arg, BOT_BAD_CODE);
}

/* ---------- lead list and lead recovery ----------
   Newest 8, one Open button each, one Older button when more exist. The page
   number is the only thing in the callback, bounded, and the business always
   comes from the binding. */

const LEADS_PAGE = 8;
const LEADS_PAGE_MAX = 50;
const OPENS_PER_HOUR = 30;

async function sendLeadsPage(chatId, businessId, page, messageId) {
  const safePage = Math.max(0, Math.min(LEADS_PAGE_MAX, Number(page) || 0));
  const leads = await listClientLeads(businessId, LEADS_PAGE + 1, safePage * LEADS_PAGE);
  const hasOlder = leads.length > LEADS_PAGE;
  const shown = leads.slice(0, LEADS_PAGE);
  if (!shown.length) {
    const text = safePage === 0 ? 'No requests yet.' : 'No older requests.';
    if (messageId) return editMessageText(chatId, messageId, text, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
    return reply(chatId, text);
  }
  const text = renderLeadList(shown);
  const markup = leadListKeyboard(shown, safePage, hasOlder);
  if (messageId) return editMessageText(chatId, messageId, text, markup).catch(() => {});
  return sendMessage(chatId, text, markup);
}

async function handleLeads(chatId, binding) {
  if (!binding) return reply(chatId, BOT_NOT_CONNECTED);
  return sendLeadsPage(chatId, binding.business_id, 0, null);
}

/**
 * The card for a lead in its CURRENT state: view, buttons and review result all
 * derived from the row, never from the message that was tapped.
 */
async function cardFor({ lead, leadId }) {
  if (lead.status === 'done') {
    const sent = await hasReviewSent(leadId).catch(() => false);
    if (sent) return { view: 'done', kb: { reply_markup: { inline_keyboard: [] } }, reviewResult: 'sent' };
    if (!lead.email) return { view: 'done', kb: { reply_markup: { inline_keyboard: [] } }, reviewResult: 'no_email' };
    return { view: 'error', kb: { reply_markup: tryAgainKeyboard(leadId) }, reviewResult: 'failed' };
  }
  if (lead.status === 'contacted' || lead.status === 'quoted' || lead.status === 'won') {
    return { view: 'contacted', kb: { reply_markup: jobDoneKeyboard(leadId) }, reviewResult: null };
  }
  return { view: 'new', kb: { reply_markup: alertKeyboard(leadId) }, reviewResult: null };
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

/** Remaining whole hours, rounded up, never below 1. */
const hoursLeft = (iso) => Math.max(1, Math.ceil((new Date(iso).getTime() - Date.now()) / 3600000));

/**
 * Mint one code and send the invite text. The rate limit is checked here, right
 * before a mint, so listing pending invites does not spend the hourly budget.
 * Fail closed, like the plain-text hint: no reply when the counter is unreachable.
 */
async function mintAndSendInvite(chatId, businessId) {
  let within;
  try { within = await hitRateLimit('invite:' + chatId, 3600, INVITES_PER_HOUR); } catch { return; }
  if (!within) return reply(chatId, BOT_INVITE_RATE_LIMIT);

  const { code } = await mintBindCode(businessId);
  // getMe() once per instance; a failure falls back to /start plus the code and
  // logs bot_username_unavailable rather than failing the invite.
  const username = await botUsername();
  return reply(chatId, botInviteText(code, { username }));
}

/** /invite — mint one single-use code for THIS chat's business. */
async function handleInvite(chatId, binding) {
  if (!binding) return reply(chatId, BOT_NOT_CONNECTED);
  if (!(await isOwnerChat(binding.business_id, chatId))) return reply(chatId, BOT_OWNER_ONLY);

  const [bound, pending] = await Promise.all([
    countBusinessChats(binding.business_id),
    countLiveBindCodes(binding.business_id),
  ]);
  if (bound >= recipientsMax()) return reply(chatId, BOT_INVITE_CAPPED);
  if (pending >= invitesMax()) {
    // Say how many are waiting and when each lapses, never the codes. The one
    // button cancels them and mints a fresh code, so a full cap is not a dead end.
    const rows = await listLiveBindCodes(binding.business_id);
    return sendMessage(chatId, botInvitePendingText({ hours: rows.map((r) => hoursLeft(r.expires_at)) }), {
      reply_markup: { inline_keyboard: [[{ text: BOT_INVITE_CANCEL_BUTTON, callback_data: 'i:c' }]] },
    });
  }

  return mintAndSendInvite(chatId, binding.business_id);
}

/**
 * The cap button. Owner only, business from the binding. The second tap inside
 * a minute must not mint a second code, so a short mutex gates the whole action.
 * The hourly mint budget is checked BEFORE expiring: a rate-limited tap must
 * leave the old invites alive.
 */
async function handleInviteCancel({ chatId, businessId, answer }) {
  if (!(await isOwnerChat(businessId, chatId))) { await answer(BOT_OWNER_ONLY); return; }

  let first;
  try { first = await hitRateLimit('invitecancel:' + businessId, 60, 1); } catch { await answer(TOAST_GENERIC_ERROR); return; }
  if (!first) { await answer(BOT_INVITE_CANCEL_ALREADY); return; }

  let within;
  try { within = await hitRateLimit('invite:' + chatId, 3600, INVITES_PER_HOUR); } catch { await answer(TOAST_GENERIC_ERROR); return; }
  if (!within) { await answer(BOT_INVITE_RATE_LIMIT); return; }

  try {
    await expireLiveBindCodes(businessId);
    const { code } = await mintBindCode(businessId);
    const username = await botUsername();
    await sendMessage(chatId, botInviteText(code, { username }));
    await answer(BOT_INVITE_CANCELLED);
  } catch (e) {
    console.error('invite_cancel_failed', (e && e.code) || 'no_code');
    await answer(TOAST_GENERIC_ERROR);
  }
}

/** The list, as a new message or as an edit of the one the button lives on. */
async function sendRecipients(chatId, businessId, messageId) {
  const rows = await listBusinessChatsDetailed(businessId);
  const pending = await countLiveBindCodes(businessId);
  const text = `${botRecipientsText(rows)}\n\n${BOT_RECIPIENTS_OWNER_NOTE}\n${BOT_RECIPIENTS_PENDING(pending)}`;
  const markup = { reply_markup: rows.length ? recipientsKeyboard(rows) : { inline_keyboard: [] } };
  if (messageId) return editMessageText(chatId, messageId, text, markup).catch(() => {});
  return sendMessage(chatId, text, markup);
}

/** /recipients — who receives alerts, with one Remove button per row. */
async function handleRecipients(chatId, binding) {
  if (!binding) return reply(chatId, BOT_NOT_CONNECTED);
  if (!(await isOwnerChat(binding.business_id, chatId))) return reply(chatId, BOT_OWNER_ONLY);
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
  if (!rows.length || String(rows[0].tg_chat_id) !== String(chatId)) {
    await answer(TOAST_OWNER_ONLY);
    return;
  }
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
async function handlePlainText(chatId, binding, text = '') {
  const shaped = bindCodeShape(text);
  if (binding) {
    // A bound chat never moves between businesses by pasting a code.
    if (shaped) return reply(chatId, BOT_ALREADY_CONNECTED_CODE);
  } else if (shaped) {
    return handlePastedCode(chatId, shaped);
  }
  let within;
  try {
    within = await hitRateLimit('tghint:' + chatId, 3600, 3);
  } catch { return; }
  if (!within) return;
  await reply(chatId, binding ? BOT_PLAIN_TEXT : BOT_NOT_CONNECTED);
}

/* ---------- operator commands ----------
   Authorised by chat id, in a private chat, on every message and every tap.
   A non-operator who sends one of these gets exactly what any unknown text gets
   (BOT_PLAIN_TEXT or BOT_NOT_CONNECTED), so the commands leave no trace. */

const SLUG_RE = /^[a-z0-9-]{2,60}$/;
const CODES_PER_SLUG_HOUR = 10;

async function handleOperatorCode(chatId, arg) {
  const slug = String(arg || '').trim();
  if (!SLUG_RE.test(slug)) return reply(chatId, OPERATOR_USAGE_CODE);
  // Fail closed: an unreachable counter means no code, not an unlimited one.
  let within;
  try { within = await hitRateLimit('opcode:' + slug, 3600, CODES_PER_SLUG_HOUR); } catch { return; }
  if (!within) return reply(chatId, OPERATOR_CAPPED);
  const business = await getActiveBusinessBySlug(slug).catch(() => null);
  if (!business) return reply(chatId, OPERATOR_UNKNOWN_SLUG);
  const { code } = await mintBindCode(business.id);
  const username = await botUsername();
  // TWO messages, strictly. The first is the operator's (slug, code, human
  // expiry); the second is the only text a client may ever see. They are
  // separate sends on purpose: forwarding the first would leak the slug, and
  // editing one message in place is not something Telegram guarantees.
  await reply(chatId, operatorCodeText({ slug: business.slug, code, hours: BIND_CODE_HOURS }));
  const forward = await sendMessage(chatId, botForwardText({ code, username, hours: BIND_CODE_HOURS }));
  if (!forward || !forward.ok) {
    // The code exists and is valid; only the forwardable copy failed. Say so
    // and repeat the code, or the operator is left with a half-finished flow.
    console.error('code_forward_send_failed');
    await reply(chatId, operatorCodeResendText({ code, hours: BIND_CODE_HOURS }));
  }
}

async function handleOperatorPhones(chatId, arg) {
  const slug = String(arg || '').trim();
  if (!SLUG_RE.test(slug)) return reply(chatId, OPERATOR_USAGE_PHONES);
  const business = await getActiveBusinessBySlug(slug).catch(() => null);
  if (!business) return reply(chatId, OPERATOR_UNKNOWN_SLUG);
  const rows = await listBusinessChatsDetailed(business.id);
  if (!rows.length) {
    return reply(chatId, `${OPERATOR_NO_PHONES}\n\n${business.name} (${business.slug}). Mint an invite with /code ${business.slug}.`);
  }
  return sendMessage(chatId, operatorPhonesText({ business, rows, ownerId: rows[0].id }), operatorPhonesKeyboard(rows));
}

async function handleOperatorBusinesses(chatId) {
  const slugs = await listBusinessSlugs().catch(() => []);
  const rows = [];
  for (const r of slugs) {
    const b = await getActiveBusinessBySlug(r.slug).catch(() => null);
    const phones = b ? await countBusinessChats(b.id).catch(() => 0) : 0;
    rows.push({ slug: r.slug, status: r.status, phones });
  }
  return reply(chatId, operatorBusinessesText(rows));
}

/**
 * p: ask, P: remove, q: cancel. The row id is the address; the business comes
 * from the row. The operator may remove the last phone, because locking them out
 * of their own recovery path is worse than an empty business — the warning says
 * exactly what will happen.
 */
async function handleOperatorPhoneCallback({ cb, kind, rowId, answer }) {
  const chatId = cb.message && cb.message.chat && cb.message.chat.id;
  const messageId = cb.message && cb.message.message_id;
  const row = await getChatById(rowId).catch(() => null);
  if (!row) { await answer(OPERATOR_PHONE_GONE); return; }
  const business = await getBusinessById(row.business_id).catch(() => null);
  if (!business) { await answer(OPERATOR_PHONE_GONE); return; }
  const rows = await listBusinessChatsDetailed(row.business_id);
  const index = rows.findIndex((r) => r.id === rowId);

  if (kind === 'p') {
    await answer('');
    return editMessageText(chatId, messageId,
      operatorConfirmRemoveText({ row, index: index < 0 ? rows.length : index, isLast: rows.length <= 1 }),
      operatorConfirmRemoveKeyboard(rowId)).catch(() => {});
  }
  if (kind === 'q') {
    await answer('');
    return editMessageText(chatId, messageId,
      operatorPhonesText({ business, rows, ownerId: rows[0] && rows[0].id }),
      operatorPhonesKeyboard(rows)).catch(() => {});
  }

  const removed = await removeChatById(rowId);
  await answer(removed ? OPERATOR_PHONE_REMOVED : OPERATOR_PHONE_GONE);
  const after = await listBusinessChatsDetailed(row.business_id);
  if (!after.length) {
    return editMessageText(chatId, messageId,
      `📵 ${business.name} (${business.slug}) has no phones connected.\n\nNobody will receive alerts for this business until a new phone is connected. Mint an invite with /code ${business.slug}.`,
      { reply_markup: { inline_keyboard: [] } }).catch(() => {});
  }
  return editMessageText(chatId, messageId,
    operatorPhonesText({ business, rows: after, ownerId: after[0].id }),
    operatorPhonesKeyboard(after)).catch(() => {});
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
    let text;
    try {
      const fresh = await getClientLead(leadId, businessId);
      if (!fresh) throw new Error('lead_gone');
      text = renderAlert({ business, lead: fresh, view, reviewResult });
    } catch (e) {
      console.error('tg_rerender_failed', (e && e.code) || 'no_code');
      await editMessageReplyMarkup(chatId, messageId, keyboardExtra && keyboardExtra.reply_markup).catch(() => {});
      return;
    }
    const edited = await editMessageText(chatId, messageId, text, keyboardExtra).catch(() => ({ ok: false }));
    if (edited && edited.ok) return;
    // Too old to edit (Telegram refuses, or the bot was restarted): send the
    // current card as a new message rather than leaving stale buttons on screen.
    await sendMessage(chatId, text, keyboardExtra).catch(() => {});
  };

  /** Re-render this lead in whatever state it is in NOW. Used by a stale tap. */
  const renderCurrent = async () => {
    const fresh = await getClientLead(leadId, businessId).catch(() => null);
    if (!fresh) return;
    const card = await cardFor({ lead: fresh, leadId });
    await render(card.view, card.kb, card.reviewResult);
  };

  return { answer, render, renderCurrent, lead, leadId, businessId, business };
}

/** c: open -> contacted only. */
async function onContacted(ctx) {
  const { answer, render, leadId, businessId } = ctx;
  const result = await transitionLead(leadId, businessId, 'contacted', null);
  if (!result.changed) {
    // The lead exists — a second phone, or a double tap, moved it first. Show
    // the current card instead of the "Not found." lie.
    await answer(TOAST_ALREADY_UPDATED);
    await ctx.renderCurrent();
    return;
  }
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
  if (lead.status === 'done') { await answer(TOAST_ALREADY_UPDATED); await ctx.renderCurrent(); return; }
  if (lead.status !== 'contacted' && lead.status !== 'quoted' && lead.status !== 'won') {
    await answer(TOAST_CONTACT_FIRST);
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
  if (lead.status === 'done') { await answer(TOAST_ALREADY_UPDATED); await ctx.renderCurrent(); return; }
  if (lead.status !== 'contacted' && lead.status !== 'quoted' && lead.status !== 'won') {
    await answer(TOAST_CONTACT_FIRST);
    return;
  }
  const token = randomBytes(24).toString('base64url');
  const result = await transitionLead(leadId, businessId, 'done', token);
  if (!result.changed) { await answer(TOAST_ALREADY_UPDATED); await ctx.renderCurrent(); return; }
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
  if (lead.status !== 'done') { await answer(TOAST_NOTHING_TO_RETRY); return; }
  if (await hasReviewSent(leadId)) { await answer(TOAST_NOTHING_TO_RETRY); return; }
  // Mutex for a double tap. Two concurrent r: callbacks both pass the checks
  // above; rate_limits is the only atomic primitive available without a schema
  // change, so the first tap claims the retry and the second becomes a no-op.
  // The claim is RELEASED when the attempt finishes (finally below), so this is
  // a lock for the duration of the send, not a debounce: a later retry after a
  // failure is allowed again. Fails open — a retry the owner asked for matters
  // more than the lock.
  // The lock is keyed by the failure generation, not by time: two taps for the
  // same attempt share one key, so exactly one wins even across a clock bucket
  // edge (the old 10 s bucket let a tap landing just after the edge through).
  // A failure writes a new event, which moves the next attempt to a new key;
  // a crash leaves the key behind, so a claim older than 5 minutes is cleared
  // on the next attempt rather than blocking the lead forever.
  const failInfo = await getReviewFailureInfo(leadId);
  const lockKey = `retry:${leadId}:${failInfo.count}`;
  let claimed = true;
  try {
    await clearStaleRetryLock(lockKey, new Date(Date.now() - 310 * 1000).toISOString());
    claimed = await hitRateLimit(lockKey, 300, 1);
  } catch { claimed = true; }
  if (!claimed) { await answer(TOAST_NOTHING_TO_RETRY); return; }
  let sentOk = false;
  try {
    // Re-check AFTER the claim: the check at the top can be true for both taps.
    if (await hasReviewSent(leadId)) { await answer(TOAST_NOTHING_TO_RETRY); return; }
    const retry = await getDoneLeadForRetry(leadId, businessId);
    if (!retry || !retry.review_token || !retry.email) { await answer(TOAST_NOTHING_TO_RETRY); return; }
    // Idempotency key: Resend caches per key for 24 h. After a timeout the
    // timed-out attempt may have delivered, so reuse its EXACT key (recorded
    // in that failure's meta) and let Resend dedupe; after any other failure
    // the cached failure must not be replayed, so use a fresh suffixed key
    // named by the earlier failure count. A new suffixed key can never equal
    // an earlier one: earlier suffixes are r1..r(count-1), this one is r<count>.
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
      // Keep the claim: the send succeeded, so no tap needs this lock again.
      sentOk = true;
      await render('done', { reply_markup: { inline_keyboard: [] } }, 'sent');
    } else {
      await render('error', { reply_markup: tryAgainKeyboard(leadId) }, 'failed');
    }
  } finally {
    // Only a failed attempt releases the lock. A success keeps it, and the
    // lead is done anyway, so no later tap can reach this handler.
    if (!sentOk) {
      try { await clearRateLimit(lockKey); } catch { /* the next generation is a new key */ }
    }
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

const CB_LEAD = /^([cdynrvxo]):([0-9a-f-]{36})$/;
const CB_RECIPIENT = /^([xXv]):([0-9a-f-]{36})$/;
const CB_OPERATOR_PHONE = /^([pPq]):([0-9a-f-]{36})$/;
const CB_PAGE = /^l:(\d{1,3})$/;
// The invite-cap button. No business id in the payload: the business comes from
// the binding, so a forged callback can only ever act on the sender's own.
const CB_INVITE_CANCEL = /^i:c$/;

/** Open one lead as a NEW message with its current card. */
async function handleOpenLead({ cb, leadId, binding, answer }) {
  const chatId = cb.message && cb.message.chat && cb.message.chat.id;
  let within;
  // Fail closed: a stuck counter must not become an unlimited open loop.
  try { within = await hitRateLimit('open:' + chatId, 3600, OPENS_PER_HOUR); } catch { return; }
  if (!within) { await answer(TOAST_TOO_MANY_OPENS); return; }
  const lead = await getClientLead(leadId, binding.business_id).catch(() => null);
  if (!lead) { await answer(GENERIC_NOT_FOUND); return; }
  const business = await getBusinessById(binding.business_id).catch(() => null);
  if (!business) { await answer(GENERIC_NOT_FOUND); return; }
  const card = await cardFor({ lead, leadId });
  await answer('');
  await sendMessage(chatId, renderAlert({ business, lead, view: card.view, reviewResult: card.reviewResult }), card.kb);
}

/**
 * One dispatcher. Operator callbacks are authorised by chat id and handled
 * before the binding is even read; everything else needs a binding and is
 * addressed by a lead id or a business_chats row id, never by a business id.
 */
async function handleCallback(cb, binding) {
  const data = String(cb.data || '');
  const answer = createAnswerOnce(cb.id);
  const chat = (cb.message && cb.message.chat) || {};
  const chatId = chat.id;
  const chatType = chat.type;
  const messageId = cb.message && cb.message.message_id;

  try {
    const opPhone = CB_OPERATOR_PHONE.exec(data);
    if (opPhone) {
      // A non-operator tapping a forged p:/P:/q: gets the same answer as any
      // unknown callback, and nothing is read or written.
      if (!isOperatorChat(chatId, chatType)) { await answer(GENERIC_NOT_FOUND); return; }
      await handleOperatorPhoneCallback({ cb, kind: opPhone[1], rowId: opPhone[2], answer });
      return;
    }

    if (!binding) { await answer(GENERIC_NOT_FOUND); return; }

    if (CB_INVITE_CANCEL.test(data)) {
      await handleInviteCancel({ chatId, businessId: binding.business_id, answer });
      return;
    }

    const page = CB_PAGE.exec(data);
    if (page) {
      await answer('');
      await sendLeadsPage(chatId, binding.business_id, Number(page[1]), messageId);
      return;
    }

    const recipient = CB_RECIPIENT.exec(data);
    if (recipient) {
      await handleRecipientCallback({ cb, kind: recipient[1], rowId: recipient[2], binding, answer });
      return;
    }

    const m = CB_LEAD.exec(data);
    if (!m) { await answer(GENERIC_NOT_FOUND); return; }
    const kind = m[1];
    const leadId = m[2];

    if (kind === 'o') { await handleOpenLead({ cb, leadId, binding, answer }); return; }

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
    await answer(TOAST_GENERIC_ERROR);
  }
}

/**
 * The bot was blocked, or removed from the chat. Telegram sends this only when
 * the update is in allowed_updates (lib/tg.js setWebhook). Deleting a chat does
 * NOT send it — that shows up as a 403 on the next alert instead.
 */
async function handleChatMember(m) {
  const chat = (m && m.chat) || {};
  if (chat.type !== 'private') return;
  const status = m.new_chat_member && m.new_chat_member.status;
  if (status !== 'kicked' && status !== 'left') return;
  const binding = await getChatBinding(chat.id).catch(() => null);
  if (!binding) return;
  console.error('tg_bot_blocked');
  const business = await getBusinessById(binding.business_id).catch(() => null);
  if (business) await notifyOperatorUnreachable({ business, chatId: chat.id });
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
    // my_chat_member carries the chat at the top level, not inside a message.
    const chat = (msg && msg.chat) || (u.my_chat_member && u.my_chat_member.chat);
    if (!chat || chat.type !== 'private') return res.status(200).json({ ok: true });
    const chatId = chat.id;
    const binding = await getChatBinding(chatId);

    if (u.message && typeof u.message.text === 'string') {
      const text = u.message.text.trim();
      const token = text.split(/\s+/)[0];
      let first = token.toLowerCase();
      // /command@botname is how a command arrives from a client that appends the
      // bot. Only this bot's own username is stripped; another bot's suffix is
      // not a command at all, and falls through to the plain-text path.
      const at = first.indexOf('@');
      if (at > 0) {
        const suffix = first.slice(at + 1);
        const own = (await botUsername()) || String(process.env.TELEGRAM_BOT_USERNAME || '').toLowerCase();
        if (!own || suffix !== String(own).toLowerCase()) {
          await handlePlainText(chatId, binding, text);
          return res.status(200).json({ ok: true });
        }
        first = first.slice(0, at);
      }
      const arg = text.slice(token.length).trim();
      if (first === '/start') {
        await handleStart(chatId, arg);
      } else if (first === '/leads') {
        await handleLeads(chatId, binding);
      } else if (first === '/invite') {
        await handleInvite(chatId, binding);
      } else if (first === '/recipients') {
        await handleRecipients(chatId, binding);
      } else if (first === '/help') {
        await reply(chatId, binding ? BOT_HELP : BOT_NOT_CONNECTED);
      } else if (first === '/id') {
        // Every private chat, bound or not, operator or not: it is how the
        // operator learns OPERATOR_CHAT_ID without a third-party bot. Not in
        // the command menu.
        await reply(chatId, OPERATOR_ID_TEXT(chatId));
      } else if (isOperatorChat(chatId, chat.type)) {
        // Operator commands. A non-operator never reaches this branch, so the
        // reply they get is the same as for any unknown text.
        if (first === '/code') await handleOperatorCode(chatId, arg);
        else if (first === '/phones') await handleOperatorPhones(chatId, arg);
        else if (first === '/businesses') await handleOperatorBusinesses(chatId);
        else if (first === '/operator') await reply(chatId, OPERATOR_HELP);
        else await handlePlainText(chatId, binding, text);
      } else {
        await handlePlainText(chatId, binding, text);
      }
    } else if (u.callback_query) {
      await handleCallback(u.callback_query, binding);
    } else if (u.my_chat_member) {
      await handleChatMember(u.my_chat_member);
    }
  } catch (e) {
    console.error('tg_update_failed', (e && e.code) || 'no_code');
  }
  return res.status(200).json({ ok: true });
}
