#!/usr/bin/env node
// tests/build-linked-assets.test.mjs — Gate B.
// HARNESS: builds one dev root (assets/ linked, not copied) and removes it.
//
// What it proves:
//   B1  the dev root really links assets/ rather than copying it
//   B2  build-static.js copies through that link: exit 0, a real dist/assets
//       directory (not a symlink), and a file that came from the link
//   B3  removing the root leaves the real assets/ untouched
//
// WHY. fs.cpSync recreates a symlink as a symlink unless told otherwise, and
// Windows refuses that without a privilege (EPERM). `dereference: true` is the
// one-word fix that lets the dev root link 124 MB instead of copying it.
//
// Mutation: drop `dereference: true` and B2 fails with EPERM.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDevRoot, removeDevRoot } from './dev-root.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'build-root';

let total = 0;
let failed = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(52)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};

let root = null;
try {
  root = createDevRoot({ sourceRoot: ROOT, name: NAME });
  const linked = (() => { try { return fs.lstatSync(path.join(root, 'assets')).isSymbolicLink(); } catch { return false; } })();
  line(linked, 'B1', 'the dev root links assets/ instead of copying it', `linked=${linked}`);

  const r = spawnSync(process.execPath, ['build-static.js', 'index.html', '--out', 'dist/index.html'], {
    cwd: root, encoding: 'utf8', timeout: 120000,
  });
  const distAssets = path.join(root, 'dist', 'assets');
  let isDir = false;
  let isLink = true;
  try { const st = fs.lstatSync(distAssets); isDir = st.isDirectory(); isLink = st.isSymbolicLink(); } catch {}
  const sample = fs.existsSync(path.join(distAssets, 'images', 'og-image.jpg'));
  line(r.status === 0 && fs.existsSync(path.join(root, 'dist', 'index.html')) && isDir && !isLink && sample,
    'B2', 'the build copies through the link',
    `exit=${r.status} dir=${isDir} link=${isLink} sample=${sample}`);

  removeDevRoot(root);
  const gone = !fs.existsSync(root);
  const sourceIntact = fs.existsSync(path.join(ROOT, 'assets', 'images', 'og-image.jpg'));
  line(gone && sourceIntact, 'B3', 'removing the root leaves the real assets/ alone',
    `rootGone=${gone} source=${sourceIntact}`);
  root = null;
} catch (e) {
  line(false, 'B0', 'build harness ran', e && e.message ? e.message.slice(0, 80) : 'threw');
} finally {
  if (root) removeDevRoot(root);
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
