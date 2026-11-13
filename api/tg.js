// Vercel serverless function: POST /api/tg — Telegram webhook.
//
// Auth first. Tenancy is ALWAYS derived from the sender's chat id through
// business_chats, never from message text or callback data. Reads of leads go
// through public.v_client_leads. Nothing here touches the private schema.

import { randomBytes } from 'node:crypto';
import {
  getChatBinding, bindChat, claimBindCode, restoreBindCode, getBindCodeState, getBusinessById, clearRateLimit, deleteLeadScoped,
  listClientLeads, getClientLead, transitionLead, getDoneLeadForRetry, hasReviewSent, getReviewFailureInfo, addEvent, hitRateLimit,
  countBusinessChats, countBusinessesByName, countLiveBindCodes, listLiveBindCodes, expireLiveBindCodes, clearStaleRetryLock,
  listBusinessChatsDetailed, getBusinessChat, removeBusinessChat,
  getActiveBusinessBySlug, listBusinessSlugs, listPickerBusinesses, getChatById, removeChatById,
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
  TOAST_NO_OLDER, TOAST_NO_LEADS, TOAST_NO_REMOVE, BOT_INVITE_FORWARD_HINT,
  BOT_CODE_BAD, BOT_ALREADY_CONNECTED_CODE, BOT_BOUND_ELSEWHERE, BOT_BIND_FAILED, TOAST_LEAD_GONE, BOT_RECIPIENT_SELF,
  removeLeadListText, removeLeadKeyboard, removeLeadConfirmText, removeLeadConfirmKeyboard, removedText, REMOVE_LEAD_GONE,
  OPERATOR_ALREADY_CONNECTED_CODE, OPERATOR_DO_NOT_OPEN, OPERATOR_WELCOME, OPERATOR_CODE_USED, OPERATOR_CODE_EXPIRED, OPERATOR_CODE_UNKNOWN,
  BOT_OWNER_ONLY, botForwardText,
  operatorCodeText, operatorCodeResendText, operatorPhonesText, operatorPhonesKeyboard,
  operatorConfirmRemoveText, operatorConfirmRemoveKeyboard, operatorBusinessesText,
  OPERATOR_USAGE_CODE, OPERATOR_USAGE_PHONES, OPERATOR_UNKNOWN_SLUG, OPERATOR_CAPPED, OPERATOR_NO_PHONES,
  OPERATOR_PHONE_REMOVED, OPERATOR_PHONE_GONE, operatorIdMessage, OPERATOR_HELP,
  OPERATOR_PICK_TEXT, OPERATOR_NO_BUSINESSES, operatorPickerKeyboard, OPERATOR_LEADS_HINT, OPERATOR_REMOVE_LEAD,
  leadDetailKeyboard, persistentKeyboard, KEYBOARD_LABELS, BOT_DISCONNECTED,
  OWNER_KEYBOARD_LABELS, STAFF_KEYBOARD_LABELS, OPERATOR_KEYBOARD_LABELS,
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

/** Plain text plus entities. Never parse_mode: nothing here is markup. */
async function replyMessage(chatId, msg) {
  return sendMessage(chatId, msg.text, { entities: msg.entities });
}

/* ---------- persistent reply keyboard ----------
   One keyboard per role, attached to the /start and /help replies and to the
   bind confirmation, so a role always sees its shortcuts and nothing else. A
   press arrives as plain text and is mapped back onto the command through
   KEYBOARD_LABELS; the handlers' permission checks are the authorization, so
   the keyboard itself grants nothing. When a chat is disconnected it gets one
   short notice carrying ReplyKeyboardRemove, because its keyboard went stale
   the moment the binding row was deleted. */

async function roleKeyboardMarkup(chatId, binding) {
  // A bound chat is a business chat and must never be offered the operator
  // keyboard, whatever OPERATOR_CHAT_ID says (bindChat already refuses to bind
  // the operator chat; this ordering is the belt to those braces).
  if (binding) {
    const owner = await isOwnerChat(binding.business_id, chatId).catch(() => false);
    return persistentKeyboard(owner ? OWNER_KEYBOARD_LABELS : STAFF_KEYBOARD_LABELS);
  }
  if (isOperatorChat(chatId)) return persistentKeyboard(OPERATOR_KEYBOARD_LABELS);
  return { remove_keyboard: true };
}

/** Reply with this chat's current keyboard (or its removal) on the SAME
 *  message. Best effort: a keyboard that cannot be resolved never blocks the
 *  reply. */
async function replyRole(chatId, text, binding) {
  let markup = null;
  try { markup = await roleKeyboardMarkup(chatId, binding); } catch { markup = null; }
  return sendMessage(chatId, text, markup ? { reply_markup: markup } : undefined);
}

/** One short notice with the keyboard removed, to a chat that was just
 *  disconnected. Best effort: a chat that blocked the bot stays blocked. */
function sendKeyboardRemoved(chatId) {
  return sendMessage(chatId, BOT_DISCONNECTED, { reply_markup: { remove_keyboard: true } }).catch(() => {});
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
  if (!businessId) return replyRole(chatId, badText, null);
  const business = await getBusinessById(businessId).catch(() => null);
  if (!business) {
    await restoreBindCode(code, businessId).catch(() => {});
    return replyRole(chatId, isOperatorChat(chatId) ? OPERATOR_WELCOME : badText, null);
  }

  try {
    await bindChat(businessId, chatId);
  } catch (e) {
    await restoreBindCode(code, businessId).catch(() => {});
    if (e && e.code === 'operator_chat') return replyRole(chatId, OPERATOR_DO_NOT_OPEN, null);
    console.error('bind_after_claim_failed', (e && e.code) || 'no_code');
    return replyRole(chatId, BOT_BIND_FAILED, null);
  }

  let actual = null;
  let readFailed = false;
  try { actual = await getChatBinding(chatId); } catch { readFailed = true; }
  if (readFailed) {
    // A failed read is not evidence that the chat belongs elsewhere. Say so,
    // and do not charge the code for a bind we cannot confirm.
    await restoreBindCode(code, businessId).catch(() => {});
    return replyRole(chatId, BOT_BIND_FAILED, null);
  }
  if (!actual || String(actual.business_id) !== String(businessId)) {
    await restoreBindCode(code, businessId).catch(() => {});
    return replyRole(chatId, BOT_BOUND_ELSEWHERE, actual);
  }

  // The bind succeeded: this reply is where the chat gets its role keyboard.
  return replyRole(chatId, botLinkedText(business.name), actual);
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
 * What the operator is told when they open a client's link from a chat that is
 * already bound. Never claims the code is still valid without checking, and
 * never names the business that owns it.
 */
async function operatorLinkReply(code) {
  let state = 'unknown';
  try { state = await getBindCodeState(code); } catch { state = 'unknown'; }
  if (state === 'live') return OPERATOR_ALREADY_CONNECTED_CODE;
  if (state === 'used') return OPERATOR_CODE_USED;
  if (state === 'expired') return OPERATOR_CODE_EXPIRED;
  return OPERATOR_CODE_UNKNOWN;
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
  const shaped = bindCodeShape(arg);
  if (existing) {
    if (shaped && isOperatorChat(chatId)) return replyRole(chatId, await operatorLinkReply(shaped), existing);
    return replyRole(chatId, shaped ? BOT_ALREADY_CONNECTED_CODE : BOT_ALREADY_CONNECTED, existing);
  }
  if (!arg) return replyRole(chatId, isOperatorChat(chatId) ? OPERATOR_WELCOME : BOT_NOT_CONNECTED, null);
  // An unbound operator opening a client link would bind the operator and burn
  // the code the client needs. A live code gets the do-not-open warning; a dead
  // one is just an unknown link, so the operator gets the welcome.
  if (shaped && isOperatorChat(chatId)) {
    let state = 'unknown';
    try { state = await getBindCodeState(shaped); } catch { state = 'unknown'; }
    return replyRole(chatId, state === 'live' ? OPERATOR_DO_NOT_OPEN : OPERATOR_WELCOME, null);
  }

  return finishBind(chatId, arg, BOT_BAD_CODE);
}

/* ---------- lead list and lead recovery ----------
   Newest 5, one Open button each, one Older button when more exist. The page
   number is the only thing in the callback, bounded, and the business always
   comes from the binding. */

const LEADS_PAGE = 5;
const LEADS_PAGE_MAX = 50;
const OPENS_PER_HOUR = 30;

/**
 * Telegram refuses an edit that changes nothing with 400 "message is not
 * modified". That is the state we asked for, so it counts as success. Any other
 * failure is logged by status only: the body can echo the message text, and the
 * text holds a customer's name.
 */
async function editList(chatId, messageId, text, markup) {
  const r = await editMessageText(chatId, messageId, text, markup, { parse: 'description' });
  if (r && r.ok) return r;
  if (/message is not modified/i.test(String((r && r.description) || ''))) {
    return { ok: true, status: 'not_modified' };
  }
  console.error('tg_edit_failed', (r && r.status) || 'no_status');
  return r;
}

/**
 * A page with nothing on it is never left as it was: the message is rewritten
 * from current data, because a button that answers with a toast and then does
 * nothing is a button that lies. The toast explains the tap, the edit repairs
 * the message — numbers for what is there now, Older only when it is real, and
 * the empty text with no buttons when the page is gone. `answer` is the
 * callback's once-only responder, absent on the /leads command path.
 */
async function sendLeadsPage(chatId, businessId, page, messageId, answer = null) {
  const safePage = Math.max(0, Math.min(LEADS_PAGE_MAX, Number(page) || 0));
  const leads = await listClientLeads(businessId, LEADS_PAGE + 1, safePage * LEADS_PAGE);
  const hasOlder = leads.length > LEADS_PAGE;
  const shown = leads.slice(0, LEADS_PAGE);
  const empty = !shown.length;
  const text = empty ? 'No requests yet.' : renderLeadList(shown);
  const markup = empty ? { reply_markup: { inline_keyboard: [] } } : leadListKeyboard(shown, safePage, hasOlder);
  if (messageId) {
    if (answer) await answer(empty ? (safePage === 0 ? TOAST_NO_LEADS : TOAST_NO_OLDER) : '');
    return editList(chatId, messageId, text, markup);
  }
  if (empty) return reply(chatId, safePage === 0 ? 'No requests yet.' : 'No older requests.');
  return sendMessage(chatId, text, markup);
}

async function handleLeads(chatId, binding) {
  if (!binding) return reply(chatId, BOT_NOT_CONNECTED);
  return sendLeadsPage(chatId, binding.business_id, 0, null);
}

const REMOVE_PAGE = 5;

/** The /remove_lead list: five per page, numbers only, no actions. Same rule:
 *  an empty page is rewritten, never left with a button that does nothing. */
async function sendRemovePage(chatId, businessId, page, messageId, answer = null) {
  const safePage = Math.max(0, Math.min(LEADS_PAGE_MAX, Number(page) || 0));
  const leads = await listClientLeads(businessId, REMOVE_PAGE + 1, safePage * REMOVE_PAGE);
  const hasOlder = leads.length > REMOVE_PAGE;
  const shown = leads.slice(0, REMOVE_PAGE);
  const empty = !shown.length;
  const text = empty ? 'No requests to remove.' : removeLeadListText(shown);
  const markup = empty ? { reply_markup: { inline_keyboard: [] } } : removeLeadKeyboard(shown, safePage, hasOlder);
  if (messageId) {
    if (answer) await answer(empty ? (safePage === 0 ? TOAST_NO_REMOVE : TOAST_NO_OLDER) : '');
    return editList(chatId, messageId, text, markup);
  }
  if (empty) return reply(chatId, safePage === 0 ? 'No requests to remove.' : 'No older requests.');
  return sendMessage(chatId, text, markup);
}

/** Owner only, like /invite: staff get the same toast as any owner command. */
async function handleRemoveLead(chatId, binding) {
  if (!binding) return reply(chatId, BOT_NOT_CONNECTED);
  if (!(await isOwnerChat(binding.business_id, chatId))) return reply(chatId, BOT_OWNER_ONLY);
  return sendRemovePage(chatId, binding.business_id, 0, null);
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
 * The invite is TWO messages, exactly like the operator's /code. The first is an
 * instruction to the owner and is never forwarded; the second is the only text a
 * client may ever see. Sending one message and hoping the owner forwards it
 * whole is how the instruction ends up in the client's chat.
 *
 * The code is already valid when the first send runs, so a failed second send
 * repeats the code (the no-username form: /start plus the code) rather than
 * leaving a half-finished flow with nothing to forward.
 */
async function sendInvitePair(chatId, code) {
  // getMe() once per instance; a failure falls back to /start plus the code and
  // logs bot_username_unavailable rather than failing the invite.
  const username = await botUsername();
  await reply(chatId, BOT_INVITE_FORWARD_HINT);
  const forward = await replyMessage(chatId, botInviteText(code, { username }));
  if (!forward || !forward.ok) {
    console.error('invite_forward_send_failed');
    await replyMessage(chatId, botInviteText(code, { username: null }));
  }
}

/**
 * Mint one code and send the pair. The rate limit is checked here, right
 * before a mint, so listing pending invites does not spend the hourly budget.
 * Fail closed, like the plain-text hint: no reply when the counter is unreachable.
 */
async function mintAndSendInvite(chatId, businessId) {
  let within;
  try { within = await hitRateLimit('invite:' + chatId, 3600, INVITES_PER_HOUR); } catch { return; }
  if (!within) return reply(chatId, BOT_INVITE_RATE_LIMIT);

  const { code } = await mintBindCode(businessId);
  return sendInvitePair(chatId, code);
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
    await sendInvitePair(chatId, code);
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
  const text = `${botRecipientsText(rows)}\n\n${BOT_RECIPIENTS_PENDING(pending)}`;
  const markup = { reply_markup: rows.length ? recipientsKeyboard(rows, { selfChatId: chatId }) : { inline_keyboard: [] } };
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
    if (String(row.tg_chat_id) === String(chatId)) { await answer(BOT_RECIPIENT_SELF); return; }
    await answer('');
    return editMessageText(chatId, messageId, recipientConfirmText(row, index < 0 ? rows.length : index, { isLast: rows.length <= 1 }), {
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
  if (String(row.tg_chat_id) === String(chatId)) { await answer(BOT_RECIPIENT_SELF); return; }
  if (rows.length <= 1) { await answer(BOT_RECIPIENT_LAST); return; }
  const removed = await removeBusinessChat(binding.business_id, rowId);
  // The removed phone's keyboard is stale the moment this row is gone.
  if (removed) await sendKeyboardRemoved(row.tg_chat_id);
  await answer(removed ? BOT_RECIPIENT_REMOVED : BOT_RECIPIENT_GONE);
  return sendRecipients(chatId, binding.business_id, messageId);
}

/** Plain-text hint, at most 3 per chat per hour; fail closed (no reply). */
async function handlePlainText(chatId, binding, text = '') {
  const shaped = bindCodeShape(text);
  if (binding) {
    // A bound chat never moves between businesses by pasting a code.
    if (shaped) {
      return reply(chatId, isOperatorChat(chatId) ? await operatorLinkReply(shaped) : BOT_ALREADY_CONNECTED_CODE);
    }
  } else if (shaped) {
    if (isOperatorChat(chatId)) return reply(chatId, OPERATOR_DO_NOT_OPEN);
    return handlePastedCode(chatId, shaped);
  }
  if (isOperatorChat(chatId)) return reply(chatId, OPERATOR_WELCOME);
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

async function operatorPick(chatId, prefix, usageText) {
  const rows = await listPickerBusinesses().catch(() => []);
  if (!rows.length) return reply(chatId, OPERATOR_NO_BUSINESSES);
  if (rows.length > 8) return reply(chatId, usageText);
  return sendMessage(chatId, OPERATOR_PICK_TEXT, operatorPickerKeyboard(rows, prefix));
}

async function handleOperatorCode(chatId, arg) {
  const slug = String(arg || '').trim();
  if (!slug) return operatorPick(chatId, 'pc', OPERATOR_USAGE_CODE);
  if (!SLUG_RE.test(slug)) return reply(chatId, OPERATOR_USAGE_CODE);
  // Fail closed: an unreachable counter means no code, not an unlimited one.
  let within;
  try { within = await hitRateLimit('opcode:' + slug, 3600, CODES_PER_SLUG_HOUR); } catch { return; }
  if (!within) return reply(chatId, OPERATOR_CAPPED);
  const business = await getActiveBusinessBySlug(slug).catch(() => null);
  if (!business) return reply(chatId, OPERATOR_UNKNOWN_SLUG);
  // A new code supersedes the business's older unused ones: leaving them live
  // fills the owner's invite cap with codes nobody will use. Used codes are
  // never touched (they are the record of who connected).
  let cancelled = 0;
  try {
    // Count only codes that were actually live; the update also touches rows
    // that expired long ago, and telling the operator about those would lie.
    cancelled = (await listLiveBindCodes(business.id)).length;
    await expireLiveBindCodes(business.id);
  } catch { cancelled = 0; }
  const { code } = await mintBindCode(business.id);
  const username = await botUsername();
  // TWO messages, strictly. The first is the operator's (slug, code, human
  // expiry); the second is the only text a client may ever see. They are
  // separate sends on purpose: forwarding the first would leak the slug, and
  // editing one message in place is not something Telegram guarantees.
  await replyMessage(chatId, operatorCodeText({ slug: business.slug, code, hours: BIND_CODE_HOURS, cancelled }));
  const forward = await replyMessage(chatId, botForwardText({ code, username, hours: BIND_CODE_HOURS }));
  if (!forward || !forward.ok) {
    // The code exists and is valid; only the forwardable copy failed. Say so
    // and repeat the code, or the operator is left with a half-finished flow.
    console.error('code_forward_send_failed');
    await replyMessage(chatId, operatorCodeResendText({ code, hours: BIND_CODE_HOURS }));
  }
}

async function handleOperatorPhones(chatId, arg) {
  const slug = String(arg || '').trim();
  if (!slug) return operatorPick(chatId, 'pb', OPERATOR_USAGE_PHONES);
  if (!SLUG_RE.test(slug)) return reply(chatId, OPERATOR_USAGE_PHONES);
  const business = await getActiveBusinessBySlug(slug).catch(() => null);
  if (!business) return reply(chatId, OPERATOR_UNKNOWN_SLUG);
  const rows = await listBusinessChatsDetailed(business.id);
  const duplicateName = await countBusinessesByName(business.name).then((n) => n > 1).catch(() => false);
  const title = `${business.name}${duplicateName ? ` (${business.slug})` : ''}`;
  if (!rows.length) {
    return reply(chatId, `${OPERATOR_NO_PHONES}\n\n${title}. Mint an invite with /code ${business.slug}.`);
  }
  return sendMessage(chatId, operatorPhonesText({ business, rows, ownerId: rows[0].id, selfChatId: chatId, duplicateName }), operatorPhonesKeyboard(rows));
}

async function handleOperatorBusinesses(chatId) {
  const slugs = await listBusinessSlugs().catch(() => []);
  const rows = [];
  for (const r of slugs) {
    // Count by id: a paused or churned business has phones too, and the
    // active-only lookup would show 0 for them.
    // null, not 0: a failed count is unknown, and the text says "?" for it.
    const phones = await countBusinessChats(r.id).catch(() => null);
    rows.push({ slug: r.slug, name: r.name, status: r.status, phones });
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
  // The removed phone's keyboard is stale the moment this row is gone.
  if (removed) await sendKeyboardRemoved(row.tg_chat_id);
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
function makeContext({ cb, business, lead, leadId, businessId, answer, surface = 'alert', page = 0 }) {
  const chatId = cb.message && cb.message.chat && cb.message.chat.id;
  const messageId = cb.message && cb.message.message_id;
  // The page the browser list came from, bounded; Back and the detail's own
  // actions re-address it, so it must never grow past what the regexes allow.
  const safePage = Math.max(0, Math.min(LEADS_PAGE_MAX, Number(page) || 0));

  /**
   * The keyboard for a card state, on the surface the tap came from. The alert
   * surface keeps today's keyboards exactly. The browser detail (surface
   * 'detail') keeps the same actions and styles, adds Back to the page it came
   * from, and adds the detail-only copy_text button for the phone.
   */
  const keyboardFor = (view, reviewResult, fresh) => {
    if (surface === 'detail') {
      const kind = view === 'confirm' ? 'confirm'
        : (view === 'error' || reviewResult === 'failed') ? 'error'
          : view; // 'new' | 'contacted' | 'done'
      return leadDetailKeyboard(kind, leadId, safePage, fresh || lead);
    }
    if (view === 'error' || reviewResult === 'failed') return { reply_markup: tryAgainKeyboard(leadId) };
    if (view === 'confirm') return { reply_markup: confirmKeyboard(leadId, !!((fresh || lead) && (fresh || lead).email)) };
    if (view === 'contacted') return { reply_markup: jobDoneKeyboard(leadId) };
    if (view === 'done') return { reply_markup: { inline_keyboard: [] } };
    return { reply_markup: alertKeyboard(leadId) };
  };

  // Re-render from the database through the roofer-facing path, never from the
  // previous message text. If the read fails, edit only the keyboard.
  const render = async (view, reviewResult = null) => {
    if (!chatId || !messageId) return;
    let fresh = null;
    let text;
    try {
      fresh = await getClientLead(leadId, businessId);
      if (!fresh) throw new Error('lead_gone');
      text = renderAlert({ business, lead: fresh, view, reviewResult });
    } catch (e) {
      console.error('tg_rerender_failed', (e && e.code) || 'no_code');
      await editMessageReplyMarkup(chatId, messageId, keyboardFor(view, reviewResult, fresh || lead).reply_markup).catch(() => {});
      return;
    }
    const extra = keyboardFor(view, reviewResult, fresh);
    const edited = await editMessageText(chatId, messageId, text, extra).catch(() => ({ ok: false }));
    if (edited && edited.ok) return;
    // Too old to edit (Telegram refuses, or the bot was restarted): send the
    // current card as a new message rather than leaving stale buttons on screen.
    await sendMessage(chatId, text, extra).catch(() => {});
  };

  /** Re-render this lead in whatever state it is in NOW. Used by a stale tap. */
  const renderCurrent = async () => {
    const fresh = await getClientLead(leadId, businessId).catch(() => null);
    if (!fresh) return;
    const card = await cardFor({ lead: fresh, leadId });
    await render(card.view, card.reviewResult);
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
  await render('contacted');
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
  await render('confirm');
}

/** n: cancel back to step 2. No write. */
async function onCancel(ctx) {
  const { answer, render, leadId } = ctx;
  await answer('');
  await render('contacted');
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
      await render('error', 'failed');
    } else {
      await render('done', reviewResult);
    }
  } catch (e) {
    console.error('tg_callback_failed', (e && e.code) || 'no_code');
    if (result.lead && result.lead.email) {
      await render('error', 'failed');
    } else {
      await render('done', 'no_email');
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
    // Idempotency key: Resend caches per key for 24 h. After a timeout or a
    // concurrent-409 the original attempt may still deliver, so a LATER manual
    // retry reuses its EXACT key (recorded in failure meta); nothing auto-retries.
    // After any definite failure use a fresh suffixed key named by the earlier
    // failure count. A new suffix can never equal an earlier one.
    const retryKey = (failInfo.lastStatus === 'timeout' || failInfo.lastStatus === 'idempotency_concurrent')
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
      await render('done', 'sent');
    } else {
      await render('error', 'failed');
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
// The in-place /leads browser. Row taps and detail actions carry the page the
// list came from, so Back restores that exact page; the lead address is a uuid
// and the page is bounded digits, so nothing a customer typed can ride along.
const CB_LEAD_OPEN = /^L:(\d{1,3}):([0-9a-f-]{36})$/;
const CB_LEAD_DETAIL = /^([CDYNR]):(\d{1,3}):([0-9a-f-]{36})$/;
// /remove_lead: open a confirm, delete, cancel, page. All scoped to the binding.
const CB_REMOVE_OPEN = /^rl:([0-9a-f-]{36})$/;
const CB_REMOVE_DELETE = /^RL:([0-9a-f-]{36})$/;
const CB_REMOVE_CANCEL = /^rc:([0-9a-f-]{36})$/;
const CB_REMOVE_PAGE = /^rm:(\d{1,3})$/;
// The /remove_lead browser: a row tap asks, E: confirms. Same owner gate.
const CB_REMOVE_ASK = /^Q:(\d{1,3}):([0-9a-f-]{36})$/;
const CB_REMOVE_DO = /^E:(\d{1,3}):([0-9a-f-]{36})$/;
// The invite-cap button. No business id in the payload: the business comes from
// the binding, so a forged callback can only ever act on the sender's own.
const CB_INVITE_CANCEL = /^i:c$/;
// Operator pickers: pb = phones, pc = code. The payload is the business id, so a
// stale list can only ever point at a business that no longer exists.
const CB_OPERATOR_PICK = /^(pb|pc):([0-9a-f-]{36})$/;

/** Open one lead as a NEW message with its current card. */
async function handleOpenLead({ cb, leadId, binding, answer }) {
  const chatId = cb.message && cb.message.chat && cb.message.chat.id;
  let within;
  // Fail closed: a stuck counter must not become an unlimited open loop.
  try { within = await hitRateLimit('open:' + chatId, 3600, OPENS_PER_HOUR); } catch { return; }
  if (!within) { await answer(TOAST_TOO_MANY_OPENS); return; }
  const lead = await getClientLead(leadId, binding.business_id).catch(() => null);
  if (!lead) { await answer(TOAST_LEAD_GONE); return; }
  const business = await getBusinessById(binding.business_id).catch(() => null);
  if (!business) { await answer(GENERIC_NOT_FOUND); return; }
  const card = await cardFor({ lead, leadId });
  await answer('');
  await sendMessage(chatId, renderAlert({ business, lead, view: card.view, reviewResult: card.reviewResult }), card.kb);
}

/**
 * L: — open one lead INSIDE the list message: the same message is edited to
 * the detail, never a second one. The page travels in the callback so Back can
 * restore the exact list page. A lead that is gone answers and refreshes the
 * page, so no dead row button is left behind.
 */
async function handleDetailOpen({ cb, page, leadId, binding, answer }) {
  const chatId = cb.message && cb.message.chat && cb.message.chat.id;
  const messageId = cb.message && cb.message.message_id;
  const lead = await getClientLead(leadId, binding.business_id).catch(() => null);
  if (!lead) {
    await answer(TOAST_LEAD_GONE);
    return sendLeadsPage(chatId, binding.business_id, page, messageId, null);
  }
  const business = await getBusinessById(binding.business_id).catch(() => null);
  if (!business) { await answer(GENERIC_NOT_FOUND); return; }
  const card = await cardFor({ lead, leadId });
  const text = renderAlert({ business, lead, view: card.view, reviewResult: card.reviewResult });
  const markup = leadDetailKeyboard(card.view, leadId, page, lead);
  await answer('');
  const r = await editList(chatId, messageId, text, markup);
  // Too old to edit: send the detail as a new message rather than leaving a
  // dead row button on screen. Its Back edits the new message instead.
  if (!(r && r.ok)) await sendMessage(chatId, text, markup).catch(() => {});
}

/**
 * After a removal, redraw the removal list on the page the confirm came from.
 * If that page emptied (its last row was the one deleted), step back to the
 * newest page that still has rows, so the owner is never left staring at an
 * empty page with only a disabled Older above nothing.
 */
async function refreshRemovePage(chatId, businessId, page, messageId) {
  let p = Math.max(0, Math.min(LEADS_PAGE_MAX, Number(page) || 0));
  while (p > 0) {
    const probe = await listClientLeads(businessId, 1, p * REMOVE_PAGE).catch(() => [{}]);
    if (probe.length) break;
    p--;
  }
  return sendRemovePage(chatId, businessId, p, messageId, null);
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
    const pick = CB_OPERATOR_PICK.exec(data);
    if (pick) {
      // Operator-only BEFORE any data read; a non-operator gets the same answer
      // as any unknown callback.
      if (!isOperatorChat(chatId, chatType)) { await answer(GENERIC_NOT_FOUND); return; }
      const b = await getBusinessById(pick[2]).catch(() => null);
      if (!b || (b.status !== 'demo' && b.status !== 'active')) { await answer(OPERATOR_UNKNOWN_SLUG); return; }
      await answer('');
      if (pick[1] === 'pb') await handleOperatorPhones(chatId, b.slug);
      else await handleOperatorCode(chatId, b.slug);
      return;
    }

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

    const rmOpen = CB_REMOVE_OPEN.exec(data);
    const rmDel = CB_REMOVE_DELETE.exec(data);
    const rmCancel = CB_REMOVE_CANCEL.exec(data);
    const rmPage = CB_REMOVE_PAGE.exec(data);
    const rmAsk = CB_REMOVE_ASK.exec(data);
    const rmDo = CB_REMOVE_DO.exec(data);
    if (rmOpen || rmDel || rmCancel || rmPage || rmAsk || rmDo) {
      // Owner only, before any read; the business is always the binding's.
      if (!(await isOwnerChat(binding.business_id, chatId))) { await answer(TOAST_OWNER_ONLY); return; }
      const messageId = cb.message && cb.message.message_id;
      if (rmPage) { return sendRemovePage(chatId, binding.business_id, Number(rmPage[1]), messageId, answer); }
      // The /remove_lead browser: a row tap asks, E: re-checks the row and the
      // binding (both re-read above and here), deletes, then refreshes that
      // page — stepping back if the deletion emptied it.
      if (rmAsk) {
        const leadId = rmAsk[2];
        const lead = await getClientLead(leadId, binding.business_id).catch(() => null);
        if (!lead) { await answer(REMOVE_LEAD_GONE); return refreshRemovePage(chatId, binding.business_id, Number(rmAsk[1]), messageId); }
        await answer('');
        return editList(chatId, messageId, removeLeadConfirmText(lead), removeLeadConfirmKeyboard(leadId, Number(rmAsk[1])));
      }
      if (rmDo) {
        const leadId = rmDo[2];
        const lead = await getClientLead(leadId, binding.business_id).catch(() => null);
        if (!lead) { await answer(REMOVE_LEAD_GONE); return refreshRemovePage(chatId, binding.business_id, Number(rmDo[1]), messageId); }
        const removed = await deleteLeadScoped(leadId, binding.business_id).catch(() => 0);
        // The name comes from the row read before the delete: after it there is
        // nothing left to name.
        await answer(removed ? removedText(lead) : REMOVE_LEAD_GONE);
        return refreshRemovePage(chatId, binding.business_id, Number(rmDo[1]), messageId);
      }
      const leadId = (rmOpen || rmDel || rmCancel)[1];
      if (rmCancel) {
        await answer('');
        return sendRemovePage(chatId, binding.business_id, 0, messageId);
      }
      const lead = await getClientLead(leadId, binding.business_id).catch(() => null);
      if (!lead) { await answer(REMOVE_LEAD_GONE); return; }
      if (rmOpen) {
        await answer('');
        return editMessageText(chatId, messageId, removeLeadConfirmText(lead), removeLeadConfirmKeyboard(leadId)).catch(() => {});
      }
      const removed = await deleteLeadScoped(leadId, binding.business_id).catch(() => 0);
      // The name comes from the row read before the delete: after it there is
      // nothing left to name.
      const done = removed ? removedText(lead) : REMOVE_LEAD_GONE;
      await answer(done);
      return editList(chatId, messageId, done, { reply_markup: { inline_keyboard: [] } });
    }

    const page = CB_PAGE.exec(data);
    if (page) {
      await sendLeadsPage(chatId, binding.business_id, Number(page[1]), messageId, answer);
      return;
    }

    const recipient = CB_RECIPIENT.exec(data);
    if (recipient) {
      await handleRecipientCallback({ cb, kind: recipient[1], rowId: recipient[2], binding, answer });
      return;
    }

    // L: — the /leads browser's row tap: the same message becomes the detail.
    const open = CB_LEAD_OPEN.exec(data);
    if (open) {
      await handleDetailOpen({ cb, page: Number(open[1]), leadId: open[2], binding, answer });
      return;
    }

    // c/d/y/n/r on an alert message (today's behaviour, unchanged) and
    // C/D/Y/N/R on the browser detail (same handlers, page-aware keyboards).
    const m = CB_LEAD.exec(data);
    const md = CB_LEAD_DETAIL.exec(data);
    if (!m && !md) { await answer(GENERIC_NOT_FOUND); return; }
    const kind = m ? m[1] : md[1].toLowerCase();
    const leadId = m ? m[2] : md[3];
    const surface = m ? 'alert' : 'detail';
    const detailPage = md ? Number(md[2]) : 0;

    if (kind === 'o') { await handleOpenLead({ cb, leadId, binding, answer }); return; }

    const lead = await getClientLead(leadId, binding.business_id);
    if (!lead) { await answer(GENERIC_NOT_FOUND); return; }
    const business = await getBusinessById(binding.business_id);
    if (!business) { await answer(GENERIC_NOT_FOUND); return; }

    const handler = CALLBACK_HANDLERS[kind];
    if (!handler) { await answer(GENERIC_NOT_FOUND); return; }
    await handler(makeContext({ cb, business, lead, leadId, businessId: binding.business_id, answer, surface, page: detailPage }));
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
      // A persistent-keyboard press arrives as the button's plain text. Map the
      // known labels onto their commands here; every handler still applies its
      // own permission checks, exactly as if the command had been typed. An
      // unknown text is not a press at all and takes the plain-text path.
      const pressed = Object.prototype.hasOwnProperty.call(KEYBOARD_LABELS, text) ? KEYBOARD_LABELS[text] : null;
      const token = pressed || text.split(/\s+/)[0];
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
      const arg = pressed ? '' : text.slice(token.length).trim();
      const operator = isOperatorChat(chatId, chat.type);
      // Operator answers for the owner commands: the role comes from the env,
      // not from a binding. No new callbacks: the pickers reuse pc:/pb:.
      if (operator && first === '/invite') {
        await operatorPick(chatId, 'pc', OPERATOR_USAGE_CODE);
      } else if (operator && first === '/recipients') {
        await operatorPick(chatId, 'pb', OPERATOR_USAGE_PHONES);
      } else if (operator && first === '/help') {
        await replyRole(chatId, OPERATOR_HELP, binding);
      } else if (operator && first === '/remove_lead') {
        await reply(chatId, OPERATOR_REMOVE_LEAD);
      } else if (operator && first === '/leads') {
        await reply(chatId, OPERATOR_LEADS_HINT);
      } else if (first === '/start') {
        await handleStart(chatId, arg);
      } else if (first === '/leads') {
        await handleLeads(chatId, binding);
      } else if (first === '/invite') {
        await handleInvite(chatId, binding);
      } else if (first === '/recipients') {
        await handleRecipients(chatId, binding);
      } else if (first === '/remove_lead') {
        await handleRemoveLead(chatId, binding);
      } else if (first === '/help') {
        await replyRole(chatId, binding ? BOT_HELP : BOT_NOT_CONNECTED, binding);
      } else if (first === '/id') {
        // Every private chat, bound or not, operator or not: it is how the
        // operator learns OPERATOR_CHAT_ID without a third-party bot. Not in
        // the command menu.
        await replyMessage(chatId, operatorIdMessage(chatId, { operator: isOperatorChat(chatId) }));
      } else if (operator) {
        // Operator commands. A non-operator never reaches this branch, so the
        // reply they get is the same as for any unknown text.
        if (first === '/code') await handleOperatorCode(chatId, arg);
        else if (first === '/phones') await handleOperatorPhones(chatId, arg);
        else if (first === '/businesses') await handleOperatorBusinesses(chatId);
        else if (first === '/operator') await replyRole(chatId, OPERATOR_HELP, binding);
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
