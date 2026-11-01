/**
 * posters.mjs — the hero poster stills, from frame 0 of the source clip.
 *
 *   desktop: 1920x1080  -> hero-poster.avif / hero-poster.webp
 *   phone:   864x1080   -> hero-poster-mobile.avif / hero-poster-mobile.webp  (the same 4:5 centre crop as
 *                          hero-mobile.mp4, at the crop's native size)
 *
 * AVIF takes the highest quality that still fits the byte budget; WebP is the fallback and is encoded at a
 * fixed high quality, because it only ships to browsers that cannot read AVIF.
 */
import sharp from 'sharp';
import fs from 'node:fs/promises';
import { ssim } from 'ssim.js';

const AVIF_BUDGET = 120 * 1024;
const MOBILE_AVIF_BUDGET = 96 * 1024;
const WEBP_Q = 60;   // the fallback only ships to browsers without AVIF; q82 cost 485 KB for a still that is on screen for a moment

const kb = (n) => (n / 1024).toFixed(0) + ' KB';
const asClamped = (b) => new Uint8ClampedArray(b.buffer, b.byteOffset, b.length);

async function score(buf, ref) {
  const { data, info } = await sharp(buf).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return ssim(
    { data: asClamped(ref.data), width: ref.info.width, height: ref.info.height },
    { data: asClamped(data), width: info.width, height: info.height },
    { downsample: 'fast' }
  ).mssim;
}

async function run(src, name, budget) {
  const ref = await sharp(src).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let best = null;
  for (let q = 72; q >= 16; q -= 2) {
    const buf = await sharp(src).toColourspace('srgb').avif({ quality: q, effort: 6, chromaSubsampling: '4:4:4' }).toBuffer();
    if (buf.length <= budget) { best = { q, buf }; break; }
  }
  if (!best) throw new Error(`${name}: nothing fits ${budget}`);
  await fs.writeFile(`assets/images/hero/${name}.avif`, best.buf);
  console.log(`${name}.avif  q${best.q}  ${kb(best.buf.length)}  ssim ${(await score(best.buf, ref)).toFixed(4)}`);

  const w = await sharp(src).toColourspace('srgb').webp({ quality: WEBP_Q, effort: 6, smartSubsample: true }).toBuffer();
  await fs.writeFile(`assets/images/hero/${name}.webp`, w);
  console.log(`${name}.webp  q${WEBP_Q}  ${kb(w.length)}  ssim ${(await score(w, ref)).toFixed(4)}`);
}

await run('_shots/vid/poster-frame.png', 'hero-poster', AVIF_BUDGET);
await run('_shots/vid/poster-frame-m.png', 'hero-poster-mobile', MOBILE_AVIF_BUDGET);
