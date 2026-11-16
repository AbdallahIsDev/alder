// lib/operator-alarm.js — the one way a scheduled job tells the operator.
//
// Telegram to the operator chat first; if that is not accepted, an email to
// the operator address; if neither, one loud log line. It never throws, and
// it answers which of the three happened, so the caller can release a claim
// when nobody heard. The daily self-check and the daily billing job both use
// it, so "the operator alert channel" is one piece of code.

import { sendMessage } from './tg.js';
import { sendMail } from './mail.js';
import { operatorAlarmEmail } from './email-builders.js';
import { operatorChatId, operatorEmail } from './operator.js';

/**
 * `text` goes to Telegram, `body` into the email (the same words unless the
 * caller formats them differently). `keyPrefix` and the UTC `dateKey` make
 * the email's idempotency key, so each job mails the operator at most once a
 * day. `io` lets a caller pass its own senders.
 * Returns 'telegram' | 'email' | 'undelivered'.
 */
export async function deliverOperatorAlarm({ body, text, dateKey, keyPrefix = 'selfcheck' }, io = {}) {
  const send = io.sendMessage || sendMessage;
  const mail = io.sendMail || sendMail;
  const chat = operatorChatId();
  if (chat) {
    const r = await send(chat, text).catch(() => ({ ok: false }));
    if (r && r.ok) return 'telegram';
  }
  const to = operatorEmail();
  if (to) {
    const r = await mail({
      to, fromName: 'Lead Alerts', ...operatorAlarmEmail(body, dateKey),
      idempotencyKey: `${keyPrefix}:operator:${dateKey}`,
    }).catch(() => ({ ok: false }));
    if (r && r.ok) return 'email';
  }
  console.error('operator_alarm_undelivered');
  return 'undelivered';
}
