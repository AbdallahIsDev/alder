#!/usr/bin/env node
// tests/prelaunch-consistency.test.mjs — Gate PL.
// HARNESS: source/document assertions, no network, no database.
//
// What it proves:
//   PL1  the runbook and legal drafts match the code's decisions
//   PL2  the local static server survives a bad URL and serves a directory index
//   PL3  a failed notice-audit read is logged as unavailable, not clean zeros

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let total = 0;
let failed = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(52)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};

{
  const ops = read('docs/OPERATIONS.md');
  const privacy = read('docs/legal-drafts/privacy-notice.md');
  const flags = [
    !ops.includes('Reactivate** and **Leads**, then **Extend 30 days**, then **Back**'),
    ops.includes('**Reactivate** (one tap) | suspended only'),
    !ops.includes('falling back to `TELEGRAM_CHAT_ID`'),
    !ops.includes('at most three times an hour'),
    /44 px[^.]*desktop[^.]*32 px[^.]*phones/.test(ops),
    /may be\s+deleted by hand/.test(privacy),
    /* the terminated page: the runbook, the privacy notice and the terms all
       describe the one sentence the page actually shows */
    ops.includes('/api/site-state') && ops.includes('This website is currently unavailable.'),
    privacy.includes('This website is currently') && privacy.includes('unavailable.'),
    !/your website form accepts no requests\. A visitor is told to call you/i.test(read('docs/legal-drafts/terms-of-service.md')),
    /* the form's resting look and the draft rules are described where the
       visitor's phone is described */
    // MEANING CHANGE 2026-11-28: the runbook now names the "24-hour draft
    // expiry" instead of saying a draft is "less than 24 hours old"; both are
    // the same policy, and this gate still requires the number to be there.
    /no-store/.test(ops) && /24[- ]hours?\s+(old|draft expiry)/.test(ops) && /focus-visible/.test(ops),
  ];
  const ok = flags.every(Boolean);
  line(ok, 'PL1', 'runbook and legal draft match the code', `flags=${flags.map(Number).join('')}`);
}

{
  const src = read('scripts/serve.mjs');
  const at = src.indexOf('const resolveInside');
  const block = src.slice(at, src.indexOf('const server', at));
  const guard = /try\s*\{[^}]*decodeURIComponent[\s\S]*\}\s*catch/.test(block);
  const handler = src.slice(src.indexOf('const server'));
  const targetFirst = /const target = [^\n]+\n[\s\S]{0,200}fsp\.stat\(target\)/.test(handler);
  line(guard && targetFirst, 'PL2', 'static server guards decode and stats the final target',
    `guard=${guard} targetFirst=${targetFirst}`);
}

{
  const src = read('api/selfcheck.js');
  const ok = /a\.ok === false/.test(src) && /notice_audit_unavailable/.test(src);
  line(ok, 'PL3', 'notice-audit read failure is logged distinctly', `ok=${ok}`);
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
