// lib/notice-audit.js — the daily check that no owner notice vanished.
//
// Every notice round writes one business_events row BEFORE anything is sent
// ('expected') and its outcomes after the sends ('sent', 'failed' or
// 'skipped'; lib/lifecycle-notify.js). A send that fails alerts the operator
// at once. What that cannot catch is a round that never finished: the
// function was killed half way, or the outcome rows could not be written.
// Such a round leaves an 'expected' row with nothing after it, and this
// module finds those rows once a day (api/selfcheck.js, after the billing
// job) and tells the operator: business name and notice type, nothing else.
//
// It reads fixed words only (no text, no address, no chat id is ever in the
// table), writes nothing but its own once-a-day claim, and never throws.

import * as dbApi from './db.js';
import { deliverOperatorAlarm } from './operator-alarm.js';
import { noticeWord } from './lifecycle-text.js';

const HOUR = 3600000;
/** How far back the daily run looks: a day and a margin, so a round is seen
 *  by exactly the run after it, whatever minute the cron fires. */
export const AUDIT_WINDOW_MS = 26 * HOUR;
/** A round younger than this may still be sending: it is left for tomorrow. */
export const AUDIT_SETTLE_MS = 10 * 60000;

/**
 * PURE. `events` are business_events rows, oldest first. Returns one entry
 * per round that has an 'expected' row and no outcome: the next row of the
 * same business and type is another 'expected', or there is none.
 * [{ businessId, type, at }]
 */
export function missingOutcomes(events, nowMs = Date.now()) {
  const open = new Map(); // "<business>|<type>" -> the 'expected' row waiting for an outcome
  const missing = [];
  for (const e of events || []) {
    if (!e || !e.business_id || !e.type) continue;
    const key = `${e.business_id}|${e.type}`;
    if (e.status === 'expected') {
      if (open.has(key)) missing.push(open.get(key));
      open.set(key, e);
    } else {
      open.delete(key);
    }
  }
  for (const e of open.values()) {
    if (nowMs - Date.parse(e.created_at) >= AUDIT_SETTLE_MS) missing.push(e);
  }
  return missing
    .map((e) => ({ businessId: e.business_id, type: e.type, at: e.created_at }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/** PURE. The operator's message: names and notice types only. */
export function noticeAuditText(items) {
  const lines = ['Owner notices with no recorded outcome', ''];
  for (const it of items.slice(0, 20)) lines.push(`${it.name}: ${noticeWord(it.type)}${it.count > 1 ? ` (${it.count})` : ''}`);
  if (items.length > 20) lines.push(`and ${items.length - 20} more`);
  lines.push('', 'Check that each business was told.');
  return lines.join('\n');
}

export const AUDIT_IO = {
  listBusinessEventsSince: dbApi.listBusinessEventsSince,
  getBusinessById: dbApi.getBusinessById,
  hitRateLimit: dbApi.hitRateLimit,
  clearRateLimit: dbApi.clearRateLimit,
};

/**
 * Returns { ok, rounds, missing, operator } or { ok, skipped: 'unavailable' }
 * on a database without the table. `operator` is 'none' (nothing to say, or
 * already said today), 'telegram', 'email' or 'undelivered'.
 */
export async function auditOwnerNotices({ now = Date.now() } = {}, io = AUDIT_IO) {
  let events;
  try { events = await io.listBusinessEventsSince(new Date(now - AUDIT_WINDOW_MS).toISOString()); } catch { return { ok: false, rounds: 0, missing: 0, operator: 'none' }; }
  if (events === null) return { ok: true, skipped: 'unavailable' };
  const rounds = events.filter((e) => e.status === 'expected').length;
  const missing = missingOutcomes(events, now);
  if (!missing.length) return { ok: true, rounds, missing: 0, operator: 'none' };

  const dateKey = new Date(now).toISOString().slice(0, 10);
  // Once a day, however often the check is called.
  let first = true;
  const claim = 'ops:notice-audit';
  try { first = await io.hitRateLimit(claim, 86400, 1); } catch { first = true; }
  if (!first) return { ok: true, rounds, missing: missing.length, operator: 'none' };

  const grouped = new Map();
  for (const m of missing) {
    const key = `${m.businessId}|${m.type}`;
    const g = grouped.get(key) || { businessId: m.businessId, type: m.type, count: 0 };
    g.count += 1;
    grouped.set(key, g);
  }
  const items = [];
  for (const g of grouped.values()) {
    let name = 'A business';
    try {
      const b = await io.getBusinessById(g.businessId);
      if (b) name = String(b.name || b.slug || name).replace(/\s+/g, ' ').trim();
    } catch { /* the name is a convenience; the alert still goes out */ }
    items.push({ ...g, name });
  }
  const text = noticeAuditText(items);
  let operator = 'undelivered';
  try { operator = await deliverOperatorAlarm({ body: text, text, dateKey, keyPrefix: 'notice-audit' }, io); } catch { operator = 'undelivered'; }
  // Nobody heard: let the next run say it.
  if (operator === 'undelivered' && io.clearRateLimit) { try { await io.clearRateLimit(claim); } catch { /* next day */ } }
  return { ok: true, rounds, missing: missing.length, operator };
}
