// tests/network-guard.test.mjs — no suite may reach a real provider.
//
// N1  importing tests/env.mjs installs the guard on globalThis.fetch
// N2  api.telegram.org and api.resend.com are blocked whatever VERCEL_ENV says
// N3  loopback and the Supabase host pass
// N4  a blocked request throws before a socket is opened
//
// Mutation: delete the installNetworkGuard() call at the bottom of tests/env.mjs
// and N1/N4 fail. That is the point of asserting on the ambient fetch rather
// than on a guard the test installs itself.

import { loadEnv } from './env.mjs';
import { GUARDED, isBlockedUrl, installNetworkGuard } from './env.mjs';

loadEnv();

let total = 0;
let failed = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(56)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 90) : ''}`);
};

/* N1: the ambient fetch, not one this test installed. */
line(globalThis.fetch && globalThis.fetch[GUARDED] === true, 'N1',
  'tests/env.mjs installs the guard on the ambient fetch',
  `marker=${!!(globalThis.fetch && globalThis.fetch[GUARDED])}`);

/* N2/N3: the predicate, under every environment value that matters. */
{
  const saved = process.env.VERCEL_ENV;
  const cases = [];
  for (const env of ['production', 'preview', 'development', undefined]) {
    if (env === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = env;
    cases.push({
      env: env || 'unset',
      tg: isBlockedUrl('https://api.telegram.org/bot123/sendMessage'),
      rs: isBlockedUrl('https://api.resend.com/emails'),
      lo: isBlockedUrl('http://127.0.0.1:63900/__reset'),
      lh: isBlockedUrl('http://localhost:3000/api/lead'),
      sb: isBlockedUrl((process.env.SUPABASE_URL || 'https://x.supabase.co') + '/rest/v1/leads'),
    });
  }
  if (saved === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = saved;
  const ok = cases.every((c) => c.tg && c.rs && !c.lo && !c.lh && !c.sb);
  line(ok, 'N2', 'providers blocked under every VERCEL_ENV; loopback and Supabase pass',
    cases.map((c) => `${c.env}:${c.tg ? 'B' : 'x'}${c.rs ? 'B' : 'x'}${c.sb ? 'x' : 'P'}`).join(' '));
}

/* N4: behavioural. 192.0.2.1 is TEST-NET-1, reserved and unroutable; with the
   guard this throws immediately, without it the request hangs until the signal. */
{
  let msg = '';
  try {
    await fetch('http://192.0.2.1/probe', { signal: AbortSignal.timeout(1000) });
  } catch (e) {
    msg = String((e && e.message) || '');
  }
  line(msg === 'network_guard_blocked', 'N4', 'a blocked request throws before any socket',
    `message=${msg || '(none)'}`);
}

/* N5: re-installing is a no-op, and uninstalling restores a working fetch. */
{
  const before = globalThis.fetch;
  const off = installNetworkGuard();
  const stillSame = globalThis.fetch === before;
  off();
  const restored = globalThis.fetch === before;
  line(stillSame && restored, 'N5', 'install is idempotent and the uninstall is a no-op',
    `same=${stillSame} restored=${restored}`);
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
