// lib/owner-mail-failure.js — one way a scheduled owner email stops being silent.
//
// /api/selfcheck and /api/digest email the owner when no bound phone heard the
// message. A Resend failure used to leave only an `emailed: 0` counter on a 200
// response. This module writes the same business_events rows a lifecycle notice
// writes, then alerts the operator at most once per business/type/UTC day. If
// the alert itself cannot be delivered the claim is released so the next run can
// try again. Fixed words only: no address, name, chat id or message body is
// written to the event table.

import { addBusinessEvent, hitRateLimit, clearRateLimit } from './db.js';
import { deliverOperatorAlarm } from './operator-alarm.js';
import { noticeFailureAlert } from './lifecycle-text.js';

/** Fixed error class from a mail result: an HTTP status or a sender status word. */
export function ownerMailErrorClass(result) {
  const status = result && result.status;
  if (typeof status === 'number') return `http_${status}`;
  const word = String(status || 'unknown').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40);
  return word || 'unknown';
}

/** The `expected` row is written before the send, exactly as lifecycle notices do. */
export async function logOwnerMailExpected(businessId, type, io = {}) {
  const add = io.addBusinessEvent || addBusinessEvent;
  try { await add({ businessId, type, channel: 'email', status: 'expected' }); } catch { /* never throws */ }
}

/** A successful send closes the expected row; a failed one is closed by
 *  reportOwnerMailFailure. Without this, the daily audit would report a
 *  perfectly delivered cron email as missing. */
export async function logOwnerMailOutcome(businessId, type, result, io = {}) {
  const add = io.addBusinessEvent || addBusinessEvent;
  try {
    await add({
      businessId, type, channel: 'email', status: 'sent',
      providerId: result && result.id ? result.id : null,
    });
  } catch { /* never throws */ }
}

/**
 * Log a failed owner email and alert the operator. Returns true only when the
 * alert was delivered; a deduped alert counts as handled.
 */
export async function reportOwnerMailFailure({ business, type, result, dateKey = new Date().toISOString().slice(0, 10), io = {} }) {
  const errorClass = ownerMailErrorClass(result);
  const add = io.addBusinessEvent || addBusinessEvent;
  try { await add({ businessId: business.id, type, channel: 'email', status: 'failed', errorClass }); } catch { /* never throws */ }

  const hit = io.hitRateLimit || hitRateLimit;
  const clear = io.clearRateLimit || clearRateLimit;
  const key = `ops:notice:${business.id}:${type}`;
  let first = true;
  try { first = await hit(key, 86400, 1); } catch { first = true; }
  if (!first) return false;

  const text = noticeFailureAlert({ business, type, failures: [{ channel: 'email', errorClass }] });
  let how = 'undelivered';
  try {
    how = await deliverOperatorAlarm({ body: text, text, dateKey, keyPrefix: `notice:${type}:${business.id}` }, io);
  } catch { how = 'undelivered'; }
  if (how === 'undelivered') {
    try { await clear(key); } catch { /* next run may try again */ }
    return false;
  }
  return true;
}
