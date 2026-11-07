// lib/sample-texts.js — every user-facing Telegram string, rendered with sample data.
//
// Two callers, both non-production: tests/bot-text.test.mjs (the artifact guard)
// and scripts/preview.mjs (the gallery). Nothing under api/ imports this file.
//
// The list is generated, not hand-maintained: every exported BOT_*/TOAST_*
// string is picked up automatically, so a new constant is covered the moment it
// exists. The rendered builders are listed explicitly because they need fixtures.

import * as C from './content.js';

const business = {
  id: '00000000-0000-0000-0000-000000000001',
  slug: 'alder-demo',
  name: 'Alder Roofing',
  status: 'demo',
  timezone: 'America/Chicago',
  owner_email: 'owner@example.com',
  google_review_url: 'https://example.com/review',
};

const lead = {
  id: '00000000-0000-0000-0000-000000000002',
  name: 'Daniel Whitaker',
  phone: '(555) 501-2345',
  email: 'daniel@example.com',
  zip: '50265',
  service: 'repair',
  home: 'house',
  timing: 'asap',
  roof_age: '10 to 20 years',
  insurance_claim: true,
  notes: 'Roof leaks around the chimney after rain.',
  status: 'open',
  created_at: new Date(Date.now() - 41 * 60000).toISOString(),
};

const otherLead = {
  ...lead,
  id: '00000000-0000-0000-0000-000000000003',
  name: 'Maria Lopez',
  phone: '5555019876',
  email: '',
  status: 'done',
};

const recipients = [
  { id: 'r1', label: null },
  { id: 'r2', label: 'Office' },
];

/**
 * [{ name, text }] — one entry per string a person can see in Telegram.
 * `username` is passed explicitly so the invite renders its link shape; the
 * fallback shape is rendered too, because both can ship.
 */
export function sampleTelegramTexts() {
  const out = [];
  const add = (name, text) => out.push({ name, text: String(text == null ? '' : text) });

  // Every exported constant whose name marks it as user-facing copy.
  for (const [name, value] of Object.entries(C)) {
    if (typeof value === 'string' && /^(BOT_|TOAST_)/.test(name)) add(name, value);
  }

  for (const view of ['new', 'contacted', 'confirm', 'done', 'error']) {
    for (const reviewResult of view === 'done' ? ['sent', 'no_email', 'failed'] : [null]) {
      add(`alert:${view}:${reviewResult || '-'}`, C.renderAlert({ business, lead, view, reviewResult }));
    }
  }
  add('alert:new:duplicate', C.renderAlert({ business, lead, view: 'new', reviewResult: null, duplicate: true }));
  add('alert:done:no-email-lead', C.renderAlert({ business, lead: otherLead, view: 'done', reviewResult: 'no_email' }));

  add('lead-list:one', C.renderLeadList([lead]));
  add('lead-list:two', C.renderLeadList([lead, otherLead]));
  add('lead-list:empty', C.renderLeadList([]));

  add('linked', C.botLinkedText(business.name));
  add('invite:link', C.botInviteText('K7M2QPX9RT4W', { username: 'alder_alerts_bot' }));
  add('invite:fallback', C.botInviteText('K7M2QPX9RT4W'));
  add('recipients', C.botRecipientsText(recipients));
  add('recipients:empty', C.botRecipientsText([]));
  add('recipient-confirm', C.recipientConfirmText(recipients[1], 1));

  return out;
}

export { business as sampleBusiness, lead as sampleLead };
