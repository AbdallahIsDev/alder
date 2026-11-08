// tests/email-layout.test.mjs — one shell for every email, enforced.
//
// The reported symptom was an email with a stray "logo.png" attachment card:
// lib/mail.js attaches the logo as a CID inline image for every send, but the
// ops emails built a bare <pre> that never referenced it. A mail client shows an
// unreferenced inline attachment as an attachment.
//
// Two rules, both checkable without asserting on copy:
//   1. every builder in the registry produces HTML that came out of shell()
//      (asserted on LAYOUT_MARKER, not on wording)
//   2. every module that calls sendMail() imports the registry, so a new sender
//      that hand-rolls its own HTML fails this suite instead of shipping

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMAIL_BUILDERS } from '../lib/email-builders.js';
import { LAYOUT_MARKER } from '../lib/email-layout.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let total = 0;
let failed = 0;
function line(ok, id, name, detail = '') {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? `  (${detail})` : ''}`);
}

const business = {
  id: '00000000-0000-0000-0000-000000000001',
  slug: 'alder-demo', name: 'Alder Roofing', status: 'demo',
  timezone: 'America/Chicago', owner_email: 'owner@example.com',
  google_review_url: 'https://example.com/review',
};
const lead = {
  id: '00000000-0000-0000-0000-000000000002',
  name: 'Test Customer', phone: '5555012345', email: 'customer@example.com',
  zip: '50265', service: 'repair', home: 'house', timing: 'asap',
  roof_age: '10 to 20 years', insurance_claim: false, notes: '',
  status: 'open', created_at: new Date().toISOString(),
};
const opsDay = { created: 3, tg_sent: 2, email_owner_sent: 1, tg_failed: 1, email_owner_failed: 0, autoreply_failed: 0, review_request_failed: 0 };
const digestDay = { newLeads: 4, repeats: 1, untouched: 2, failed: 0 };

/* One fixture per builder. A builder added to the registry without a fixture
   here fails L1 as "not covered", which is the point: the list is the contract. */
const FIXTURES = {
  ownerEmail: [{ business, lead }],
  autoReply: [{ business, lead }],
  reviewEmail: [{ business, token: 'test-token', siteUrl: 'http://127.0.0.1:3000' }],
  selfCheckEmail: [opsDay, '2026-11-07'],
  digestEmail: [digestDay, '2026-11-07'],
  operatorAlarmEmail: ['⚠️ Needs attention\nalder-demo: 1 alert could not be delivered', '2026-11-07'],
};

/* L1: every registered builder, and only registered ones, produces shell HTML. */
{
  const names = Object.keys(EMAIL_BUILDERS).sort();
  const fixtures = Object.keys(FIXTURES).sort();
  const missing = names.filter((n) => !fixtures.includes(n));
  const extra = fixtures.filter((n) => !names.includes(n));
  const bad = [];
  for (const name of names) {
    const args = FIXTURES[name];
    if (!args) continue;
    const out = EMAIL_BUILDERS[name](...args);
    if (!out || typeof out.html !== 'string' || !out.html.includes(LAYOUT_MARKER)) bad.push(name);
    if (!out || typeof out.text !== 'string' || !out.text.trim()) bad.push(`${name}:text`);
  }
  line(missing.length === 0 && extra.length === 0 && bad.length === 0, 'L1',
    'every email builder produces HTML from the shared layout',
    `builders=${names.length} missing=${missing.join(',') || 'none'} extra=${extra.join(',') || 'none'} bad=${bad.join(',') || 'none'}`);
}

/* L2: the logo is referenced, not left dangling. This is the exact regression:
   an attached logo that no tag points at is shown as a stray attachment. */
{
  const out = EMAIL_BUILDERS.selfCheckEmail(opsDay, '2026-11-07', { redirectActive: true, operator: true });
  const refs = (out.html.match(/cid:brand-logo/g) || []).length;
  line(refs > 0 && !out.html.includes('<pre'), 'L2',
    'ops email references the inline logo and has no bare <pre>',
    `cid-refs=${refs} pre=${out.html.includes('<pre')}`);
}

/* L3: the detector itself says no. Without this, L1 could pass because the
   marker test is vacuous. */
{
  const looksLikeLayout = (html) => String(html || '').includes(LAYOUT_MARKER);
  line(looksLikeLayout(`<body ${LAYOUT_MARKER}></body>`) === true
    && looksLikeLayout('<pre style="font:13px monospace">x</pre>') === false, 'L3',
    'the layout check accepts shell output and rejects a hand-rolled body', '');
}

/* L4: no module calls sendMail() without importing the registry. lib/mail.js is
   the definition itself, so it is the one allowed exception. */
{
  const files = [];
  for (const dir of ['lib', 'api']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      if (f.endsWith('.js')) files.push(path.join(dir, f));
    }
  }
  const offenders = [];
  for (const rel of files) {
    // Comments mention sendMail() by name; only code counts. Strip both forms
    // before looking, or this test would flag its own documentation.
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    if (!/\bsendMail\s*\(/.test(src)) continue;
    if (rel === path.join('lib', 'mail.js')) continue;
    if (rel === path.join('lib', 'email-builders.js')) continue;
    if (/from '[^']*email-builders\.js'/.test(src)) continue;
    offenders.push(rel);
  }
  line(offenders.length === 0, 'L4',
    'every sendMail() caller imports the builder registry',
    offenders.length ? offenders.join(',') : `scanned ${files.length} files`);
}

/* L5: no email carries an emoji. Telegram keeps its own; the email variant is
   stripped at the builder boundary, so this walks subject, text and HTML. */
{
  const PICTO = /\p{Extended_Pictographic}/u;
  const bad = [];
  for (const name of Object.keys(EMAIL_BUILDERS).sort()) {
    const out = EMAIL_BUILDERS[name](...FIXTURES[name]);
    for (const part of ['subject', 'text', 'html']) {
      const v = String(out[part] || '');
      if (PICTO.test(v) || /[\uFE0F\u200D]/.test(v)) bad.push(`${name}:${part}`);
    }
  }
  line(bad.length === 0, 'L5', 'no email subject, text or html carries an emoji',
    bad.length ? bad.join(',') : `${Object.keys(EMAIL_BUILDERS).length} builders clean`);
}

/* L6: header = logo + brand name as text; footer names the right brand.
   Owner/operator emails use the platform; customer emails use the company. */
{
  const bad = [];
  const build = (name) => EMAIL_BUILDERS[name](...FIXTURES[name]);
  // Everything before the body cell is header: the <style> block is long.
  const head = (html) => String(html).split('<td style="padding:24px 24px"')[0];
  const cases = [
    ['ownerEmail', 'Lead Alerts', 'Lead Alerts', true],
    ['selfCheckEmail', 'Lead Alerts', 'Lead Alerts', true],
    ['digestEmail', 'Lead Alerts', 'Lead Alerts', true],
    ['operatorAlarmEmail', 'Lead Alerts', 'Lead Alerts', true],
    ['autoReply', 'Alder Roofing', 'Alder Roofing', false],
    ['reviewEmail', 'Alder Roofing', 'Alder Roofing', false],
  ];
  for (const [name, headerName, footerName, platform] of cases) {
    const out = build(name);
    const h = head(out.html);
    if (!out.html.includes('cid:brand-logo')) bad.push(`${name}:logo`);
    if (!h.includes(`>${headerName}<`)) bad.push(`${name}:header`);
    if (!out.html.includes(`Sent by ${footerName}`)) bad.push(`${name}:footer`);
    if (platform && h.includes('Alder Roofing')) bad.push(`${name}:company-in-header`);
  }
  line(bad.length === 0, 'L6', 'every header has logo + name, footer names the right brand',
    bad.length ? bad.join(',') : `${cases.length} builders checked`);
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
