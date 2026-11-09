// tests/dev-root.mjs — a project directory for `vercel dev` that has no .env.
//
// WHY THIS EXISTS. `vercel dev` loads .env and .env.local from its project
// directory and those values beat the environment it was started with. Measured
// on 2026-11-09 with vercel 48.12.1: a function read the value from .env, not the
// value pinned into the parent process. So a TEST_ENV=1 run silently used the
// production database while every check said "test".
//
// The fix is structural: the server runs from a directory that contains the
// project but no .env files. `vercel dev` does not walk up to a parent directory
// (measured: a child of a directory with a .env still saw the pinned value), so
// the root can live under _debug/ and the source is reached through junctions.
//
// Junctions, not copies: api/, lib/, assets/, scripts/ and node_modules/ are the
// real directories. Only the four small root files are copied. A junction is a
// link, so removing the root must unlink it rather than recurse into it —
// removeDevRoot does that explicitly.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Directories linked into the root. `assets` is NOT here: the build copies it
 * into dist with fs.cpSync, and cpSync recreates a junction as a symlink, which
 * needs a privilege Windows does not grant by default (EPERM). It is copied
 * instead — 124 MB, about a second, and the build copies it again anyway.
 */
export const LINKED = ['api', 'lib', 'scripts', 'node_modules'];

/** Directories copied into the root rather than linked. */
export const COPIED_DIRS = ['assets'];

/** Root files the build reads, copied into the root. */
export const COPIED = ['vercel.json', 'package.json', 'index.html', 'build-static.js'];

/**
 * Create a dev root for `sourceRoot`. Returns its absolute path.
 * Idempotent: an existing root is removed first.
 */
export function createDevRoot({ sourceRoot, name = 'dev-root', debugDir = '_debug' }) {
  const dir = path.join(sourceRoot, debugDir, name);
  removeDevRoot(dir);
  fs.mkdirSync(dir, { recursive: true });

  for (const entry of LINKED) {
    const target = path.join(sourceRoot, entry);
    if (!fs.existsSync(target)) continue;
    fs.symlinkSync(target, path.join(dir, entry), 'junction');
  }
  for (const entry of COPIED_DIRS) {
    const target = path.join(sourceRoot, entry);
    if (fs.existsSync(target)) fs.cpSync(target, path.join(dir, entry), { recursive: true });
  }
  for (const file of COPIED) {
    const from = path.join(sourceRoot, file);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, file));
  }

  /* Keep the project link so `vercel dev` pulls env for THIS project instead of
     creating a new one on the account. The pull writes .env.local with only
     VERCEL_OIDC_TOKEN, which cannot override a pinned value. */
  const link = path.join(sourceRoot, '.vercel', 'project.json');
  if (fs.existsSync(link)) {
    fs.mkdirSync(path.join(dir, '.vercel'), { recursive: true });
    fs.copyFileSync(link, path.join(dir, '.vercel', 'project.json'));
  }
  return dir;
}

/**
 * Remove a dev root. Junctions are unlinked first: a recursive delete would
 * follow them into the real api/, lib/ and node_modules/.
 */
export function removeDevRoot(dir) {
  if (!dir || !fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    let stat;
    try { stat = fs.lstatSync(p); } catch { continue; }
    if (stat.isSymbolicLink()) { try { fs.unlinkSync(p); } catch {} }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
