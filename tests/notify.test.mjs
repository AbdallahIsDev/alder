#!/usr/bin/env node
// tests/notify.test.mjs — Gates A and B.
// HARNESS: in-process handler call with fake Telegram / Resend servers (node:http).
// Run through tests/run.mjs, which creates .test-mode and points both base URLs at the fakes.

import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from './env.mjs';
import { createClient } from '@supabase/supabase-js';

loadEnv();
const TG = process.env.FAKE_TG_URL;
const RS = process.env.FAKE_RESEND_URL;
if (!TG || !RS) { console.log('FAIL  pre  run through tests/run.mjs'); process.exit(1); }

const { default: handler } = await import('../api/lead.js');
const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const RUN = Math.random().toString(36).slice(2, 10);

let failed = 0, total = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(5)}${String(what).padEnd(46)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 100) : ''}`);
};
const note = (s) => console.log(`NOTE       ${s}`);

const logs = [];
const realWarn = console.warn, realErr = console.error;
console.warn = (...a) => logs.push(a.map(String).join(' '));
console.error = (...a) => logs.push(a.map(String).join(' '));

async function control(base, cfg) {
  const r = await fetch(base + '/__control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
  return r.json();
}
async function requests(base) {
  const r = await fetch(base + '/__requests');
  return (await r.json()).requests;
}
async function reset(base) { await fetch(base + '/__reset', { method: 'POST' }); }
async function resetLimits() { await svc.from('rate_limits').delete().gte('window_start', '2000-01-01'); }
async function leadFor(key) {
  const { data } = await svc.from('leads').select('id').eq('idempotency_key', key);
  return data || [];
}
async function events(id) {
  const { data } = await svc.from('lead_events').select('kind, meta').eq('lead_id', id);
  return data || [];
}
async function clean() {
  await svc.from('leads').delete().like('idempotency_key', `${RUN}-%`);
  await resetLimits();
}

function fakeRes() {
  const r = {
    code: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
    send(s) { this.body = s; return this; },
    end() { return this; },
  };
  return r;
}

let ip = 40;
async function post(over, extra) {
  const body = {
    service: 'replacement', home: 'house', timing: 'asap', age: '10 to 20 years',
    zip: '50265', phone: '5155550142', name: 'Notify Tester', email: 'notify@example.com',
    notes: 'plain note', claim: false, website: '', elapsed: 5000,
    slug: 'alder-demo', idempotencyKey: `${RUN}-${Math.random().toString(36).slice(2, 10)}`,
    ...over,
  };
  const res = fakeRes();
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': `203.0.113.${ip++}`, ...(extra || {}) },
    body, socket: {},
  };
  const t0 = Date.now();
  await handler(req, res);
  return { res, body, key: body.idempotencyKey, ms: Date.now() - t0 };
}

const base32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function code(n) { let s = ''; for (let i = 0; i < n; i++) s += base32[Math.floor(Math.random() * base32.length)]; return s; }

await control(TG, { mode: 'ok' });
await control(RS, { mode: 'ok' });

/* ================= GATE A — owner email ================= */
try {
  await clean();
  await reset(TG); await reset(RS);
  const special = { name: 'Bob" <x@y>', notes: '<script>alert(1)</script>\r\nsecond line' };
  const { res, key } = await post(special);
  const rows = await leadFor(key);
  const rreq = (await requests(RS)).filter((x) => x.method === 'POST' && x.path === '/emails');
  const owner = rreq.find((x) => x.body && x.body.subject && x.body.subject.startsWith('New lead:')) || rreq[0];
  const b = owner && owner.body;
  const okFrom = b && b.from && b.from.startsWith('Lead Alerts <');
  const okTo = b && Array.isArray(b.to) && b.to[0] === process.env.MAIL_REDIRECT_TO;
  const okReply = b && b.reply_to === 'notify@example.com';
  const okPrefix = b && b.subject.startsWith('[TEST for ');
  const escaped = b && b.html.includes('&lt;script&gt;') && b.html.includes('Bob&quot; &lt;x@y&gt;');
  const bothParts = b && typeof b.html === 'string' && typeof b.text === 'string';
  const noCrLf = b && !/[\r\n]/.test(b.subject) && !/[\r\n]/.test(b.from);
  // NEW (item 4): table-based shell, labels in both parts, tel: has only digits and +,
  // no external resources, preheader present, escaped notes, under 100 KB.
  const TABLE_LABELS = ['Name', 'Phone', 'Email', 'Service', 'Timing', 'Property', 'Roof age', 'Insurance claim', 'ZIP'];
  const labelsOk = b && TABLE_LABELS.every((l) => b.html.includes('>' + l + '</td>') && b.text.includes(l + ':'))
    && b.text.includes('Notes:');   // the HTML part carries notes in the quoted box, not a table row
  const tel = b && b.html.match(/href="tel:(.*?)"/);
  const telOk = tel && /^[+0-9]+$/.test(tel[1]);
  const noExternal = b && !/<img|<script/.test(b.html)
    && !(b.html.match(/https?:\/\/[^"]+/g) || []).some((u) => !u.startsWith('https://g.page') && !u.includes('alder-demo'));
  const preheaderOk = b && b.html.includes('Bob&quot; &lt;x@y&gt;') && b.html.includes('ZIP 50265');
  const smallOk = b && b.html.length < 100 * 1024;
  const linkMailOk = b && !b.html.includes('<script>') && b.html.includes('&lt;script&gt;');
  line(res.code === 200 && okFrom && okTo && okReply && okPrefix && escaped && bothParts && noCrLf && rows.length === 1
    && labelsOk && telOk && noExternal && preheaderOk && smallOk && linkMailOk,
    'A1', 'owner email payload exact + escaped',
    `from=${okFrom} to=${okTo} reply_to=${okReply} prefix=${okPrefix} esc=${escaped} crlf=${noCrLf} labels=${labelsOk} tel=${telOk} ext=${!noExternal}`);
  line(!!(owner && owner.headers && owner.headers['idempotency-key']), 'A2', 'Idempotency-Key header sent');

  /* A1b: MAIL_REDIRECT_PREFIX=off skips ONLY the subject prefix; recipient still redirected */
  await clean(); await reset(RS);
  const savedPrefix = process.env.MAIL_REDIRECT_PREFIX;
  process.env.MAIL_REDIRECT_PREFIX = 'off';
  const { key: keyB } = await post({});
  process.env.MAIL_REDIRECT_PREFIX = savedPrefix;
  const reqsB = (await requests(RS)).filter((x) => x.method === 'POST' && x.path === '/emails');
  const ownerB = reqsB.find((x) => x.body && x.body.subject && x.body.subject.startsWith('New lead:')) && reqsB.find((x) => x.body && x.body.subject && x.body.subject.startsWith('New lead:')).body;
  line(!!ownerB && !ownerB.subject.startsWith('[TEST for ') && ownerB.to[0] === process.env.MAIL_REDIRECT_TO
    && ownerB.subject.startsWith('New lead:'),
    'A1b', 'prefix off: no [TEST] prefix, still redirected', `to=${ownerB && ownerB.to} subj=${ownerB && ownerB.subject.slice(0, 30)}`);
} catch (e) { line(false, 'A1', 'owner email payload', e.message); }

/* Resend 500 */
try {
  await clean();
  await control(RS, { mode: '500' }); await reset(RS);
  const { res, key, ms } = await post({});
  await control(RS, { mode: 'ok' });
  const rows = await leadFor(key);
  const evs = rows.length ? await events(rows[0].id) : [];
  const fail = evs.find((e) => e.kind === 'email_owner_failed');
  line(res.code === 200 && res.body && res.body.ok === true && rows.length === 1 && !!fail && fail.meta.status === 500 && ms < 5000,
    'A3', 'Resend 500 -> ok:true, one email_owner_failed', `${res.code} rows=${rows.length} ms=${ms} meta=${JSON.stringify(fail && fail.meta)}`);
} catch (e) { line(false, 'A3', 'Resend 500', e.message); }

/* Resend 6 s hang */
try {
  await clean();
  await control(RS, { mode: 'hang_once', hangMs: 6000 }); await reset(RS);
  const { res, key, ms } = await post({});
  await control(RS, { mode: 'ok' }); await reset(RS);
  const rows = await leadFor(key);
  const evs = rows.length ? await events(rows[0].id) : [];
  const fail = evs.find((e) => e.kind === 'email_owner_failed');
  line(res.code === 200 && rows.length === 1 && !!fail && ms < 5000,
    'A4', 'Resend 6 s hang -> ok:true, under 5 s', `${res.code} ms=${ms} meta=${JSON.stringify(fail && fail.meta)}`);
} catch (e) { line(false, 'A4', 'Resend hang', e.message); }

/* Redirect off + default sender -> no HTTP call */
try {
  await clean();
  const savedRedirect = process.env.MAIL_REDIRECT_TO, savedFrom = process.env.MAIL_FROM;
  delete process.env.MAIL_REDIRECT_TO; delete process.env.MAIL_FROM;
  await reset(RS);
  const { res, key } = await post({});
  const count = (await requests(RS)).filter((x) => x.path === '/emails').length;
  const rows = await leadFor(key);
  const evs = rows.length ? await events(rows[0].id) : [];
  const fail = evs.find((e) => e.kind === 'email_owner_failed');
  line(res.code === 200 && count === 0 && !!fail && fail.meta.status === 'no_verified_sender',
    'A5', 'no redirect + default sender -> no HTTP call', `calls=${count} meta=${JSON.stringify(fail && fail.meta)}`);
  if (savedRedirect !== undefined) process.env.MAIL_REDIRECT_TO = savedRedirect;
  if (savedFrom !== undefined) process.env.MAIL_FROM = savedFrom;
} catch (e) { line(false, 'A5', 'no redirect', e.message); }

/* ================= GATE B — Telegram alert ================= */
try {
  await clean();
  await reset(TG); await reset(RS);
  const { res, key } = await post({ notes: 'A note that should be capped' });
  const tgReq = (await requests(TG)).filter((x) => x.method === 'POST' && x.path.includes('/sendMessage'));
  const t = tgReq[0] && tgReq[0].body;
  // NEW (item 2): one "Label: value" per line, blank lines between groups, title
  // carries the only "·", phone keeps the +1 tappable form, ends with Status: New.
  const expectedText = [
    'New lead · Alder Roofing (demo)',
    '',
    'Name: Notify Tester',
    'Phone: +15155550142',
    'Email: notify@example.com',
    '',
    'Service: Roof replacement',
    'Timing: As soon as possible',
    'Property: House',
    'Roof age: 10 to 20 years',
    'Insurance claim: No',
    'ZIP: 50265',
    '',
    'Notes: A note that should be capped',
    '',
    'Status: New',
  ].join('\n');
  const textOk = t && t.text === expectedText;
  const noJoin = t && t.text.split('\n').slice(1).every((l) => !l.includes(' · '));
  const noParse = t && !('parse_mode' in t);
  const kb = t && t.reply_markup && t.reply_markup.inline_keyboard;
  const oneBtn = Array.isArray(kb) && kb.length === 1 && kb[0].length === 1
    && kb[0][0].text === 'Mark contacted' && /^c:[0-9a-f-]{36}$/.test(kb[0][0].callback_data || '');
  line(res.code === 200 && textOk && noJoin && noParse && oneBtn && t.chat_id === process.env.TELEGRAM_CHAT_ID,
    'B1', 'exact plain text, no parse_mode, demo fallback chat', `chat=${t && t.chat_id} keys=${t && Object.keys(t).join(',')}`);
  const rows = await leadFor(key);
  const evs = rows.length ? await events(rows[0].id) : [];
  line(evs.some((e) => e.kind === 'tg_sent'), 'B2', 'tg_sent event recorded');

  /* minimal lead: no notes, no email — the Email and Notes lines are omitted */
  await clean();
  await reset(TG);
  const noContact = await post({ email: '', notes: '' });
  const minReq = (await requests(TG)).filter((x) => x.method === 'POST' && x.path.includes('/sendMessage'));
  const minText = minReq[0] && minReq[0].body && minReq[0].body.text;
  const minExpected = [
    'New lead · Alder Roofing (demo)',
    '',
    'Name: Notify Tester',
    'Phone: +15155550142',
    '',
    'Service: Roof replacement',
    'Timing: As soon as possible',
    'Property: House',
    'Roof age: 10 to 20 years',
    'Insurance claim: No',
    'ZIP: 50265',
    '',
    'Status: New',
  ].join('\n');
  line(!!minText && minText === minExpected,
    'B2b', 'minimal lead: exact text, no Email/Notes lines', `${minText ? minText.length + ' chars' : 'none'}`);
} catch (e) { line(false, 'B1', 'telegram text', e.message); }

/* Bound business -> its chat only */
let boundId = null, activeId = null;
try {
  await clean();
  const { data: biz } = await svc.from('businesses').select('id').eq('slug', 'alder-demo').single();
  const chat = 770001;
  await svc.from('business_chats').upsert({ business_id: biz.id, tg_chat_id: chat }, { onConflict: 'tg_chat_id' });
  await reset(TG);
  await post({});
  const tgReq = (await requests(TG)).filter((x) => x.path.includes('/sendMessage'));
  line(tgReq.length === 1 && String(tgReq[0].body.chat_id) === String(chat),
    'B3', 'bound business -> its chat only', `calls=${tgReq.length} chat=${tgReq[0] && tgReq[0].body.chat_id}`);

  /* Second business -> its own chat */
  const { data: biz2 } = await svc.from('businesses').select('id').eq('slug', 'second-demo').single();
  const chat2 = 770002;
  await svc.from('business_chats').upsert({ business_id: biz2.id, tg_chat_id: chat2 }, { onConflict: 'tg_chat_id' });
  await reset(TG);
  await post({ slug: 'second-demo' });
  const req2 = (await requests(TG)).filter((x) => x.path.includes('/sendMessage'));
  line(req2.length === 1 && String(req2[0].body.chat_id) === String(chat2),
    'B4', 'second business -> its own chat only', `chat=${req2[0] && req2[0].body.chat_id}`);

  /* Active business with no chat -> no call, tg_failed no_chat */
  const { data: made } = await svc.from('businesses').insert({
    slug: `active-${RUN}`, name: 'Active Co', owner_email: 'owner@active.example.com',
    google_review_url: 'https://g.page/r/active', status: 'active',
  }).select('id').single();
  activeId = made.id;
  await reset(TG);
  const { res, key } = await post({ slug: `active-${RUN}` });
  const reqA = (await requests(TG)).filter((x) => x.path.includes('/sendMessage'));
  const rows = await leadFor(key);
  const evs = rows.length ? await events(rows[0].id) : [];
  const f = evs.find((e) => e.kind === 'tg_failed');
  line(res.code === 200 && reqA.length === 0 && !!f && f.meta.status === 'no_chat',
    'B5', 'active + no chat -> no call, tg_failed no_chat', `calls=${reqA.length} meta=${JSON.stringify(f && f.meta)}`);
} catch (e) { line(false, 'B3', 'chat routing', e.message); }

/* 400-with-keyboard retries once without it */
try {
  await clean();
  await control(TG, { mode: '400_if_keyboard' }); await reset(TG);
  const { res } = await post({});
  const reqs = (await requests(TG)).filter((x) => x.path.includes('/sendMessage'));
  await control(TG, { mode: 'ok' });
  line(res.code === 200 && reqs.length === 2 && !!reqs[0].body.reply_markup && !reqs[1].body.reply_markup,
    'B6', '400 with keyboard -> one retry without it', `calls=${reqs.length} keyboard=${!!reqs[0]?.body?.reply_markup}/${!!reqs[1]?.body?.reply_markup}`);
} catch (e) { line(false, 'B6', 'keyboard retry', e.message); }

/* 6 s hang */
try {
  await clean();
  await control(TG, { mode: 'hang_once', hangMs: 6000 }); await reset(TG);
  const { res, key, ms } = await post({});
  await control(TG, { mode: 'ok' }); await reset(TG);
  const rows = await leadFor(key);
  const evs = rows.length ? await events(rows[0].id) : [];
  const f = evs.find((e) => e.kind === 'tg_failed');
  line(res.code === 200 && rows.length === 1 && !!f && ms < 5000,
    'B7', 'Telegram 6 s hang -> ok:true, under 5 s', `${res.code} ms=${ms} meta=${JSON.stringify(f && f.meta)}`);
} catch (e) { line(false, 'B7', 'telegram hang', e.message); }

/* Token / PII never in logs or event meta */
try {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const key = process.env.RESEND_API_KEY || '';
  const logText = logs.join('\n');
  const tokenLeak = (token && logText.includes(token)) || /bot\d+:/.test(logText) || (key && logText.includes(key));
  const piiLeak = /notify@example\.com|5155550142|Notify Tester|<script>/.test(logText);
  line(!tokenLeak && !piiLeak, 'B8', 'logs contain no token, key, URL or PII', `${logs.length} log lines`);
} catch (e) { line(false, 'B8', 'log scan', e.message); }

/* cleanup */
try {
  await svc.from('business_chats').delete().in('tg_chat_id', [770001, 770002]);
  if (activeId) {
    await svc.from('leads').delete().eq('business_id', activeId);
    await svc.from('businesses').delete().eq('id', activeId);
  }
  await clean();
} catch {}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
console.warn = realWarn; console.error = realErr;
process.exit(failed ? 1 : 0);
