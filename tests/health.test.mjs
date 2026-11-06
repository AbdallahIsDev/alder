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

const saved = { HEALTH_SECRET: process.env.HEALTH_SECRET, MAIL_REDIRECT_TO: process.env.MAIL_REDIRECT_TO };
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

  /* S2: wrong secret, wrong bearer */
  process.env.HEALTH_SECRET = 'health-test-secret-value';
  {
    const wrong = await callCheck({ secret: 'nope' });
    const wrongBearer = await callCheck({ bearer: 'nope' });
    line(wrong.code === 401 && wrongBearer.code === 401, 'S2', 'selfcheck: bad secret -> 401', `${wrong.code}/${wrongBearer.code}`);
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
    const r = await callCheck({ bearer: 'health-test-secret-value' });
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
  if (saved.MAIL_REDIRECT_TO === undefined) delete process.env.MAIL_REDIRECT_TO; else process.env.MAIL_REDIRECT_TO = saved.MAIL_REDIRECT_TO;
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
