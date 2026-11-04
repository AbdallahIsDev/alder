// scripts/preview.mjs — renders current copy builders to files for human review.
// Reads NO environment, opens NO network connection (unless --serve, which binds
// 127.0.0.1:4173 and serves ONLY _debug/previews and dist/), touches NO database.
// Usage: node scripts/preview.mjs [--serve]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  ownerEmail, autoReply, reviewEmail, renderAlert, reviewLandingPage,
} from '../lib/content.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '_debug', 'previews');
const serve = process.argv.includes('--serve');

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

for (const v of ['O1', 'O2', 'O3']) {
  add(`owner-email-${v}-clean.html`, `Owner email ${v} — CLEAN lead`, wrapHtml(`Owner email ${v}`, ownerEmail({ business, lead: cleanLead, variant: v }).html), true);
  add(`owner-email-${v}-minimal.html`, `Owner email ${v} — MINIMAL lead`, wrapHtml(`Owner email ${v}`, ownerEmail({ business, lead: minimalLead, variant: v }).html), true);
}
add('owner-email-stress.html', 'Owner email — STRESS lead', wrapHtml('Owner email', ownerEmail({ business, lead: stressLead, variant: 'O1' }).html), true);
add('owner-email.txt', 'Owner email (plain text) — full lead', ownerEmail({ business, lead: cleanLead }).text, false);
add('auto-reply.html', 'Customer auto-reply', wrapHtml('Auto reply', autoReply({ business, lead: cleanLead }).html), true);
add('review-request-R1.html', 'Review request — R1 (button)', wrapHtml('Review request', reviewEmail({ business, token, siteUrl, variant: 'R1' }).html), true);
add('review-request-R2.html', 'Review request — R2 (stars)', wrapHtml('Review request', reviewEmail({ business, token, siteUrl, variant: 'R2' }).html), true);
add('telegram-alert-new.txt', 'Telegram alert — new', renderAlert({ business, lead: cleanLead, view: 'new', reviewResult: null }), false);
add('telegram-alert-contacted.txt', 'Telegram alert — contacted', renderAlert({ business, lead: cleanLead, view: 'contacted', reviewResult: null }), false);
add('telegram-alert-confirm.txt', 'Telegram alert — confirm', renderAlert({ business, lead: cleanLead, view: 'confirm', reviewResult: null }), false);
add('telegram-alert-done.txt', 'Telegram alert — done', renderAlert({ business, lead: cleanLead, view: 'done', reviewResult: 'sent' }), false);
// Landing pages with a stubbed Google URL on 127.0.0.1 so the redirect can be seen
// without leaving the machine (a loopback URL is not allowlisted, so inject via a
// local stub — use a google-shaped display URL instead).
const STUB_GOOGLE = 'https://g.page/stub';
for (const [q, n] of [['s1', 1], ['s5', 5], ['go', 0]]) {
  add(`review-landing-${q}.html`, `Review landing page (?${q === 'go' ? 'go=1' : 's=' + n})`, reviewLandingPage({ business, token, googleUrl: STUB_GOOGLE, stars: n }) , true);
}

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

// Side-by-side owner variants for the CLEAN lead
index += '<h2>Owner email — three variants side by side (CLEAN lead)</h2>\n'
  + '<p class="cap">The same lead in the three available owner-email designs. O1 is the default (dark brand band), O2 is the light version (accent bar on top, light body), O3 paints the whole header with the accent colour. Changing the variant is a one-line constant (docs/EMAIL_SYSTEM.md).</p><div class="cols">';
for (const v of ['O1', 'O2', 'O3']) {
  index += `<div class="col"><h3 style="margin:8px 0">${v}</h3>`
    + `<p class="cap">Desktop width</p><iframe src="owner-email-${v}-clean.html" width="640" height="420"></iframe>`
    + `<p class="cap">Phone width</p><iframe src="owner-email-${v}-clean.html" width="375" height="420"></iframe></div>`;
}
index += '</div>';
index += '<p class="cap">MINIMAL lead: a customer who filled only the required fields, to check the layout when email and notes are empty.</p><div class="cols">';
for (const v of ['O1', 'O2', 'O3']) {
  index += `<div class="col"><h3 style="margin:8px 0">${v} (minimal)</h3>`
    + `<iframe src="owner-email-${v}-minimal.html" width="640" height="420"></iframe></div>`;
}
index += '</div>';
index += '<p class="cap">STRESS lead: weird characters on purpose, proves nothing a customer types can break the email.</p>\n'
  + '<iframe src="owner-email-stress.html" width="640" height="420"></iframe>\n';
index += '<h2>Customer auto-reply</h2><p class="cap">Sent to the customer right after their request lands. NO time promise and no studio name — only the roofer\'s business name.</p>\n'
  + '<iframe src="auto-reply.html" width="640" height="420"></iframe>\n';
index += '<h2>Review request email — R1 (button)</h2><p class="cap">One button that opens the review landing page. No private-feedback sentences and no incentives.</p>\n'
  + '<iframe src="review-request-R1.html" width="640" height="420"></iframe>\n';
index += '<h2>Review request email — R2 (stars)</h2><p class="cap">Five hollow stars that open the landing page pre-selecting that rating.</p>\n'
  + '<iframe src="review-request-R2.html" width="640" height="420"></iframe>\n';
index += '<h2>Review landing page</h2><p class="cap">Opened from the email. Opening it writes NOTHING to the database (mail scanners open every link); the page\'s JavaScript records the rating and the Google click, then sends you to Google.</p>\n'
  + '<iframe src="review-landing-s1.html" width="640" height="420"></iframe>\n'
  + '<iframe src="review-landing-s5.html" width="640" height="420"></iframe>\n'
  + '<iframe src="review-landing-go.html" width="640" height="420"></iframe>\n';
index += '<h2>Telegram alerts (text)</h2>\n'
  + '<p class="cap">Telegram: lead just arrived</p><pre>' + esc(files.find((f) => f.name === 'telegram-alert-new.txt').body) + '</pre>\n'
  + '<p class="cap">Telegram: roofer tapped Contacted</p><pre>' + esc(files.find((f) => f.name === 'telegram-alert-contacted.txt').body) + '</pre>\n'
  + '<p class="cap">Telegram: asked to confirm before emailing the customer</p><pre>' + esc(files.find((f) => f.name === 'telegram-alert-confirm.txt').body) + '</pre>\n'
  + '<p class="cap">Telegram: finished</p><pre>' + esc(files.find((f) => f.name === 'telegram-alert-done.txt').body) + '</pre>\n';
index += '<h2>Owner email (plain text)</h2>\n<pre>' + esc(files.find((f) => f.name === 'owner-email.txt').body) + '</pre>\n';
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
