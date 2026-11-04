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

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
