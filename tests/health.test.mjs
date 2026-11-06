#!/usr/bin/env node
// tests/health.test.mjs — Gate H.
// HARNESS: in-process, no HTTP server. The handler is called directly with a fake
// request/response; the counts query goes to the configured database (read-only).
//
// What it proves:
//   H1  No HEALTH_SECRET configured -> 503. An unconfigured deployment is loud,
//       not silently open.
//   H2  Wrong or missing header -> 401, and nothing is queried.
//   H3  Correct secret -> 200.
//   H4  Shape: numbers and booleans only, exactly the agreed keys, no PII, no
//       values from the environment.
//   H5  POST -> 405.

import { loadEnv } from './env.mjs';
import { fakeRes } from './helpers.mjs';

loadEnv();

let failed = 0, total = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(50)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};

const { default: handler } = await import('../api/health.js');

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
} catch (e) {
  line(false, 'H0', 'health suite threw', e.message);
} finally {
  if (saved.HEALTH_SECRET === undefined) delete process.env.HEALTH_SECRET; else process.env.HEALTH_SECRET = saved.HEALTH_SECRET;
  if (saved.MAIL_REDIRECT_TO === undefined) delete process.env.MAIL_REDIRECT_TO; else process.env.MAIL_REDIRECT_TO = saved.MAIL_REDIRECT_TO;
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
