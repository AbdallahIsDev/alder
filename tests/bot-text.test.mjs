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
import { spawnSync } from 'node:child_process';
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

/* T9: buttons stay short for narrow phones, and the obvious is not spelled out. */
{
  const C = await import('../lib/content.js');
  const buttons = [
    C.BOT_INVITE_CANCEL_BUTTON,
    ...C.recipientsKeyboard([{ id: 'a', label: null }], {}).inline_keyboard.flat().map((b) => b.text),
    ...C.operatorPhonesKeyboard([{ id: 'a', label: null }]).reply_markup.inline_keyboard.flat().map((b) => b.text),
    ...C.leadListKeyboard([{ id: 'x' }], 0, true).reply_markup.inline_keyboard.flat().map((b) => b.text),
  ];
  const long = buttons.filter((t) => t.length > 20);
  const copy = [C.OPERATOR_USAGE_PHONES, C.OPERATOR_USAGE_CODE, C.OPERATOR_HELP, C.BOT_INVITE_CANCEL_BUTTON,
    C.botRecipientsText([{ id: 'a', label: null }]), C.botInvitePendingText({ hours: [5] })].join('\n');
  const banned = /with a Remove button each|Tap Remove to disconnect|The main phone is the one connected first|Cancel them to make a new one/i;
  line(long.length === 0 && !banned.test(copy), 'T9', 'buttons <= 20 chars, no obvious copy',
    `buttons=${buttons.length} long=${long.join(',') || 'none'}`);
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

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
