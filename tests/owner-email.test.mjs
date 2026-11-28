#!/usr/bin/env node
// tests/owner-email.test.mjs — Gate OE (the owner's lifecycle email).
// HARNESS: in-process, pure functions only. No network, no database, no clock:
// every case passes its own `now`. The last check reads two source files.
//
// What it proves (lib/lifecycle-text.js ownerNotice + lib/email-builders.js):
//   OE1  no sentence is repeated across subject / heading / first body line,
//        in any state or reason: the heading IS the subject, and the first
//        paragraph says something the reader has not just read
//   OE2  every paragraph ends in words that cannot be split across a line:
//        the last two are joined by a non-breaking space, once, and no
//        paragraph ends in a lone word
//   OE3  the help line is on the mails that offer a reply path and NOT on the
//        two that deliberately do not (reactivation, daily held-leads): the
//        service is back, so there is nothing to reply about
//   OE4  the reactivation mail never says \"Support has reactivated it\" and
//        never asks for a reply; it says what works again and until when
//   OE5  the daily held-leads mail says \"New requests are waiting\" and is the
//        only mail that carries a count; it promises nothing about a date
//   OE6  the suspension mail (payment) keeps \"Reply to this email and we will
//        help\", and the wording of both suspensions is the word of the code
//   OE7  the mail is plain text with the paragraphs the builder renders, sent
//        by the shared template: no button, no link, and Reply-To support is
//        the sender's job (lib/notify.js), asserted there
//
// Mutation: drop noOrphan() from the paragraph map and OE2 fails; add the
// help line back to the reactivation notice and OE3 fails.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as LT from '../lib/lifecycle-text.js';
import { billingDate, daysText } from '../lib/billing.js';
import { lifecycleEmail } from '../lib/email-builders.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0, total = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(5)}${String(what).padEnd(56)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 110) : ''}`);
};
const NBSP = '\u00A0';
const plain = (s) => String(s || '').replace(/\u00A0/g, ' ');
const DAY = 86400000;
const PAID = '2026-12-14T09:00:00Z';
const P = Date.parse(PAID);
const biz = (patch = {}) => ({
  id: 'b1', name: 'Alder Roofing', slug: 'alder', status: 'active',
  paid_until: PAID, billing_warning_stage: 0, suspended_for_billing: false, ...patch,
});
const sentenceKey = (s) => String(s || '')
  .toLowerCase()
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/* The whole matrix: every notice, both reasons where the reason changes it,
   at the moment it is sent. */
const CASES = [
  ['renewal_reminder', biz(), P - 3 * DAY - 3600000, 'billing'],
  ['overdue', biz(), P + 3600000, 'billing'],
  ['final_warning', biz(), P + 4 * DAY + 3600000, 'billing'],
  ['suspension', biz({ status: 'paused', suspended_for_billing: true }), P + 5 * DAY + 3600000, 'billing'],
  ['suspension', biz({ status: 'paused' }), P + 5 * DAY, 'manual'],
  ['termination_warning', biz({ status: 'paused', suspended_for_billing: true }), P + 10 * DAY + 3600000, 'billing'],
  ['termination', biz({ status: 'churned', suspended_for_billing: true }), P + 15 * DAY + 3600000, 'billing'],
  ['termination', biz({ status: 'churned' }), P + 15 * DAY, 'manual'],
  ['reactivation', biz({ status: 'active' }), P + 20 * DAY, 'payment'],
  ['reactivation', biz({ status: 'active' }), P + 20 * DAY, 'manual'],
  ['held_summary', biz({ status: 'paused', suspended_for_billing: true }), P + 6 * DAY, 'billing'],
  ['held_summary', biz({ status: 'paused' }), P + 6 * DAY, 'manual'],
];
const mail = (type, business, now, reason, extra = {}) => LT.ownerNotice(type, { business, now, reason, ...extra }).email;
const EVERY = CASES.map(([type, business, now, reason]) => ({
  type, reason, email: mail(type, business, now, reason, { held: 2, paidUntil: P + 30 * DAY }),
}));

/* OE1: no sentence said twice. */
{
  const bad = [];
  for (const { type, reason, email } of EVERY) {
    if (!email.text) continue;
    const paragraphs = plain(email.text).split('\n\n').map(sentenceKey);
    const head = sentenceKey(email.heading);
    const subject = sentenceKey(email.subject);
    if (head !== subject) bad.push(`${type}:heading`);
    // The first paragraph may not be the subject again, nor start with it.
    if (paragraphs[0] === head || paragraphs[0].startsWith(head)) bad.push(`${type}:${reason}:first=heading`);
    // And no paragraph may repeat a whole earlier paragraph.
    if (new Set(paragraphs).size !== paragraphs.length) bad.push(`${type}:${reason}:repeat`);
  }
  line(bad.length === 0, 'OE1', 'no sentence repeated across subject, heading and body', bad.slice(0, 4).join(' '));
}

/* OE2: the last THREE words cannot be split. MEANING CHANGE 2026-11-28:
   until now only the last two were glued, which still left a tail of "nothing
   is lost." on a phone; the last three chunks must now carry NBSP joins and
   nothing earlier may. */
{
  const bad = [];
  for (const { type, reason, email } of EVERY) {
    if (!email.text) continue;
    for (const para of String(email.text).split('\n\n')) {
      // Split on PLAIN spaces only: JavaScript's \s matches the non-breaking
      // space too, which is exactly what a naive split would hide.
      const words = para.split(' ').filter(Boolean);
      const last = words[words.length - 1] || '';
      const joins = (para.match(/\u00A0/g) || []).length;
      // The last plain-space chunk holds three words and both NBSP joins;
      // no earlier word is glued.
      if ((last.match(/\u00A0/g) || []).length !== 2 || joins !== 2) {
        bad.push(`${type}:${reason}:${words.slice(-3).join('_')}`); break;
      }
    }
  }
  line(bad.length === 0, 'OE2', 'every paragraph ends in three words that cannot split', bad.slice(0, 4).join(' '));
}

/* OE3: the help line where it belongs. */
{
  const has = (email) => plain(email.text).split('\n\n').some((p) => p === 'Reply to this email and we will help.');
  const NO_HELP = new Set(['reactivation', 'held_summary']);
  const bad = [];
  for (const { type, reason, email } of EVERY) {
    if (!email.text) continue;
    const endsWithHelp = plain(email.text).endsWith('Reply to this email and we will help.');
    if (NO_HELP.has(type) ? has(email) : !endsWithHelp) bad.push(`${type}:${reason}`);
  }
  // The help line is added once, and is the last paragraph when it is there.
  const helpIn = EVERY.filter((e) => has(e.email));
  line(bad.length === 0 && helpIn.length === 8, 'OE3', 'the help line is on the mails that offer a reply path', `${bad.join(' ') || 'ok'} with=${helpIn.length}`);
}

/* OE4: the reactivation mail. */
{
  const e = mail('reactivation', biz(), P + 20 * DAY, 'payment', { paidUntil: P + 30 * DAY });
  const text = plain(e.text);
  const ok = /^(Your service is active again)$/.test(e.subject) && e.heading === e.subject
    && !/reactivat|by support|support has/i.test(text)
    && !/reply to this email/i.test(text)
    // MEANING CHANGE 2026-11-28 (item 11): the "every alert ..." sentence is
    // gone; the mail says only that the service and website work again.
    && !text.includes('Every alert') && !text.includes('working again')
    && e.subject === 'Your service is active again'
    && text.includes('Your website is taking requests again.')
    // The date it is paid until, when there is one: the reader's next question.
    && text.includes(`Your service is paid until ${billingDate(P + 30 * DAY)}.`);
  // No date known: the line is left out rather than filled with "?".
  const noDate = plain(mail('reactivation', biz(), P + 20 * DAY, 'manual').text);
  line(ok && !noDate.includes('?') && !noDate.includes('paid until'), 'OE4', 'reactivation: what works again, no thanks, no reply path', text.slice(0, 60));
}

/* OE5: the daily held-leads mail. */
{
  const one = mail('held_summary', biz({ status: 'paused', suspended_for_billing: true }), P + 6 * DAY, 'billing', { held: 1 });
  const many = mail('held_summary', biz({ status: 'paused', suspended_for_billing: true }), P + 6 * DAY, 'billing', { held: 4 });
  const oneText = plain(one.text);
  const manyText = plain(many.text);
  const ok = one.subject === 'New requests are waiting' && one.heading === one.subject
    && oneText.startsWith('1 request came in through your website form while the service was suspended.')
    && manyText.startsWith('4 requests came in through your website form while the service was suspended.')
    // It is a count: no lead, no name, no phone, no date it cannot know.
    && !/\d{1,2}:\d{2}|\+?\d{7,}|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/.test(oneText)
    && oneText.includes('Renewing shows all of them.')
    && !/reply to this email/i.test(oneText);
  const manual = plain(mail('held_summary', biz({ status: 'paused' }), P + 6 * DAY, 'manual', { held: 2 }).text);
  // MEANING CHANGE 2026-11-28 (item 10): the manual "Contact support to resolve
  // it, and the requests appear." was a second call to action; the count email
  // now only says when the requests appear.
  line(ok && manual.includes('Your requests appear when the service is back.')
    && !/contact support/i.test(manual) && !manual.includes('Renewing'),
    'OE5', 'held leads: one count, no details, no second call to action', oneText.slice(0, 50));
}

/* OE6: the suspensions keep the help line, and say the right thing. */
{
  const billing = mail('suspension', biz({ status: 'paused', suspended_for_billing: true }), P + 5 * DAY + 3600000, 'billing');
  const manual = mail('suspension', biz({ status: 'paused' }), P + 5 * DAY, 'manual');
  const bt = plain(billing.text);
  const mt = plain(manual.text);
  const ok = billing.subject === 'Your service has been suspended' && billing.heading === billing.subject
    && bt.endsWith('Reply to this email and we will help.')
    && /payment/i.test(bt) && /renew/i.test(bt)
    && bt.includes(`(${daysText(Math.ceil((P + 15 * DAY - (P + 5 * DAY + 3600000)) / DAY))} left)`)
    // By hand: no payment language and no termination date, because neither
    // is true.
    && !/payment|renew|termination date|deadline/i.test(mt)
    && !/contact support/i.test(bt + mt)
    && mt.endsWith('Reply to this email and we will help.')
    // Neither says who suspended the service.
    && !/by support|support has/i.test(`${bt}${mt}`);
  line(ok, 'OE6', 'both suspensions: right reason, help line kept, no \"by support\"', bt.slice(0, 50));
}

/* OE7: the mail is the template, plain text, no button. */
{
  const subject = 'Your service has been suspended';
  const text = 'First paragraph.\n\nReply to this email and we will help.';
  const c = lifecycleEmail(biz(), { subject, text });
  const html = String(c.html);
  const ok = c.subject === subject && c.text === text
    && html.includes('Sent by Lead Alerts')
    // The heading in the card is the subject, and the body is the text.
    && html.includes(subject)
    && html.includes('First paragraph.')
    // No button and no link in the body: a reply is the only path.
    && !/<a\s/i.test(html.split('Sent by Lead Alerts')[0].split('</table>').pop() || '')
    && !/<button/i.test(html);
  // Reply-To support is the sender's promise (lib/notify.js sendLifecycleEmail).
  const notify = fs.readFileSync(path.join(ROOT, 'lib', 'notify.js'), 'utf8');
  const wired = /export async function sendLifecycleEmail[\s\S]{0,700}?replyTo:\s*supportEmail\(\)/.test(notify);
  line(ok && wired, 'OE7', 'the shared template, plain text, no button; Reply-To support', `html=${ok} replyTo=${wired}`);
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
