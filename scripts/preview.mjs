// scripts/preview.mjs — renders current copy builders to files for human review.
// Reads NO environment, opens NO network connection, touches NO database.
// Usage: node scripts/preview.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ownerEmail, autoReply, reviewEmail, telegramAlertText,
} from '../lib/content.js';
import * as content from '../lib/content.js';

// renderAlert is introduced in ITEM 2 of this task. Until then, fall back to the
// current alert text so every output file can still be generated now.
function renderAlertHuman(arg) {
  return typeof content.renderAlert === 'function'
    ? content.renderAlertHuman(arg)
    : telegramAlertText(arg);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '_debug', 'previews');

const business = {
  id: '00000000-0000-0000-0000-000000000001',
  slug: 'alder-demo',
  name: 'Alder Roofing',          // demo business name; consistent with test fixtures
  status: 'demo',
  timezone: 'America/Chicago',
  owner_email: 'owner@alder-demo.example',
  google_review_url: 'https://example.com/google-review',
};

const fullLead = {
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
  notes: 'Roof leaks around the chimney after rain.\nReally need <b>hail & "storm" damage</q> checked before it gets worse.\nCan someone come on a weekday morning?',
};

const minimalLead = {
  id: '00000000-0000-0000-0000-000000000003',
  name: 'Maria Lopez',
  phone: '5555019876',
  email: '',
  zip: '50269',
  service: 'unsure',
  home: 'other',
  timing: 'planning',
  roof_age: 'Not sure',
  insurance_claim: false,
  notes: '',
};

const token = 'sample-review-token-0123456789abcdef';
const siteUrl = 'http://localhost:3000';

function esc(v) {
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
const wrapHtml = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body style="font:14px Arial,Helvetica,sans-serif">${body}</body></html>\n`;

function write(name, body) {
  const p = path.join(OUT, name);
  fs.writeFileSync(p, body);
  console.log(p);
}

fs.mkdirSync(OUT, { recursive: true });

const ownerFull = ownerEmail({ business, lead: fullLead });
const ownerTextFull = ownerFull.text;
const autoFull = autoReply({ business, lead: fullLead });
const reviewFull = reviewEmail({ business, token, siteUrl });

const files = [
  { name: 'owner-email.html', title: 'Owner email — full lead', body: wrapHtml('Owner email', ownerFull.html), html: true },
  { name: 'owner-email.txt', title: 'Owner email (plain text) — full lead', body: ownerTextFull, html: false },
  { name: 'auto-reply.html', title: 'Customer auto-reply', body: wrapHtml('Auto reply', autoFull.html), html: true },
  { name: 'review-request.html', title: 'Review request email', body: wrapHtml('Review request', reviewFull.html), html: true },
  { name: 'telegram-alert-new.txt', title: 'Telegram alert — new', body: renderAlertHuman({ business, lead: fullLead, view: 'new', reviewResult: null }), html: false },
  { name: 'telegram-alert-contacted.txt', title: 'Telegram alert — contacted', body: renderAlertHuman({ business, lead: fullLead, view: 'contacted', reviewResult: null }), html: false },
  { name: 'telegram-alert-confirm.txt', title: 'Telegram alert — confirm', body: renderAlertHuman({ business, lead: fullLead, view: 'confirm', reviewResult: null }), html: false },
  { name: 'telegram-alert-done.txt', title: 'Telegram alert — done', body: renderAlertHuman({ business, lead: fullLead, view: 'done', reviewResult: 'sent' }), html: false },
];

for (const f of files) write(f.name, f.body);

let index = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Previews</title></head><body style="font:14px Arial,Helvetica,sans-serif">\n<h1>Previews</h1>\n';
for (const f of files) {
  index += `<h2>${esc(f.title)} — <a href="${esc(f.name)}">${esc(f.name)}</a></h2>\n`;
  index += f.html
    ? `<iframe src="${esc(f.name)}" width="640" height="420" style="border:1px solid #ccc"></iframe>\n`
    : `<pre>${esc(f.body)}</pre>\n`;
}
index += '<h2>Minimal lead — telegram alert preview (text)</h2>\n';
index += `<pre>${esc(renderAlertHuman({ business, lead: minimalLead, view: 'new', reviewResult: null }))}</pre>\n`;
index += '<h2>Minimal lead — owner email (plain text)</h2>\n';
index += `<pre>${esc(ownerEmail({ business, lead: minimalLead }).text)}</pre>\n`;
index += '</body></html>\n';
write('index.html', index);
