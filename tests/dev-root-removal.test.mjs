#!/usr/bin/env node
// tests/dev-root-removal.test.mjs — Gate H.
// HARNESS: temporary directories under _debug/. No network, no database.
//
// What it proves:
//   H1  a normal removal unlinks the junction and leaves the real target intact
//   H2  when a link cannot be unlinked, the root is NOT recursively deleted: it
//       returns removed:false, prints one names-only line, and the target keeps
//       its files
//   H3  (informational) what a bare fs.rmSync does to a junction on this platform
//
// Mutation: delete the re-scan from removeDevRoot and H2 fails — rmSync runs
// anyway and reports removed:true.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeDevRoot } from './dev-root.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = path.join(ROOT, '_debug', 'devroot-test');

let total = 0;
let failed = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(52)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};

const fresh = (name) => {
  const dir = path.join(BASE, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/* One real target, two roots that link to it. */
const target = fresh('target');
fs.writeFileSync(path.join(target, 'keep.txt'), 'real content\n');

const root1 = fresh('root1');
fs.symlinkSync(target, path.join(root1, 'link'), 'junction');

const root2 = fresh('root2');
fs.symlinkSync(target, path.join(root2, 'link'), 'junction');

try {
  /* H1: the normal path. */
  const r1 = removeDevRoot(root1);
  const h1 = r1.removed === true && !fs.existsSync(root1) && fs.existsSync(path.join(target, 'keep.txt'));
  line(h1, 'H1', 'a normal removal keeps the target intact',
    `removed=${r1.removed} rootGone=${!fs.existsSync(root1)} target=${fs.existsSync(path.join(target, 'keep.txt'))}`);

  /* H2: a link that will not unlink. Stub unlinkSync so the first pass fails. */
  const realUnlink = fs.unlinkSync;
  const printed = [];
  const realLog = console.log;
  let r2;
  try {
    fs.unlinkSync = () => { const e = new Error('EBUSY: fake lock'); e.code = 'EBUSY'; throw e; };
    console.log = (s) => { printed.push(String(s)); };
    r2 = removeDevRoot(root2);
  } finally {
    fs.unlinkSync = realUnlink;
    console.log = realLog;
  }
  const warn = printed.find((l) => /^WARN {2}dev-root {2}not removed: 1 link\(s\) still present$/.test(l));
  const h2 = r2.removed === false && r2.reason === 'links-remain' && r2.survivors === 1
    && fs.existsSync(root2) && fs.existsSync(path.join(target, 'keep.txt')) && !!warn;
  line(h2, 'H2', 'a surviving link stops the recursive delete',
    `removed=${r2.removed} reason=${r2.reason} survivors=${r2.survivors} target=${fs.existsSync(path.join(target, 'keep.txt'))} warn=${!!warn}`);

  /* H3: what a bare rmSync does here. Informational — the answer differs by
     platform and by whether the link is a junction or a symlink. */
  const root3 = fresh('root3');
  fs.symlinkSync(target, path.join(root3, 'link'), 'junction');
  let rmError = null;
  try { fs.rmSync(root3, { recursive: true, force: true }); } catch (e) { rmError = e.code || 'error'; }
  const survived = fs.existsSync(path.join(target, 'keep.txt'));
  line(true, 'H3', 'bare rmSync on a junction: target survives?',
    `survived=${survived} error=${rmError || 'none'}`);
  /* H4: the delete itself fails — Windows holds the directory for a moment after
     the dev server is killed. Cleanup runs after every assertion, so it must
     report and return, never throw. */
  const root4 = fresh('root4');
  const realRm = fs.rmSync;
  const printed4 = [];
  const realLog4 = console.log;
  let r4;
  try {
    fs.rmSync = () => { const e = new Error('EBUSY: fake lock'); e.code = 'EBUSY'; throw e; };
    console.log = (s) => { printed4.push(String(s)); };
    r4 = removeDevRoot(root4);
  } finally {
    fs.rmSync = realRm;
    console.log = realLog4;
  }
  const warn4 = printed4.find((l) => /^WARN {2}dev-root {2}not removed: EBUSY \(a leftover root is harmless\)$/.test(l));
  line(!!r4 && r4.removed === false && r4.reason === 'busy' && !!warn4 && fs.existsSync(root4),
    'H4', 'a locked directory is reported, never thrown',
    `removed=${r4 && r4.removed} reason=${r4 && r4.reason} warn=${!!warn4}`);

} catch (e) {
  line(false, 'H0', 'removal harness ran', e && e.message ? e.message.slice(0, 80) : 'threw');
} finally {
  for (const d of ['root1', 'root2', 'root3', 'root4']) {
    try { fs.rmSync(path.join(BASE, d), { recursive: true, force: true }); } catch {}
  }
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
