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
export function failureLines(day, { audience = 'owner' } = {}) {
  const lines = [];
  if (day && day.tg_failed) lines.push(`❌ ${plural(day.tg_failed, 'alert', 'alerts')} could not be delivered`);
  // "to you" for the owner, "to the owner" when the operator is reading about
  // someone else's business.
  if (day && day.email_owner_failed) {
    lines.push(`❌ ${plural(day.email_owner_failed, 'alert email', 'alert emails')} to ${audience === 'operator' ? 'the owner' : 'you'} did not go out`);
  }
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
export function selfCheckBody(day) {
  const lines = [];
  const fails = failureLines(day);
  if (fails.length) {
    lines.push('⚠️ Needs attention', ...fails, '');
  }
  lines.push(
    `🆕 New requests: ${(day && day.created) || 0}`,
    `📨 Alerts delivered: ${((day && day.tg_sent) || 0) + ((day && day.email_owner_sent) || 0)}`,
  );
  return lines.join('\n');
}

/**
 * The owner-facing self-check. Per business, own counts, and no operator text of
 * any kind — a demo business is not an audience for the redirect warning any
 * more; the operator gets that in their own alarm.
 */
export function selfCheckText(day) {
  return [SELFCHECK_TITLE, SELFCHECK_SUBTITLE, '', selfCheckBody(day)].join('\n');
}

/** One business's failures as a single plain phrase, for the operator list. */
export function failureSummary(day) {
  return failureLines(day, { audience: 'operator' }).map((l) => l.replace(/^❌ /, '')).join('; ');
}

/**
 * The operator alarm: ONE message for the whole run, problems first.
 *
 * This is the only place a slug, an aggregate or the redirect warning appears.
 * Returns null when there is nothing to say, so a clean run sends nothing at all.
 */
export function operatorAlarmBody({ rows = [], redirectActive = false, noPhoneSlugs = [] } = {}) {
  const blocks = [];
  if (rows.length) {
    blocks.push(['⚠️ Needs attention', ...rows.map((r) => `${r.slug}: ${failureSummary(r.day)}`)].join('\n'));
  }
  if (noPhoneSlugs.length) {
    blocks.push('📵 No phone connected: ' + noPhoneSlugs.join(', '));
  }
  if (redirectActive) {
    blocks.push([
      '⚠️ Test mode is on: customer emails are redirected to your test address, so real customers will not receive them. Remove it before going live.',
      '',
      'Setting: MAIL_REDIRECT_TO',
    ].join('\n'));
  }
  if (!blocks.length) return null;
  return blocks.join('\n\n');
}

export const OPERATOR_TITLE = SELFCHECK_TITLE + ' — operator';

export function operatorAlarmText(opts) {
  const body = operatorAlarmBody(opts);
  if (!body) return null;
  return [OPERATOR_TITLE, SELFCHECK_SUBTITLE, '', body].join('\n');
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
 * Every business is an owner audience and is treated identically: it hears from
 * us only when one of its OWN sends failed, with only its own counts. Operator
 * content (redirect warning, aggregates, slugs, "no phone") never travels on
 * this path — see operatorAlarmText.
 */
export function shouldAlertBusiness({ status, failed }) {
  if (status !== 'demo' && status !== 'active') return false;
  return failed > 0;
}
