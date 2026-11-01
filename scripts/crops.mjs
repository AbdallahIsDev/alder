/**
 * crops.mjs — 1:1 crop comparisons: original vs AVIF vs WebP.
 * Node scripts/crops.mjs  (writes _shots/crop-*.png)
 */
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, '_source-assets', 'hero');
const OUT = path.join(ROOT, 'assets', 'images', 'hero');
const SHOTS = path.join(ROOT, '_shots');

const FONT = 20;

function label(text, w) {
  const svg = `<svg width="${w}" height="34"><rect width="${w}" height="34" fill="#111"/>` +
    `<text x="10" y="23" font-family="monospace" font-size="${FONT}" fill="#fff">${text}</text></svg>`;
  return Buffer.from(svg);
}

async function panel(buf, meta, rect, text) {
  const crop = await sharp(buf).extract(rect).toBuffer();
  return { crop, w: rect.width, h: rect.height, text };
}

/** rect in the coordinate space of `refWidth` */
async function build(name, srcFile, files, cropRect, scaleRefWidth) {
  const base = sharp(path.join(SRC, srcFile));
  const refBuf = scaleRefWidth
    ? await base.resize({ width: scaleRefWidth, kernel: 'lanczos3', fit: 'inside' }).toBuffer()
    : await base.toBuffer();
  const panels = [];
  for (const [text, file] of [['ORIGINAL', refBuf], ...files.map((f) => [f.label, f.buf])]) {
    const buf = Buffer.isBuffer(file) ? file : await fs.readFile(path.join(OUT, file));
    const m = await sharp(buf).metadata();
    const crop = await sharp(buf).extract(cropRect).toBuffer();
    panels.push({ crop, w: m.width, h: m.height, text, meta: m });
  }
  const w = cropRect.width, h = cropRect.height, gap = 6, head = 34;
  const totalW = panels.length * w + (panels.length - 1) * gap;
  const comps = [];
  let x = 0;
  for (const p of panels) {
    const lbl = await sharp(label(p.text, w)).png().toBuffer();
    comps.push({ input: lbl, top: 0, left: x });
    comps.push({ input: p.crop, top: head, left: x });
    x += w + gap;
  }
  const out = path.join(SHOTS, `crop-${name}.png`);
  await sharp({ create: { width: totalW, height: h + head, channels: 3, background: '#000' } })
    .composite(comps).png().toFile(out);
  console.log(out, `${totalW}x${h + head}`);
}

const d1 = { left: 620, top: 430, width: 420, height: 300 };   // shingle courses, hero-1
const d1sky = { left: 60, top: 30, width: 420, height: 300 };  // sky / cloud gradient, hero-1
const d2 = { left: 120, top: 240, width: 420, height: 300 };   // trees + seam, hero-2
const d3 = { left: 700, top: 420, width: 420, height: 300 };   // cedar shakes + stone, hero-3
const m1 = { left: 300, top: 700, width: 300, height: 240 };
const m2 = { left: 260, top: 620, width: 300, height: 240 };
const m3 = { left: 220, top: 700, width: 300, height: 240 };

await build('hero-1-shingles', 'hero-1.png', [{ label: 'AVIF', buf: 'hero-1.avif' }, { label: 'WEBP', buf: 'hero-1.webp' }], d1);
await build('hero-1-sky', 'hero-1.png', [{ label: 'AVIF', buf: 'hero-1.avif' }, { label: 'WEBP', buf: 'hero-1.webp' }], d1sky);
await build('hero-2', 'hero-2.png', [{ label: 'AVIF', buf: 'hero-2.avif' }, { label: 'WEBP', buf: 'hero-2.webp' }], d2);
await build('hero-3', 'hero-3.png', [{ label: 'AVIF', buf: 'hero-3.avif' }, { label: 'WEBP', buf: 'hero-3.webp' }], d3);
await build('hero-1-m', 'hero-1-m.png', [{ label: 'AVIF', buf: 'hero-1-m.avif' }, { label: 'WEBP', buf: 'hero-1-m.webp' }], m1, 900);
await build('hero-2-m', 'hero-2-m.png', [{ label: 'AVIF', buf: 'hero-2-m.avif' }, { label: 'WEBP', buf: 'hero-2-m.webp' }], m2, 900);
await build('hero-3-m', 'hero-3-m.png', [{ label: 'AVIF', buf: 'hero-3-m.avif' }, { label: 'WEBP', buf: 'hero-3-m.webp' }], m3, 900);
