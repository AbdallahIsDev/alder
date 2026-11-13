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
   Row buttons in the /leads browser are the exception: they carry
   "name · service · age" on a full-width row of their own, so they get their
   own cap (40, enforced by leadRowLabel) instead of 20. Before the browser,
   list rows were number buttons sharing one row and the cap was 20 for
   everything; the split is the recorded change. */
{
  const C = await import('../lib/content.js');
  const lead = { id: 'x', name: 'Daniel Whitaker', service: 'repair', created_at: new Date().toISOString() };
  const rows = C.leadListKeyboard([lead, lead], 0, true).reply_markup.inline_keyboard.flat()
    .filter((b) => b.callback_data && b.callback_data.startsWith('L:'));
  const navAndActions = [
    C.BOT_INVITE_CANCEL_BUTTON,
    ...C.recipientsKeyboard([{ id: 'a', label: null }], {}).inline_keyboard.flat().map((b) => b.text),
    ...C.operatorPhonesKeyboard([{ id: 'a', label: null }]).reply_markup.inline_keyboard.flat().map((b) => b.text),
    ...C.leadListKeyboard([lead], 0, true).reply_markup.inline_keyboard[1].map((b) => b.text),
    'Mark contacted', 'Job completed', 'Send request', 'Cancel', 'Try again',
    ...C.leadDetailKeyboard('contacted', 'x', 0, lead).reply_markup.inline_keyboard.flat().map((b) => b.text),
  ];
  const longActions = navAndActions.filter((t) => t.length > 20);
  const longRows = rows.filter((b) => b.text.length > 40);
  const copy = [C.OPERATOR_USAGE_PHONES, C.OPERATOR_USAGE_CODE, C.OPERATOR_HELP, C.BOT_INVITE_CANCEL_BUTTON,
    C.botRecipientsText([{ id: 'a', label: null }]), C.botInvitePendingText({ hours: [5] })].join('\n');
  const banned = /with a Remove button each|Tap Remove to disconnect|The main phone is the one connected first|Cancel them to make a new one/i;
  line(longActions.length === 0 && longRows.length === 0 && !banned.test(copy),
    'T9', 'action buttons <= 20 chars, browser rows <= 40', 
    `actions=${navAndActions.length} rows=${rows.length} long=${longActions.concat(longRows.map((b) => b.text)).join(',') || 'none'}`);
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

/* T14: the persistent reply keyboard. KeyboardButton text only, persistent and
   resized, one fixed set per role, and every label maps back onto a command —
   the permission checks live in the handlers, never in the keyboard. */
{
  const owner = C.persistentKeyboard(C.OWNER_KEYBOARD_LABELS);
  const staff = C.persistentKeyboard(C.STAFF_KEYBOARD_LABELS);
  const op = C.persistentKeyboard(C.OPERATOR_KEYBOARD_LABELS);
  const btnKeys = (kb) => kb.keyboard.flat().map((b) => Object.keys(b).sort().join(','));
  const shapeOk = [owner, staff, op].every((kb) =>
    kb.is_persistent === true && kb.resize_keyboard === true
    && Array.isArray(kb.keyboard) && kb.keyboard.every((row) => row.length === 1)
    && btnKeys(kb).every((k) => k === 'text'));
  const setsOk = JSON.stringify(C.OWNER_KEYBOARD_LABELS) === JSON.stringify(['Leads', 'Invite', 'Recipients', 'Help'])
    && JSON.stringify(C.STAFF_KEYBOARD_LABELS) === JSON.stringify(['Leads', 'Help'])
    && JSON.stringify(C.OPERATOR_KEYBOARD_LABELS) === JSON.stringify(['Businesses', 'Code', 'Phones', 'Operator']);
  const labels = [...C.OWNER_KEYBOARD_LABELS, ...C.STAFF_KEYBOARD_LABELS, ...C.OPERATOR_KEYBOARD_LABELS];
  const mapped = labels.map((l) => C.KEYBOARD_LABELS[l]);
  const mapOk = Object.keys(C.KEYBOARD_LABELS).length === new Set(labels).size
    && mapped.every((cmd) => typeof cmd === 'string' && /^\/[a-z_]+$/.test(cmd))
    && mapped.every((cmd) => cmd.length <= 32);
  line(shapeOk && setsOk && mapOk, 'T14', 'persistent keyboard: text-only buttons, one set per role',
    `shape=${shapeOk} sets=${setsOk} map=${mapOk} labels=${labels.length}`);
}

/* T15: the /leads browser row label: name · service · age, shortened to fit,
   and never a contact detail. The message text stays the source of truth. */
{
  const lead = { name: 'Daniel Whitaker', service: 'repair', created_at: new Date(Date.now() - 5 * 60000).toISOString(), phone: '5155550100', email: 'd@example.com' };
  const label = C.leadRowLabel(lead);
  const long = C.leadRowLabel({ ...lead, name: 'Maximilian Constantine Vanderberg-Roofington III', service: 'replacement' });
  const parts = label.split(' · ');
  const ok = parts.length === 3
    && parts[0] === 'Daniel Whitaker' && parts[1] === 'Repair' && parts[2] === '5m ago'
    && !label.includes('5155550100') && !label.includes('@')
    && label.length <= 40
    && long.length <= 40 && long.includes('…') && long.startsWith('Maximilian')
    && long.endsWith('5m ago') && long.includes('Roof replacement')
    && !long.includes('Vanderberg');
  line(ok, 'T15', 'row label: name · service · age, <= 40, no contact details',
    `label=${JSON.stringify(label)} long=${JSON.stringify(long)}`);
}

/* T16: Newer/Older both ends are always rendered; the unavailable end is
   disabled and points at the page it is already on, so a client that ignores
   `disabled` asks for a harmless no-op refresh. */
{
  const lead = { id: 'x', name: 'A', service: 'repair', created_at: new Date().toISOString() };
  const first = C.leadListKeyboard([lead], 0, true).reply_markup.inline_keyboard[1];
  const mid = C.leadListKeyboard([lead], 1, true).reply_markup.inline_keyboard[1];
  const last = C.leadListKeyboard([lead], 2, false).reply_markup.inline_keyboard[1];
  const rmFirst = C.removeLeadKeyboard([lead], 0, true).reply_markup.inline_keyboard[1];
  const ok = first[0].text === 'Newer' && first[0].disabled === true && first[0].callback_data === 'l:0'
    && first[1].text === 'Older' && !('disabled' in first[1]) && first[1].callback_data === 'l:1'
    && mid.every((b) => !('disabled' in b)) && mid[0].callback_data === 'l:0' && mid[1].callback_data === 'l:2'
    && last[0].callback_data === 'l:1' && last[1].disabled === true && last[1].callback_data === 'l:2'
    && rmFirst[0].disabled === true && rmFirst[0].callback_data === 'rm:0' && rmFirst[1].callback_data === 'rm:1';
  line(ok, 'T16', 'nav ends always present; unavailable end disabled, same-page callback',
    `first=${first.map((b) => b.text + (b.disabled ? '(off)' : '')).join('/')} last=${last.map((b) => b.text + (b.disabled ? '(off)' : '')).join('/')}`);
}

/* T17: Telegram caps callback_data at 1-64 bytes. Every keyboard builder is
   exercised with the worst case (three-digit page, real uuid) and every
   emitted callback must fit; copy_text must be 1-256 characters and never
   share a button with callback_data. */
{
  const C2 = await import('../lib/content.js');
  const uuid = '550e8400-e29b-41d4-a716-446655440000';
  const lead = { id: uuid, name: 'Daniel Whitaker', service: 'repair', phone: '5155550100', email: 'd@example.com', created_at: new Date().toISOString() };
  const keyboards = [
    C2.leadListKeyboard([lead, lead, lead, lead, lead], 999, true, true),
    C2.removeLeadKeyboard([lead, lead, lead, lead, lead], 999, true, true),
    C2.removeLeadConfirmKeyboard(uuid, 999),
    C2.removeLeadConfirmKeyboard(uuid),
    C2.alertKeyboard(uuid), C2.jobDoneKeyboard(uuid), C2.tryAgainKeyboard(uuid), C2.confirmKeyboard(uuid, true),
    C2.recipientsKeyboard([{ id: uuid, label: null }], {}),
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
  const both = buttons.filter((b) => b.callback_data && b.copy_text);
  const copies = buttons.filter((b) => b.copy_text).map((b) => b.copy_text.text);
  const badCopy = copies.filter((t) => typeof t !== 'string' || t.length < 1 || t.length > 256);
  const longest = cbs.reduce((a, b) => (Buffer.byteLength(b) > Buffer.byteLength(a) ? b : a), '');
  line(cbs.length > 20 && tooLong.length === 0 && empty.length === 0 && shaped.length === 0
    && both.length === 0 && badCopy.length === 0,
    'T17', 'every callback_data <= 64 bytes; copy_text 1-256, never both',
    `callbacks=${cbs.length} longest=${longest} (${Buffer.byteLength(longest)}B) copies=${copies.length}`);
}

/* T18: the lead detail keyboard — the browser's card. Same actions and styles
   as the alert, plus Back to the page it came from, plus the detail-only
   copy_text phone button (never in a list view). */
{
  const C2 = await import('../lib/content.js');
  const uuid = '550e8400-e29b-41d4-a716-446655440000';
  const lead = { id: uuid, name: 'A', service: 'repair', phone: '5155550100', email: 'd@example.com', created_at: new Date().toISOString() };
  const kb = (kind, l = lead) => C2.leadDetailKeyboard(kind, uuid, 3, l).reply_markup.inline_keyboard;
  const copyOf = (rows) => rows.flat().find((b) => b.copy_text);
  const backOf = (rows) => rows.flat().find((b) => b.callback_data === 'l:3');
  const fresh = kb('new');
  const contacted = kb('contacted');
  const confirm = kb('confirm');
  const done = kb('done');
  const error = kb('error');
  const noPhone = kb('new', { ...lead, phone: null });
  const ok = fresh[0][0].text === 'Mark contacted' && fresh[0][0].callback_data === `C:3:${uuid}` && fresh[0][0].style === 'primary'
    && contacted[0][0].text === 'Job completed' && contacted[0][0].callback_data === `D:3:${uuid}` && contacted[0][0].style === 'primary'
    && confirm[0][0].text === 'Send request' && confirm[0][0].callback_data === `Y:3:${uuid}` && confirm[0][0].style === 'success'
    && confirm[0][1].text === 'Cancel' && confirm[0][1].callback_data === `N:3:${uuid}` && confirm[0][1].style === 'danger'
    && kb('confirm', { ...lead, email: null })[0][0].text === 'Mark done'
    && done.length === 1
    && error[0][0].text === 'Try again' && error[0][0].callback_data === `R:3:${uuid}` && error[0][0].style === 'primary'
    && [fresh, contacted, confirm, done, error].every((rows) => {
      const c = copyOf(rows);
      return c && c.copy_text.text === '+15155550100' && !c.callback_data;
    })
    && [fresh, contacted, confirm, done, error].every((rows) => backOf(rows) && !backOf(rows).copy_text)
    && noPhone.flat().every((b) => !b.copy_text) && backOf(noPhone)
    && !JSON.stringify(C2.leadListKeyboard([lead], 0, true)).includes('copy_text')
    && !JSON.stringify(C2.removeLeadKeyboard([lead], 0, true)).includes('copy_text');
  line(ok, 'T18', 'detail keyboard: alert actions + styles + Back + phone copy_text',
    `kinds=new/contacted/confirm/done/error phoneless=${noPhone.flat().length}`);
}

/* T19: the button icon seam. Plain Unicode emoji today; the custom-emoji
   extension point must stay a comment, not a field. */
{
  const C2 = await import('../lib/content.js');
  const uuid = '550e8400-e29b-41d4-a716-446655440000';
  const lead = { id: uuid, name: 'A', service: 'repair', phone: '5155550100', created_at: new Date().toISOString() };
  const all = JSON.stringify({
    list: C2.leadListKeyboard([lead], 0, true),
    remove: C2.removeLeadKeyboard([lead], 0, true),
    detail: C2.leadDetailKeyboard('new', uuid, 0, lead),
    confirm: C2.removeLeadConfirmKeyboard(uuid, 0),
    owner: C2.persistentKeyboard(C2.OWNER_KEYBOARD_LABELS),
  });
  const ok = C2.buttonIcon('back') === '⬅️' && C2.buttonIcon('copy') === '📋'
    && C2.buttonIcon('unknown') === null && C2.buttonIcon('') === null
    && C2.iconLabel('back', 'Back') === '⬅️ Back'
    && C2.iconLabel('unknown', 'Back') === 'Back'
    && C2.iconLabel('back') === ''
    && !all.includes('icon_custom_emoji_id');
  line(ok, 'T19', 'icon seam: Unicode emoji only, no custom emoji field',
    `icons=${Object.keys(C2.BUTTON_ICONS).join(',')} custom=${all.includes('icon_custom_emoji_id')}`);
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
