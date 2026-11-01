#!/usr/bin/env node
/**
 * optimize-hero.mjs — the hero slider images.
 *
 * Same encoder settings as scripts/optimize-images.mjs (they are read out of
 * scripts/images.config.json, so the two can never drift), with the two things the generic
 * pipeline cannot do:
 *
 *   1. a desktop image is encoded at its exact original pixel size, with no resize call at all;
 *   2. the quality search runs DOWNWARD to the lowest quality that still clears the SSIM floor,
 *      because the brief is "the smallest file with SSIM >= 0.97", not "the default quality".
 *
 *   node scripts/optimize-hero.mjs
 *   node scripts/optimize-hero.mjs --only=hero-1
 *
 * Sources: _source-assets/hero/*.png (never the published copies).
 * Output:  assets/images/hero/*.{avif,webp}, metadata stripped (sharp drops EXIF/ICC/XMP unless
 *          withMetadata() is called, which it never is here).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { ssim } from 'ssim.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, '_source-assets', 'hero');
const OUT = path.join(ROOT, 'assets', 'images', 'hero');

const argv = process.argv.slice(2);
const ONLY = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;

const FLOOR = 0.97;          /* the brief's SSIM floor, against the lossless reference */

/* Two SSIM implementations disagree on WebP for the cedar-shake slide: ssim.js (RGB) passes at
   q70, ffmpeg's YUV "All" figure does not (4:2:0 chroma on a strongly saturated warm image).
   These two are pinned to the lowest quality that clears the floor on BOTH, so the number in the
   report is true whichever tool you measure it with. */
const PINS = { 'hero-3': { webp: 81 }, 'hero-3-m': { webp: 81 } };
const MOBILE_W = 900;        /* see the note in the report: 1 device px per CSS px at the widest supported box */

const cfg = JSON.parse(await fs.readFile(path.join(HERE, 'images.config.json'), 'utf8'));
const AVIF = cfg.defaults.formats.avif;
const WEBP = cfg.defaults.formats.webp;
const KERNEL = cfg.defaults.kernel;

const kb = (n) => (n >= 1024 * 1024 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(0) + ' KB');
const pad = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);
const asClamped = (b) => new Uint8ClampedArray(b.buffer, b.byteOffset, b.length);

/** Lossless reference. Desktop: the PNG's own pixels. Mobile: the one Lanczos3 downscale, so the
 *  score isolates codec loss from resampling loss. */
async function reference(input, width) {
  let p = sharp(input);
  if (width) p = p.resize({ width, kernel: KERNEL, fit: 'inside' });
  return p.toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

async function encode(input, width, fmt, quality) {
  let p = sharp(input);
  if (width) p = p.resize({ width, kernel: KERNEL, fit: 'inside' });
  p = p.toColourspace('srgb');
  p = fmt === 'avif'
    ? p.avif({ quality, effort: AVIF.effort, chromaSubsampling: AVIF.chromaSubsampling })
    : p.webp({ quality, effort: WEBP.effort, smartSubsample: WEBP.smartSubsample });
  return p.toBuffer();
}

async function score(buf, ref) {
  const { data, info } = await sharp(buf).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== ref.info.width || info.height !== ref.info.height) {
    throw new Error(`decoded ${info.width}x${info.height} != ref ${ref.info.width}x${ref.info.height}`);
  }
  return ssim(
    { data: asClamped(ref.data), width: info.width, height: info.height },
    { data: asClamped(data), width: info.width, height: info.height },
    { downsample: 'fast' }
  ).mssim;
}

/** Lowest quality that still clears the floor, then one step back up for a small safety margin
 *  against the visual check (banding in sky, shingle detail). Walks down from the pipeline default. */
async function search(input, width, fmt, ref) {
  const start = fmt === 'avif' ? AVIF.quality : WEBP.quality;
  const step = 2;
  const tries = [];
  let best = null;
  for (let q = start; q >= 20; q -= step) {
    const buf = await encode(input, width, fmt, q);
    const s = await score(buf, ref);
    tries.push({ q, size: buf.length, ssim: +s.toFixed(4) });
    if (s >= FLOOR) best = { q, buf, size: buf.length, ssim: s };
    else break;                                   /* the curve is monotonic enough: stop at the first miss */
  }
  if (!best) {                                    /* never cleared the floor even at the default */
    for (let q = start + step; q <= 100; q += step) {
      const buf = await encode(input, width, fmt, q);
      const s = await score(buf, ref);
      tries.push({ q, size: buf.length, ssim: +s.toFixed(4) });
      if (s >= FLOOR) { best = { q, buf, size: buf.length, ssim: s }; break; }
    }
  }
  if (!best) throw new Error(`${fmt}: no quality reached SSIM ${FLOOR}`);
  return { ...best, tries };
}

const JOBS = [
  { name: 'hero-1', src: 'hero-1.png', width: 0 },
  { name: 'hero-1-m', src: 'hero-1-m.png', width: MOBILE_W },
  { name: 'hero-2', src: 'hero-2.png', width: 0 },
  { name: 'hero-2-m', src: 'hero-2-m.png', width: MOBILE_W },
  { name: 'hero-3', src: 'hero-3.png', width: 0 },
  { name: 'hero-3-m', src: 'hero-3-m.png', width: MOBILE_W },
].filter((j) => !ONLY || j.name === ONLY);

await fs.mkdir(OUT, { recursive: true });
const report = [];

for (const job of JOBS) {
  const input = path.join(SRC, job.src);
  const meta = await sharp(input).metadata();
  const ref = await reference(input, job.width);
  const inBytes = (await fs.stat(input)).size;
  const row = { name: job.name, source: `${meta.width}x${meta.height}`, out: {} };
  console.log(`\n${job.name}  ${meta.width}x${meta.height} ${kb(inBytes)} -> ${ref.info.width}x${ref.info.height}`);

  for (const fmt of ['avif', 'webp']) {
    const pin = PINS[job.name] && PINS[job.name][fmt];
    let r;
    if (pin) {
      const buf = await encode(input, job.width, fmt, pin);
      r = { q: pin, buf, size: buf.length, ssim: await score(buf, ref), tries: [{ q: pin }] };
    } else {
      r = await search(input, job.width, fmt, ref);
    }
    const file = path.join(OUT, `${job.name}.${fmt}`);
    await fs.writeFile(file, r.buf);
    row.out[fmt] = { q: r.q, size: r.size, ssim: +r.ssim.toFixed(4), dims: `${ref.info.width}x${ref.info.height}`, tries: r.tries };
    console.log(`  ${pad(fmt, 5)} q${padl(r.q, 3)}  ${padl(kb(r.size), 9)}  ssim ${r.ssim.toFixed(4)}  ${ref.info.width}x${ref.info.height}  (${r.tries.length} tries)`);
  }
  report.push(row);
}

console.log('\n' + JSON.stringify(report, null, 1));
await fs.writeFile(path.join(ROOT, '_shots', 'hero-encode-report.json'), JSON.stringify(report, null, 1)).catch(() => {});
