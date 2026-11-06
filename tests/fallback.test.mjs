#!/usr/bin/env node
// tests/fallback.test.mjs — Gate E.
// HARNESS: real HTTP through vercel dev (urlencoded body parsing, HTML responses),
// plus the fake Resend server for the auto-reply payload.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.mjs';
import { createClient } from '@supabase/supabase-js';
import { ALDER_DEMO } from './helpers.mjs';

loadEnv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.LEAD_API_URL || 'http://localhost:3000/api/lead';
const ORIGIN = new URL(API).origin;
const RS = process.env.FAKE_RESEND_URL;
const LOG = path.resolve(ROOT, process.env.LEAD_API_LOG || '_debug/vercel-dev.log');
const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const RUN = Math.random().toString(36).slice(2, 10);

let failed = 0, total = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(5)}${String(what).padEnd(48)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};
async function reset(base) { await fetch(base + '/__reset', { method: 'POST' }); }
async function resendCalls() {
  const r = await fetch(RS + '/__requests');
  return (await r.json()).requests.filter((x) => x.method === 'POST' && x.path === '/emails');
}
// The runner truncates this log at server start, so counting the whole file is safe.
// (Counting from a captured byte offset was flaky: the dev server buffers stderr and
// the warning can land after the response, making a slice appear empty.)

const form = (over) => ({
  service: 'repair', home: 'house', timing: 'planning', age: 'Not sure',
  zip: '50265', phone: '5155550100', name: 'Fallback Tester',
  email: 'fallback@example.com', notes: 'no-js note', website: '', slug: ALDER_DEMO,
  ...over,
});
async function postForm(values) {
  const body = new URLSearchParams(values).toString();
  return fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-real-ip': `198.51.100.${Math.floor(Math.random() * 200) + 20}` },
    body,
  });
}
const rowsFor = async (marker) => (await svc.from('leads').select('id').eq('notes', marker)).data || [];

try {
  await reset(RS);
  await svc.from('rate_limits').delete().gte('window_start', '2000-01-01');

  /* valid urlencoded -> 200 HTML, row created, elapsed and idempotencyKey absent from the form */
  const marker = `E1 ${RUN}`;
  const r1 = await postForm(form({ notes: marker }));
  const html1 = await r1.text();
  const rows1 = await rowsFor(marker);
  line(r1.status === 200 && /text\/html/.test(r1.headers.get('content-type') || '')
    && html1.includes('Alder Roofing') && html1.includes('Back to the site') && rows1.length === 1,
    'E1', 'urlencoded POST -> 200 HTML, row created', `${r1.status} rows=${rows1.length}`);

  /* honeypot filled -> 200 HTML, no row, warn logged */
  const marker2 = `E2 ${RUN}`;
  const warnCount = () => (fs.readFileSync(LOG, 'utf8').match(/lead_dropped_honeypot/g) || []).length;
  const beforeLog = warnCount();
  const r2 = await postForm(form({ notes: marker2, website: 'http://spam.example' }));
  const html2 = await r2.text();
  let afterLog = beforeLog;
  for (let i = 0; i < 48 && afterLog <= beforeLog; i++) {
    await new Promise((r) => setTimeout(r, 125));
    afterLog = warnCount();
  }
  const rows2 = await rowsFor(marker2);
  line(r2.status === 200 && /text\/html/.test(r2.headers.get('content-type') || '')
    && rows2.length === 0 && afterLog > beforeLog,
    'E2', 'honeypot -> 200 HTML, no row, warn logged', `${r2.status} rows=${rows2.length} logs=${beforeLog}->${afterLog}`);

  /* invalid ZIP -> 400 HTML */
  const r3 = await postForm(form({ zip: 'abcde' }));
  const html3 = await r3.text();
  line(r3.status === 400 && /text\/html/.test(r3.headers.get('content-type') || '')
    && html3.includes('check your details'),
    'E3', 'invalid ZIP -> 400 HTML', r3.status);

  /* auto-reply payload */
  const owner = await svc.from('businesses').select('name, owner_email').eq('slug', ALDER_DEMO).single();
  const mails = await resendCalls();
  const auto = mails.find((x) => x.body && x.body.reply_to === owner.data.owner_email);
  const b = auto && auto.body;
  const fromNameOk = b && b.from.startsWith(owner.data.name + ' <');
  const text = b ? (b.html + ' ' + b.text).toLowerCase() : '';
  const noPromise = !/within \d|shortly|soon|24 hours|by tomorrow|as soon as/i.test(text);
  const noBranding = !/\bai\b|studio|automatic(ally)? post|missed-call/i.test(text);
  const hasBoth = b && typeof b.html === 'string' && typeof b.text === 'string';
  line(!!auto && fromNameOk && noPromise && noBranding && hasBoth,
    'E4', 'auto-reply: owner reply_to, business from, no promise',
    `found=${!!auto} from=${fromNameOk} promise=${!noPromise}`);

  /* JSON path unchanged */
  const r5 = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-real-ip': '198.51.100.240' },
    body: JSON.stringify({
      service: 'repair', home: 'house', timing: 'asap', age: 'Not sure', zip: '50265',
      phone: '5155550100', name: 'Json Still Works', email: '', notes: '', claim: false,
      website: '', elapsed: 5000, slug: ALDER_DEMO, idempotencyKey: `${RUN}-json`,
    }),
  });
  let j = null; try { j = await r5.json(); } catch {}
  line(r5.status === 200 && j && j.ok === true, 'E5', 'JSON path still returns {ok:true}', `${r5.status} ${JSON.stringify(j)}`);

  /* E6: urlencoded missing any of the four choice fields -> 400 HTML, nothing stored.
     The server must supply NO defaults for service/home/timing/age on form posts. */
  const marker6 = `E6 ${RUN}`;
  const missingResults = [];
  for (const field of ['service', 'home', 'timing', 'age']) {
    const partial = form({ notes: marker6 });
    delete partial[field];
    const r = await postForm(partial);
    const html = await r.text();
    missingResults.push(`${field}:${r.status}/${/text\/html/.test(r.headers.get('content-type') || '')}/${html.includes('check your details')}`);
  }
  const rows6 = await rowsFor(marker6);
  line(missingResults.length === 4 && missingResults.every((s) => s.endsWith('/true/true')) && rows6.length === 0,
    'E6', 'missing service/home/timing/age -> 400 HTML, no row', `${missingResults.join(' ')} rows=${rows6.length}`);

  /* E7: a complete urlencoded post stores exactly the chosen values */
  const marker7 = `E7 ${RUN}`;
  const r7 = await postForm(form({
    service: 'storm', home: 'multi', timing: 'quarter', age: 'Over 20 years', notes: marker7,
  }));
  const rows7 = await rowsFor(marker7);
  const row7 = rows7.length === 1
    ? (await svc.from('leads').select('service, home, timing, roof_age').eq('notes', marker7).single()).data
    : null;
  line(r7.status === 200 && row7 && row7.service === 'storm' && row7.home === 'multi'
    && row7.timing === 'quarter' && row7.roof_age === 'Over 20 years',
    'E7', 'complete form stores exactly the chosen values',
    r7.status + (row7 ? ` ${row7.service}/${row7.home}/${row7.timing}/${row7.roof_age}` : ' no-row'));
} catch (e) {
  line(false, 'E0', 'fallback suite threw', e.message);
} finally {
  await svc.from('leads').delete().like('notes', `E1 ${RUN}%`);
  await svc.from('leads').delete().like('notes', `E2 ${RUN}%`);
  await svc.from('leads').delete().like('notes', `E6 ${RUN}%`);
  await svc.from('leads').delete().like('notes', `E7 ${RUN}%`);
  await svc.from('leads').delete().eq('idempotency_key', `${RUN}-json`);
  await svc.from('rate_limits').delete().gte('window_start', '2000-01-01');
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
