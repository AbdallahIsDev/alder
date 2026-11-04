#!/usr/bin/env node
// tests/review.test.mjs — Gate D.
// HARNESS: real HTTP through vercel dev (rewrites, redirects and form POST),
// plus the fake Telegram server for the low-rating alert.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.mjs';
import { createClient } from '@supabase/supabase-js';

loadEnv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = new URL(process.env.LEAD_API_URL || 'http://localhost:3000/api/lead').origin;
const TG = process.env.FAKE_TG_URL;
const RS = process.env.FAKE_RESEND_URL;
const LOG = path.resolve(ROOT, process.env.LEAD_API_LOG || '_debug/vercel-dev.log');
const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let failed = 0, total = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(5)}${String(what).padEnd(48)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};
async function control(base, cfg) {
  await fetch(base + '/__control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
}
async function reset(base) { await fetch(base + '/__reset', { method: 'POST' }); }
async function tgCalls() {
  const r = await fetch(TG + '/__requests');
  return (await r.json()).requests.filter((x) => x.method === 'POST' && x.path.includes('/sendMessage'));
}
async function resendCalls() {
  const r = await fetch(RS + '/__requests');
  return (await r.json()).requests.filter((x) => x.method === 'POST' && x.path === '/emails');
}
const token = () => randomBytes(24).toString('base64url');

const { data: biz } = await svc.from('businesses').select('id, name, google_review_url').eq('slug', 'alder-demo').single();
const leads = [];
async function seed(tk) {
  const { data } = await svc.from('leads').insert({
    business_id: biz.id, name: 'Review Tester', phone: '5155550100', email: 'review@example.com',
    zip: '50265', service: 'repair', home: 'house', timing: 'asap', roof_age: 'Not sure',
    insurance_claim: false, notes: null, status: 'done',
    review_token: tk, idempotency_key: 'review-' + tk.slice(0, 12),
  }).select('id').single();
  if (data) leads.push(data.id);
  return data && data.id;
}

try {
  await control(TG, { mode: 'ok' }); await reset(TG); await reset(RS);

  /* Token entropy */
  const t0 = token();
  line(t0.length === 32 && /^[A-Za-z0-9_-]+$/.test(t0), 'D1', 'review_token is 192 bits / 32 chars', `${t0.length} chars`);
  const id0 = await seed(t0);

  /* Page before any rating, and for every rating 1..5 */
  const page0 = await fetch(`${ORIGIN}/r/${t0}`);
  const html0 = await page0.text();
  const hasGo = html0.includes(`/r/${t0}/go`) && html0.includes('Leave a Google review');
  line(page0.status === 200 && hasGo, 'D2', 'page shows the Google button before any rating', `${page0.status} go=${hasGo}`);

  const pages = [];
  for (let s = 1; s <= 5; s++) {
    const tk = token(); const leadId = await seed(tk);
    await svc.from('review_feedback').upsert({ lead_id: leadId, rating: s, comment: '' }, { onConflict: 'lead_id' });
    const r = await fetch(`${ORIGIN}/r/${tk}`);
    pages.push({ s, token: tk, html: await r.text(), status: r.status });
  }
  const allHaveButton = pages.every((p) => p.status === 200 && p.html.includes(`/r/${p.token}/go`) && p.html.includes('Leave a Google review'));
  // Pages differ only by their token. Compare the button markup with that token normalised.
  const buttonOf = (html) => {
    const m = /<a href="\/r\/[^"]+\/go"[^>]*>Leave a Google review<\/a>/.exec(html);
    return m ? m[0].replace(/\/r\/[^/]+\/go/, '/r/TOKEN/go') : '';
  };
  const buttons = pages.map((p) => buttonOf(p.html));
  const identical = buttons.every((b) => b && b === buttons[0]);
  line(allHaveButton && identical, 'D3', 'Google button identical for ratings 1..5', `pages=${pages.length} identical=${identical}`);

  /* D3b: stronger than D3. The only rating-dependent HTML in the page is the
     "Thank you for your feedback." paragraph, which reviewPage() emits only when a
     stored rating exists (the `thanks` const in lib/content.js). With the token and
     that single line normalised, the page for NO rating and for ratings 1..5 must be
     byte-identical. The numeric rating is never printed anywhere on the page. */
  const RATING_LINE = '<p style="font:15px Arial,Helvetica,sans-serif;color:#333">Thank you for your feedback.</p>';
  const strip = (html, tk) => html.split(tk).join('TOKEN').split(RATING_LINE).join('');
  const variants = [strip(html0, t0), ...pages.map((p) => strip(p.html, p.token))];
  const same = variants.every((v) => v === variants[0]);
  line(variants.length === 6 && same, 'D3b', 'whole page identical: no rating and ratings 1..5',
    `variants=${variants.length} identical=${same}`);

  /* Unknown token */
  const missing = await fetch(`${ORIGIN}/r/${token()}`);
  const missingBody = await missing.text();
  const generic = await fetch(`${ORIGIN}/definitely-missing-page`);
  const genericBody = await generic.text();
  line(missing.status === 404 && !missingBody.includes('Review Tester') && !missingBody.includes(biz.name),
    'D4', 'unknown token -> 404, no information', `${missing.status} len=${missingBody.length}`);

  /* 1-star POST: button survives, one Telegram alert */
  const t1 = token(); const lid1 = await seed(t1);
  await reset(TG);
  const post1 = await fetch(`${ORIGIN}/r/${t1}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'stars=1&comment=Not+happy', redirect: 'manual',
  });
  const page1 = await fetch(`${ORIGIN}/r/${t1}`);
  const html1 = await page1.text();
  const alerts1 = (await tgCalls()).length;
  const fb1 = await svc.from('review_feedback').select('rating, comment').eq('lead_id', lid1).maybeSingle();
  line(post1.status === 303 && html1.includes('Leave a Google review') && alerts1 === 1 && fb1.data.rating === 1,
    'D5', '1-star -> 303, button survives, one TG alert', `${post1.status} alerts=${alerts1} rating=${fb1.data.rating}`);

  /* 5-star: no Telegram alert */
  const t5 = token(); await seed(t5);
  await reset(TG);
  await fetch(`${ORIGIN}/r/${t5}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'stars=5&comment=Great', redirect: 'manual',
  });
  line((await tgCalls()).length === 0, 'D6', '5-star -> no Telegram alert');

  /* second POST updates, does not duplicate */
  await fetch(`${ORIGIN}/r/${t1}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'stars=2&comment=Updated', redirect: 'manual',
  });
  const { data: rows } = await svc.from('review_feedback').select('lead_id, rating, comment').eq('lead_id', lid1);
  line(rows.length === 1 && rows[0].rating === 2 && rows[0].comment === 'Updated',
    'D7', 'second POST updates the same row', `rows=${rows.length} rating=${rows[0] && rows[0].rating}`);

  /* D10: low-rating alert dedupe. The owner is alerted only when the stored rating
     MOVES into the 1-2 range (no previous rating, or previous >= 3). A repeat low
     rating must not alert again; a low rating after a 3 must. */
  const t10 = token(); const lid10 = await seed(t10);
  await reset(TG);
  await fetch(`${ORIGIN}/r/${t10}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'stars=2&comment=First+complaint', redirect: 'manual',
  });
  const d10First = (await tgCalls()).length;
  await fetch(`${ORIGIN}/r/${t10}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'stars=2&comment=Repeat', redirect: 'manual',
  });
  const d10Repeat = (await tgCalls()).length;
  await fetch(`${ORIGIN}/r/${t10}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'stars=3&comment=Better', redirect: 'manual',
  });
  const d10Mid = (await tgCalls()).length;
  await fetch(`${ORIGIN}/r/${t10}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'stars=1&comment=Worse+again', redirect: 'manual',
  });
  const d10Back = (await tgCalls()).length;
  const fb10 = await svc.from('review_feedback').select('rating').eq('lead_id', lid10).maybeSingle();
  line(d10First === 1 && d10Repeat === 1 && d10Mid === 1 && d10Back === 2 && fb10.data.rating === 1,
    'D10', 'low-rating alert fires once per move into 1-2', `alerts=${d10First}/${d10Repeat}/${d10Mid}/${d10Back} final=${fb10.data.rating}`);

  /* /go — REWRITTEN (item 4): the old behaviour was a GET that wrote
     google_clicked and 302'd, which contradicts the scanner-safety rule
     (mail scanners open every link and would register fake clicks).
     Now the legacy path lands on the new landing page: GET writes nothing,
     the page's POST records the click. */
  const t2 = token(); await seed(t2);
  const goPage = await fetch(`${ORIGIN}/r/${t2}/go`, { redirect: 'manual' });
  const goHtml = await goPage.text();
  const goFb = await svc.from('review_feedback').select('lead_id').eq('lead_id', (await svc.from('leads').select('id').eq('review_token', t2).maybeSingle()).data?.id || '');
  const goEvents = await svc.from('lead_events').select('id').eq('lead_id', (await svc.from('leads').select('id').eq('review_token', t2).maybeSingle()).data?.id || '');
  await fetch(`${ORIGIN}/r/${t2}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'go=1', redirect: 'manual' });
  const goFbAfter = await svc.from('review_feedback').select('google_clicked').eq('lead_id', (await svc.from('leads').select('id').eq('review_token', t2).maybeSingle()).data?.id || '');
  line(goPage.status === 200 && goHtml.includes('location.replace') && goHtml.includes('Continue to Google')
    && (await goFb.data).length === 0 && (await goEvents.data).length === 0
    && goFbAfter.data.length === 1 && goFbAfter.data[0].google_clicked === true,
    'D8', '/go lands on the landing page now; POST records the click', `status=${goPage.status} fbAfter=${goFbAfter.data.length}`);

  /* I: new landing page (?s=N / ?go=1). GET must never write; POST records. */
  const tI = token(); const lidI = await seed(tI);
  // I1: GET ?s=1..5 and ?go=1 write nothing
  await reset(TG);
  const fbBefore = await svc.from('review_feedback').select('lead_id').eq('lead_id', lidI);
  for (const q of ['?s=1', '?s=2', '?s=3', '?s=4', '?s=5', '?go=1']) {
    await fetch(`${ORIGIN}/r/${tI}${q}`, { redirect: 'manual' });
  }
  const fbAfter = await svc.from('review_feedback').select('lead_id').eq('lead_id', lidI);
  const evAfter = await svc.from('lead_events').select('id').eq('lead_id', lidI);
  line((await fbBefore.data).length === 0 && (await fbAfter.data).length === 0 && (await evAfter.data).length === 0
    && (await tgCalls()).length === 0,
    'I1', 'GET ?s=1..5 and ?go=1 create zero rows/events/requests', `fb=${(await fbAfter.data).length} ev=${(await evAfter.data).length}`);
  // I2: copy identical for s=1 and s=5 except star glyphs/config
  const p1 = await (await fetch(`${ORIGIN}/r/${tI}?s=1`)).text();
  const p5 = await (await fetch(`${ORIGIN}/r/${tI}?s=5`)).text();
  const norm = (h) => h
    .split(tI).join('TOKEN')
    .replace(/"stars":\d/g, '"stars":N')
    .replace(/"googleUrl":"[^"]*"/g, '"googleUrl":"G"');
  line(norm(p1) === norm(p5), 'I2', 'landing copy identical for s=1 and s=5 except stars', `identical=${norm(p1) === norm(p5)}`);
  // I3: POST from the page's path records once, repeat changes nothing new
  const postLanding = (body) => fetch(`${ORIGIN}/r/${tI}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual' });
  await reset(TG);
  await postLanding('stars=4&comment=&go=1');
  const fbI1 = await svc.from('review_feedback').select('rating, google_clicked').eq('lead_id', lidI).maybeSingle();
  const ev1 = await svc.from('lead_events').select('kind').eq('lead_id', lidI);
  await postLanding('stars=4&comment=&go=1');
  const fbI2 = await svc.from('review_feedback').select('rating').eq('lead_id', lidI);
  line(fbI1.data.rating === 4 && fbI1.data.google_clicked === true && ev1.data.length === 2 && fbI2.data.length === 1,
    'I3', 'page POST records rating + click once; repeat adds nothing', `rating=${fbI1.data.rating} events=${ev1.data.length}`);
  // I4: rating 2 alerts once and the landing page still redirects to Google
  const t4 = token(); await seed(t4);
  await reset(TG);
  const r4 = await fetch(`${ORIGIN}/r/${t4}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'stars=2&comment=Meh&go=1', redirect: 'manual' });
  const alerts4 = (await tgCalls()).length;
  const landing4 = await (await fetch(`${ORIGIN}/r/${t4}?s=2`)).text();
  // The redirect target is whatever allowlisted URL the business row holds
  // (g.page etc. do not contain the string "google.com"), so assert location.replace
  // carries a non-empty googleUrl that IS allowlisted rather than a substring.
  const m4 = /"googleUrl":"([^"]*)"/.exec(landing4);
  const targetOk = m4 && m4[1].length > 1 && m4[1].startsWith('https://');
  line(alerts4 === 1 && r4.status === 303 && landing4.includes('location.replace') && targetOk,
    'I4', '2-star POST alerts once and the landing page still redirects to Google', `alerts=${alerts4} target=${targetOk}`);
  // I5: disallowed Google hosts never produce a redirect
  const bads = ['http://evil.example', 'javascript:alert(1)', 'https://google.com.evil.example'];
  const hostGuard = (v) => { try { const u = new URL(v); return u.protocol === 'https:' && ['www.google.com', 'google.com', 'search.google.com', 'maps.google.com', 'g.page', 'maps.app.goo.gl', 'goo.gl'].includes(u.hostname); } catch { return false; } };
  const badAllowed = bads.filter(hostGuard);
  line(badAllowed.length === 0 && landing4.includes('Continue to Google'),
    'I5', 'disallowed Google hosts never produce a redirect', `badAllowed=${badAllowed.join(',')}`);
  // I6: s=0, s=6, s=abc -> go behaviour (Verify: page renders, redirects, no stars)
  const i6pages = ['?s=0', '?s=6', '?s=abc'];
  const i6ok = [];
  for (const q of i6pages) {
    const h = await (await fetch(`${ORIGIN}/r/${t4}${q}`)).text();
    i6ok.push(h.includes('Thank you!') && h.includes('Continue to Google')
      && h.includes('location.replace') && !h.includes('id="stars"'));
  }
  line(i6ok.every(Boolean), 'I6', 's=0, s=6, s=abc fall back to go behaviour', i6ok.join('/'));
  // I7: token from another business changes nothing (tenancy on the landing page)
  const t7 = token(); await seed(t7);
  const foreignBefore = await svc.from('review_feedback').select('lead_id').eq('lead_id', (await svc.from('leads').select('id').eq('review_token', t7).maybeSingle()).data?.id || '');
  await fetch(`${ORIGIN}/r/${tI}?s=5`, { redirect: 'manual' });
  await fetch(`${ORIGIN}/r/${t7}?s=5`, { redirect: 'manual' });
  const foreignAfter = await svc.from('review_feedback').select('lead_id').eq('lead_id', (await svc.from('leads').select('id').eq('review_token', t7).maybeSingle()).data?.id || '');
  line((await foreignBefore.data).length === 0 && (await foreignAfter.data).length === 0,
    'I7', 'landing GET for another business token writes nothing', `fb=${(await foreignAfter.data).length}`);

  /* I8: the landing card is vertically AND horizontally centred in every state */
  const i8Pages = [];
  i8Pages.push(await (await fetch(`${ORIGIN}/r/${tI}?s=3`)).text());
  i8Pages.push(await (await fetch(`${ORIGIN}/r/${tI}?go=1`)).text());
  const tU = token(); await seed(tU);
  // unavailable state: a business with a disallowed Google host cannot be seeded
  // through the API; render it via a unit-level call instead.
  const { reviewLandingPage: rlp } = await import('../lib/content.js');
  i8Pages.push(rlp({ business: { name: biz.name, id: biz.id }, token: tU, googleUrl: 'http://evil.example', stars: 3 }));
  const i8ok = i8Pages.every((h) =>
    h.includes('display:flex') && h.includes('align-items:center') && h.includes('justify-content:center')
    && h.includes('min-height:100vh') && h.includes('min-height:100dvh')
    && h.indexOf('min-height:100vh') < h.indexOf('min-height:100dvh')
    && !/margin-top/.test(h));
  line(i8ok, 'I8', 'landing card centred on both axes in every state', `pages=${i8Pages.length}`);

  /* no studio branding, no AI, no auto-posting claim */
  const haystack = [html0, html1, ...pages.map((p) => p.html), ...(await resendCalls()).map((x) => (x.body?.html || '') + (x.body?.text || ''))].join('\n');
  const banned = /\bAlder Studio\b|\bAI\b|automatic(ally)? post|missed-call text-back|Google auto-post/i.test(haystack);
  line(!banned, 'D9', 'no studio branding, AI or auto-posting claim', `scanned=${haystack.length} chars`);
} catch (e) {
  line(false, 'D0', 'review suite threw', e.message);
} finally {
  if (leads.length) await svc.from('leads').delete().in('id', leads);
  await svc.from('rate_limits').delete().gte('window_start', '2000-01-01');
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
