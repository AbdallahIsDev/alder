// lib/held-leads.js — what happens after a lead is stored for a SUSPENDED
// business (api/lead.js, hold mode).
//
// The lead itself is already in the database with leads.held_at set. Nothing
// about it leaves the system: no owner email with its details, no Telegram
// alert with its details, no customer auto-reply. What the business gets is:
//
//   - ONE short Telegram message per held lead to every bound phone, with no
//     personal data ("A new lead just submitted your form..."), capped at
//     HELD_NOTICES_PER_HOUR per business so a busy form cannot flood a chat;
//   - at most ONE email per business per UTC day to the owner address, which
//     carries a COUNT and nothing else.
//
// Both go through lib/lifecycle-notify.js, so every attempt is logged and a
// failure alerts the operator. Nothing here throws and nothing here can
// change the HTTP response.

import * as dbApi from './db.js';
import { sendMessage } from './tg.js';
import { sendMail } from './mail.js';
import { sendLifecycleEmail } from './notify.js';
import { sendOwnerNotice } from './lifecycle-notify.js';
import { ownerNotice } from './lifecycle-text.js';
import { heldLeadCount, suspendedKeyboard } from './service-status.js';
import { HELD_NOTICES_PER_HOUR } from './lifecycle-config.js';

export const HELD_IO = {
  getBusinessById: dbApi.getBusinessById,
  listBusinessChatsDetailed: dbApi.listBusinessChatsDetailed,
  countHeldLeads: dbApi.countHeldLeads,
  lastBusinessEventAt: dbApi.lastBusinessEventAt,
  addBusinessEvent: dbApi.addBusinessEvent,
  hitRateLimit: dbApi.hitRateLimit,
  sendMessage,
  sendMail,
  sendLifecycleEmail,
};

/** Returns { telegram, email }: each 'sent' | 'limited' | 'failed' | 'none'. */
export async function announceHeldLead({ business, now = Date.now() }, io = HELD_IO) {
  const out = { telegram: 'none', email: 'none' };
  const dateKey = new Date(now).toISOString().slice(0, 10);
  // The tenant row carries no billing columns; the words of the notice (why
  // the service is suspended) and the held count (since when) need them.
  let full = business;
  try { full = (await io.getBusinessById(business.id)) || business; } catch { full = business; }
  full = { ...full, owner_email: business.owner_email };
  try {
    // Fails CLOSED: when the counter cannot be read, no message is sent. The
    // lead is safe in the database either way, and /status shows the count.
    let within = false;
    try { within = await io.hitRateLimit(`held:tg:${business.id}`, 3600, HELD_NOTICES_PER_HOUR); } catch { within = false; }
    if (!within) {
      out.telegram = 'limited';
    } else {
      const rows = await io.listBusinessChatsDetailed(business.id);
      if (rows.length) {
        const r = await sendOwnerNotice(io, {
          business: full, rows, notice: ownerNotice('held_lead', { business: full, now }), instance: now, email: false, dateKey,
          keyboard: suspendedKeyboard,
        });
        out.telegram = r.phonesOk > 0 ? 'sent' : 'failed';
      }
    }
  } catch (e) {
    console.error('held_notice_failed', (e && e.code) || 'no_code');
    out.telegram = 'failed';
  }

  try {
    if (!business.owner_email) return out;
    let first = false;
    try { first = await io.hitRateLimit(`held:mail:${business.id}`, 86400, 1); } catch { first = false; }
    if (!first) { out.email = 'limited'; return out; }
    const held = (await heldLeadCount(full, io)) || 1;
    const r = await sendOwnerNotice(io, {
      business: full, rows: [],
      notice: ownerNotice('held_summary', { business: full, now, held }), instance: dateKey, dateKey,
    });
    out.email = r.email === 'sent' ? 'sent' : 'failed';
  } catch (e) {
    console.error('held_email_failed', (e && e.code) || 'no_code');
    out.email = 'failed';
  }
  return out;
}
