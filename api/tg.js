// Vercel serverless function: POST /api/tg — Telegram webhook.
//
// Auth first. Tenancy is ALWAYS derived from the sender's chat id through
// business_chats, never from message text or callback data. Reads of leads go
// through public.v_client_leads. Nothing here touches the private schema.

import { randomBytes } from 'node:crypto';
import * as dbApi from '../lib/db.js';
import { isOperatorChat } from '../lib/operator.js';
import * as bindCodesApi from '../lib/bind-codes.js';
import * as tgApi from '../lib/tg.js';
import { secretMatches } from '../lib/request.js';
import * as notifyApi from '../lib/notify.js';
import { runTimed, setHandler, timedAll } from '../lib/timing.js';
import {
  renderAlert, renderHeldLeadList, jobDoneKeyboard, confirmKeyboard, tryAgainKeyboard,
  botLinkedText, BOT_HELP, BOT_ALREADY_CONNECTED, BOT_NOT_CONNECTED, BOT_BAD_CODE, BOT_PLAIN_TEXT,
  botInviteText, botRecipientsText, recipientsKeyboard, recipientConfirmText, recipientConfirmKeyboard,
  BOT_INVITE_CAPPED, BOT_INVITE_CANCEL_BUTTON, BOT_INVITE_CANCEL_ALREADY, BOT_INVITE_RATE_LIMIT,
  botInvitePendingText, BOT_RECIPIENTS_PENDING, BOT_RECIPIENT_LAST, BOT_RECIPIENT_REMOVED, BOT_RECIPIENT_GONE,
  TOAST_NOT_FOUND, TOAST_ALREADY_DONE, TOAST_CONTACT_FIRST, TOAST_NOTHING_TO_RETRY, TOAST_GENERIC_ERROR,
  TOAST_ALREADY_UPDATED, TOAST_TOO_MANY_OPENS, TOAST_OWNER_ONLY, leadListKeyboard, heldListKeyboard, heldLeadsText, alertKeyboard,
  TOAST_NO_OLDER, TOAST_NO_LEADS, TOAST_NO_REMOVE, BOT_INVITE_FORWARD_HINT,
  BOT_CODE_BAD, BOT_ALREADY_CONNECTED_CODE, BOT_BOUND_ELSEWHERE, BOT_BIND_FAILED, TOAST_LEAD_GONE, BOT_RECIPIENT_SELF,
  removeLeadListText, removeLeadKeyboard, removeLeadConfirmText, removeLeadConfirmKeyboard, removedText, REMOVE_LEAD_GONE,
  OPERATOR_ALREADY_CONNECTED_CODE, OPERATOR_DO_NOT_OPEN, OPERATOR_WELCOME, OPERATOR_CODE_USED, OPERATOR_CODE_EXPIRED, OPERATOR_CODE_UNKNOWN,
  BOT_OWNER_ONLY, botForwardText,
  operatorCodeText, operatorCodeResendText,
  operatorBusinessListText, operatorBusinessListKeyboard, operatorBusinessDetailText, operatorBusinessDetailKeyboard,
  operatorSuspendConfirmText, operatorSuspendConfirmKeyboard, operatorSuspendedText,
  operatorReactivateConfirmText, operatorReactivateConfirmKeyboard, operatorReactivatedText,
  operatorTerminateConfirmText, operatorTerminateConfirmKeyboard, operatorTerminatedText, operatorAlreadyTerminatedText,
  OPERATOR_TERMINATED, OPERATOR_ALREADY_TERMINATED, operatorTerminatedReactivateText, OPERATOR_TERMINATED_EXTEND,
  operatorBillingReactivateText, OPERATOR_BILLING_EXTEND,
  operatorAlreadySuspendedText, operatorAlreadyActiveText, operatorInviteSuspendedText,
  operatorInviteListText, operatorInviteListKeyboard, operatorInviteBackKeyboard,
  operatorAlreadyConnectedText, operatorAlreadyConnectedKeyboard, operatorReplaceConfirmText, operatorReplaceConfirmKeyboard,
  operatorInviteFailedText, operatorReplaceFailedText, OPERATOR_ALREADY_REPLACED, OPERATOR_NO_PHONE_NOW, BOT_ACCESS_ENDED,
  operatorBackToBusinessKeyboard,
  operatorExtendConfirmText, operatorExtendConfirmKeyboard, operatorExtendedText, operatorAlreadyExtendedText,
  OPERATOR_EXTENDED, OPERATOR_ALREADY_EXTENDED, OPERATOR_BILLING_UNAVAILABLE,
  operatorLeadListText, operatorLeadCardText, operatorLeadColumns, operatorLeadListKeyboard, operatorLeadDetailKeyboard,
  unpackUuid,
  OPERATOR_BUSINESS_GONE, OPERATOR_SCREEN_EXPIRED, OPERATOR_PAGE_GONE,
  OPERATOR_SUSPENDED, OPERATOR_REACTIVATED, OPERATOR_ALREADY_SUSPENDED, OPERATOR_ALREADY_ACTIVE,
  OPERATOR_NO_LEADS, OPERATOR_NO_OLDER_LEADS, OPERATOR_LEAD_GONE, OPERATOR_RECENT_DAYS,
  OPERATOR_USAGE_INVITE, OPERATOR_UNKNOWN_SLUG, OPERATOR_CAPPED, operatorIdMessage, OPERATOR_HELP,
  leadDetailKeyboard, persistentKeyboard, KEYBOARD_LABELS, BOT_DISCONNECTED,
  OWNER_KEYBOARD_LABELS, STAFF_KEYBOARD_LABELS, OPERATOR_KEYBOARD_LABELS,
} from '../lib/content.js';
import { suspendBusiness, terminateBusiness, reactivateBusiness, heldLeadCount, heldGroupCount, heldGroupOpen, suspendedKeyboard, sendFailed } from '../lib/service-status.js';
import { suspendedReply, suspendedToast, connectRefused, statusText } from '../lib/lifecycle-text.js';
import { nextPaidUntil, decodeExtendToken, extendTargetAllowed, extendTokenExpired } from '../lib/billing.js';
import { applyPayment } from '../lib/billing-ops.js';
import { sendHeldLeadsToPhones } from '../lib/held-leads.js';

/* ---------- timing ----------
   Every database and Telegram call this file makes goes through a wrapper that
   records how long it took, under a label that says what the call is FOR. The
   labels are the only thing recorded: no argument and no result is read (see
   lib/timing.js). The handler prints one "[tg-timing]" line per update. The
   wrapped functions keep their names, so the code below reads as before. */

const {
  getChatBinding, bindChat, claimBindCode, restoreBindCode, getBindCodeState, getBusinessById, clearRateLimit, deleteLeadScoped,
  listClientLeads, getClientLead, transitionLead, getDoneLeadForRetry, hasReviewSent, getReviewFailureInfo, addEvent, hitRateLimit,
  countBusinessChats, countLiveBindCodes, listLiveBindCodes, expireLiveBindCodes, clearStaleRetryLock,
  listBusinessChatsDetailed, getBusinessChat, removeBusinessChat,
  expireOtherBindCodes, expireBindCode, removeAllBusinessChats,
  getBusinessBySlug, setBusinessStatus, extendPaidUntil,
  countHeldLeads, lastBusinessEventAt, addBusinessEvent, listHeldLeads,
  listBusinessesPage, countChatsForBusinesses, getLeadTotals, countClientLeadsSince,
  listLeadsColumns, getLeadColumns,
} = timedAll(dbApi, {
  getChatBinding: 'db.binding_lookup',
  bindChat: 'db.bind_chat',
  claimBindCode: 'db.bind_code_claim',
  restoreBindCode: 'db.bind_code_restore',
  getBindCodeState: 'db.bind_code_state',
  getBusinessById: 'db.business_by_id',
  getBusinessBySlug: 'db.business_by_slug',
  setBusinessStatus: 'db.business_status_update',
  extendPaidUntil: 'db.business_paid_until_update',
  listBusinessesPage: 'db.business_page',
  listClientLeads: 'db.lead_page',
  getClientLead: 'db.lead_by_id',
  getLeadTotals: 'db.lead_totals',
  countClientLeadsSince: 'db.lead_count_recent',
  listLeadsColumns: 'db.operator_lead_page',
  getLeadColumns: 'db.operator_lead_by_id',
  transitionLead: 'db.status_update',
  deleteLeadScoped: 'db.lead_delete',
  getDoneLeadForRetry: 'db.lead_retry_read',
  hasReviewSent: 'db.review_sent_check',
  getReviewFailureInfo: 'db.review_failure_info',
  addEvent: 'db.event_insert',
  hitRateLimit: 'db.rate_limit',
  clearRateLimit: 'db.rate_limit_clear',
  clearStaleRetryLock: 'db.retry_lock_clear',
  listBusinessChatsDetailed: 'db.chat_list',
  countBusinessChats: 'db.chat_count',
  countChatsForBusinesses: 'db.chat_count_page',
  getBusinessChat: 'db.chat_by_id_scoped',
  removeBusinessChat: 'db.chat_remove_scoped',
  countLiveBindCodes: 'db.invite_count',
  listLiveBindCodes: 'db.invite_list',
  expireLiveBindCodes: 'db.invite_expire',
  expireOtherBindCodes: 'db.invite_expire_others',
  expireBindCode: 'db.invite_take_back',
  removeAllBusinessChats: 'db.chat_remove_all',
  countHeldLeads: 'db.held_lead_count',
  listHeldLeads: 'db.held_lead_page',
  lastBusinessEventAt: 'db.business_event_last',
  addBusinessEvent: 'db.business_event_insert',
});
const { sendMessage, answerCallbackQuery, editMessageText, editMessageReplyMarkup, botUsername } = timedAll(tgApi, {
  sendMessage: 'tg.send_message',
  answerCallbackQuery: 'tg.answer_callback',
  editMessageText: 'tg.edit_message_text',
  editMessageReplyMarkup: 'tg.edit_reply_markup',
  // Not a Telegram request once the username is known (env override, or the
  // per-instance cache after one getMe), so it is not counted under "tg.".
  botUsername: 'lookup.bot_username',
});
// One insert each; the label says so.
const { mintBindCode } = timedAll(bindCodesApi, { mintBindCode: 'db.invite_mint' });
const { BIND_CODE_HOURS } = bindCodesApi;
// The review email is the Resend call plus the event row that records it.
const { sendReviewRequest, notifyOperatorUnreachable, sendLifecycleEmail } = timedAll(notifyApi, {
  sendReviewRequest: 'mail.review_request',
  notifyOperatorUnreachable: 'tg.operator_notice',
  sendLifecycleEmail: 'mail.lifecycle_notice',
});
// Pure checks and lists, not database calls: nothing to time.
const { isSuspendedStatus } = dbApi;
/** The calls lib/service-status.js, lib/lifecycle-notify.js and applyPayment()
 *  make, as this file's timed wrappers: a suspension, a termination, a
 *  reactivation and a recorded payment show up in the timing line whoever
 *  started them. */
const SERVICE_IO = {
  sendMessage: (...a) => sendMessage(...a),
  // The SECOND message of a reactivation: the held leads themselves, in
  // /leads' format (/leads' own builder, so the two cannot drift).
  sendHeldLeads: ({ business, rows, now }) => sendHeldLeadsToPhones({ business, rows, now }, {
    ...SERVICE_IO, listHeldLeads: (...a) => listHeldLeads(...a),
  }),
  sendLifecycleEmail: (...a) => sendLifecycleEmail(...a),
  setBusinessStatus: (...a) => setBusinessStatus(...a),
  getBusinessById: (...a) => getBusinessById(...a),
  listBusinessChatsDetailed: (...a) => listBusinessChatsDetailed(...a),
  extendPaidUntil: (...a) => extendPaidUntil(...a),
  countHeldLeads: (...a) => countHeldLeads(...a),
  lastBusinessEventAt: (...a) => lastBusinessEventAt(...a),
  addBusinessEvent: (...a) => addBusinessEvent(...a),
  hitRateLimit: (...a) => hitRateLimit(...a),
  clearRateLimit: (...a) => clearRateLimit(...a),
};

const GENERIC_NOT_FOUND = TOAST_NOT_FOUND;

/** A promise's outcome as a value, so two independent reads can run together
 *  and still be judged in the order the code reads them. */
const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

/**
 * Run steps that do not depend on each other side by side, and wait for ALL of
 * them — also when one fails, so nothing this function started is still on
 * its way when the update is answered. Then fail with the first failure in
 * list order, as the same steps run one after another would have. Returns the
 * results in list order; a step may be a plain value (null for "nothing to do").
 */
async function together(steps) {
  const results = await Promise.allSettled(steps);
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map((r) => r.value);
}

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
   One keyboard per role (at most two buttons in one row), attached to the
   /start and /help replies, to the bind confirmation, and to every reply to
   free text, so the keyboard reopens after the user has typed something. A
   press arrives as plain text and is mapped back onto the command through
   KEYBOARD_LABELS; the handlers' permission checks are the authorization, so
   the keyboard itself grants nothing. When a chat is disconnected it gets one
   short notice carrying ReplyKeyboardRemove, because its keyboard went stale
   the moment the binding row was deleted.

   What Telegram allows: a reply keyboard can only travel as the reply_markup
   of a message the bot SENDS, and a message has exactly one reply_markup. So
   a reply that already carries inline buttons (a lead list, a picker) cannot
   also carry this keyboard, and when the bot sends nothing (the plain-text
   hint is rate limited) there is nothing to attach it to. */

async function roleKeyboardMarkup(chatId, binding) {
  // A bound chat is a business chat and must never be offered the operator
  // keyboard, whatever OPERATOR_CHAT_ID says (bindChat already refuses to bind
  // the operator chat; this ordering is the belt to those braces).
  if (binding) {
    // Suspended or terminated: the one Status button, whatever the role.
    if (bindingSuspended(binding)) return suspendedKeyboard();
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

/* ---------- suspended or terminated business ----------
   Suspend sets businesses.status to 'paused', Terminate to 'churned' (shown
   as "Terminated"). Nothing is deleted either way: the phones stay bound, the
   invites and the leads stay where they are, and a recorded payment (Extend
   30 days) puts the status back. Reactivate applies to a suspended business
   only: on a terminated one it refuses and points at Extend. While it lasts,
   a phone of that business keeps /status and /start (the one keyboard button
   is Status). Every other command, keyboard press and free text gets a short
   answer that says the service is off, why, and until when, with the support
   link; a button tap gets the same as a toast. There is no free-text cap:
   each message is answered. No lead data is shown, and nothing is
   changed. The status arrives with the binding (one query, lib/db.js
   getChatBinding); the reason and the dates need the business row, which is
   read only when an answer is actually sent. */

function bindingSuspended(binding) { return !!binding && isSuspendedStatus(binding.business_status); }

/** The business behind a binding, or a minimal stand-in built from the
 *  binding when the row cannot be read: the answer then names the state and
 *  no date, and is still sent. */
async function boundBusiness(binding) {
  const row = await getBusinessById(binding.business_id).catch(() => null);
  return row || { id: binding.business_id, status: binding.business_status };
}

/** The answer to anything but /status, with the one-button keyboard on the
 *  same message: a phone that missed the notice still loses its stale role
 *  keyboard here. */
async function replySuspended(chatId, binding) {
  const m = suspendedReply({ business: await boundBusiness(binding) });
  return sendMessage(chatId, m.text, { entities: m.entities, reply_markup: suspendedKeyboard() });
}

/**
 * /status, for every bound phone: the state of the service in a few lines.
 * In service: "Active" and the paid-until date (and, once payment is
 * overdue, when the service will be suspended). Suspended: the reason, the
 * termination date with the days left, and HOW MANY leads are waiting, as a
 * number and nothing else. Terminated: that, and that no data was deleted.
 * It reads the business row and, when suspended, one count; it writes
 * nothing. A chat with no binding gets the usual "not connected" line.
 */
async function handleStatus(chatId, binding) {
  if (!binding) return replyRole(chatId, BOT_NOT_CONNECTED, null);
  const business = await boundBusiness(binding);
  const off = isSuspendedStatus(business.status);
  const held = business.status === 'paused' ? await heldLeadCount(business, SERVICE_IO) : null;
  const m = statusText({ business, held });
  let markup = null;
  try { markup = off ? suspendedKeyboard() : await roleKeyboardMarkup(chatId, binding); } catch { markup = null; }
  return sendMessage(chatId, m.text, { entities: m.entities, ...(markup ? { reply_markup: markup } : {}) });
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
  // A suspended or terminated business connects no new phone. The code is
  // handed back unused, so the same invite works again once the business is
  // back in service. The chat is not bound, so it gets no keyboard.
  if (isSuspendedStatus(business.status)) {
    await restoreBindCode(code, businessId).catch(() => {});
    const m = connectRefused(business.status);
    return sendMessage(chatId, m.text, { entities: m.entities, reply_markup: { remove_keyboard: true } });
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
  if (!within) return replyRole(chatId, BOT_CODE_BAD, null);
  let global;
  try { global = await hitRateLimit('bindtry:all', 3600, bindTriesGlobal()); } catch { return; }
  if (!global) {
    // A global ceiling protects the table from a distributed guessing run. It
    // is not a per-chat answer, so say nothing new to the chat and log it.
    console.error('bind_ceiling_hit');
    return replyRole(chatId, BOT_CODE_BAD, null);
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
const isOwnerOf = (rows, chatId) => rows.length > 0 && String(rows[0].tg_chat_id) === String(chatId);

async function isOwnerChat(businessId, chatId) {
  return isOwnerOf(await listBusinessChatsDetailed(businessId), chatId);
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
   Newest 5 in the text, one row of number buttons under it, then Newer/Older
   only where they lead somewhere. The page number and the lead id are the only
   things in a callback, bounded, and the business always comes from the
   binding. */

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
 * the message — numbers for what is there now, Newer/Older only when they are
 * real, and the empty text with no buttons when the page is gone. No lead is
 * read for writing and nothing is changed, so a stale Newer/Older (including a
 * disabled end from a message sent before the ends were dropped) is harmless.
 * Older is not offered on the last page the browser can address. `answer` is
 * the callback's once-only responder, absent on the /leads command path. The
 * toast depends on the page that was read, so it cannot go out before the
 * read; it goes out TOGETHER with the edit, not ahead of it.
 */
async function sendLeadsPage(chatId, businessId, page, messageId, answer = null) {
  const safePage = Math.max(0, Math.min(LEADS_PAGE_MAX, Number(page) || 0));
  const leads = await listClientLeads(businessId, LEADS_PAGE + 1, safePage * LEADS_PAGE);
  const hasOlder = leads.length > LEADS_PAGE && safePage < LEADS_PAGE_MAX;
  const shown = leads.slice(0, LEADS_PAGE);
  const empty = !shown.length;
  // Item A4: the heading counts the leads the GROUP shows — every held row
  // released by a reactivation inside HELD_GROUP_DAYS, from ANY suspension
  // cycle. Counting only the newest suspension made "1" sit above two rows.
  // The count is read only when a held row is shown; it falls back to the rows
  // on the page when unreadable. Order, numbers, callbacks and marks are intact.
  const heldRows = shown.filter((l) => l.held_at).length;
  let heldTotal = null;                                        // null = count unreadable
  let heldGroup = true;
  if (heldRows) {
    const io = {
      countHeldLeads: dbApi.countHeldLeads,
      lastBusinessEventAt: dbApi.lastBusinessEventAt,
    };
    // HELD_GROUP_DAYS after the latest reactivation the group closes and the
    // rows join the ordinary list in date order; the `held` line stays.
    heldGroup = await heldGroupOpen({ id: businessId }, io).catch(() => true);
    const total = await heldGroupCount({ id: businessId }, io, heldGroup).catch(() => null);
    heldTotal = total === null || total === undefined ? null : Math.max(0, total);
  }
  const text = empty ? 'No requests yet.' : renderHeldLeadList(shown, Date.now(), heldTotal, { group: heldGroup });
  const markup = empty ? { reply_markup: { inline_keyboard: [] } } : leadListKeyboard(shown, safePage, hasOlder);
  if (messageId) {
    const [, edited] = await together([
      answer ? answer(empty ? (safePage === 0 ? TOAST_NO_LEADS : TOAST_NO_OLDER) : '') : null,
      editList(chatId, messageId, text, markup),
    ]);
    return edited;
  }
  if (empty) return reply(chatId, safePage === 0 ? 'No requests yet.' : 'No older requests.');
  return sendMessage(chatId, text, markup);
}

/**
 * Item A5: the held list opened from a lead's Back button (or its Older/Newer
 * row). It is NOT /leads: only held rows, its own callbacks and a count that
 * matches the rows grouped here. A lead opened from this message Backs here;
 * the single detail sent at reactivation Backs to /leads.
 */
async function sendHeldLeadsPage(chatId, businessId, page, messageId, answer = null) {
  const safePage = Math.max(0, Math.min(LEADS_PAGE_MAX, Number(page) || 0));
  const offset = safePage * LEADS_PAGE;
  const all = await dbApi.listHeldLeads(businessId, { limit: offset + LEADS_PAGE + 1 });
  const shown = all.slice(offset, offset + LEADS_PAGE);
  const hasOlder = all.length > offset + LEADS_PAGE && safePage < LEADS_PAGE_MAX;
  const text = shown.length ? heldLeadsText(shown, Date.now(), all.length) : 'No requests yet.';
  const markup = shown.length
    ? heldListKeyboard(shown, safePage, hasOlder, safePage > 0)
    : { reply_markup: { inline_keyboard: [] } };
  if (messageId) {
    const [, edited] = await together([
      answer ? answer(shown.length ? '' : (safePage === 0 ? TOAST_NO_LEADS : TOAST_NO_OLDER)) : null,
      editList(chatId, messageId, text, markup),
    ]);
    return edited;
  }
  return sendMessage(chatId, text, markup);
}

async function handleLeads(chatId, binding) {
  if (!binding) return reply(chatId, BOT_NOT_CONNECTED);
  return sendLeadsPage(chatId, binding.business_id, 0, null);
}

const REMOVE_PAGE = 5;

/** The /remove_lead list: five per page, one row of number buttons, the same
 *  navigation rule as /leads. Same rule for an empty page: it is rewritten,
 *  never left with a button that does nothing. `rows` is this page as the
 *  caller has just read it (refreshRemovePage), so it is not read twice. */
async function sendRemovePage(chatId, businessId, page, messageId, answer = null, rows = null) {
  const safePage = Math.max(0, Math.min(LEADS_PAGE_MAX, Number(page) || 0));
  const leads = rows || await listClientLeads(businessId, REMOVE_PAGE + 1, safePage * REMOVE_PAGE);
  const hasOlder = leads.length > REMOVE_PAGE && safePage < LEADS_PAGE_MAX;
  const shown = leads.slice(0, REMOVE_PAGE);
  const empty = !shown.length;
  const text = empty ? 'No requests to remove.' : removeLeadListText(shown);
  const markup = empty ? { reply_markup: { inline_keyboard: [] } } : removeLeadKeyboard(shown, safePage, hasOlder);
  if (messageId) {
    const [, edited] = await together([
      answer ? answer(empty ? (safePage === 0 ? TOAST_NO_REMOVE : TOAST_NO_OLDER) : '') : null,
      editList(chatId, messageId, text, markup),
    ]);
    return edited;
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
  // The owner check reads this business's phones, so the same rows say how
  // many are connected: no second query for the count.
  const phones = await listBusinessChatsDetailed(binding.business_id);
  if (!isOwnerOf(phones, chatId)) return reply(chatId, BOT_OWNER_ONLY);

  const bound = phones.length;
  const pending = await countLiveBindCodes(binding.business_id);
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

/** The list, as a new message or as an edit of the one the button lives on.
 *  `known` is the phone list when the caller read it in this same request and
 *  nothing has changed since; after a removal it is read again. The pending
 *  count does not depend on the list, so the two reads run together. */
async function sendRecipients(chatId, businessId, messageId, known = null) {
  const [rows, pending] = await together([
    known || listBusinessChatsDetailed(businessId),
    countLiveBindCodes(businessId),
  ]);
  const text = `${botRecipientsText(rows)}\n\n${BOT_RECIPIENTS_PENDING(pending)}`;
  const markup = { reply_markup: rows.length ? recipientsKeyboard(rows, { selfChatId: chatId }) : { inline_keyboard: [] } };
  if (messageId) return editMessageText(chatId, messageId, text, markup).catch(() => {});
  return sendMessage(chatId, text, markup);
}

/** /recipients — who receives alerts, with one Remove button per row. */
async function handleRecipients(chatId, binding) {
  if (!binding) return reply(chatId, BOT_NOT_CONNECTED);
  // Owner check first, on the same rows the list is then drawn from.
  const rows = await listBusinessChatsDetailed(binding.business_id);
  if (!isOwnerOf(rows, chatId)) return reply(chatId, BOT_OWNER_ONLY);
  return sendRecipients(chatId, binding.business_id, undefined, rows);
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
  if (!isOwnerOf(rows, chatId)) {
    await answer(TOAST_OWNER_ONLY);
    return;
  }
  const index = rows.findIndex((r) => r.id === rowId);
  // Once the toast is decided it goes out together with the edit: the spinner
  // stops while the message is being redrawn, not before the redraw starts.
  // A list read in this request is reused while nothing has been removed.
  const goneAndRefresh = () => together([
    answer(BOT_RECIPIENT_GONE),
    sendRecipients(chatId, binding.business_id, messageId, rows),
  ]);

  if (kind === 'x') {
    const row = index >= 0 ? rows[index] : await getBusinessChat(binding.business_id, rowId);
    if (!row) { await goneAndRefresh(); return; }
    if (String(row.tg_chat_id) === String(chatId)) { await answer(BOT_RECIPIENT_SELF); return; }
    await together([
      answer(''),
      editMessageText(chatId, messageId, recipientConfirmText(row, index < 0 ? rows.length : index, { isLast: rows.length <= 1 }), {
        reply_markup: recipientConfirmKeyboard(rowId),
      }).catch(() => {}),
    ]);
    return;
  }

  if (kind === 'v') {
    await together([answer(''), sendRecipients(chatId, binding.business_id, messageId, rows)]);
    return;
  }

  // X: the confirm tap. Existence first: after a successful removal the list has
  // one row left, and a second tap must say "already removed", not "that is the
  // last phone". The delete is still scoped by business AND row, and reports 0
  // rows if two taps race.
  const row = index >= 0 ? rows[index] : await getBusinessChat(binding.business_id, rowId);
  if (!row) { await goneAndRefresh(); return; }
  if (String(row.tg_chat_id) === String(chatId)) { await answer(BOT_RECIPIENT_SELF); return; }
  if (rows.length <= 1) { await answer(BOT_RECIPIENT_LAST); return; }
  const removed = await removeBusinessChat(binding.business_id, rowId);
  // Three things that do not wait for each other: the notice to the removed
  // phone (its keyboard is stale the moment this row is gone), the toast, and
  // the list — read again, because it has just changed.
  await together([
    removed ? sendKeyboardRemoved(row.tg_chat_id) : null,
    answer(removed ? BOT_RECIPIENT_REMOVED : BOT_RECIPIENT_GONE),
    sendRecipients(chatId, binding.business_id, messageId),
  ]);
}

/**
 * Plain-text hint, at most 3 per chat per hour; fail closed (no reply).
 *
 * Every reply to free text goes out through replyRole, so it carries this
 * chat's own keyboard and the keyboard reopens after the user typed: the
 * owner or staff keyboard for a bound chat, the operator keyboard for the
 * unbound operator chat, ReplyKeyboardRemove for an unbound chat. The role is
 * resolved from the binding first, so an operator keyboard can never reach a
 * business chat. When the hint is rate limited the bot sends nothing, and a
 * keyboard cannot be sent without a message.
 */
async function handlePlainText(chatId, binding, text = '') {
  const shaped = bindCodeShape(text);
  if (binding) {
    // A bound chat never moves between businesses by pasting a code.
    if (shaped) {
      return replyRole(chatId, isOperatorChat(chatId) ? await operatorLinkReply(shaped) : BOT_ALREADY_CONNECTED_CODE, binding);
    }
  } else if (shaped) {
    if (isOperatorChat(chatId)) return replyRole(chatId, OPERATOR_DO_NOT_OPEN, null);
    return handlePastedCode(chatId, shaped);
  }
  if (isOperatorChat(chatId)) return replyRole(chatId, OPERATOR_WELCOME, binding);
  let within;
  try {
    within = await hitRateLimit('tghint:' + chatId, 3600, 3);
  } catch { return; }
  if (!within) return;
  await replyRole(chatId, binding ? BOT_PLAIN_TEXT : BOT_NOT_CONNECTED, binding);
}

/* ---------- operator commands ----------
   Authorised by chat id, in a private chat, on every message and every tap.
   A non-operator who sends one of these gets exactly what any unknown text gets
   (BOT_PLAIN_TEXT or BOT_NOT_CONNECTED), so the commands leave no trace. */

const SLUG_RE = /^[a-z0-9-]{2,60}$/;
const CODES_PER_SLUG_HOUR = 10;

/* ---------- operator invites ----------
   One set of rules for every way the operator asks for an invite: a number in
   the /invite list, the Invite button under a business, "/invite <slug>", and
   a button of the old /code picker.

     suspended           one short line and Back; nothing is created
     a phone is bound    "<Name> · Already connected · N phones" with Replace
                         phone and Back; nothing is created and NOTHING is
                         written, not even the hourly counter
     no phone            one new invite, shown as the two messages below

   An invite is never added next to a connected phone: more phones are the
   owner's own /invite. The operator can only REPLACE the phones, after one
   confirmation (replaceOperatorPhones).

   The two messages. (1) The guidance: slug, code, expiry and "the next
   message is for the client". From a button it is the browser message
   itself, edited, with Back to where the tap came from; typed, it is a new
   message. (2) A NEW message that is the only text a client may ever see: no
   slug, no business name, no operator wording. They are separate on purpose:
   forwarding the first would leak the slug. `at` is { chatId, page, from }
   plus { messageId, answer } when the request is a button tap. */

/** Draw one screen of the flow: an edit of the browser message for a tap
 *  (the toast goes out with it), one new message for a typed command. */
async function showInviteScreen(at, text, markup, toast = '') {
  if (at.messageId) {
    const [, edited] = await together([at.answer(toast), editList(at.chatId, at.messageId, text, markup)]);
    return edited;
  }
  return sendMessage(at.chatId, text, markup);
}

/** The screen the flow was opened from, redrawn from current data. */
async function showInviteOrigin(at, businessId, toast) {
  if (!at.messageId) return sendOperatorList({ kind: 'invite', chatId: at.chatId, page: 0 });
  if (at.from === 'business' && businessId) {
    return sendBusinessDetail({ chatId: at.chatId, messageId: at.messageId, businessId, page: at.page, answer: at.answer, toast });
  }
  return sendOperatorList({
    kind: at.from === 'business' ? 'businesses' : 'invite', chatId: at.chatId, page: at.page, messageId: at.messageId, answer: at.answer, toast,
  });
}

/**
 * Store ONE new invite for a business the caller has just read from the
 * database and found served. In this order: the hourly cap (10 per business,
 * fails closed: an unreachable counter means no code, not an unlimited one);
 * the new code; then every OTHER live unused code of the business is expired,
 * so the new code is the only one that can still connect a phone. Used codes
 * are never touched (they are the record of who connected).
 *
 * Returns { code, cancelled }, or { failed: 'capped' | 'error' } with nothing
 * usable left behind: if the older codes cannot be expired the new one is
 * taken back, because an invite that leaves an old link working is not the
 * invite that was asked for.
 */
async function createOperatorInvite(business) {
  let within;
  try { within = await hitRateLimit('opcode:' + business.slug, 3600, CODES_PER_SLUG_HOUR); } catch { return { failed: 'error' }; }
  if (!within) return { failed: 'capped' };
  let code;
  try {
    ({ code } = await mintBindCode(business.id));
  } catch (e) {
    console.error('operator_invite_mint_failed', (e && e.code) || 'no_code');
    return { failed: 'error' };
  }
  try {
    return { code, cancelled: await expireOtherBindCodes(business.id, code) };
  } catch (e) {
    console.error('operator_invite_expire_failed', (e && e.code) || 'no_code');
    await expireBindCode(business.id, code).catch(() => {});
    return { failed: 'error' };
  }
}

/**
 * The two messages of one invite, in order: the guidance first (an edit for a
 * tap; if the edit does not land it is sent as a new message, so the operator
 * is never left without the code), then the client message. If the client
 * message cannot be sent, the guidance says so and repeats the code: the code
 * exists and is valid, only the forwardable copy failed.
 */
async function sendInviteOutput(at, business, { code, cancelled = 0, removed = 0, failed = 0 }) {
  const username = await botUsername();
  const notes = { code, hours: BIND_CODE_HOURS, cancelled, removed, failed };
  const back = operatorInviteBackKeyboard(business.id, at.page, at.from);
  const guidance = operatorCodeText({ slug: business.slug, ...notes });
  const asMarkup = (m) => ({ ...back, entities: m.entities });
  let edited = false;
  if (at.messageId) {
    const [, r] = await together([at.answer(''), editList(at.chatId, at.messageId, guidance.text, asMarkup(guidance))]);
    edited = !!(r && r.ok);
  }
  if (!edited) await sendMessage(at.chatId, guidance.text, asMarkup(guidance)).catch(() => {});
  const forward = await replyMessage(at.chatId, botForwardText({ code, username, hours: BIND_CODE_HOURS })).catch(() => null);
  if (forward && forward.ok) return;
  console.error('code_forward_send_failed');
  const resend = operatorCodeResendText(notes);
  if (edited) await editList(at.chatId, at.messageId, resend.text, asMarkup(resend)).catch(() => {});
  else await sendMessage(at.chatId, resend.text, asMarkup(resend)).catch(() => {});
}

/**
 * Replace phone, confirmed. In this order:
 *  (a) the new invite is stored FIRST. If that fails (the cap, the counter,
 *      the database) nothing is removed and the screen says so;
 *  (b) every other pending invite of the business is expired (inside
 *      createOperatorInvite), so an old link cannot be redeemed;
 *  (c) ALL bindings of the business are deleted in one statement scoped by
 *      its id; the statement returns the chats it removed. If it fails, the
 *      new invite is taken back and the screen says no phone was removed;
 *  (d) each removed chat gets one plain notice with ReplyKeyboardRemove; a
 *      notice that fails is counted and blocks nothing;
 *  (e) the two messages of the new invite.
 * The business status is not touched. The first phone that redeems the new
 * invite is the oldest binding, which is what "main phone" means.
 *
 * Two confirms at the same moment would each expire the other's new code, so
 * the step is taken under a short claim on the rate-limit table (one per
 * business per minute, released when the step ends). The tap that does not
 * get the claim changes nothing and is told "Already replaced."; so is a tap
 * that finds no phone left to remove.
 */
async function replaceOperatorPhones(at, business) {
  const back = operatorInviteBackKeyboard(business.id, at.page, at.from);
  const lockKey = 'opreplace:' + business.id;
  let claimed;
  // Fail closed: without the claim nothing is created and nothing is removed.
  try { claimed = await hitRateLimit(lockKey, 60, 1); } catch { await at.answer(TOAST_GENERIC_ERROR); return; }
  if (!claimed) { await at.answer(OPERATOR_ALREADY_REPLACED); return; }
  try {
    const made = await createOperatorInvite(business);
    if (made.failed) {
      await showInviteScreen(at, operatorInviteFailedText({ business, capped: made.failed === 'capped', replace: true }), back);
      return;
    }
    let removedChats;
    try {
      removedChats = await removeAllBusinessChats(business.id);
    } catch (e) {
      console.error('operator_replace_remove_failed', (e && e.code) || 'no_code');
      await expireBindCode(business.id, made.code).catch(() => {});
      await showInviteScreen(at, operatorReplaceFailedText(business), back);
      return;
    }
    if (!removedChats.length) {
      // Another request removed them between the count and this statement.
      await expireBindCode(business.id, made.code).catch(() => {});
      await at.answer(OPERATOR_ALREADY_REPLACED);
      return;
    }
    const notices = await together(removedChats.map((chat) => settle(
      sendMessage(chat, BOT_ACCESS_ENDED, { reply_markup: { remove_keyboard: true } }))));
    await sendInviteOutput(at, business, {
      code: made.code, cancelled: made.cancelled, removed: removedChats.length, failed: notices.filter(sendFailed).length,
    });
  } finally {
    await clearRateLimit(lockKey).catch(() => {});
  }
}

/**
 * One step of the flow for a business the caller addressed by id (a tap) or
 * has just read by slug (the typed command; `known` is that row).
 *   open     the rules at the top of this section
 *   ask      the Replace question
 *   cancel   back to "Already connected"; never creates anything
 *   confirm  replaceOperatorPhones
 * The business and its phone count are read on EVERY step, together. Gone: a
 * toast and the current list. Suspended: the one line and Back, whatever the
 * step. A phone count that cannot be read stops the step (the dispatcher
 * answers with the generic error): nothing is created on a guess. ask, cancel
 * and confirm need a phone to act on; with none left, confirm says "Already
 * replaced." and leaves the message alone (it may be showing the new invite),
 * and the other two redraw the screen the flow was opened from.
 */
async function operatorInviteStep(at, { step, businessId, known = null }) {
  const [biz, count] = await together([
    known ? { value: known } : settle(getBusinessById(businessId)),
    settle(countBusinessChats(businessId)),
  ]);
  if (biz.error) throw biz.error;
  const business = biz.value;
  if (!business) { await showInviteOrigin(at, null, OPERATOR_BUSINESS_GONE); return; }
  const back = operatorInviteBackKeyboard(business.id, at.page, at.from);
  if (isSuspendedStatus(business.status)) {
    await showInviteScreen(at, operatorInviteSuspendedText(business), back);
    return;
  }
  if (count.error) throw count.error;
  const phones = count.value;

  if (step === 'open') {
    if (phones > 0) {
      await showInviteScreen(at, operatorAlreadyConnectedText({ business, phones }),
        operatorAlreadyConnectedKeyboard(business.id, at.page, at.from));
      return;
    }
    const made = await createOperatorInvite(business);
    if (made.failed) {
      await showInviteScreen(at, operatorInviteFailedText({ business, capped: made.failed === 'capped' }), back);
      return;
    }
    await sendInviteOutput(at, business, made);
    return;
  }
  if (phones === 0) {
    if (step === 'confirm') await at.answer(OPERATOR_ALREADY_REPLACED);
    else await showInviteOrigin(at, business.id, OPERATOR_NO_PHONE_NOW);
    return;
  }
  if (step === 'ask') {
    await showInviteScreen(at, operatorReplaceConfirmText({ business, phones }),
      operatorReplaceConfirmKeyboard(business.id, at.page, at.from));
  } else if (step === 'cancel') {
    await showInviteScreen(at, operatorAlreadyConnectedText({ business, phones }),
      operatorAlreadyConnectedKeyboard(business.id, at.page, at.from));
  } else {
    await replaceOperatorPhones(at, business);
  }
}

/**
 * /invite in the operator chat. With no word after it: the list, one message
 * edited in place. With a slug: the same rules as a pick from that list,
 * answered with new messages (Back leads to the first page of the list).
 */
async function handleOperatorInvite(chatId, arg) {
  const slug = String(arg || '').trim();
  if (!slug) {
    try {
      return await sendOperatorList({ kind: 'invite', chatId, page: 0 });
    } catch (e) {
      console.error('operator_invite_list_failed', (e && e.code) || 'no_code');
      return reply(chatId, TOAST_GENERIC_ERROR);
    }
  }
  if (!SLUG_RE.test(slug)) return reply(chatId, OPERATOR_USAGE_INVITE);
  const business = await getBusinessBySlug(slug).catch(() => null);
  if (!business) return reply(chatId, OPERATOR_UNKNOWN_SLUG);
  try {
    return await operatorInviteStep({ chatId, page: 0, from: 'list' }, { step: 'open', businessId: business.id, known: business });
  } catch (e) {
    console.error('operator_invite_failed', (e && e.code) || 'no_code');
    return reply(chatId, TOAST_GENERIC_ERROR);
  }
}

/* ---------- operator business browser ----------
   /businesses and /invite each open ONE message, edited in place like the
   owner's /leads: the list, one business, its leads (read-only, minimal), an
   invite, Suspend and Reactivate. Operator access is cross-business by
   design, so nothing here comes from a binding; instead every tap is (1)
   checked against OPERATOR_CHAT_ID by the dispatcher before anything is read,
   and (2) has its business id read back from the database before anything is
   drawn or changed. A business that is gone answers with a toast and the
   current list. A lead is always read by its own id AND that validated
   business id. */

const BUSINESS_PAGE = 5;
const BUSINESS_PAGE_MAX = 199;
const clampBusinessPage = (page) => Math.max(0, Math.min(BUSINESS_PAGE_MAX, Number(page) || 0));

/** One page of /businesses in exactly two queries: the rows (name, then id),
 *  and the phone counts of those rows together. Never one count per business.
 *  One page of /invite is the first query alone, served businesses only. */
async function readOperatorPage(kind, page) {
  const rows = await listBusinessesPage(BUSINESS_PAGE + 1, page * BUSINESS_PAGE, { served: kind === 'invite' });
  const shown = rows.slice(0, BUSINESS_PAGE);
  const hasOlder = rows.length > BUSINESS_PAGE && page < BUSINESS_PAGE_MAX;
  if (kind === 'invite') return { shown, hasOlder };
  // Counted by business id, so a suspended business shows its phones too.
  // null, not 0, when the count fails: the text says "?" for it.
  const counts = shown.length ? await countChatsForBusinesses(shown.map((r) => r.id)).catch(() => null) : null;
  return {
    shown: shown.map((r) => ({ ...r, phones: counts ? (counts.get(String(r.id)) || 0) : null })),
    hasOlder,
  };
}

/** Either list. With a message id it is an edit, and the toast goes out with
 *  it; without one (the command) it is the one new message. A page that no
 *  longer exists becomes the first page, never an empty screen. */
async function sendOperatorList({ kind, chatId, page, messageId = null, answer = null, toast = '' }) {
  let p = clampBusinessPage(page);
  let view = await readOperatorPage(kind, p);
  let note = toast;
  if (!view.shown.length && p > 0) {
    p = 0;
    view = await readOperatorPage(kind, 0);
    note = note || OPERATOR_PAGE_GONE;
  }
  const invite = kind === 'invite';
  const text = invite ? operatorInviteListText(view.shown) : operatorBusinessListText(view.shown);
  const markup = !view.shown.length ? { reply_markup: { inline_keyboard: [] } }
    : invite ? operatorInviteListKeyboard(view.shown, p, view.hasOlder)
      : operatorBusinessListKeyboard(view.shown, p, view.hasOlder);
  if (messageId) {
    const [, edited] = await together([answer ? answer(note) : null, editList(chatId, messageId, text, markup)]);
    return edited;
  }
  return sendMessage(chatId, text, markup);
}

const sendBusinessPage = (chatId, page, messageId, answer = null, toast = '') =>
  sendOperatorList({ kind: 'businesses', chatId, page, messageId, answer, toast });

/** /businesses: the browser's first page as one new message. */
async function handleOperatorBusinesses(chatId) {
  try {
    return await sendBusinessPage(chatId, 0, null);
  } catch (e) {
    console.error('operator_businesses_failed', (e && e.code) || 'no_code');
    return reply(chatId, TOAST_GENERIC_ERROR);
  }
}

/** One business: its phones and its lead numbers. The four reads need only
 *  the id, so they run together; the business row is judged first, and
 *  nothing is drawn unless it exists. The lead numbers are two aggregates
 *  (a count with the newest created_at, and a count since a date): no lead
 *  row and no lead content is read for this screen. */
async function sendBusinessDetail({ chatId, messageId, businessId, page, answer, toast = '' }) {
  const since = new Date(Date.now() - OPERATOR_RECENT_DAYS * 86400000).toISOString();
  const [biz, chats, totals, recent] = await together([
    settle(getBusinessById(businessId)),
    settle(listBusinessChatsDetailed(businessId)),
    settle(getLeadTotals(businessId)),
    settle(countClientLeadsSince(businessId, since)),
  ]);
  if (biz.error) throw biz.error;
  const business = biz.value;
  if (!business) return sendBusinessPage(chatId, page, messageId, answer, OPERATOR_BUSINESS_GONE);
  // A count of the leads being held, only while the business is suspended.
  const held = business.status === 'paused' ? await heldLeadCount(business, SERVICE_IO) : null;
  const text = operatorBusinessDetailText({
    business,
    rows: chats.error ? null : chats.value,
    stats: {
      total: totals.error ? null : totals.value.total,
      lastAt: totals.error ? null : totals.value.lastAt,
      recent: recent.error ? null : recent.value,
      held,
    },
  });
  const suspended = isSuspendedStatus(business.status);
  const markup = operatorBusinessDetailKeyboard(business.id, page, {
    suspended,
    terminated: business.status === 'churned',
    connected: Array.isArray(chats.value) && chats.value.length > 0,
    billingSuspended: suspended && !business.billing_unavailable && business.suspended_for_billing === true,
  });
  await together([answer(toast), editList(chatId, messageId, text, markup)]);
}

/** The validated business row for a tap, or null after answering with the
 *  current list. Every lead read below waits for this. */
async function operatorBusinessOrList({ chatId, messageId, businessId, page, answer }) {
  const business = await getBusinessById(businessId);
  if (!business) await sendBusinessPage(chatId, page, messageId, answer, OPERATOR_BUSINESS_GONE);
  return business;
}

/** The business's leads, read-only and minimal: only the columns behind
 *  OPERATOR_LEAD_FIELDS are read, in the owner's order (created_at desc, id
 *  desc), scoped by the validated business id. */
async function sendOperatorLeads({ chatId, messageId, business, leadPage, page, answer, toast = null }) {
  const lp = Math.max(0, Math.min(LEADS_PAGE_MAX, Number(leadPage) || 0));
  const leads = await listLeadsColumns(business.id, operatorLeadColumns(), LEADS_PAGE + 1, lp * LEADS_PAGE);
  const hasOlder = leads.length > LEADS_PAGE && lp < LEADS_PAGE_MAX;
  const shown = leads.slice(0, LEADS_PAGE);
  const note = toast !== null ? toast : (shown.length ? '' : (lp === 0 ? OPERATOR_NO_LEADS : OPERATOR_NO_OLDER_LEADS));
  await together([
    answer(note),
    editList(chatId, messageId, operatorLeadListText(business, shown, lp),
      operatorLeadListKeyboard({ businessId: business.id, leads: shown, leadPage: lp, page, hasOlder })),
  ]);
}

async function handleOperatorLeadsPage({ chatId, messageId, businessId, leadPage, page, answer }) {
  const business = await operatorBusinessOrList({ chatId, messageId, businessId, page, answer });
  if (!business) return;
  await sendOperatorLeads({ chatId, messageId, business, leadPage, page, answer });
}

/** One lead, read-only: the allowed fields, and only Back under it. */
async function handleOperatorLeadOpen({ chatId, messageId, businessId, leadId, leadPage, page, answer }) {
  const business = await operatorBusinessOrList({ chatId, messageId, businessId, page, answer });
  if (!business) return;
  const lead = await getLeadColumns(leadId, business.id, operatorLeadColumns()).catch(() => null);
  if (!lead) {
    await sendOperatorLeads({ chatId, messageId, business, leadPage, page, answer, toast: OPERATOR_LEAD_GONE });
    return;
  }
  await together([
    answer(''),
    editList(chatId, messageId, operatorLeadCardText(business, lead),
      operatorLeadDetailKeyboard({ businessId: business.id, leadPage, page })),
  ]);
}

/**
 * Suspend: stop the whole service for one business. `confirmed` false asks,
 * true does it. The only thing written is businesses.status ('paused');
 * bindings, invites and leads are untouched, so Reactivate restores
 * everything without re-onboarding.
 *
 * On confirm: suspendBusiness() (lib/service-status.js, the ONE suspension
 * path, shared with the daily billing job) writes the status in one UPDATE
 * scoped by the id AND the served statuses, so a second tap or a race changes
 * nothing, and then sends the suspension notice to every bound phone (with
 * the one-button Status keyboard) and to the owner address. A notice that
 * fails is logged, alerts this chat and blocks nothing. The operator's
 * message then becomes the result. A business that is already suspended or
 * terminated gets no notice and no write. A suspension made here is never
 * marked "for non-payment", so the daily job leaves it alone.
 */
async function handleOperatorSuspend({ chatId, messageId, businessId, page, answer, confirmed }) {
  const [biz, chats] = await together([
    settle(getBusinessById(businessId)),
    // The question needs no phone list; only the suspension itself does.
    confirmed ? settle(listBusinessChatsDetailed(businessId)) : null,
  ]);
  if (biz.error) throw biz.error;
  const business = biz.value;
  if (!business) { await sendBusinessPage(chatId, page, messageId, answer, OPERATOR_BUSINESS_GONE); return; }
  const back = operatorBackToBusinessKeyboard(business.id, page);
  const terminated = business.status === 'churned';
  const already = () => together([
    answer(terminated ? OPERATOR_ALREADY_TERMINATED : OPERATOR_ALREADY_SUSPENDED),
    editList(chatId, messageId, terminated ? operatorAlreadyTerminatedText(business) : operatorAlreadySuspendedText(business), back),
  ]);

  if (isSuspendedStatus(business.status)) {
    if (confirmed) { await already(); return; }
    await sendBusinessDetail({
      chatId, messageId, businessId: business.id, page, answer,
      toast: terminated ? OPERATOR_ALREADY_TERMINATED : OPERATOR_ALREADY_SUSPENDED,
    });
    return;
  }
  if (!confirmed) {
    await together([
      answer(''),
      editList(chatId, messageId, operatorSuspendConfirmText(business), operatorSuspendConfirmKeyboard(business.id, page)),
    ]);
    return;
  }

  // The phones could not be read: nothing is changed and nobody is told. The
  // dispatcher answers with the generic error and the question stays on
  // screen. A status that could not be written throws too, and nothing is
  // reported as done.
  if (chats.error) throw chats.error;
  const { changed, notice } = await suspendBusiness({ business, rows: chats.value }, SERVICE_IO);
  if (!changed) { await already(); return; }
  await together([
    answer(OPERATOR_SUSPENDED),
    editList(chatId, messageId, operatorSuspendedText({ business, notice }), back),
  ]);
}

/**
 * Terminate: the operator ends a service by hand, from an active or a
 * suspended business. `confirmed` false asks, true does it. It is
 * terminateBusiness() in lib/service-status.js, the SAME function the daily
 * job calls at the end of the suspended period: status 'churned' in one
 * scoped UPDATE, then the termination notice to every phone and the owner
 * address. Nothing is deleted, so Extend 30 days puts the business back;
 * Reactivate refuses a terminated one. A termination made here is never
 * marked "for non-payment".
 *
 * The buttons are bx (ask) and bX (confirm). bt / bT, the letters of the
 * Terminate that used to delete a business, stay retired.
 */
async function handleOperatorTerminate({ chatId, messageId, businessId, page, answer, confirmed }) {
  const [biz, chats] = await together([
    settle(getBusinessById(businessId)),
    confirmed ? settle(listBusinessChatsDetailed(businessId)) : null,
  ]);
  if (biz.error) throw biz.error;
  const business = biz.value;
  if (!business) { await sendBusinessPage(chatId, page, messageId, answer, OPERATOR_BUSINESS_GONE); return; }
  const back = operatorBackToBusinessKeyboard(business.id, page);
  const already = () => together([
    answer(OPERATOR_ALREADY_TERMINATED),
    editList(chatId, messageId, operatorAlreadyTerminatedText(business), back),
  ]);

  if (business.status === 'churned') {
    if (confirmed) { await already(); return; }
    await sendBusinessDetail({ chatId, messageId, businessId: business.id, page, answer, toast: OPERATOR_ALREADY_TERMINATED });
    return;
  }
  if (!confirmed) {
    await together([
      answer(''),
      editList(chatId, messageId, operatorTerminateConfirmText(business), operatorTerminateConfirmKeyboard(business.id, page)),
    ]);
    return;
  }

  if (chats.error) throw chats.error;
  const { changed, notice } = await terminateBusiness({ business, rows: chats.value }, SERVICE_IO);
  if (!changed) { await already(); return; }
  await together([
    answer(OPERATOR_TERMINATED),
    editList(chatId, messageId, operatorTerminatedText({ business, notice }), back),
  ]);
}

/**
 * Reactivate: br opens a confirmation, bR does the work. A stale br from an
 * old screen always lands on the question, never on the state change.
 * reactivateBusiness() (lib/service-status.js, shared with a recorded
 * payment) then writes 'active' in one UPDATE scoped by the id AND the
 * suspended statuses, so a second tap changes nothing. Every bound phone
 * gets its role keyboard back and the owner address gets the same email;
 * the notice says how many leads were held. paid_until is not touched.
 *
 * Terminated is not this button's business: both br and bR refuse a 'churned'
 * row and point at Extend 30 days, writing nothing. reactivateBusiness() still
 * accepts it for Extend and applyPayment(), so the guard lives here and only
 * here.
 */
async function handleOperatorReactivate({ chatId, messageId, businessId, page, answer, confirmed = false }) {
  const [biz, chats] = await together([
    settle(getBusinessById(businessId)),
    confirmed ? settle(listBusinessChatsDetailed(businessId)) : null,
  ]);
  if (biz.error) throw biz.error;
  const business = biz.value;
  if (!business) { await sendBusinessPage(chatId, page, messageId, answer, OPERATOR_BUSINESS_GONE); return; }
  const back = operatorBackToBusinessKeyboard(business.id, page);
  const already = () => together([
    answer(OPERATOR_ALREADY_ACTIVE),
    editList(chatId, messageId, operatorAlreadyActiveText(business), back),
  ]);
  // Terminated: Extend 30 days is the only way back (owner, 2026-11-17). Refused
  // on BOTH paths, before anything is read for writing: a stale br never offers
  // a confirm it cannot honour, and a stale bR never restores a business the
  // next daily run would terminate again (which told the owner "active again"
  // for a day). Nothing is written, sent or logged. reactivateBusiness() is
  // untouched: Extend and applyPayment() still use it to restore a business.
  if (business.status === 'churned') {
    await together([
      answer(OPERATOR_TERMINATED_EXTEND),
      editList(chatId, messageId, operatorTerminatedReactivateText(business), back),
    ]);
    return;
  }
  // A billing suspension has no Reactivate button: only a recorded payment
  // clears suspended_for_billing. A stale br:/bR: must not restore the service
  // without one, or the next daily run would terminate it again.
  if (business.suspended_for_billing) {
    await together([
      answer(OPERATOR_BILLING_EXTEND),
      editList(chatId, messageId, operatorBillingReactivateText(business), back),
    ]);
    return;
  }
  if (!confirmed) {
    await together([
      answer(''),
      editList(chatId, messageId, operatorReactivateConfirmText(business), operatorReactivateConfirmKeyboard(business.id, page)),
    ]);
    return;
  }
  if (!isSuspendedStatus(business.status)) { await already(); return; }
  if (chats.error) throw chats.error;

  const { changed, notice } = await reactivateBusiness({ business, rows: chats.value, reason: 'manual' }, SERVICE_IO);
  if (!changed) { await already(); return; }
  await together([
    answer(OPERATOR_REACTIVATED),
    editList(chatId, messageId, operatorReactivatedText(business, { notice }), back),
  ]);
}

/**
 * Extend 30 days: the operator records one payment. `token` null asks; a
 * token is the Confirm button, and carries the exact paid-until moment the
 * question showed.
 *
 * Ask: the date is nextPaidUntil(paid_until, now): max(paid_until, now) + 30
 * days. Nothing is written.
 *
 * Confirm: applyPayment() with the date FROM THE BUTTON. That is what makes a
 * double tap harmless: the second tap asks for the same date, the business is
 * already paid that far, and nothing is written, sent or reactivated. Before
 * it is applied the date is checked against the business as it is now: it
 * must lie in the future and be no later than one press could reach, so no
 * button, however old, can add more than one period. A date that fails that
 * check is a screen that expired: the business is shown as it is.
 *
 * A suspended or terminated business is reactivated through the Reactivate
 * path (notices and keyboards included), and the question says so before the
 * tap.
 */
async function handleOperatorExtend({ chatId, messageId, businessId, page, answer, token = null }) {
  const business = await operatorBusinessOrList({ chatId, messageId, businessId, page, answer });
  if (!business) return;
  const back = operatorBackToBusinessKeyboard(business.id, page);
  if (business.billing_unavailable) {
    await together([answer(''), editList(chatId, messageId, OPERATOR_BILLING_UNAVAILABLE, back)]);
    return;
  }
  const now = Date.now();
  const suspended = isSuspendedStatus(business.status);

  if (token === null) {
    const target = nextPaidUntil(business.paid_until, now);
    await together([
      answer(''),
      editList(chatId, messageId, operatorExtendConfirmText({ business, target, suspended }),
        operatorExtendConfirmKeyboard(business.id, page, target)),
    ]);
    return;
  }

  const parsed = decodeExtendToken(token);
  const target = parsed && parsed.target;
  if (!parsed || extendTokenExpired(parsed, now) || !extendTargetAllowed(target, business.paid_until, now)) {
    await sendBusinessDetail({ chatId, messageId, businessId: business.id, page, answer, toast: OPERATOR_SCREEN_EXPIRED });
    return;
  }

  const r = await applyPayment({ businessId: business.id, paidUntil: target, source: 'operator', reactivate: 'any', business }, SERVICE_IO);
  if (!r.ok) {
    if (r.reason === 'unavailable') { await together([answer(''), editList(chatId, messageId, OPERATOR_BILLING_UNAVAILABLE, back)]); return; }
    await sendBusinessPage(chatId, page, messageId, answer, OPERATOR_BUSINESS_GONE);
    return;
  }
  if (!r.changed) {
    // Already paid that far (the second tap of a double tap): nothing was
    // written, nobody was told.
    await together([
      answer(OPERATOR_ALREADY_EXTENDED),
      editList(chatId, messageId, operatorAlreadyExtendedText({ business, paidUntil: r.paidUntil }), back),
    ]);
    return;
  }
  await together([
    answer(OPERATOR_EXTENDED),
    editList(chatId, messageId, operatorExtendedText({
      business, paidUntil: r.paidUntil, reactivated: r.reactivated, notice: r.notice || null,
    }), back),
  ]);
}

/* ---------- callback handling ----------
   handleCallback authenticates, parses, reads the lead once, then dispatches on
   the first character of callback_data. One function per kind; the shared
   answer() answers at most once, so a handler that already answered and then
   throws does not produce a second toast.

   Where the time goes, and the two rules that keep it short:
   1. The toast is sent as soon as its text is known and is never waited for
      before the next step: answer() goes out TOGETHER with the edit (or with
      the writes that follow), so the spinner stops while the message is being
      redrawn. A toast whose text depends on a read or a write still waits for
      that read or write, and for nothing else.
   2. A lead is read once per tap. The dispatcher reads it through
      v_client_leads, scoped by id AND business, and the card is drawn from
      that row; it is read again only when a write was refused, because that
      is the one case where the row is known to have changed. */

/** Everything a handler needs, including render(), which draws the card. */
function makeContext({ cb, business, lead, leadId, businessId, answer, surface = 'alert', page = 0 }) {
  const chatId = cb.message && cb.message.chat && cb.message.chat.id;
  const messageId = cb.message && cb.message.message_id;
  // The page the browser list came from, bounded; Back and the detail's own
  // actions re-address it, so it must never grow past what the regexes allow.
  const safePage = Math.max(0, Math.min(LEADS_PAGE_MAX, Number(page) || 0));

  /**
   * The keyboard for a card state, on the surface the tap came from. The alert
   * surface keeps today's keyboards exactly. The browser detail (surface
   * 'detail') keeps the same actions and styles and adds Back to the page it
   * came from.
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

  // The row the card is drawn from: what this request read through the
  // roofer-facing view (scoped by id AND business) — the dispatcher's read,
  // or renderCurrent's newer one. Never the previous message text.
  let current = lead;

  // Render from that row. The view (and so the status line and the buttons)
  // is the caller's: it comes from the write this request has just made, or
  // from the row itself. Nothing but the status changes on a lead after it is
  // stored, so the row read before the write still holds every other line of
  // the card, and reading it a second time would only repeat the first read.
  // If the text cannot be built, edit only the keyboard.
  const render = async (view, reviewResult = null) => {
    if (!chatId || !messageId) return;
    const fresh = current;
    let text;
    try {
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

  /** Re-render this lead in whatever state it is in NOW. Used by a stale tap:
   *  a write was refused, so the row has changed since the dispatcher read it
   *  and is read again — once; render() then draws from this newer row. */
  const renderCurrent = async () => {
    const fresh = await getClientLead(leadId, businessId).catch(() => null);
    if (!fresh) return;
    current = fresh;
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
    await together([answer(TOAST_ALREADY_UPDATED), ctx.renderCurrent()]);
    return;
  }
  // The status is written. The toast, the two event rows and the new card do
  // not depend on each other, so none of them waits for another. The events
  // keep their own order (status_changed, then contacted).
  const events = async () => {
    try { await addEvent(leadId, 'status_changed', { status: 'contacted' }); } catch (e) {
      console.error('tg_status_event_failed', (e && e.code) || 'no_code');
    }
    try { await addEvent(leadId, 'contacted', {}); } catch (e) {
      console.error('tg_contacted_event_failed', (e && e.code) || 'no_code');
    }
  };
  await together([answer(''), events(), render('contacted')]);
}

/** d: ask before emailing; no write, no email. */
async function onJobDone(ctx) {
  const { answer, render, lead, leadId } = ctx;
  if (lead.status === 'done') { await together([answer(TOAST_ALREADY_UPDATED), ctx.renderCurrent()]); return; }
  if (lead.status !== 'contacted' && lead.status !== 'quoted' && lead.status !== 'won') {
    await answer(TOAST_CONTACT_FIRST);
    return;
  }
  await together([answer(''), render('confirm')]);
}

/** n: cancel back to step 2. No write. */
async function onCancel(ctx) {
  const { answer, render, leadId } = ctx;
  await together([answer(''), render('contacted')]);
}

/** y: contacted/quoted/won -> done, then send the review request. */
async function onConfirm(ctx) {
  const { answer, render, lead, leadId, businessId, business } = ctx;
  if (lead.status === 'done') { await together([answer(TOAST_ALREADY_UPDATED), ctx.renderCurrent()]); return; }
  if (lead.status !== 'contacted' && lead.status !== 'quoted' && lead.status !== 'won') {
    await answer(TOAST_CONTACT_FIRST);
    return;
  }
  const token = randomBytes(24).toString('base64url');
  const result = await transitionLead(leadId, businessId, 'done', token);
  if (!result.changed) { await together([answer(TOAST_ALREADY_UPDATED), ctx.renderCurrent()]); return; }
  // The lead is done and the toast is empty whatever the email does, so the
  // spinner is stopped now and not waited for: the event row and the email
  // start at once. It is awaited at the very end, after the card is drawn.
  const answered = answer('');
  // Post-transition: the lead is done, so a throw here must not leave the
  // old Yes/Cancel buttons on screen (Yes would only say "already
  // completed" and Try again would never be offered). Best-effort render
  // of the error view (or the no-email done view) instead; no second answer.
  try {
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
  await answered;
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
    // Every check has passed: the toast is empty whatever the email does, so
    // the spinner stops while the email is being sent.
    const answered = answer('');
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
    await answered;
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

/** Timing-log names for the lead buttons. Fixed strings, one per kind. */
const LEAD_HANDLER_NAMES = {
  c: 'contacted', d: 'job_done', n: 'cancel', y: 'confirm', r: 'retry', o: 'open_card',
};

/**
 * An answerer that reaches Telegram at most once per callback query.
 *
 * Every branch answers exactly once (a spinner that never stops is worse than a
 * generic toast), and a handler that somehow answered and then threw must not
 * produce a second toast. Exported so the guard can be exercised on its own.
 *
 * Every later call returns the FIRST call's promise. A handler may start the
 * answer and carry on without waiting for it; whoever calls again — the
 * dispatcher's catch included — then waits for that one request to finish, so
 * the function never returns while the answer is still on its way.
 */
export function createAnswerOnce(id) {
  let sent = null;
  return (text) => {
    if (!sent) sent = answerCallbackQuery(id, text).catch(() => {});
    return sent;
  };
}

const CB_LEAD = /^([cdynrvxo]):([0-9a-f-]{36})$/;
const CB_RECIPIENT = /^([xXv]):([0-9a-f-]{36})$/;
// The operator's old "Remove Phone N" buttons. They no longer remove anything:
// a tap answers "expired" and shows the current business list.
const CB_OPERATOR_PHONE = /^([pPq]):([0-9a-f-]{36})$/;
const CB_PAGE = /^l:(\d{1,3})$/;
// The in-place /leads browser. Number taps and detail actions carry the page the
// list came from, so Back restores that exact page; the lead address is a uuid
// and the page is bounded digits, so nothing a customer typed can ride along.
const CB_LEAD_OPEN = /^L:(\d{1,3}):([0-9a-f-]{36})$/;
// Item A5: the held list's own number tap, page and Back from its detail.
const CB_HELD_OPEN = /^HL:(\d{1,3}):([0-9a-f-]{36})$/;
const CB_HELD_PAGE = /^hL:(\d{1,3})$/;
const CB_HELD_BACK = /^hl:(\d{1,3})$/;
const CB_LEAD_DETAIL = /^([CDYNR]):(\d{1,3}):([0-9a-f-]{36})$/;
// /remove_lead: open a confirm, delete, cancel, page. All scoped to the binding.
const CB_REMOVE_OPEN = /^rl:([0-9a-f-]{36})$/;
const CB_REMOVE_DELETE = /^RL:([0-9a-f-]{36})$/;
const CB_REMOVE_CANCEL = /^rc:([0-9a-f-]{36})$/;
const CB_REMOVE_PAGE = /^rm:(\d{1,3})$/;
// The /remove_lead browser: a number tap asks, E: confirms. Same owner gate.
const CB_REMOVE_ASK = /^Q:(\d{1,3}):([0-9a-f-]{36})$/;
const CB_REMOVE_DO = /^E:(\d{1,3}):([0-9a-f-]{36})$/;
// The invite-cap button. No business id in the payload: the business comes from
// the binding, so a forged callback can only ever act on the sender's own.
const CB_INVITE_CANCEL = /^i:c$/;
// Buttons of the operator's old pickers. pc was the /code picker: it follows
// today's invite rules for that business. pb was the /phones picker: retired.
const CB_OPERATOR_PICK = /^(pb|pc):([0-9a-f-]{36})$/;
// The operator's business browser (see lib/content.js for the table). Pages are
// bounded digits and every id is a uuid, as text or as 22 packed characters.
// bl = the business list, bn = the /invite list.
const CB_OP_LIST = /^(bl|bn):(\d{1,3})$/;
// bd open, bs ask to suspend, bS suspend, br ask to reactivate, bR reactivate,
// be ask to extend the paid period, bx ask to terminate, bX terminate; bt/bT were the
// retired Terminate (it deleted data) and only ever answer "expired". The invite flow, once per origin (see OP_INVITE_STEPS): from the
// /invite list bi open, bp ask to replace, bP replace, bc cancel; from the
// business bv, bw, bW, bu.
const CB_OP_BUSINESS = /^(bd|bs|bS|br|bR|be|bi|bp|bP|bc|bv|bw|bW|bu|bt|bT|bx|bX):(\d{1,3}):([0-9a-f-]{36})$/;
// bE: extend to exactly <until> (whole seconds, base 36; lib/billing.js).
const CB_OP_EXTEND = /^bE:(\d{1,3}):([0-9a-f-]{36}):([0-9a-z]{1,8}\.[0-9a-z]{1,8})$/;
const CB_OP_LEADS = /^bq:(\d{1,2}):(\d{1,3}):([0-9a-f-]{36})$/;
const CB_OP_LEAD = /^bo:(\d{1,2}):(\d{1,3}):([A-Za-z0-9_-]{22})([A-Za-z0-9_-]{22})$/;
/** The invite flow's callbacks: which step, and where Back leads. */
const OP_INVITE_STEPS = {
  bi: { step: 'open', from: 'list' }, bp: { step: 'ask', from: 'list' },
  bP: { step: 'confirm', from: 'list' }, bc: { step: 'cancel', from: 'list' },
  bv: { step: 'open', from: 'business' }, bw: { step: 'ask', from: 'business' },
  bW: { step: 'confirm', from: 'business' }, bu: { step: 'cancel', from: 'business' },
};
const OP_BUSINESS_HANDLER_NAMES = {
  bd: 'cb.operator_business_open', bs: 'cb.operator_suspend_ask', bS: 'cb.operator_suspend',
  br: 'cb.operator_reactivate_ask', bR: 'cb.operator_reactivate', be: 'cb.operator_extend_ask', bv: 'cb.operator_invite_business', bi: 'cb.operator_invite_open',
  bp: 'cb.operator_replace_ask', bw: 'cb.operator_replace_ask',
  bP: 'cb.operator_replace', bW: 'cb.operator_replace',
  bc: 'cb.operator_replace_cancel', bu: 'cb.operator_replace_cancel',
  bt: 'cb.operator_expired', bT: 'cb.operator_expired',
  bx: 'cb.operator_terminate_ask', bX: 'cb.operator_terminate',
};

/** Open one lead as a NEW message with its current card. */
async function handleOpenLead({ cb, leadId, binding, answer }) {
  const chatId = cb.message && cb.message.chat && cb.message.chat.id;
  let within;
  // Fail closed: a stuck counter must not become an unlimited open loop.
  try { within = await hitRateLimit('open:' + chatId, 3600, OPENS_PER_HOUR); } catch { return; }
  if (!within) { await answer(TOAST_TOO_MANY_OPENS); return; }
  // Both reads need only the binding's business, so they run together.
  const [lead, business] = await together([
    getClientLead(leadId, binding.business_id).catch(() => null),
    getBusinessById(binding.business_id).catch(() => null),
  ]);
  if (!lead) { await answer(TOAST_LEAD_GONE); return; }
  if (!business) { await answer(GENERIC_NOT_FOUND); return; }
  const card = await cardFor({ lead, leadId });
  await together([
    answer(''),
    sendMessage(chatId, renderAlert({ business, lead, view: card.view, reviewResult: card.reviewResult }), card.kb),
  ]);
}

/**
 * L: — a number tap opens one lead INSIDE the list message: the same message
 * is edited to the detail, never a second one. The page travels in the
 * callback so Back can restore the exact list page. A lead that is gone
 * answers and refreshes the page, so no dead number button is left behind.
 */
async function handleDetailOpen({ cb, page, leadId, binding, answer, held = false }) {
  const chatId = cb.message && cb.message.chat && cb.message.chat.id;
  const messageId = cb.message && cb.message.message_id;
  // The lead (scoped by id AND business) and the business row both need only
  // the binding's business, so they are read together.
  const [lead, business] = await together([
    getClientLead(leadId, binding.business_id).catch(() => null),
    getBusinessById(binding.business_id).catch(() => null),
  ]);
  if (!lead) {
    await together([
      answer(TOAST_LEAD_GONE),
      sendLeadsPage(chatId, binding.business_id, page, messageId, null),
    ]);
    return;
  }
  if (!business) { await answer(GENERIC_NOT_FOUND); return; }
  const card = await cardFor({ lead, leadId });
  const text = renderAlert({ business, lead, view: card.view, reviewResult: card.reviewResult });
  const markup = leadDetailKeyboard(card.view, leadId, page, lead, held);
  const [, r] = await together([answer(''), editList(chatId, messageId, text, markup)]);
  // Too old to edit: send the detail as a new message rather than leaving a
  // dead number button on screen. Its Back edits the new message instead.
  if (!(r && r.ok)) await sendMessage(chatId, text, markup).catch(() => {});
}

/**
 * After a removal, redraw the removal list on the page the confirm came from.
 * If that page emptied (its last row was the one deleted), step back to the
 * newest page that still has rows, so the owner is never left staring at an
 * empty page.
 */
async function refreshRemovePage(chatId, businessId, page, messageId) {
  let p = Math.max(0, Math.min(LEADS_PAGE_MAX, Number(page) || 0));
  // Read the page itself rather than probing it and then reading it again:
  // the rows that prove the page is not empty are the rows that get drawn. A
  // read that fails is left for sendRemovePage to repeat, and to report.
  let rows = null;
  for (;;) {
    rows = await listClientLeads(businessId, REMOVE_PAGE + 1, p * REMOVE_PAGE).catch(() => null);
    if (p === 0 || rows === null || rows.length) break;
    p--;
  }
  return sendRemovePage(chatId, businessId, p, messageId, null, rows);
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
    const opList = CB_OP_LIST.exec(data);
    const opBusiness = CB_OP_BUSINESS.exec(data);
    const opLeads = CB_OP_LEADS.exec(data);
    const opLead = CB_OP_LEAD.exec(data);
    const opExtend = CB_OP_EXTEND.exec(data);
    if (opList || opBusiness || opLeads || opLead || opExtend) {
      setHandler(opList ? (opList[1] === 'bn' ? 'cb.operator_invite_page' : 'cb.operator_business_page')
        : opLeads ? 'cb.operator_leads_page'
          : opLead ? 'cb.operator_lead_open'
            : opExtend ? 'cb.operator_extend'
              : OP_BUSINESS_HANDLER_NAMES[opBusiness[1]]);
      // Operator-only BEFORE any data read, on every tap; a non-operator gets
      // the same answer as any unknown callback and nothing is read or written.
      if (!isOperatorChat(chatId, chatType)) { await answer(GENERIC_NOT_FOUND); return; }
      if (opList) {
        await sendOperatorList({ kind: opList[1] === 'bn' ? 'invite' : 'businesses', chatId, page: Number(opList[2]), messageId, answer });
        return;
      }
      if (opExtend) {
        await handleOperatorExtend({
          chatId, messageId, businessId: opExtend[2], page: clampBusinessPage(opExtend[1]), answer, token: opExtend[3],
        });
        return;
      }
      if (opBusiness) {
        const kind = opBusiness[1];
        const at = { chatId, messageId, businessId: opBusiness[3], page: clampBusinessPage(opBusiness[2]), answer };
        if (kind === 'bd') await sendBusinessDetail(at);
        else if (kind === 'bs' || kind === 'bS') await handleOperatorSuspend({ ...at, confirmed: kind === 'bS' });
        else if (kind === 'bx' || kind === 'bX') await handleOperatorTerminate({ ...at, confirmed: kind === 'bX' });
        else if (kind === 'br') await handleOperatorReactivate(at);
        else if (kind === 'bR') await handleOperatorReactivate({ ...at, confirmed: true });
        else if (kind === 'be') await handleOperatorExtend(at);
        else if (OP_INVITE_STEPS[kind]) {
          await operatorInviteStep({ ...at, from: OP_INVITE_STEPS[kind].from }, { step: OP_INVITE_STEPS[kind].step, businessId: at.businessId });
        }
        // bt / bT: the buttons of the retired Terminate, which deleted a
        // business. Nothing is ended: the tap says the screen expired and
        // the message becomes that business as it is now.
        else await sendBusinessDetail({ ...at, toast: OPERATOR_SCREEN_EXPIRED });
        return;
      }
      if (opLeads) {
        await handleOperatorLeadsPage({
          chatId, messageId, businessId: opLeads[3], leadPage: Number(opLeads[1]), page: clampBusinessPage(opLeads[2]), answer,
        });
        return;
      }
      const businessId = unpackUuid(opLead[3]);
      const leadId = unpackUuid(opLead[4]);
      if (!businessId || !leadId) { await answer(GENERIC_NOT_FOUND); return; }
      await handleOperatorLeadOpen({
        chatId, messageId, businessId, leadId, leadPage: Number(opLead[1]), page: clampBusinessPage(opLead[2]), answer,
      });
      return;
    }

    const pick = CB_OPERATOR_PICK.exec(data);
    if (pick) {
      // Operator-only BEFORE any data read; a non-operator gets the same answer
      // as any unknown callback.
      setHandler(pick[1] === 'pb' ? 'cb.operator_expired' : 'cb.operator_pick_code');
      if (!isOperatorChat(chatId, chatType)) { await answer(GENERIC_NOT_FOUND); return; }
      const at = { chatId, messageId, businessId: pick[2], page: 0, answer };
      // An old /phones picker button: that screen is gone. The tap says so
      // and the message becomes that business as it is now.
      if (pick[1] === 'pb') await sendBusinessDetail({ ...at, toast: OPERATOR_SCREEN_EXPIRED });
      // An old /code picker button is a pick from the /invite list: the same
      // rules, in the same message (Back leads to the first page of the list).
      else await operatorInviteStep({ ...at, from: 'list' }, { step: 'open', businessId: pick[2] });
      return;
    }

    const opPhone = CB_OPERATOR_PHONE.exec(data);
    if (opPhone) {
      // A non-operator tapping a forged p:/P:/q: gets the same answer as any
      // unknown callback, and nothing is read or written. For the operator
      // these are buttons of a screen that no longer exists: nothing is
      // removed, the tap says so and the message becomes the current list.
      setHandler('cb.operator_expired');
      if (!isOperatorChat(chatId, chatType)) { await answer(GENERIC_NOT_FOUND); return; }
      await sendBusinessPage(chatId, 0, messageId, answer, OPERATOR_SCREEN_EXPIRED);
      return;
    }

    if (!binding) { await answer(GENERIC_NOT_FOUND); return; }

    // A phone of a suspended or terminated business: one short toast for
    // every button, and nothing is read, shown or changed.
    if (bindingSuspended(binding)) {
      setHandler('cb.suspended');
      await answer(suspendedToast(binding.business_status));
      return;
    }

    if (CB_INVITE_CANCEL.test(data)) {
      setHandler('cb.invite_cancel');
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
      setHandler(rmPage ? 'cb.remove_page' : rmAsk ? 'cb.remove_ask' : rmDo ? 'cb.remove_confirm'
        : rmCancel ? 'cb.remove_cancel_legacy' : rmOpen ? 'cb.remove_ask_legacy' : 'cb.remove_confirm_legacy');
      // Owner only, before any read; the business is always the binding's.
      // This check is never run alongside the read it guards.
      if (!(await isOwnerChat(binding.business_id, chatId))) { await answer(TOAST_OWNER_ONLY); return; }
      const messageId = cb.message && cb.message.message_id;
      // Below, a toast goes out together with the edit that follows it, once
      // its text is known; neither waits for the other.
      if (rmPage) { return sendRemovePage(chatId, binding.business_id, Number(rmPage[1]), messageId, answer); }
      // The /remove_lead browser: a number tap asks, E: re-checks the row and the
      // binding (both re-read above and here), deletes, then refreshes that
      // page — stepping back if the deletion emptied it.
      if (rmAsk) {
        const leadId = rmAsk[2];
        const lead = await getClientLead(leadId, binding.business_id).catch(() => null);
        if (!lead) {
          await together([answer(REMOVE_LEAD_GONE), refreshRemovePage(chatId, binding.business_id, Number(rmAsk[1]), messageId)]);
          return;
        }
        await together([
          answer(''),
          editList(chatId, messageId, removeLeadConfirmText(lead), removeLeadConfirmKeyboard(leadId, Number(rmAsk[1]))),
        ]);
        return;
      }
      if (rmDo) {
        const leadId = rmDo[2];
        const lead = await getClientLead(leadId, binding.business_id).catch(() => null);
        if (!lead) {
          await together([answer(REMOVE_LEAD_GONE), refreshRemovePage(chatId, binding.business_id, Number(rmDo[1]), messageId)]);
          return;
        }
        const removed = await deleteLeadScoped(leadId, binding.business_id).catch(() => 0);
        // The name comes from the row read before the delete: after it there is
        // nothing left to name.
        await together([
          answer(removed ? removedText(lead) : REMOVE_LEAD_GONE),
          refreshRemovePage(chatId, binding.business_id, Number(rmDo[1]), messageId),
        ]);
        return;
      }
      const leadId = (rmOpen || rmDel || rmCancel)[1];
      if (rmCancel) {
        await together([answer(''), sendRemovePage(chatId, binding.business_id, 0, messageId)]);
        return;
      }
      const lead = await getClientLead(leadId, binding.business_id).catch(() => null);
      if (!lead) { await answer(REMOVE_LEAD_GONE); return; }
      if (rmOpen) {
        await together([
          answer(''),
          editMessageText(chatId, messageId, removeLeadConfirmText(lead), removeLeadConfirmKeyboard(leadId)).catch(() => {}),
        ]);
        return;
      }
      const removed = await deleteLeadScoped(leadId, binding.business_id).catch(() => 0);
      // The name comes from the row read before the delete: after it there is
      // nothing left to name.
      const done = removed ? removedText(lead) : REMOVE_LEAD_GONE;
      await together([answer(done), editList(chatId, messageId, done, { reply_markup: { inline_keyboard: [] } })]);
      return;
    }

    const page = CB_PAGE.exec(data);
    if (page) {
      setHandler('cb.leads_page');
      await sendLeadsPage(chatId, binding.business_id, Number(page[1]), messageId, answer);
      return;
    }

    // The held list (item A5): its pages and its detail Back never fall
    // through to the full /leads browser.
    const heldPage = CB_HELD_PAGE.exec(data) || CB_HELD_BACK.exec(data);
    if (heldPage) {
      setHandler('cb.held_page');
      await sendHeldLeadsPage(chatId, binding.business_id, Number(heldPage[1]), messageId, answer);
      return;
    }
    const heldOpen = CB_HELD_OPEN.exec(data);
    if (heldOpen) {
      setHandler('cb.held_open');
      await handleDetailOpen({ cb, page: Number(heldOpen[1]), leadId: heldOpen[2], binding, answer, held: true });
      return;
    }

    const recipient = CB_RECIPIENT.exec(data);
    if (recipient) {
      setHandler({ x: 'cb.recipient_ask', X: 'cb.recipient_remove', v: 'cb.recipient_cancel' }[recipient[1]]);
      await handleRecipientCallback({ cb, kind: recipient[1], rowId: recipient[2], binding, answer });
      return;
    }

    // L: — the /leads browser's number tap: the same message becomes the detail.
    const open = CB_LEAD_OPEN.exec(data);
    if (open) {
      setHandler('cb.lead_open');
      await handleDetailOpen({ cb, page: Number(open[1]), leadId: open[2], binding, answer });
      return;
    }

    // c/d/y/n/r on an alert message (today's behaviour, unchanged) and
    // C/D/Y/N/R on the browser detail (same handlers, page-aware keyboards).
    const m = CB_LEAD.exec(data);
    const md = CB_LEAD_DETAIL.exec(data);
    if (!m && !md) { setHandler('cb.unknown'); await answer(GENERIC_NOT_FOUND); return; }
    const kind = m ? m[1] : md[1].toLowerCase();
    const leadId = m ? m[2] : md[3];
    const surface = m ? 'alert' : 'detail';
    const detailPage = md ? Number(md[2]) : 0;

    // The handler name says which button and on which surface: the alert
    // message or the /leads detail. A fixed name per kind; never the lead.
    setHandler(`cb.${LEAD_HANDLER_NAMES[kind] || 'unknown'}.${surface}`);

    if (kind === 'o') { await handleOpenLead({ cb, leadId, binding, answer }); return; }

    // One read of the lead, scoped by id AND the binding's business, and one
    // of the business row. Neither needs the other, so they run together; the
    // outcomes are then judged in the order they used to be read, so a failed
    // or empty lead read is still what decides the answer first.
    const [leadRead, businessRead] = await together([
      settle(getClientLead(leadId, binding.business_id)),
      settle(getBusinessById(binding.business_id)),
    ]);
    if (leadRead.error) throw leadRead.error;
    const lead = leadRead.value;
    if (!lead) { await answer(GENERIC_NOT_FOUND); return; }
    if (businessRead.error) throw businessRead.error;
    const business = businessRead.value;
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

/** Timing-log names for the commands. A typed word that is not one of these
 *  is logged as 'text.plain', so the log can only ever hold these strings. */
const COMMAND_HANDLER_NAMES = {
  '/start': 'cmd.start', '/leads': 'cmd.leads', '/invite': 'cmd.invite', '/recipients': 'cmd.recipients',
  '/remove_lead': 'cmd.remove_lead', '/help': 'cmd.help', '/id': 'cmd.id', '/status': 'cmd.status',
};
/**
 * The operator chat's own commands, and nothing else: /businesses, /invite,
 * /help (and its alias /operator). /start and /id behave as in every chat.
 * Any other text in the operator chat, a retired command included (/code,
 * /phones, /recipients, /leads, /remove_lead), is answered with the one line
 * that points to /help.
 */
const OPERATOR_COMMAND_NAMES = {
  '/businesses': 'cmd.operator_businesses', '/invite': 'cmd.operator_invite',
  '/help': 'cmd.operator_help', '/operator': 'cmd.operator_help',
  '/start': 'cmd.start', '/id': 'cmd.id',
};
/**
 * Keyboard labels that the operator chat has carried. A press is not a typed
 * command: the old "Code" and "Phones" buttons keep opening what they opened
 * (the invite flow, the business list) although /code and /phones, typed, no
 * longer exist.
 */
const OPERATOR_PRESS_COMMANDS = { '/code': '/invite', '/phones': '/businesses' };

/**
 * One authenticated update from a private chat: resolve the binding, then
 * route a command, a keyboard press, free text, a button tap or a block.
 * Runs under the timing context, so every step below is measured.
 */
async function handleUpdate(u, chat) {
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
        setHandler('text.plain');
        await handlePlainText(chatId, binding, text);
        return;
      }
      first = first.slice(0, at);
    }
    const arg = pressed ? '' : text.slice(token.length).trim();
    // The role comes from the env, re-read on every message, never from a
    // binding and never from the text.
    const operator = isOperatorChat(chatId, chat.type);

    if (operator) {
      if (pressed && OPERATOR_PRESS_COMMANDS[first]) first = OPERATOR_PRESS_COMMANDS[first];
      // The command's own fixed name, or the fallback's: what was typed never
      // reaches the log.
      setHandler(OPERATOR_COMMAND_NAMES[first] || 'text.operator_fallback');
      if (first === '/businesses') await handleOperatorBusinesses(chatId);
      else if (first === '/invite') await handleOperatorInvite(chatId, arg);
      else if (first === '/help' || first === '/operator') await replyRole(chatId, OPERATOR_HELP, binding);
      else if (first === '/start') await handleStart(chatId, arg);
      else if (first === '/id') await replyMessage(chatId, operatorIdMessage(chatId, { operator: true }));
      // Everything else, the owner commands included: handlePlainText keeps
      // the code-shaped-text warnings and otherwise answers with the one line
      // that points to /help.
      else await handlePlainText(chatId, binding, text);
      return;
    }

    setHandler(COMMAND_HANDLER_NAMES[first] || 'text.plain');
    if (first === '/id') {
      // Every private chat, bound or not, operator or not: it is how the
      // operator learns OPERATOR_CHAT_ID without a third-party bot. Not in
      // the command menu. It shows the chat's own id and nothing else, so a
      // suspended business's phone still gets it.
      await replyMessage(chatId, operatorIdMessage(chatId, { operator: false }));
    } else if (first === '/status') {
      // Every bound phone, in service or not: the command a suspended or
      // terminated business keeps.
      await handleStatus(chatId, binding);
    } else if (first === '/start') {
      // Also kept when the business is off: /start says the phone is still
      // connected, it is not the suspended-state answer.
      await handleStart(chatId, arg);
    } else if (bindingSuspended(binding)) {
      // A phone of a suspended or terminated business: the same short answer
      // (state, reason, date, support link) for every other command, keyboard
      // press and free text, and no data. No per-chat cap: every message is
      // answered, as promised to the owner.
      const command = !!pressed || !!COMMAND_HANDLER_NAMES[first];
      setHandler(command ? 'cmd.suspended' : 'text.suspended');
      await replySuspended(chatId, binding);
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
    } else {
      // Not a command of this chat. The operator's commands are not commands
      // at all here, so they get exactly what any unknown text gets.
      await handlePlainText(chatId, binding, text);
    }
  } else if (u.callback_query) {
    setHandler('cb.unknown');
    await handleCallback(u.callback_query, binding);
  } else if (u.my_chat_member) {
    setHandler('member.status');
    await handleChatMember(u.my_chat_member);
  } else {
    setHandler('message.other');
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
    // my_chat_member carries the chat at the top level, not inside a message.
    const chat = (msg && msg.chat) || (u.my_chat_member && u.my_chat_member.chat);
    if (!chat || chat.type !== 'private') return res.status(200).json({ ok: true });
    // One "[tg-timing]" line per update from here on: the handler name, the
    // cold-start flag, the region, and how long each step took. No PII.
    await runTimed(u.callback_query ? 'callback' : (u.my_chat_member ? 'member' : 'message'), () => handleUpdate(u, chat));
  } catch (e) {
    console.error('tg_update_failed', (e && e.code) || 'no_code');
  }
  return res.status(200).json({ ok: true });
}
