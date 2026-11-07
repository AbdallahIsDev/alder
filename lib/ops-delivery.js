// lib/ops-delivery.js — one delivery path for the scheduled ops messages.
//
// /api/selfcheck and /api/digest both talk to a set of businesses: Telegram
// first, and the same text by email when a business has no bound chat or none of
// its sends landed. The email is a fallback, never a second copy, so a business
// that received the Telegram message gets no email.
//
// The senders are parameters, so both the real handler path and the tests drive
// exactly the same loop. `text` is one body for every target; `textFor` is for
// callers whose message differs per business (the counts differ).
//
// One recipient, one message per run. Two businesses can share an owner email
// (the operator's own test rows do), and a person who owns both should not get
// the same alarm twice. The caller passes `mailKeyFor` so this loop can tell
// that two targets are the same inbox; chats are deduped on their own id.
// Deduplication only suppresses a send that WOULD have succeeded: if the first
// attempt for an inbox failed, the next target for that inbox is still tried,
// because a person with no message is worse than a person with two.

export async function deliverToBusinesses({ targets, text, textFor, chatsFor, sendTg, sendMailFor, mailKeyFor }) {
  let sent = 0;
  let emailed = 0;
  let deduped = 0;
  const perTarget = new Map();
  const seenChats = new Set();
  const seenMail = new Set();

  for (const target of targets) {
    const body = textFor ? textFor(target) : text;
    // chatsFor may be sync (a prebuilt map) or async (a query); Promise.resolve
    // covers both, and a throw becomes an empty list.
    const chats = await Promise.resolve().then(() => chatsFor(target)).catch(() => []);
    let delivered = 0;
    for (const chat of chats) {
      if (seenChats.has(chat)) { deduped++; continue; }
      seenChats.add(chat);
      const r = await sendTg(chat, body).catch(() => ({ ok: false }));
      if (r && r.ok) delivered++;
    }
    sent += delivered;
    let mailed = 0;
    if (chats.length === 0 || delivered === 0) {
      const key = mailKeyFor
        ? await Promise.resolve().then(() => mailKeyFor(target)).catch(() => null)
        : null;
      if (key && seenMail.has(key)) {
        deduped++;
      } else {
        const r = await sendMailFor(target, body).catch(() => ({ ok: false }));
        if (r && r.ok) {
          emailed++;
          mailed = 1;
          if (key) seenMail.add(key);
        }
      }
    }
    // Per-target counts, so a caller can tell "nobody heard this one" from "the
    // total happened to be zero".
    perTarget.set(target, { sent: delivered, emailed: mailed });
  }
  return { sent, emailed, deduped, perTarget };
}
