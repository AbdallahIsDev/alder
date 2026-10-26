#!/usr/bin/env node
/**
 * optimize-images.mjs — the one image pipeline for this site.
 *
 * Reads scripts/images.config.json, and for every target folder encodes each source image
 * to AVIF + WebP at an exact pixel size, raising quality until the result clears an SSIM
 * floor against the resized original, then trying one step lower and keeping it only if it
 * still clears the floor. Idempotent: a file whose outputs already exist and are newer than
 * the source is skipped, so re-running costs nothing. Pass --force to re-encode regardless.
 *
 *   node scripts/optimize-images.mjs
 *   node scripts/optimize-images.mjs --force
 *   node scripts/optimize-images.mjs --only=services
 *
 * Add a folder by appending a target to the config; nothing else needs to change.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { ssim } from 'ssim.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const SOURCE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.avif']);
const FORMATS = ['webp', 'avif'];

/* ------------------------------------------------------------------ args */

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const ONLY = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;

/* ------------------------------------------------------------------ util */

const kb = (n) => (n >= 1024 * 1024 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(0) + ' KB');
const pad = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);

async function statOrNull(p) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

/** The reference is the lossless resize, not the original file. Comparing the encoder against
 *  a downscaled reference isolates codec loss from resampling loss, which is the only thing
 *  the quality setting actually controls. */
async function resizeRaw(input, t) {
  return sharp(input)
    .resize({ width: t.width, height: t.height, fit: t.fit, position: t.position, kernel: t.kernel })
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

const asClamped = (buf) => new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length);

async function measureBuf(encoded, ref) {
  const { data, info } = await sharp(encoded).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== ref.info.width || info.height !== ref.info.height) {
    throw new Error(`decoded size ${info.width}x${info.height} != ${ref.info.width}x${ref.info.height}`);
  }
  const { mssim } = ssim(
    { data: asClamped(ref.data), width: info.width, height: info.height },
    { data: asClamped(data), width: info.width, height: info.height },
    { downsample: 'fast' }
  );
  return mssim;
}

/** Encodes to a buffer. The encoder method is called by name — toFile() infers the format from
 *  the extension and silently ignores an options object, so the settings must be applied here.
 *  No withMetadata() anywhere: sharp strips EXIF/ICC/XMP by default, which is what we want. */
async function encodeBuffer(input, t, fmt, quality) {
  let p = sharp(input)
    .resize({ width: t.width, height: t.height, fit: t.fit, position: t.position, kernel: t.kernel })
    .toColourspace('srgb');

  const o = t.formats[fmt];
  if (fmt === 'webp') {
    p = p.webp({ quality, effort: o.effort, smartSubsample: o.smartSubsample });
  } else {
    p = p.avif({ quality, effort: o.effort, chromaSubsampling: o.chromaSubsampling });
  }
  return p.toBuffer();
}

/**
 * Quality search, all in memory so no temp files are written. Start at the configured quality;
 * if it clears the floor, try one step lower and keep it only when it still clears. If it fails,
 * step up until it passes. The winner is written once.
 *
 * A target may pin the quality per file and format (`pin: { stem: { webp: 83, avif: 60 } }`) for
 * the cases where one step either side of the default is a bad trade — a single-step search can
 * only find the neighbours of the starting quality, not the point where the curve actually
 * crosses the floor. A pin still gets measured, and still reports if it lands below the floor.
 */
async function encodeWithFloor(input, outPath, t, fmt, ref, pin) {
  const floor = t.ssimFloor;
  const step = t.qualityStep;

  const run = async (q) => {
    const buf = await encodeBuffer(input, t, fmt, q);
    return { q, buf, size: buf.length, score: await measureBuf(buf, ref) };
  };

  if (typeof pin === 'number') {
    const pinned = await run(pin);
    await fs.writeFile(outPath, pinned.buf);
    return {
      quality: pinned.q,
      size: pinned.size,
      score: pinned.score,
      raised: false,
      lowered: false,
      pinned: true,
      tries: [{ q: pinned.q, size: pinned.size, score: pinned.score }],
    };
  }

  let best = await run(t.formats[fmt].quality);
  const tries = [best];
  let raised = false;
  let lowered = false;

  if (best.score < floor) {
    raised = true;
    while (best.score < floor && best.q < t.maxQuality) {
      best = await run(Math.min(best.q + step, t.maxQuality));
      tries.push(best);
    }
  } else if (best.q - step > 0) {
    const cand = await run(best.q - step);
    tries.push(cand);
    if (cand.score >= floor) {
      best = cand;
      lowered = true;
    }
  }

  await fs.writeFile(outPath, best.buf);
  return {
    quality: best.q,
    size: best.size,
    score: best.score,
    raised,
    lowered,
    tries: tries.map(({ q, size, score }) => ({ q, size, score })),
  };
}

/* ------------------------------------------------------------------ main */

const configPath = path.join(HERE, 'images.config.json');
const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
const defaults = raw.defaults;

const targets = raw.targets
  .filter((t) => !ONLY || t.name === ONLY)
  .map((t) => ({
    fit: defaults.fit,
    position: defaults.position,
    kernel: defaults.kernel,
    ssimFloor: defaults.ssimFloor,
    qualityStep: defaults.qualityStep,
    maxQuality: defaults.maxQuality,
    formats: defaults.formats,
    ...t,
  }));

if (!targets.length) {
  console.error(ONLY ? `no target named "${ONLY}" in images.config.json` : 'no targets configured');
  process.exit(1);
}

const rows = [];
let encodedCount = 0;
let skippedCount = 0;
let inBytes = 0;
let outBytes = 0;
let failures = 0;

for (const t of targets) {
  const inDir = path.join(ROOT, t.input);
  const outDir = path.join(ROOT, t.output);

  const entries = (await fs.readdir(inDir)).filter((f) => SOURCE_EXT.has(path.extname(f).toLowerCase())).sort();

  if (!entries.length) {
    console.error(`  ! ${t.name}: no source images in ${t.input}`);
    continue;
  }

  await fs.mkdir(outDir, { recursive: true });
  /* A target may give only a width (fit: 'inside'); the height then follows the source ratio and
     nothing is cropped. Print it that way instead of "940xundefined". */
  const sizeLabel = t.height ? `${t.width}x${t.height}` : `${t.width} wide (height follows the source ratio)`;
  console.log(`\n${t.name}  ${sizeLabel}  ${entries.length} source image(s)  ${t.input} -> ${t.output}`);

  for (const file of entries) {
    const input = path.join(inDir, file);
    const stem = path.basename(file, path.extname(file));
    const name = (t.rename && t.rename[stem]) || stem;
    const inStat = await fs.stat(input);
    inBytes += inStat.size;

    const outs = FORMATS.map((fmt) => path.join(outDir, `${name}.${fmt}`));
    const outStats = await Promise.all(outs.map(statOrNull));
    const fresh =
      !FORCE && outStats.every((s) => s && s.mtimeMs >= inStat.mtimeMs) && outStats.every((s) => s.size > 0);

    if (fresh) {
      skippedCount++;
      const sizes = outStats.map((s) => s.size);
      outBytes += sizes.reduce((a, b) => a + b, 0);
      rows.push({
        name,
        inBytes: inStat.size,
        out: Object.fromEntries(FORMATS.map((f, i) => [f, { size: sizes[i], quality: '-', score: null, cached: true }])),
        cached: true,
      });
      console.log(`  = ${pad(name, 22)} up to date, skipped`);
      continue;
    }

    const ref = await resizeRaw(input, t);
    const out = {};

    for (const [i, fmt] of FORMATS.entries()) {
      const pin = t.pin && t.pin[stem] && t.pin[stem][fmt];
      const res = await encodeWithFloor(input, outs[i], t, fmt, ref, pin);
      out[fmt] = { size: res.size, quality: res.quality, score: res.score, tries: res.tries, raised: res.raised, lowered: res.lowered, pinned: res.pinned };
      outBytes += res.size;
      if (res.score < t.ssimFloor) failures++;
      const flag = res.score < t.ssimFloor ? 'FAIL' : res.pinned ? 'pinned' : res.raised ? 'raised' : res.lowered ? 'lowered' : '';
      console.log(
        `  + ${pad(name, 22)} ${pad(fmt, 5)} q${padl(res.quality, 3)}  ${padl(kb(res.size), 9)}  ${padl(
          `${ref.info.width}x${ref.info.height}`,
          9
        )}  ssim ${res.score.toFixed(4)}  ${flag}`
      );
    }

    encodedCount++;
    rows.push({ name, inBytes: inStat.size, out });
  }
}

/* ------------------------------------------------------------------ report */

console.log('\n' + '-'.repeat(78));
console.log(`${pad('file', 24)}${padl('source', 11)}${padl('webp', 11)}${padl('avif', 11)}${padl('saved', 9)}`);
console.log('-'.repeat(78));
for (const r of rows) {
  const w = r.out.webp.size;
  const a = r.out.avif.size;
  const best = Math.min(w, a);
  const saved = (1 - best / r.inBytes) * 100;
  console.log(
    `${pad(r.name, 24)}${padl(kb(r.inBytes), 11)}${padl(kb(w) + ' q' + r.out.webp.quality, 11)}${padl(
      kb(a) + ' q' + r.out.avif.quality,
      11
    )}${padl(saved.toFixed(1) + '%', 9)}`
  );
}
console.log('-'.repeat(78));
console.log(
  `${pad('total', 24)}${padl(kb(inBytes), 11)}${padl('', 22)}${padl(((1 - outBytes / inBytes) * 100).toFixed(1) + '%', 9)}`
);
console.log(
  `\n${encodedCount} encoded, ${skippedCount} skipped${failures ? `, ${failures} below the SSIM floor` : ', all above the SSIM floor'}`
);
console.log(`bytes in ${inBytes} -> out ${outBytes}\n`);

if (failures) process.exitCode = 1;
