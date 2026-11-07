// tests/housekeeping.test.mjs — the daily sweep deletes only what is dead.
//
// K1  an unused code expired 8 days ago is deleted; one that expires tomorrow
//     and one that was USED long ago both survive
// K2  a rate_limits row whose window ended 3 days ago is deleted; 1 day survives
// K3  the read is bounded to 1000 rows and deletes go in chunks
// K4  a delete failure is counted, never thrown, and does not stop the other table
// K5  a list failure on one table still lets the other finish

import { sweepExpired, CODE_RETENTION_DAYS, LIMIT_RETENTION_DAYS } from '../lib/housekeeping.js';

let total = 0, failed = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(52)}${d ? '  ' + String(d).slice(0, 96) : ''}`);
};

const DAY = 86400000;
const NOW = Date.parse('2026-11-08T00:00:00Z');

/** A stand-in for the two tables, with the same predicates as the SQL. */
function makeIo({ codes = [], limits = [], failDeleteCodes = false, failListLimits = false } = {}) {
  const state = { codes: codes.slice(), limits: limits.slice(), calls: [], chunks: [] };
  return {
    state,
    io: {
      listCodes: async (cutoff, n) => {
        state.calls.push(['listCodes', cutoff, n]);
        return state.codes.filter((c) => !c.used_at && c.expires_at < cutoff).slice(0, n).map((c) => c.code);
      },
      deleteCodes: async (list, cutoff) => {
        state.calls.push(['deleteCodes', list.length, cutoff]);
        if (failDeleteCodes) throw new Error('nope');
        state.chunks.push(list.length);
        const before = state.codes.length;
        state.codes = state.codes.filter((c) => !(list.includes(c.code) && !c.used_at && c.expires_at < cutoff));
        return before - state.codes.length;
      },
      listLimits: async (cutoff, n) => {
        state.calls.push(['listLimits', cutoff, n]);
        if (failListLimits) throw new Error('nope');
        return [...new Set(state.limits.filter((r) => r.window_start < cutoff).slice(0, n).map((r) => r.key))];
      },
      deleteLimits: async (keys, cutoff) => {
        state.calls.push(['deleteLimits', keys.length, cutoff]);
        const before = state.limits.length;
        state.limits = state.limits.filter((r) => !(keys.includes(r.key) && r.window_start < cutoff));
        return before - state.limits.length;
      },
    },
  };
}

const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

/* K1 */
{
  const { io, state } = makeIo({ codes: [
    { code: 'OLDCODE23456', used_at: null, expires_at: iso(8 * DAY) },
    { code: 'LIVECDE23456', used_at: null, expires_at: iso(-1 * DAY) },
    { code: 'USEDCDE23456', used_at: iso(30 * DAY), expires_at: iso(9 * DAY) },
  ] });
  const r = await sweepExpired(io, { now: NOW });
  line(r.codes === 1 && state.codes.length === 2 && state.codes.some((c) => c.code === 'LIVECDE23456')
    && state.codes.some((c) => c.code === 'USEDCDE23456'),
    'K1', 'old unused code deleted; live and used codes survive',
    `deleted=${r.codes} left=${state.codes.length}`);
}

/* K2 */
{
  const { io, state } = makeIo({ limits: [
    { key: 'bindtry:1', window_start: iso(3 * DAY) },
    { key: 'invite:2', window_start: iso(1 * DAY) },
  ] });
  const r = await sweepExpired(io, { now: NOW });
  line(r.limits === 1 && state.limits.length === 1 && state.limits[0].key === 'invite:2',
    'K2', 'old rate_limits row deleted, recent one survives', `deleted=${r.limits}`);
}

/* K3 */
{
  const codes = Array.from({ length: 1500 }, (_, i) => ({ code: 'BULK' + String(i).padStart(8, '0'), used_at: null, expires_at: iso(30 * DAY) }));
  const { io, state } = makeIo({ codes });
  const r = await sweepExpired(io, { now: NOW });
  const list = state.calls.find((c) => c[0] === 'listCodes');
  line(r.codes === 1000 && list[2] === 1000 && state.chunks.length === 10 && state.chunks.every((n) => n <= 100),
    'K3', 'read bounded to 1000, deletes chunked at 100',
    `deleted=${r.codes} chunks=${state.chunks.length}`);
}

/* K4 */
{
  const { io, state } = makeIo({
    codes: [{ code: 'DEADCDE23456', used_at: null, expires_at: iso(8 * DAY) }],
    limits: [{ key: 'old:1', window_start: iso(3 * DAY) }],
    failDeleteCodes: true,
  });
  const r = await sweepExpired(io, { now: NOW });
  line(r.failed === 1 && r.codes === 0 && r.limits === 1 && state.limits.length === 0,
    'K4', 'delete failure counted, other table still swept', `failed=${r.failed} limits=${r.limits}`);
}

/* K5 */
{
  const { io, state } = makeIo({
    codes: [{ code: 'DEADCDE23456', used_at: null, expires_at: iso(8 * DAY) }],
    failListLimits: true,
  });
  const r = await sweepExpired(io, { now: NOW });
  line(r.failed === 1 && r.codes === 1 && state.codes.length === 0,
    'K5', 'list failure on one table does not stop the other', `failed=${r.failed} codes=${r.codes}`);
}

/* K6: the cutoffs are the documented ones. */
{
  const { io, state } = makeIo();
  await sweepExpired(io, { now: NOW });
  const listCode = state.calls.find((c) => c[0] === 'listCodes');
  const listLimit = state.calls.find((c) => c[0] === 'listLimits');
  const wantCode = new Date(NOW - CODE_RETENTION_DAYS * DAY).toISOString();
  const wantLimit = new Date(NOW - LIMIT_RETENTION_DAYS * DAY).toISOString();
  line(listCode[1] === wantCode && listLimit[1] === wantLimit && CODE_RETENTION_DAYS === 7 && LIMIT_RETENTION_DAYS === 2,
    'K6', 'cutoffs: codes 7 days, rate limits 2 days', `code=${listCode[1].slice(0, 10)} limit=${listLimit[1].slice(0, 10)}`);
}

/* K7: the production predicates keep the used_at guard in BOTH the read and the
   delete. A stub cannot prove the SQL, so pin the source text. */
{
  const src = (await import('node:fs')).readFileSync('lib/db.js', 'utf8');
  const fn = src.slice(src.indexOf('export async function sweepExpired'), src.indexOf('/* ---------- businesses'));
  const guards = (fn.match(/\.is\('used_at', null\)/g) || []).length;
  line(guards === 2 && fn.includes("lt('expires_at', cutoff)") && fn.includes("lt('window_start', cutoff)"),
    'K7', 'db predicates: used_at guard on read and delete',
    `guards=${guards}`);
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
