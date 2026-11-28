// lib/lifecycle-text.js — everything a business is TOLD about its lifecycle.
//
// PURE: no database, no network, no clock of its own. One notice is one value:
//
//   { type, telegram: { text, entities }, email: { subject, heading, text } }
//
// House rules for every text below, owner-facing and operator-facing alike:
//
//   - No "by support". A manual suspension is "Your service has been
//     suspended." — nothing blames a person, nothing names a team. A
//     reactivation says the service is back and nothing about who did it.
//   - Never imply a lead is lost. A held request is "saved safely"; it is
//     hidden, not gone, and it comes back when the service does.
//   - A billing suspension's primary action is RENEW. "Contact support" is
//     the second line, a help path, never the main one.
//   - No orphan lines: no Telegram message ends on a line holding a single
//     short word ("again", "suspended"). The manual line breaks are chosen so
//     lines are balanced, 24 to 34 characters, and every line is at most 34
//     (MAX_LINE) so nothing wraps mid-phrase on a phone.
//   - No parse_mode anywhere. Links are text_link entities laid on the action
//     words themselves ("Renew now", "Contact support"), never on a separate
//     repeated line. The offsets are UTF-16 code units, which is what a
//     JavaScript string index is and what Telegram counts.
//   - Emails say the same thing in flowing paragraphs, have no button, and
//     end with "Reply to this email and we will help." — except the
//     reactivation mail, which offers no reply path (the service is back; the
//     bot is the channel) and the held-lead mails, which carry a count only.
//
// `type` is the vocabulary of business_events.type.

import {
  SUPPORT_TELEGRAM_URL, SUPPORT_LINK_LABEL, RENEW_URL, RENEW_LINK_LABEL,
} from './lifecycle-config.js';
import { billingState, billingDate, daysText, toMs, statusLines } from './billing.js';

export const MAX_LINE = 34;
export const EMAIL_HELP_LINE = 'Reply to this email and we will help.';
/** The one keyboard button a suspended or terminated business's phone has. */
export const STATUS_BUTTON_LABEL = 'Status';
/** The words that carry the renew link. One constant: the copy reads it. */
export const RENEW_WORDS = RENEW_LINK_LABEL;

/* ---------- building a Telegram message with links ---------- */

/** A run of words that carries a link. Everything else in a paragraph is a
 *  plain string or some words. */
const linkTo = (text, url) => ({ text, url });

/** "Renew now", carrying the one renew address. */
export const renewLink = () => linkTo(RENEW_WORDS, RENEW_URL);
/** "Contact support", carrying the support address. */
export const supportLink = () => linkTo(SUPPORT_LINK_LABEL, SUPPORT_TELEGRAM_URL);

/** One token's text. A token is a string, a number or a link. */
const tokText = (t) => (typeof t === 'string' ? t : typeof t === 'number' ? String(t) : String(t.text));

/**
 * Break ONE paragraph into lines of at most `max` characters, at spaces, and
 * never inside a link's words (a link is one atomic token).
 *
 * The break points minimise the sum of the SQUARED slack of every line,
 * including the last, so the lines of a paragraph come out balanced instead
 * of "long, long, one short word". That is what removes an orphan ending.
 *
 * A line is also never broken straight after an opening bracket: "(5 days
 * left)" reads as one fact, so the break goes before the bracket instead of
 * inside it. A paragraph that already fits on one line stays on one line,
 * which is what keeps "Paid until: Dec 14" one fact per line.
 */
export function wrapTokens(tokens, max = MAX_LINE) {
  const words = [];
  for (const t of tokens) {
    const text = tokText(t);
    if (!text) continue;
    if (typeof t !== 'string' && typeof t !== 'number') { words.push({ text, token: t }); continue; }
    for (const w of text.split(/\s+/).filter(Boolean)) words.push({ text: w, token: t });
  }
  if (!words.length) return [];
  const n = words.length;
  const width = (from, to) => words.slice(from, to).reduce((a, w, i) => a + (i ? 1 : 0) + w.text.length, 0);
  if (width(0, n) <= max) return [words];

  // A break after a word that opens a bracket would split the bracket's
  // contents from it; that break is allowed only when nothing else fits.
  const opens = (w) => /[(\[{]$/.test(w.text);
  const best = new Array(n + 1).fill(Infinity);
  const next = new Array(n + 1).fill(-1);
  best[n] = 0;
  for (let i = n - 1; i >= 0; i--) {
    let len = 0;
    for (let j = i + 1; j <= n; j++) {
      len = j === i + 1 ? words[i].text.length : len + 1 + words[j - 1].text.length;
      if (len > max && j > i + 1) break;
      const slack = Math.max(0, max - len);
      const penalty = j < n && opens(words[j - 1]) ? 900 : 0;
      const cost = slack * slack + penalty + best[j];
      if (cost < best[i]) { best[i] = cost; next[i] = j; }
    }
  }
  const lines = [];
  for (let i = 0; i < n;) {
    const j = next[i] > i ? next[i] : n;
    lines.push(words.slice(i, j));
    i = j;
  }
  return lines;
}

/** Lines as text, and the links inside them as entities. */
function renderLines(lines) {
  const out = [];
  const entities = [];
  let offset = 0;
  lines.forEach((line, li) => {
    if (li) offset += 1;
    line.forEach((w, wi) => {
      if (wi) offset += 1;
      if (typeof w.token !== 'string' && typeof w.token !== 'number' && w.token.url) {
        entities.push({ type: 'text_link', offset, length: w.text.length, url: w.token.url });
      }
      offset += w.text.length;
      out.push((wi ? ' ' : '') + w.text);
    });
    out.push('\n');
  });
  out.pop();
  const text = out.join('');
  return { text, entities };
}

/**
 * One Telegram message.
 *
 * A paragraph is either an array of tokens (words and links) or a tight group
 * `{ lines: [tokens, tokens] }`. Either is wrapped on its own, so a paragraph
 * that fits stays on one line — which is what keeps one fact per line on the
 * /status screen. Paragraphs are separated by one blank line; the lines of a
 * tight group by one newline. Every link becomes one text_link entity on
 * exactly its words, with UTF-16 offsets.
 */
export function telegramDoc(paragraphs) {
  const units = [];
  for (const p of paragraphs || []) {
    if (p && !Array.isArray(p) && Array.isArray(p.lines)) {
      const lines = p.lines.map((tokens) => wrapTokens(tokens || []).map((l) => l));
      const flat = lines.flat();
      if (flat.length) units.push({ lines: flat, tight: true });
      continue;
    }
    const lines = wrapTokens(p || []);
    if (lines.length) units.push({ lines, tight: false });
  }
  const text = [];
  const entities = [];
  let offset = 0;
  units.forEach((u, ui) => {
    if (ui) { text.push('\n\n'); offset += 2; }
    u.lines.forEach((line, li) => {
      if (li) { text.push('\n'); offset += 1; }
      line.forEach((w, wi) => {
        if (wi) { text.push(' '); offset += 1; }
        if (typeof w.token !== 'string' && typeof w.token !== 'number' && w.token.url) {
          entities.push({ type: 'text_link', offset, length: w.text.length, url: w.token.url });
        }
        text.push(w.text);
        offset += w.text.length;
      });
    });
  });
  return { text: text.join(''), entities };
}

/** One document from two, joined by one blank line. Offsets are rebased. */
export function concatDocs(a, b) {
  if (!a || !a.text) return b || { text: '', entities: [] };
  if (!b || !b.text) return a;
  const base = a.text.length + 2;
  return {
    text: `${a.text}\n\n${b.text}`,
    entities: [...a.entities, ...b.entities.map((e) => ({ ...e, offset: e.offset + base }))],
  };
}

/** A document whose only link is one support line at the end. Kept for the
 *  few callers that need nothing else. */
export function telegramMessage(paragraphs) {
  return telegramDoc([...(paragraphs || []), [supportLink()]]);
}

/**
 * An email body: one flowing line per paragraph, the last THREE words of every
 * paragraph joined with non-breaking spaces so a narrow column cannot leave
 * one or two short words alone on its final line. Nothing else is changed.
 */
export function emailText(paragraphs) {
  const paras = (paragraphs || [])
    .map((p) => (p || []).map(tokText).join(' ').replace(/ +/g, ' ').trim())
    .filter((p) => p.length);
  return paras.map(noOrphan).join('\n\n');
}

export const NBSP = '\u00A0';

/** Join the last three words of one paragraph with non-breaking spaces.
 *  Email clients do not support text-wrap, so this is the only way to keep a
 *  short tail ("nothing / is lost.") from becoming its own line. */
export function noOrphan(paragraph) {
  const s = String(paragraph == null ? '' : paragraph);
  const words = s.split(' ');
  if (words.length < 2) return s;
  const tail = words.splice(-3);
  return (words.length ? words.join(' ') + ' ' : '') + tail.join(NBSP);
}

/** The short word a paragraph would leave alone on its final line, or null.
 *  Used by the tests and by docs/MESSAGE_PREVIEW.md's notes. */
export function orphanWord(paragraph) {
  const s = String(paragraph == null ? '' : paragraph);
  const words = s.split(' ');
  // A paragraph of ONE word is exactly the orphan this helper exists to find;
  // the old early return made it blind to the case it was named for.
  const last = words[words.length - 1];
  if (!last) return null;
  return last.replace(/\u00A0/g, ' ').length <= 12 && !last.includes(NBSP) ? last : null;
}

const left = (n) => `${daysText(n)} left`;

/** Why a business is switched off: 'billing' (the daily job, payment not
 *  received) or 'manual' (switched off by hand). */
export function suspensionReason(business) {
  return business && business.suspended_for_billing === true ? 'billing' : 'manual';
}

/* ---------- the six billing notices ---------- */

/**
 * Build one notice. `now` is the moment it is about. Options:
 *   reason      'billing' | 'manual' (suspension, termination), 'payment' |
 *               'manual' (reactivation)
 *   held        leads held so far (reactivation, held_summary)
 *   paidUntil   the new paid_until (reactivation after a payment)
 *
 * `p` is the Telegram document: paragraphs of tokens (strings and links),
 * wrapped and linked by telegramDoc. `e` is the email: paragraphs of flowing
 * text, independent of `p` because a mail has no link words and must not
 * repeat a sentence.
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
  let p;              // Telegram paragraphs
  let e;              // Email paragraphs
  let emailHelp = true;

  if (type === 'renewal_reminder') {
    subject = 'Your payment is due soon';
    p = [
      [`Your payment is due on ${due} (${left(s.daysLeft)}).`],
      [renewLink(), 'to keep your service running.'],
    ];
    e = [
      [`Your payment is due on ${due} (${left(s.daysLeft)}).`],
      ['Renewing before that date keeps your service running and your website taking requests.'],
      ['Send /status to the Lead Alerts bot on Telegram at any time to see your dates.'],
    ];
  } else if (type === 'overdue') {
    subject = 'Payment overdue';
    p = [
      [`Your payment was due on ${due} and has not arrived.`],
      [`Your service works until ${suspends}, then it is suspended (${left(untilSuspend)}).`],
      [renewLink(), 'to keep it running.'],
    ];
    e = [
      [`Your payment was due on ${due} and has not arrived.`],
      [`Your service keeps working until ${suspends} (${left(untilSuspend)}). After that it is suspended and your website pauses new requests.`],
      ['Renewing now keeps everything running without a break.'],
    ];
  } else if (type === 'final_warning') {
    subject = 'Final notice: payment overdue';
    p = [
      ['Final notice: your payment is overdue.'],
      [`Your service will be suspended on ${suspends} (${left(untilSuspend)}) unless payment arrives.`],
      [renewLink(), 'to keep it running.'],
    ];
    e = [
      ['This is the last reminder before your service is suspended.'],
      [`The payment is still outstanding. The service is suspended on ${suspends} (${left(untilSuspend)}) unless payment arrives.`],
      ['Renewing takes a minute and keeps your website taking requests.'],
    ];
  } else if (type === 'suspension') {
    subject = 'Your service has been suspended';
    p = reason === 'billing'
      ? [
        ['Your service is suspended because payment was overdue.'],
        ['Your website still saves new requests. They are visible again after you renew.'],
        [`The service terminates on ${terminates} (${left(untilTerminate)}).`],
        [renewLink(), 'to restore the service.'],
        ['Need help?', supportLink()],
      ]
      : [
        ['Your service has been suspended.'],
        ['Your website still saves new requests. They are kept safely and shown once the service is back.'],
        [supportLink(), 'to resolve it.'],
      ];
    // Item 10: one short, balanced sentence; no orphan "nothing is lost."
    // and, for a manual suspension, no mention of any termination date.
    e = reason === 'billing'
      ? [
        ['Your website still saves every request. Each one is kept safely and will wait for you when service returns.'],
        [`The service is terminated on ${terminates} (${left(untilTerminate)}) unless payment is received.`],
        ['Renewing restores the service and shows every request that came in.'],
      ]
      : [
        ['Your website still saves every request. Each one is kept safely and will wait for you when service returns.'],
      ];
  } else if (type === 'termination_warning') {
    subject = 'Your service will be terminated';
    p = [
      ['Your service is still suspended and payment has not arrived.'],
      [`It will be terminated on ${terminates} (${left(untilTerminate)}).`],
      [renewLink(), 'to keep it running.'],
    ];
    e = [
      ['Your service is still suspended and the payment has not arrived.'],
      [`It will be terminated on ${terminates} (${left(untilTerminate)}) unless payment arrives.`],
      ['A terminated service stops accepting requests, and putting it back takes a new payment.'],
    ];
  } else if (type === 'termination') {
    subject = 'Your service has been terminated';
    p = reason === 'billing'
      ? [
        ['Your service has been terminated because payment was overdue.'],
        ['Your website has stopped accepting requests. Your data has not been deleted.'],
        [renewLink(), 'to restore the service.'],
        ['Need help?', supportLink()],
      ]
      : [
        ['Your service has been terminated.'],
        ['Your website has stopped accepting requests. Your data has not been deleted.'],
        [supportLink(), 'to restore the service.'],
      ];
    e = reason === 'billing'
      ? [
        ['Your website has stopped accepting requests. Everything you had is still stored: no lead, no phone and no setting was deleted.'],
        ['A new payment restores the service and brings every saved request back.'],
      ]
      : [
        ['Your website has stopped accepting requests. Everything you had is still stored: no lead, no phone and no setting was deleted.'],
        ['The service can be restored; contact support to arrange it.'],
      ];
  } else if (type === 'reactivation') {
    subject = 'Your service is active again';
    // The Telegram message says ONE thing. If there are held leads, a SECOND
    // message follows with them, in /leads' own format (api/tg.js sends it).
    p = [['Your service is active again.']];
    const until = toMs(paidUntil);
    // Item 11: no claim about every alert or email — only the two facts the
    // business can check: service active (subject) and website back.
    e = [
      ...(until === null ? [] : [[`Your service is paid until ${billingDate(until)}.`]]),
      ['Your website is taking requests again.'],
    ];
    emailHelp = false;      // the service is back: no reply path, no "we will help"
  } else if (type === 'held_lead') {
    subject = 'A new request is waiting';
    // No personal data, in any form. Billing: renew is the way in. Manual:
    // support is the way in, and there is nothing to pay.
    p = suspensionReason(business) === 'billing'
      ? [
        // A2: the two facts are separate lines, not one flowing paragraph that
        // could strand "Your" at the end of the first line.
        { lines: [['New lead received.'], ['Your lead is saved safely.']] },
        [renewLink(), 'to see the details.'],
        ['Need help?', supportLink()],
      ]
      : [
        { lines: [['New lead received.'], ['Your lead is saved safely.']] },
        ['The details stay hidden while the service is suspended.'],
        [supportLink(), 'to resolve it.'],
      ];
    e = null;   // a held lead is Telegram only; the daily email carries a count
  } else if (type === 'held_summary') {
    subject = 'New requests are waiting';
    const n = Math.max(1, Number(held) || 1);
    p = null;   // email only
    e = [
      [`${n} request${n === 1 ? '' : 's'} came in through your website form while the service was suspended.`],
      ['The details are hidden until the service is active again, and every one of them is saved in full.'],
      suspensionReason(business) === 'billing'
        ? ['Renewing shows all of them.']
        : ['Your requests appear when the service is back.'],
    ];
    emailHelp = false;
  } else {
    throw new Error('unknown notice type');
  }

  // An email paragraph is flowing text: join its tokens, then keep the last
  // three words together with non-breaking spaces. (Spreading a string here
  // would put an empty paragraph between every character.)
  const body = e ? e.map((para) => noOrphan(para.map(tokText).join(' ').replace(/ +/g, ' ').trim())).filter(Boolean) : null;
  return {
    type,
    telegram: p ? telegramDoc(p) : null,
    email: {
      subject,
      // The heading is the subject. The first body paragraph is NEW
      // information, never the heading said a second time.
      heading: subject,
      text: body ? [...body, ...(emailHelp ? [noOrphan(EMAIL_HELP_LINE)] : [])].join('\n\n') : null,
    },
  };
}

/* ---------- the owner bot while suspended or terminated ---------- */

/**
 * The short reply a suspended or terminated business's phone gets for any
 * message other than /status and /start: the state, the reason, what happens
 * to new requests, the date with the days left, and the one action that
 * matters (renew for a billing suspension, support otherwise). No /status
 * hint: the Status button is on the keyboard in this state, so telling
 * somebody to type it says the same thing twice.
 */
export function suspendedReply({ business, now = Date.now() }) {
  const reason = suspensionReason(business);
  const s = billingState(business, now);
  const tracked = reason === 'billing' && s.state !== 'not_enforced';
  const terminated = String(business && business.status) === 'churned';
  let p;
  if (terminated) {
    p = reason === 'billing'
      ? [
        ['Your service has been terminated because payment was overdue.'],
        ['Your website accepts no new requests. Your data has not been deleted.'],
        [renewLink(), 'to restore the service.'],
      ]
      : [
        ['Your service has been terminated.'],
        ['Your website accepts no new requests. Your data has not been deleted.'],
        [supportLink(), 'to restore the service.'],
      ];
  } else if (reason === 'billing' && tracked) {
    const days = Math.max(0, Math.ceil((s.terminateAt - toMs(now)) / 86400000));
    p = [
      ['Your service is suspended because payment was overdue.'],
      [`It terminates on ${billingDate(s.terminateAt)} (${left(days)}).`],
      ['New requests are still saved and shown after you renew.'],
      [renewLink(), 'to restore the service.'],
    ];
  } else {
    // A suspension made by hand has no scheduled termination date and no
    // countdown. Say what is true and where help is.
    p = [
      ['Your service has been suspended.'],
      ['New requests are still saved and kept safely until the service is back.'],
      [supportLink(), 'to resolve it.'],
    ];
  }
  return telegramDoc(p);
}

/** The toast a button tap gets on a suspended or terminated business's
 *  phone (a toast is plain text, 200 characters at most). */
export function suspendedToast(status) {
  return String(status) === 'churned'
    ? 'This service was terminated.'
    : 'This service is suspended.';
}

/** A valid invite code used while the business is switched off: no phone is
 *  connected and the code is handed back unused. Says nothing about why. */
export function connectRefused(status) {
  return telegramDoc([
    [`${String(status) === 'churned' ? 'This service was terminated.' : 'This service is suspended.'} A new phone cannot be connected right now.`],
  ]);
}

/**
 * /status, in any state: the SAME facts the operator's business screen shows
 * (statusLines in lib/billing.js), then the owner-only words — the reason, how
 * many requests are waiting (a number, never a detail) and the one link that
 * helps. `held` is that count; null when it could not be read.
 */
export function statusText({ business, now = Date.now(), held = null }) {
  const s = billingState(business, now);
  const tracked = s.state !== 'not_enforced' && !(business && business.billing_unavailable);
  const f = statusLines(business, { now, held, heldLabel: 'Leads waiting' });
  const status = String((business && business.status) || '');
  const reason = suspensionReason(business);
  const billing = reason === 'billing';
  // The facts of the state, one per line and together: no blank lines inside.
  const facts = f.filter((l) => !/^Leads waiting: /.test(l));
  let doc = telegramDoc([{ lines: facts.map((l) => [l]) }]);
  // The extras depend on the STATE, not on whether a payment date is tracked:
  // a suspension made by hand is not "not tracked and therefore nothing to
  // say" — it has no countdown, so it needs the way out all the more.
  const extra = [];
  if (status === 'churned') {
    extra.push([billing ? 'Payment was not received.' : 'The service was terminated.']);
    extra.push(['Your data has not been deleted.']);
    extra.push([billing ? renewLink() : supportLink(), 'to restore the service.']);
  } else if (status === 'paused') {
    extra.push([billing ? 'Reason: payment was overdue.' : 'The service was suspended.']);
    if (held > 0) {
      extra.push([`Leads waiting: ${held}`]);
      extra.push(['Their details are hidden until the service is back.']);
    }
    extra.push([billing ? renewLink() : supportLink(), 'to restore the service.']);
  }
  if (extra.length === 1) extra.unshift([]);
  if (extra.length) doc = concatDocs(doc, telegramDoc(extra));
  return doc;
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
