#!/usr/bin/env node
// tests/owner-mail-failure.test.mjs — Gate OF.
// HARNESS: in-process fakes, no network, no database.
//
// What it proves:
//   OF1  a failed owner cron email writes a business_events failed row and alerts
//        the operator once for that business/type/day
//   OF2  an undelivered operator alert releases the claim so a later failure can
//        still be reported
//   OF3  deliverToBusinesses calls the failure hook when the fallback email fails

import { reportOwnerMailFailure, logOwnerMailOutcome } from '../lib/owner-mail-failure.js';
import { deliverToBusinesses } from '../lib/ops-delivery.js';
import { alertOperator } from '../lib/lifecycle-notify.js';

let total = 0;
let failed = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(52)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};

const business = { id: 'biz-1', name: 'Alpha Roofing', slug: 'alpha' };
process.env.OPERATOR_CHAT_ID = 'fake-operator-chat';

{
  const events = [];
  const alarms = [];
  const claims = [];
  const io = {
    addBusinessEvent: async (row) => { events.push(row); return true; },
    hitRateLimit: async (key) => { claims.push(key); return claims.length === 1; },
    clearRateLimit: async () => true,
    sendMessage: async () => { alarms.push('tg'); return { ok: true }; },
    sendMail: async () => ({ ok: false, status: 500 }),
  };
  const a = await reportOwnerMailFailure({ business, type: 'selfcheck', result: { ok: false, status: 500 }, dateKey: '2026-11-26', io });
  const b = await reportOwnerMailFailure({ business, type: 'selfcheck', result: { ok: false, status: 500 }, dateKey: '2026-11-26', io });
  line(a === true && b === false && events.length === 2
    && events.every((e) => e.businessId === business.id && e.type === 'selfcheck' && e.channel === 'email' && e.status === 'failed')
    && alarms.length === 1,
  'OF1', 'owner mail failure logs and alerts once per business/type/day',
  `alertA=${a} alertB=${b} events=${events.length} alarms=${alarms.length}`);
}

{
  let cleared = 0;
  const io = {
    addBusinessEvent: async () => true,
    hitRateLimit: async () => true,
    clearRateLimit: async () => { cleared++; return true; },
    sendMessage: async () => ({ ok: false, status: 403 }),
    sendMail: async () => ({ ok: false, status: 500 }),
  };
  const how = await reportOwnerMailFailure({ business, type: 'digest', result: { ok: false, status: 500 }, dateKey: '2026-11-26', io });
  line(how === false && cleared === 1, 'OF2', 'undelivered alert releases the claim',
    `how=${how} cleared=${cleared}`);
}

{
  const failures = [];
  const r = await deliverToBusinesses({
    targets: ['biz-1'], text: 'T',
    chatsFor: async () => [],
    sendTg: async () => ({ ok: false }),
    sendMailFor: async () => ({ ok: false, status: 500 }),
    onMailFailure: async (target, result) => { failures.push({ target, status: result.status }); },
  });
  line(r.emailed === 0 && failures.length === 1 && failures[0].status === 500,
    'OF3', 'deliverToBusinesses reports a failed owner email',
    `emailed=${r.emailed} failures=${failures.length}`);
}

{
  const events = [];
  const io = { addBusinessEvent: async (row) => { events.push(row); return true; } };
  await logOwnerMailOutcome('biz-1', 'selfcheck', { ok: true, id: 'msg-1' }, io);
  line(events.length === 1 && events[0].status === 'sent' && events[0].providerId === 'msg-1',
    'OF4', 'successful owner cron email closes its expected row',
    `rows=${events.length} status=${events[0] && events[0].status}`);
}

{
  let cleared = 0;
  const io = {
    hitRateLimit: async () => true,
    clearRateLimit: async () => { cleared++; return true; },
    sendMessage: async () => ({ ok: false, status: 403 }),
    sendMail: async () => ({ ok: false, status: 500 }),
  };
  const ok = await alertOperator(io, {
    business, type: 'suspension',
    failures: [{ channel: 'telegram', errorClass: 'http_403' }], dateKey: '2026-11-26',
  });
  line(ok === false && cleared === 1, 'OF5', 'notice alert claim released when nobody was told',
    `ok=${ok} cleared=${cleared}`);
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
