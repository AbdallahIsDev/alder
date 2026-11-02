// Renders the site icon set from assets/images/favicon.svg.
//
// The master is a 512x512 vector: ink plate (rx 112), accent roof band + chimney, white house.
// PNGs are rendered with a high density so the vector rasterises at full resolution rather than
// being upscaled from a 72dpi raster, then resized with lanczos3.
//
// apple-touch-icon and the manifest icons get an opaque ink backing: iOS paints transparency as
// black, and Android masks "any" purpose icons, so a transparent corner shows through as a dark
// notch. The plate colour is the same ink, so the artwork is unchanged apart from its corners.
//
// Usage: node scripts/make-icons.mjs
import { readFile, stat } from 'node:fs/promises';
import sharp from 'sharp';

const SRC = 'assets/images/favicon.svg';
const OUT = 'assets/images';
const INK = '#1C1F24';

/** Render the SVG at `size`, optionally over an opaque plate. */
async function render(svg, size, { opaque = false } = {}) {
  const art = await sharp(svg, { density: Math.ceil((72 * size) / 512) })
    .resize(size, size, { kernel: 'lanczos3' })
    .png()
    .toBuffer();

  if (!opaque) return sharp(art).png({ compressionLevel: 9 }).toBuffer();

  return sharp({ create: { width: size, height: size, channels: 4, background: INK } })
    .composite([{ input: art }])
    .flatten({ background: INK })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

const svg = await readFile(SRC);
const jobs = [
  ['favicon-32x32.png', 32, { opaque: false }],
  ['apple-touch-icon.png', 180, { opaque: true }],
  ['icon-192.png', 192, { opaque: true }],
  ['icon-512.png', 512, { opaque: true }],
];

for (const [name, size, opts] of jobs) {
  const buf = await render(svg, size, opts);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(`${OUT}/${name}`, buf);
  const { width, height, channels, hasAlpha } = await sharp(buf).metadata();
  const kb = ((await stat(`${OUT}/${name}`)).size / 1024).toFixed(1);
  console.log(
    `${name.padEnd(22)} ${width}x${height}  ${channels}ch  alpha=${hasAlpha ? 'yes' : 'no'}  ${kb} KB`,
  );
}
