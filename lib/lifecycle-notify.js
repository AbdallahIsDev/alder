// lib/lifecycle-notify.js — the ONE way a lifecycle notice reaches a business.
//
// Every owner-facing billing / suspension / termination / reactivation /
// held-lead notice goes through sendOwnerNotice(): Telegram to every bound
// phone and one email to the owner address. It goes out whatever the
// business's status is (a suspended business must still be told it is about
// to be terminated). Around the sends it does the three things that keep a
// notice from failing silently:
//
//   1. the log    one business_events row when the round starts ('expected',
//                 written BEFORE anything is sent, so a round that died
//                 half way leaves a trace), then one row per attempt ('sent'
//                 / 'failed' with a fixed error class) or one 'skipped' row
//                 when there was nobody to send to, in a single insert. No
//                 text, no address, no chat id is ever written.
//   2. the alert  any failed send alerts the operator (business name, notice
//                 type, channel, error class; no personal data), at most once
//                 per business per notice type per UTC day.
//   3. the answer { phones, phonesOk, email, delivered, nobody, failures } so
//                 the caller can decide whether the notice counts as sent.
//
// No I/O of its own: every call is a member of `io` (the webhook passes its
// timed wrappers, the job the plain functions, a test fakes).
//
//   io.sendMessage(chatId, text, extra)                    -> { ok, status }
//   io.sendLifecycleEmail({ business, subject, text, key }) -> { ok, status, id }
//   io.addBusinessEvent(row | rows)                        -> boolean (never throws)
//   io.hitRateLimit(key, windowSeconds, max)               -> boolean
//   io.sendMail(...)                                       (operator alarm fallback)

import { deliverOperatorAlarm } from './operator-alarm.js';
import { noticeFailureAlert } from './lifecycle-text.js';

const settle = (promise) => Promise.resolve(promise).then((value) => ({ value }), (error) => ({ error }));
/** Whether a send reached its service and was accepted. */
export const sendFailed = (r) => !!(r.error || !(r.value && r.value.ok));

/** A send's outcome as a fixed word: an HTTP status ("http_403"), one of the
 *  sender's own status words ("timeout", "missing_env"), or "exception". */
export function errorClassOf(r) {
  if (r.error) return 'exception';
  const status = r.value && r.value.status;
  if (typeof status === 'number') return `http_${status}`;
  const word = String(status || 'unknown').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40);
  return word || 'unknown';
}

async function log(io, row) {
  if (!io.addBusinessEvent) return;
  try { await io.addBusinessEvent(row); } catch { console.error('business_event_failed', 'threw'); }
}

/**
 * Send one notice. `rows` are the business's bound phones (oldest first);
 * `keyboard(row, index)` may return a reply_markup for that phone.
 * `instance` identifies THIS occurrence of the event (a transition timestamp,
 * or the paid period plus the day): it is part of the email's idempotency
 * key, so the same event is never mailed twice and a second suspension on
 * the same day still is. `email: false` sends Telegram only. `unreadable`
 * says the phone list could not be read (rows is then empty).
 */
export async function sendOwnerNotice(io, { business, rows = [], notice, instance, keyboard = null, email = true, dateKey = null, unreadable = false }) {
  const type = notice.type;
  const businessId = business.id;
  await log(io, { businessId, type, channel: 'none', status: 'expected' });

  const wantsEmail = !!(email && notice.email && business.owner_email);
  const [sent, mail] = await Promise.all([
    Promise.all(rows.map((r, i) => {
      const markup = keyboard ? keyboard(r, i) : null;
      let call;
      try {
        call = io.sendMessage(r.tg_chat_id, notice.telegram.text, {
          entities: notice.telegram.entities,
          ...(markup ? { reply_markup: markup } : {}),
        });
      } catch (e) { call = Promise.reject(e); }
      return settle(call);
    })),
    wantsEmail
      ? settle((async () => io.sendLifecycleEmail({
        business, subject: notice.email.subject, text: notice.email.text, key: `${type}:${businessId}:${instance}`,
      }))())
      : null,
  ]);

  // The outcome of every attempt, written in ONE insert after the sends.
  const outcome = [];
  const failures = [];
  // The phone list could not be read: no phone was told, and that is a
  // failed delivery like any other (logged, counted, alerted).
  if (unreadable) {
    failures.push({ channel: 'telegram', errorClass: 'phones_unreadable' });
    outcome.push({ businessId, type, channel: 'telegram', status: 'failed', errorClass: 'phones_unreadable' });
  }
  for (const r of sent) {
    const failed = sendFailed(r);
    const errorClass = failed ? errorClassOf(r) : null;
    if (failed) failures.push({ channel: 'telegram', errorClass });
    outcome.push({ businessId, type, channel: 'telegram', status: failed ? 'failed' : 'sent', errorClass });
  }
  let emailResult = 'none';
  if (mail) {
    const failed = sendFailed(mail);
    emailResult = failed ? 'failed' : 'sent';
    const errorClass = failed ? errorClassOf(mail) : null;
    if (failed) failures.push({ channel: 'email', errorClass });
    outcome.push({
      businessId, type, channel: 'email', status: emailResult, errorClass,
      providerId: !failed && mail.value && mail.value.id ? mail.value.id : null,
    });
  }
  const phonesOk = sent.filter((r) => !sendFailed(r)).length;
  const nobody = rows.length === 0 && !mail && !unreadable;
  if (nobody) outcome.push({ businessId, type, channel: 'none', status: 'skipped', errorClass: 'no_recipient' });
  await log(io, outcome);

  let alerted = false;
  if (failures.length) alerted = await alertOperator(io, { business, type, failures, dateKey });

  return {
    type, phones: rows.length, phonesOk, phonesFailed: rows.length - phonesOk,
    email: emailResult, delivered: phonesOk > 0 || emailResult === 'sent', nobody, failures, alerted,
  };
}

/** At most one alert per business per notice type per UTC day. The claim
 *  fails OPEN: an alert sent twice is better than a failure nobody saw. */
export async function alertOperator(io, { business, type, failures, dateKey = null }) {
  let first = true;
  try { first = await io.hitRateLimit(`ops:notice:${business.id}:${type}`, 86400, 1); } catch { first = true; }
  if (!first) return false;
  const text = noticeFailureAlert({ business, type, failures });
  const day = dateKey || new Date().toISOString().slice(0, 10);
  try {
    const how = await deliverOperatorAlarm({ body: text, text, dateKey: day, keyPrefix: `notice:${type}:${business.id}` }, io);
    return how !== 'undelivered';
  } catch {
    console.error('notice_alert_failed');
    return false;
  }
}
