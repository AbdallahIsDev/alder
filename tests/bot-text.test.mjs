// tests/bot-text.test.mjs — every Telegram string is well formed.
//
// The bug this exists for: /invite shipped "add://n//n/start CODE" because the
// template contained //n where \n was meant. Nothing escaped anything — the
// characters were typed. R13 looked at that string and asked only "no banned
// words, no '{' placeholders", so it passed.
//
// T1  no user-facing text contains a literal \n, "//n", an unpaired //, an
//     unreplaced ${...}, "undefined" or "[object "
// T2  the invite carries a real t.me deep link, the code exactly twice, and the
//     expiry, with real line breaks
// T3  the fallback shape (no username) is equally well formed
// T4  every exported BOT_*/TOAST_* string is in the sample set, so a new
//     constant cannot dodge T1
//
// Mutation: put //n back into botInviteText and T1 fails.

import fs from 'node:fs';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { loadEnv } from './env.mjs';
import { sampleTelegramTexts } from '../lib/sample-texts.js';
import * as C from '../lib/content.js';
import { isTestKey } from './helpers.mjs';

loadEnv();

let total = 0;
let failed = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(52)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};

/** The shapes that mean "this string was built wrong". */
export const ARTIFACTS = [
  ['literal backslash-n', /\\n/],
  ['//n', /\/\/n/],
  ['unpaired //', /(^|[^:])\/\//],
  ['unreplaced template', /\$\{/],
  ['undefined', /\bundefined\b/],
  ['[object', /\[object /],
];

const samples = sampleTelegramTexts();

/* T1 */
{
  const hits = [];
  for (const { name, text } of samples) {
    for (const [label, re] of ARTIFACTS) {
      if (re.test(text)) hits.push(`${name}:${label}`);
    }
  }
  line(hits.length === 0, 'T1', 'no user-facing text carries a build artifact',
    `strings=${samples.length} hits=${hits.slice(0, 4).join(',') || 'none'}`);
}

/* T2: the client message carries the link as an entity, never as visible URL
   text, and the code appears once, on its own last line, as a code entity. */
{
  const code = 'K7M2QPX9RT4W';
  const m = C.botInviteText(code, { username: 'alder_alerts_bot' });
  const link = m.entities.find((e) => e.type === 'text_link');
  const codeEnt = m.entities.find((e) => e.type === 'code');
  const linkWords = link ? m.text.slice(link.offset, link.offset + link.length) : '';
  const occurrences = m.text.split(code).length - 1;
  const lastLine = m.text.split('\n').pop();
  const ok = m.text.startsWith('Tap here to connect your lead alerts on Telegram, then press Start.')
    && !m.text.includes('Hi!') && !m.text.includes('t.me') && !m.text.includes('http')
    && linkWords === 'connect your lead alerts'
    && link.url === `https://t.me/alder_alerts_bot?start=${code}`
    && occurrences === 1 && lastLine === code
    && !!codeEnt && m.text.slice(codeEnt.offset, codeEnt.offset + codeEnt.length) === code
    && m.entities.length === 2;
  line(ok, 'T2', 'client message: link words carry the URL, code once as an entity',
    `entities=${m.entities.length} link=${linkWords} count=${occurrences}`);
}

/* T3: without a username there is no text_link; /start CODE stays visible. */
{
  const code = 'K7M2QPX9RT4W';
  const m = C.botInviteText(code);
  const types = m.entities.map((e) => e.type);
  const ent = m.entities[0] || {};
  const ok = !types.includes('text_link') && types.includes('code')
    && m.text.startsWith('Connect your lead alerts on Telegram. Open the bot and send it this code:')
    && !m.text.includes('Tap here') && !m.text.includes('t.me')
    && m.text.includes(`/start ${code}`)
    && m.text.slice(ent.offset, ent.offset + ent.length) === `/start ${code}`
    && m.text.split(code).length - 1 === 1
    && /expires in 24 hours/.test(m.text);
  line(ok, 'T3', 'client fallback: no link sentence, /start CODE as a code entity',
    `types=${types.join(',')} lines=${m.text.split('\n').length}`);
}

/* T4 */
{
  const exported = Object.entries(C)
    .filter(([k, v]) => typeof v === 'string' && /^(BOT_|TOAST_)/.test(k))
    .map(([k]) => k);
  const covered = new Set(samples.map((s) => s.name));
  const missing = exported.filter((k) => !covered.has(k));
  line(missing.length === 0, 'T4', 'every exported user-facing constant is sampled',
    `exported=${exported.length} missing=${missing.join(',') || 'none'}`);
}

/* T5: the sweep predicate is narrow. A UUID's first segment is 8 hex chars, so
   the UUID exclusion is what stops a sweep deleting a real page-minted lead. */
{
  const ok = isTestKey('a1b2c3d4-x') && isTestKey('canary-abc')
    && !isTestKey('manual-test-1700000000000-ab12')
    && !isTestKey('form-abc') && !isTestKey('measure-abc')
    && !isTestKey('550e8400-e29b-41d4-a716-446655440000');
  line(ok, 'T5', 'sweep keys: suite and canary only, never manual-test or a UUID', `ok=${ok}`);
}

/* T6: the two messages of the operator's /invite <slug> are disjoint. The operator line names the slug and
   marks the code as an entity; the client message never names the business. */
{
  const code = 'K7M2QPX9RT4W';
  const first = C.operatorCodeText({ slug: 'alder-demo', code });
  const second = C.botForwardText({ code, username: 'alder_alerts_bot' });
  const ent = first.entities[0] || {};
  const ok = first.text.includes('alder-demo') && first.text.includes(code)
    && /expires in 24 hours/i.test(first.text)
    && first.text.slice(ent.offset, ent.offset + ent.length) === code
    && first.entities.length === 1
    && !second.text.includes('alder-demo') && !second.text.includes('Alder')
    && !second.text.includes('operator');
  line(ok, 'T6', '/invite <slug>: operator line names the slug, client message never does',
    `opEntities=${first.entities.length} slugInClient=${second.text.includes('alder-demo')}`);
}

/* T7: without a username the client message still tells the client to send
   /start plus the code, and it carries no dead link. */
{
  const code = 'K7M2QPX9RT4W';
  const m = C.botForwardText({ code });
  const ok = !m.text.includes('t.me') && m.text.includes(`/start ${code}`)
    && m.text.startsWith('Connect your lead alerts on Telegram.')
    && !m.text.includes('Hi!') && !m.text.includes('send me') && !m.text.includes('Tap here')
    && /expires in 24 hours/.test(m.text)
    && m.entities.every((e) => e.type === 'code');
  line(ok, 'T7', 'client fallback: no link, /start CODE, no "send me"',
    `len=${m.text.length} entities=${m.entities.length}`);
}

/* T9: buttons stay short for narrow phones, and the obvious is not spelled out.
   Every button is capped at 20 characters. The /leads and /remove_lead lists
   carry number buttons sharing ONE row ("1".."5"), so the list buttons are a
   single character each. Recorded history of this assertion: the cap was 20
   for everything; the labeled-row browser then split it (rows <= 40, actions
   <= 20); the labeled rows are gone again, so it is 20 for everything and
   exactly one digit for a list button — stricter than both earlier forms. */
{
  const C = await import('../lib/content.js');
  const lead = { id: 'x', name: 'Daniel Whitaker', service: 'repair', created_at: new Date().toISOString() };
  const five = [lead, lead, lead, lead, lead];
  const listKb = C.leadListKeyboard(five, 1, true).reply_markup.inline_keyboard;
  const removeKb = C.removeLeadKeyboard(five, 1, true).reply_markup.inline_keyboard;
  const bizId = '550e8400-e29b-41d4-a716-446655440000';
  const fiveBiz = [1, 2, 3, 4, 5].map((n) => ({ id: bizId, name: 'A Very Long Business Name Roofing & Exteriors ' + n, slug: 's' + n, status: 'demo', phones: n }));
  const fiveOpLeads = five.map((l) => ({ ...l, id: bizId }));
  const opListKb = C.operatorBusinessListKeyboard(fiveBiz, 1, true).reply_markup.inline_keyboard;
  const opLeadsKb = C.operatorLeadListKeyboard({ businessId: bizId, leads: fiveOpLeads, leadPage: 1, page: 1, hasOlder: true }).reply_markup.inline_keyboard;
  const numbers = [...listKb[0], ...removeKb[0], ...opListKb[0], ...opLeadsKb[0]];
  const navAndActions = [
    C.BOT_INVITE_CANCEL_BUTTON,
    ...C.recipientsKeyboard([{ id: 'a', label: null }], {}).inline_keyboard.flat().map((b) => b.text),
    ...C.recipientConfirmKeyboard('a').inline_keyboard.flat().map((b) => b.text),
    ...opListKb.flat().map((b) => b.text),
    ...opLeadsKb.flat().map((b) => b.text),
    ...C.operatorBusinessDetailKeyboard(bizId, 1).reply_markup.inline_keyboard.flat().map((b) => b.text),
    ...C.operatorBusinessDetailKeyboard(bizId, 1, { suspended: true }).reply_markup.inline_keyboard.flat().map((b) => b.text),
    ...C.operatorSuspendConfirmKeyboard(bizId, 1).reply_markup.inline_keyboard.flat().map((b) => b.text),
    ...C.operatorInviteListKeyboard(fiveBiz, 1, true).reply_markup.inline_keyboard.flat().map((b) => b.text),
    ...C.operatorBackToInviteListKeyboard(1).reply_markup.inline_keyboard.flat().map((b) => b.text),
    ...C.operatorBackToBusinessKeyboard(bizId, 1).reply_markup.inline_keyboard.flat().map((b) => b.text),
    ...['list', 'business'].flatMap((from) => [C.operatorAlreadyConnectedKeyboard(bizId, 1, from), C.operatorReplaceConfirmKeyboard(bizId, 1, from),
      C.operatorInviteBackKeyboard(bizId, 1, from)].flatMap((k) => k.reply_markup.inline_keyboard.flat().map((b) => b.text))),
    ...C.operatorLeadDetailKeyboard({ businessId: bizId, leadPage: 1, page: 1 }).reply_markup.inline_keyboard.flat().map((b) => b.text),
    ...listKb.flat().map((b) => b.text),
    ...removeKb.flat().map((b) => b.text),
    ...C.removeLeadConfirmKeyboard('x', 0).reply_markup.inline_keyboard.flat().map((b) => b.text),
    ...C.alertKeyboard('x').inline_keyboard.flat().map((b) => b.text),
    ...C.jobDoneKeyboard('x').inline_keyboard.flat().map((b) => b.text),
    ...C.tryAgainKeyboard('x').inline_keyboard.flat().map((b) => b.text),
    ...C.confirmKeyboard('x', true).inline_keyboard.flat().map((b) => b.text),
    ...C.confirmKeyboard('x', false).inline_keyboard.flat().map((b) => b.text),
    ...['new', 'contacted', 'confirm', 'done', 'error'].flatMap((k) => C.leadDetailKeyboard(k, 'x', 0, lead).reply_markup.inline_keyboard.flat().map((b) => b.text)),
    ...[C.OWNER_KEYBOARD_LABELS, C.STAFF_KEYBOARD_LABELS, C.OPERATOR_KEYBOARD_LABELS].flatMap((l) => C.persistentKeyboard(l).keyboard.flat().map((b) => b.text)),
  ];
  const longActions = navAndActions.filter((t) => t.length > 20);
  const badNumbers = numbers.filter((b) => !/^[1-5]$/.test(b.text));
  // The operator copy offers no retired command (/phones, /code, the owner's
  // /recipients and /leads), no per-phone Remove, no Terminate, and never the
  // word "Requests" for a count of leads.
  const opBiz = { id: bizId, name: 'A', slug: 'a', status: 'demo' };
  const operatorCopy = [C.OPERATOR_WELCOME, C.OPERATOR_HELP, C.OPERATOR_USAGE_INVITE, C.OPERATOR_UNKNOWN_SLUG, C.OPERATOR_CAPPED,
    C.OPERATOR_NO_BUSINESSES, C.OPERATOR_NO_INVITABLE, C.OPERATOR_BUSINESS_GONE, C.OPERATOR_SCREEN_EXPIRED, C.OPERATOR_PAGE_GONE,
    C.OPERATOR_NO_LEADS, C.OPERATOR_NO_OLDER_LEADS, C.OPERATOR_LEAD_GONE,
    C.operatorBusinessListText(fiveBiz), C.operatorInviteListText(fiveBiz), C.operatorNoPhoneText({ business: { name: 'A', slug: 'a' } }),
    C.operatorBusinessDetailText({ business: opBiz, rows: [{ label: null }], stats: { total: 1, recent: 1, lastAt: new Date().toISOString() } }),
    C.operatorSuspendConfirmText(opBiz), C.operatorSuspendedText({ business: opBiz, failed: 1 }), C.operatorReactivatedText(opBiz),
    C.operatorAlreadySuspendedText(opBiz), C.operatorAlreadyActiveText(opBiz), C.operatorInviteSuspendedText(opBiz),
    C.operatorAlreadyConnectedText({ business: opBiz, phones: 2 }), C.operatorReplaceConfirmText({ business: opBiz, phones: 2 }),
    C.operatorInviteFailedText({ business: opBiz }), C.operatorInviteFailedText({ business: opBiz, capped: true, replace: true }),
    C.operatorReplaceFailedText(opBiz), C.OPERATOR_ALREADY_REPLACED, C.OPERATOR_NO_PHONE_NOW, C.BOT_ACCESS_ENDED,
    C.operatorCodeText({ slug: 'a', code: 'K7M2QPX9RT4W', cancelled: 2, removed: 2, failed: 1 }).text,
    C.operatorCodeResendText({ code: 'K7M2QPX9RT4W', removed: 1 }).text,
    C.operatorLeadListText(opBiz, fiveOpLeads), C.operatorLeadCardText(opBiz, fiveOpLeads[0])].join('\n');
  // (The blocked-phone notice names the OWNER's /recipients on purpose: it
  // says who can remove the phone. It is checked for the rest only.)
  const copy = [operatorCopy, C.BOT_INVITE_CANCEL_BUTTON, C.operatorUnreachableText({ business: { name: 'A', slug: 'a' }, chatId: 1234 }),
    C.botRecipientsText([{ id: 'a', label: null }]), C.botInvitePendingText({ hours: [5] })].join('\n');
  const banned = /with a Remove button each|Tap Remove to disconnect|The main phone is the one connected first|Cancel them to make a new one|\/phones|Remove Phone|Pick a business with/i;
  const bannedOperator = /\/code\b|\/recipients|\/leads|\/remove_lead|Terminate|terminated|Requests?\b/;
  const goneExports = ['OPERATOR_USAGE_PHONES', 'OPERATOR_NO_PHONES', 'OPERATOR_PHONE_REMOVED', 'OPERATOR_PHONE_GONE',
    'operatorPhonesText', 'operatorPhonesKeyboard', 'operatorConfirmRemoveText', 'operatorConfirmRemoveKeyboard', 'operatorBusinessesText',
    'OPERATOR_LEADS_HINT', 'OPERATOR_USAGE_CODE', 'OPERATOR_PICK_TEXT', 'operatorPickerKeyboard', 'OPERATOR_REMOVE_LEAD',
    'OPERATOR_TERMINATE_STILL', 'OPERATOR_TERMINATED', 'OPERATOR_NOT_CONNECTED', 'operatorTerminateConfirmText',
    'operatorTerminateConfirmKeyboard', 'operatorTerminatedText', 'botAccessEndedText',
    // The in-place "Invite link · works once" output and its toast.
    'operatorInviteResultText', 'operatorInviteCancelledToast']
    .filter((k) => k in C);
  const oldInviteOutput = /Invite link|Forward this link to the business owner|works once ·/.test(operatorCopy);
  line(longActions.length === 0 && numbers.length === 20 && badNumbers.length === 0 && !banned.test(copy)
    && !bannedOperator.test(operatorCopy) && !oldInviteOutput && goneExports.length === 0,
    'T9', 'every button <= 20 chars; list buttons are one digit',
    `buttons=${navAndActions.length} numbers=${numbers.map((b) => b.text).join('')} long=${longActions.join(',') || 'none'} gone=${goneExports.join(',') || 'none'} banned=${banned.test(copy)}/${bannedOperator.test(operatorCopy)}`);
}

/* T10: destructive confirms say what happens, and only they carry danger. */
{
  const C = await import('../lib/content.js');
  const one = C.recipientConfirmText({ id: 'a', label: null }, 0, { isLast: false });
  const last = C.recipientConfirmText({ id: 'a', label: null }, 0, { isLast: true });
  const kb = C.recipientConfirmKeyboard('row-1').inline_keyboard[0];
  const bizId = '550e8400-e29b-41d4-a716-446655440000';
  const biz = { id: bizId, name: 'Alder Roofing', slug: 'alder-demo', status: 'demo' };
  const opKb = C.operatorSuspendConfirmKeyboard(bizId, 3).reply_markup.inline_keyboard[0];
  const opDetail = C.operatorBusinessDetailKeyboard(bizId, 3).reply_markup.inline_keyboard;
  const opSuspended = C.operatorBusinessDetailKeyboard(bizId, 3, { suspended: true }).reply_markup.inline_keyboard;
  // Replace phone, opened from the /invite list and from a business screen.
  const kbRows = (k) => k.reply_markup.inline_keyboard;
  const connectedList = kbRows(C.operatorAlreadyConnectedKeyboard(bizId, 3, 'list'));
  const connectedBiz = kbRows(C.operatorAlreadyConnectedKeyboard(bizId, 3, 'business'));
  const replaceList = kbRows(C.operatorReplaceConfirmKeyboard(bizId, 3, 'list'));
  const replaceBiz = kbRows(C.operatorReplaceConfirmKeyboard(bizId, 3, 'business'));
  const danger = [kb[0], opKb[0], opDetail[0][0], connectedList[0][0], connectedBiz[0][0], replaceList[0][0], replaceBiz[0][0]];
  const cancel = [kb[1], opKb[1], opDetail[0][1], opDetail[1][1], opSuspended[0][1], opSuspended[1][0],
    connectedList[0][1], connectedBiz[0][1], replaceList[0][1], replaceBiz[0][1]];
  const JSONsame = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // The exact layouts. Served: Suspend (danger) left and Leads right, then
  // Invite (primary) left and Back right. Suspended: Reactivate (primary) and
  // Leads, then Back alone; no Invite and no Suspend. The question: Confirm
  // suspend (danger) left, Cancel right, back to the business.
  const now = Date.parse('2026-11-14T12:00:00Z');
  const stats = { total: 7, recent: 3, lastAt: '2026-11-12T10:00:00Z' };
  const phones = [{ label: null }, { label: 'Van' }];
  const opOk = JSONsame(opDetail, [
    [{ text: 'Suspend', callback_data: `bs:3:${bizId}`, style: 'danger' }, { text: 'Leads', callback_data: `bq:0:3:${bizId}` }],
    [{ text: 'Invite', callback_data: `bv:3:${bizId}`, style: 'primary' }, { text: 'Back', callback_data: 'bl:3' }],
  ]) && JSONsame(opSuspended, [
    [{ text: 'Reactivate', callback_data: `br:3:${bizId}`, style: 'primary' }, { text: 'Leads', callback_data: `bq:0:3:${bizId}` }],
    [{ text: 'Back', callback_data: 'bl:3' }],
  ]) && JSONsame(opKb, [
    { text: 'Confirm suspend', callback_data: `bS:3:${bizId}`, style: 'danger' },
    { text: 'Cancel', callback_data: `bd:3:${bizId}` },
  ])
    // Already connected: Replace phone (danger) left, Back right. The
    // question: Confirm replace (danger) left, Cancel right, side by side.
    && JSONsame(connectedList, [[{ text: 'Replace phone', callback_data: `bp:3:${bizId}`, style: 'danger' }, { text: 'Back', callback_data: 'bn:3' }]])
    && JSONsame(connectedBiz, [[{ text: 'Replace phone', callback_data: `bw:3:${bizId}`, style: 'danger' }, { text: 'Back', callback_data: `bd:3:${bizId}` }]])
    && JSONsame(replaceList, [[{ text: 'Confirm replace', callback_data: `bP:3:${bizId}`, style: 'danger' }, { text: 'Cancel', callback_data: `bc:3:${bizId}` }]])
    && JSONsame(replaceBiz, [[{ text: 'Confirm replace', callback_data: `bW:3:${bizId}`, style: 'danger' }, { text: 'Cancel', callback_data: `bu:3:${bizId}` }]])
    && JSONsame(kbRows(C.operatorInviteBackKeyboard(bizId, 3, 'list')), [[{ text: 'Back', callback_data: 'bn:3' }]])
    && JSONsame(kbRows(C.operatorInviteBackKeyboard(bizId, 3, 'business')), [[{ text: 'Back', callback_data: `bd:3:${bizId}` }]])
    && [connectedList, connectedBiz, replaceList, replaceBiz].flat(2).every((b) => Buffer.byteLength(b.callback_data, 'utf8') <= 64)
    && C.operatorAlreadyConnectedText({ business: biz, phones: 1 }) === 'Alder Roofing · Already connected · 1 phone'
    && C.operatorAlreadyConnectedText({ business: biz, phones: 3 }) === 'Alder Roofing · Already connected · 3 phones'
    && C.operatorReplaceConfirmText({ business: biz, phones: 1 }) === 'Replace the phone of Alder Roofing? The 1 current phone stops receiving alerts and loses access immediately, and a new invite is created. Alerts on Telegram stay off until the new phone connects; new leads are still saved and emailed.'
    && C.operatorReplaceConfirmText({ business: biz, phones: 3 }) === 'Replace the phones of Alder Roofing? The 3 current phones stop receiving alerts and lose access immediately, and a new invite is created. Alerts on Telegram stay off until the new phone connects; new leads are still saved and emailed.'
    && C.BOT_ACCESS_ENDED === 'Your access to lead alerts for this business was ended by support.'
    && C.OPERATOR_ALREADY_REPLACED === 'Already replaced.'
    && C.operatorInviteSuspendedText(biz) === 'Alder Roofing is suspended. Reactivate it first.'
    && C.operatorInviteFailedText({ business: biz, replace: true }) === 'Could not create an invite for Alder Roofing. Try again. No phone was removed.'
    && C.operatorCodeText({ slug: 'alder-demo', code: 'K7M2QPX9RT4W', removed: 2, failed: 1, cancelled: 2 }).text
      === 'Code for alder-demo: K7M2QPX9RT4W\n\nExpires in 24 hours. 2 phones removed (1 notice not delivered). 2 older invites were cancelled. The next message is for the client — forward it as it is.'
    && C.operatorSuspendConfirmText(biz) === 'Suspend Alder Roofing? Telegram alerts, emails and the website form stop for this business. Data is kept and you can reactivate at any time.'
    && C.BOT_SUSPENDED_NOTICE === 'Your service has been suspended. Contact support if this is a mistake.'
    && C.BOT_SUSPENDED === 'This service is suspended. Contact support.'
    && C.BOT_REACTIVATED === 'Your service is active again.'
    && C.OPERATOR_SCREEN_EXPIRED === 'That screen expired. Here is the current screen.'
    && C.operatorSuspendedText({ business: biz, failed: 0 }) === 'Alder Roofing suspended · 0 notices failed'
    && C.operatorSuspendedText({ business: biz, failed: 1 }) === 'Alder Roofing suspended · 1 notice failed'
    && C.operatorReactivatedText(biz) === 'Alder Roofing reactivated'
    // The business screen, to the character, in its three states.
    && C.operatorBusinessDetailText({ business: biz, rows: phones, stats, nowMs: now })
      === 'Alder Roofing\nDemo · alder-demo\n\nTelegram: Connected\nPhone 1 · main phone\nPhone 2 (Van)\n\nLeads: 7 total · 3 in the last 30 days\nLast lead: 2d ago'
    && C.operatorBusinessDetailText({ business: { ...biz, status: 'active' }, rows: [], stats: { total: 0, recent: 0, lastAt: null }, nowMs: now })
      === 'Alder Roofing\nActive · alder-demo\n\nTelegram: Not connected\n\nLeads: 0 total · 0 in the last 30 days'
    && C.operatorBusinessDetailText({ business: { ...biz, status: 'paused' }, rows: [{ label: null }], stats, nowMs: now })
      === 'Alder Roofing\nSuspended · alder-demo\n\nTelegram: Connected\nPhone 1 · main phone\n\nLeads: 7 total · 3 in the last 30 days\nLast lead: 2d ago'
    // The operator's view of a lead: these fields and no other.
    && JSONsame([...C.OPERATOR_LEAD_FIELDS], ['service', 'status', 'age'])
    && C.operatorLeadCardText(biz, { service: 'repair', status: 'open', created_at: '2026-11-12T10:00:00Z', name: 'Dana Whitfield', phone: '+15155550142', email: 'dana@example.com', notes: 'side gate' }, now)
      === 'Alder Roofing\nLead\n\nService: Repair\nStatus: New\nReceived: 2d ago';
  const ok = opOk && !/Remove it\?/.test(one) && !/Remove it\?/.test(last)
    && one.includes('It will stop receiving alerts.')
    && last.includes('This is the last phone.')
    && danger.every((b) => b.style === 'danger')
    && cancel.every((b) => b.style === undefined)
    && opDetail[1][0].style === 'primary' && opSuspended[0][0].style === 'primary'
    && C.BOT_RECIPIENT_REMOVED === 'Removed.';
  line(ok, 'T10', 'destructive confirm: says what happens, danger only on the action',
    `one=${one.split('\n').pop()} danger=${danger.map((b) => b.style).join(',')}`);
}

/* T8: the preview renders entities, not just .text. It spawns the real script
   and reads the file it writes, so a preview that silently drops the markers
   fails here. */
{
  const r = spawnSync(process.execPath, ['scripts/preview.mjs'], { encoding: 'utf8' });
  const file = ' _debug/previews/telegram-invite.txt'.trim();
  const body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const sample = samples.find((x) => x.name === 'invite:link:rendered');
  // Same spawn: the HTML previews must show the company header and no emoji.
  const htmlFiles = ['digest.html', 'selfcheck-active.html', 'owner-email-stress.html', 'review-request.html'];
  const htmlBad = [];
  for (const f of htmlFiles) {
    const html = fs.existsSync('_debug/previews/' + f) ? fs.readFileSync('_debug/previews/' + f, 'utf8') : '';
    if (!html.includes('Alder Roofing')) htmlBad.push(f + ':name');
    if (/\p{Extended_Pictographic}/u.test(html)) htmlBad.push(f + ':emoji');
  }
  const ok = r.status === 0
    && body.includes('[[link:https://t.me/alder_alerts_bot?start=')
    && body.includes('[[code]]K7M2QPX9RT4W[[/code]]')
    && !!sample && sample.text.includes('[[link:') && sample.text.includes('[[code]]')
    && htmlBad.length === 0;
  line(ok, 'T8', 'preview: entities, no emoji, company name in the HTML header',
    `exit=${r.status} bad=${htmlBad.join(',') || 'none'}`);
}

/* T12: the owner menu lists /remove_lead, and every entry is a legal command. */
{
  const { COMMANDS } = await import('../scripts/tg-commands.mjs');
  const names = COMMANDS.map((c) => c.command);
  const legal = COMMANDS.every((c) => /^[a-z0-9_]{1,32}$/.test(c.command) && c.description.length <= 256);
  line(names.includes('remove_lead') && legal, 'T12',
    'owner menu lists /remove_lead and every command is legal', names.join(','));
}

/* T13: the removal line names the request and nothing else — no phone, no email,
   no notes, no trailing period. The name is the only thing the owner needs to
   know which row went, and this line sits in a chat someone may read over a
   shoulder. */
{
  const withName = C.removedText({ name: 'Daniel Whitaker', service: 'repair', phone: '5555012345', email: 'd@example.com', notes: 'gate code 1234' });
  const blank = C.removedText({ name: '   ', service: 'storm' });
  const ok = withName === 'Removed: Daniel Whitaker · Repair'
    && blank === 'Removed: a request · Storm damage'
    && !withName.endsWith('.')
    && !/\d/.test(withName) && !withName.includes('@')
    && !withName.includes('gate');
  line(ok, 'T13', 'removal line: name and job only, no contact details',
    JSON.stringify(withName));
}

/* T14: the persistent reply keyboard. At most TWO buttons, side by side in ONE
   row, KeyboardButton text only (no emoji), persistent and resized; one fixed
   set per role; every label maps back onto a command — the permission checks
   live in the handlers, never in the keyboard. Everything else stays in the
   native command menu (T20). */
{
  const owner = C.persistentKeyboard(C.OWNER_KEYBOARD_LABELS);
  const staff = C.persistentKeyboard(C.STAFF_KEYBOARD_LABELS);
  const op = C.persistentKeyboard(C.OPERATOR_KEYBOARD_LABELS);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const btnKeys = (kb) => kb.keyboard.flat().map((b) => Object.keys(b).sort().join(','));
  const shapeOk = [owner, staff, op].every((kb) =>
    kb.is_persistent === true && kb.resize_keyboard === true
    && same(Object.keys(kb).sort(), ['is_persistent', 'keyboard', 'resize_keyboard'])
    && Array.isArray(kb.keyboard) && kb.keyboard.length === 1
    && kb.keyboard[0].length >= 1 && kb.keyboard[0].length <= 2
    && btnKeys(kb).every((k) => k === 'text')
    && kb.keyboard[0].every((b) => /^[A-Za-z]+$/.test(b.text)));
  // The exact layouts, left to right.
  const setsOk = same(owner.keyboard, [[{ text: 'Invite' }, { text: 'Leads' }]])
    && same(staff.keyboard, [[{ text: 'Leads' }]])
    && same(op.keyboard, [[{ text: 'Invite' }, { text: 'Businesses' }]]);
  const labels = [...C.OWNER_KEYBOARD_LABELS, ...C.STAFF_KEYBOARD_LABELS, ...C.OPERATOR_KEYBOARD_LABELS];
  const mapped = labels.map((l) => C.KEYBOARD_LABELS[l]);
  // The map is the current labels plus the ones a phone may still be showing
  // from an earlier keyboard (the operator's "Code" among them) — and nothing
  // else. "Code" and "Phones" still map onto their old commands here; the
  // operator chat turns a PRESS on them into /invite and /businesses
  // (tests/operator-browser OB1a, OB13), while the typed commands are gone.
  const legacy = Object.keys(C.LEGACY_KEYBOARD_LABELS);
  const mapOk = same(Object.keys(C.KEYBOARD_LABELS).sort(), [...new Set([...labels, ...legacy])].sort())
    && same(legacy.sort(), ['Code', 'Help', 'Operator', 'Phones', 'Recipients'])
    && same(mapped, ['/invite', '/leads', '/leads', '/invite', '/businesses'])
    && C.KEYBOARD_LABELS.Code === '/code'
    && C.KEYBOARD_LABELS.Recipients === '/recipients' && C.KEYBOARD_LABELS.Help === '/help'
    && C.KEYBOARD_LABELS.Phones === '/phones' && C.KEYBOARD_LABELS.Operator === '/operator'
    && Object.values(C.KEYBOARD_LABELS).every((cmd) => typeof cmd === 'string' && /^\/[a-z_]+$/.test(cmd) && cmd.length <= 32);
  line(shapeOk && setsOk && mapOk, 'T14', 'persistent keyboard: one row, <= 2 text-only buttons per role',
    `shape=${shapeOk} sets=${setsOk} map=${mapOk} owner=${C.OWNER_KEYBOARD_LABELS.join('|')} staff=${C.STAFF_KEYBOARD_LABELS.join('|')} op=${C.OPERATOR_KEYBOARD_LABELS.join('|')}`);
}

/* T15: the list buttons are numbers and nothing else. The message text is the
   only place a lead's details appear: the number in front of a lead in the
   text is the label of its button, in the same order, in ONE row. (Before:
   one labeled row button per lead, "name · service · age" — a second copy of
   the text. That builder, leadRowLabel, is gone.) */
{
  const now = Date.now();
  const leads = [1, 2, 3, 4, 5].map((n) => ({
    id: `0000000${n}-e29b-41d4-a716-446655440000`, name: `Customer ${n}`, service: 'repair', status: 'open',
    phone: '5155550100', email: `c${n}@example.com`, created_at: new Date(now - n * 60000).toISOString(),
  }));
  const text = C.renderLeadList(leads, now);
  const removeText = C.removeLeadListText(leads, now);
  const listKb = C.leadListKeyboard(leads, 0, false).reply_markup.inline_keyboard;
  const removeKb = C.removeLeadKeyboard(leads, 0, false).reply_markup.inline_keyboard;
  const numbered = (t) => t.split('\n').filter((l) => /^\d+\. /.test(l));
  const rowOk = (kb, prefix) => kb.length === 1 && kb[0].length === 5
    && kb[0].every((b, i) => b.text === String(i + 1) && b.callback_data === `${prefix}:0:${leads[i].id}`
      && Object.keys(b).sort().join(',') === 'callback_data,text');
  const textOk = numbered(text).length === 5 && numbered(text).every((l, i) => l === `${i + 1}. Customer ${i + 1}`)
    && numbered(removeText).every((l, i) => l === `${i + 1}. Customer ${i + 1}`)
    && text.includes('Repair · +15155550100') && /\d+m ago/.test(text);
  // No detail from the text may appear on a button.
  const allLabels = [...listKb.flat(), ...removeKb.flat()].map((b) => b.text).join('|');
  const noDuplicate = !/Customer|Repair|ago|just now|·|515|@/.test(allLabels);
  const ok = rowOk(listKb, 'L') && rowOk(removeKb, 'Q') && textOk && noDuplicate
    && typeof C.leadRowLabel === 'undefined'
    && C.leadListKeyboard([], 0, false).reply_markup.inline_keyboard.length === 0
    && C.leadListKeyboard(leads.slice(0, 2), 0, false).reply_markup.inline_keyboard[0].length === 2;
  line(ok, 'T15', 'list buttons: one row of numbers matching the text, no duplication',
    `list=${rowOk(listKb, 'L')} remove=${rowOk(removeKb, 'Q')} text=${textOk} labels=${allLabels}`);
}

/* T16: navigation renders only what is useful. First page with older rows:
   Older alone. Middle pages: Newer and Older side by side. Last page: Newer
   alone. A single page: no navigation row. No button is ever disabled and no
   placeholder is rendered; the whole keyboard is the number row plus at most
   one navigation row. (Before: both ends always present, the unavailable one
   disabled with a same-page callback.) */
{
  const lead = { id: 'x', name: 'A', service: 'repair', created_at: new Date().toISOString() };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const kbs = (build, prefix) => {
    const first = build([lead], 0, true).reply_markup.inline_keyboard;
    const mid = build([lead], 1, true).reply_markup.inline_keyboard;
    const last = build([lead], 2, false).reply_markup.inline_keyboard;
    const single = build([lead], 0, false).reply_markup.inline_keyboard;
    // Explicit arguments that would produce a useless button are ignored: a
    // Newer on page 0 and an Older past the last addressable page.
    const forcedNewer = build([lead], 0, false, true).reply_markup.inline_keyboard;
    const capped = build([lead], 999, true, true).reply_markup.inline_keyboard;
    const all = [first, mid, last, single, forcedNewer, capped];
    return same(first[1], [{ text: 'Older', callback_data: `${prefix}:1` }])
      && same(mid[1], [{ text: 'Newer', callback_data: `${prefix}:0` }, { text: 'Older', callback_data: `${prefix}:2` }])
      && same(last[1], [{ text: 'Newer', callback_data: `${prefix}:1` }])
      && single.length === 1 && forcedNewer.length === 1
      && same(capped[1], [{ text: 'Newer', callback_data: `${prefix}:998` }])
      && all.every((kb) => kb.length <= 2 && kb[0].length === 1 && kb[0][0].text === '1')
      && all.every((kb) => !JSON.stringify(kb).includes('disabled'));
  };
  const listOk = kbs(C.leadListKeyboard, 'l');
  const removeOk = kbs(C.removeLeadKeyboard, 'rm');
  line(listOk && removeOk, 'T16', 'nav: Older / Newer+Older / Newer / none, never disabled',
    `leads=${listOk} remove=${removeOk}`);
}

/* T17: Telegram caps callback_data at 1-64 bytes. Every keyboard builder is
   exercised with the worst case (three-digit page, real uuid) and every
   emitted callback must fit. No button carries copy_text any more (the
   "Copy phone" button is gone), and every button has exactly one action. */
{
  const C2 = await import('../lib/content.js');
  const uuid = '550e8400-e29b-41d4-a716-446655440000';
  const lead = { id: uuid, name: 'Daniel Whitaker', service: 'repair', phone: '5155550100', email: 'd@example.com', created_at: new Date().toISOString() };
  const keyboards = [
    C2.leadListKeyboard([lead, lead, lead, lead, lead], 998, true, true),
    C2.leadListKeyboard([lead, lead, lead, lead, lead], 999, true, true),
    C2.removeLeadKeyboard([lead, lead, lead, lead, lead], 998, true, true),
    C2.removeLeadKeyboard([lead, lead, lead, lead, lead], 999, true, true),
    C2.removeLeadConfirmKeyboard(uuid, 999),
    C2.removeLeadConfirmKeyboard(uuid),
    C2.alertKeyboard(uuid), C2.jobDoneKeyboard(uuid), C2.tryAgainKeyboard(uuid), C2.confirmKeyboard(uuid, true),
    C2.recipientsKeyboard([{ id: uuid, label: null }], {}),
    C2.recipientConfirmKeyboard(uuid),
    C2.operatorInviteListKeyboard([lead, lead, lead, lead, lead], 998, true, true),
    C2.operatorInviteListKeyboard([lead, lead, lead, lead, lead], 999, true, true),
    C2.operatorBackToInviteListKeyboard(999),
    C2.operatorBusinessDetailKeyboard(uuid, 999, { suspended: true }),
    C2.operatorBusinessListKeyboard([lead, lead, lead, lead, lead], 998, true, true),
    C2.operatorBusinessListKeyboard([lead, lead, lead, lead, lead], 999, true, true),
    C2.operatorBusinessDetailKeyboard(uuid, 999),
    C2.operatorSuspendConfirmKeyboard(uuid, 999),
    C2.operatorBackToBusinessKeyboard(uuid, 999),
    C2.operatorLeadListKeyboard({ businessId: uuid, leads: [lead, lead, lead, lead, lead], leadPage: 98, page: 999, hasOlder: true }),
    C2.operatorLeadListKeyboard({ businessId: uuid, leads: [lead, lead, lead, lead, lead], leadPage: 99, page: 999, hasOlder: true }),
    C2.operatorLeadDetailKeyboard({ businessId: uuid, leadPage: 99, page: 999 }),
    ...['new', 'contacted', 'confirm', 'done', 'error'].map((k) => C2.leadDetailKeyboard(k, uuid, 999, lead)),
    C2.leadDetailKeyboard('new', uuid, 999, { ...lead, phone: null }),
  ];
  const buttons = keyboards.flatMap((kb) => (kb.reply_markup || kb).inline_keyboard.flat());
  const cbs = buttons.filter((b) => b.callback_data).map((b) => b.callback_data);
  const tooLong = cbs.filter((d) => Buffer.byteLength(d, 'utf8') > 64);
  const empty = cbs.filter((d) => Buffer.byteLength(d, 'utf8') < 1);
  // Nothing a customer typed can ride along: a known one- or two-letter kind,
  // then only digits, colons and uuid hex.
  // The one exception is bo: (the operator's read-only request): two uuids
  // do not fit as text, so both travel packed, 22 base64url characters each,
  // and each must unpack to a uuid again. Still nothing typed by anyone.
  const packedOk = (d) => {
    const m = /^bo:(\d{1,2}):(\d{1,3}):([A-Za-z0-9_-]{22})([A-Za-z0-9_-]{22})$/.exec(d);
    return !!m && C2.unpackUuid(m[3]) === uuid && C2.unpackUuid(m[4]) === uuid;
  };
  const shaped = cbs.filter((d) => (d.startsWith('bo:')
    ? !packedOk(d)
    : !/^[A-Za-z]{1,2}:/.test(d) || !/^[0-9a-f:-]*$/.test(d.replace(/^[A-Za-z]{1,2}:/, ''))));
  // Every page a button addresses must pass the anchored page regex (1-3 digits;
  // the operator's request page 1-2 digits).
  const pages = cbs.map((d) => /^(?:l|rm|bl):(\d+)$/.exec(d) || /^(?:[LQCDYNRE]|bd|bt|bT):(\d+):/.exec(d) || /^b[qo]:\d{1,2}:(\d+):/.exec(d)).filter(Boolean).map((m) => m[1]);
  const badPages = pages.filter((n) => n.length > 3)
    .concat(cbs.map((d) => /^b[qo]:(\d+):/.exec(d)).filter(Boolean).map((m) => m[1]).filter((n) => n.length > 2));
  const packs = C2.packUuid(uuid).length === 22 && C2.unpackUuid(C2.packUuid(uuid)) === uuid
    && C2.packUuid('not-a-uuid') === '' && C2.unpackUuid('short') === null && C2.unpackUuid('!'.repeat(22)) === null;
  const noAction = buttons.filter((b) => !b.callback_data);
  const copies = buttons.filter((b) => 'copy_text' in b);
  const longest = cbs.reduce((a, b) => (Buffer.byteLength(b) > Buffer.byteLength(a) ? b : a), '');
  line(cbs.length > 20 && tooLong.length === 0 && empty.length === 0 && shaped.length === 0
    && badPages.length === 0 && pages.length > 20 && packs
    && cbs.filter((d) => d.startsWith('bo:')).length === 10
    && noAction.length === 0 && copies.length === 0,
    'T17', 'every callback_data <= 64 bytes; no copy_text button anywhere',
    `callbacks=${cbs.length} longest=${longest} (${Buffer.byteLength(longest)}B) copies=${copies.length}`);
}

/* T18: the lead detail keyboard — the browser's card. Same actions and styles
   as the alert, then "Back" alone on its own row, plain text, to the page it
   came from. The "Copy phone" button is gone: the number is already tappable
   in the message text. */
{
  const C2 = await import('../lib/content.js');
  const uuid = '550e8400-e29b-41d4-a716-446655440000';
  const lead = { id: uuid, name: 'A', service: 'repair', phone: '5155550100', email: 'd@example.com', created_at: new Date().toISOString() };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const kb = (kind, l = lead) => C2.leadDetailKeyboard(kind, uuid, 3, l).reply_markup.inline_keyboard;
  const BACK = [{ text: 'Back', callback_data: 'l:3' }];
  const fresh = kb('new');
  const contacted = kb('contacted');
  const confirm = kb('confirm');
  const done = kb('done');
  const error = kb('error');
  const noPhone = kb('new', { ...lead, phone: null });
  const ok = same(fresh, [[{ text: 'Mark contacted', callback_data: `C:3:${uuid}`, style: 'primary' }], BACK])
    && same(contacted, [[{ text: 'Job completed', callback_data: `D:3:${uuid}`, style: 'primary' }], BACK])
    && same(confirm, [[
      { text: 'Send request', callback_data: `Y:3:${uuid}`, style: 'success' },
      { text: 'Cancel', callback_data: `N:3:${uuid}`, style: 'danger' },
    ], BACK])
    && kb('confirm', { ...lead, email: null })[0][0].text === 'Mark done'
    && same(done, [BACK])
    && same(error, [[{ text: 'Try again', callback_data: `R:3:${uuid}`, style: 'primary' }], BACK])
    && same(noPhone, fresh)
    && same(kb('new', null), fresh)
    && ![fresh, contacted, confirm, done, error, noPhone].some((rows) => /copy_text|Copy/.test(JSON.stringify(rows)))
    // The phone the button used to copy is still in the detail text.
    && C2.renderAlert({ business: { name: 'B', timezone: 'America/Chicago' }, lead: { ...lead, status: 'open', zip: '50265' }, view: 'new' }).includes('+15155550100');
  line(ok, 'T18', 'detail keyboard: alert actions + styles, then plain Back; no copy',
    `kinds=new/contacted/confirm/done/error back=${JSON.stringify(done)}`);
}

/* T19: the button icon seam, and no emoji on any button. The seam is kept for
   the future (custom emoji) but returns NO icon today: every name answers
   null and every label comes back unchanged. That the seam still works is
   proved with an injected table, never with a shipped icon. Every button
   label the builders can emit is checked for emoji. (Before: back was a left
   arrow emoji and copy a clipboard emoji.) */
{
  const C2 = await import('../lib/content.js');
  const uuid = '550e8400-e29b-41d4-a716-446655440000';
  const lead = { id: uuid, name: 'A', service: 'repair', phone: '5155550100', email: 'd@example.com', created_at: new Date().toISOString() };
  const five = [lead, lead, lead, lead, lead];
  const inline = [
    C2.leadListKeyboard(five, 1, true), C2.removeLeadKeyboard(five, 1, true),
    C2.removeLeadConfirmKeyboard(uuid, 0), C2.removeLeadConfirmKeyboard(uuid),
    C2.alertKeyboard(uuid), C2.jobDoneKeyboard(uuid), C2.tryAgainKeyboard(uuid),
    C2.confirmKeyboard(uuid, true), C2.confirmKeyboard(uuid, false),
    C2.recipientsKeyboard([{ id: uuid, label: null }, { id: uuid, label: null }], {}), C2.recipientConfirmKeyboard(uuid),
    C2.operatorBusinessListKeyboard(five, 1, true), C2.operatorBusinessDetailKeyboard(uuid, 1),
    C2.operatorBusinessDetailKeyboard(uuid, 1, { suspended: true }),
    C2.operatorSuspendConfirmKeyboard(uuid, 1), C2.operatorBackToBusinessKeyboard(uuid, 1),
    C2.operatorInviteListKeyboard(five, 1, true), C2.operatorBackToInviteListKeyboard(1),
    C2.operatorLeadListKeyboard({ businessId: uuid, leads: five, leadPage: 1, page: 1, hasOlder: true }),
    C2.operatorLeadDetailKeyboard({ businessId: uuid, leadPage: 1, page: 1 }),
    ...['new', 'contacted', 'confirm', 'done', 'error'].map((k) => C2.leadDetailKeyboard(k, uuid, 0, lead)),
  ].flatMap((kb) => (kb.reply_markup || kb).inline_keyboard.flat());
  const reply = [C2.OWNER_KEYBOARD_LABELS, C2.STAFF_KEYBOARD_LABELS, C2.OPERATOR_KEYBOARD_LABELS]
    .flatMap((l) => C2.persistentKeyboard(l).keyboard.flat());
  const labels = [...inline, ...reply].map((b) => String(b.text)).concat([C2.BOT_INVITE_CANCEL_BUTTON]);
  const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE0F}\u{200D}\u{2190}-\u{21FF}]/u;
  const withEmoji = labels.filter((t) => EMOJI.test(t));
  const all = JSON.stringify([inline, reply]);
  const injected = { back: '\u2B05\uFE0F' };
  const ok = Object.keys(C2.BUTTON_ICONS).length === 0 && Object.isFrozen(C2.BUTTON_ICONS)
    && C2.buttonIcon('back') === null && C2.buttonIcon('copy') === null
    && C2.buttonIcon('unknown') === null && C2.buttonIcon('') === null
    && C2.buttonIcon('toString') === null && C2.buttonIcon('constructor') === null
    && C2.iconLabel('back', 'Back') === 'Back'
    && C2.iconLabel('copy', 'Copy phone') === 'Copy phone'
    && C2.iconLabel('unknown', 'Back') === 'Back'
    && C2.iconLabel('back') === ''
    // The seam itself: with a table that has an icon, it is used.
    && C2.buttonIcon('back', injected) === injected.back
    && C2.iconLabel('back', 'Back', injected) === `${injected.back} Back`
    && C2.iconLabel('other', 'Back', injected) === 'Back'
    && EMOJI.test(C2.iconLabel('back', 'Back', injected))
    && labels.length > 40 && withEmoji.length === 0
    && !all.includes('icon_custom_emoji_id');
  line(ok, 'T19', 'icon seam kept, returns no icon; no emoji on any button',
    `icons=${Object.keys(C2.BUTTON_ICONS).length} labels=${labels.length} emoji=${withEmoji.join(',') || 'none'} custom=${all.includes('icon_custom_emoji_id')}`);
}

/* T20: the actual setMyCommands scopes. The script is spawned against a
   loopback fake, so what is asserted is what Telegram would receive: the owner
   commands in the DEFAULT scope, the operator commands in the operator CHAT
   scope — and nothing else gets a menu. The fake keeps what was set per scope
   and answers getMyCommands with it, so "info" after "set" reads the same
   lists back. (The spawn is async, not spawnSync: a synchronous wait would
   freeze this process and the fake with it.) */
{
  const requests = [];
  const menus = new Map();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const entry = { path: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') };
    requests.push(entry);
    const scopeKey = JSON.stringify(entry.body.scope || null);
    let result = [];
    if (entry.path.endsWith('/setMyCommands')) { menus.set(scopeKey, entry.body.commands); result = true; }
    if (entry.path.endsWith('/getMyCommands')) result = menus.get(scopeKey) || [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const opChat = '5150000000000123';
  const token = 'test-token';
  const runScript = (mode) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/tg-commands.mjs', mode], {
      env: {
        ...process.env,
        VERCEL_ENV: 'development',
        TELEGRAM_API_BASE: base,
        TELEGRAM_BOT_TOKEN: token,
        OPERATOR_CHAT_ID: opChat,
        TELEGRAM_CHAT_ID: '',
      },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ status: code == null ? -1 : code, out }); });
  });
  let set = { status: null, out: '' };
  let info = { status: null, out: '' };
  let stale = { status: null, out: '' };
  try {
    set = await runScript('set');
    info = await runScript('info');
    // What the live bot had: the operator chat still listing /code and /phones.
    menus.set(JSON.stringify({ type: 'chat', chat_id: Number(opChat) }), [{ command: 'businesses', description: 'x' },
      { command: 'code', description: 'x' }, { command: 'phones', description: 'x' }, { command: 'help', description: 'x' }]);
    stale = await runScript('info');
  } finally {
    server.close();
  }
  const { COMMANDS, OPERATOR_COMMANDS, menuLine, operatorScope, operatorSkippedLines } = await import('../scripts/tg-commands.mjs');
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const calls = requests.filter((x) => x.path.endsWith('/setMyCommands'));
  const defaultScope = calls.find((x) => !('scope' in x.body));
  const chatScope = calls.find((x) => x.body.scope && x.body.scope.type === 'chat');
  const otherScopes = calls.filter((x) => x.body.scope && x.body.scope.type !== 'chat');
  // The two lists, exactly: names, order and descriptions.
  const WANT_DEFAULT = [
    { command: 'leads', description: 'Your latest requests' },
    { command: 'invite', description: 'Connect another phone' },
    { command: 'recipients', description: 'Who receives alerts' },
    { command: 'remove_lead', description: 'Remove a request' },
    { command: 'help', description: 'How this works' },
  ];
  const WANT_OPERATOR = [
    { command: 'businesses', description: 'Businesses: phones, leads, suspend' },
    { command: 'invite', description: 'Invite or replace a phone' },
    { command: 'help', description: 'Operator commands' },
    { command: 'id', description: "This chat's ID" },
  ];
  const DEFAULT_LINE = '/leads, /invite, /recipients, /remove_lead, /help';
  const OPERATOR_LINE = '/businesses, /invite, /help, /id';
  const listsOk = same(COMMANDS, WANT_DEFAULT) && same(OPERATOR_COMMANDS, WANT_OPERATOR)
    && new Set(OPERATOR_COMMANDS.map((c) => c.command)).size === 4
    // No /code, no /phones, no /recipients, and /operator is an unlisted alias.
    && !OPERATOR_COMMANDS.some((c) => ['code', 'phones', 'recipients', 'operator', 'leads', 'remove_lead'].includes(c.command))
    && !OPERATOR_COMMANDS.some((c) => /request|terminate|phones list/i.test(c.description))
    && [...COMMANDS, ...OPERATOR_COMMANDS].every((c) => /^[a-z0-9_]{1,32}$/.test(c.command) && c.description.length >= 3 && c.description.length <= 40)
    && menuLine(COMMANDS) === DEFAULT_LINE && menuLine(OPERATOR_COMMANDS) === OPERATOR_LINE && menuLine([]) === '(empty)';
  // What Telegram received is those lists, in that order, in those scopes.
  const sentOk = set.status === 0 && calls.length === 2
    && !!defaultScope && same(defaultScope.body.commands, WANT_DEFAULT)
    && !!chatScope && same(chatScope.body.commands, WANT_OPERATOR)
    && same(chatScope.body.scope, { type: 'chat', chat_id: Number(opChat) })
    && otherScopes.length === 0
    && requests.some((x) => x.path.endsWith('/setMyDescription'))
    && requests.some((x) => x.path.endsWith('/setMyShortDescription'));
  // What the script prints: both menus as plain text, and never the chat id
  // or the token.
  const quiet = [set, info, stale].every((x) => !x.out.includes(opChat) && !x.out.includes(token) && !/https?:/.test(x.out));
  const printOk = set.out.includes('default menu (every private chat): ' + DEFAULT_LINE)
    && set.out.includes('operator menu (operator chat only): ' + OPERATOR_LINE)
    && info.status === 0 && info.out.includes('default menu (every private chat): ' + DEFAULT_LINE)
    && info.out.includes('operator menu (operator chat only): ' + OPERATOR_LINE) && info.out.includes('operator menu is up to date')
    && stale.status === 0 && stale.out.includes('operator menu (operator chat only): /businesses, /code, /phones, /help')
    && stale.out.includes('OPERATOR MENU IS OUT OF DATE: run npm run tg:commands (expected ' + OPERATOR_LINE + ')')
    && !stale.out.includes('up to date');
  // Without a usable OPERATOR_CHAT_ID there is no chat to address: the script
  // says, in capitals, that the operator chat keeps its old menu.
  const skipped = operatorSkippedLines('OPERATOR_CHAT_ID is not set');
  const scopeOk = same(operatorScope({ OPERATOR_CHAT_ID: ' 42 ' }), { scope: { type: 'chat', chat_id: 42 } })
    && same(operatorScope({}), { reason: 'OPERATOR_CHAT_ID is not set' })
    && same(operatorScope({ OPERATOR_CHAT_ID: '' }), { reason: 'OPERATOR_CHAT_ID is not set' })
    && same(operatorScope({ OPERATOR_CHAT_ID: '@someone' }), { reason: 'OPERATOR_CHAT_ID is not a numeric chat id' })
    && skipped[0] === 'OPERATOR MENU NOT UPDATED: OPERATOR_CHAT_ID is not set.' && skipped.length === 3
    && /keeps the menu it had before/.test(skipped[1]);
  line(listsOk && sentOk && printOk && quiet && scopeOk, 'T20', 'command menus: exact lists and order, per scope, printed',
    `exit=${set.status}/${info.status}/${stale.status} calls=${calls.length} scopes=${calls.map((x) => (x.body.scope && x.body.scope.type) || 'default').join(',')} lists=${listsOk} sent=${sentOk} print=${printOk} quiet=${quiet} scope=${scopeOk}`);
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
