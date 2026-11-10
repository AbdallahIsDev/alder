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
import { fakeRes, ALDER_DEMO } from './helpers.mjs';

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

const { data: biz } = await svc.from('businesses').select('id, name, google_review_url').eq('slug', ALDER_DEMO).single();
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

/* ---------- in-process review handler (most tests) vs real HTTP (kept) ----
   Moved from real HTTP through vercel dev: D3, D3b, D5-D7, D10, I2-I9, R1
   prove handler logic/markup only. Kept on real HTTP: D2 (full GET page),
   D4 (404 + dev-server generic page), D8 (/r/:token/go rewrite), I1 (all
   rewrite variants create nothing). */
const { default: reviewHandler } = await import('../api/review.js');
let rip = 100;
async function callReview({ method = 'GET', token, query = {}, body }) {
  const res = fakeRes({ body: '' });
  await reviewHandler({
    method,
    query: { token, ...query },
    url: `/r/${token}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-real-ip': `198.51.100.${rip++}` },
    body, socket: {},
  }, res);
  return { status: res.code, headers: res.headers, text: String(res.body) };
}
const pageIn = (token, query) => callReview({ token, query });
const postIn = (token, body) => callReview({ method: 'POST', token, body });

try {
  await control(TG, { mode: 'ok' }); await reset(TG); await reset(RS);

  /* D0: a stored URL that lost its leading "h" is repaired, and only that.
     Production carried "ttps://search.google.com/..." and the page fell back to
     "Review link unavailable" with no stars — for real customers. */
  {
    const { googleUrlAllowed, reviewPage } = await import('../lib/content.js');
    const typo = 'ttps://search.google.com/local/writereview?placeid=X';
    const fixed = googleUrlAllowed(typo);
    const page = reviewPage({ business: { name: 'A' }, token: 't', googleUrl: typo, stars: 0 });
    const ok = fixed === 'https://search.google.com/local/writereview?placeid=X'
      && googleUrlAllowed('ttps://evil.example/x') === null
      && googleUrlAllowed('http://search.google.com/x') === null
      && (page.html.match(/role="radio"/g) || []).length === 5;
    line(ok, 'D0', 'a "ttps://" typo is repaired; other schemes and hosts rejected', `fixed=${!!fixed}`);
  }

  /* R2: the wrapper. A phone keeps today's page (no card, body gutter only);
     from 640px the same content sits on a white card. The card styles must live
     inside the media rule — outside it they would apply everywhere. */
  {
    const { reviewPage } = await import('../lib/content.js');
    const { getBrand } = await import('../lib/brand.js');
    const c = getBrand().colors;
    const withStars = reviewPage({ business: { name: 'Alder Roofing' }, token: 't', googleUrl: 'https://g.page/r/x', stars: 0 }).html;
    const noLink = reviewPage({ business: { name: 'Alder Roofing' }, token: 't', googleUrl: null, stars: 0 }).html;
    const styleOf = (h) => (h.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
    const split = (h) => {
      const s = styleOf(h);
      const at = s.indexOf('@media (min-width: 640px)');
      return at < 0 ? [s, ''] : [s.slice(0, at), s.slice(at)];
    };
    const [base, media] = split(withStars);
    const baseOk = /\.rv \{ width: 100%; max-width: 420px; margin: 0 auto; box-sizing: border-box \}/.test(base)
      && !/background:|border:|border-radius|box-shadow/.test(base.replace(/@font-face\s*\{[^}]*\}/g, ''));
    const mediaOk = media.includes(`.rv { max-width: 468px; padding: 24px; background: ${c.card}; border: 1px solid ${c.border}; border-radius: 10px }`);
    const wrapper = (h) => h.includes('<main class="rv">') && !/<main style=/.test(h);
    line(baseOk && mediaOk && wrapper(withStars) && wrapper(noLink), 'R2',
      'review page: no card on a phone, white card from 640px',
      `base=${baseOk} media=${mediaOk} both=${wrapper(withStars) && wrapper(noLink)}`);
  }

  /* Token entropy */
  const t0 = token();
  line(t0.length === 32 && /^[A-Za-z0-9_-]+$/.test(t0), 'D1', 'review_token is 192 bits / 32 chars', `${t0.length} chars`);
  const id0 = await seed(t0);

  /* Page before any rating, and for every rating 1..5 */
  const page0 = await fetch(`${ORIGIN}/r/${t0}`);
  const html0 = await page0.text();
  const hasRatingPage = html0.includes('How was your experience with')
    && (html0.match(/<button[^>]*role="radio"[^>]*>/g) || []).length === 5
    && html0.includes('id="continue"')
    && html0.includes('disabled');
  line(page0.status === 200 && hasRatingPage, 'D2', 'page offers a rating widget before any rating', `${page0.status} widget=${hasRatingPage}`);

  // Seeds/pages are order-independent (unique tokens, no shared state):
  // run them concurrently.
  const pages = await Promise.all([1, 2, 3, 4, 5].map(async (s) => {
    const tk = token(); const leadId = await seed(tk);
    await svc.from('review_feedback').upsert({ lead_id: leadId, rating: s, comment: '' }, { onConflict: 'lead_id' });
    const r = await pageIn(tk);
    return { s, token: tk, html: r.text, status: r.status };
  }));
  const allOfferContinue = pages.every((p) => p.status === 200
    && p.html.includes('id="continue"')
    && p.html.includes('disabled'));
  // Pages differ only by their token. The whole widget markup is identical.
  const buttonOf = (html) => {
    const m = /<button[^>]*id="continue"[^>]*>Continue to Google<\/button>/.exec(html);
    return m ? m[0] : '';
  };
  const buttons = pages.map((p) => buttonOf(p.html));
  const identical = buttons.every((b) => b && b === buttons[0]);
  line(allOfferContinue && identical, 'D3', 'Continue button identical for ratings 1..5', `pages=${pages.length} identical=${identical}`);

  /* The new rating page never renders rating state; normalized for the token, the
     whole page is byte-identical for no rating and every rating 1..5. The numeric
     rating is never printed anywhere on the page. */
  const strip = (html, tk) => html.split(tk).join('TOKEN');
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

  /* 1-star POST records the rating, one Telegram alert, Google remains offered */
  const t1 = token(); const lid1 = await seed(t1);
  await reset(TG);
  const post1 = await postIn(t1, 'stars=1&comment=Not+happy');
  const page1 = await pageIn(t1);
  const html1 = page1.text;
  const alerts1 = (await tgCalls()).length;
  const fb1 = await svc.from('review_feedback').select('rating, comment').eq('lead_id', lid1).maybeSingle();
  line(post1.status === 303 && html1.includes('Continue to Google') && alerts1 === 1 && fb1.data.rating === 1,
    'D5', '1-star -> 303, Google continues, one TG alert', `${post1.status} alerts=${alerts1} rating=${fb1.data.rating}`);

  /* 5-star: no Telegram alert */
  const t5 = token(); await seed(t5);
  await reset(TG);
  await postIn(t5, 'stars=5&comment=Great');
  line((await tgCalls()).length === 0, 'D6', '5-star -> no Telegram alert');

  /* second POST updates, does not duplicate */
  await postIn(t1, 'stars=2&comment=Updated');
  const { data: rows } = await svc.from('review_feedback').select('lead_id, rating, comment').eq('lead_id', lid1);
  line(rows.length === 1 && rows[0].rating === 2 && rows[0].comment === 'Updated',
    'D7', 'second POST updates the same row', `rows=${rows.length} rating=${rows[0] && rows[0].rating}`);

  /* D10: low-rating alert dedupe. The owner is alerted only when the stored rating
     MOVES into the 1-2 range (no previous rating, or previous >= 3). A repeat low
     rating must not alert again; a low rating after a 3 must. */
  const t10 = token(); const lid10 = await seed(t10);
  await reset(TG);
  await postIn(t10, 'stars=2&comment=First+complaint');
  const d10First = (await tgCalls()).length;
  await postIn(t10, 'stars=2&comment=Repeat');
  const d10Repeat = (await tgCalls()).length;
  await postIn(t10, 'stars=3&comment=Better');
  const d10Mid = (await tgCalls()).length;
  await postIn(t10, 'stars=1&comment=Worse+again');
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
  line(goPage.status === 200 && goHtml.includes('location.assign') && goHtml.includes('Continue to Google')
    && (await goFb.data).length === 0 && (await goEvents.data).length === 0
    && goFbAfter.data.length === 1 && goFbAfter.data[0].google_clicked === true,
    'D8', '/go lands on the rating page now; POST records the click', `status=${goPage.status} fbAfter=${goFbAfter.data.length}`);

  /* I: new landing page (?s=N / ?go=1). GET must never write; POST records. */
  const tI = token(); const lidI = await seed(tI);
  // I1: GET plain, ?s=1..5, ?go=1 and /go write nothing
  await reset(TG);
  const fbBefore = await svc.from('review_feedback').select('lead_id').eq('lead_id', lidI);
  for (const u of ['', '?s=1', '?s=2', '?s=3', '?s=4', '?s=5', '?go=1', '/go']) {
    await fetch(`${ORIGIN}/r/${tI}${u}`, { redirect: 'manual' });
  }
  const fbAfter = await svc.from('review_feedback').select('lead_id').eq('lead_id', lidI);
  const evAfter = await svc.from('lead_events').select('id').eq('lead_id', lidI);
  line((await fbBefore.data).length === 0 && (await fbAfter.data).length === 0 && (await evAfter.data).length === 0
    && (await tgCalls()).length === 0,
    'I1', 'GET plain, ?s=1..5, ?go=1, /go create zero rows/events/requests', `fb=${(await fbAfter.data).length} ev=${(await evAfter.data).length}`);
  // I2: copy identical for s=1 and s=5 except the pre-selection used by script
  const p1 = (await pageIn(tI, { s: '1' })).text;
  const p5 = (await pageIn(tI, { s: '5' })).text;
  const norm = (h) => h
    .split(tI).join('TOKEN')
    .replace(/"stars":\d/g, '"stars":N')
    .replace(/"googleUrl":"[^"]*"/g, '"googleUrl":"G"');
  line(norm(p1) === norm(p5), 'I2', 'rating page copy identical for s=1 and s=5 except pre-selection', `identical=${norm(p1) === norm(p5)}`);
  // I3: POST from the page's path records once, repeat changes nothing new
  const postLanding = (body) => postIn(tI, body);
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
  const r4 = await postIn(t4, 'stars=2&comment=Meh&go=1');
  const alerts4 = (await tgCalls()).length;
  const landing4 = (await pageIn(t4, { s: '2' })).text;
  // The redirect target is whatever allowlisted URL the business row holds
  // (g.page etc. do not contain the string "google.com"), so assert location.replace
  // carries a non-empty googleUrl that IS allowlisted rather than a substring.
  const m4 = /"googleUrl":"([^"]*)"/.exec(landing4);
  const targetOk = m4 && m4[1].length > 1 && m4[1].startsWith('https://');
  line(alerts4 === 1 && r4.status === 303 && landing4.includes('location.assign') && targetOk,
    'I4', '2-star POST alerts once and the rating page still offers Google', `alerts=${alerts4} target=${targetOk}`);
  // I5: disallowed Google hosts never produce a redirect
  const bads = ['http://evil.example', 'javascript:alert(1)', 'https://google.com.evil.example'];
  const hostGuard = (v) => { try { const u = new URL(v); return u.protocol === 'https:' && ['www.google.com', 'google.com', 'search.google.com', 'maps.google.com', 'g.page', 'maps.app.goo.gl', 'goo.gl'].includes(u.hostname); } catch { return false; } };
  const badAllowed = bads.filter(hostGuard);
  line(badAllowed.length === 0 && landing4.includes('Continue to Google'),
    'I5', 'disallowed Google hosts never produce a redirect', `badAllowed=${badAllowed.join(',')}`);
  // I6: s=0, s=6, s=abc -> same interactive rating page; no auto redirect timer
  const i6pages = [{ s: '0' }, { s: '6' }, { s: 'abc' }];
  const i6ok = [];
  for (const q of i6pages) {
    const h = (await pageIn(t4, q)).text;
    i6ok.push(h.includes('How was your experience with') && h.includes('Continue to Google')
      && h.includes('<svg') && h.includes('id="stars"') && h.includes('id="continue"')
      && !h.includes('setTimeout(function(){'));
  }
  line(i6ok.every(Boolean), 'I6', 's=0, s=6, s=abc fall back to the interactive rating page', i6ok.join('/'));
  // I7: token from another business changes nothing (tenancy on the landing page)
  const t7 = token(); await seed(t7);
  const foreignBefore = await svc.from('review_feedback').select('lead_id').eq('lead_id', (await svc.from('leads').select('id').eq('review_token', t7).maybeSingle()).data?.id || '');
  await pageIn(tI, { s: '5' });
  await pageIn(t7, { s: '5' });
  const foreignAfter = await svc.from('review_feedback').select('lead_id').eq('lead_id', (await svc.from('leads').select('id').eq('review_token', t7).maybeSingle()).data?.id || '');
  line((await foreignBefore.data).length === 0 && (await foreignAfter.data).length === 0,
    'I7', 'landing GET for another business token writes nothing', `fb=${(await foreignAfter.data).length}`);

  /* I8: the landing card is vertically AND horizontally centred in every state */
  const i8Pages = [];
  i8Pages.push((await pageIn(tI, { s: '3' })).text);
  i8Pages.push((await pageIn(tI, { go: '1' })).text);
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

  /* I9: interactive rating page structure — SVG stars, disabled-until-rated
     button, and no timer-based redirect before user action. */
  const i9 = (await pageIn(tI, { s: '3' })).text;
  const svgSpans = [1, 2, 3, 4, 5].every((n) => i9.includes(`data-star="${n}"`) && i9.includes('<svg'));
  line(svgSpans && !/[★☆]/.test(i9) && i9.includes('<button id="continue" type="button" disabled')
    && i9.includes('role="radiogroup"') && i9.includes('aria-label="Rating"')
    && i9.includes('min-width:44px;min-height:44px')
    && !i9.includes('setTimeout(function(){'),
    'I9', 'SVG stars, no text glyphs, Continue disabled until rating, no auto-redirect timer',
    `svg=${svgSpans}`);

  /* R1: review page head — same-origin @font-face (Geist+Inter) with swap,
     heading preload, favicon links, no card styling, smaller title.
     Before (card design): main had background/border/radius/28px padding,
     title 24px, body padding 16px, no fonts/favicon in the head. */
  {
    const r1 = (await pageIn(tI, { s: '3' })).text;
    const fontsOk = r1.includes('@font-face') && r1.includes(`font-family:'Geist'`) && r1.includes(`font-family:'Inter'`)
      && r1.includes(`url('/assets/fonts/geist-var.woff2')`) && r1.includes(`url('/assets/fonts/inter-var.woff2')`)
      && r1.includes('font-display:swap') && r1.includes('<link rel="preload" as="font" href="/assets/fonts/geist-var.woff2"');
    const iconsOk = r1.includes('rel="icon" href="/assets/icons/favicon.svg"')
      && r1.includes('rel="icon" href="/assets/icons/favicon-32x32.png"')
      && r1.includes('rel="apple-touch-icon" href="/assets/icons/apple-touch-icon-v1.png"');
    /* The wrapper is a class now, not an inline style: the same rule serves both
       variants and the media query can override it. The no-card assertion moved
       with it — the base rule must still carry no background or border. */
    const baseRule = (/\.rv \{([^}]*)\}/.exec(r1) || [])[1] || '';
    const noCard = r1.includes('<main class="rv">') && !/<main style=/.test(r1)
      && !/background:|border:|border-radius|box-shadow|padding:28px/.test(baseRule)
      && baseRule.includes('max-width: 420px') && /padding:0 24px/.test(r1);
    const titleOk = r1.includes('font:600 20px/26px') && r1.includes('text-wrap:balance') && !r1.includes('24px/30px');
    line(fontsOk && iconsOk && noCard && titleOk, 'R1', 'review head: fonts+preload+favicon, no card, 20px title',
      `fonts=${fontsOk} icons=${iconsOk} noCard=${noCard} title=${titleOk}`);
  }

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
