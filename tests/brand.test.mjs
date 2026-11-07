#!/usr/bin/env node
// tests/brand.test.mjs — Gate F.
// HARNESS: in-process, no network, no DB. Reads only lib/brand.generated.json,
// index.html (extraction source) and assets/fonts. Run through tests/run.mjs.
//
// F1  The generated JSON equals a fresh extraction from index.html (drift test).
// F2  Every colour is /^#[0-9A-F]{6}$/.
// F3  Contrast: text/card >= 4.5, muted/card >= 4.5, accentText/accent >= 4.5, onBg/bg >= 4.5.
// F4  Every font file referenced exists in assets/fonts.
// F5  Logo PNGs exist, are 72 px high, and have alpha.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { getBrand } from '../lib/brand.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED = path.join(ROOT, 'lib', 'brand.generated.json');

let failed = 0, total = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(5)}${String(what).padEnd(48)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};

/* F1: drift test */
const before = fs.readFileSync(GENERATED, 'utf8');
const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'sync-brand.mjs')],
  { cwd: ROOT, encoding: 'utf8' });
const after = fs.readFileSync(GENERATED, 'utf8');
line(r.status === 0 && before === after, 'F1', 'generated JSON equals fresh extraction (no drift)',
  r.status === 0 ? `identical=${before === after}` : `sync failed: ${(r.stderr || r.stdout || '').slice(0, 80)}`);

const brand = getBrand();
const colors = brand.colors;

/* F2 */
const hexes = Object.entries(colors);
const badHex = hexes.filter(([, v]) => !/^#[0-9A-F]{6}$/.test(v));
line(badHex.length === 0, 'F2', 'every colour is #RRGGBB', `roles=${hexes.length} bad=${badHex.map(([k]) => k).join(',')}`);

/* F3 */
function relLum(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const cr = (a, b) => {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const ratios = {
  text: cr(colors.text, colors.card),
  muted: cr(colors.muted, colors.card),
  accentText: cr(colors.accentText, colors.accent),
  onBg: cr(colors.onBg, colors.bg),
};
line(Object.values(ratios).every((v) => v >= 4.5), 'F3', 'all required contrast pairs >= 4.5',
  `text=${ratios.text.toFixed(2)} muted=${ratios.muted.toFixed(2)} accentText=${ratios.accentText.toFixed(2)} onBg=${ratios.onBg.toFixed(2)}`);

/* F4 */
const fontsDir = path.join(ROOT, 'assets', 'fonts');
const missing = (brand.fonts.faces || []).filter((f) => !fs.existsSync(path.join(fontsDir, f.file)));
line(missing.length === 0 && (brand.fonts.faces || []).length > 0, 'F4', 'every referenced font file exists',
  `faces=${(brand.fonts.faces || []).length} missing=${missing.map((f) => f.file).join(',')}`);

/* F5 */
async function checkLogo() {
  if (!brand.logo) { line(true, 'F5', 'logo is null (wordmark mode)', 'null'); return; }
  const results = [];
  for (const key of ['onDark', 'onLight']) {
    const url = brand.logo[key];
    const rel = String(url).replace(/^https?:\/\/[^/]+/, '').replace(/^\//, '');
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { results.push(`${key}:missing`); continue; }
    const meta = await sharp(abs).metadata();
    results.push(`${key}:${meta.height}px alpha=${meta.hasAlpha}`);
    if (!(meta.height === 72 && meta.hasAlpha)) results.push(`${key}:BAD`);
  }
  line(results.length === 2 && !results.some((s) => s.includes('BAD') || s.includes('missing')),
    'F5', 'logo PNGs 72px high with alpha', results.join(' '));
}
await checkLogo();

/* F6: the module actually loads the logo bytes (the file vercel.json's
   functions.includeFiles guarantees in the deployed bundle). */
{
  const b64 = brand.logo && brand.logo.onDarkB64;
  const bytes = b64 ? Buffer.from(b64, 'base64') : Buffer.alloc(0);
  const isPng = bytes.length > 100 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  line(isPng, 'F6', 'brand module loads logo PNG bytes from generated JSON',
    `len=${bytes.length} png=${isPng}`);
}

/* F7: form-control borders meet WCAG 1.4.11 (3:1) on the modal's own ground.
   The field fill is white at 7% over the dialog, the dialog is the ink at 74%
   over the scrim, and the scrim is the ink at 50% over the page — so the worst
   case is a white section behind the modal, which is what this models. The three
   tokens are read from index.html; only the composite chain is hardcoded. */
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  // The .est token block spans a few lines (--ctl-* sits on its own), so take the
  // line that carries --field plus the three that follow it.
  const lines = html.split('\n');
  const at = lines.findIndex((l) => l.includes('--field:') && l.includes('--line:'));
  const tokenScope = at < 0 ? '' : lines.slice(at, at + 8).join('\n');
  const token = (name) => {
    const m = new RegExp('--' + name + ':\\s*([^;]+);').exec(tokenScope);
    return m ? m[1].trim() : null;
  };
  const scrimBlock = /\.est-scrim \{[^}]*background: ([^;]+);/.exec(html);
  const scrimSpec = scrimBlock ? scrimBlock[1].trim() : null;

  const parse = (v) => {
    if (!v) return null;
    let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
    if (m) {
      const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
      return { rgb: h.match(/../g).map((x) => parseInt(x, 16)), a: 1 };
    }
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+))?\s*\)$/.exec(v.trim());
    if (!m) return null;
    return { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] };
  };
  const over = (fg, bg) => fg.rgb.map((c, i) => c * fg.a + bg[i] * (1 - fg.a));
  const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };

  const bg = parse(token('bg')), fieldSpec = parse(token('field')), scrim = parse(scrimSpec);
  const ctlLine = parse(token('ctl-line')), ctlFocus = parse(token('ctl-focus')), ctlErr = parse(token('ctl-err'));
  let detail = 'tokens missing';
  let ok = false;
  if (bg && fieldSpec && scrim && ctlLine && ctlFocus && ctlErr) {
    const page = [255, 255, 255];
    const dialog = over(bg, over(scrim, page));
    const field = over(fieldSpec, dialog);
    // A border is painted over what is behind it, so a translucent value is
    // composited before it is measured — otherwise rgb(255 255 255/.18) would be
    // scored as opaque white and a regression would look like an improvement.
    const lineOnField = over(ctlLine, field);
    const lineOnDialog = over(ctlLine, dialog);
    const focusOnField = over(ctlFocus, field);
    const errOnField = over(ctlErr, field);
    const rLineField = ratio(lineOnField, field);
    const rLineDialog = ratio(lineOnDialog, dialog);
    const rFocus = ratio(focusOnField, field);
    const rFocusStep = ratio(focusOnField, lineOnField);
    const rErr = ratio(errOnField, field);
    const rErrStep = ratio(errOnField, lineOnField);
    const errIsRed = ctlErr.rgb[0] > ctlErr.rgb[1] + 20 && ctlErr.rgb[0] > ctlErr.rgb[2] + 20;
    ok = rLineField >= 3 && rLineDialog >= 3
      && rFocus >= 3 && rFocusStep >= 1.4
      && rErr >= 3 && rErrStep >= 1.4 && errIsRed;
    detail = `resting ${rLineField.toFixed(2)}/${rLineDialog.toFixed(2)} focus ${rFocus.toFixed(2)} step ${rFocusStep.toFixed(2)} `
      + `err ${rErr.toFixed(2)} step ${rErrStep.toFixed(2)} red=${errIsRed}`;
  }
  line(ok, 'F7', 'form-control borders >=3:1, states distinguishable', detail);
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
