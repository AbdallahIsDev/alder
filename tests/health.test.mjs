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

const { default: handler, countInvalidReviewLinks, reviewLinkOk } = await import('../api/health.js');
const { default: selfcheck, alertTargets, deliverSelfCheck, operatorAlarm, claimOperatorAlarmProblems, selectUnclaimedOperatorAlarm, filterActiveBusinesses } = await import('../api/selfcheck.js');
const { selfCheckText, shouldAlertBusiness, failedTotal, operatorAlarmText } = await import('../lib/ops-copy.js');
const { selfCheckEmail } = await import('../lib/email-builders.js');

const KINDS = ['created', 'tg_sent', 'tg_failed', 'email_owner_sent', 'email_owner_failed', 'autoreply_failed', 'review_request_failed'];
const TOP = ['last_24h', 'last_hour', 'mail_redirect_active', 'ok', 'operator_chat_bound', 'operator_chat_set', 'operator_email_set', 'operator_reachable', 'review_links_invalid', 'salt_set', 'webhook_secret_set'];

const call = async ({ method = 'GET', secret } = {}) => {
  const res = fakeRes();
  const headers = secret === undefined ? {} : { 'x-health-secret': secret };
  await handler({ method, headers }, res);
  return res;
};

const saved = { HEALTH_SECRET: process.env.HEALTH_SECRET, CRON_SECRET: process.env.CRON_SECRET, MAIL_REDIRECT_TO: process.env.MAIL_REDIRECT_TO };
try {
  {
    const rows = [{ id: 'a' }, { id: 'b' }];
    line(filterActiveBusinesses(rows, 'b').map((b) => b.id).join(',') === 'b'
      && filterActiveBusinesses(rows, null).length === 2,
      'S17', 'self-check business filter: one when requested, all by default');
  }
  /* H1: no secret configured */
  delete process.env.HEALTH_SECRET;
  {
    const r = await call({ secret: 'anything' });
    line(r.code === 503 && r.body && r.body.ok === false, 'H1', 'no HEALTH_SECRET -> 503', `code=${r.code}`);
  }

  /* H1b: the review-link count is strict about what is STORED. */
  {
    const rows = [
      { google_review_url: 'https://g.page/r/x' },
      { google_review_url: 'https://search.google.com/local/writereview?placeid=1' },
      { google_review_url: 'ttps://search.google.com/local/writereview?placeid=1' },
      { google_review_url: 'http://g.page/r/x' },
      { google_review_url: 'https://evil.example/r' },
      { google_review_url: '' },
      { google_review_url: null },
      // An allowed host with the right scheme and no identifier leads nowhere.
      { google_review_url: 'https://g.page/r/' },
      { google_review_url: 'https://search.google.com/local/writereview?placeid=' },
    ];
    const ok = reviewLinkOk('https://g.page/r/x') === true
      && reviewLinkOk('ttps://search.google.com/x') === false
      && reviewLinkOk('https://g.page/r/') === false
      && reviewLinkOk('https://search.google.com/local/writereview?placeid=') === false
      && countInvalidReviewLinks(rows) === 7;
    line(ok, 'H1b', 'invalid links: https, allowed host, and a real identifier',
      `invalid=${countInvalidReviewLinks(rows)}`);
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

  /* B12a: the redirect flag is the CONFIG state, in any environment, and the
     address itself never reaches the body (the task's alternative to a
     deploy-blocking hard fail: make the state impossible to miss). */
  {
    const before = process.env.MAIL_REDIRECT_TO;
    process.env.MAIL_REDIRECT_TO = 'b12-inbox@example.invalid';
    const r = await call({ secret: 'health-test-secret-value' });
    const body = r.body || {};
    const text = JSON.stringify(body);
    const flagged = body.mail_redirect_active === true;
    const noAddress = !text.includes('b12-inbox') && !text.includes('MAIL_REDIRECT_TO') && !/@/.test(text);
    if (before === undefined) delete process.env.MAIL_REDIRECT_TO; else process.env.MAIL_REDIRECT_TO = before;
    line(r.code === 200 && flagged && noAddress, 'B12a',
      'health: mail_redirect_active true, the address never leaves',
      `code=${r.code} flag=${body.mail_redirect_active} leak=${!noAddress}`);
  }

  /* B12b: one predicate answers "is customer mail being swallowed right now",
     and it is the one the daily operator line is built from. Production only:
     a preview or a test run redirecting to a test inbox is not an incident. */
  {
    const { mailRedirectConfigured, mailRedirectInProduction } = await import('../lib/mail.js');
    const before = { redirect: process.env.MAIL_REDIRECT_TO, env: process.env.VERCEL_ENV };
    process.env.MAIL_REDIRECT_TO = 'b12-inbox@example.invalid';
    process.env.VERCEL_ENV = 'production';
    const prodSet = mailRedirectInProduction();
    process.env.VERCEL_ENV = 'preview';
    const previewSet = mailRedirectInProduction();
    process.env.VERCEL_ENV = 'development';
    const devSet = mailRedirectInProduction();
    delete process.env.MAIL_REDIRECT_TO;
    process.env.VERCEL_ENV = 'production';
    const prodUnset = mailRedirectInProduction();
    const configuredWhenUnset = mailRedirectConfigured();
    if (before.redirect === undefined) delete process.env.MAIL_REDIRECT_TO; else process.env.MAIL_REDIRECT_TO = before.redirect;
    if (before.env === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = before.env;

    // The alarm the handler builds while the predicate is true: the fixed line,
    // exactly once, with no address in it.
    const alarm = operatorAlarm({
      businesses: [], counts: new Map(), chatsByBusiness: new Map(),
      recentLeadBusinesses: new Set(), redirectActive: prodSet,
    });
    const lineCount = alarm && alarm.body ? (alarm.body.match(/Test mode is on/g) || []).length : 0;
    const alarmsOk = !!alarm && lineCount === 1 && alarm.body.includes('Setting: MAIL_REDIRECT_TO')
      && !alarm.body.includes('b12-inbox');
    const matrixOk = prodSet === true && previewSet === false && devSet === false
      && prodUnset === false && configuredWhenUnset === false;
    line(matrixOk && alarmsOk, 'B12b',
      'redirect predicate: production only; alarm carries one fixed line',
      `prod=${prodSet} preview=${previewSet} dev=${devSet} unset=${prodUnset} line=${lineCount}`);
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

  /* S3: the owner copy and the operator alarm, without a database */
  {
    const ruleOk = shouldAlertBusiness({ status: 'demo', failed: 0 }) === false
      && shouldAlertBusiness({ status: 'demo', failed: 2 }) === true
      && shouldAlertBusiness({ status: 'active', failed: 0 }) === false
      && shouldAlertBusiness({ status: 'active', failed: 2 }) === true
      && shouldAlertBusiness({ status: 'paused', failed: 2 }) === false;
    const zero = Object.fromEntries(KINDS.map((k) => [k, 0]));
    const owner = selfCheckText({ ...zero, tg_failed: 2, created: 3 });
    const own = owner.includes('New requests: 3') && owner.includes('2 alerts could not be delivered');
    const noOperator = !/Test mode|MAIL_REDIRECT_TO|alder-demo|second-demo/.test(owner);
    const alarm = operatorAlarmText({ rows: [{ slug: 'alder-demo', day: { tg_failed: 2 } }], redirectActive: true, noPhoneSlugs: ['second-demo'] });
    const alarmOk = alarm.includes('alder-demo: 2 alerts could not be delivered')
      && alarm.includes('No phone connected: second-demo')
      && alarm.includes('Test mode is on')
      && alarm.indexOf('Needs attention') < alarm.indexOf('Test mode');
    const silent = operatorAlarmText({ rows: [], redirectActive: false, noPhoneSlugs: [] }) === null;
    const totals = failedTotal({ ...zero, tg_failed: 2, autoreply_failed: 1 }) === 3;
    line(ruleOk && own && noOperator && alarmOk && silent && totals, 'S3',
      'owner copy has no operator text; one alarm names every business',
      `rule=${ruleOk} own=${own} clean=${noOperator} alarm=${alarmOk} silent=${silent}`);
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
    const body = selfCheckEmail({ ...zero, tg_failed: 1 }, '2026-11-07');
    // The shell's <style> block contains "@media", so the address check is a
    // real address shape, not a bare "@".
    const clean = !body.subject.includes('@') && !/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(body.html)
      // The layout marker is data-alder-layout, so the check is the business
      // name and an address, not the bare word.
      && !/alder roofing|owner@|example\.com/i.test(body.text + body.html)
      && body.text.includes('1 alert could not be delivered') && body.html.includes('1 alert could not be delivered');
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
      MAIL_FROM: process.env.MAIL_FROM, OPERATOR_CHAT_ID: process.env.OPERATOR_CHAT_ID,
      OPERATOR_EMAIL: process.env.OPERATOR_EMAIL,
    };
    const realFetch = globalThis.fetch;
    const ctl = (base, body) => realFetch(base + '/__control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const reset = (base) => realFetch(base + '/__reset', { method: 'POST' });
    const reqs = async (base) => (await (await realFetch(base + '/__requests')).json()).requests;
    const sent = [];
    const claimedProblems = new Set();
    let restore = null;
    try {
      process.env.VERCEL_ENV = 'development';
      process.env.TELEGRAM_API_BASE = TG;
      process.env.RESEND_API_BASE = RS;
      process.env.MAIL_FROM = 'alerts@example.com';
      process.env.OPERATOR_CHAT_ID = 'op-chat';
      process.env.OPERATOR_EMAIL = 'ops@example.com';
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
        if (table === 'rpc/hit_rate_limit') {
          const key = JSON.parse(init.body || '{}').p_key;
          if (claimedProblems.has(key)) return json(false);
          claimedProblems.add(key);
          return json(true);
        }
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
      // The HTML header is the company's (the text part stays name-free).
      const headerOk = m1.body && typeof m1.body.html === 'string'
        && m1.body.html.includes('>Alder Roofing<') && m1.body.html.includes('Sent by Lead Alerts');
      const countsOnly = m1.body && typeof m1.body.text === 'string'
        && m1.body.text.includes('1 alert could not be delivered') && !m1.body.text.includes('@')
        && !/alder roofing|owner@|example\.com/i.test(m1.body.text);

      // MAIL_REDIRECT_TO still wins over owner_email, as everywhere else.
      await reset(RS);
      process.env.MAIL_REDIRECT_TO = 'inbox@example.com';
      const r2 = await call();
      const mail2 = (await reqs(RS)).filter((x) => x.path === '/emails');
      // The owner still gets its self-check; the repeated operator problem is
      // claimed, so only one redirected email remains.
      const toRedirect = mail2.length === 1
        && mail2.every((x) => JSON.stringify(x.body.to) === JSON.stringify(['inbox@example.com']));

      // Two Telegram attempts: the owner chat (mode 500) and the operator alarm.
      const opTg = tg1.find((x) => String(x.body.chat_id) === 'op-chat');
      // Telegram is in 500 mode for everyone, so the first operator alarm falls
      // back to OPERATOR_EMAIL: one owner email and one operator email.
      const opMail = mail1.find((x) => JSON.stringify(x.body.to) === JSON.stringify(['ops@example.com']));
      const ok = r1.code === 200 && r1.body.emailed === 1 && r1.body.sent === 0
        && r1.body.operator === 'email'
        && mail1.length === 2 && !!opMail && tg1.length === 2 && !!opTg && toOwner && keyOk && countsOnly
        && /alder-demo: 1 alert could not be delivered/.test(opTg.body.text)
        && r2.code === 200 && r2.body.operator === 'none' && mail2.length === 1 && toRedirect;
      // The email assertion lives on its own line so a missing business shows
      // up here, not buried in S12's combined condition.
      line(!!headerOk, 'S4b', 'selfcheck email: company header, platform footer',
        `header=${!!headerOk} mail=${mail1.length}`);
      line(ok, 'S12', 'selfcheck: telegram down -> owner email, redirect wins',
        `r1=${r1.code} emailed=${r1.body.emailed} tg=${tg1.length} op=${!!opTg} key=${!!keyOk} counts=${!!countsOnly} header=${!!headerOk} redirect=${!!toRedirect}`);
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

  /* S14/S15/S16: per-business owner counts, no de-duplication, one alarm. */
  {
    const TG = process.env.FAKE_TG_URL, RS = process.env.FAKE_RESEND_URL;
    const DEMO = '33333333-3333-3333-3333-333333333333';
    const ACT = '44444444-4444-4444-4444-444444444444';
    const B1 = '55555555-5555-5555-5555-555555555555';
    const B2 = '66666666-6666-6666-6666-666666666666';
    const SB = process.env.SUPABASE_URL;
    const realFetch3 = globalThis.fetch;
    const savedEnv = {
      VERCEL_ENV: process.env.VERCEL_ENV, TELEGRAM_API_BASE: process.env.TELEGRAM_API_BASE,
      RESEND_API_BASE: process.env.RESEND_API_BASE, MAIL_REDIRECT_TO: process.env.MAIL_REDIRECT_TO,
      MAIL_FROM: process.env.MAIL_FROM, OPERATOR_CHAT_ID: process.env.OPERATOR_CHAT_ID,
    };
    const ctl = (base, body) => realFetch3(base + '/__control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const reset = (base) => realFetch3(base + '/__reset', { method: 'POST' });
    const reqs = async (base) => (await (await realFetch3(base + '/__requests')).json()).requests;
    const claimedProblems = new Set();
    const install = (data) => {
      globalThis.fetch = async (input, init = {}) => {
        const url = typeof input === 'string' ? input : input.url;
        if (!url.startsWith(SB)) return realFetch3(input, init);
        const u = new URL(url);
        const table = u.pathname.replace('/rest/v1/', '');
        const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
        if (table === 'rpc/hit_rate_limit') {
          const key = JSON.parse(init.body || '{}').p_key;
          if (claimedProblems.has(key)) return json(false);
          claimedProblems.add(key);
          return json(true);
        }
        if (table === 'businesses') return json(data.businesses || []);
        // PostgREST filters; so does this. Without the business_id filter the
        // chat lookup would hand every business the same chat.
        if (table === 'business_chats') {
          const bid = (u.searchParams.get('business_id') || '').replace('eq.', '');
          return json((data.chats || []).filter((c) => !bid || c.business_id === bid));
        }
        if (table === 'lead_events') return json(data.events || []);
        if (table === 'leads') return json(data.leads || []);
        return json([]);
      };
    };
    const call = async () => {
      const res = fakeRes();
      await selfcheck({ method: 'GET', headers: { 'x-health-secret': 'health-test-secret-value' } }, res);
      return res;
    };
    try {
      process.env.VERCEL_ENV = 'development';
      delete process.env.MAIL_REDIRECT_TO;
      process.env.MAIL_FROM = 'alerts@example.com';
      process.env.TELEGRAM_API_BASE = TG;
      process.env.RESEND_API_BASE = RS;
      process.env.OPERATOR_CHAT_ID = 'op-chat';
      await ctl(TG, { mode: 'ok' }); await ctl(RS, { mode: 'ok' });
      await reset(TG); await reset(RS);

      // Demo: one failed alert, a bound chat. Active: two failed owner emails,
      // no chat. Each owner message carries its own number and only its own; the
      // operator gets ONE alarm naming both.
      install({
        businesses: [
          { id: DEMO, slug: 'alder-demo', name: 'D', owner_email: 'demo@example.com', status: 'demo' },
          { id: ACT, slug: 'second-demo', name: 'A', owner_email: 'client@example.com', status: 'active' },
        ],
        chats: [{ business_id: DEMO, tg_chat_id: 'chat-demo' }],
        events: [
          { lead_id: 'l-demo', kind: 'tg_failed' },
          { lead_id: 'l-act', kind: 'email_owner_failed' },
          { lead_id: 'l-act', kind: 'email_owner_failed' },
        ],
        leads: [{ id: 'l-demo', business_id: DEMO }, { id: 'l-act', business_id: ACT }],
      });
      const r = await call();
      const tg = (await reqs(TG)).filter((x) => x.path.includes('/sendMessage'));
      const mail = (await reqs(RS)).filter((x) => x.path === '/emails');
      const ownerTg = tg.find((x) => String(x.body.chat_id) === 'chat-demo');
      const opTg = tg.find((x) => String(x.body.chat_id) === 'op-chat');
      const clientText = (mail[0] && mail[0].body && mail[0].body.text) || '';
      const split = r.code === 200 && r.body.sent === 1 && r.body.emailed === 1 && r.body.failed === 3
        && tg.length === 2 && mail.length === 1
        && /1 alert could not be delivered/.test(ownerTg.body.text) && !/2 alert emails/.test(ownerTg.body.text)
        && /2 alert emails to you did not go out/.test(clientText) && !/1 alert could not/.test(clientText)
        && !/MAIL_REDIRECT_TO|alder-demo|second-demo/.test(clientText);
      line(split, 'S14', 'each owner message carries only its own counts',
        `sent=${r.body.sent} emailed=${r.body.emailed} tg=${tg.length} failed=${r.body.failed}`);

      const alarmOk = !!opTg
        && /alder-demo: 1 alert could not be delivered/.test(opTg.body.text)
        && /second-demo: 2 alert emails to the owner did not go out/.test(opTg.body.text)
        && /No phone connected: second-demo/.test(opTg.body.text);
      line(alarmOk, 'S15', 'the operator gets one alarm naming every affected business',
        `op=${!!opTg} slugs=${alarmOk}`);

      // Two active businesses, one shared inbox, one failure each: two messages,
      // because each carries that business's own numbers (decision: never drop).
      await reset(TG); await reset(RS);
      install({
        businesses: [
          { id: B1, slug: 'b1', name: 'B1', owner_email: 'shared@example.com', status: 'active' },
          { id: B2, slug: 'b2', name: 'B2', owner_email: 'shared@example.com', status: 'active' },
        ],
        chats: [],
        events: [{ lead_id: 'l-1', kind: 'tg_failed' }, { lead_id: 'l-2', kind: 'tg_failed' }],
        leads: [{ id: 'l-1', business_id: B1 }, { id: 'l-2', business_id: B2 }],
      });
      const r2 = await call();
      const mail2 = (await reqs(RS)).filter((x) => x.path === '/emails');
      line(r2.code === 200 && r2.body.emailed === 2 && mail2.length === 2, 'S16',
        'a shared inbox gets two messages, one per business',
        `emailed=${r2.body.emailed} mail=${mail2.length}`);
    } catch (e) {
      line(false, 'S14', 'selfcheck: per-business counts', e.message);
    } finally {
      globalThis.fetch = realFetch3;
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      await ctl(TG, { mode: 'ok' }).catch(() => {});
      await ctl(RS, { mode: 'ok' }).catch(() => {});
    }
  }

  /* S5: who gets an owner message — only the business with its own failures */
  {
    const businesses = [
      { id: 'biz-a', slug: 'biz-a', status: 'demo' }, { id: 'biz-b', slug: 'biz-b', status: 'active' },
      { id: 'biz-c', slug: 'biz-c', status: 'active' }, { id: 'biz-d', slug: 'biz-d', status: 'demo' },
    ];
    const counts = new Map([['biz-a', { tg_failed: 2 }], ['biz-b', { email_owner_failed: 1 }]]);
    const targets = alertTargets({ businesses, counts });
    const ok = targets.length === 2 && targets.includes('biz-a') && targets.includes('biz-b')
      && !targets.includes('biz-c') && !targets.includes('biz-d');
    // The alarm, by contrast, is one message that names both.
    const alarm = operatorAlarm({
      businesses, counts,
      chatsByBusiness: new Map([['biz-a', ['c']], ['biz-b', []], ['biz-c', ['c']], ['biz-d', []]]),
      recentLeadBusinesses: new Set(),
      redirectActive: false,
    });
    // biz-d is a demo business with no chat and no recent lead: parked, not an
    // incident, so it is not listed any more.
    const alarmOk = !!alarm && alarm.body.includes('biz-a: 2 alerts') && alarm.body.includes('biz-b: 1 alert email')
      && alarm.body.includes('No phone connected: biz-b') && !alarm.body.includes('biz-d');
    line(ok && alarmOk, 'S5', 'owner targets are per business; the alarm aggregates',
      `targets=${targets.length} alarm=${alarmOk}`);
  }

  /* S17-S20: the operator alarm goes quiet when nothing is actually wrong */
  /* S22-S23: operator problems are claimed once per 24-hour rate-limit bucket;
     claim errors fail open so an alert is still sent. */
  {
    const business = { id: 'biz-throttle', slug: 'throttle-client', status: 'active' };
    const makeAlarm = (day) => operatorAlarm({
      businesses: [business], counts: new Map([[business.id, day]]),
      chatsByBusiness: new Map([[business.id, []]]),
      recentLeadBusinesses: new Set(), redirectActive: true,
    });
    const alarm = makeAlarm({ tg_failed: 2, email_owner_failed: 1 });
    const held = new Set();
    const atomicClaim = async (key, windowSeconds, max) => {
      if (windowSeconds !== 86400 || max !== 1) throw new Error('unexpected claim settings');
      if (held.has(key)) return false;
      held.add(key);
      return true;
    };
    const first = await claimOperatorAlarmProblems(alarm, atomicClaim);
    const repeat = await claimOperatorAlarmProblems(alarm, atomicClaim);
    const repeated = selectUnclaimedOperatorAlarm(alarm, repeat);
    const expanded = makeAlarm({ tg_failed: 3, email_owner_failed: 1, review_request_failed: 1 });
    const newProblem = await claimOperatorAlarmProblems(expanded, atomicClaim);
    const filtered = selectUnclaimedOperatorAlarm(expanded, newProblem);
    const throttleOk = first.length === 4 && repeat.length === 0 && repeated === null
      && newProblem.length === 1 && filtered && filtered.body.includes('review request')
      && !filtered.body.includes('alerts could not be delivered') && !filtered.body.includes('Test mode is on');
    line(throttleOk, 'S22', 'repeat operator issues are throttled; new issue still alerts',
      `first=${first.length} repeat=${repeat.length} new=${newProblem.length}`);

    const failedOpen = await claimOperatorAlarmProblems(alarm, async () => { throw new Error('db unavailable'); });
    const openAlarm = selectUnclaimedOperatorAlarm(alarm, failedOpen);
    const failOpenOk = failedOpen.length === alarm.problemKeys.length && !!openAlarm
      && openAlarm.body.includes('alerts could not be delivered') && openAlarm.body.includes('Test mode is on');
    line(failOpenOk, 'S23', 'claim errors still send every operator problem', `problems=${failedOpen.length}`);
  }

  {
    const demo = { id: 'd1', slug: 'second-demo', status: 'demo' };
    const active = { id: 'a1', slug: 'client', status: 'active' };
    const none = new Map();

    const quiet = operatorAlarm({
      businesses: [demo], counts: none,
      chatsByBusiness: new Map([['d1', []]]), recentLeadBusinesses: new Set(), redirectActive: false,
    });
    line(quiet === null, 'S17', 'empty demo with no lead and no chat: no alarm at all', `alarm=${!!quiet}`);

    const activeAlarm = operatorAlarm({
      businesses: [active], counts: none,
      chatsByBusiness: new Map([['a1', []]]), recentLeadBusinesses: new Set(), redirectActive: false,
    });
    line(!!activeAlarm && activeAlarm.body.includes('No phone connected: client'), 'S18',
      'active client with no chat: alarm', `alarm=${!!activeAlarm}`);

    const demoLead = operatorAlarm({
      businesses: [demo], counts: none,
      chatsByBusiness: new Map([['d1', []]]), recentLeadBusinesses: new Set(['d1']), redirectActive: false,
    });
    line(!!demoLead && demoLead.body.includes('No phone connected: second-demo'), 'S19',
      'demo with a lead in the last week and no chat: alarm', `alarm=${!!demoLead}`);

    const unknown = operatorAlarm({
      businesses: [active], counts: none,
      chatsByBusiness: new Map([['a1', null]]), recentLeadBusinesses: new Set(), redirectActive: false,
    });
    line(unknown === null, 'S20', 'a chat lookup that failed is unknown, not "no phone"', `alarm=${!!unknown}`);

    const noRecent = operatorAlarm({
      businesses: [demo], counts: none,
      chatsByBusiness: new Map([['d1', []]]), recentLeadBusinesses: null, redirectActive: false,
    });
    line(!!noRecent && noRecent.body.includes('No phone connected: second-demo'), 'S21',
      'a failed recent-lead query reports the demo row instead of excusing it', `alarm=${!!noRecent}`);
  }

  /* S4: authorised call — shape only; `sent` depends on live data and is not asserted */
  {
    const r = await callCheck({ bearer: 'cron-test-secret-value' });
    const b = r.body || {};
    const shapeOk = r.code === 200 && b.ok === true
      && typeof b.sent === 'number' && typeof b.failed === 'number'
      && typeof b.redirect_active === 'boolean'
      && JSON.stringify(Object.keys(b).sort()) === JSON.stringify(['emailed', 'failed', 'ok', 'operator', 'operator_reachable', 'redirect_active', 'sent']);
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
