// scripts/preview.mjs — renders current copy builders to files for human review.
// Reads NO environment, opens NO network connection (unless --serve, which binds
// 127.0.0.1:4173 and serves ONLY _debug/previews and dist/), touches NO database.
// Usage: node scripts/preview.mjs [--serve]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  ownerEmail, autoReply, reviewEmail, renderAlert, renderLeadList,
  botLinkedText, BOT_HELP, BOT_ALREADY_CONNECTED, BOT_NOT_CONNECTED, BOT_PLAIN_TEXT,
  reviewLandingPage, botInviteText, botRecipientsText, recipientConfirmText,
  operatorCodeText, botForwardText,
} from '../lib/content.js';
import { digestText } from '../api/digest.js';
import { selfCheckText } from '../lib/ops-copy.js';
import { selfCheckEmail, digestEmail } from '../lib/email-builders.js';
import { renderMessage } from '../lib/sample-texts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '_debug', 'previews');
const serve = process.argv.includes('--serve');

// Clear stale outputs first — but ONLY inside this repo's _debug/previews.
// Never touch its contents outside that folder, and never the parent itself.
{
  const target = OUT;
  const expectedParent = path.resolve(ROOT, '_debug', 'previews');
  if (target !== expectedParent) {
    console.error('preview: output dir does not match _debug/previews; aborting without deleting anything.');
    process.exit(1);
  }
  if (!target.startsWith(path.resolve(ROOT) + path.sep)) {
    console.error('preview: output dir is outside the repo; aborting without deleting anything.');
    process.exit(1);
  }
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const p = path.join(target, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) fs.rmSync(p, { recursive: true, force: true });
    else fs.unlinkSync(p);
  }
}

const business = {
  id: '00000000-0000-0000-0000-000000000001',
  slug: 'alder-demo',
  name: 'Alder Roofing',          // demo business name; consistent with test fixtures
  status: 'demo',
  timezone: 'America/Chicago',
  owner_email: 'owner@alder-demo.example',
  google_review_url: 'https://example.com/google-review',
};

const cleanLead = {
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
  notes: 'Roof leaks around the chimney after rain.\nReally need it checked before it gets worse.',
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

const stressLead = {
  id: '00000000-0000-0000-0000-000000000004',
  name: 'Stress <b>Test</b> & "Co"',
  phone: '(555) 501-2345',
  email: 'stress@example.com',
  zip: '50265',
  service: 'storm',
  home: 'house',
  timing: 'month',
  roof_age: 'Over 20 years',
  insurance_claim: true,
  notes: '<b>hail</b> & "quotes" </q> on a line\nsecond <i>line</i>',
};

const token = 'sample-review-token-0123456789abcdef';
const siteUrl = 'http://127.0.0.1:4173';

// The real emails carry the logo as a CID inline image (cid:brand-logo,
// attached by lib/mail.js). In this gallery only, rewrite it to a data URI
// so the logo shows in a browser. The hosted PNGs in assets/email/ are
// used here and nowhere else in production email.
const logoDataUri = 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'assets', 'email', 'logo-on-dark.png')).toString('base64');
const withLogo = (html) => String(html).replaceAll('cid:brand-logo', logoDataUri);

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

const files = [];
const add = (name, title, body, html) => { files.push({ name, title, body, html }); };

for (const v of ['O1']) {
  add(`owner-email-${v}-clean.html`, `Owner email — CLEAN lead`, wrapHtml(`Owner email`, withLogo(ownerEmail({ business, lead: cleanLead }).html)), true);
  add(`owner-email-${v}-minimal.html`, `Owner email — MINIMAL lead`, wrapHtml(`Owner email`, withLogo(ownerEmail({ business, lead: minimalLead }).html)), true);
}
add('owner-email-stress.html', 'Owner email — STRESS lead', wrapHtml('Owner email', withLogo(ownerEmail({ business, lead: stressLead }).html)), true);
add('owner-email.txt', 'Owner email (plain text) — full lead', ownerEmail({ business, lead: cleanLead }).text, false);
add('auto-reply.html', 'Customer auto-reply', wrapHtml('Auto reply', withLogo(autoReply({ business, lead: cleanLead }).html)), true);
add('review-request.html', 'Review request email (five stars)', wrapHtml('Review request', withLogo(reviewEmail({ business, token, siteUrl }).html)), true);
add('telegram-alert-new.txt', 'Telegram alert — new', renderAlert({ business, lead: cleanLead, view: 'new', reviewResult: null }), false);
add('telegram-alert-contacted.txt', 'Telegram alert — contacted', renderAlert({ business, lead: cleanLead, view: 'contacted', reviewResult: null }), false);
add('telegram-alert-confirm.txt', 'Telegram alert — confirm', renderAlert({ business, lead: cleanLead, view: 'confirm', reviewResult: null }), false);
add('telegram-alert-done.txt', 'Telegram alert — done (review sent)', renderAlert({ business, lead: cleanLead, view: 'done', reviewResult: 'sent' }), false);
add('telegram-alert-done-no-email.txt', 'Telegram alert — done (no email)', renderAlert({ business, lead: { ...cleanLead, email: '' }, view: 'done', reviewResult: 'no_email' }), false);
add('telegram-alert-error.txt', 'Telegram alert — error (Try again)', renderAlert({ business, lead: cleanLead, view: 'error', reviewResult: 'failed' }), false);
add('telegram-alert-repeat.txt', 'Telegram alert — possible repeat', renderAlert({ business, lead: cleanLead, view: 'new', reviewResult: null, duplicate: true }), false);
// The daily digest is counts only, so this is the whole message for both
// channels: Telegram sends it as-is, the email fallback wraps the same text.
add('digest.txt', 'Daily digest — Telegram and email', digestText({ newLeads: 4, repeats: 1, untouched: 2, failed: 0 }, '2026-11-07'), false);
add('digest-attention.txt', 'Daily digest — with a failure', digestText({ newLeads: 4, repeats: 1, untouched: 2, failed: 2 }, '2026-11-07'), false);
add('digest.html', 'Daily digest email', wrapHtml('Daily digest', withLogo(digestEmail({ newLeads: 4, repeats: 1, untouched: 2, failed: 0 }, '2026-11-07').html)), true);
// The self-check has two audiences. A demo business is the operator's own and may
// see the redirect warning; an active client never does.
const opsDay = { created: 3, tg_sent: 3, email_owner_sent: 3, tg_failed: 1, email_owner_failed: 0, autoreply_failed: 1, review_request_failed: 0 };
add('selfcheck-demo.txt', 'Alert check — demo business (operator)', selfCheckText(opsDay, { redirectActive: true, operator: true }), false);
add('selfcheck-active.txt', 'Alert check — active client', selfCheckText(opsDay, { redirectActive: true, operator: false }), false);
add('selfcheck-demo.html', 'Alert check email — demo business', wrapHtml('Alert check', withLogo(selfCheckEmail(opsDay, '2026-11-07', { redirectActive: true, operator: true }).html)), true);
add('selfcheck-active.html', 'Alert check email — active client', wrapHtml('Alert check', withLogo(selfCheckEmail(opsDay, '2026-11-07', { redirectActive: true, operator: false }).html)), true);
// Recipients: /invite, /recipients and the remove confirmation. Plain text, one
// business per chat, no names — the list is "Recipient N" unless a label is set.
add('telegram-invite.txt', 'Telegram /invite (deep link; [[link]] and [[code]] show entities)', renderMessage(botInviteText('K7M2QPX9RT4W', { username: 'alder_alerts_bot' })), false);
add('telegram-invite-fallback.txt', 'Telegram /invite (no username)', renderMessage(botInviteText('K7M2QPX9RT4W')), false);
add('telegram-code.txt', 'Telegram /code: operator line + client message', [renderMessage(operatorCodeText({ slug: 'alder-demo', code: 'K7M2QPX9RT4W' })), renderMessage(botForwardText({ code: 'K7M2QPX9RT4W', username: 'alder_alerts_bot' }))].join('\n\n---\n\n'), false);
add('telegram-recipients.txt', 'Telegram /recipients', botRecipientsText([
  { id: 'r1', label: null },
  { id: 'r2', label: null },
  { id: 'r3', label: 'Office' },
]), false);
add('telegram-recipient-confirm.txt', 'Telegram remove confirmation', recipientConfirmText({ id: 'r2', label: null }, 1), false);

add('telegram-leads.txt', 'Telegram /leads list', renderLeadList([
  { name: 'Daniel Whitaker', service: 'repair', phone: '+15155550142', status: 'contacted', created_at: new Date(Date.now() - 41 * 60000).toISOString() },
  { name: 'Maria Lopez', service: 'storm', phone: '5550102345', status: 'open', created_at: new Date(Date.now() - 1500 * 60000).toISOString() },
  { name: 'A customer with a very long name that must be truncated', service: 'unsure', phone: '+201005408345', status: 'done', created_at: new Date(Date.now() - 5000 * 60000).toISOString() },
]), false);
add('telegram-bot-copy.txt', 'Telegram bot copy (linked/help/already/unconnected/plain)',
  [botLinkedText(business.name), BOT_HELP, BOT_ALREADY_CONNECTED, BOT_NOT_CONNECTED, BOT_PLAIN_TEXT].join('\n\n---\n\n'), false);
// Landing pages with a stubbed Google URL on 127.0.0.1 so the redirect can be seen
// without leaving the machine.
const STUB_GOOGLE = 'https://g.page/stub';
for (const [q, n] of [['s1', 1], ['s5', 5], ['go', 0]]) {
  add(`review-landing-${q}.html`, `Review landing page (?${q === 'go' ? 'go=1' : 's=' + n})`, reviewLandingPage({ business, token, googleUrl: STUB_GOOGLE, stars: n }) , true);
}
add('review-landing-unavailable.html', 'Review landing page (unavailable link)', reviewLandingPage({ business, token, googleUrl: 'http://evil.example', stars: 3 }), true);

for (const f of files) write(f.name, f.body);

let index = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Previews</title>
<style>body{font:15px/1.5 Arial,Helvetica,sans-serif;margin:0 auto;max-width:1100px;padding:24px}h1{font:700 24px Arial}
h2{font:700 18px Arial;margin:34px 0 8px} .cap{color:#555;margin:0 0 14px;max-width:70ch}
.cols{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px} .col iframe{border:1px solid #ccc;background:#eee}
iframe{border:1px solid #ccc;background:#eee} pre{border:1px solid #ddd;padding:12px;background:#fafafa;max-width:70ch;white-space:pre-wrap}
.dark iframe{filter:invert(1) hue-rotate(180deg)}
@media (max-width:900px){.cols{grid-template-columns:1fr}}</style></head><body>
<h1>Previews</h1>
<p>Static gallery of every email and Telegram message the system can send. When run with
<b>--serve</b> this page is served at <b>http://127.0.0.1:4173</b> and the fonts and logos load
from that origin. The redirect target of the review landing pages is a stub, so it stays on
this machine.</p>
<label><input type="checkbox" id="dark"> Simulate dark mode</label>
<p style="color:#555">Rough approximation of mail-app dark-mode inversion (invert + hue-rotate); not a real dark mode.</p>
<script>document.getElementById('dark').addEventListener('change',function(){document.body.classList.toggle('dark',this.checked);});</script>
`;

// Owner variants side-by-side REMOVED: there is one design now.
index += '<h2>Owner email — CLEAN lead</h2>\n'
  + '<p class="cap">The same lead in the current owner-email design.</p>'
  + '<p class="cap">Desktop width</p><iframe src="owner-email-O1-clean.html" width="640" height="420"></iframe>'
  + '<p class="cap">Phone width</p><iframe src="owner-email-O1-clean.html" width="375" height="420"></iframe>\n';
index += '<p class="cap">MINIMAL lead: a customer who filled only the required fields, to check the layout when email and notes are empty. This lead has no email, so only the Call button appears.</p>\n'
  + '<iframe src="owner-email-O1-minimal.html" width="640" height="420"></iframe>\n';
index += '<p class="cap">STRESS lead: weird characters on purpose, proves nothing a customer types can break the email.</p>\n'
  + '<iframe src="owner-email-stress.html" width="640" height="420"></iframe>\n';
index += '<h2>Customer auto-reply</h2><p class="cap">Sent to the customer right after their request lands. NO time promise and no studio name — only the roofer\'s business name.</p>\n'
  + '<iframe src="auto-reply.html" width="640" height="420"></iframe>\n';
index += '<h2>Review request email (five stars)</h2><p class="cap">Five hollow stars that open the landing page pre-selecting that rating.</p>\n'
  + '<iframe src="review-request.html" width="640" height="420"></iframe>\n';
index += '<h2>Review landing page</h2><p class="cap">Opened from the email. Opening it writes NOTHING to the database (mail scanners open every link); the page\'s JavaScript records the rating and the Google click, then sends you to Google.</p>\n'
  + '<iframe src="review-landing-s1.html" width="640" height="700"></iframe>\n'
  + '<iframe src="review-landing-s5.html" width="640" height="700"></iframe>\n'
  + '<iframe src="review-landing-go.html" width="640" height="700"></iframe>\n'
  + '<iframe src="review-landing-unavailable.html" width="640" height="700"></iframe>\n';
index += '<h2>Telegram alerts (text)</h2>\n'
  + '<p class="cap">Telegram: lead just arrived</p><pre>' + esc(files.find((f) => f.name === 'telegram-alert-new.txt').body) + '</pre>\n'
  + '<p class="cap">Telegram: roofer tapped Contacted</p><pre>' + esc(files.find((f) => f.name === 'telegram-alert-contacted.txt').body) + '</pre>\n'
  + '<p class="cap">Telegram: asked to confirm before emailing the customer</p><pre>' + esc(files.find((f) => f.name === 'telegram-alert-confirm.txt').body) + '</pre>\n'
  + '<p class="cap">Telegram: finished, review request sent</p><pre>' + esc(files.find((f) => f.name === 'telegram-alert-done.txt').body) + '</pre>\n'
  + '<p class="cap">Telegram: finished, no email on file (nothing was sent)</p><pre>' + esc(files.find((f) => f.name === 'telegram-alert-done-no-email.txt').body) + '</pre>\n'
  + '<p class="cap">Telegram: review email failed — one "Try again" button (r:) resends it with the existing token</p><pre>' + esc(files.find((f) => f.name === 'telegram-alert-error.txt').body) + '</pre>\n'
  + '<p class="cap">Telegram: the same phone or email asked before — one extra line, never the earlier lead\'s details</p><pre>' + esc(files.find((f) => f.name === 'telegram-alert-repeat.txt').body) + '</pre>\n'
  + '<p class="cap">Telegram: /invite — one single-use code, as a tappable deep link plus the plain code</p><pre>' + esc(files.find((f) => f.name === 'telegram-invite.txt').body) + '</pre>\n'
  + '<p class="cap">Telegram: /invite when getMe() is unavailable — same copy, /start plus the code, still real line breaks</p><pre>' + esc(files.find((f) => f.name === 'telegram-invite-fallback.txt').body) + '</pre>\n'
  + '<p class="cap">Telegram: /recipients — every phone on this business, one Remove button each</p><pre>' + esc(files.find((f) => f.name === 'telegram-recipients.txt').body) + '</pre>\n'
  + '<p class="cap">Telegram: removing a phone asks once, and the last one cannot be removed</p><pre>' + esc(files.find((f) => f.name === 'telegram-recipient-confirm.txt').body) + '</pre>\n'
  + '<p class="cap">Daily digest (13:00 UTC cron, off by default): counts only, no names, no addresses — the same text is safe by email</p><pre>' + esc(files.find((f) => f.name === 'digest.txt').body) + '</pre>\n'
  + '<p class="cap">The same digest when something failed: one extra section, in plain words, no internal event names</p><pre>' + esc(files.find((f) => f.name === 'digest-attention.txt').body) + '</pre>\n'
  + '<p class="cap">Alert check, demo business (operator): problems first, then the counts, then the redirect warning in a separate block</p><pre>' + esc(files.find((f) => f.name === 'selfcheck-demo.txt').body) + '</pre>\n'
  + '<p class="cap">Alert check, active client: its own counts only — no redirect warning, no setting names</p><pre>' + esc(files.find((f) => f.name === 'selfcheck-active.txt').body) + '</pre>\n'  + '<p class="cap">Telegram: /leads list (spaced format)</p><pre>' + esc(files.find((f) => f.name === 'telegram-leads.txt').body) + '</pre>\n'
  + '<p class="cap">Telegram: bot copy — linked, help, already connected, not connected, plain-text hint</p><pre>' + esc(files.find((f) => f.name === 'telegram-bot-copy.txt').body) + '</pre>\n';
index += '<h2>Owner email (plain text)</h2>\n<pre>' + esc(files.find((f) => f.name === 'owner-email.txt').body) + '</pre>\n';
index += '<h2>Operations emails</h2>\n'
  + '<p class="cap">The scheduled messages now use the same shell as the product emails: same logo (a CID inline image, so it is referenced rather than left dangling as an attachment), same header band, same footer and padding. Only the content differs.</p>\n'
  + '<p class="cap">Your lead summary — nothing failed, so there is no Needs attention section at all.</p><iframe src="digest.html" width="640" height="420"></iframe>\n'
  + '<p class="cap">Alert check — demo business. Operator detail is last and clearly separated.</p><iframe src="selfcheck-demo.html" width="640" height="480"></iframe>\n'
  + '<p class="cap">Alert check — active client. Same layout, no operator detail.</p><iframe src="selfcheck-active.html" width="640" height="480"></iframe>\n';
index += '</body></html>\n';
write('index.html', index);

if (serve) {
  const MIME = { '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const roots = [OUT, path.join(ROOT, 'dist')];
    let found = null;
    for (const root of roots) {
      const cand = path.join(root, url === '/' ? 'index.html' : url.replace(/^\/+/, ''));
      if (cand.startsWith(root) && fs.existsSync(cand) && fs.statSync(cand).isFile()) { found = cand; break; }
    }
    if (!found) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found\n'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(found)] || 'application/octet-stream' });
    fs.createReadStream(found).pipe(res);
  });
  server.listen(4173, '127.0.0.1', () => {
    console.log('serving http://127.0.0.1:4173/ (only _debug/previews and dist/ are reachable)');
  });
}
