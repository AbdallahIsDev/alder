#!/usr/bin/env node
// tests/fixture-safety.test.mjs — Gate F.
// HARNESS: in-process checks plus read-only Supabase queries.
//
// Suites now write only to the dedicated test database. The reserved fixture-chat
// range and two-signal sweep rule still guard against accidentally targeting a
// real Telegram user if test data or cleanup code drifts.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './env.mjs';
import { fetchAllRows, isFixtureLead, fixtureEmail, isTestKey } from './helpers.mjs';
import { FIXTURE_ID_BASE, FIXTURE_CHATS, ALL_FIXTURE_CHAT_IDS, isFixtureChatId } from './fixture-ids.mjs';

loadEnv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let failed = 0, total = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(5)}${String(what).padEnd(52)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};

/* F1 — the range itself. */
const ids = ALL_FIXTURE_CHAT_IDS;
const allAbove = ids.every((n) => Number.isSafeInteger(n) && n >= FIXTURE_ID_BASE);
const allBelowMax = ids.every((n) => n <= Number.MAX_SAFE_INTEGER);
const unique = new Set(ids).size === ids.length;
line(allAbove && allBelowMax && unique, 'F1', 'fixture ids are unique safe integers >= base',
  `${ids.length} ids, base=${FIXTURE_ID_BASE}`);

/* F2 — never the operator's own chat or the legacy single chat. */
const reserved = [process.env.OPERATOR_CHAT_ID, process.env.TELEGRAM_CHAT_ID]
  .filter((v) => v != null && String(v).trim() !== '')
  .map((v) => Number(v));
const collides = reserved.filter((n) => ids.includes(n));
line(collides.length === 0, 'F2', 'no fixture id equals OPERATOR_CHAT_ID/TELEGRAM_CHAT_ID',
  `${reserved.length} reserved id(s) checked`);

/* F3 — none is bound right now. A hit means a suite leaked its row. */
let bound = [];
try {
  bound = await fetchAllRows(() => svc.from('business_chats').select('tg_chat_id').gte('tg_chat_id', FIXTURE_ID_BASE));
} catch (e) {
  line(false, 'F3', 'read business_chats', e.code || 'no_code');
}
line(bound.length === 0, 'F3', 'no fixture chat is currently bound',
  bound.length ? `${bound.length} row(s) — run the runner's pre-clean` : '0 rows');

/* F4 — the predicate rejects the old ids and accepts the new range. */
const oldIds = [770001, 770002, 770010, 880001, 880002, 880009, 900001, 900003];
const rejectsOld = oldIds.every((n) => isFixtureChatId(n) === false);
const acceptsNew = isFixtureChatId(FIXTURE_ID_BASE) && isFixtureChatId(FIXTURE_ID_BASE + 999);
const rejectsAboveSafe = isFixtureChatId(Number.MAX_SAFE_INTEGER + 1) === false;
line(rejectsOld && acceptsNew && rejectsAboveSafe, 'F4', 'isFixtureChatId: old ids rejected, range accepted',
  `${oldIds.length} old ids`);

/* F5 — the pager reads past PostgREST's 1000-row cap. */
{
  const all = Array.from({ length: 1005 }, (_, i) => ({ id: i }));
  let calls = 0;
  const build = () => ({
    range(from, to) {
      calls++;
      return Promise.resolve({ data: all.slice(from, to + 1), error: null });
    },
  });
  const rows = await fetchAllRows(build);
  line(rows.length === 1005 && calls === 2, 'F5', 'fetchAllRows pages past 1000 rows',
    `rows=${rows.length} calls=${calls}`);
}

/* F6 — the sweep needs BOTH signals. */
const key = 'abcd1234-suffix';
const marked = { idempotency_key: key, email: fixtureEmail('x') };
const unmarked = { idempotency_key: key, email: 'real@customer.example' };
const noEmail = { idempotency_key: key, email: null };
const markerOnly = { idempotency_key: '550e8400-e29b-41d4-a716-446655440000', email: fixtureEmail('x') };
line(isFixtureLead(marked) === true
  && isFixtureLead(unmarked) === false
  && isFixtureLead(noEmail) === false
  && isFixtureLead(markerOnly) === false
  && isTestKey(markerOnly.idempotency_key) === false,
'F6', 'sweep requires key shape AND fixture email marker',
`marked=${isFixtureLead(marked)} unmarked=${isFixtureLead(unmarked)} uuid=${isFixtureLead(markerOnly)}`);

/* F7 — no old-style id survives anywhere in the suites. Source scan, so a new
   suite cannot reintroduce one even if it never runs here. */
{
  const files = fs.readdirSync(path.join(ROOT, 'tests'))
    .filter((f) => f.endsWith('.test.mjs') && f !== 'fixture-safety.test.mjs');
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, 'tests', f), 'utf8');
    const m = src.match(/\b(?:77|88|90)0{3}\d\b|\b(?:77|88|90)00\d{2}\b/g);
    if (m) bad.push(`${f}:${[...new Set(m)].join(',')}`);
  }
  line(bad.length === 0, 'F7', 'no suite hard-codes a real-space chat id',
    bad.length ? bad.join(' ') : `${files.length} files clean`);
}

/* F8 — no suite mints a bind code for a real business. Source scan: the code a
   test leaves behind is what /invite's cap counts, and a killed run leaves it. */
{
  const files = fs.readdirSync(path.join(ROOT, 'tests'))
    .filter((f) => f.endsWith('.test.mjs') && f !== 'fixture-safety.test.mjs');
  const bad = [];
  const mint = /(?:createBindCode|mintBindCode)\([^\n]*?\b(?:bizA|bizB)\.id/g;
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, 'tests', f), 'utf8');
    if (mint.test(src)) bad.push(f);
  }
  line(bad.length === 0, 'F8', 'no suite mints a code on a real business',
    bad.length ? bad.join(' ') : `${files.length} files clean`);
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
