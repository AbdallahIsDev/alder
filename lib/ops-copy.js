// lib/ops-copy.js — the words the scheduled operations messages use.
//
// Pure functions: no database, no environment, no network. That is what makes
// them testable, and what lets both the Telegram body and the email body come
// from one place instead of drifting apart.
//
// House rules for this copy, learned the hard way in production:
//   - no internal names (tg_sent, email_owner_failed, autoreply_failed)
//   - no abbreviations, no underscores, no event names
//   - an emoji is never the whole message: it decorates words that stand alone
//   - counts only: no lead name, phone, email, note, or business name
//   - operator-only detail (the redirect warning, a setting name) is a separate
//     block that only a demo business ever receives

/** Kinds that mean "something we tried to send did not go out". */
export const FAILED_KINDS = ['tg_failed', 'email_owner_failed', 'autoreply_failed', 'review_request_failed'];

export const SELFCHECK_TITLE = '🔎 Alert check';
export const SELFCHECK_SUBTITLE = 'Last 24 hours';
export const DIGEST_TITLE = '📋 Your lead summary';
export const DIGEST_SUBTITLE = 'Last 24 hours';

/** The failure total for one business's day. */
export function failedTotal(day) {
  return FAILED_KINDS.reduce((a, k) => a + ((day && day[k]) || 0), 0);
}

/** "1 alert" / "3 alerts" without a bare "1 alerts". */
function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * One line per kind that actually failed, in the order an owner would care
 * about: the alert itself first, then the customer-facing mail.
 */
export function failureLines(day) {
  const lines = [];
  if (day && day.tg_failed) lines.push(`❌ ${plural(day.tg_failed, 'alert', 'alerts')} could not be delivered`);
  if (day && day.email_owner_failed) lines.push(`❌ ${plural(day.email_owner_failed, 'alert email', 'alert emails')} to you did not go out`);
  if (day && day.autoreply_failed) lines.push(`❌ ${plural(day.autoreply_failed, 'confirmation email', 'confirmation emails')} to a customer failed`);
  if (day && day.review_request_failed) lines.push(`❌ ${plural(day.review_request_failed, 'review request', 'review requests')} to a customer failed`);
  return lines;
}

/**
 * The self-check body for ONE business, from that business's own counts.
 *
 * Problems come first, because a person reading a one-screen message on a phone
 * stops at the first block. The counts follow, so "nothing failed but only two
 * requests arrived" is still legible. The operator block is last and separated,
 * so a client can never mistake it for something about their own leads.
 */
export function selfCheckBody(day, { redirectActive = false, operator = false } = {}) {
  const lines = [];
  const fails = failureLines(day);
  if (fails.length) {
    lines.push('⚠️ Needs attention', ...fails, '');
  }
  lines.push(
    `🆕 New requests: ${(day && day.created) || 0}`,
    `📨 Alerts delivered: ${((day && day.tg_sent) || 0) + ((day && day.email_owner_sent) || 0)}`,
  );
  if (operator && redirectActive) {
    lines.push(
      '',
      '⚠️ Test mode is on: customer emails are redirected to your test address, so real customers will not receive them. Remove it before going live.',
      '',
      'Setting: MAIL_REDIRECT_TO',
    );
  }
  return lines.join('\n');
}

/** Title + subtitle + body, the form Telegram sends. */
export function selfCheckText(day, opts) {
  return [SELFCHECK_TITLE, SELFCHECK_SUBTITLE, '', selfCheckBody(day, opts)].join('\n');
}

/**
 * The owner digest body. No failure section at all when nothing failed — a
 * heading that says "no problems" every day trains people to stop reading.
 */
export function digestBody(day) {
  const lines = [
    `🆕 New requests: ${day.newLeads}`,
    `⏳ Waiting for you over a day: ${day.untouched}`,
    `🔁 Possible repeat requests: ${day.repeats}`,
    '',
    'Open /leads to see them.',
  ];
  if (day.failed > 0) {
    lines.push('', '⚠️ Needs attention', `❌ ${plural(day.failed, 'message', 'messages')} could not be delivered`);
  }
  return lines.join('\n');
}

export function digestText(day) {
  return [DIGEST_TITLE, DIGEST_SUBTITLE, '', digestBody(day)].join('\n');
}

/**
 * Who is told what.
 *
 * A demo business is the operator's own: it may see the redirect warning and
 * the setting name, and a redirect alone is enough to make the message worth
 * sending. An active business is a client: it hears from us only when one of
 * its OWN sends failed, and it never sees operator text.
 */
export function shouldAlertBusiness({ status, failed, redirectActive }) {
  if (status === 'demo') return failed > 0 || redirectActive;
  if (status === 'active') return failed > 0;
  return false;
}
