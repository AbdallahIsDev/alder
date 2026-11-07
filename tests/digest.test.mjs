#!/usr/bin/env node
// tests/digest.test.mjs — Gate D (daily digest).
// HARNESS: in-process, no HTTP server, no database writes. PostgREST is faked at
// the fetch layer; Telegram and Resend are the loopback fakes. Nothing is sent.
//
// What it proves:
//   D1  Off by default: no DIGEST_ENABLED -> 200 { enabled: false }, no sends.
//   D2  Auth is the selfcheck matrix: 503 without HEALTH_SECRET, 401 for a wrong
//       header, the health secret as a bearer, or the cron secret in the header;
//       the cron bearer works; POST -> 405.
//   D3  Counts: new leads, possible repeats, untouched and failed, per business.
//   D4  A business with nothing to report gets no message.
//   D5  Telegram down -> the same counts go out by email.
//   D6  Both down -> 200 with a summary and no throw.
//   D7  A second call on the same UTC day sends nothing (the per-day claim).
//   D8  The text carries no PII: no address, no business name, no phone.

import { loadEnv } from './env.mjs';
import { fakeRes } from './helpers.mjs';

loadEnv();

let failed = 0, total = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(52)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 100) : ''}`);
};

const saved = {
  HEALTH_SECRET: process.env.HEALTH_SECRET,
  CRON_SECRET: process.env.CRON_SECRET,
  DIGEST_ENABLED: process.env.DIGEST_ENABLED,
  VERCEL_ENV: process.env.VERCEL_ENV,
  TELEGRAM_API_BASE: process.env.TELEGRAM_API_BASE,
  RESEND_API_BASE: process.env.RESEND_API_BASE,
  MAIL_FROM: process.env.MAIL_FROM,
  MAIL_REDIRECT_TO: process.env.MAIL_REDIRECT_TO,
};

const TG = process.env.FAKE_TG_URL;
const RS = process.env.FAKE_RESEND_URL;
const realFetch = globalThis.fetch;
const ctl = (base, body) => realFetch(base + '/__control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const resetFake = (base) => realFetch(base + '/__reset', { method: 'POST' });
const fakeReqs = async (base) => (await (await realFetch(base + '/__requests')).json()).requests;

try {
  process.env.HEALTH_SECRET = 'health-test-secret-value';
  process.env.CRON_SECRET = 'cron-test-secret-value';
  process.env.VERCEL_ENV = 'development';
  process.env.TELEGRAM_API_BASE = TG;
  process.env.RESEND_API_BASE = RS;
  process.env.MAIL_FROM = 'alerts@example.com';
  delete process.env.MAIL_REDIRECT_TO;
  delete process.env.DIGEST_ENABLED;

  const {
    default: handler, digestText, digestHasSomething, digestEnabled, digestUntouchedDays,
  } = await import('../api/digest.js');

  const call = async ({ method = 'GET', secret, bearer } = {}) => {
    const res = fakeRes();
    const headers = {};
    if (secret !== undefined) headers['x-health-secret'] = secret;
    if (bearer !== undefined) headers.authorization = 'Bearer ' + bearer;
    await handler({ method, headers }, res);
    return res;
  };

  /* ---------- D1: off by default ---------- */
  {
    await ctl(TG, { mode: 'ok' }); await resetFake(TG);
    const r = await call({ secret: 'health-test-secret-value' });
    const reqs = await fakeReqs(TG);
    line(r.code === 200 && r.body && r.body.ok === true && r.body.enabled === false && reqs.length === 0,
      'D1', 'disabled unless DIGEST_ENABLED=1', `code=${r.code} enabled=${r.body && r.body.enabled} tg=${reqs.length}`);
  }

  /* ---------- D2: auth matrix ---------- */
  {
    const noSecret = await (async () => {
      const keep = process.env.HEALTH_SECRET;
      delete process.env.HEALTH_SECRET;
      const r = await call({ secret: 'anything' });
      process.env.HEALTH_SECRET = keep;
      return r;
    })();
    const wrongHeader = await call({ secret: 'nope' });
    const healthAsBearer = await call({ bearer: 'health-test-secret-value' });
    const cronInHeader = await call({ secret: 'cron-test-secret-value' });
    const cronBearer = await call({ bearer: 'cron-test-secret-value' });
    const post = await call({ method: 'POST', secret: 'health-test-secret-value' });
    const ok = noSecret.code === 503 && wrongHeader.code === 401 && healthAsBearer.code === 401
      && cronInHeader.code === 401 && cronBearer.code === 200 && post.code === 405;
    line(ok, 'D2', 'auth matrix: 503 / 401 x3 / cron bearer / 405',
      `${noSecret.code}/${wrongHeader.code}/${healthAsBearer.code}/${cronInHeader.code}/${cronBearer.code}/${post.code}`);
  }

  /* ---------- fixture at the fetch layer ---------- */
  const A = 'aaaaaaaa-0000-0000-0000-000000000001';
  const B = 'bbbbbbbb-0000-0000-0000-000000000002';
  const C = 'cccccccc-0000-0000-0000-000000000003';
  const fixture = {
    businesses: [
      { id: A, slug: 'alder-demo', name: 'Alder Roofing', owner_email: 'owner@example.com', status: 'demo' },
      { id: B, slug: 'beta', name: 'Beta Roofing', owner_email: 'beta@example.com', status: 'active' },
      { id: C, slug: 'quiet', name: 'Quiet Roofing', owner_email: 'quiet@example.com', status: 'demo' },
      { id: 'pppppppp-0000-0000-0000-000000000004', slug: 'paused', name: 'Paused Roofing', owner_email: 'paused@example.com', status: 'paused' },
    ],
    chats: [{ business_id: A, tg_chat_id: 'chat-a' }],
    // A: three fresh leads, one flagged as a repeat, two old open ones, one failed alert.
    leadsFresh: [
      { id: 'a1', business_id: A }, { id: 'a2', business_id: A }, { id: 'a3', business_id: A },
      { id: 'b1', business_id: B },
    ],
    createdEvents: [
      { lead_id: 'a2', meta: { duplicate_of: 'old-1' } },
      { lead_id: 'a1', meta: {} },
      { lead_id: 'b1', meta: {} },
    ],
    openOld: [{ id: 'a-old1', business_id: A }, { id: 'a-old2', business_id: A }],
    contacted: [{ lead_id: 'a-old2' }],
    failedEvents: [{ lead_id: 'a1', kind: 'tg_failed' }],
    claim: true,
  };

  let installed = null;
  let lastUrls = [];
  const install = (fx) => {
    const SB = process.env.SUPABASE_URL;
    const claimed = new Set();
    const seen = [];
    lastUrls = seen;
    globalThis.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.startsWith(SB)) return realFetch(input, init);
      const u = new URL(url);
      seen.push(url);
      const table = u.pathname.replace('/rest/v1/', '');
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      // PostgREST caps a response at 1,000 rows. supabase-js turns .range(a, b)
      // into offset/limit query params, so the fake pages the same way — without
      // this a missing range() in the client would look correct.
      const rFrom = Number(u.searchParams.get('offset') || 0);
      const rLimit = u.searchParams.get('limit');
      const rTo = rLimit ? rFrom + Number(rLimit) - 1 : 1e9;
      const page = (rows) => rows.slice(rFrom, rTo + 1);
      if (table === 'rate_limits' && String(init.method || '').toUpperCase() === 'DELETE') {
        const key = (u.searchParams.get('key') || '').replace('eq.', '');
        claimed.delete(key);
        return json([]);
      }
      if (table === 'rpc/hit_rate_limit') {
        const body = JSON.parse(init.body || '{}');
        const key = body.p_key;
        if (claimed.has(key)) return json(false);
        claimed.add(key);
        return json(fx.claim);
      }
      if (table === 'leads') {
        if (u.searchParams.get('status') === 'eq.open') return json(page(fx.openOld));
        if (u.searchParams.get('id')) return json(page([]));
        return json(page(fx.leadsFresh));
      }
      if (table === 'lead_events') {
        const kind = u.searchParams.get('kind') || '';
        const inList = u.searchParams.get('lead_id') || '';
        if (kind === 'eq.created') return json(page(fx.createdEvents));
        if (kind === 'eq.contacted') {
          // Honour the in.(...) list, so a missing chunk shows up as missing rows.
          const wanted = inList.startsWith('in.(') ? inList.slice(4, -1).split(',') : null;
          const rows = wanted ? fx.contacted.filter((c) => wanted.includes(c.lead_id)) : fx.contacted;
          return json(page(rows));
        }
        return json(page(fx.failedEvents));
      }
      if (table === 'businesses') {
        const st = u.searchParams.get('status');
        if (st && st.startsWith('in.(')) {
          const allowed = st.slice(4, -1).split(',');
          return json(fx.businesses.filter((b) => allowed.includes(b.status)));
        }
        return json(fx.businesses);
      }
      if (table === 'business_chats') return json(fx.chats);
      return json([]);
    };
    installed = () => { globalThis.fetch = realFetch; };
  };

  const run = async () => {
    process.env.DIGEST_ENABLED = '1';
    await ctl(TG, { mode: 'ok' }); await ctl(RS, { mode: 'ok' });
    await resetFake(TG); await resetFake(RS);
    const r = await call({ secret: 'health-test-secret-value' });
    const tg = (await fakeReqs(TG)).filter((x) => x.path.includes('/sendMessage'));
    const mail = (await fakeReqs(RS)).filter((x) => x.path === '/emails');
    return { r, tg, mail };
  };

  /* ---------- D3: counts per business ---------- */
  try {
    install(fixture);
    const { r, tg, mail } = await run();
    const textA = (tg[0] && tg[0].body && tg[0].body.text) || '';
    const textB = (mail[0] && mail[0].body && mail[0].body.text) || '';
    const aOk = textA.includes('New requests: 3') && textA.includes('Possible repeat requests: 1')
      && textA.includes('Waiting for you over a day: 1')
      && textA.includes('Needs attention') && textA.includes('1 lead alert to your phone could not be delivered')
      && textA.includes('Open /leads to see them.');
    // B had no failure, so it must have no Needs attention section at all.
    const bOk = textB.includes('New requests: 1') && textB.includes('Waiting for you over a day: 0')
      && !textB.includes('Needs attention');
    line(r.code === 200 && tg.length === 1 && mail.length === 1 && aOk && bOk,
      'D3', 'counts: new / repeats / untouched / failed, per business',
      `code=${r.code} tg=${tg.length} mail=${mail.length} a=${aOk} b=${bOk} sent=${r.body.sent} emailed=${r.body.emailed}`);
  } catch (e) {
    line(false, 'D3', 'counts: new / repeats / untouched / failed, per business', e.message);
  } finally { if (installed) installed(); }

  /* ---------- D4: a quiet business gets nothing ---------- */
  try {
    install({ ...fixture, businesses: [{ id: C, slug: 'quiet', name: 'Quiet Roofing', owner_email: 'quiet@example.com' }], chats: [], leadsFresh: [], createdEvents: [], openOld: [], contacted: [], failedEvents: [] });
    const { r, tg, mail } = await run();
    line(r.code === 200 && r.body.businesses === 0 && tg.length === 0 && mail.length === 0,
      'D4', 'quiet business: no message at all', `code=${r.code} businesses=${r.body.businesses} tg=${tg.length} mail=${mail.length}`);
  } catch (e) {
    line(false, 'D4', 'quiet business: no message at all', e.message);
  } finally { if (installed) installed(); }

  /* ---------- D10: a paused business is never a target ---------- */
  try {
    const P = 'pppppppp-0000-0000-0000-000000000004';
    install({
      ...fixture,
      businesses: [{ id: P, slug: 'paused', name: 'Paused Roofing', owner_email: 'paused@example.com', status: 'paused' }],
      chats: [{ business_id: P, tg_chat_id: 'chat-p' }],
      leadsFresh: [{ id: 'p1', business_id: P }],
      createdEvents: [], openOld: [], contacted: [], failedEvents: [],
    });
    const { r, tg, mail } = await run();
    line(r.code === 200 && r.body.businesses === 0 && tg.length === 0 && mail.length === 0,
      'D10', 'paused business with a chat and an owner gets nothing',
      `code=${r.code} businesses=${r.body.businesses} tg=${tg.length} mail=${mail.length}`);
  } catch (e) {
    line(false, 'D10', 'paused business with a chat and an owner gets nothing', e.message);
  } finally { if (installed) installed(); }

  /* ---------- D11/D12: the untouched lookback ---------- */
  {
    const savedDays = process.env.DIGEST_UNTOUCHED_DAYS;
    delete process.env.DIGEST_UNTOUCHED_DAYS;
    const def = digestUntouchedDays();
    process.env.DIGEST_UNTOUCHED_DAYS = '7';
    const seven = digestUntouchedDays();
    const bad = ['0', '-2', 'abc', ''].every((v) => { process.env.DIGEST_UNTOUCHED_DAYS = v; return digestUntouchedDays() === 14; });
    if (savedDays === undefined) delete process.env.DIGEST_UNTOUCHED_DAYS; else process.env.DIGEST_UNTOUCHED_DAYS = savedDays;
    line(def === 14 && seven === 7 && bad, 'D11', 'untouched lookback: default 14, invalid falls back',
      `default=${def} explicit=${seven} invalid=${bad}`);
  }

  try {
    install(fixture);
    const before = Date.now();
    await run();
    const openUrl = lastUrls.find((u) => u.includes('status=eq.open')) || '';
    const m = /created_at=gte\.([^&]+)/.exec(openUrl);
    const floor = m ? Date.parse(decodeURIComponent(m[1])) : NaN;
    const days = m ? (before - floor) / 86400000 : NaN;
    const bounded = Number.isFinite(days) && days > 13.9 && days < 14.1;
    line(bounded, 'D12', 'untouched query is bounded to the 14-day lookback',
      `floorDays=${Number.isFinite(days) ? days.toFixed(2) : 'none'} url=${openUrl.length} chars`);
  } catch (e) {
    line(false, 'D12', 'untouched query is bounded to the 14-day lookback', e.message);
  } finally { if (installed) installed(); }

  /* ---------- D13: 250 open leads and 1,200 events, exact and short ---------- */
  try {
    // UUID-shaped ids, like the real column: 250 short strings would not show
    // the URL problem at all.
    const bigLeads = Array.from({ length: 250 }, (_, i) => ({
      id: `aaaaaaaa-0000-0000-0000-${String(i).padStart(12, '0')}`, business_id: A,
    }));
    const contactedEvents = [];
    for (let i = 0; i < 150; i++) contactedEvents.push({ lead_id: bigLeads[i].id });
    while (contactedEvents.length < 1200) contactedEvents.push({ lead_id: bigLeads[0].id });
    install({
      ...fixture,
      businesses: [fixture.businesses[0]],
      chats: [{ business_id: A, tg_chat_id: 'chat-a' }],
      leadsFresh: [], createdEvents: [], openOld: bigLeads, contacted: contactedEvents, failedEvents: [],
    });
    const { r, tg } = await run();
    const text = (tg[0] && tg[0].body && tg[0].body.text) || '';
    const maxUrl = lastUrls.reduce((a, u) => Math.max(a, u.length), 0);
    const contactedCalls = lastUrls.filter((u) => u.includes('lead_id=in.')).length;
    // Four chunks (250 / 80) plus a second page for the chunk that holds the lead
    // with 1,050 duplicate events — so >= 4 proves chunking and <= 6 proves the
    // loop is not spinning.
    const ok = r.code === 200 && text.includes('Waiting for you over a day: 100')
      && maxUrl < 4000 && contactedCalls >= 4 && contactedCalls <= 6;
    line(ok, 'D13', '250 leads / 1200 events: exact, chunked, short URLs',
      `untouched=${(text.match(/Waiting for you over a day: (\d+)/) || [])[1]} maxUrl=${maxUrl} chunks=${contactedCalls}`);
  } catch (e) {
    line(false, 'D13', '250 leads / 1200 events: exact, chunked, short URLs', e.message);
  } finally { if (installed) installed(); }

  /* ---------- D14/D15: a claim is released only when nobody heard it ---------- */
  try {
    install({ ...fixture, businesses: [fixture.businesses[0]], chats: [{ business_id: A, tg_chat_id: 'chat-a' }] });
    process.env.DIGEST_ENABLED = '1';
    await ctl(TG, { mode: '500' }); await ctl(RS, { mode: '500' });
    await resetFake(TG); await resetFake(RS);
    const first = await call({ secret: 'health-test-secret-value' });
    const second = await call({ secret: 'health-test-secret-value' });
    line(first.body.sent === 0 && first.body.emailed === 0 && first.body.released === 1
      && second.body.businesses === 1 && second.body.skipped === 0,
      'D14', 'both down: claim released, retry the same day sends',
      `released=${first.body.released} retryBusinesses=${second.body.businesses} skipped=${second.body.skipped}`);
  } catch (e) {
    line(false, 'D14', 'both down: claim released, retry the same day sends', e.message);
  } finally { if (installed) installed(); }

  try {
    install({ ...fixture, businesses: [fixture.businesses[0]], chats: [{ business_id: A, tg_chat_id: 'chat-a' }] });
    process.env.DIGEST_ENABLED = '1';
    await ctl(TG, { mode: '500' }); await ctl(RS, { mode: 'ok' });
    await resetFake(TG); await resetFake(RS);
    const first = await call({ secret: 'health-test-secret-value' });
    const second = await call({ secret: 'health-test-secret-value' });
    line(first.body.emailed === 1 && first.body.released === 0
      && second.body.businesses === 0 && second.body.skipped === 1,
      'D15', 'one channel up: claim kept, retry skipped',
      `emailed=${first.body.emailed} released=${first.body.released} retrySkipped=${second.body.skipped}`);
  } catch (e) {
    line(false, 'D15', 'one channel up: claim kept, retry skipped', e.message);
  } finally { if (installed) installed(); }

  /* ---------- D5: Telegram down -> email ---------- */
  try {
    install({ ...fixture, businesses: [fixture.businesses[0]], chats: [{ business_id: A, tg_chat_id: 'chat-a' }] });
    process.env.DIGEST_ENABLED = '1';
    await ctl(TG, { mode: '500' }); await ctl(RS, { mode: 'ok' });
    await resetFake(TG); await resetFake(RS);
    const r = await call({ secret: 'health-test-secret-value' });
    const mail = (await fakeReqs(RS)).filter((x) => x.path === '/emails');
    const to = mail[0] && JSON.stringify(mail[0].body.to);
    line(r.code === 200 && r.body.sent === 0 && r.body.emailed === 1 && mail.length === 1
      && to === JSON.stringify(['owner@example.com']),
      'D5', 'telegram down: same counts go out by email', `sent=${r.body.sent} emailed=${r.body.emailed} to=${to}`);
  } catch (e) {
    line(false, 'D5', 'telegram down: same counts go out by email', e.message);
  } finally { if (installed) installed(); }

  /* ---------- D6: both down ---------- */
  try {
    install({ ...fixture, businesses: [fixture.businesses[0]], chats: [{ business_id: A, tg_chat_id: 'chat-a' }] });
    process.env.DIGEST_ENABLED = '1';
    await ctl(TG, { mode: '500' }); await ctl(RS, { mode: '500' });
    await resetFake(TG); await resetFake(RS);
    const r = await call({ secret: 'health-test-secret-value' });
    line(r.code === 200 && r.body.ok === true && r.body.sent === 0 && r.body.emailed === 0 && r.body.businesses === 1,
      'D6', 'both down: 200 with a summary, no throw', `code=${r.code} sent=${r.body.sent} emailed=${r.body.emailed}`);
  } catch (e) {
    line(false, 'D6', 'both down: 200 with a summary, no throw', e.message);
  } finally { if (installed) installed(); }

  /* ---------- D7: a second call the same day sends nothing ---------- */
  try {
    install({ ...fixture, businesses: [fixture.businesses[0]], chats: [{ business_id: A, tg_chat_id: 'chat-a' }] });
    process.env.DIGEST_ENABLED = '1';
    await ctl(TG, { mode: 'ok' }); await ctl(RS, { mode: 'ok' });
    await resetFake(TG); await resetFake(RS);
    const first = await call({ secret: 'health-test-secret-value' });
    const tg1 = (await fakeReqs(TG)).filter((x) => x.path.includes('/sendMessage')).length;
    const second = await call({ secret: 'health-test-secret-value' });
    const tg2 = (await fakeReqs(TG)).filter((x) => x.path.includes('/sendMessage')).length;
    line(first.body.businesses === 1 && tg1 === 1 && second.body.businesses === 0 && second.body.skipped === 1 && tg2 === 1,
      'D7', 'second call the same UTC day sends nothing', `first=${tg1} second=${tg2} skipped=${second.body.skipped}`);
  } catch (e) {
    line(false, 'D7', 'second call the same UTC day sends nothing', e.message);
  } finally { if (installed) installed(); }

  /* ---------- D3b: failures are named by kind, a zero kind is hidden ---------- */
  {
    const { digestBody } = await import('../lib/ops-copy.js');
    const one = digestBody({ newLeads: 0, repeats: 0, untouched: 0, failed: 2, failures: { tg_failed: 1, autoreply_failed: 1 } });
    const none = digestBody({ newLeads: 0, repeats: 0, untouched: 0, failed: 1, failures: { tg_failed: 1, review_request_failed: 0 } });
    const ok = one.includes('1 lead alert to your phone could not be delivered')
      && one.includes('1 confirmation email to a customer failed')
      && !one.includes('review request')
      && none.includes('1 lead alert to your phone could not be delivered') && !none.includes('review request');
    line(ok, 'D3b', 'digest failures named by kind; a zero kind is not shown', `one=${one.length} none=${none.length}`);
  }

  /* ---------- D8: the text carries no PII ---------- */
  {
    const text = digestText({ newLeads: 3, repeats: 1, untouched: 2, failed: 1 }, '2026-11-07');
    // The date moved to the email subject; the body is counts and plain words.
    const clean = !text.includes('@') && !/alder|beta roofing|quiet/i.test(text)
      && !/\d{3}[-.\s]\d{3}[-.\s]\d{4}/.test(text)
      && text.startsWith('📋 Your lead summary') && text.includes('Open /leads to see them.');
    line(clean, 'D8', 'digest text: counts only, no address or name', `${text.length} chars`);
  }

  /* ---------- D9: the rule ---------- */
  {
    const quiet = digestHasSomething({ newLeads: 0, repeats: 0, untouched: 0, failed: 0 });
    const repeatsOnly = digestHasSomething({ newLeads: 0, repeats: 3, untouched: 0, failed: 0 });
    const some = digestHasSomething({ newLeads: 0, repeats: 0, untouched: 1, failed: 0 });
    const on = digestEnabled();
    line(quiet === false && repeatsOnly === false && some === true && on === true,
      'D9', 'sends only when new / untouched / failed > 0', `quiet=${quiet} repeatsOnly=${repeatsOnly} some=${some} enabled=${on}`);
  }
} finally {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  await ctl(TG, { mode: 'ok' }).catch(() => {});
  await ctl(RS, { mode: 'ok' }).catch(() => {});
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
