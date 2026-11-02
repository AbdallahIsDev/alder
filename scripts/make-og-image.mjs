#!/usr/bin/env node
/* ============================================================================================
   make-og-image.mjs : turn one picture into the 1200x630 social card.

   Every network that renders a link preview asks for exactly one image and caches it by URL,
   so the file has to be 1200x630, under 300 KB, and named for its version (og-image-v1.jpg,
   -v2, ...). Overwriting a name is how you end up with an old picture in a new post.

   The card this site ships is client art (assets/images/og-image.jpg), so this is the fallback
   generator: it writes a new versioned name, never over that file. Point BIZ.ogImage at whatever
   you generate.

   Usage
     node scripts/make-og-image.mjs                              hero poster -> assets/images/og-image-v1.jpg
     node scripts/make-og-image.mjs --src art.png --out assets/images/og-image-v2.jpg
     node scripts/make-og-image.mjs --src art.png --preview _shots/og-300.png

   --src      source picture (anything sharp reads). Default: assets/images/hero/hero-poster.webp
   --out      destination .jpg. Default: assets/images/og-image-v1.jpg
   --gravity  centre (default), north, south, east, west, or "x,y" percentages for the crop anchor
   --preview  also write a 300px-wide copy, to check the card still reads at thumbnail size

   The picture is centre-cropped to 5.6:2.94 (never stretched), converted to sRGB, flattened onto
   the page ink, stripped of metadata, and encoded at the highest JPEG quality that stays under
   300 KB, never below 78. No text is drawn: the card is the photograph.
   ============================================================================================ */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const args = process.argv.slice(2);
const opt = { src: 'assets/images/hero/hero-poster.webp', out: 'assets/images/og-image-v1.jpg', gravity: 'centre', preview: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--src') opt.src = args[++i];
  else if (a === '--out') opt.out = args[++i];
  else if (a === '--gravity') opt.gravity = args[++i];
  else if (a === '--preview') opt.preview = args[++i];
  else { console.error('make-og-image: unknown option ' + a); process.exit(1); }
}

const W = 1200, H = 630, LIMIT = 300 * 1024, MIN_Q = 78;
const gravity = /^\d+(\.\d+)?,\d+(\.\d+)?$/.test(opt.gravity)
  ? { x: parseFloat(opt.gravity.split(',')[0]) / 100, y: parseFloat(opt.gravity.split(',')[1]) / 100 }
  : opt.gravity;

if (!fs.existsSync(opt.src)) { console.error('make-og-image: source not found: ' + opt.src); process.exit(1); }

const meta = await sharp(opt.src).metadata();
const ratio = meta.width / meta.height, target = W / H;
const crop = ratio > target
  ? `crop ${Math.round(meta.height * target)}x${meta.height} from ${meta.width}x${meta.height} (side trim)`
  : `crop ${meta.width}x${Math.round(meta.width / target)} from ${meta.width}x${meta.height} (top/bottom trim)`;

/* cover = crop to the target ratio, then scale. Never a stretch. */
const base = await sharp(opt.src)
  .rotate()
  .resize(W, H, { fit: 'cover', position: gravity, kernel: 'lanczos3' })
  .flatten({ background: '#1c1f24' })
  .toColourspace('srgb')
  .toBuffer();

let buf = null, quality = 0;
for (let q = 88; q >= MIN_Q; q -= 2) {
  const candidate = await sharp(base).jpeg({ quality: q, mozjpeg: true, progressive: true, chromaSubsampling: '4:4:4' }).toBuffer();
  if (candidate.length <= LIMIT) { buf = candidate; quality = q; break; }
}
if (!buf) {
  console.error(`make-og-image: even quality ${MIN_Q} is over 300 KB. Crop tighter or start from a cleaner picture.`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(path.resolve(opt.out)), { recursive: true });
fs.writeFileSync(opt.out, buf);

const outMeta = await sharp(buf).metadata();
console.log(`make-og-image: ${opt.out}`);
console.log(`  source ${meta.width}x${meta.height} (${meta.format}) -> ${crop}`);
console.log(`  out ${outMeta.width}x${outMeta.height} ${outMeta.format} ${outMeta.space} quality ${quality} ${(buf.length / 1024).toFixed(1)} KB`);

if (opt.preview) {
  fs.mkdirSync(path.dirname(path.resolve(opt.preview)), { recursive: true });
  await sharp(buf).resize(300, null, { kernel: 'lanczos3' }).png().toFile(opt.preview);
  console.log(`  preview ${opt.preview} (300px wide)`);
}
