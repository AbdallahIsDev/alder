#!/usr/bin/env node
// tests/canary-limits.test.mjs — Gate L.
// HARNESS: the test project's rate_limits table, two throwaway keys.
//
// What it proves:
//   L1  the host gate: no host, no production reference, or the production host
//       itself all refuse
//   L2  the canary business's rows are removed and another business's are not
//   L3  a production-looking host deletes nothing
//
// Mutation: drop the `production` branch from canClearLimits and L3 fails — the
// row for the other business is deleted.

import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { loadEnv, isTestEnv, readEnvFile } from '../lib/env.js';
import { canClearLimits, clearCanaryLimits, limitLine } from './canary-limits.mjs';

loadEnv();
/* This suite writes rate_limits rows. It must never run against production, and
   the runner only ever calls it with TEST_ENV=1. */
if (!isTestEnv()) {
  console.log('SKIP  L1-L3  TEST_ENV=1 is required; this suite writes rate_limits');
  process.exit(0);
}

let total = 0;
let failed = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(52)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};

/* L1: the matrix. */
{
  const cases = [
    [{ host: '', prodHost: 'https://p.supabase.co' }, false, 'no-host'],
    [{ host: 'https://t.supabase.co', prodHost: '' }, false, 'no-production-reference'],
    [{ host: 'https://p.supabase.co', prodHost: 'https://p.supabase.co' }, false, 'production'],
    [{ host: 'https://p.supabase.co/', prodHost: 'https://p.supabase.co' }, false, 'production'],
    [{ host: 'https://t.supabase.co', prodHost: 'https://p.supabase.co' }, true, 'test'],
  ];
  const bad = cases.filter(([input, ok, reason]) => {
    const r = canClearLimits(input);
    return r.ok !== ok || r.reason !== reason;
  });
  line(bad.length === 0, 'L1', 'the host gate refuses production and unknown hosts',
    bad.length ? `wrong: ${bad.length}` : `${cases.length} cases`);
}

/* L4/L5: the one line the runner prints. */
{
  const cleared = limitLine({ cleared: 2, skipped: null });
  const none = limitLine({ cleared: 0, skipped: 'none' });
  const prod = limitLine({ cleared: 0, skipped: 'production' });
  const many = limitLine({ cleared: 0, skipped: 'too-many' });
  const ok = cleared === 'runner  canary rate limits cleared: 2 row(s)'
    && none === 'runner  canary rate limits cleared: 0 row(s)'
    && prod === 'WARN  runner  canary rate limits not cleared: production'
    && many === 'WARN  runner  canary rate limits not cleared: too-many';
  line(ok, 'L4', 'none is not a warning; every other skip is', `prod=${prod.startsWith('WARN')} none=${none.startsWith('runner')}`);

  const all = [cleared, none, prod, many].join('\n');
  const leaks = /https?:|supabase|\.co\b|[A-Za-z0-9_-]{20,}/.test(all);
  line(!leaks, 'L5', 'the line carries no host, key or path', `leaks=${leaks}`);
}

const host = process.env.SUPABASE_URL;
const prodHost = readEnvFile('.env').SUPABASE_URL;
const svc = createClient(host, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const A = randomUUID();
const B = randomUUID();
const windowStart = new Date().toISOString();

try {
  await svc.from('rate_limits').insert([
    { key: 'biz:' + A, window_start: windowStart },
    { key: 'biz:' + B, window_start: windowStart },
  ]);

  /* L2 */
  const r1 = await clearCanaryLimits(svc, A, { host, prodHost });
  const { data: left } = await svc.from('rate_limits').select('key').in('key', ['biz:' + A, 'biz:' + B]);
  const aGone = !(left || []).some((x) => x.key === 'biz:' + A);
  const bKept = (left || []).some((x) => x.key === 'biz:' + B);
  line(r1.cleared === 1 && aGone && bKept, 'L2', 'only the canary business is cleared',
    `cleared=${r1.cleared} aGone=${aGone} bKept=${bKept}`);

  /* L3: the same host in both slots is production as far as this function knows. */
  const r2 = await clearCanaryLimits(svc, B, { host, prodHost: host });
  const { data: after } = await svc.from('rate_limits').select('key').eq('key', 'biz:' + B);
  line(r2.cleared === 0 && r2.skipped === 'production' && (after || []).length === 1,
    'L3', 'a production-looking host deletes nothing',
    `cleared=${r2.cleared} skipped=${r2.skipped} rows=${(after || []).length}`);
} catch (e) {
  line(false, 'L0', 'rate-limit harness ran', e && e.message ? e.message.slice(0, 80) : 'threw');
} finally {
  await svc.from('rate_limits').delete().in('key', ['biz:' + A, 'biz:' + B]);
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
