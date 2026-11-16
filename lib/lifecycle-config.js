// lib/lifecycle-config.js — every lifecycle duration, in ONE place.
//
// PURE: no database, no network. The billing rules (lib/billing.js), the daily
// job (lib/billing-ops.js), the operator screens, the owner bot, the emails
// and the docs all read these values; nothing else in the repository may
// state a lifecycle duration or the support address as a literal
// (Gate BL, check BL1d in tests/billing.test.mjs, scans for that).
//
// D is businesses.paid_until (UTC). NULL means "not billing-enforced".
//
//   paid         now <  D - RENEWAL_REMINDER_DAYS
//   due_soon     D - RENEWAL_REMINDER_DAYS <= now < D
//   grace        D <= now < D + GRACE_DAYS                 everything works
//   suspended    D + GRACE_DAYS <= now < D + GRACE_DAYS + SUSPENDED_DAYS
//   terminated   now >= D + GRACE_DAYS + SUSPENDED_DAYS

/** The renewal reminder goes out this many days before paid_until. */
export const RENEWAL_REMINDER_DAYS = 3;
/** Days of full service after paid_until before the business is suspended. */
export const GRACE_DAYS = 5;
/** Days a business stays suspended before it is terminated. */
export const SUSPENDED_DAYS = 10;
/** paid_until + this many days = termination (D + 15 d with the values above). */
export const TERMINATE_AFTER_DAYS = GRACE_DAYS + SUSPENDED_DAYS;
/** How long a terminated business's data is kept. DOCUMENTED ONLY: nothing in
 *  the code deletes data, and there is no purge job. */
export const RETENTION_DAYS = 60;
/** What one recorded payment ("Extend 30 days") adds. */
export const EXTEND_DAYS = 30;

/** The final warning goes out when this much of the grace period is left
 *  (D + GRACE_DAYS - 1 d), the termination warning when this much of the
 *  suspended period has passed (D + GRACE_DAYS + 5 d = D + 10 d). */
export const FINAL_WARNING_DAYS_BEFORE = 1;
export const TERMINATION_WARNING_DAYS_BEFORE = 5;
/** A daily cron fires anywhere inside its hour. A run that comes a few
 *  minutes "early" must not skip a warning that is due that day, so a WARNING
 *  may go out up to this long before its exact moment. A suspension or a
 *  termination never happens early: those follow the exact boundary. */
export const NOTICE_JITTER_MS = 3600000;

/** Held leads: a suspended business's phones get one short Telegram notice
 *  per held lead, but never more than this many per business per hour (the
 *  form's own limit is 200 an hour; Telegram's is about one message a second
 *  per chat). The owner address gets at most ONE held-leads email per UTC day. */
export const HELD_NOTICES_PER_HOUR = 20;

/** Where "Contact support" leads. The ONLY place this address is written. */
export const SUPPORT_TELEGRAM_URL = 'https://t.me/AbdallahIsDev';
/** The words that carry the link in a Telegram message (a text_link entity). */
export const SUPPORT_LINK_LABEL = 'Contact support';

/** Reply-To of every owner billing / lifecycle email: the operator address
 *  that is already configured (OPERATOR_EMAIL). null when it is not set; the
 *  email then goes out without a Reply-To header. Read at call time, never
 *  cached, never logged. */
export function supportEmail(env = process.env) {
  const v = String((env && env.OPERATOR_EMAIL) || '').trim();
  return v || null;
}
