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
 * Directories linked into the root. `assets` is here too: the build copies it
 * into dist with fs.cpSync, and that call passes `dereference: true` so a
 * junction is copied as content instead of being recreated as a link (which
 * Windows refuses with EPERM).
 */
export const LINKED = ['api', 'lib', 'scripts', 'node_modules', 'assets', 'clients'];

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
 * Remove a dev root. Junctions are unlinked first, then the directory is scanned
 * again: a recursive delete is only safe when no link survived. If one did (a
 * locked handle, a permission error), removing the root could follow it into the
 * real api/, lib/ or node_modules/ — so it refuses and says so.
 *
 * @returns {{removed: boolean, reason: string|null, survivors: number}}
 */
export function removeDevRoot(dir) {
  if (!dir || !fs.existsSync(dir)) return { removed: false, reason: 'missing', survivors: 0 };

  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    let stat;
    try { stat = fs.lstatSync(p); } catch { continue; }
    if (stat.isSymbolicLink()) { try { fs.unlinkSync(p); } catch {} }
  }

  const survivors = fs.readdirSync(dir).filter((entry) => {
    try { return fs.lstatSync(path.join(dir, entry)).isSymbolicLink(); } catch { return false; }
  });

  if (survivors.length) {
    /* Names only: a path here would leak the machine's layout into test output. */
    console.log(`WARN  dev-root  not removed: ${survivors.length} link(s) still present`);
    return { removed: false, reason: 'links-remain', survivors: survivors.length };
  }

  fs.rmSync(dir, { recursive: true, force: true });
  return { removed: true, reason: null, survivors: 0 };
}
