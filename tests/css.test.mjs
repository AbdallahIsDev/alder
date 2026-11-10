#!/usr/bin/env node
// tests/css.test.mjs — the stylesheet is a real, self-contained file.
// HARNESS: one real build into _debug/css-build. No network, no database.
//
// The page used to carry its CSS in a <style> block; it now links
// assets/css/styles.css. Two things can go wrong silently: the link is missing
// (an unstyled page still renders) or a url() inside the CSS still points at the
// old location (a font silently falls back). Both are checked here.
//
//   CSS1  the built page links exactly one stylesheet, relative, and has no <style>
//   CSS2  every non-data url() resolves to a file, relative to the CSS file
//   CSS3  the two font files are the ../fonts/ form the move requires
//
// Mutation: put one font path back to url(assets/fonts/…) and CSS2 fails.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, '_debug', 'css-build');
const CSS = path.join(ROOT, 'assets', 'css', 'styles.css');

let total = 0;
let failed = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(5)}${String(what).padEnd(52)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};

try {
  /* CSS1: build the page the way a deployment does. */
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  const r = spawnSync(process.execPath, ['build-static.js', 'index.html', '--out', path.join(OUT_DIR, 'index.html')], {
    cwd: ROOT, encoding: 'utf8',
  });
  const builtPath = path.join(OUT_DIR, 'index.html');
  const built = fs.existsSync(builtPath) ? fs.readFileSync(builtPath, 'utf8') : '';
  const links = built.match(/<link[^>]*rel="stylesheet"[^>]*>/gi) || [];
  const href = (links[0] && (links[0].match(/href="([^"]+)"/) || [])[1]) || '';
  const noStyle = !/<style[\s>]/i.test(built);
  const carried = fs.existsSync(path.join(OUT_DIR, 'assets', 'css', 'styles.css'));
  line(r.status === 0 && links.length === 1 && href === '/assets/css/styles.css' && noStyle && carried,
    'CSS1', 'built page: one root-absolute stylesheet, no <style>, css copied',
    `exit=${r.status} links=${links.length} href=${href} style=${!noStyle} copied=${carried}`);

  /* CSS2: every url() that is not a data: URI must exist on disk. */
  const css = fs.readFileSync(CSS, 'utf8');
  const urls = [...css.matchAll(/url\(([^)]+)\)/g)]
    .map((m) => m[1].trim().replace(/^['"]|['"]$/g, ''))
    .filter((u) => !u.startsWith('data:'));
  const missing = urls.filter((u) => {
    if (/^[a-z]+:/i.test(u)) return false;                    // absolute scheme: not ours
    const clean = u.split(/[?#]/)[0];
    return !fs.existsSync(path.resolve(path.dirname(CSS), clean));
  });
  line(urls.length > 0 && missing.length === 0, 'CSS2', 'every url() in the stylesheet resolves',
    `urls=${urls.length} missing=${missing.join('|') || 'none'}`);

  /* CSS3: the two faces, in the form the move requires. */
  const fontUrls = urls.filter((u) => u.includes('fonts/'));
  const relative = fontUrls.length === 2 && fontUrls.every((u) => /^\.\.\/fonts\/[a-z0-9.-]+\.woff2$/i.test(u));
  line(relative, 'CSS3', 'both font urls are ../fonts/, not assets/fonts/',
    `count=${fontUrls.length} ok=${relative}`);

  /* CSS5: every stylesheet link is root-absolute, in Alder and in a second
     client. A relative href resolves against the page's folder, which is not
     the site root once the page is served from a nested path. */
  {
    const sample = path.join(OUT_DIR, 'example.html');
    const r2 = spawnSync(process.execPath, ['build-static.js', 'index.html', '--client', 'example', '--out', sample], {
      cwd: ROOT, encoding: 'utf8',
    });
    const pages = [built, fs.existsSync(sample) ? fs.readFileSync(sample, 'utf8') : ''];
    const bad = [];
    pages.forEach((html, i) => {
      const found = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*>/gi)].map((m) => (m[0].match(/href="([^"]+)"/) || [])[1] || '');
      if (!found.length) bad.push(`${i ? 'sample' : 'alder'}:none`);
      for (const h of found) if (!h.startsWith('/')) bad.push(`${i ? 'sample' : 'alder'}:${h}`);
    });
    line(r2.status === 0 && bad.length === 0, 'CSS5',
      'every stylesheet href is root-absolute, both clients', `bad=${bad.join('|') || 'none'}`);
  }

  /* CSS4: the modal's Call is filled like "Send my request", and the hover rule
     that keeps it filled exists. Without that rule .btn.phone:hover paints a
     white 10% ground over the accent. */
  const block = (sel) => {
    const i = css.indexOf(sel);
    if (i < 0) return '';
    const open = css.indexOf('{', i);
    const close = css.indexOf('}', open);
    return open < 0 || close < 0 ? '' : css.slice(open, close);
  };
  const call = block('.est-actions .btn.phone');
  const hover = block('.est-actions .btn.phone:hover');
  const ghost = block('.est-actions .btn.ghost');
  const callOk = /min-height:\s*52px/.test(call) && /padding:\s*0 24px/.test(call)
    && /background:\s*var\(--accent\)/.test(call) && /color:\s*#fff/.test(call)
    && /border-color:\s*transparent/.test(call) && /font-weight:\s*600/.test(call);
  const hoverOk = /background:\s*var\(--accent\)/.test(hover) && /filter:\s*brightness\(\.9\)/.test(hover);
  const ghostOk = /min-height:\s*52px/.test(ghost) && /rgb\(255 255 255\/\.05\)/.test(ghost);
  line(callOk && hoverOk && ghostOk, 'CSS4', 'modal Call is filled, hover keeps it filled',
    `call=${callOk} hover=${hoverOk} close=${ghostOk}`);
} catch (e) {
  line(false, 'CSS0', 'stylesheet harness ran', e && e.message ? e.message.slice(0, 80) : 'threw');
} finally {
  try { fs.rmSync(OUT_DIR, { recursive: true, force: true }); } catch {}
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
