#!/usr/bin/env node
// tests/build-test-probe.test.mjs — Gate S.
// HARNESS: in-process. No network, no database.
//
// What it proves:
//   S1  _debug/build-test does not exist when a suite starts
//
// The runner sweeps that path before the first suite, so a tree left behind by a
// killed run is gone by the time anything measures it. tests/startup-sweep.test.mjs
// plants a folder and runs this suite to prove the sweep happens at START, not
// only at the end.
//
// Mutation: remove the start sweep from tests/run.mjs and this fails.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, '_debug', 'build-test');

const exists = fs.existsSync(TARGET);
console.log(`${exists ? 'FAIL' : 'PASS'}  S1  no stale _debug/build-test at suite start  exists=${exists}`);
console.log('');
console.log(`${exists ? '0/1 passed — 1 FAILED' : '1/1 passed'}`);
process.exit(exists ? 1 : 0);
