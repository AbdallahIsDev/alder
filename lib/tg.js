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

/* Webhook management lives here so the token is never formatted in a script. */
export async function setWebhook(url, secretToken) {
  return call('setWebhook', {
    url,
    secret_token: secretToken,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
}

export async function getWebhookInfo() {
  return call('getWebhookInfo', {}, { parse: 'result' });
}

export async function deleteWebhook() {
  return call('deleteWebhook', { drop_pending_updates: true });
}

export async function setMyCommands(commands) {
  return call('setMyCommands', { commands });
}

export async function getMyCommands() {
  return call('getMyCommands', {}, { parse: 'result' });
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
