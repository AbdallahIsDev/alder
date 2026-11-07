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

/* T2 */
{
  const code = 'K7M2QPX9RT4W';
  const text = C.botInviteText(code, { username: 'alder_alerts_bot' });
  const link = `https://t.me/alder_alerts_bot?start=${code}`;
  const occurrences = text.split(code).length - 1;
  const ok = text.includes(link)
    && !text.includes('\\')
    && !text.includes('//n')
    && occurrences === 2
    && /expires in 24 hours/.test(text)
    && text.split('\n').length === 4;
  line(ok, 'T2', 'invite: deep link, code twice, expiry, real line breaks',
    `link=${text.includes(link)} count=${occurrences} lines=${text.split('\n').length} expiry=${/expires in 24 hours/.test(text)}`);
}

/* T3 */
{
  const text = C.botInviteText('K7M2QPX9RT4W');
  const ok = text.includes('/start K7M2QPX9RT4W')
    && !text.includes('\\')
    && !text.includes('t.me')
    && text.split('\n').length === 4
    && /expires in 24 hours/.test(text);
  line(ok, 'T3', 'invite fallback: /start plus code, real line breaks',
    `lines=${text.split('\n').length}`);
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

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
