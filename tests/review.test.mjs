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

  /* /go redirect, including a forced DB write failure */
  const t2 = token(); await seed(t2);
  const go = await fetch(`${ORIGIN}/r/${t2}/go`, { redirect: 'manual' });
  const goFail = await fetch(`${ORIGIN}/r/${t2}/go`, { redirect: 'manual', headers: { 'x-review-force-fail': '1' } });
  line(go.status === 302 && go.headers.get('location') === biz.google_review_url
    && goFail.status === 302 && goFail.headers.get('location') === biz.google_review_url,
    'D8', '/go redirects even when the DB write fails', `${go.status}/${goFail.status}`);

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
