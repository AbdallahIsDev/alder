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
import { LAYOUT_MARKER, HEADER_END, fitName } from '../lib/email-layout.js';

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
  selfCheckEmail: [opsDay, '2026-11-07', business],
  digestEmail: [digestDay, '2026-11-07', business],
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

/* L6: header = the COMPANY's logo + name for every company-facing and
   customer-facing email; the operator alarm uses the platform. The footer is
   the only place the two audiences differ. */
{
  const bad = [];
  const head = (html) => {
    const at = String(html).indexOf(HEADER_END);
    return at === -1 ? '' : String(html).slice(0, at);
  };
  const cases = [
    ['ownerEmail', 'Alder Roofing', 'Lead Alerts'],
    ['selfCheckEmail', 'Alder Roofing', 'Lead Alerts'],
    ['digestEmail', 'Alder Roofing', 'Lead Alerts'],
    ['operatorAlarmEmail', 'Lead Alerts', 'Lead Alerts'],
    ['autoReply', 'Alder Roofing', 'Alder Roofing'],
    ['reviewEmail', 'Alder Roofing', 'Alder Roofing'],
  ];
  for (const [name, headerName, footerName] of cases) {
    const out = EMAIL_BUILDERS[name](...FIXTURES[name]);
    const h = head(out.html);
    if (!out.html.includes('cid:brand-logo')) bad.push(`${name}:logo`);
    if (!h.includes(`>${headerName}<`)) bad.push(`${name}:header`);
    if (!out.html.includes(`Sent by ${footerName}`)) bad.push(`${name}:footer`);
  }
  line(bad.length === 0, 'L6', 'company header everywhere, platform only on the operator alarm',
    bad.length ? bad.join(',') : `${cases.length} builders checked`);
}

/* L6b: a company email with no business must not fall back silently. */
{
  const orig = console.error;
  const seen = [];
  console.error = (...a) => seen.push(a.join(' '));
  try {
    EMAIL_BUILDERS.digestEmail(digestDay, '2026-11-07');
    EMAIL_BUILDERS.selfCheckEmail(opsDay, '2026-11-07');
  } finally {
    console.error = orig;
  }
  line(seen.filter((x) => x.includes('email_business_missing')).length === 2, 'L6b',
    'missing business logs email_business_missing', `logs=${seen.length}`);
}

/* L7: the header marker exists exactly once, so L6 cannot silently split on
   nothing and pass. */
{
  const bad = [];
  for (const name of Object.keys(EMAIL_BUILDERS).sort()) {
    const out = EMAIL_BUILDERS[name](...FIXTURES[name]);
    const n = (out.html.split(HEADER_END).length - 1);
    if (n !== 1) bad.push(`${name}:${n}`);
  }
  line(bad.length === 0, 'L7', 'every email has exactly one header marker',
    bad.length ? bad.join(',') : `${Object.keys(EMAIL_BUILDERS).length} builders`);
}

/* L8: long names. Multi-word names wrap; a single long token is truncated;
   HTML characters are escaped; non-ASCII survives. */
{
  const longWords = 'Northwest Metropolitan Roofing and Exteriors';
  const oneToken = 'A'.repeat(40);
  const htmlChars = 'Smith & Sons <Roofing>';
  const rtl = 'شركة السقوف';
  const fit = fitName(longWords);
  const fitOne = fitName(oneToken);
  const esc1 = fitName(htmlChars);
  const outHtml = EMAIL_BUILDERS.autoReply({ business: { ...business, name: htmlChars }, lead }).html;
  const outRtl = EMAIL_BUILDERS.autoReply({ business: { ...business, name: rtl }, lead }).html;
  const outToken = EMAIL_BUILDERS.autoReply({ business: { ...business, name: oneToken }, lead }).html.split(HEADER_END)[0];
  const ok = outToken.includes('A'.repeat(27) + '…') && !outToken.includes('A'.repeat(28))
    && fit === longWords
    && fitOne.length === 28 && fitOne.endsWith('…')
    && esc1 === htmlChars
    && outHtml.includes('Smith &amp; Sons &lt;Roofing&gt;')
    && outRtl.includes(rtl)
    && !outHtml.includes('white-space:nowrap');
  line(ok, 'L8', 'names wrap, long tokens truncate, HTML escapes, non-ASCII survives',
    `fit=${fit === longWords} token=${fitOne.length} rtl=${outRtl.includes(rtl)}`);
}

/* L9: stripEmoji removes the emoji and one space, never the indentation that
   digest and self-check bodies rely on. */
{
  const { stripEmoji } = await import('../lib/email-builders.js');
  const before = '  ❌ 2 alerts failed\n    indented detail\n📨 Alerts delivered: 3';
  const after = stripEmoji(before);
  const ok = after === '  2 alerts failed\n    indented detail\nAlerts delivered: 3';
  line(ok, 'L9', 'stripEmoji keeps intentional indentation',
    `after=${JSON.stringify(after)}`);
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
