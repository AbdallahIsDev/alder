#!/usr/bin/env node
// tests/runner-diagnostic.test.mjs — Gate RD.
// HARNESS: reads tests/run.mjs. No network, no database.
//
// What it proves:
//   RD1  the TEST site_host failure prints a sanitised, truncated error.message
//        and error.status, not only error.code.
//
// Mutation: change the failure line back to error.code only and RD1 fails.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'tests', 'run.mjs'), 'utf8');

let total = 0;
let failed = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(52)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};

const lines = SRC.split(/\r?\n/);
const at = lines.findIndex((l) => l.includes('could not assign TEST site_host'));
const failure = at >= 0 ? lines.slice(Math.max(0, at - 8), at + 1).join('\n') : '';
const hasMessage = /String\(error\.message/.test(failure) && /message=\$\{msg\}/.test(failure);
const hasStatus = /error\.status/.test(failure) && /status=\$\{status\}/.test(failure);
const truncated = /slice\(0,\s*200\)/.test(failure);
const sanitised = /url-redacted/.test(failure) && /ip-redacted/.test(failure);

line(hasMessage && hasStatus && truncated && sanitised, 'RD1',
  'site_host failure reports sanitised message and status',
  `message=${hasMessage} status=${hasStatus} truncated=${truncated} sanitised=${sanitised}`);

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
