/**
 * verify-hero.mjs — network + console checks for the hero, in real Chromium.
 *
 *   node scripts/verify-hero.mjs video      # HERO_MODE = 'video': zero slider image requests
 *   node scripts/verify-hero.mjs slider     # HERO_MODE = 'slider': correct file per viewport
 *
 * Serves nothing itself: expects http://127.0.0.1:8123 to be the project root.
 */
import { chromium } from 'playwright';

const MODE = process.argv[2] || 'video';
const BASE = 'http://127.0.0.1:8123/index.html';
const VIEWPORTS = [
  { name: 'desktop 1440x900', width: 1440, height: 900, dpr: 1 },
  { name: 'phone 390x844', width: 390, height: 844, dpr: 3, isMobile: true, hasTouch: true },
  { name: 'tablet 768x1024', width: 768, height: 1024, dpr: 2, isMobile: true, hasTouch: true },
];

const SLIDER = /hero-[123](-m)?\.(avif|webp|png)/;

const browser = await chromium.launch();
let bad = 0;

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dpr,
    isMobile: !!vp.isMobile,
    hasTouch: !!vp.hasTouch,
  });
  const page = await ctx.newPage();
  const reqs = [];
  const errors = [];
  page.on('request', (r) => reqs.push(r.url()));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForTimeout(3500);

  const sliderHits = [...new Set(reqs.filter((u) => SLIDER.test(u)))].map((u) => u.split('/').pop());
  const allHero = [...new Set(reqs.filter((u) => /assets\/images\/hero\//.test(u)))].map((u) => u.split('/').pop());

  /* what the <img> actually settled on, and how big it is */
  const picked = await page.evaluate(() => {
    const im = document.querySelector('.hero .slide.on img') || document.querySelector('.hero .slide img');
    if (!im) return null;
    return { src: (im.currentSrc || im.src || '').split('/').pop(), w: im.naturalWidth, h: im.naturalHeight };
  });
  const stacked = await page.evaluate(() => document.documentElement.classList.contains('hero-stack'));

  console.log(`\n== ${MODE} · ${vp.name}`);
  console.log('   hero image requests:', sliderHits.length ? sliderHits.join(', ') : '(none)');
  console.log('   all /hero/ requests:', allHero.length ? allHero.join(', ') : '(none)');
  if (picked) console.log('   slide img:', picked.src, `${picked.w}x${picked.h}`);
  console.log('   hero-stack class:', stacked);
  console.log('   console errors:', errors.length ? errors.join(' | ') : 'none');

  if (MODE === 'video' && sliderHits.length) { console.log('   FAIL: slider images requested in video mode'); bad++; }
  if (errors.length) bad++;

  await page.screenshot({ path: `_shots/hero-${MODE}-${vp.width}.png` });
  await ctx.close();
}

await browser.close();
console.log(bad ? `\n${bad} problem(s)` : '\nOK');
process.exitCode = bad ? 1 : 0;
