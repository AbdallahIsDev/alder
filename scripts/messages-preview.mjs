// scripts/messages-preview.mjs — every word an owner or the operator can be
// sent, rendered with sample data into docs/MESSAGE_PREVIEW.md.
//
//   npm run messages:preview
//
// Reads NO environment, touches NO database, opens NO network connection. The
// texts come from the same builders the bot and the mailer call, so a preview
// can never drift from what ships: change a builder, run this, read the diff.
//
// Two rules the output follows:
//   1. Line breaks exactly as sent. A Telegram message is shown inside a fenced
//      block, one line per line; an email body the same. Nothing is wrapped,
//      re-flowed or trimmed.
//   2. A text_link entity is shown as [[link:URL]]words[[/link]], which is
//      lib/sample-texts.js renderMessage's notation, so the words that carry
//      the link are visible without a phone.
//
// The file is generated. Never edit it by hand: edit the builder and re-run.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownerNotice, suspendedReply, statusText, connectRefused, suspendedToast } from '../lib/lifecycle-text.js';
import {
  operatorBusinessDetailText, operatorBusinessDetailKeyboard,
  operatorSuspendConfirmText, operatorSuspendedText, operatorReactivateConfirmText,
  operatorReactivatedText, operatorTerminateConfirmText, operatorTerminatedText,
  operatorAlreadySuspendedText, operatorAlreadyActiveText, operatorAlreadyTerminatedText,
  operatorTerminatedReactivateText, operatorBillingReactivateText,
  operatorExtendConfirmText, operatorExtendedText, operatorAlreadyExtendedText,
  operatorInviteSuspendedText,
} from '../lib/content.js';
import { billingState, nextPaidUntil, billingDate } from '../lib/billing.js';
import {
  RENEWAL_REMINDER_DAYS, GRACE_DAYS, SUSPENDED_DAYS, TERMINATE_AFTER_DAYS, RETENTION_DAYS,
  EXTEND_DAYS, HELD_GROUP_DAYS, HELD_NOTICES_PER_HOUR,
} from '../lib/lifecycle-config.js';
import { HELD_MESSAGE, UNAVAILABLE_MESSAGE } from '../api/lead.js';
import { renderMessage } from '../lib/sample-texts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'MESSAGE_PREVIEW.md');

const DAY = 86400000;

/* One sample period: paid until 14 December 2026, 09:00 UTC. Every "now" below
   is a whole day before or after it, so the dates in the preview are the dates
   in docs/LIFECYCLE_EXPLAINED.md. */
const PAID_UNTIL = Date.parse('2026-12-14T09:00:00Z');
const at = (days) => PAID_UNTIL + days * DAY;

const business = {
  id: '00000000-0000-0000-0000-000000000001',
  slug: 'alder-demo',
  name: 'Alder Roofing',
  status: 'active',
  timezone: 'America/Chicago',
  owner_email: 'owner@example.com',
  paid_until: new Date(PAID_UNTIL).toISOString(),
  billing_warning_stage: 0,
  suspended_for_billing: false,
};

const phones = [{ id: 'c1', tg_chat_id: '1', label: null, created_at: '2026-11-01T10:00:00Z' }];

const stats = { total: 7, recent: 7, lastAt: new Date(at(-14)).toISOString() };

const H = [];
const w = (s = '') => H.push(s);

/** One Telegram (or plain text) message, line breaks preserved. */
function block(title, text, note = '') {
  w(`### ${title}`);
  w();
  if (note) { w(note); w(); }
  w('```text');
  w(text);
  w('```');
  w();
}

function telegram(title, msg, note = '') {
  block(title, renderMessage(msg), note);
}

function email(title, mail, note = '') {
  w(`### ${title}`);
  w();
  if (note) { w(note); w(); }
  w(`**Subject:** ${mail.subject}`);
  w();
  w('```text');
  w(mail.text);
  w('```');
  w();
}

/** A keyboard as the owner sees it: one line per row of buttons. */
function keyboard(title, markup, note = '') {
  const rows = (markup && markup.reply_markup && markup.reply_markup.inline_keyboard) || [];
  w(`### ${title}`);
  w();
  if (note) { w(note); w(); }
  w('```text');
  if (!rows.length) w('(no buttons)');
  for (const row of rows) w(row.map((b) => `[${b.text}]`).join(' '));
  w('```');
  w();
}

/* ---------- the header ---------- */
w('# Every message, as it is sent');
w();
w('**Generated file.** `npm run messages:preview` writes it from the same');
w('builders the bot and the mailer call. Do not edit it by hand: change the');
w('builder in `lib/lifecycle-text.js`, `lib/content.js` or `api/lead.js`, then');
w('run the command and read the diff.');
w();
w('How to read it:');
w();
w('- `[[link:URL]]Renew now[[/link]]` is one blue link that Telegram underlines');
w('  on those words. There is no `parse_mode`: the link is an entity with an');
w('  explicit offset and length.');
w('- A fenced `text` block keeps every line break exactly as it is sent. No');
w('  line of a Telegram message is longer than 34 characters, so nothing wraps');
w('  in the middle of a phrase on a phone.');
w('- The sample period is **paid until 14 December 2026**, so every date and');
w('  countdown is the one in `docs/LIFECYCLE_EXPLAINED.md`.');
w();
w('## Numbers this file is built from');
w();
w('| Constant | Value |');
w('|---|---|');
w(`| \`RENEWAL_REMINDER_DAYS\` | ${RENEWAL_REMINDER_DAYS} days before the paid date |`);
w(`| \`GRACE_DAYS\` | ${GRACE_DAYS} days of full service after it |`);
w(`| \`SUSPENDED_DAYS\` | ${SUSPENDED_DAYS} days suspended |`);
w(`| \`TERMINATE_AFTER_DAYS\` | termination at D + ${TERMINATE_AFTER_DAYS} days |`);
w(`| \`EXTEND_DAYS\` | one payment = ${EXTEND_DAYS} days |`);
w(`| \`RETENTION_DAYS\` | data kept ${RETENTION_DAYS} days after termination (by hand) |`);
w(`| \`HELD_GROUP_DAYS\` | the held group shows for ${HELD_GROUP_DAYS} days after reactivation |`);
w(`| \`HELD_NOTICES_PER_HOUR\` | at most ${HELD_NOTICES_PER_HOUR} held-lead notices an hour |`);
w();

/* ---------- the six billing notices, by state ---------- */
w('## 1. The billing notices');
w();
w('Each is sent once per paid period, to every connected phone and to the');
w('owner email. The Telegram text and the email say the same thing; the email');
w('has no buttons and its Reply-To is the support address.');
w();

const stages = [
  ['renewal_reminder', at(-RENEWAL_REMINDER_DAYS * 1 - 0.5) - 0, 'due soon: 3 days before the paid date',
    'The paid date is 3 days away. Everything still works.'],
  ['overdue', at(0.5), 'grace begins: the paid date has passed',
    'Overdue, still fully working. The suspension date is named.'],
  ['final_warning', at(GRACE_DAYS - 1 + 0.5), 'grace, last day: one day before suspension',
    'The last warning before the service is switched off.'],
  ['suspension', at(GRACE_DAYS + 0.5), 'suspended for non-payment',
    'Billing reason: the site still saves requests, the termination date is named, the primary action is to renew.'],
  ['termination_warning', at(GRACE_DAYS + 5 + 0.5), 'suspended: 5 days before termination',
    'A reminder that termination is coming.'],
  ['termination', at(GRACE_DAYS + SUSPENDED_DAYS + 0.5), 'terminated',
    'The service is off. Nothing was deleted.'],
];
for (const [type, now, when, note] of stages) {
  const n = ownerNotice(type, { business, now, reason: 'billing' });
  w(`### \`${type}\` — ${when}`);
  w();
  w(note);
  w();
  w('**Telegram** (every phone):');
  w();
  w('```text');
  w(renderMessage(n.telegram));
  w('```');
  w();
  w(`**Email** — subject: **${n.email.subject}** · heading: **${n.email.subject}**`);
  w();
  w('```text');
  w(n.email.text);
  w('```');
  w();
}

/* ---------- suspension and termination by hand ---------- */
w('## 2. Suspension and termination by hand');
w();
w('A manual suspension says only that the service is suspended: no reason and');
w('no countdown, because nothing was scheduled and nobody was late.');
w();
for (const type of ['suspension', 'termination']) {
  const n = ownerNotice(type, { business: { ...business, status: 'paused' }, now: at(GRACE_DAYS + 0.5), reason: 'manual' });
  w(`### \`${type}\` — manual`);
  w();
  w('**Telegram**:');
  w();
  w('```text');
  w(renderMessage(n.telegram));
  w('```');
  w();
  w(`**Email** — subject: **${n.email.subject}**`);
  w();
  w('```text');
  w(n.email.text);
  w('```');
  w();
}

/* ---------- reactivation / extend ---------- */
w('## 3. Back in service');
w();
w('The first message says one thing only: the service is active again. If');
w('there are held leads, a SECOND message follows immediately with those leads,');
w('in the same shape as `/leads`.');
w();
for (const [reason, held, when] of [
  ['payment', 0, 'Extend 30 days, no held leads'],
  ['payment', 3, 'Extend 30 days, 3 held leads (then the second message)'],
  ['manual', 0, 'Reactivate, no held leads'],
  ['manual', 2, 'Reactivate, 2 held leads (then the second message)'],
]) {
  const paidUntil = reason === 'payment' ? nextPaidUntil(business.paid_until, at(GRACE_DAYS + 0.5)) : null;
  const n = ownerNotice('reactivation', { business: { ...business, status: 'active' }, now: at(GRACE_DAYS + 0.5), reason, held, paidUntil });
  const title = `\`reactivation\` — ${when}`;
  w(`### ${title}`);
  w();
  w('**Telegram** (first message):');
  w();
  w('```text');
  w(renderMessage(n.telegram));
  w('```');
  w();
  w(`**Email** — subject: **${n.email.subject}**`);
  w();
  w('```text');
  w(n.email.text);
  w('```');
  w();
}

/* ---------- held-lead notices ---------- */
w('## 4. A new request while the service is suspended');
w();
w(`One Telegram message per held lead to every phone (at most ${HELD_NOTICES_PER_HOUR}`);
w('an hour), with no personal data at all. The details stay in the database');
w('and are visible after the service is back.');
w();
for (const [reason, suspendedForBilling, label] of [
  ['billing', true, 'billing suspension'],
  ['manual', false, 'manual suspension'],
]) {
  const n = ownerNotice('held_lead', {
    business: { ...business, status: 'paused', suspended_for_billing: suspendedForBilling }, now: at(GRACE_DAYS + 0.5), reason,
  });
  w(`### \`held_lead\` — ${label}`);
  w();
  w('**Telegram**:');
  w();
  w('```text');
  w(renderMessage(n.telegram));
  w('```');
  w();
}

/* ---------- the daily held-lead email ---------- */
w('## 5. The daily email about waiting requests');
w();
w('At most one per business per UTC day, and it carries a count, never a');
w('detail and never a name.');
w();
for (const [held, label] of [[1, 'one request'], [4, 'four requests']]) {
  const n = ownerNotice('held_summary', { business: { ...business, status: 'paused', suspended_for_billing: true }, now: at(GRACE_DAYS + 0.5), held });
  w(`### \`held_summary\` — ${label}`);
  w();
  w(`**Email** — subject: **${n.email.subject}**`);
  w();
  w('```text');
  w(n.email.text);
  w('```');
  w();
}

/* ---------- what an owner is answered while off ---------- */
w('## 6. Every other message while the service is off');
w();
w('The owner keeps one button, **Status**. `/status` and `/start` still work.');
w('Anything else gets this short answer with the same button.');
w();
const suspendedBilling = { ...business, status: 'paused', suspended_for_billing: true, paid_until: new Date(at(-GRACE_DAYS)).toISOString() };
const suspendedManual = { ...business, status: 'paused', suspended_for_billing: false };
const terminated = { ...business, status: 'churned', suspended_for_billing: true, paid_until: new Date(at(-15)).toISOString() };
for (const [biz, label] of [
  [suspendedBilling, 'suspended for non-payment'],
  [suspendedManual, 'suspended by hand'],
  [terminated, 'terminated'],
]) {
  telegram(`Reply — ${label}`, suspendedReply({ business: biz, now: biz.id ? Date.now() : Date.now() }), '');
}
w('### Button taps while off (a toast, plain text, 200 characters at most)');
w();
w('```text');
w(`suspended: ${suspendedToast('paused')}`);
w(`terminated: ${suspendedToast('churned')}`);
w('```');
w();
telegram('A valid invite code used while off', connectRefused('paused'));
telegram('…while terminated', connectRefused('churned'));

/* ---------- /status in every state ---------- */
w('## 7. `/status`, in every state');
w();
w('The same facts as the operator\'s screen, in the owner\'s words.');
w();
const statusCases = [
  // A whole three days BEFORE the reminder starts, so the sample shows the
  // paid facts (due-soon begins at D - RENEWAL_REMINDER_DAYS).
  ['paid', { ...business }, -RENEWAL_REMINDER_DAYS - 3, null],
  ['due soon', { ...business }, -RENEWAL_REMINDER_DAYS + 0.5, null],
  ['grace (overdue)', { ...business }, GRACE_DAYS - 1 + 0.5, null],
  ['suspended for non-payment', { ...business, status: 'paused', suspended_for_billing: true }, GRACE_DAYS + 0.5, 2],
  ['suspended by hand', { ...business, status: 'paused' }, GRACE_DAYS + 0.5, 1],
  ['terminated', { ...business, status: 'churned', suspended_for_billing: true }, GRACE_DAYS + SUSPENDED_DAYS + 0.5, null],
  ['not tracked (a demo)', { ...business, status: 'demo', paid_until: null }, 0, null],
];
for (const [label, biz, offset, held] of statusCases) {
  telegram(`/status — ${label}`, statusText({ business: biz, now: at(offset), held }));
}

/* ---------- the operator's screens ---------- */
w('## 8. The operator\'s screens');
w();
w('The operator sees one business at a time: a status block built by the same');
w('formatter the owner\'s `/status` uses, then the buttons for that state.');
w();

const opCases = [
  ['active, a phone connected', { ...business, status: 'active' }, 0, { connected: true }],
  ['active, no phone connected', { ...business, status: 'active' }, 0, { connected: false }],
  ['due soon', { ...business, status: 'active' }, -RENEWAL_REMINDER_DAYS + 0.5, { connected: true }],
  ['grace', { ...business, status: 'active' }, GRACE_DAYS - 1 + 0.5, { connected: true }],
  ['suspended for non-payment', { ...business, status: 'paused', suspended_for_billing: true }, GRACE_DAYS + 0.5, { connected: true, suspended: true, billingSuspended: true }],
  ['suspended by hand', { ...business, status: 'paused', suspended_for_billing: false }, GRACE_DAYS + 0.5, { connected: true, suspended: true }],
  ['terminated', { ...business, status: 'churned', suspended_for_billing: true }, GRACE_DAYS + SUSPENDED_DAYS + 0.5, { connected: true, suspended: true, terminated: true }],
  ['billing not tracked', { ...business, status: 'demo', paid_until: null }, 0, { connected: true }],
];
const BIZ_ID = business.id;
for (const [label, biz, offset, opts] of opCases) {
  const text = operatorBusinessDetailText({
    business: biz, rows: opts.connected ? phones : [], stats: { ...stats, held: opts.suspended ? 2 : 0 }, nowMs: at(offset),
  });
  block(`Business screen — ${label}`, text);
  keyboard(`Buttons — ${label}`, operatorBusinessDetailKeyboard(BIZ_ID, 0, opts));
}

/* ---------- the operator's questions and results ---------- */
w('## 9. The operator\'s questions and their answers');
w();
const suspendedBiz = { ...business, status: 'paused', suspended_for_billing: false };
const billingBiz = { ...business, status: 'paused', suspended_for_billing: true };
const terminatedBiz = { ...business, status: 'churned', suspended_for_billing: true };
block('Ask: suspend', operatorSuspendConfirmText(business));
block('Ask: reactivate', operatorReactivateConfirmText(suspendedBiz));
block('Ask: terminate', operatorTerminateConfirmText(suspendedBiz));
block('Ask: extend, an active business', operatorExtendConfirmText({ business, target: nextPaidUntil(business.paid_until, at(0)), suspended: false }));
block('Ask: extend, a suspended business', operatorExtendConfirmText({ business: suspendedBiz, target: nextPaidUntil(business.paid_until, at(GRACE_DAYS + 0.5)), suspended: true }));
block('Ask: extend, a terminated business', operatorExtendConfirmText({ business: terminatedBiz, target: nextPaidUntil(business.paid_until, at(GRACE_DAYS + SUSPENDED_DAYS + 0.5)), suspended: true }));
block('Result: suspended', operatorSuspendedText({ business, notice: { phones: 1, phonesOk: 1, email: 'sent' } }));
block('Result: reactivated', operatorReactivatedText(suspendedBiz, { notice: { phones: 1, phonesOk: 1, email: 'sent' } }));
block('Result: terminated', operatorTerminatedText({ business, notice: { phones: 1, phonesOk: 1, email: 'sent' } }));
block('Result: extended', operatorExtendedText({ business, paidUntil: nextPaidUntil(business.paid_until, at(0)), reactivated: false, notice: { phones: 1, phonesOk: 1, email: 'sent' } }));
block('Result: extended and restored', operatorExtendedText({ business: suspendedBiz, paidUntil: nextPaidUntil(business.paid_until, at(GRACE_DAYS + 0.5)), reactivated: true, notice: { phones: 1, phonesOk: 1, email: 'sent' } }));
block('Already extended', operatorAlreadyExtendedText({ business, paidUntil: business.paid_until }));
block('Already suspended', operatorAlreadySuspendedText(business));
block('Already active', operatorAlreadyActiveText(business));
block('Already terminated', operatorAlreadyTerminatedText(business));
block('Refusal: Reactivate on a terminated business', operatorTerminatedReactivateText(terminatedBiz));
block('Refusal: Reactivate on a billing suspension', operatorBillingReactivateText(billingBiz));
block('Refusal: an invite for a suspended business', operatorInviteSuspendedText(suspendedBiz));
block('Refusal: an invite for a terminated business', operatorInviteSuspendedText(terminatedBiz));

/* ---------- what the visitor reads ---------- */
w('## 10. What the visitor reads');
w();
w('Two answers are not "sent" and are not a failure: a suspended business saves');
w('the request and shows **Request saved** with the Call button; a terminated');
w('business shows a neutral page and accepts nothing. Neither promises a reply.');
w();
block('Site — suspended business (request saved, then held)', HELD_MESSAGE,
  'The panel\'s heading is **Request saved**; the summary of what the visitor typed is shown above these words.');
block('Site — terminated business (the form is not available)', UNAVAILABLE_MESSAGE);
block('Site — terminated business: the whole page', 'This website is currently unavailable.',
  'Only the form is replaced by this sentence; the page keeps its header, its sections and its phone number. The form API answers the same refusal.');
block('No-JS form — suspended business (stored, held)', 'Your request was saved. The business will see it when its service is active again.',
  'The no-JS page is a plain HTML page, one paragraph, no promise of a reply.');
block('No-JS form — terminated business (nothing stored)', 'This business isn\'t accepting requests through this form right now.');

/* ---------- held leads after reactivation ---------- */
w('## 11. `/leads` after a reactivation');
w();
w(`For ${HELD_GROUP_DAYS} days after the service comes back, the leads received while it was`);
w('suspended are a group of their own at the top. After that they are ordinary');
w('rows in date order. Their number, date and the `held` line never change.');
w();
w('```text');
w('Recent requests');
w();
w('Received while suspended: 2');
w();
w('1. Maria Lopez');
w('Repair · (555) 501-9876');
w('New · 2d ago');
w('held');
w();
w('2. Daniel Whitaker');
w('Replacement · (555) 501-2345');
w('New · 3d ago');
w('held');
w();
w('Other requests');
w();
w('3. Sam Reed');
w('Storm damage · (555) 501-1111');
w('Contacted · 9d ago');
w('```');
w();
w(`After ${HELD_GROUP_DAYS} days the same page is one list, in date order, with no group;`);
w('each held row keeps its `held` line.');
w();

w('---');
w();
w('Generated by `npm run messages:preview` from the code, not typed by hand.');
w();

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, H.join('\n'));
console.log(`messages:preview  wrote ${path.relative(ROOT, OUT)} (${H.length} lines)`);
