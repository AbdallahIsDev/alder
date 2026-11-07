// lib/tg.js — Telegram Bot API, plain text only.
//
// Every call goes through lib/outbound.js: 3000 ms timeout, status-only results,
// dev-only base override, and the .test-mode interlock. Nothing in this file logs
// a URL, a token, an error object or a response body.

import { baseFor, blockedByInterlock, postJson } from './outbound.js';

const REAL_BASE = 'https://api.telegram.org';

function base() {
  return baseFor('TELEGRAM_API_BASE', REAL_BASE);
}

function guard() {
  if (blockedByInterlock('TELEGRAM_API_BASE')) return { ok: false, status: 'blocked_test_mode' };
  if (!process.env.TELEGRAM_BOT_TOKEN) return { ok: false, status: 'missing_env' };
  return null;
}

/** Generic Bot API call. `method` is a fixed string chosen by the caller, never user input. */
async function call(method, payload, opts) {
  const g = guard();
  if (g) return g;
  const url = base() + '/bot' + process.env.TELEGRAM_BOT_TOKEN + '/' + method;
  return postJson(url, payload || {}, opts);
}

/**
 * Send one plain-text message. `extra` may carry reply_markup; parse_mode is never set.
 * Callers that pass a keyboard must retry once without it on a 400.
 */
export async function sendMessage(chatId, text, extra) {
  return call('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(extra || {}),
  });
}

export async function answerCallbackQuery(callbackQueryId, text) {
  return call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
}

export async function editMessageText(chatId, messageId, text, extra) {
  return call('editMessageText', {
    chat_id: chatId, message_id: messageId, text,
    ...(extra || {}),
  });
}

export async function editMessageReplyMarkup(chatId, messageId, replyMarkup) {
  return call('editMessageReplyMarkup', {
    chat_id: chatId, message_id: messageId,
    reply_markup: replyMarkup || { inline_keyboard: [] },
  });
}

export async function getMe() {
  return call('getMe', {}, { parse: 'result' });
}

/**
 * The bot's own @username, for t.me deep links.
 *
 * No new secret: getMe() is authenticated by the token we already have. The
 * answer is cached for the life of the instance, because a warm lambda handles
 * many invites and the username cannot change while the token stays the same.
 * A FAILURE is deliberately not cached — the next invocation gets a fresh try —
 * and it is never fatal: the invite falls back to /start plus the code, and
 * `bot_username_unavailable` is logged as a fixed event name.
 *
 * TELEGRAM_BOT_USERNAME overrides the lookup. It exists for local runs and for
 * the day getMe is rate limited, not as a required variable.
 */
let cachedUsername = null;

export async function botUsername() {
  const override = String(process.env.TELEGRAM_BOT_USERNAME || '').trim().replace(/^@/, '');
  if (override) return override;
  if (cachedUsername) return cachedUsername;
  try {
    const r = await getMe();
    const name = r && r.ok && r.result && r.result.username;
    if (typeof name === 'string' && /^[A-Za-z0-9_]{3,64}$/.test(name)) {
      cachedUsername = name;
      return name;
    }
  } catch { /* fall through to the log line */ }
  console.error('bot_username_unavailable');
  return null;
}

/* Webhook management lives here so the token is never formatted in a script. */
export async function setWebhook(url, secretToken) {
  return call('setWebhook', {
    url,
    secret_token: secretToken,
    allowed_updates: ['message', 'callback_query', 'my_chat_member'],
    drop_pending_updates: true,
  });
}

export async function getWebhookInfo() {
  return call('getWebhookInfo', {}, { parse: 'result' });
}

export async function deleteWebhook() {
  return call('deleteWebhook', { drop_pending_updates: true });
}

/** `extra` carries a scope, e.g. { scope: { type: 'chat', chat_id: 123 } }. */
export async function setMyCommands(commands, extra) {
  return call('setMyCommands', { commands, ...(extra || {}) });
}

export async function getMyCommands(extra) {
  return call('getMyCommands', { ...(extra || {}) }, { parse: 'result' });
}

export async function setMyDescription(description) {
  return call('setMyDescription', { description });
}

export async function getMyDescription() {
  return call('getMyDescription', {}, { parse: 'result' });
}

export async function setMyShortDescription(shortDescription) {
  return call('setMyShortDescription', { short_description: shortDescription });
}

export async function getMyShortDescription() {
  return call('getMyShortDescription', {}, { parse: 'result' });
}

/** Only the live smoke uses this: it is allowed to print Telegram's error description. */
export async function sendMessageWithDescription(chatId, text, extra) {
  const g = guard();
  if (g) return g;
  const url = base() + '/bot' + process.env.TELEGRAM_BOT_TOKEN + '/sendMessage';
  return postJson(url, { chat_id: chatId, text, disable_web_page_preview: true, ...(extra || {}) }, { parse: 'description' });
}
