// lib/ops-delivery.js — one delivery path for the scheduled ops messages.
//
// /api/selfcheck and /api/digest both talk to a set of businesses: Telegram
// first, and the same text by email when a business has no bound chat or none of
// its sends landed. The email is a fallback, never a second copy, so a business
// that received the Telegram message gets no email.
//
// The senders are parameters, so both the real handler path and the tests drive
// exactly the same loop. `text` is one body for every target; `textFor` is for
// callers whose message differs per business (the digest counts differ).

export async function deliverToBusinesses({ targets, text, textFor, chatsFor, sendTg, sendMailFor }) {
  let sent = 0;
  let emailed = 0;
  const perTarget = new Map();
  for (const target of targets) {
    const body = textFor ? textFor(target) : text;
    // chatsFor may be sync (a prebuilt map) or async (a query); Promise.resolve
    // covers both, and a throw becomes an empty list.
    const chats = await Promise.resolve().then(() => chatsFor(target)).catch(() => []);
    let delivered = 0;
    for (const chat of chats) {
      const r = await sendTg(chat, body).catch(() => ({ ok: false }));
      if (r && r.ok) delivered++;
    }
    sent += delivered;
    let mailed = 0;
    if (chats.length === 0 || delivered === 0) {
      const r = await sendMailFor(target, body).catch(() => ({ ok: false }));
      if (r && r.ok) { emailed++; mailed = 1; }
    }
    // Per-target counts, so a caller can tell "nobody heard this one" from "the
    // total happened to be zero".
    perTarget.set(target, { sent: delivered, emailed: mailed });
  }
  return { sent, emailed, perTarget };
}
