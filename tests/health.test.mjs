#!/usr/bin/env node
// tests/health.test.mjs — Gate H, plus the daily self-check.
// HARNESS: in-process, no HTTP server. The handlers are called directly with a fake
// request/response; the counts query goes to the configured database (read-only).
// Sends are blocked by the .test-mode interlock, so no real Telegram message leaves.
//
// What it proves:
//   H1  No HEALTH_SECRET configured -> 503. An unconfigured deployment is loud,
//       not silently open.
//   H2  Wrong or missing header -> 401, and nothing is queried.
//   H3  Correct secret -> 200.
//   H4  Shape: numbers and booleans only, exactly the agreed keys, no PII, no
//       values from the environment.
//   H5  POST -> 405.
//   S1  /api/selfcheck: no secret -> 503; S2 wrong secret -> 401.
//   S3  The alert rule and the message text (pure, no database): only counts, no
//       names, no addresses.
//   S4  /api/selfcheck authorised -> 200 with counts and booleans only.

import { loadEnv } from './env.mjs';
import { fakeRes } from './helpers.mjs';

loadEnv();

let failed = 0, total = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(50)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};

const { default: handler } = await import('../api/health.js');
const { default: selfcheck, shouldAlert, selfCheckText, alertTargets, deliverSelfCheck, selfCheckEmail } = await import('../api/selfcheck.js');

const KINDS = ['created', 'tg_sent', 'tg_failed', 'email_owner_sent', 'email_owner_failed', 'autoreply_failed', 'review_request_failed'];
const TOP = ['last_24h', 'last_hour', 'mail_redirect_active', 'ok', 'salt_set', 'webhook_secret_set'];

const call = async ({ method = 'GET', secret } = {}) => {
  const res = fakeRes();
  const headers = secret === undefined ? {} : { 'x-health-secret': secret };
  await handler({ method, headers }, res);
  return res;
};

const saved = { HEALTH_SECRET: process.env.HEALTH_SECRET, CRON_SECRET: process.env.CRON_SECRET, MAIL_REDIRECT_TO: process.env.MAIL_REDIRECT_TO };
try {
  /* H1: no secret configured */
  delete process.env.HEALTH_SECRET;
  {
    const r = await call({ secret: 'anything' });
    line(r.code === 503 && r.body && r.body.ok === false, 'H1', 'no HEALTH_SECRET -> 503', `code=${r.code}`);
  }

  /* H2: configured, but the caller has the wrong (or no) secret */
  process.env.HEALTH_SECRET = 'health-test-secret-value';
  {
    const wrong = await call({ secret: 'not-the-secret' });
    const short = await call({ secret: 'health-test' });
    const none = await call({});
    const ok = wrong.code === 401 && short.code === 401 && none.code === 401
      && [wrong, short, none].every((r) => r.body && r.body.ok === false);
    line(ok, 'H2', 'wrong, short or missing secret -> 401', `${wrong.code}/${short.code}/${none.code}`);
  }

  /* H3 + H4: authorised call returns counts and booleans, nothing else */
  {
    const r = await call({ secret: 'health-test-secret-value' });
    const body = r.body || {};
    const shapeOk = r.code === 200 && body.ok === true
      && JSON.stringify(Object.keys(body).sort()) === JSON.stringify(TOP)
      && JSON.stringify(Object.keys(body.last_hour || {}).sort()) === JSON.stringify([...KINDS].sort())
      && JSON.stringify(Object.keys(body.last_24h || {}).sort()) === JSON.stringify([...KINDS].sort());
    line(shapeOk, 'H3', 'authorised call returns the agreed shape', `code=${r.code} keys=${Object.keys(body).length}`);

    const numeric = [...Object.values(body.last_hour || {}), ...Object.values(body.last_24h || {})];
    const countsOk = numeric.length === KINDS.length * 2
      && numeric.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
    const boolsOk = ['mail_redirect_active', 'webhook_secret_set', 'salt_set']
      .every((k) => typeof body[k] === 'boolean');
    // Nothing but counts and booleans: no string anywhere in the payload.
    const noStrings = !/[":]\s*"[^"]/.test(JSON.stringify(body));
    line(countsOk && boolsOk && noStrings, 'H4', 'numbers and booleans only, no PII or env values',
      `counts=${numeric.length} bools=${boolsOk} strings=${!noStrings}`);
  }

  /* H5: GET only */
  {
    const r = await call({ method: 'POST', secret: 'health-test-secret-value' });
    line(r.code === 405, 'H5', 'POST -> 405', `code=${r.code}`);
  }
  /* H6: both cron entries are valid for a Hobby plan.
     Hobby allows one run per day per job and rejects a more frequent expression at
     deploy time, so a five-minute schedule here would break the deployment, not
     just the job. Each path must resolve to a real function, and the two must not
     land on the same hour (two daily messages in one minute is a bad morning). */
  {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    const crons = cfg.crons || [];
    const shapes = crons.map((c) => {
      const [m, h, dom, mon, dow] = c.schedule.split(' ');
      return {
        path: c.path,
        hour: h,
        daily: c.schedule.split(' ').length === 5 && m !== '*' && h !== '*' && dom === '*' && mon === '*' && dow === '*',
        resolves: fs.existsSync(path.join(ROOT, c.path.replace(/^\//, '') + '.js')),
      };
    });
    const allDaily = shapes.length === 2 && shapes.every((x) => x.daily && x.resolves);
    const distinct = new Set(shapes.map((x) => x.hour)).size === shapes.length;
    const paths = shapes.map((x) => x.path).sort().join(',');
    // Exact hours, so moving a cron is a deliberate edit with a failing test
    // rather than something that quietly changes when the owner is messaged.
    const hours = crons.map((c) => c.schedule).sort().join(',');
    const pinned = hours === '0 13 * * *,0 9 * * *';
    line(allDaily && distinct && pinned && paths === '/api/digest,/api/selfcheck', 'H6',
      'crons: two daily jobs, both resolve, pinned hours',
      `n=${crons.length} hours=${shapes.map((x) => x.hour).join('/')} daily=${allDaily} distinct=${distinct} pinned=${pinned} paths=${paths}`);
  }

  /* ---------- self-check ---------- */

  const callCheck = async ({ method = 'GET', secret, bearer } = {}) => {
    const res = fakeRes();
    const headers = {};
    if (secret !== undefined) headers['x-health-secret'] = secret;
    if (bearer !== undefined) headers.authorization = 'Bearer ' + bearer;
    await selfcheck({ method, headers }, res);
    return res;
  };

  /* S1: no secret configured */
  delete process.env.HEALTH_SECRET;
  {
    const r = await callCheck({ secret: 'anything' });
    line(r.code === 503 && r.body && r.body.ok === false, 'S1', 'selfcheck: no HEALTH_SECRET -> 503', `code=${r.code}`);
  }

  /* S2: the two secrets are not interchangeable. The health secret works in the
     header only; the cron secret works as a bearer only. */
  process.env.HEALTH_SECRET = 'health-test-secret-value';
  process.env.CRON_SECRET = 'cron-test-secret-value';
  {
    const wrongHeader = await callCheck({ secret: 'nope' });
    const wrongBearer = await callCheck({ bearer: 'nope' });
    const healthAsBearer = await callCheck({ bearer: 'health-test-secret-value' });
    const cronInHeader = await callCheck({ secret: 'cron-test-secret-value' });
    const ok = [wrongHeader, wrongBearer, healthAsBearer, cronInHeader].every((r) => r.code === 401);
    line(ok, 'S2', 'selfcheck: secrets are not interchangeable',
      `${wrongHeader.code}/${wrongBearer.code}/${healthAsBearer.code}/${cronInHeader.code}`);
  }

  /* S3: the rule and the message text, without a database */
  {
    const ruleOk = shouldAlert({ failedTotal: 0, redirectActive: false }) === false
      && shouldAlert({ failedTotal: 1, redirectActive: false }) === true
      && shouldAlert({ failedTotal: 0, redirectActive: true }) === true;
    const zero = Object.fromEntries(KINDS.map((k) => [k, 0]));
    const text = selfCheckText({ ...zero, tg_failed: 2 }, { redirectActive: true });
    const countsOnly = !text.includes('@') && !/alder/i.test(text) && !text.includes('+1')
      && text.includes('tg_failed 2') && text.includes('2 alerts did not go out')
      && text.includes('Email redirect is ON');
    const clean = selfCheckText(zero, { redirectActive: false });
    const silent = !clean.includes('did not go out') && !clean.includes('redirect');
    line(ruleOk && countsOnly && silent, 'S3', 'selfcheck: rule and counts-only text',
      `rule=${ruleOk} counts=${countsOnly} silent=${silent}`);
  }

  /* S6-S9: delivery — Telegram first, email only when Telegram did not land.
     The senders are injected, so these are behaviour tests without a database or
     a network: the same code path the handler uses. */

  /* S6: Telegram down -> the counts go out by email instead */
  {
    const calls = { tg: 0, mail: 0 };
    const r = await deliverSelfCheck({
      targets: ['biz-1'], text: 'T',
      chatsFor: async () => ['chat-1'],
      sendTg: async () => { calls.tg++; return { ok: false, status: 500 }; },
      sendMailFor: async () => { calls.mail++; return { ok: true }; },
    });
    line(r.sent === 0 && r.emailed === 1 && calls.tg === 1 && calls.mail === 1, 'S6',
      'telegram down: same counts go out by email', `sent=${r.sent} emailed=${r.emailed} tg=${calls.tg} mail=${calls.mail}`);
  }

  /* S7: both down -> nothing delivered, no throw, summary still says so */
  {
    const calls = { tg: 0, mail: 0 };
    const r = await deliverSelfCheck({
      targets: ['biz-1'], text: 'T',
      chatsFor: async () => ['chat-1'],
      sendTg: async () => { calls.tg++; return { ok: false, status: 'timeout' }; },
      sendMailFor: async () => { calls.mail++; return { ok: false, status: 500 }; },
    });
    line(r.sent === 0 && r.emailed === 0 && calls.tg === 1 && calls.mail === 1, 'S7',
      'both down: nothing delivered, no throw', `sent=${r.sent} emailed=${r.emailed}`);
  }

  /* S8: both up -> one Telegram message, no email duplicate */
  {
    const calls = { tg: 0, mail: 0 };
    const r = await deliverSelfCheck({
      targets: ['biz-1'], text: 'T',
      chatsFor: async () => ['chat-1'],
      sendTg: async () => { calls.tg++; return { ok: true, status: true }; },
      sendMailFor: async () => { calls.mail++; return { ok: true }; },
    });
    line(r.sent === 1 && r.emailed === 0 && calls.mail === 0, 'S8',
      'telegram up: no email duplicate', `sent=${r.sent} emailed=${r.emailed} mail=${calls.mail}`);
  }

  /* S9: no bound chat at all -> email is the only channel */
  {
    const calls = { tg: 0, mail: 0 };
    const r = await deliverSelfCheck({
      targets: ['biz-1'], text: 'T',
      chatsFor: async () => [],
      sendTg: async () => { calls.tg++; return { ok: true }; },
      sendMailFor: async () => { calls.mail++; return { ok: true }; },
    });
    line(r.sent === 0 && r.emailed === 1 && calls.tg === 0 && calls.mail === 1, 'S9',
      'no bound chat: email only', `sent=${r.sent} emailed=${r.emailed} tg=${calls.tg}`);
  }

  /* S10: the email body carries the counts and nothing else */
  {
    const zero = Object.fromEntries(KINDS.map((k) => [k, 0]));
    const body = selfCheckEmail(selfCheckText({ ...zero, tg_failed: 1 }, { redirectActive: false }), '2026-11-07');
    const clean = !body.subject.includes('@') && !body.html.includes('@') && !/alder/i.test(body.text + body.html)
      && body.text.includes('tg_failed 1') && body.html.includes('tg_failed 1');
    line(clean && body.subject.includes('2026-11-07'), 'S10', 'email fallback body: counts only',
      `subject=${body.subject.length} chars html=${body.html.length}`);
  }

  /* S11: the header path still works on selfcheck, and the cron bearer is NOT
     accepted by /api/health. */
  {
    const viaHeader = await callCheck({ secret: 'health-test-secret-value' });
    const res2 = fakeRes();
    await handler({ method: 'GET', headers: { authorization: 'Bearer cron-test-secret-value' } }, res2);
    const healthOk = await callCheck({ secret: 'health-test-secret-value' });
    line(viaHeader.code === 200 && res2.code === 401 && healthOk.code === 200, 'S11',
      'header works on selfcheck, cron bearer rejected by health',
      `selfcheck=${viaHeader.code} healthBearer=${res2.code} healthHeader=${healthOk.code}`);
  }

  /* S12: the real handler path, not the injected senders. PostgREST is faked at
     the fetch layer, Telegram is the loopback fake in 500 mode, Resend is the
     loopback fake in ok mode. This is the only test that proves ownerOf ->
     getBusinessById -> sendMail actually reaches owner_email, that the
     idempotency key is selfcheck:<businessId>:<date>, and that MAIL_REDIRECT_TO
     still wins. */
  {
    const TG = process.env.FAKE_TG_URL, RS = process.env.FAKE_RESEND_URL;
    const BIZ = '11111111-1111-1111-1111-111111111111';
    const saved = {
      VERCEL_ENV: process.env.VERCEL_ENV, TELEGRAM_API_BASE: process.env.TELEGRAM_API_BASE,
      RESEND_API_BASE: process.env.RESEND_API_BASE, MAIL_REDIRECT_TO: process.env.MAIL_REDIRECT_TO,
      MAIL_FROM: process.env.MAIL_FROM,
    };
    const realFetch = globalThis.fetch;
    const ctl = (base, body) => realFetch(base + '/__control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const reset = (base) => realFetch(base + '/__reset', { method: 'POST' });
    const reqs = async (base) => (await (await realFetch(base + '/__requests')).json()).requests;
    const sent = [];
    let restore = null;
    try {
      process.env.VERCEL_ENV = 'development';
      process.env.TELEGRAM_API_BASE = TG;
      process.env.RESEND_API_BASE = RS;
      process.env.MAIL_FROM = 'alerts@example.com';
      delete process.env.MAIL_REDIRECT_TO;
      await ctl(TG, { mode: '500' }); await ctl(RS, { mode: 'ok' });
      await reset(TG); await reset(RS);

      const SB = process.env.SUPABASE_URL;
      globalThis.fetch = async (input, init = {}) => {
        const url = typeof input === 'string' ? input : input.url;
        if (!url.startsWith(SB)) return realFetch(input, init);
        const u = new URL(url);
        const table = u.pathname.replace('/rest/v1/', '');
        const select = u.searchParams.get('select') || '';
        sent.push(table + '?' + select);
        const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
        if (table === 'lead_events' && select === 'id') {
          const kind = (u.searchParams.get('kind') || '').replace('eq.', '');
          const n = kind === 'tg_failed' ? 2 : 0;
          return new Response(null, { status: 200, headers: { 'content-range': `0-${n ? n - 1 : 0}/${n}` } });
        }
        if (table === 'lead_events') return json([{ lead_id: 'lead-1', kind: 'tg_failed' }]);
        if (table === 'leads') return json([{ id: 'lead-1', business_id: BIZ }]);
        if (table === 'business_chats') return json([{ tg_chat_id: 'chat-1' }]);
        if (table === 'businesses') {
          // id=eq.<uuid> is getBusinessById (one row); anything else is the list
          // listActiveBusinesses asks for, which filters on status like PostgREST.
          if (u.searchParams.get('id')) {
            return json({ id: BIZ, slug: 'alder-demo', name: 'Alder Roofing', status: 'demo', timezone: 'America/Chicago', owner_email: 'owner@example.com', google_review_url: 'https://g.page/r/x' });
          }
          return json([{ id: BIZ, slug: 'alder-demo', name: 'Alder Roofing', owner_email: 'owner@example.com', status: 'demo' }]);
        }
        return json([]);
      };
      restore = () => { globalThis.fetch = realFetch; };

      process.env.HEALTH_SECRET = 'health-test-secret-value';
      const call = async () => {
        const res = fakeRes();
        await selfcheck({ method: 'GET', headers: { 'x-health-secret': 'health-test-secret-value' } }, res);
        return res;
      };
      const r1 = await call();
      const mail1 = (await reqs(RS)).filter((x) => x.path === '/emails');
      const tg1 = (await reqs(TG)).filter((x) => x.path.includes('/sendMessage'));
      const m1 = mail1[0] || {};
      const dateKey = new Date().toISOString().slice(0, 10);
      const toOwner = m1.body && JSON.stringify(m1.body.to) === JSON.stringify(['owner@example.com']);
      const keyOk = m1.headers && m1.headers['idempotency-key'] === `selfcheck:${BIZ}:${dateKey}`;
      // "owner" is part of the event kind names (email_owner_sent), so the PII
      // check looks for the business name and an address, not that word.
      const countsOnly = m1.body && typeof m1.body.text === 'string'
        && m1.body.text.includes('tg_failed 2') && !m1.body.text.includes('@')
        && !/alder roofing|owner@|example\.com/i.test(m1.body.text);

      // MAIL_REDIRECT_TO still wins over owner_email, as everywhere else.
      await reset(RS);
      process.env.MAIL_REDIRECT_TO = 'inbox@example.com';
      const r2 = await call();
      const mail2 = (await reqs(RS)).filter((x) => x.path === '/emails');
      const toRedirect = mail2[0] && JSON.stringify(mail2[0].body.to) === JSON.stringify(['inbox@example.com']);

      const ok = r1.code === 200 && r1.body.emailed === 1 && r1.body.sent === 0
        && mail1.length === 1 && tg1.length === 1 && toOwner && keyOk && countsOnly
        && r2.code === 200 && mail2.length === 1 && toRedirect;
      line(ok, 'S12', 'selfcheck: telegram down -> owner email, redirect wins',
        `r1=${r1.code} emailed=${r1.body.emailed} mail=${mail1.length} tg=${tg1.length} toOwner=${!!toOwner} key=${!!keyOk} counts=${!!countsOnly} redirect=${!!toRedirect}`);
    } catch (e) {
      line(false, 'S12', 'selfcheck: telegram down -> owner email, redirect wins', e.message);
    } finally {
      if (restore) restore();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      await ctl(TG, { mode: 'ok' }).catch(() => {});
      await ctl(RS, { mode: 'ok' }).catch(() => {});
    }
  }

  /* S13: a paused business is never told anything, even when a failed event
     belongs to it. The failure path derives targets from lead_events, so this is
     the one route where an offboarded business could otherwise still be emailed. */
  {
    const PAUSED = '22222222-2222-2222-2222-222222222222';
    const realFetch2 = globalThis.fetch;
    const SB = process.env.SUPABASE_URL;
    const savedEnv = {
      VERCEL_ENV: process.env.VERCEL_ENV, TELEGRAM_API_BASE: process.env.TELEGRAM_API_BASE,
      RESEND_API_BASE: process.env.RESEND_API_BASE, MAIL_REDIRECT_TO: process.env.MAIL_REDIRECT_TO,
    };
    try {
      process.env.VERCEL_ENV = 'development';
      process.env.TELEGRAM_API_BASE = process.env.FAKE_TG_URL;
      process.env.RESEND_API_BASE = process.env.FAKE_RESEND_URL;
      delete process.env.MAIL_REDIRECT_TO;
      for (const base of [process.env.FAKE_TG_URL, process.env.FAKE_RESEND_URL]) {
        await realFetch2(base + '/__control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"mode":"ok"}' });
        await realFetch2(base + '/__reset', { method: 'POST' });
      }
      globalThis.fetch = async (input, init = {}) => {
        const url = typeof input === 'string' ? input : input.url;
        if (!url.startsWith(SB)) return realFetch2(input, init);
        const u = new URL(url);
        const table = u.pathname.replace('/rest/v1/', '');
        const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
        if (table === 'lead_events' && (u.searchParams.get('select') === 'id')) {
          const kind = (u.searchParams.get('kind') || '').replace('eq.', '');
          const n = kind === 'tg_failed' ? 1 : 0;
          return new Response(null, { status: 200, headers: { 'content-range': `0-${n ? n - 1 : 0}/${n}` } });
        }
        if (table === 'lead_events') return json([{ lead_id: 'p-lead', kind: 'tg_failed' }]);
        if (table === 'leads') return json([{ id: 'p-lead', business_id: PAUSED }]);
        if (table === 'businesses') {
          const row = { id: PAUSED, slug: 'paused', name: 'Paused Roofing', owner_email: 'paused@example.com', status: 'paused' };
          if (u.searchParams.get('id')) return json(row);
          // PostgREST filters; so does this, or a missing .in('status') in the
          // client would look correct here.
          const st = u.searchParams.get('status') || '';
          if (st.startsWith('in.(') && !st.slice(4, -1).split(',').includes('paused')) return json([]);
          return json([row]);
        }
        // A bound chat, so a missing active-filter shows up as a real send rather
        // than as an empty chat list that quietly falls through.
        if (table === 'business_chats') return json([{ tg_chat_id: 'chat-paused' }]);
        return json([]);
      };
      process.env.HEALTH_SECRET = 'health-test-secret-value';
      const res = fakeRes();
      await selfcheck({ method: 'GET', headers: { 'x-health-secret': 'health-test-secret-value' } }, res);
      const tg = (await (await realFetch2(process.env.FAKE_TG_URL + '/__requests')).json()).requests;
      const rs = (await (await realFetch2(process.env.FAKE_RESEND_URL + '/__requests')).json()).requests;
      line(res.code === 200 && res.body.sent === 0 && res.body.emailed === 0 && tg.length === 0 && rs.length === 0,
        'S13', 'paused business: failed event does not reach it',
        `code=${res.code} sent=${res.body.sent} emailed=${res.body.emailed} tg=${tg.length} mail=${rs.length}`);
    } catch (e) {
      line(false, 'S13', 'paused business: failed event does not reach it', e.message);
    } finally {
      globalThis.fetch = realFetch2;
      for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  }

  /* S5: who gets told — everyone under a redirect, only the affected businesses otherwise */
  {
    const fails = new Map([['biz-a', { tg_failed: 2 }], ['biz-b', { email_owner_failed: 1 }]]);
    const all = ['biz-a', 'biz-b', 'biz-c'];
    const redirect = alertTargets({ redirectActive: true, failedByBusiness: fails, allBusinessIds: all });
    const partial = alertTargets({ redirectActive: false, failedByBusiness: fails, allBusinessIds: all });
    const ok = redirect.length === 3 && partial.length === 2
      && partial.includes('biz-a') && partial.includes('biz-b') && !partial.includes('biz-c');
    line(ok, 'S5', 'selfcheck: redirect tells everyone, else only affected', `redirect=${redirect.length} partial=${partial.length}`);
  }

  /* S4: authorised call — shape only; `sent` depends on live data and is not asserted */
  {
    const r = await callCheck({ bearer: 'cron-test-secret-value' });
    const b = r.body || {};
    const shapeOk = r.code === 200 && b.ok === true
      && typeof b.sent === 'number' && typeof b.failed === 'number'
      && typeof b.redirect_active === 'boolean'
      && JSON.stringify(Object.keys(b).sort()) === JSON.stringify(['emailed', 'failed', 'ok', 'redirect_active', 'sent']);
    line(shapeOk, 'S4', 'selfcheck: authorised call returns counts only', `code=${r.code} sent=${b.sent} failed=${b.failed}`);
  }

} catch (e) {
  line(false, 'H0', 'health suite threw', e.message);
} finally {
  if (saved.HEALTH_SECRET === undefined) delete process.env.HEALTH_SECRET; else process.env.HEALTH_SECRET = saved.HEALTH_SECRET;
  if (saved.CRON_SECRET === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved.CRON_SECRET;
  if (saved.MAIL_REDIRECT_TO === undefined) delete process.env.MAIL_REDIRECT_TO; else process.env.MAIL_REDIRECT_TO = saved.MAIL_REDIRECT_TO;
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
