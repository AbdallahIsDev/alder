// lib/lifecycle-text.js — everything a business is TOLD about its lifecycle.
//
// PURE: no database, no network, no clock of its own. One notice is one value:
//
//   { type, telegram: { text, entities }, email: { subject, text } }
//
// The Telegram text has manual line breaks (no line longer than about 34
// characters, so nothing wraps mid-phrase on a phone) and ends with the words
// "Contact support" carrying a text_link entity: there is NO parse_mode
// anywhere, the link is an entity with an explicit offset and length. The
// email says the same thing in flowing paragraphs, has no button, and ends
// with "Reply to this email and we will help." (its Reply-To is the support
// address; see lib/notify.js sendLifecycleEmail).
//
// `type` is the vocabulary of business_events.type.

import { SUPPORT_TELEGRAM_URL, SUPPORT_LINK_LABEL } from './lifecycle-config.js';
import { billingState, billingDate, daysText, toMs } from './billing.js';

export const MAX_LINE = 34;
export const EMAIL_HELP_LINE = 'Reply to this email and we will help.';
/** The one keyboard button a suspended or terminated business's phone has. */
export const STATUS_BUTTON_LABEL = 'Status';

/**
 * Paragraphs (arrays of lines) as one Telegram message that ends with the
 * support link. Offsets are UTF-16 code units, which is what a JavaScript
 * string index is and what Telegram counts.
 */
export function telegramMessage(paragraphs) {
  const body = paragraphs.filter((p) => p && p.length).map((p) => p.join('\n')).join('\n\n');
  const text = `${body}\n\n${SUPPORT_LINK_LABEL}`;
  return {
    text,
    entities: [{ type: 'text_link', offset: text.length - SUPPORT_LINK_LABEL.length, length: SUPPORT_LINK_LABEL.length, url: SUPPORT_TELEGRAM_URL }],
  };
}

/** The same paragraphs as an email body: one flowing line per paragraph. */
export function emailText(paragraphs) {
  return [...paragraphs.filter((p) => p && p.length).map((p) => p.join(' ')), EMAIL_HELP_LINE].join('\n\n');
}

const STATUS_HINT = ['Send /status to see the', 'countdown.'];
const STATUS_HINT_PLAIN = ['Send /status at any time to see', 'the current state.'];
const HELD_EXPLAINER = ['Your website still saves new', 'requests. You will see them', 'when the service is active', 'again.'];

const left = (n) => `${daysText(n)} left`;

/** Why a business is switched off: 'billing' (the daily job, payment not
 *  received) or 'manual' (support did it by hand). */
export function suspensionReason(business) {
  return business && business.suspended_for_billing === true ? 'billing' : 'manual';
}

/**
 * Build one notice. `now` is the moment it is about. Options:
 *   reason      'billing' | 'manual' (suspension, termination), 'payment' |
 *               'manual' (reactivation)
 *   held        leads held so far (reactivation, held_summary)
 *   paidUntil   the new paid_until (reactivation after a payment)
 */
export function ownerNotice(type, { business = null, now = Date.now(), reason = 'billing', held = 0, paidUntil = null } = {}) {
  const s = billingState(business, now);
  const tracked = s.state !== 'not_enforced';
  const due = tracked ? billingDate(s.paidUntil) : '?';
  const suspends = tracked ? billingDate(s.suspendAt) : '?';
  const terminates = tracked ? billingDate(s.terminateAt) : '?';
  const untilSuspend = tracked ? Math.max(0, Math.ceil((s.suspendAt - toMs(now)) / 86400000)) : 0;
  const untilTerminate = tracked ? Math.max(0, Math.ceil((s.terminateAt - toMs(now)) / 86400000)) : 0;
  let subject;
  let p;

  if (type === 'renewal_reminder') {
    subject = 'Your payment is due soon';
    p = [
      [`Your payment is due on ${due}`, `(${left(s.daysLeft)}).`],
      ['Renew before that date to keep', 'your service running.'],
      ['Send /status to see your dates.'],
    ];
  } else if (type === 'overdue') {
    subject = 'Payment overdue';
    p = [
      [`Your payment was due on ${due}`, 'and has not been received.'],
      ['Your service keeps working until', `${suspends} (${left(untilSuspend)}).`, 'After that it is suspended.'],
      STATUS_HINT,
    ];
  } else if (type === 'final_warning') {
    subject = 'Final notice: payment overdue';
    p = [
      ['Final notice: your payment is', 'overdue.'],
      ['Your service will be suspended', `on ${suspends} (${left(untilSuspend)})`, 'unless payment is received.'],
      STATUS_HINT,
    ];
  } else if (type === 'suspension') {
    subject = 'Your service has been suspended';
    p = reason === 'billing'
      ? [
        ['Your service is suspended', 'because payment was not', 'received on time.'],
        ['It will be terminated on', `${terminates} (${left(untilTerminate)})`, 'unless payment is received.'],
        HELD_EXPLAINER,
        STATUS_HINT,
      ]
      : [
        ['Your service has been suspended', 'by support.'],
        HELD_EXPLAINER,
        STATUS_HINT_PLAIN,
      ];
  } else if (type === 'termination_warning') {
    subject = 'Your service will be terminated';
    p = [
      ['Your service is still suspended', 'and payment has not been', 'received.'],
      ['It will be terminated on', `${terminates} (${left(untilTerminate)}).`],
      STATUS_HINT,
    ];
  } else if (type === 'termination') {
    subject = 'Your service has been terminated';
    p = [
      reason === 'billing'
        ? ['Your service has been', 'terminated because payment was', 'not received.']
        : ['Your service has been', 'terminated by support.'],
      ['Your website form no longer', 'accepts requests. Your data has', 'not been deleted.'],
      STATUS_HINT_PLAIN,
    ];
  } else if (type === 'reactivation') {
    subject = 'Your service is active again';
    const until = toMs(paidUntil);
    p = [
      reason === 'payment'
        ? ['Your service is active again.', 'Thank you for your payment.']
        : ['Your service is active again.', 'Support has reactivated it.'],
      until === null ? null : [`Paid until: ${billingDate(until)}.`],
      held > 0 ? [`${held} lead${held === 1 ? '' : 's'} came in while your`, 'service was suspended.', 'Send /leads to see them.'] : null,
      STATUS_HINT_PLAIN,
    ];
  } else if (type === 'held_lead') {
    subject = 'A new request is waiting';
    // The next step is not the same for the two reasons a service is off.
    // Suspended for non-payment: paying is the way back, and /status has the
    // countdown. Suspended by support: there is nothing to pay, so the words
    // say what actually restores it and the support link at the end carries
    // the address.
    p = suspensionReason(business) === 'billing'
      ? [['A new lead just submitted your', 'form. Your service is suspended,', 'so the details are hidden.', 'Renew to see them.'], STATUS_HINT]
      : [['A new lead just submitted your', 'form. Your service is suspended,', 'so the details are hidden.', 'Contact support to restore it.'], ['Send /status to see the current', 'state.']];
  } else if (type === 'held_summary') {
    subject = 'New requests are waiting';
    const n = Math.max(1, Number(held) || 1);
    p = [
      [`${n} new request${n === 1 ? ' has' : 's have'} come in`, 'through your website form while', 'your service is suspended.'],
      ['The details are hidden until', 'the service is active again.'],
    ];
  } else {
    throw new Error('unknown notice type');
  }
  return { type, telegram: telegramMessage(p), email: { subject, text: emailText(p) } };
}

/* ---------- the owner bot while suspended or terminated ---------- */

/**
 * The short reply a suspended or terminated business's phone gets for any
 * message other than /status and /start: the reason, the termination date
 * with the days left (a billing suspension; a suspension made by support has
 * no scheduled termination), the /status hint and the support link.
 */
export function suspendedReply({ business, now = Date.now() }) {
  const reason = suspensionReason(business);
  const s = billingState(business, now);
  const terminated = String(business && business.status) === 'churned';
  let p;
  if (terminated) {
    p = [
      reason === 'billing'
        ? ['This service was terminated', 'because payment was not', 'received.']
        : ['This service was terminated', 'by support.'],
      ['Send /status to see the current', 'state.'],
    ];
  } else if (reason === 'billing' && s.state !== 'not_enforced') {
    const days = Math.max(0, Math.ceil((s.terminateAt - toMs(now)) / 86400000));
    p = [
      ['This service is suspended', 'because payment was not', 'received on time.'],
      ['It will be terminated on', `${billingDate(s.terminateAt)} (${left(days)}).`],
      STATUS_HINT,
    ];
  } else {
    p = [
      reason === 'billing'
        ? ['This service is suspended', 'because payment was not', 'received on time.']
        : ['This service has been suspended', 'by support.'],
      ['Send /status to see the current', 'state.'],
    ];
  }
  return telegramMessage(p);
}

/** The toast a button tap gets on a suspended or terminated business's
 *  phone (a toast is plain text, 200 characters at most). */
export function suspendedToast(status) {
  return String(status) === 'churned'
    ? 'This service was terminated. Send /status.'
    : 'This service is suspended. Send /status.';
}

/** A valid invite code used while the business is switched off: no phone is
 *  connected and the code is handed back unused. Says nothing about why. */
export function connectRefused(status) {
  return telegramMessage([[
    String(status) === 'churned' ? 'This service was terminated.' : 'This service is suspended.',
    'A new phone cannot be connected',
    'right now.',
  ]]);
}

/**
 * /status, in any state. `held` is how many leads are being held (a number,
 * never a detail); null when it could not be read.
 *   Active (+ paid until, when tracked) · overdue, suspends on a date ·
 *   suspended: the reason, terminates on a date, days left, held leads ·
 *   terminated.
 */
export function statusText({ business, now = Date.now(), held = null }) {
  const status = String((business && business.status) || '');
  const reason = suspensionReason(business);
  const s = billingState(business, now);
  const tracked = s.state !== 'not_enforced' && !(business && business.billing_unavailable);
  const heldLines = held > 0 ? [`Leads waiting: ${held}`, 'Their details are hidden until', 'the service is active again.'] : null;
  let p;
  if (status === 'churned') {
    p = [
      ['Status: Terminated'],
      reason === 'billing'
        ? ['Payment was not received.', tracked ? `Terminated on ${billingDate(s.terminateAt)}.` : null].filter(Boolean)
        : ['Terminated by support.'],
      ['Your website form no longer', 'accepts requests. Your data has', 'not been deleted.'],
    ];
  } else if (status === 'paused') {
    const days = tracked ? Math.max(0, Math.ceil((s.terminateAt - toMs(now)) / 86400000)) : 0;
    p = [
      ['Status: Suspended'],
      reason === 'billing'
        ? ['Reason: payment was not', 'received on time.']
        : ['Reason: suspended by support.'],
      reason === 'billing' && tracked ? [`Terminates on ${billingDate(s.terminateAt)}`, `(${left(days)}).`] : null,
      heldLines,
    ];
  } else if (tracked && status === 'active' && s.state !== 'paid' && s.state !== 'due_soon') {
    const days = Math.max(0, Math.ceil((s.suspendAt - toMs(now)) / 86400000));
    p = [
      ['Status: Active, payment overdue'],
      [`Payment was due on ${billingDate(s.paidUntil)}.`],
      s.state === 'grace'
        ? ['Your service will be suspended', `on ${billingDate(s.suspendAt)} (${left(days)}).`]
        : ['Your service will be suspended', 'at the next daily check.'],
    ];
  } else {
    p = [
      ['Status: Active'],
      tracked && status === 'active'
        ? [`Paid until: ${billingDate(s.paidUntil)}`, `(${left(s.daysLeft)}).`]
        : null,
    ];
  }
  return telegramMessage(p);
}

/* ---------- what the operator is told when a notice fails ---------- */

const NOTICE_WORDS = {
  renewal_reminder: 'renewal reminder', overdue: 'overdue notice', final_warning: 'final warning',
  suspension: 'suspension notice', termination_warning: 'termination warning', termination: 'termination notice',
  reactivation: 'reactivation notice', held_lead: 'held-lead notice', held_summary: 'held-leads email',
};
export const noticeWord = (type) => NOTICE_WORDS[type] || 'notice';

/** Business name, notice type, channel and a fixed error class. Nothing else:
 *  no address, no chat, no lead. */
export function noticeFailureAlert({ business, type, failures }) {
  const name = String((business && (business.name || business.slug)) || 'A business').replace(/\s+/g, ' ').trim();
  return [
    'Notice not delivered',
    '',
    name,
    `Notice: ${noticeWord(type)}`,
    ...failures.map((f) => `${f.channel === 'email' ? 'Email' : 'Telegram'}: ${f.errorClass}`),
  ].join('\n');
}
