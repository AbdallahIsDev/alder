#!/usr/bin/env node
// tests/lifecycle.test.mjs — Gate LC (a suspended or terminated business and
// its website form: hold mode, "unavailable", the held-lead notices, and
// what a reactivation releases).
// HARNESS: api/lead.js and lib/service-status.js called in process against
// the loopback Telegram and Resend fakes and the in-memory PostgREST of
// tests/lifecycle-harness.mjs. No database, no network.
//
// What it proves:
//   LC1  a business in service: the lead is stored, the owner address gets
//        the lead email and every phone the alert (the baseline the rest is
//        measured against)
//   LC2  SUSPENDED = hold mode: 200 { ok, held }; the lead is stored whole,
//        with held_at; NOTHING about it leaves: no lead email, no alert with
//        its details, no customer auto-reply; every phone gets one short
//        notice with no personal data, the support link and the Status
//        keyboard; the owner address gets one email with a COUNT only
//   LC3  a second held lead the same day: one more short notice per phone,
//        no second email; the held count is 2
//   LC4  a retry with the same idempotency key stores nothing and announces
//        nothing; the no-JS form gets a page that says "saved", promises no
//        reply and names nobody's data
//   LC5  the per-hour cap: after HELD_NOTICES_PER_HOUR notices the phones
//        get no more, and every lead is still stored and answered
//   LC6  a notice that fails never changes the answer: the lead is held, the
//        failure is logged and the operator is alerted once
//   LC7  TERMINATED = unavailable: 410 { ok:false, unavailable } and a plain
//        page for the no-JS form; nothing stored, nothing sent, nothing read
//        beyond the tenant; an unknown host is still 404
//   LC8  without migration 0007 the lead is still stored and still announced
//        to nobody
//   LC9  reactivation releases: the notice says how many leads came in, the
//        phones get their role keyboards back, held leads are ordinary leads
//        of the owner's list, and the next lead is announced normally
//   LC10 no personal data in anything a suspended business was sent, in the
//        notice log, or in the operator's alerts
//   LC12 the daily notice audit (api/selfcheck.js): a notice round that left
//        an 'expected' row and no outcome is reported to the operator once a
//        day, by business name and notice type only; complete rounds, rounds
//        still in flight and a database without the table are silent
//   LC13 docs/OPERATIONS.md and docs/legal-drafts/ state the durations that
//        lib/lifecycle-config.js holds, and every draft is marked as a draft
//   LC11 the page: the modal has a panel for each answer with the same
//        sentences the endpoint gives the no-JS form, a Call button, and no
//        reply promise; the generic error panel is not used for either, and
//        in the held state the recap and the next steps are hidden by a rule
//        of their own (display:flex beats the hidden attribute in a browser)
//
// Mutation (each makes a check fail; revert afterwards):
//   api/lead.js: drop `if (held) { ... return okReply(); }`      -> LC2
//   api/lead.js: drop the held_at field of the insert            -> LC2, LC3
//   api/lead.js: answer 404 for 'churned'                        -> LC7
//   lib/held-leads.js: raise the email claim's max to 2          -> LC3
//   lib/held-leads.js: skip the hourly claim                     -> LC5
//   assets/css/styles.css: drop the .est-recap[hidden] /
//     .est-after[hidden] rules (they show again in the held state) -> LC11

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeRes } from './helpers.mjs';
import {
  world, setStore, get, set, during, everything, businessRow, bizId, tgRefuse, mailCtl, longLines, supportLinkOk, textOf, toOf, same,
  OWNER, STAFF, CHAT_B, OP, DAY, iso,
} from './lifecycle-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.IP_HASH_SALT = process.env.IP_HASH_SALT || 'lifecycle-test-salt-0123456789abcdef';

let failed = 0, total = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(5)}${String(what).padEnd(58)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 150) : ''}`);
};

const A = bizId(1);   // suspended for non-payment, two phones
const B = bizId(2);   // active, one phone
const T = bizId(3);   // terminated
const PII = { name: 'Dana Whitfield', phone: '5155550142', email: 'dana.w@fixture.invalid', notes: 'side gate code 4471', zip: '50265' };
const SUPPORT_URL = 'https://t.me/AbdallahIsDev';
const STATUS_KB = { keyboard: [[{ text: 'Status' }]], is_persistent: true, resize_keyboard: true };
const HELD_NOTICE = 'A new lead just submitted your\nform. Your service is suspended,\nso the details are hidden.\nRenew to see them.\n\nSend /status to see the\ncountdown.\n\nContact support';
const HELD_NOTICE_MANUAL = 'A new lead just submitted your\nform. Your service is suspended,\nso the details are hidden.\nRenew to see them.\n\nContact support to restore it.\n\nSend /status to see the current\nstate.\n\nContact support';
const HELD_MAIL = (n) => `${n} new request${n === 1 ? ' has' : 's have'} come in through your website form while your service is suspended.\n\nThe details are hidden until the service is active again.\n\nReply to this email and we will help.`;
const HELD_PAGE = 'Your request was saved, but this business can\u2019t respond through this form right now. For the fastest help, please call them directly.';
const GONE_PAGE = 'This business isn\u2019t accepting requests through this form right now. Please call them directly.';
const OWNER_KB = { keyboard: [[{ text: 'Invite' }, { text: 'Leads' }]], is_persistent: true, resize_keyboard: true };
const STAFF_KB = { keyboard: [[{ text: 'Leads' }]], is_persistent: true, resize_keyboard: true };

const fresh = () => setStore({
  businesses: [
    businessRow(A, 'alder', 'Alder Roofing', 'paused', { paid_until: iso(Date.now() - 6 * DAY), billing_warning_stage: 4, suspended_for_billing: true }),
    businessRow(B, 'beta', 'Beta Roofing', 'active'),
    businessRow(T, 'tern', 'Tern Roofs', 'churned', { paid_until: iso(Date.now() - 16 * DAY), billing_warning_stage: 6, suspended_for_billing: true }),
  ],
  chats: [
    { id: 'c1', business_id: A, tg_chat_id: OWNER, label: null, created_at: iso(Date.now() - 9 * DAY) },
    { id: 'c2', business_id: A, tg_chat_id: STAFF, label: 'Van', created_at: iso(Date.now() - 8 * DAY) },
    { id: 'c3', business_id: B, tg_chat_id: CHAT_B, label: null, created_at: iso(Date.now() - 9 * DAY) },
    { id: 'c4', business_id: T, tg_chat_id: 5000000000000099, label: null, created_at: iso(Date.now() - 9 * DAY) },
  ],
});

let n = 0;
const { default: leadHandler } = await import('../api/lead.js');
const submit = (host, { form = false, key = null, patch = {} } = {}) => during(async () => {
  n += 1;
  const body = {
    service: 'repair', home: 'house', timing: 'asap', age: 'Not sure', zip: PII.zip, phone: PII.phone, name: PII.name,
    email: PII.email, notes: PII.notes, claim: false, website: '', elapsed: 5000, idempotencyKey: key || `lc-${n}-${Math.random().toString(36).slice(2, 12)}`, ...patch,
  };
  const res = fakeRes();
  await leadHandler({
    method: 'POST', headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'x-real-ip': `203.0.113.${(n % 200) + 1}`, host }, body, socket: {},
  }, res);
  return res;
});
/** Any of the visitor's details in a string. */
const leaks = (s) => [PII.name, 'Dana', 'Whitfield', PII.phone, '515-555', '(515)', PII.email, PII.notes, '4471', PII.zip].filter((x) => String(s).includes(x));
const leadsOf = (id) => world.store.leads.filter((l) => l.business_id === id);

try {
  const { HELD_NOTICES_PER_HOUR } = await import('../lib/lifecycle-config.js');
  const SS = await import('../lib/service-status.js');
  const { HELD_IO } = await import('../lib/held-leads.js');
  const { DEFAULT_IO } = await import('../lib/billing-ops.js');
  const { HELD_MESSAGE, UNAVAILABLE_MESSAGE } = await import('../api/lead.js');
  const dbApi = await import('../lib/db.js');
  const everySend = []; // every Telegram message and email sent to a suspended or terminated business

  /* LC1: the baseline. A business in service is told everything. */
  fresh();
  {
    const r = await submit('beta.test');
    const lead = leadsOf(B)[0];
    const alert = r.sends.filter((m) => String(m.body.chat_id) === String(CHAT_B));
    const ownerMail = r.mail.filter((m) => toOf(m) === 'beta@fixture.invalid');
    const ok = r.out.code === 200 && same(r.out.body, { ok: true })
      && leadsOf(B).length === 1 && lead.held_at === null && lead.name === PII.name
      && alert.length === 1 && textOf(alert[0]).includes(PII.name)
      && ownerMail.length === 1 && String(ownerMail[0].body.text).includes(PII.name)
      && world.store.events.length === 0;
    line(ok, 'LC1', 'in service: stored, alerted and mailed with its details',
      `code=${r.out.code} leads=${leadsOf(B).length} tg=${alert.length} mail=${ownerMail.length}/${r.mail.length}`);
  }

  /* LC2: suspended = hold mode. */
  {
    const r = await submit('alder.test');
    everySend.push(...r.tg, ...r.mail);
    const lead = leadsOf(A)[0];
    const lookup = r.sb.find((q) => q.table === 'businesses');
    const answerOk = r.out.code === 200 && same(r.out.body, { ok: true, held: true })
      && !!lookup && lookup.params.some(([k, v]) => k === 'site_host' && v === 'eq.alder.test') && !lookup.params.some(([k]) => k === 'status');
    // Stored whole, and marked.
    const storedOk = leadsOf(A).length === 1 && !!lead.held_at && Math.abs(Date.parse(lead.held_at) - Date.now()) < 60000
      && lead.name === PII.name && lead.phone === '+1' + PII.phone && lead.email === PII.email && lead.notes === PII.notes && lead.zip === PII.zip
      && lead.status === 'open' && lead.business_id === A;
    // Every phone: one short notice, nothing of the visitor in it.
    const told = (chat) => r.sends.filter((m) => String(m.body.chat_id) === String(chat));
    const tgOk = r.sends.length === 2 && [OWNER, STAFF].every((c) => told(c).length === 1 && textOf(told(c)[0]) === HELD_NOTICE
      && supportLinkOk(told(c)[0].body, SUPPORT_URL) && same(told(c)[0].body.reply_markup, STATUS_KB) && !('parse_mode' in told(c)[0].body))
      && longLines(HELD_NOTICE).length === 0 && r.operator.length === 0;
    // The owner address: a count. The visitor: nothing at all.
    const mailOk = r.mail.length === 1 && toOf(r.mail[0]) === 'alder@fixture.invalid' && r.mail[0].body.subject === 'New requests are waiting'
      && String(r.mail[0].body.text).includes(HELD_MAIL(1)) && r.mail[0].body.reply_to === 'operator@fixture.invalid'
      && !r.mail.some((m) => toOf(m) === PII.email) && r.operatorMail.length === 0;
    const quiet = leaks(JSON.stringify([...r.tg.map((m) => m.body), ...r.mail.map((m) => m.body)])).length === 0;
    // lead_events: created (marked held) and nothing that says it was announced.
    const ev = world.store.leadEvents.filter((e) => e.lead_id === lead.id);
    const eventsOk = ev.length === 1 && ev[0].kind === 'created' && ev[0].meta.held === true
      && same(world.store.events.map((e) => `${e.type}/${e.channel}/${e.status}`),
        ['held_lead/none/expected', 'held_lead/telegram/sent', 'held_lead/telegram/sent', 'held_summary/none/expected', 'held_summary/email/sent']);
    line(answerOk && storedOk && tgOk && mailOk && quiet && eventsOk, 'LC2', 'suspended: held, stored whole, announced to nobody',
      `answer=${answerOk} stored=${storedOk} tg=${tgOk} mail=${mailOk} quiet=${quiet} events=${eventsOk}`);
  }

  /* LC3: a second held lead on the same day. */
  {
    const r = await submit('alder.test', { patch: { name: 'Second Person', phone: '5155550143' } });
    everySend.push(...r.tg, ...r.mail);
    const count = await SS.heldLeadCount(get(A), HELD_IO);
    const ok = r.out.code === 200 && same(r.out.body, { ok: true, held: true }) && leadsOf(A).length === 2 && leadsOf(A).every((l) => !!l.held_at)
      && r.sends.length === 2 && r.sends.every((m) => textOf(m) === HELD_NOTICE) && r.mail.length === 0 && count === 2
      && !JSON.stringify(r.tg.map((m) => m.body)).includes('Second Person');
    line(ok, 'LC3', 'second held lead: a notice per phone, no second email',
      `code=${r.out.code} leads=${leadsOf(A).length} tg=${r.sends.length} mail=${r.mail.length} count=${count}`);
  }

  /* LC4: a retry, and the no-JS form. */
  {
    const key = 'lc4-retry-key-0001';
    const first = await submit('alder.test', { key });
    const before = leadsOf(A).length;
    const again = await submit('alder.test', { key });
    everySend.push(...first.tg, ...first.mail, ...again.tg, ...again.mail);
    const retryOk = again.out.code === 200 && same(again.out.body, { ok: true, held: true }) && leadsOf(A).length === before
      && again.tg.length === 0 && again.mail.length === 0;
    const form = await submit('alder.test', { form: true });
    everySend.push(...form.tg, ...form.mail);
    const page = String(form.out.body);
    const formOk = form.out.code === 200 && page.includes(HELD_PAGE);
    const pageOk = HELD_MESSAGE === HELD_PAGE && !/We received your request|We.ll reply|reply within|Dana|5155550/.test(page) && leadsOf(A).length === before + 1
      && leadsOf(A).slice(-1)[0].source === 'form-nojs' && !!leadsOf(A).slice(-1)[0].held_at;
    line(retryOk && formOk && pageOk, 'LC4', 'retry stores and announces nothing; the no-JS page says saved',
      `retry=${retryOk} form=${formOk} page=${pageOk} code=${form.out.code}`);
  }

  /* LC5: the hourly cap on the short notices. */
  {
    const sentSoFar = world.store.events.filter((e) => e.type === 'held_lead' && e.channel === 'none').length;
    let notices = 0, answers = 0, stored = leadsOf(A).length;
    const extra = HELD_NOTICES_PER_HOUR - sentSoFar + 3;
    let leaked = 0;
    for (let i = 0; i < extra; i++) {
      const r = await submit('alder.test');
      everySend.push(...r.tg, ...r.mail);
      if (r.sends.length) notices += 1;
      if (r.out.code === 200 && r.out.body.held === true) answers += 1;
      if (r.mail.length) leaked += 1;
    }
    const ok = notices === HELD_NOTICES_PER_HOUR - sentSoFar && answers === extra && leadsOf(A).length === stored + extra && leaked === 0
      && HELD_NOTICES_PER_HOUR === 20;
    line(ok, 'LC5', 'the hourly cap: no more notices, every lead still held',
      `cap=${HELD_NOTICES_PER_HOUR} before=${sentSoFar} notices=${notices} answers=${answers}/${extra} stored=${leadsOf(A).length - stored}`);
  }

  /* LC6: a notice that fails changes nothing for the visitor. */
  fresh();
  {
    world.tgHook = ({ method, chat }) => (method === 'sendMessage' && String(chat) === String(STAFF) ? tgRefuse() : null);
    const r = await submit('alder.test');
    const second = await submit('alder.test');
    world.tgHook = null;
    everySend.push(...r.tg, ...r.mail, ...second.tg, ...second.mail);
    const failedRow = world.store.events.filter((e) => e.type === 'held_lead' && e.status === 'failed');
    const alert = textOf(r.operator[0]);
    const ok = r.out.code === 200 && same(r.out.body, { ok: true, held: true }) && leadsOf(A).length === 2
      && failedRow.length === 2 && failedRow.every((e) => e.channel === 'telegram' && e.error_class === 'http_403')
      // Alerted once for the day, not once per lead.
      && r.operator.length === 1 && second.operator.length === 0
      && alert === 'Notice not delivered\n\nAlder Roofing\nNotice: held-lead notice\nTelegram: http_403' && leaks(alert).length === 0;
    line(ok, 'LC6', 'a failed notice: still held, logged, operator alerted once',
      `code=${r.out.code} failed=${failedRow.length} alerts=${r.operator.length}/${second.operator.length}`);
  }

  /* LC7: terminated = unavailable. */
  {
    const leadsBefore = world.store.leads.length;
    const eventsBefore = world.store.events.length + world.store.leadEvents.length;
    const r = await submit('tern.test');
    const form = await submit('tern.test', { form: true });
    const page = String(form.out.body);
    const jsonOk = r.out.code === 410 && same(r.out.body, { ok: false, unavailable: true });
    const formOk = form.out.code === 410 && page.includes(GONE_PAGE) && UNAVAILABLE_MESSAGE === GONE_PAGE
      && !/terminat|suspend|unpaid|payment|saved|We received/i.test(page);
    const nothing = [r, form].every((x) => x.tg.length === 0 && x.mail.length === 0 && x.w.length === 0
      && x.sb.every((q) => q.table === 'businesses' || q.table === 'rpc/hit_rate_limit'))
      && world.store.leads.length === leadsBefore && world.store.events.length + world.store.leadEvents.length === eventsBefore;
    const unknown = await submit('nobody.test');
    const unknownOk = unknown.out.code === 404 && same(unknown.out.body, { ok: false }) && unknown.tg.length === 0 && unknown.w.length === 0;
    line(jsonOk && formOk && nothing && unknownOk, 'LC7', 'terminated: 410 unavailable, nothing stored or sent',
      `json=${jsonOk} form=${formOk} nothing=${nothing} unknown=${unknownOk}`);
  }

  /* LC8: a database without migration 0007. */
  fresh();
  world.store.no0007 = true;
  {
    const r = await submit('alder.test');
    everySend.push(...r.tg, ...r.mail);
    const lead = leadsOf(A)[0];
    const ok = r.out.code === 200 && same(r.out.body, { ok: true, held: true }) && leadsOf(A).length === 1 && lead.name === PII.name
      // Still announced to nobody: no lead email, no alert with details, no auto-reply.
      && leaks(JSON.stringify([...r.tg.map((m) => m.body), ...r.mail.map((m) => m.body)])).length === 0
      && !r.mail.some((m) => toOf(m) === PII.email) && r.sends.every((m) => textOf(m) === HELD_NOTICE);
    line(ok, 'LC8', 'without migration 0007: stored, still announced to nobody',
      `code=${r.out.code} leads=${leadsOf(A).length} tg=${r.sends.length} mail=${r.mail.length}`);
  }
  world.store.no0007 = false;

  /* LC9: reactivation releases the held leads. */
  fresh();
  {
    // Suspended by hand this time: the /status hint stays the plain one.
    set(A, { suspended_for_billing: false, paid_until: null, billing_warning_stage: 0 });
    const one = await submit('alder.test');
    const two = await submit('alder.test', { patch: { name: 'Second Person', phone: '5155550143' } });
    everySend.push(...one.tg, ...one.mail, ...two.tg, ...two.mail);
    const manualOk = one.sends.length === 2 && one.sends.every((m) => textOf(m) === HELD_NOTICE_MANUAL) && longLines(HELD_NOTICE_MANUAL).length === 0;
    const rows = world.store.chats.filter((c) => c.business_id === A);
    const r = await during(() => SS.reactivateBusiness({ business: get(A), rows, reason: 'manual' }, DEFAULT_IO));
    const want = 'Your service is active again.\nSupport has reactivated it.\n\n2 leads came in while your\nservice was suspended.\nSend /leads to see them.\n\nSend /status at any time to see\nthe current state.\n\nContact support';
    const told = (chat) => r.sends.filter((m) => String(m.body.chat_id) === String(chat));
    const noticeOk = r.out.changed === true && r.out.held === 2 && get(A).status === 'active'
      && told(OWNER).length === 1 && textOf(told(OWNER)[0]) === want && same(told(OWNER)[0].body.reply_markup, OWNER_KB)
      && told(STAFF).length === 1 && textOf(told(STAFF)[0]) === want && same(told(STAFF)[0].body.reply_markup, STAFF_KB)
      && r.mail.length === 1 && String(r.mail[0].body.text).includes('2 leads came in while your service was suspended.')
      && leaks(JSON.stringify([...r.tg.map((m) => m.body), ...r.mail.map((m) => m.body)])).length === 0;
    // The held leads are ordinary leads of the owner's list now, whole.
    const list = await dbApi.listClientLeads(A, 10, 0);
    const listOk = list.length === 2 && list.some((l) => l.name === PII.name) && list.some((l) => l.name === 'Second Person')
      && leadsOf(A).length === 2 && (await SS.heldLeadCount(get(A), HELD_IO)) !== null;
    // And the next lead is announced normally, with its details.
    const next = await submit('alder.test', { patch: { name: 'Third Person', phone: '5155550144' } });
    const nextOk = next.out.code === 200 && same(next.out.body, { ok: true }) && leadsOf(A).length === 3 && leadsOf(A).slice(-1)[0].held_at === null
      && next.sends.some((m) => textOf(m).includes('Third Person')) && next.mail.some((m) => toOf(m) === 'alder@fixture.invalid' && String(m.body.text).includes('Third Person'));
    line(manualOk && noticeOk && listOk && nextOk, 'LC9', 'reactivation: the count, the keyboards, the leads, normal again',
      `manual=${manualOk} notice=${noticeOk} list=${listOk} next=${nextOk}`);
  }

  /* LC10: nothing personal in anything a suspended business was sent, in the
     notice log or in the operator's alerts; no line longer than the rule. */
  {
    const all = await everything();
    const sent = everySend.map((m) => JSON.stringify(m.body));
    const log = JSON.stringify(world.store.events);
    const leaked = [...sent, log].flatMap((x) => leaks(x));
    const long = everySend.filter((m) => m.body && m.body.chat_id !== undefined).flatMap((m) => longLines(textOf(m)));
    const parse = all.tg.filter((x) => x.body && typeof x.body === 'object' && 'parse_mode' in x.body).length;
    const visitorMail = all.mail.filter((m) => toOf(m) === PII.email);
    // The only mail the visitor ever got is the auto-reply of the two leads
    // submitted while the business was IN service (LC1, LC9's last).
    line(leaked.length === 0 && long.length === 0 && parse === 0 && everySend.length > 40 && visitorMail.length <= 2, 'LC10', 'no personal data, no long line, no parse_mode in any notice',
      `messages=${everySend.length} leaked=${[...new Set(leaked)].join('|') || 'none'} long=${long.length} parse=${parse} visitorMail=${visitorMail.length}`);
  }

  /* LC12: the daily audit of the notice log. */
  {
    const NA = await import('../lib/notice-audit.js');
    const now = Date.parse('2026-11-16T07:00:00Z');
    const ev = (business_id, type, status, minutesAgo, channel = 'none') => ({ business_id, type, channel, status, created_at: iso(now - minutesAgo * 60000) });
    // Pure: complete rounds are fine; an 'expected' with nothing after it, or
    // followed by another 'expected', is missing; a round still in flight waits.
    const pure = NA.missingOutcomes([
      ev(A, 'overdue', 'expected', 600), ev(A, 'overdue', 'sent', 600, 'telegram'), ev(A, 'overdue', 'sent', 600, 'email'),
      ev(B, 'suspension', 'expected', 500),                                       // never finished
      ev(A, 'held_lead', 'expected', 400), ev(A, 'held_lead', 'expected', 300), ev(A, 'held_lead', 'failed', 300, 'telegram'),  // the first one is missing
      ev(T, 'termination', 'expected', 200), ev(T, 'termination', 'skipped', 200),
      ev(B, 'reactivation', 'expected', 5),                                       // still sending
    ], now);
    const pureOk = same(pure.map((m) => `${m.businessId === A ? 'A' : m.businessId === B ? 'B' : 'T'}:${m.type}`), ['B:suspension', 'A:held_lead'])
      && NA.missingOutcomes([], now).length === 0 && NA.missingOutcomes(null, now).length === 0;
    // End to end: the operator is told once, names and notice types only.
    fresh();
    world.store.clock = null;
    world.store.events = [
      { id: 'n1', ...ev(B, 'suspension', 'expected', 500) },
      { id: 'n2', ...ev(A, 'held_lead', 'expected', 400) }, { id: 'n3', ...ev(A, 'held_lead', 'expected', 300) },
      { id: 'n4', ...ev(A, 'held_lead', 'sent', 300, 'telegram') },
      { id: 'n5', ...ev(T, 'termination', 'expected', 200) }, { id: 'n6', ...ev(T, 'termination', 'sent', 200, 'email') },
      { id: 'n7', ...ev(T, 'overdue', 'expected', 60 * 30) },                     // older than the window: yesterday's run saw it
    ];
    const first = await during(() => NA.auditOwnerNotices({ now }));
    const again = await during(() => NA.auditOwnerNotices({ now }));
    const text = textOf(first.operator[0]);
    const runOk = same(first.out, { ok: true, rounds: 4, missing: 2, operator: 'telegram' }) && first.operator.length === 1 && first.sends.length === 0 && first.mail.length === 0
      && text === 'Owner notices with no recorded outcome\n\nBeta Roofing: suspension notice\nAlder Roofing: held-lead notice\n\nCheck that each business was told.'
      && first.w.length === 0
      && same(again.out, { ok: true, rounds: 4, missing: 2, operator: 'none' }) && again.tg.length === 0;
    // Nothing missing: silence. No table: skipped, silence.
    world.store.events = world.store.events.filter((e) => !['n1', 'n2'].includes(e.id));
    world.store.claims.clear();
    const clean = await during(() => NA.auditOwnerNotices({ now }));
    world.store.no0007 = true;
    const bare = await during(() => NA.auditOwnerNotices({ now }));
    world.store.no0007 = false;
    const quietOk = same(clean.out, { ok: true, rounds: 2, missing: 0, operator: 'none' }) && clean.tg.length === 0 && clean.operatorMail.length === 0
      && same(bare.out, { ok: true, skipped: 'unavailable' }) && bare.tg.length === 0;
    const wired = /auditOwnerNotices\(\)/.test(fs.readFileSync(path.join(ROOT, 'api/selfcheck.js'), 'utf8'));
    line(pureOk && runOk && quietOk && wired, 'LC12', 'notice audit: a round with no outcome reaches the operator once',
      `pure=${pureOk} run=${runOk} quiet=${quietOk} wired=${wired} out=${JSON.stringify(first.out)}`);
  }

  /* LC13: the documents state the durations of the code. */
  {
    const L = await import('../lib/lifecycle-config.js');
    const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const drafts = read('docs/legal-drafts/README.md');
    const row = (name, value) => new RegExp('`' + name + '` \\| ' + value + ' days \\|').test(drafts);
    const tableOk = row('RENEWAL_REMINDER_DAYS', L.RENEWAL_REMINDER_DAYS) && row('GRACE_DAYS', L.GRACE_DAYS) && row('SUSPENDED_DAYS', L.SUSPENDED_DAYS)
      && row('TERMINATE_AFTER_DAYS', L.TERMINATE_AFTER_DAYS) && row('RETENTION_DAYS', L.RETENTION_DAYS) && row('EXTEND_DAYS', L.EXTEND_DAYS);
    const terms = read('docs/legal-drafts/terms-of-service.md');
    const termsOk = terms.includes(`| ${L.RENEWAL_REMINDER_DAYS} days before the due date |`) && terms.includes(`| ${L.GRACE_DAYS - L.FINAL_WARNING_DAYS_BEFORE} days after the due date |`)
      && terms.includes(`| ${L.GRACE_DAYS} days after the due date | **The service is suspended.**`)
      && terms.includes(`| ${L.TERMINATE_AFTER_DAYS - L.TERMINATION_WARNING_DAYS_BEFORE} days after the due date |`)
      && terms.includes(`| ${L.TERMINATE_AFTER_DAYS} days after the due date | **The service is terminated.**`)
      && terms.includes(`We keep your data for ${L.RETENTION_DAYS} days after termination.`) && terms.includes(`each period of ${L.EXTEND_DAYS} days`);
    const ops = read('docs/OPERATIONS.md');
    const opsOk = ops.includes(`| D - ${L.RENEWAL_REMINDER_DAYS} days | due soon |`) && ops.includes(`| D | grace (${L.GRACE_DAYS} days) |`)
      && ops.includes(`| D + ${L.GRACE_DAYS} days | **suspended** (${L.SUSPENDED_DAYS} days) |`) && ops.includes(`| D + ${L.TERMINATE_AFTER_DAYS} days | **terminated** |`)
      && ops.includes(`for ${L.RETENTION_DAYS} days | terminated, data kept |`) && ops.includes(`at most ${L.HELD_NOTICES_PER_HOUR} an hour per business`);
    // Every draft says what it is, at the top.
    const marked = ['terms-of-service.md', 'privacy-notice.md', 'data-processing-summary.md'].every((f) => /^# .*\(DRAFT, not reviewed by a lawyer\)/.test(read('docs/legal-drafts/' + f)))
      && /not legal advice/.test(drafts) && /not\s+legal advice/.test(read('docs/PRE_LAUNCH_CHECKLIST.md'));
    line(tableOk && termsOk && opsOk && marked, 'LC13', 'the runbook and the legal drafts state the configured durations',
      `table=${tableOk} terms=${termsOk} runbook=${opsOk} marked=${marked}`);
  }

  /* LC11: the page. */
  {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const esc = (t) => t.replace('\u2019', '\\u2019');
    const css = fs.readFileSync(path.join(ROOT, 'assets/css/styles.css'), 'utf8');
    const textsOk = html.includes(`text: '${esc(HELD_PAGE)}'`) && html.includes(`text: '${esc(GONE_PAGE)}'`);
    // Decided on the response, before the generic error panel can show.
    const branchOk = /out && out\.held === true \? 'held' : ''/.test(html)
      && /err && err\.body && err\.body\.unavailable === true\) \{ showSent\(data, false, 'unavailable'\); return; \}\s*showError\(err\)/.test(html);
    // The panel: its own title and words, no recap, no "what happens next",
    // no success mark, and the Call button of the done pane stays. Two of those
    // are switched off by the hidden attribute, and a display:flex rule of their
    // own beats that attribute in a browser, so each needs a rule of its own or
    // the held visitor still sees their address and the three steps.
    const hides = (sel) => new RegExp(sel.replace(/[.[\]]/g, '\\$&') + '\\s*\\{\\s*display:\\s*none\\s*\\}').test(css);
    const panelOk = /function showSent\(data, already, kind\)/.test(html) && /after\.hidden = !!notice/.test(html)
      && /recapBox\.hidden = !!already \|\| !!notice/.test(html) && /done\.classList\.toggle\('est-plain', !!notice\)/.test(html)
      && /\.est-done\.est-plain \.est-ok\s*\{\s*display:\s*none/.test(css)
      && hides('.est-done .est-recap[hidden]') && hides('.est-done .est-after[hidden]')
      && /<section class="est-pane est-done"[\s\S]*?<button type="button" class="btn ghost" data-close[\s\S]*?<a class="btn phone" href="tel:\{\{tel\}\}"/.test(html);
    const promiseFree = ![HELD_PAGE, GONE_PAGE].some((t) => /reply|within|soon|shortly|get back/i.test(t));
    // deliver() must hand the body on: resolve with the parsed JSON, reject with it.
    const deliverOk = /estimateDeliver/.test(html);
    line(textsOk && branchOk && panelOk && promiseFree && deliverOk, 'LC11', 'the page: a panel per answer, the same words, no promise',
      `texts=${textsOk} branch=${branchOk} panel=${panelOk} promise=${promiseFree}`);
  }

  /* LC17: a held lead replayed after reactivation must stay silent. The key now
     belongs to an active business, but the stored row was held and was never
     announced: announcing it here would leak its details to the owner. Run last
     so it cannot disturb the state the earlier assertions share. */
  {
    fresh();
    const key = 'lc17-held-replay-0001';
    const first = await submit('alder.test', { key });
    set(A, { status: 'active' });
    const again = await submit('alder.test', { key });
    const bodies = JSON.stringify([...again.tg.map((m) => m.body), ...again.mail.map((m) => m.body)]);
    const ok = first.out.body && first.out.body.held === true
      && again.out.code === 200 && again.out.body && again.out.body.ok === true && again.out.body.held === true
      && leadsOf(A).length === 1 && !!leadsOf(A)[0].held_at
      && again.sends.length === 0 && again.mail.length === 0 && leaks(bodies).length === 0;
    line(ok, 'LC17', 'held lead replay after reactivation stays silent',
      `first=${JSON.stringify(first.out.body)} again=${JSON.stringify(again.out.body)} leads=${leadsOf(A).length} tg=${again.sends.length} mail=${again.mail.length}`);
  }

  /* LC18: a failed fresh status read must leave a code-only line. The stale
     tenant row may still decide the answer, but the failure is never silent. */
  {
    fresh();
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args.map(String).join(' '));
    world.sbHook = async ({ table, params }) => {
      if (table === 'businesses' && params.some(([k]) => k === 'id')) {
        return new Response(JSON.stringify({ message: 'database down', code: 'XX000' }),
          { status: 500, headers: { 'content-type': 'application/json' } });
      }
      return null;
    };
    const r = await submit('alder.test');
    world.sbHook = null;
    console.error = original;
    const lineOk = errors.some((l) => l.includes('lead_status_read_failed') && /XX000|no_code/.test(l));
    const quiet = !errors.some((l) => leaks(l).length > 0);
    line(lineOk && quiet && r.out.code === 200, 'LC18',
      'failed fresh status read logs a code, never lead data',
      `logged=${lineOk} quiet=${quiet} code=${r.out.code}`);
  }
} catch (e) {
  line(false, 'LC0', 'lifecycle suite threw', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
}
console.log(`\n${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
