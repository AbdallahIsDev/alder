// Renders the app icon set from the master logo vector, assets/icons/favicon.svg.
//
// Every size is rasterised from the vector at 2048px and downsampled with lanczos3, so the small
// sizes are true supersamples rather than an upscaled raster.
//
// Three families, and the difference is load-bearing:
//   any        the logo as drawn, flattened onto an opaque ink square. Transparent corners would show
//              the launcher wallpaper through them; a full square is also what a launcher that does
//              not mask expects.
//   maskable   the mark alone, scaled down until every edge sits inside the 80% safe circle
//              (radius 204.8 at 512), because Android crops this icon to its own shape. The scale is
//              measured from the rendered pixels, not hardcoded, so a replaced logo cannot quietly
//              spill outside the circle.
//   apple      180x180, opaque, square, no pre-rounding - iOS applies its own rounded mask.
//
// Metadata is never copied (sharp drops it unless withMetadata() is called) and the PNGs are written
// with the maximum lossless deflate effort.
//
// Usage: node scripts/make-icons.mjs
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import sharp from 'sharp';

const SRC = 'assets/icons/favicon.svg'; /* the master: 512x512, plate + roof + chimney + house */
const OUT = 'assets/icons';             /* every icon, including the tab favicon, lives here */
const INK = '#1C1F24';
const SAFE = 512 * 0.4;                  /* radius of the central 80% circle */
const RENDER = 2048;                     /* rasterise the 512 vector at 4x, then downsample */

const svg = await readFile(SRC, 'utf8');
const openTag = (svg.match(/<svg[^>]*>/) || [])[0];
if (!openTag) throw new Error(SRC + ' has no <svg> element.');
const body = svg.slice(svg.indexOf(openTag) + openTag.length, svg.lastIndexOf('</svg>'));

/* The plate is the only full-canvas rect: it is what makes the logo square and opaque. */
const plateRe = /<rect[^>]*\bwidth="512"[^>]*\bheight="512"[^>]*\/>/;
if (!plateRe.test(body)) throw new Error('The master SVG has no full-canvas plate rect; update make-icons.mjs.');
const mark = body.replace(plateRe, '');
const wrap = inner => openTag + inner + '</svg>';

const ink = [parseInt(INK.slice(1, 3), 16), parseInt(INK.slice(3, 5), 16), parseInt(INK.slice(5, 7), 16)];

/** Rasterise an SVG to a square PNG, optionally over an opaque ink plate. */
async function raster(svgText, size, { opaque = false } = {}) {
  const art = await sharp(Buffer.from(svgText), { density: Math.round((72 * RENDER) / 512) })
    .resize(size, size, { fit: 'contain', kernel: 'lanczos3' })
    .png()
    .toBuffer();

  if (!opaque) return sharp(art).png({ compressionLevel: 9, effort: 10, palette: false }).toBuffer();

  return sharp({ create: { width: size, height: size, channels: 4, background: INK } })
    .composite([{ input: art }])
    .flatten({ background: INK })
    .removeAlpha() /* RGB, not RGBA-with-opaque-alpha: nothing downstream can then make it transparent */
    .png({ compressionLevel: 9, effort: 10, palette: false })
    .toBuffer();
}

/** Largest distance from the centre to a pixel the test accepts. */
async function maxRadius(buf, isContent) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const c = (info.width - 1) / 2;
  let max = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      if (!isContent(data[i], data[i + 1], data[i + 2], data[i + 3])) continue;
      const d = Math.hypot(x - c, y - c);
      if (d > max) max = d;
    }
  }
  return max;
}
const notInk = (r, g, b, a) => a > 8 && Math.abs(r - ink[0]) + Math.abs(g - ink[1]) + Math.abs(b - ink[2]) > 24;
const opaquePixel = (r, g, b, a) => a > 8;

/* --- maskable: measure the mark at 512, then scale it into the safe circle ------------------- */
const bare = await raster(wrap(mark), 512);
const reach = await maxRadius(bare, opaquePixel);
if (!reach) throw new Error('The mark rendered empty; cannot derive the maskable scale.');
const scale = (SAFE / reach) * 0.96; /* 4% inside the circle absorbs the antialiased edge */
const maskableSvg = wrap(`<rect width="512" height="512" fill="${INK}"/>` +
  `<g transform="translate(256 256) scale(${scale.toFixed(4)}) translate(-256 -256)">${mark}</g>`);

/* --- write ---------------------------------------------------------------------------------- */
await mkdir(OUT, { recursive: true });
const jobs = [
  [`${OUT}/favicon-32x32.png`, wrap(body), 32, { opaque: false }],
  [`${OUT}/apple-touch-icon-v1.png`, wrap(body), 180, { opaque: true }],
  [`${OUT}/icon-192-v1.png`, wrap(body), 192, { opaque: true }],
  [`${OUT}/icon-512-v1.png`, wrap(body), 512, { opaque: true }],
  [`${OUT}/icon-maskable-512-v1.png`, maskableSvg, 512, { opaque: true }],
];

for (const [file, svgText, size, opts] of jobs) {
  const buf = await raster(svgText, size, opts);
  await writeFile(file, buf);
  const m = await sharp(buf).metadata();
  const kb = ((await stat(file)).size / 1024).toFixed(1);
  const alpha = m.hasAlpha ? 'alpha-channel' : 'no-alpha';
  console.log(`${file.padEnd(38)} ${m.width}x${m.height}  ${alpha.padEnd(13)} ${kb} KB`);
  if (m.width !== size || m.height !== size) throw new Error(file + ' came out ' + m.width + 'x' + m.height);
}

/* --- assert the maskable safe zone --------------------------------------------------------- */
const maskable = await readFile(`${OUT}/icon-maskable-512-v1.png`);
const outReach = await maxRadius(maskable, notInk);
console.log(`maskable: mark reaches r=${outReach.toFixed(1)} of ${SAFE} (safe circle), scale ${scale.toFixed(4)}`);
if (outReach > SAFE) throw new Error('The maskable icon spills outside the 80% safe circle.');

/* --- assert opacity where it matters ------------------------------------------------------- */
for (const f of ['apple-touch-icon-v1.png', 'icon-192-v1.png', 'icon-512-v1.png', 'icon-maskable-512-v1.png']) {
  const { data, info } = await sharp(`${OUT}/${f}`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let clear = 0;
  for (let i = 3; i < data.length; i += info.channels) if (data[i] < 255) clear++;
  if (clear) throw new Error(`${f} has ${clear} non-opaque pixels; iOS and Android need a solid square.`);
}
console.log('all app icons are fully opaque');
