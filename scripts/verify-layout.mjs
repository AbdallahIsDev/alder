/**
 * verify-layout.mjs — stacked hero layout at the four required sizes + desktop regression.
 */
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:8123/index.html';
const VPS = [
  { name: 'phone 390x844', width: 390, height: 844, dpr: 3, isMobile: true },
  { name: 'phone 360x640', width: 360, height: 640, dpr: 2, isMobile: true },
  { name: 'tablet 768x1024', width: 768, height: 1024, dpr: 2, isMobile: true },
  { name: 'landscape 844x390', width: 844, height: 390, dpr: 2, isMobile: true },
  { name: 'desktop 1440x900', width: 1440, height: 900, dpr: 1, isMobile: false },
];

const browser = await chromium.launch();
for (const vp of VPS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dpr,
    isMobile: vp.isMobile,
    hasTouch: vp.isMobile,
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  const m = await page.evaluate(() => {
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { t: +b.top.toFixed(1), b: +b.bottom.toFixed(1), l: +b.left.toFixed(1), r: +b.right.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
    const hero = document.querySelector('.hero');
    const media = document.querySelector('.hero-video') || document.querySelector('.slide.on');
    const inner = document.querySelector('.hero-in');
    const h1 = document.querySelector('.hero h1');
    const btn = document.querySelector('.hero .cta .btn');
    const cs = media ? getComputedStyle(media) : null;
    return {
      vw: innerWidth, vh: innerHeight,
      hm: getComputedStyle(document.documentElement).getPropertyValue('--hm').trim(),
      hero: r(hero), media: r(media), inner: r(inner), h1: r(h1), btn: r(btn),
      mediaPos: cs ? cs.position : null, mediaHeight: cs ? cs.height : null,
      heroMinH: getComputedStyle(hero).minHeight,
      heroBg: getComputedStyle(hero).backgroundColor,
      docH: document.documentElement.scrollHeight,
    };
  });

  const gap = m.media && m.inner ? +(m.inner.t - m.media.b).toFixed(1) : null;
  console.log(`\n== ${vp.name}  (--hm ${m.hm || '-'})`);
  console.log(`   hero ${JSON.stringify(m.hero)}`);
  console.log(`   media ${JSON.stringify(m.media)} pos=${m.mediaPos} h=${m.mediaHeight}`);
  console.log(`   .hero-in top=${m.inner.t}  gap media->text ${gap}px   min-height=${m.heroMinH} bg=${m.heroBg}`);
  console.log(`   h1 ${JSON.stringify(m.h1)}   cta ${JSON.stringify(m.btn)}`);
  console.log(`   doc height ${m.docH}, errors: ${errs.length ? errs.join('|') : 'none'}`);

  await page.screenshot({ path: `_shots/layout-${vp.width}x${vp.height}.png` });

  /* scroll to the footer to make sure the sticky footer + header still behave */
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(1200);
  const foot = await page.evaluate(() => {
    const f = document.querySelector('footer');
    const b = f.getBoundingClientRect();
    return { footerVisible: b.top < innerHeight, atFt: document.documentElement.classList.contains('at-ft'), hdrHidden: document.querySelector('header').getBoundingClientRect().top < -10 };
  });
  console.log(`   footer: ${JSON.stringify(foot)}`);
  await page.screenshot({ path: `_shots/layout-${vp.width}x${vp.height}-foot.png` });
  await ctx.close();
}
await browser.close();
