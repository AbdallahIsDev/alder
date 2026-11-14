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

/* T6: /code's two messages are disjoint. The operator line names the slug and
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
  line(ok, 'T6', '/code: operator line names the slug, client message never does',
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
  const numbers = [...listKb[0], ...removeKb[0]];
  const navAndActions = [
    C.BOT_INVITE_CANCEL_BUTTON,
    ...C.recipientsKeyboard([{ id: 'a', label: null }], {}).inline_keyboard.flat().map((b) => b.text),
    ...C.recipientConfirmKeyboard('a').inline_keyboard.flat().map((b) => b.text),
    ...C.operatorPhonesKeyboard([{ id: 'a', label: null }]).reply_markup.inline_keyboard.flat().map((b) => b.text),
    ...C.operatorConfirmRemoveKeyboard('a').reply_markup.inline_keyboard.flat().map((b) => b.text),
    ...C.operatorPickerKeyboard([{ id: 'a', name: 'A Very Long Business Name Roofing & Exteriors', slug: 's' }], 'pb').reply_markup.inline_keyboard.flat().map((b) => b.text),
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
  const copy = [C.OPERATOR_USAGE_PHONES, C.OPERATOR_USAGE_CODE, C.OPERATOR_HELP, C.BOT_INVITE_CANCEL_BUTTON,
    C.botRecipientsText([{ id: 'a', label: null }]), C.botInvitePendingText({ hours: [5] })].join('\n');
  const banned = /with a Remove button each|Tap Remove to disconnect|The main phone is the one connected first|Cancel them to make a new one/i;
  line(longActions.length === 0 && numbers.length === 10 && badNumbers.length === 0 && !banned.test(copy),
    'T9', 'every button <= 20 chars; list buttons are one digit',
    `buttons=${navAndActions.length} numbers=${numbers.map((b) => b.text).join('')} long=${longActions.join(',') || 'none'}`);
}

/* T10: destructive confirms say what happens, and only they carry danger. */
{
  const C = await import('../lib/content.js');
  const one = C.recipientConfirmText({ id: 'a', label: null }, 0, { isLast: false });
  const last = C.recipientConfirmText({ id: 'a', label: null }, 0, { isLast: true });
  const kb = C.recipientConfirmKeyboard('row-1').inline_keyboard[0];
  const opKb = C.operatorConfirmRemoveKeyboard('row-1').reply_markup.inline_keyboard[0];
  const danger = [kb[0], opKb[0]];
  const cancel = [kb[1], opKb[1]];
  const ok = !/Remove it\?/.test(one) && !/Remove it\?/.test(last)
    && one.includes('It will stop receiving alerts.')
    && last.includes('This is the last phone.')
    && danger.every((b) => b.style === 'danger')
    && cancel.every((b) => b.style === undefined)
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
    && same(op.keyboard, [[{ text: 'Code' }, { text: 'Businesses' }]]);
  const labels = [...C.OWNER_KEYBOARD_LABELS, ...C.STAFF_KEYBOARD_LABELS, ...C.OPERATOR_KEYBOARD_LABELS];
  const mapped = labels.map((l) => C.KEYBOARD_LABELS[l]);
  // The map is the current labels plus the four a phone may still be showing
  // from before the cut to two buttons — and nothing else.
  const legacy = Object.keys(C.LEGACY_KEYBOARD_LABELS);
  const mapOk = same(Object.keys(C.KEYBOARD_LABELS).sort(), [...new Set([...labels, ...legacy])].sort())
    && same(legacy.sort(), ['Help', 'Operator', 'Phones', 'Recipients'])
    && same(mapped, ['/invite', '/leads', '/leads', '/code', '/businesses'])
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
    C2.operatorPhonesKeyboard([{ id: uuid, label: null }]),
    C2.operatorPickerKeyboard([{ id: uuid, name: 'n', slug: 's' }], 'pb'),
    C2.operatorConfirmRemoveKeyboard(uuid),
    ...['new', 'contacted', 'confirm', 'done', 'error'].map((k) => C2.leadDetailKeyboard(k, uuid, 999, lead)),
    C2.leadDetailKeyboard('new', uuid, 999, { ...lead, phone: null }),
  ];
  const buttons = keyboards.flatMap((kb) => (kb.reply_markup || kb).inline_keyboard.flat());
  const cbs = buttons.filter((b) => b.callback_data).map((b) => b.callback_data);
  const tooLong = cbs.filter((d) => Buffer.byteLength(d, 'utf8') > 64);
  const empty = cbs.filter((d) => Buffer.byteLength(d, 'utf8') < 1);
  // Nothing a customer typed can ride along: a known one- or two-letter kind,
  // then only digits, colons and uuid hex.
  const shaped = cbs.filter((d) => !/^[A-Za-z]{1,2}:/.test(d) || !/^[0-9a-f:-]*$/.test(d.replace(/^[A-Za-z]{1,2}:/, '')));
  // Every page a button addresses must pass the anchored page regex (1-3 digits).
  const pages = cbs.map((d) => /^(?:l|rm):(\d+)$/.exec(d) || /^[LQCDYNRE]:(\d+):/.exec(d)).filter(Boolean).map((m) => m[1]);
  const badPages = pages.filter((n) => n.length > 3);
  const noAction = buttons.filter((b) => !b.callback_data);
  const copies = buttons.filter((b) => 'copy_text' in b);
  const longest = cbs.reduce((a, b) => (Buffer.byteLength(b) > Buffer.byteLength(a) ? b : a), '');
  line(cbs.length > 20 && tooLong.length === 0 && empty.length === 0 && shaped.length === 0
    && badPages.length === 0 && pages.length > 20
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
    C2.operatorPhonesKeyboard([{ id: uuid, label: null }]), C2.operatorConfirmRemoveKeyboard(uuid),
    C2.operatorPickerKeyboard([{ id: uuid, name: 'Alder Roofing', slug: 'alder-demo' }], 'pc'),
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
   scope — and nothing else gets a menu. (The spawn is async, not spawnSync: a
   synchronous wait would freeze this process and the fake with it.) */
{
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const entry = { path: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') };
    requests.push(entry);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: [] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const opChat = '5150000000000123';
  let status = null;
  try {
    status = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['scripts/tg-commands.mjs', 'set'], {
        env: {
          ...process.env,
          VERCEL_ENV: 'development',
          TELEGRAM_API_BASE: base,
          TELEGRAM_BOT_TOKEN: 'test-token',
          OPERATOR_CHAT_ID: opChat,
          TELEGRAM_CHAT_ID: '',
        },
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
      child.on('exit', (code) => { clearTimeout(timer); resolve(code == null ? -1 : code); });
    });
  } finally {
    server.close();
  }
  const { COMMANDS, OPERATOR_COMMANDS } = await import('../scripts/tg-commands.mjs');
  const calls = requests.filter((x) => x.path.endsWith('/setMyCommands'));
  const defaultScope = calls.find((x) => !('scope' in x.body));
  const chatScope = calls.find((x) => x.body.scope && x.body.scope.type === 'chat');
  const otherScopes = calls.filter((x) => x.body.scope && x.body.scope.type !== 'chat');
  const ok = status === 0 && calls.length === 2
    && !!defaultScope && JSON.stringify(defaultScope.body.commands) === JSON.stringify(COMMANDS)
    && !!chatScope && JSON.stringify(chatScope.body.commands) === JSON.stringify(OPERATOR_COMMANDS)
    && chatScope.body.scope.chat_id === Number(opChat)
    && otherScopes.length === 0
    && requests.some((x) => x.path.endsWith('/setMyDescription'))
    && requests.some((x) => x.path.endsWith('/setMyShortDescription'));
  line(ok, 'T20', 'setMyCommands: owner commands default scope, operator chat scope',
    `exit=${status} calls=${calls.length} scopes=${calls.map((x) => (x.body.scope && x.body.scope.type) || 'default').join(',')}`);
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
