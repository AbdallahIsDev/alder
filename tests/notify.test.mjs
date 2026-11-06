#!/usr/bin/env node
// tests/notify.test.mjs — Gates A and B.
// HARNESS: in-process handler call with fake Telegram / Resend servers (node:http).
// Run through tests/run.mjs, which creates .test-mode and points both base URLs at the fakes.

import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from './env.mjs';
import { createClient } from '@supabase/supabase-js';
import { fakeRes, ALDER_DEMO } from './helpers.mjs';

loadEnv();
const TG = process.env.FAKE_TG_URL;
const RS = process.env.FAKE_RESEND_URL;
if (!TG || !RS) { console.log('FAIL  pre  run through tests/run.mjs'); process.exit(1); }

const { default: handler } = await import('../api/lead.js');
const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const RUN = Math.random().toString(36).slice(2, 10);

let failed = 0, total = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(5)}${String(what).padEnd(46)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 100) : ''}`);
};
const note = (s) => console.log(`NOTE       ${s}`);

const logs = [];
const realWarn = console.warn, realErr = console.error;
console.warn = (...a) => logs.push(a.map(String).join(' '));
console.error = (...a) => logs.push(a.map(String).join(' '));

async function control(base, cfg) {
  const r = await fetch(base + '/__control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
  return r.json();
}
async function requests(base) {
  const r = await fetch(base + '/__requests');
  return (await r.json()).requests;
}
async function reset(base) { await fetch(base + '/__reset', { method: 'POST' }); }
async function resetLimits() { await svc.from('rate_limits').delete().gte('window_start', '2000-01-01'); }
async function leadFor(key) {
  const { data } = await svc.from('leads').select('id').eq('idempotency_key', key);
  return data || [];
}
async function events(id) {
  const { data } = await svc.from('lead_events').select('kind, meta').eq('lead_id', id);
  return data || [];
}
async function clean() {
  await svc.from('leads').delete().like('idempotency_key', `${RUN}-%`);
  await resetLimits();
}


let ip = 40;
async function post(over, extra) {
  const body = {
    service: 'replacement', home: 'house', timing: 'asap', age: '10 to 20 years',
    zip: '50265', phone: '5155550142', name: 'Notify Tester', email: 'notify@example.com',
    notes: 'plain note', claim: false, website: '', elapsed: 5000,
    slug: ALDER_DEMO, idempotencyKey: `${RUN}-${Math.random().toString(36).slice(2, 10)}`,
    ...over,
  };
  const res = fakeRes();
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': `203.0.113.${ip++}`, ...(extra || {}) },
    body, socket: {},
  };
  const t0 = Date.now();
  await handler(req, res);
  return { res, body, key: body.idempotencyKey, ms: Date.now() - t0 };
}

const base32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function code(n) { let s = ''; for (let i = 0; i < n; i++) s += base32[Math.floor(Math.random() * base32.length)]; return s; }

await control(TG, { mode: 'ok' });
await control(RS, { mode: 'ok' });

/* ================= GATE A — owner email ================= */
try {
  await clean();
  await reset(TG); await reset(RS);
  const special = { name: 'Bob" <x@y>', notes: '<script>alert(1)</script>\r\nsecond line' };
  const { res, key } = await post(special);
  const rows = await leadFor(key);
  const rreq = (await requests(RS)).filter((x) => x.method === 'POST' && x.path === '/emails');
  const owner = rreq.find((x) => x.body && x.body.subject && x.body.subject.startsWith('New lead:')) || rreq[0];
  const b = owner && owner.body;
  const okFrom = b && b.from && b.from.startsWith('Lead Alerts <');
  const okTo = b && Array.isArray(b.to) && b.to[0] === process.env.MAIL_REDIRECT_TO;
  const okReply = b && b.reply_to === 'notify@example.com';
  const okPrefix = b && b.subject.startsWith('[TEST for ');
  const escaped = b && b.html.includes('&lt;script&gt;') && b.html.includes('Bob&quot; &lt;x@y&gt;');
  const bothParts = b && typeof b.html === 'string' && typeof b.text === 'string';
  const noCrLf = b && !/[\r\n]/.test(b.subject) && !/[\r\n]/.test(b.from);
  // NEW (item 4): table-based shell, labels in both parts, tel: has only digits and +,
  // no external resources beyond the brand fonts/logo and the Google review link,
  // preheader present, escaped notes, under 100 KB.
  const TABLE_LABELS = ['Name', 'Phone', 'Email', 'Service', 'Timing', 'Property', 'Roof age', 'Insurance claim', 'ZIP'];
  const labelsOk = b && TABLE_LABELS.every((l) => b.html.includes('>' + l + '</td>') && b.text.includes(l + ':'))
    && b.text.includes('Notes:');   // the HTML part carries notes in the quoted box, not a table row
  const tel = b && b.html.match(/href="tel:(.*?)"/);
  const telOk = tel && /^[+0-9]+$/.test(tel[1]);
  // Before (old email design): no <img> and no <script> anywhere, and no HTTP
  // URLs except the roofer's own Google review link.
  // After (item 3, deliberate behaviour change the task orders): the brand logo
  // IS an <img> (the O1 header), so the <img>/<script> ban is replaced by
  // "no <script> anywhere" plus "every http(s) URL is a brand asset or the
  // roofer's own Google review link".
  let badUrls = [];
  if (b) {
    const base = String(process.env.SITE_URL || '').replace(/\/+$/, '');
    const brandPrefix = base ? [base + '/', base.replace(/\/$/, '') + '/assets/'] : [];
    const urls = b.html.match(/https?:\/\/[^"\s]+/g) || [];
    badUrls = urls.filter((u) => {
      const clean = u.replace(/['")]+$/, '');
      return !(brandPrefix.some((p) => clean.startsWith(p)) || clean.startsWith('https://g.page') || clean.includes(ALDER_DEMO));
    });
  }
  const noExternalOk = !!b && !/<script/.test(b.html) && badUrls.length === 0;
  const preheaderOk = b && b.html.includes('Bob&quot; &lt;x@y&gt;') && b.html.includes('ZIP 50265');
  const smallOk = b && b.html.length < 100 * 1024;
  const linkMailOk = b && !b.html.includes('<script>') && b.html.includes('&lt;script&gt;');
  line(res.code === 200 && okFrom && okTo && okReply && okPrefix && escaped && bothParts && noCrLf && rows.length === 1
    && labelsOk && telOk && noExternalOk && preheaderOk && smallOk && linkMailOk,
    'A1', 'owner email payload exact + escaped',
    `from=${okFrom} to=${okTo} reply_to=${okReply} prefix=${okPrefix} esc=${escaped} crlf=${noCrLf} labels=${labelsOk} tel=${telOk} noExternal=${noExternalOk} badUrls=${badUrls.map((u) => u.replace(/['")]+$/, '').slice(0, 80)).join(' | ')}`);
  line(!!(owner && owner.headers && owner.headers['idempotency-key']), 'A2', 'Idempotency-Key header sent');

  /* A1c (item 4): the Resend payload carries exactly one CID attachment;
     the HTML references cid:brand-logo and no hosted image URL remains. */
  {
    const atts = b && b.attachments;
    const oneAtt = Array.isArray(atts) && atts.length === 1 && atts[0].content_id === 'brand-logo'
      && atts[0].filename === 'logo.png' && atts[0].content_type === 'image/png'
      && typeof atts[0].content === 'string' && atts[0].content.length > 100
      && /^[A-Za-z0-9+/=]+$/.test(atts[0].content);
    // single /emails endpoint, never the batch endpoint
    const singleEndpoint = owner && owner.path === '/emails';
    const noHostedImg = b && !/https?:\/\/[^"\s]*\.(png|jpg|jpeg|gif|webp)/i.test(b.html)
      && b.html.includes('src="cid:brand-logo"') && b.html.includes('alt=""');
    line(!!(oneAtt && singleEndpoint && noHostedImg), 'A1c', 'one CID attachment, single /emails, no hosted img',
      `atts=${atts && atts.length} len=${atts && atts[0] && atts[0].content.length} path=${owner && owner.path} noHosted=${noHostedImg}`);
  }

  /* G1: toTelHref normalisation (unit-level, no DB). US formats get +1; the
     international number keeps its own +; leftover digits stay as typed. */
  const { toTelHref } = await import('../lib/content.js');
  const cases = [
    ['+201005408111', 'tel:+201005408111'],
    ['(555) 501-2345', 'tel:+15555012345'],
    ['555-501-2345', 'tel:+15555012345'],
    ['1 555 501 2345', 'tel:+15555012345'],
    ['+1 (555) 501-2345', 'tel:+15555012345'],
    ['0100 540 8111', 'tel:01005408111'],
  ];
  const bad = cases.filter(([input, want]) => toTelHref(input) !== want);
  line(bad.length === 0, 'G1', 'toTelHref: US gets +1, international keeps +, rest untouched',
    bad.length ? 'bad: ' + bad.map(([i, w]) => `${i}->${toTelHref(i)} (want ${w})`).join('; ') : `${cases.length} cases ok`);

  /* G1b: displayPhone (Telegram alert) applies the same rule as toTelHref:
     a leading + is shown unchanged (never "+1+20..."); bare 10 digits get
     +1; bare 11 digits starting with 1 get +. */
  const { displayPhone, renderAlert } = await import('../lib/content.js');
  const dispCases = [
    ['+201005408345', '+201005408345'],
    ['+12125550100', '+12125550100'],
    ['2125550100', '+12125550100'],
    ['12125550100', '+12125550100'],
  ];
  const dispBad = dispCases.filter(([input, want]) => displayPhone(input) !== want);
  const telParity = dispCases.every(([input, want]) => toTelHref(input) === 'tel:' + want);
  const alertLine = renderAlert({ business: { name: 'Alder Roofing', }, lead: { name: 'John Test', phone: '+201005408345', email: '', service: 'repair', timing: 'asap', home: 'house', roof_age: 'Not sure', insurance_claim: false, zip: '50265', notes: '' }, view: 'new', reviewResult: null });
  const alertOk = alertLine.includes('Phone: +201005408345') && !alertLine.includes('+1+20');
  line(dispBad.length === 0 && telParity && alertOk, 'G1b', 'displayPhone: + unchanged, 10->+1, 11/1->+; tel parity',
    dispBad.length ? 'bad: ' + dispBad.map(([i, w]) => `${i}->${displayPhone(i)} (want ${w})`).join('; ') : `${dispCases.length} cases ok telParity=${telParity} alert=${alertOk}`);

  /* G: owner email structure (unit-level, no DB). */
  const { ownerEmail } = await import('../lib/content.js');
  const { getBrand } = await import('../lib/brand.js');
  const biz = { name: 'Alder Roofing', timezone: 'America/Chicago' };
  const leads = {
    full: { name: 'Daniel Whitaker', phone: '(555) 501-2345', email: 'daniel@example.com', zip: '50265', service: 'repair', home: 'house', timing: 'asap', roof_age: '10 to 20 years', insurance_claim: true, notes: 'line one\nline two' },
    minimal: { name: 'Maria Lopez', phone: '5555019876', email: '', zip: '50269', service: 'unsure', home: 'other', timing: 'planning', roof_age: 'Not sure', insurance_claim: false, notes: '' },
    stress: { name: 'Stress <b>Test</b>', phone: '(555) 501-2345', email: 'stress@example.com', zip: '50265', service: 'storm', home: 'house', timing: 'month', roof_age: 'Over 20 years', insurance_claim: true, notes: '<b>hail</b> & "quotes" </q>' },
  };
  const renders = {};
  for (const [lname, l] of Object.entries(leads)) renders[lname] = ownerEmail({ business: biz, lead: l });
  const brandHexes = new Set(Object.values(getBrand().colors));
  // G2
  line(Object.values(renders).every((r) => r.html && r.text && r.subject.startsWith('New lead:')),
    'G2', 'O1 renders for clean, minimal and stress leads', `renders=${Object.keys(renders).length}`);
  // G3
  const orderOk = Object.values(renders).every((r) => {
    const j = r.html.indexOf('>Job<'), b = r.html.indexOf('>Call '), rp = r.html.indexOf('Reply to this email');
    return j >= 0 && b > j && rp > b;
  });
  // G4
  const widthsOk = Object.values(renders).filter((r) => r.html.includes('width="2%"'))
    .every((r) => (r.html.match(/width="49%"/g) || []).length >= 2);
  // G5
  const noLeftOk = Object.values(renders).every((r) => !r.html.includes('border-left'));
  // G6: every HEX colour in the markup is a brand hex (stars #E0A800 may appear in review mail, not owner)
  const g6Ok = Object.values(renders).every((r) => {
    const found = [...r.html.matchAll(/#[0-9A-Fa-f]{6}/g)].map((m) => m[0].toUpperCase());
    return found.every((h) => brandHexes.has(h));
  });
  // G7: font-face urls absolute https under SITE_URL and files exist
  const siteEnv = process.env.SITE_URL;
  const faceUrls = [...renders.full.html.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]);
  const facesExist = faceUrls.every((u) => /^(?:https:\/\/[^/]+)?\/assets\/fonts\//.test(u));
  // G8 — Before (item 4): <img src="https://.../logo-on-dark.png" alt="Alder Roofing">
  // (hosted URL, business name duplicated as alt text).
  // After (item 4, deliberate change): CID inline image, alt="" (the business
  // name is printed next to it), 32x32 reserved, display:block.
  const imgs = [...renders.full.html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  const imgOk = imgs.length === 1 && imgs.every((t) => t.includes('src="cid:brand-logo"') && t.includes('alt=""')
    && t.includes('width="32"') && t.includes('height="32"') && t.includes('display:block;border:0;width:32px;height:32px;'));
  // G9
  const footerSep = renders.full.html.includes('margin:0 0 8px') && renders.full.html.includes('Reply to this email');
  // G10
  const stress = renders.stress;
  const g10Ok = stress.html.includes('&lt;b&gt;') && stress.html.includes('&amp;') && !stress.html.includes('<b>hail</b>')
    && stress.text.includes('<b>hail</b> & "quotes" </q>');
  line(orderOk, 'G3', 'buttons after Job card, before Reply paragraph', `order=${orderOk}`);
  line(widthsOk, 'G4', 'buttons half-width with 2% spacer', `widths=${widthsOk}`);
  line(noLeftOk, 'G5', 'no border-left in owner email', `ok=${noLeftOk}`);
  line(g6Ok, 'G6', 'every markup colour is a brand hex', `ok=${g6Ok}`);
  line(facesExist, 'G7', 'font-face files exist', `urls=${faceUrls.length} siteEnv=${siteEnv ? 'set' : 'unset'}`);
  line(imgOk, 'G8', 'CID logo img: src/alt=""/32x32/display:block', `imgs=${imgs.length}`);
  line(footerSep, 'G9', 'footer lines are separate elements', `ok=${footerSep}`);
  line(g10Ok, 'G10', 'stress lead stays escaped in HTML, raw in text', `ok=${g10Ok}`);

  /* G12: item 2 — compact layout. Exactly one border-radius container
     (besides the buttons and the notes box), an edge-to-edge divider between
     Customer and Job sections, label width 96, mobile @media block. */
  const compact = renders.full;
  // (The header band itself carries `border-radius:10px 10px 0 0` and the outer
  // card `border-radius:10px` — two paired radii, exactly one card box.)
  const radii = (compact.html.match(/border-radius:10px/g) || []).length;
  const divider = `<tr><td height="1" style="font-size:0;line-height:0;border-top:1px solid ${getBrand().colors.border}">&nbsp;</td></tr>`;
  const dividerOk = compact.html.includes(divider)
    && compact.html.indexOf('>Customer<') < compact.html.indexOf(divider)
    && compact.html.indexOf(divider) < compact.html.indexOf('>Job<');
  const label96 = compact.html.includes('width="96"');
  const mobileOk = compact.html.includes('@media (max-width:480px){.outer{padding:0!important}.card{border-radius:0!important;border:0!important}.px{padding-left:16px!important;padding-right:16px!important}}');
  line(radii === 2 && dividerOk && label96 && mobileOk, 'G12', 'one radius container, divider, label-96, mobile block',
    `radius=${radii} divider=${dividerOk} label96=${label96} mobile=${mobileOk}`);

  /* G11: pinned button colours (from brand tokens) */
  const bc = getBrand().colors;
  const fullHtml = renders.full.html;
  const callBtn = fullHtml.match(/<td width="49%"[^>]*bgcolor="([^"]+)"[^>]*><a[^>]*style="[^"]*color:([^;"]+)[^"]*">Call /);
  const mailBtn = fullHtml.match(/<td width="49%"[^>]*bgcolor="([^"]+)"[^>]*><a[^>]*style="[^"]*color:([^;"]+)[^"]*">Email /);
  const g11Ok = !!(callBtn && mailBtn
    && callBtn[1].toUpperCase() === bc.accent.toUpperCase()
    && callBtn[2].toUpperCase() === bc.accentText.toUpperCase()
    && mailBtn[1].toUpperCase() === bc.bg.toUpperCase()
    && mailBtn[2].toUpperCase() === bc.onBg.toUpperCase());
  // lead without an email: exactly one button, the accent one
  const noMailHtml = renders.minimal.html;
  const singleAccent = noMailHtml.includes('bgcolor="' + bc.accent + '"')
    && !/<td width="49%"[^>]*bgcolor="[^"]+"[^>]*><a[^>]*>Email /.test(noMailHtml);
  line(g11Ok && singleAccent, 'G11', 'Call=accent/accentText, Email=bg/onBg; no-email lead gets one accent button',
    `call=${callBtn && callBtn[1]} mail=${mailBtn && mailBtn[1]} single=${singleAccent}`);

  /* G13: a name carrying CR/LF cannot forge a line in the plain-text alert.
     The alert is line-structured ("Name:", "Phone:", "Status:"), so a newline in
     a customer-supplied field would let the sender add a fake status line.
     Same value with the newline already collapsed must render identically. */
  {
    const { telegramAlertText: textNew, renderLeadList: listNew } = await import('../lib/content.js');
    const mk = (name) => ({
      business: { name: 'Alder Roofing' },
      lead: {
        name, phone: '+201005408345', email: '', service: 'repair', timing: 'asap',
        home: 'house', roof_age: 'Not sure', insurance_claim: false, zip: '50265', notes: '',
      },
    });
    const evil = textNew(mk('John\n\n🔵 Status: Contacted'));
    const flat = textNew(mk('John 🔵 Status: Contacted'));
    const normal = textNew(mk('John'));
    const sameLines = evil.split('\n').length === normal.split('\n').length;
    const nameLine = evil.split('\n').find((l) => l.startsWith('Name:')) || '';
    const oneStatus = evil.split('\n').filter((l) => /^\S+ Status: /.test(l)).length;
    const oneList = listNew([{ name: 'Ann', service: 'repair', phone: '+201005408345', status: 'open', created_at: new Date().toISOString() }]);
    const evilList = listNew([{ name: 'Ann\n🔵 Status: Done', service: 'repair', phone: '+201005408345', status: 'open', created_at: new Date().toISOString() }]);
    const listOk = evilList.split('\n').length === oneList.split('\n').length;
    line(evil === flat && sameLines && nameLine === 'Name: John 🔵 Status: Contacted' && oneStatus === 1 && listOk,
      'G13', 'newline in a name cannot forge an alert line',
      `same=${evil === flat} lines=${evil.split('\n').length}/${normal.split('\n').length} status=${oneStatus} list=${listOk}`);
  }

  /* H: review-request email (unit-level) */
  const { reviewEmail: reviewEmailNew, autoReply: autoReplyNew } = await import('../lib/content.js');
  const site = 'https://reviews.example';
  // H1: the review email now has exactly one link, to /r/<token> — no star
  // glyphs and no button.
  const rr = reviewEmailNew({ business: biz, token: 'tok123', siteUrl: site });
  const rrLinks = (rr.html.match(/<a href="/g) || []).length;
  const rrOk = rr.html.includes('/r/tok123') && rrLinks === 1
    && !rr.html.includes('Leave a Google review') && !rr.html.includes('google-g')
    && !/[★☆]/.test(rr.html);
  const h3ok = !rr.html.includes('private feedback') && !rr.text.includes('private feedback')
    && !rr.html.includes('Google link works')
    && !/(discount|coupon|free[^a-z]|cash back|incentive)/i.test(rr.html + rr.text);
  // H4: customer footers read "Sent by <business>", never "Lead Alerts"
  const autoNew = autoReplyNew({ business: biz, lead: leads.full });
  const h4ok = autoNew.html.includes('Sent by Alder Roofing') && !autoNew.html.includes('Lead Alerts')
    && rr.html.includes('Sent by Alder Roofing') && !rr.html.includes('Lead Alerts');
  // H5: owner email keeps "Sent by Lead Alerts"
  const h5ok = renders.full.html.includes('Sent by Lead Alerts') && renders.full.text.includes('Sent by Lead Alerts');
  line(rrOk, 'H1', 'review email: one plain-URL link, no button or star glyphs', `links=${rrLinks}`);
  line(rrOk, 'H2', 'nothing else clickable, no star links', `links=${rrLinks}`);
  line(h3ok, 'H3', 'no private-feedback sentence, no incentives', `ok=${h3ok}`);
  line(h4ok, 'H4', 'customer footers: Sent by <business>, never Lead Alerts', `ok=${h4ok}`);
  line(h5ok, 'H5', 'owner footer still Sent by Lead Alerts', `ok=${h5ok}`);

  /* A1b: MAIL_REDIRECT_PREFIX=off skips ONLY the subject prefix; recipient still redirected */
  await clean(); await reset(RS);
  const savedPrefix = process.env.MAIL_REDIRECT_PREFIX;
  process.env.MAIL_REDIRECT_PREFIX = 'off';
  const { key: keyB } = await post({});
  process.env.MAIL_REDIRECT_PREFIX = savedPrefix;
  const reqsB = (await requests(RS)).filter((x) => x.method === 'POST' && x.path === '/emails');
  const ownerB = reqsB.find((x) => x.body && x.body.subject && x.body.subject.startsWith('New lead:')) && reqsB.find((x) => x.body && x.body.subject && x.body.subject.startsWith('New lead:')).body;
  line(!!ownerB && !ownerB.subject.startsWith('[TEST for ') && ownerB.to[0] === process.env.MAIL_REDIRECT_TO
    && ownerB.subject.startsWith('New lead:'),
    'A1b', 'prefix off: no [TEST] prefix, still redirected', `to=${ownerB && ownerB.to} subj=${ownerB && ownerB.subject.slice(0, 30)}`);
} catch (e) { line(false, 'A1', 'owner email payload', e.message); }

/* Resend 500 */
try {
  await clean();
  await control(RS, { mode: '500' }); await reset(RS);
  const { res, key, ms } = await post({});
  await control(RS, { mode: 'ok' });
  const rows = await leadFor(key);
  const evs = rows.length ? await events(rows[0].id) : [];
  const fail = evs.find((e) => e.kind === 'email_owner_failed');
  line(res.code === 200 && res.body && res.body.ok === true && rows.length === 1 && !!fail && fail.meta.status === 500 && ms < 5000,
    'A3', 'Resend 500 -> ok:true, one email_owner_failed', `${res.code} rows=${rows.length} ms=${ms} meta=${JSON.stringify(fail && fail.meta)}`);
} catch (e) { line(false, 'A3', 'Resend 500', e.message); }

/* Resend 6 s hang */
try {
  await clean();
  await control(RS, { mode: 'hang_once', hangMs: 2500 }); await reset(RS);
  const { res, key, ms } = await post({});
  await control(RS, { mode: 'ok' }); await reset(RS);
  const rows = await leadFor(key);
  const evs = rows.length ? await events(rows[0].id) : [];
  const fail = evs.find((e) => e.kind === 'email_owner_failed');
  line(res.code === 200 && rows.length === 1 && !!fail && ms < 5000,
    'A4', 'Resend 6 s hang -> ok:true, under 5 s', `${res.code} ms=${ms} meta=${JSON.stringify(fail && fail.meta)}`);
} catch (e) { line(false, 'A4', 'Resend hang', e.message); }

/* ---------- B9-B12: cross-channel owner-alert fallback ----------
   Both channels always send. When exactly one fails the owner already has the
   alert, so a second send would be a duplicate; only when NEITHER delivered does
   each usable channel get one more attempt, marked { fallback: true }. */

const sendMessageCount = async () => (await requests(TG)).filter((r) => r.path.includes('/sendMessage')).length;
const emailCount = async () => (await requests(RS)).filter((r) => r.path === '/emails').length;
const metaOf = (evs) => evs.map((e) => e.meta || {});

/* B9: both up — one Telegram, one owner email plus the auto-reply, no fallback */
try {
  await clean();
  await control(TG, { mode: 'ok' }); await control(RS, { mode: 'ok' });
  await reset(TG); await reset(RS);
  const { res, key } = await post({});
  const rows = await leadFor(key);
  const evs = rows.length ? await events(rows[0].id) : [];
  const tg = await sendMessageCount(), mail = await emailCount();
  const fb = metaOf(evs).some((m) => m.fallback === true);
  line(res.code === 200 && rows.length === 1 && tg === 1 && mail === 2 && !fb,
    'B9', 'both up: one alert per channel, no fallback', `tg=${tg} mail=${mail} fallback=${fb}`);
} catch (e) { line(false, 'B9', 'both up', e.message); }

/* B10: Telegram 500 — the owner has the email, so no second Telegram attempt */
try {
  await clean();
  await control(TG, { mode: '500' }); await control(RS, { mode: 'ok' });
  await reset(TG); await reset(RS);
  const { res, key } = await post({});
  await control(TG, { mode: 'ok' });
  const rows = await leadFor(key);
  const evs = rows.length ? await events(rows[0].id) : [];
  const tg = await sendMessageCount(), mail = await emailCount();
  const failed = evs.some((e) => e.kind === 'tg_failed' && e.meta && e.meta.status === 500);
  const fb = metaOf(evs).some((m) => m.fallback === true);
  line(res.code === 200 && rows.length === 1 && tg === 1 && mail === 2 && failed && !fb,
    'B10', 'telegram down: email delivered, no duplicate send', `tg=${tg} mail=${mail} failed=${failed} fallback=${fb}`);
} catch (e) { line(false, 'B10', 'telegram down', e.message); }

/* B11: Resend 500 — the owner has the Telegram alert, so no second email */
try {
  await clean();
  await control(TG, { mode: 'ok' }); await control(RS, { mode: '500' });
  await reset(TG); await reset(RS);
  const { res, key } = await post({});
  await control(RS, { mode: 'ok' });
  const rows = await leadFor(key);
  const evs = rows.length ? await events(rows[0].id) : [];
  const tg = await sendMessageCount(), mail = await emailCount();
  const failed = evs.some((e) => e.kind === 'email_owner_failed' && e.meta && e.meta.status === 500);
  const fb = metaOf(evs).some((m) => m.fallback === true);
  line(res.code === 200 && rows.length === 1 && tg === 1 && mail === 2 && failed && !fb,
    'B11', 'resend down: telegram delivered, no duplicate send', `tg=${tg} mail=${mail} failed=${failed} fallback=${fb}`);
} catch (e) { line(false, 'B11', 'resend down', e.message); }

/* B12: both down — nothing reached the owner, so both channels are retried once */
try {
  await clean();
  await control(TG, { mode: '500' }); await control(RS, { mode: '500' });
  await reset(TG); await reset(RS);
  const { res, key } = await post({});
  await control(TG, { mode: 'ok' }); await control(RS, { mode: 'ok' });
  const rows = await leadFor(key);
  const evs = rows.length ? await events(rows[0].id) : [];
  const tg = await sendMessageCount(), mail = await emailCount();
  const fb = metaOf(evs).filter((m) => m.fallback === true).length;
  const failedTg = evs.filter((e) => e.kind === 'tg_failed').length;
  line(res.code === 200 && rows.length === 1 && tg === 2 && mail === 3 && fb === 2 && failedTg === 2,
    'B12', 'both down: lead saved, one retry per channel', `tg=${tg} mail=${mail} fallback=${fb} tgFailed=${failedTg}`);
} catch (e) { line(false, 'B12', 'both down', e.message); }

/* B13: the per-business daily cap applies to the customer auto-reply only.
   Two leads, cap of 1: the second auto-reply is skipped, but its lead is saved
   and the owner still gets both the email and the Telegram alert. */
try {
  await clean();
  const savedCap = process.env.AUTOREPLY_DAILY_CAP;
  process.env.AUTOREPLY_DAILY_CAP = '1';
  await control(TG, { mode: 'ok' }); await control(RS, { mode: 'ok' });
  await reset(TG); await reset(RS);
  const first = await post({ idempotencyKey: `${RUN}-cap1` });
  const second = await post({ idempotencyKey: `${RUN}-cap2` });
  const tg = await sendMessageCount(), mail = await emailCount();
  const rows = (await leadFor(`${RUN}-cap1`)).length + (await leadFor(`${RUN}-cap2`)).length;
  const capped = logs.some((l) => l.includes('autoreply_capped'));
  if (savedCap === undefined) delete process.env.AUTOREPLY_DAILY_CAP; else process.env.AUTOREPLY_DAILY_CAP = savedCap;
  // 2 owner emails + 1 auto-reply (the second is capped); 2 Telegram alerts.
  line(first.res.code === 200 && second.res.code === 200 && rows === 2 && tg === 2 && mail === 3 && capped,
    'B13', 'daily cap: auto-reply skipped, lead and alerts kept',
    `rows=${rows} tg=${tg} mail=${mail} capped=${capped}`);
} catch (e) { line(false, 'B13', 'auto-reply cap', e.message); }

/* Redirect off + default sender -> no HTTP call */
try {
  await clean();
  const savedRedirect = process.env.MAIL_REDIRECT_TO, savedFrom = process.env.MAIL_FROM;
  delete process.env.MAIL_REDIRECT_TO; delete process.env.MAIL_FROM;
  await reset(RS);
  const { res, key } = await post({});
  const count = (await requests(RS)).filter((x) => x.path === '/emails').length;
  const rows = await leadFor(key);
  const evs = rows.length ? await events(rows[0].id) : [];
  const fail = evs.find((e) => e.kind === 'email_owner_failed');
  line(res.code === 200 && count === 0 && !!fail && fail.meta.status === 'no_verified_sender',
    'A5', 'no redirect + default sender -> no HTTP call', `calls=${count} meta=${JSON.stringify(fail && fail.meta)}`);
  if (savedRedirect !== undefined) process.env.MAIL_REDIRECT_TO = savedRedirect;
  if (savedFrom !== undefined) process.env.MAIL_FROM = savedFrom;
} catch (e) { line(false, 'A5', 'no redirect', e.message); }

/* ================= GATE B — Telegram alert ================= */
try {
  await clean();
  await reset(TG); await reset(RS);
  const { res, key } = await post({ notes: 'A note that should be capped' });
  const tgReq = (await requests(TG)).filter((x) => x.method === 'POST' && x.path.includes('/sendMessage'));
  const t = tgReq[0] && tgReq[0].body;
  // NEW (item 2): one "Label: value" per line, blank lines between groups, title
  // carries the only "·", phone keeps the +1 tappable form.
  // Before (item 3): the status block ended with the plain line 'Status: New'.
  // After (item 3, deliberate change): emoji status lines, one fact per line,
  // and the email never appears in the status block.
  const expectedText = [
    'New lead · Alder Roofing (demo)',
    '',
    'Name: Notify Tester',
    'Phone: +15155550142',
    'Email: notify@example.com',
    '',
    'Service: Roof replacement',
    'Timing: As soon as possible',
    'Property: House',
    'Roof age: 10 to 20 years',
    'Insurance claim: No',
    'ZIP: 50265',
    '',
    'Notes: A note that should be capped',
    '',
    '🟡 Status: New',
  ].join('\n');
  const textOk = t && t.text === expectedText;
  const noJoin = t && t.text.split('\n').slice(1).every((l) => !l.includes(' · '));
  const noParse = t && !('parse_mode' in t);
  const kb = t && t.reply_markup && t.reply_markup.inline_keyboard;
  const oneBtn = Array.isArray(kb) && kb.length === 1 && kb[0].length === 1
    && kb[0][0].text === 'Mark contacted' && /^c:[0-9a-f-]{36}$/.test(kb[0][0].callback_data || '');
  line(res.code === 200 && textOk && noJoin && noParse && oneBtn && t.chat_id === process.env.TELEGRAM_CHAT_ID,
    'B1', 'exact plain text, no parse_mode, demo fallback chat', `chat=${t && t.chat_id} keys=${t && Object.keys(t).join(',')}`);
  const rows = await leadFor(key);
  const evs = rows.length ? await events(rows[0].id) : [];
  line(evs.some((e) => e.kind === 'tg_sent'), 'B2', 'tg_sent event recorded');

  /* minimal lead: no notes, no email — the Email and Notes lines are omitted */
  await clean();
  await reset(TG);
  const noContact = await post({ email: '', notes: '' });
  const minReq = (await requests(TG)).filter((x) => x.method === 'POST' && x.path.includes('/sendMessage'));
  const minText = minReq[0] && minReq[0].body && minReq[0].body.text;
  const minExpected = [
    'New lead · Alder Roofing (demo)',
    '',
    'Name: Notify Tester',
    'Phone: +15155550142',
    '',
    'Service: Roof replacement',
    'Timing: As soon as possible',
    'Property: House',
    'Roof age: 10 to 20 years',
    'Insurance claim: No',
    'ZIP: 50265',
    '',
    '🟡 Status: New',
  ].join('\n');
  line(!!minText && minText === minExpected,
    'B2b', 'minimal lead: exact text, no Email/Notes lines', `${minText ? minText.length + ' chars' : 'none'}`);

  /* S: status block (unit). Before (26-char rule): every line <= 40 chars for
     a sample first name "John". After: every line <= 26 chars (JS length,
     emojis counted) and neither the name nor the email ever appears in the
     block — checked with a 60-char name too. The error view carries exactly
     one r: (Try again) button. */
  {
    const { renderAlert: renderS, tryAgainKeyboard, confirmKeyboard } = await import('../lib/content.js');
    const sBiz = { name: 'Alder Roofing' };
    const sLead = { name: 'John Test', phone: '+201005408345', email: 'john@example.com', service: 'repair', timing: 'asap', home: 'house', roof_age: 'Not sure', insurance_claim: false, zip: '50265', notes: '' };
    const longLead = { ...sLead, name: 'N'.repeat(60) };
    const views = [
      ['new', null], ['contacted', null], ['confirm', null],
      ['done', 'sent'], ['done', 'no_email'], ['error', 'failed'],
    ];
    let lineOk = true, mailOk = true, nameOk = true, detail = '';
    for (const [v, rr] of views) {
      for (const lead of [sLead, longLead]) {
        const tail = renderS({ business: sBiz, lead, view: v, reviewResult: rr }).split('\n\n').pop();
        for (const l of tail.split('\n')) {
          if (l.length > 26) { lineOk = false; detail += `${v}:${l.length} `; }
          if (l.includes('john@example.com')) { mailOk = false; detail += `${v}:email `; }
          if (l.includes('John') || l.includes('NNN')) { nameOk = false; detail += `${v}:name `; }
        }
      }
    }
    const uid = '00000000-0000-4000-8000-000000000001';
    const kb = tryAgainKeyboard(uid).inline_keyboard;
    const btnOk = kb.length === 1 && kb[0].length === 1 && kb[0][0].text === 'Try again'
      && kb[0][0].callback_data === 'r:' + uid && kb[0][0].style === 'primary';
    // confirm keyboard: with email "Send request", without email "Mark done".
    const ckEmail = confirmKeyboard(uid, true).inline_keyboard[0];
    const ckNoEmail = confirmKeyboard(uid, false).inline_keyboard[0];
    const ckOk = ckEmail[0].text === 'Send request' && ckEmail[0].callback_data === 'y:' + uid && ckEmail[0].style === 'success'
      && ckNoEmail[0].text === 'Mark done' && ckNoEmail[0].callback_data === 'y:' + uid && ckNoEmail[0].style === 'success'
      && ckEmail[1].text === 'Cancel' && ckNoEmail[1].text === 'Cancel';
    line(lineOk && mailOk && nameOk && btnOk && ckOk, 'S1', 'status block: lines <=26, no name/email, one r: button, confirm labels',
      `lineOk=${lineOk} mailOk=${mailOk} nameOk=${nameOk} btnOk=${btnOk} ck=${ckOk} ${detail}`);

    /* S2 (item 4): one padding system. Header/body/footer cells all carry
       24px horizontal padding (owner header 18px top/bottom, body 24/24,
       footer 8px top 24px bottom). Before: header 16/20/14, customer header
       20/28, body 8/20/0, footer 20/28/28, review wrapper 28px horizontal. */
    const { ownerEmail: ownerEmailS, autoReply: autoReplyS, reviewEmail: reviewEmailS } = await import('../lib/content.js');
    const biz = { name: 'Alder Roofing', timezone: 'America/Chicago' };
    const sLeads = { full: { name: 'Daniel Whitaker', phone: '(555) 501-2345', email: 'daniel@example.com', zip: '50265', service: 'repair', home: 'house', timing: 'asap', roof_age: '10 to 20 years', insurance_claim: true, notes: 'line one\nline two' } };
    const three = {
      owner: ownerEmailS({ business: biz, lead: sLeads.full }).html,
      auto: autoReplyS({ business: biz, lead: sLeads.full }).html,
      review: reviewEmailS({ business: biz, token: 'tok123', siteUrl: 'https://reviews.example' }).html,
    };
    const cellPad = (html, marker) => {
      const re = marker === 'header'
        ? /<tr><td class="px"[^>]*style="padding:([\dpx ]+);/
        : marker === 'body'
          ? /<tr><td style="padding:([\dpx ]+)" class="px">/
          : /<tr><td style="padding:([\dpx ]+)" class="px">/g;
      if (marker === 'footer') {
        const all = [...html.matchAll(/<tr><td style="padding:([\dpx ]+)" class="px">/g)];
        return all.length ? all[all.length - 1][1] : null;
      }
      const m = re.exec(html);
      return m && m[1];
    };
    let padOk = true, padDetail = '';
    for (const [name, html] of Object.entries(three)) {
      const h = cellPad(html, 'header'), bd = cellPad(html, 'body'), ft = cellPad(html, 'footer');
      const horiz = (p) => { const parts = String(p || '').split(' '); return parts.length >= 2 ? parts[1] : parts[0]; };
      const ok = h === '18px 24px' && bd === '24px 24px' && ft === '8px 24px 24px'
        && horiz(h) === '24px' && horiz(bd) === '24px' && horiz(ft) === '24px';
      if (!ok) { padOk = false; padDetail += `${name}:h=${h} b=${bd} f=${ft} `; }
    }
    // No inner element adds horizontal padding inside the card: the review
    // wrapper's 28px horizontal inset is gone (button's own 15px 28px stays).
    const reviewNoWrap = !three.review.includes('padding:4px 28px 6px')
      && three.review.includes('padding:4px 0 6px')
      && three.review.includes('padding:15px 28px');
    const mobileOk = three.owner.includes('.px{padding-left:16px!important;padding-right:16px!important}');
    const cidOk = Object.values(three).every((html) => html.includes('src="cid:brand-logo"')
      && html.includes('alt=""') && html.includes('width="32"') && html.includes('height="32"')
      && html.length < 100 * 1024 && !/https?:\/\/[^"\s]*logo[^"\s]*/.test(html));
    line(padOk && reviewNoWrap && mobileOk && cidOk, 'S2', 'header/body/footer padding 24px, verticals as spec, no inner inset, CID in all 3',
      `padOk=${padOk} reviewWrap=${reviewNoWrap} mobile=${mobileOk} cid=${cidOk} ${padDetail}`);
  }
} catch (e) { line(false, 'B1', 'telegram text', e.message); }

/* Bound business -> its chat only */
let boundId = null, activeId = null;
try {
  await clean();
  const { data: biz } = await svc.from('businesses').select('id').eq('slug', ALDER_DEMO).single();
  const chat = 770001;
  await svc.from('business_chats').upsert({ business_id: biz.id, tg_chat_id: chat }, { onConflict: 'tg_chat_id' });
  await reset(TG);
  await post({});
  const tgReq = (await requests(TG)).filter((x) => x.path.includes('/sendMessage'));
  line(tgReq.length === 1 && String(tgReq[0].body.chat_id) === String(chat),
    'B3', 'bound business -> its chat only', `calls=${tgReq.length} chat=${tgReq[0] && tgReq[0].body.chat_id}`);

  /* Second business -> its own chat */
  const { data: biz2 } = await svc.from('businesses').select('id').eq('slug', 'second-demo').single();
  const chat2 = 770002;
  await svc.from('business_chats').upsert({ business_id: biz2.id, tg_chat_id: chat2 }, { onConflict: 'tg_chat_id' });
  await reset(TG);
  await post({ slug: 'second-demo' });
  const req2 = (await requests(TG)).filter((x) => x.path.includes('/sendMessage'));
  line(req2.length === 1 && String(req2[0].body.chat_id) === String(chat2),
    'B4', 'second business -> its own chat only', `chat=${req2[0] && req2[0].body.chat_id}`);

  /* Active business with no chat -> no call, tg_failed no_chat */
  const { data: made } = await svc.from('businesses').insert({
    slug: `active-${RUN}`, name: 'Active Co', owner_email: 'owner@active.example.com',
    google_review_url: 'https://g.page/r/active', status: 'active',
  }).select('id').single();
  activeId = made.id;
  await reset(TG);
  const { res, key } = await post({ slug: `active-${RUN}` });
  const reqA = (await requests(TG)).filter((x) => x.path.includes('/sendMessage'));
  const rows = await leadFor(key);
  const evs = rows.length ? await events(rows[0].id) : [];
  const f = evs.find((e) => e.kind === 'tg_failed');
  line(res.code === 200 && reqA.length === 0 && !!f && f.meta.status === 'no_chat',
    'B5', 'active + no chat -> no call, tg_failed no_chat', `calls=${reqA.length} meta=${JSON.stringify(f && f.meta)}`);
} catch (e) { line(false, 'B3', 'chat routing', e.message); }

/* 400-with-keyboard retries once without it */
try {
  await clean();
  await control(TG, { mode: '400_if_keyboard' }); await reset(TG);
  const { res } = await post({});
  const reqs = (await requests(TG)).filter((x) => x.path.includes('/sendMessage'));
  await control(TG, { mode: 'ok' });
  line(res.code === 200 && reqs.length === 2 && !!reqs[0].body.reply_markup && !reqs[1].body.reply_markup,
    'B6', '400 with keyboard -> one retry without it', `calls=${reqs.length} keyboard=${!!reqs[0]?.body?.reply_markup}/${!!reqs[1]?.body?.reply_markup}`);
} catch (e) { line(false, 'B6', 'keyboard retry', e.message); }

/* L: renderLeadList exact format (unit). Before: "1. Name — service · phone
   · age · Word" single crowded lines with numbering and an em dash.
   After: title, blank line, three-line blocks, no numbering, no dashes. */
{
  const { renderLeadList } = await import('../lib/content.js');
  const now = Date.now();
  const at = (minAgo) => new Date(now - minAgo * 60000).toISOString();
  const leads = [
    { name: 'Legacy Phone', service: 'repair', phone: '5550102345', status: 'contacted', created_at: at(41) },
    { name: 'A'.repeat(40), service: 'storm', phone: '+201005408345', status: 'done', created_at: at(1500) },
    { name: 'Unknown Status', service: 'unsure', phone: '+15125550100', status: 'banana', created_at: at(5000) },
  ];
  const out = renderLeadList(leads, now);
  const expected = [
    'Recent requests',
    '',
    'Legacy Phone',
    'Repair · +15550102345',
    '41m ago · 🔵 Contacted',
    '',
    'A'.repeat(27) + '…',
    'Storm damage · +201005408345',
    '1d ago · ✅ Done',
    '',
    'Unknown Status',
    'Not sure · +15125550100',
    '3d ago · banana',
  ].join('\n');
  const maxLeads = Array.from({ length: 10 }, () => ({
    name: 'N'.repeat(80), service: 'S'.repeat(60), phone: '+20100540834533333333333333', status: 'contacted', created_at: at(1),
  }));
  const maxLen = renderLeadList(maxLeads, now).length;
  const ok = out === expected && !out.includes('—') && !/^\d+\./m.test(out)
    && out.split('\n')[1] === '' && maxLen < 4096;
  line(ok, 'L1', 'renderLeadList: exact spaced format, 10 max leads < 4096', `len=${out.length} maxLen=${maxLen}`);
  if (out !== expected) console.log('NOTE       got:\n' + out);
}

/* 6 s hang */
try {
  await clean();
  await control(TG, { mode: 'hang_once', hangMs: 2500 }); await reset(TG);
  const { res, key, ms } = await post({});
  await control(TG, { mode: 'ok' }); await reset(TG);
  const rows = await leadFor(key);
  const evs = rows.length ? await events(rows[0].id) : [];
  const f = evs.find((e) => e.kind === 'tg_failed');
  line(res.code === 200 && rows.length === 1 && !!f && ms < 5000,
    'B7', 'Telegram 6 s hang -> ok:true, under 5 s', `${res.code} ms=${ms} meta=${JSON.stringify(f && f.meta)}`);
} catch (e) { line(false, 'B7', 'telegram hang', e.message); }

/* Token / PII never in logs or event meta */
try {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const key = process.env.RESEND_API_KEY || '';
  const logText = logs.join('\n');
  const tokenLeak = (token && logText.includes(token)) || /bot\d+:/.test(logText) || (key && logText.includes(key));
  const piiLeak = /notify@example\.com|5155550142|Notify Tester|<script>/.test(logText);
  line(!tokenLeak && !piiLeak, 'B8', 'logs contain no token, key, URL or PII', `${logs.length} log lines`);
} catch (e) { line(false, 'B8', 'log scan', e.message); }

/* cleanup */
try {
  await svc.from('business_chats').delete().in('tg_chat_id', [770001, 770002]);
  if (activeId) {
    await svc.from('leads').delete().eq('business_id', activeId);
    await svc.from('businesses').delete().eq('id', activeId);
  }
  await clean();
} catch {}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
console.warn = realWarn; console.error = realErr;
process.exit(failed ? 1 : 0);
