// DB-free. The ONE phone rule, shared by the browser modal and api/lead.js.
// Run: TEST_ENV=1 node tests/run.mjs tests/phone.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from '../lib/phone.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
function line(ok, id, what, detail = '') {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(6)} ${what}${detail ? '  ' + detail : ''}`);
}

const US = P.phoneConfig(null, '1');

/* PH1: every shape the owner listed is accepted and stored as ONE value. */
{
  const forms = [
    '(555) 123-4567', '555-123-4567', '555.123.4567', '5551234567',
    '555 123 4567', '+1 555 123 4567', '+1 (555) 123-4567', '1-555-123-4567',
    '  (555) 123-4567  ', ' 5551234567 ', '٥٥٥١٢٣٤٥٦٧', '+١ ٥٥٥ ١٢٣ ٤٥٦٧',
  ];
  const bad = [];
  for (const raw of forms) {
    const n = P.normalizePhone(raw, US);
    if (!n.ok || n.value !== '+15551234567') bad.push(`${JSON.stringify(raw)} -> ${JSON.stringify(n)}`);
  }
  line(bad.length === 0, 'PH1', 'all listed US shapes -> one E.164 value',
    bad.length ? bad.join(' ; ') : `${forms.length} forms -> +15551234567`);
}

/* PH2: the same forms survive typing and pasting through the shared sanitizer. */
{
  const bad = [];
  for (const raw of ['(555) 123-4567', '+1 (555) 123-4567', '٥٥٥١٢٣٤٥٦٧']) {
    let typed = '';
    for (const ch of raw) typed = P.sanitizePhone(typed + ch, US);
    const pasted = P.sanitizePhone(raw, US);
    const n1 = P.normalizePhone(typed, US), n2 = P.normalizePhone(pasted, US);
    if (!n1.ok || !n2.ok || n1.value !== n2.value || n1.value !== '+15551234567' && /555/.test(raw)) {
      bad.push(`${JSON.stringify(raw)} typed=${JSON.stringify(typed)} pasted=${JSON.stringify(pasted)}`);
    }
  }
  line(bad.length === 0, 'PH2', 'typing and paste use the same sanitizer', bad.join(' ; '));
}

/* PH3: the stated refusals, each with a reason the form can show. */
{
  const cases = [
    ['', 'empty'], ['   ', 'empty'], ['555123456', 'too-short'],
    ['555123456789', 'too-long'], ['123456789012', 'too-long'],
    ['(055) 123-4567', 'area-code'], ['(155) 123-4567', 'area-code'],
    ['555-12a-4567', 'letters'], ['abc', 'letters'], ['5551234567x12', 'letters'],
    ['+1 (055) 123-4567', 'area-code'],
  ];
  const bad = [];
  for (const [raw, reason] of cases) {
    const n = P.normalizePhone(raw, US);
    if (n.ok || n.reason !== reason || n.value !== null) bad.push(`${JSON.stringify(raw)} -> ${JSON.stringify(n)} want ${reason}`);
  }
  line(bad.length === 0, 'PH3', 'short/long/letters/area-code/empty refused', bad.join(' ; '));
}

/* PH4: Arabic-Indic and Persian digits are ASCII before counting or storing. */
{
  const ok = P.ascii('٠١٢٣٤٥٦٧٨٩') === '0123456789' && P.ascii('۰۱۲۳۴۵۶۷۸۹') === '0123456789'
    && P.normalizePhone('٠٥٥-١٢٣-٤٥٦٧', US).reason === 'area-code';
  line(ok, 'PH4', 'Arabic-Indic/Person digits converted before validation');
}

/* PH5: non-NANP numbers still go through the caller's strict validator, so
   the existing international coverage (+44, +20, Italy's leading zero) stays. */
{
  const strict = (v) => {
    const d = v.replace(/\D/g, '');
    if (/^44(?:0)?7911123456$/.test(d)) return '+447911123456';
    if (d.startsWith('390612345678')) return '+390612345678';
    return null;
  };
  const cfg = P.phoneConfig(null, '1');
  const a = P.normalizePhone('+44 (0)7911 123456', cfg, strict);
  const b = P.normalizePhone('+39 06 1234 5678', cfg, strict);
  const c = P.normalizePhone('+44 7911 123', cfg, strict);
  line(a.ok && a.value === '+447911123456' && b.ok && b.value === '+390612345678' && !c.ok,
    'PH5', 'non-NANP delegates to strict validator', `${a.value} ${b.value} ${c.reason}`);
}

/* PH6: browser copy is generated from this file, so the two can never drift. */
{
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'phone.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const a = src.indexOf('/*__PHONE_RULE_START__*/'), b = src.indexOf('/*__PHONE_RULE_END__*/');
  const ha = html.indexOf('/*__PHONE_RULE_START__*/'), hb = html.indexOf('/*__PHONE_RULE_END__*/');
  const canonical = src.slice(a + '/*__PHONE_RULE_START__*/'.length, b).replace(/^export /gm, '').trim();
  const inline = ha >= 0 && hb > ha ? html.slice(ha + '/*__PHONE_RULE_START__*/'.length, hb).trim() : '';
  line(a >= 0 && b > a && inline === canonical, 'PH6',
    'inline browser rule is byte-identical to the shared source',
    `src=${a >= 0 && b > a} inline=${inline.length} canonical=${canonical.length}`);
}

console.log(`\nPHone ${pass}/${pass + fail} PASS${fail ? ` — ${fail} FAILED` : ''}`);
if (fail) process.exitCode = 1;
