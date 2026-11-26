#!/usr/bin/env node
// tests/design-tokens.test.mjs — Gate DT.
// HARNESS: reads design-tokens.json, its generated consumers and every file that
// can paint a box. No network, no database.
//
// What it proves:
//   DT1  the token file is the only place a numeric px radius is written
//   DT2  the generated CSS/JSON carry the same numbers as the token file
//   DT3  site, modal, API page, review page and email templates read a token

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const T = JSON.parse(read('design-tokens.json'));
const GEN = JSON.parse(read('lib/design-tokens.generated.json'));
const CSS = read('assets/css/tokens.generated.css');

let total = 0;
let failed = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(52)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};

{
  const same = JSON.stringify(T) === JSON.stringify(GEN);
  const cssOk = [`--box-radius: ${T.radius.box}`, `--radius-image: ${T.radius.image}`,
    `--radius-section: ${T.radius.section}`, `--radius-arrow: ${T.radius.arrowSquare}`]
    .every((s) => CSS.includes(s));
  line(same && cssOk, 'DT2', 'generated CSS and email JSON match the token file',
    `json=${same} css=${cssOk}`);
}

{
  const files = [
    'assets/css/styles.css', 'index.html', 'lib/email-layout.js', 'lib/content.js',
    'api/lead.js', 'lib/owner-mail-failure.js',
  ];
  const numeric = /border-radius:\s*\d+px/i;
  const offenders = files.filter((f) => numeric.test(read(f)));
  const tokenHas = /"box":\s*"12px"/.test(read('design-tokens.json'));
  line(offenders.length === 0 && tokenHas, 'DT1', 'no hardcoded px radius outside the token file',
    `offenders=${offenders.join(',') || 'none'} default=${T.radius.box}`);
}

{
  const css = read('assets/css/styles.css');
  const html = read('index.html');
  const api = read('api/lead.js');
  const mail = read('lib/email-layout.js');
  const content = read('lib/content.js');
  const ok = css.includes('@import url(\'./tokens.generated.css\')')
    && css.includes('var(--box-radius)')
    && html.includes('var(--radius-nojs')
    && api.includes('TOKENS.radius.apiCard')
    && mail.includes('TOKENS.radius.email') && /R\.card/.test(mail)
    && content.includes('TOKENS.radius.reviewCard');
  line(ok, 'DT3', 'site, modal, API, review and email all read a token', `ok=${ok}`);
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
