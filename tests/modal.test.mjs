#!/usr/bin/env node
// tests/modal.test.mjs — Gate MD (the estimate form's options and its close rules).
// HARNESS: no database, no network. The page is read as text, built with
// build-static.js for two clients, and its real scripts are run in JSDOM.
//
// What it proves:
//   MD1 the form's four service options are the services section's four
//       services: the SAME tokens in the same order, no title written twice;
//       the stored values did not move and are the API's allow-list
//   MD2 the no-JavaScript form offers the same four, from the same tokens
//   MD3 the built Alder page: the three places show identical words, the
//       fourth is "Free roof inspection", "Not sure yet" is gone
//   MD4 another client's build follows its own services (one source of truth)
//   MD5 every stored service value has a label for alerts and lists; the
//       fourth reads "Roof inspection"
//   MD6 closing is deliberate: a click on the dimmed area does nothing and
//       what was typed stays; the X, Escape and the last panel's Close close
//   MD7 the X is 32px (16px icon) on every screen; the press area is 44px on
//       desktop and 32px on phones
//   MD8 the thank-you pane: three groups in order (mark + heading, recap,
//       next steps with both buttons), the reveal order set on those groups'
//       own classes rather than on :nth-child, and every "what happens next"
//       line short enough to stay one line in the 246px box it gets at 320px
//   MD12 the debug panel no longer has a corner-radius control; delays remain
//   MD13 DEV-only auto-open ms inputs write into AUTO.delayMs, in memory only
//   MD14 the radius rule covers EVERY visible box sitewide: arrow squares, badge/label
//       dots, step squares, before/after arrows and tags, review cards and images,
//       FAQ cards, all modal option cards, fields, checkboxes, the close button and
//       the whole success screen; round-by-design and full-screen layers stay out
//   MD15 the primary CTA's white square is a real rounded box (7px) permanently
//   MD16 the permanent radii: 12px base, 24px standalone images and review cards,
//       12px review-card image, 48px CTA section, one resting border per field
//       with focus changing its colour only, and ONE accent focus ring
//   MD22 resting look: no accent bar on the selected dropdown row (weight + the
//       accent check mark instead), a pointer on every pressable button, no ring
//       on a mouse press, one consent sentence, and an auto-open that focuses
//       the dialog rather than a field
//   MD23 a draft is restored only when it holds a real answer, is from this day
//       and does not contradict the live form; an invitation focuses the dialog
//
// Mutations (each breaks the check named):
//   put a literal title back into an option                      -> MD1, MD3
//   change a stored value (unsure -> inspection)                 -> MD1, MD5
//   put data-close back on .est-scrim                            -> MD6
//   make the X 40px again, or give phones a 44px press area      -> MD7
//   move the buttons back out of .est-next-group                 -> MD8
//   go back to :nth-child delays                                 -> MD8
//   lengthen one "what happens next" line past 34 characters     -> MD8
//   drop a boxed selector from the radius rule                   -> MD14

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '_debug', 'modal-build');

let total = 0, failed = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(58)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 150) : ''}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const strip = (s) => s.replace(/ data-page-node-id="[^"]*"/g, '');

/** [{ value, title, hint }] of the form's service cards, from page text. */
const modalOptions = (html) => [...strip(html).matchAll(/<input type="radio" name="service" value="([^"]*)"><b>([^<]*)<\/b><small>([^<]*)<\/small>/g)]
  .map((m) => ({ value: m[1], title: m[2], hint: m[3] }));
/** [{ value, title }] of the no-JS form's service <select>. */
const noscriptOptions = (html) => {
  const sel = /<select id="ns-service"[^>]*>([\s\S]*?)<\/select>/.exec(html);
  return sel ? [...sel[1].matchAll(/<option value="([^"]+)">([^<]*)<\/option>/g)].map((m) => ({ value: m[1], title: m[2] })) : [];
};
/** The four headings of the services section. */
const serviceHeadings = (html) => {
  const sec = /<section class="wrap services"[\s\S]*?<\/section>/.exec(strip(html));
  return sec ? [...sec[0].matchAll(/<div class="card-text"><h3>([^<]*)<\/h3>/g)].map((m) => m[1]) : [];
};
const build = (client) => {
  const out = path.join(OUT, client, 'index.html');
  const r = spawnSync(process.execPath, ['build-static.js', 'index.html', '--client', client, '--out', out], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  return r.status === 0 ? fs.readFileSync(out, 'utf8') : null;
};

try {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'assets/css/styles.css'), 'utf8');
  const tokensCss = fs.readFileSync(path.join(ROOT, 'assets/css/tokens.generated.css'), 'utf8');
  const leadSrc = fs.readFileSync(path.join(ROOT, 'api/lead.js'), 'utf8');
  const SERVICES = JSON.parse(/const SERVICES = (\[[^\]]*\]);/.exec(leadSrc)[1].replace(/'/g, '"'));
  const VALUES = ['replacement', 'storm', 'repair', 'unsure'];

  /* MD1 */
  {
    const heads = serviceHeadings(html);
    const opts = modalOptions(html);
    const tokens = heads.every((h) => /^\{\{services\d+\}\}$/.test(h)) && heads.length === 4 && new Set(heads).size === 4;
    const sameSource = same(opts.map((o) => o.title), heads);
    const hints = opts.every((o) => /^\{\{\w+\}\}$/.test(o.hint)) && new Set(opts.map((o) => o.hint)).size === 4;
    const values = same(opts.map((o) => o.value), VALUES) && same(SERVICES, VALUES);
    line(tokens && sameSource && hints && values, 'MD1', 'the form offers the services section\'s four services',
      `tokens=${tokens} sameSource=${sameSource} hints=${hints} values=${values} titles=${opts.map((o) => o.title).join(',')}`);
  }

  /* MD2 */
  {
    const ns = noscriptOptions(html);
    const ok = same(ns.map((o) => o.value), VALUES) && same(ns.map((o) => o.title), serviceHeadings(html));
    line(ok, 'MD2', 'the no-JavaScript form offers the same four', ns.map((o) => `${o.value}=${o.title}`).join(' '));
  }

  /* MD3 */
  fs.rmSync(OUT, { recursive: true, force: true });
  {
    const built = build('alder');
    const heads = built ? serviceHeadings(built) : [];
    const opts = built ? modalOptions(built) : [];
    const ns = built ? noscriptOptions(built) : [];
    const ok = !!built && heads.length === 4 && same(opts.map((o) => o.title), heads) && same(ns.map((o) => o.title), heads)
      && heads[3] === 'Free roof inspection' && opts[3].value === 'unsure' && ns[3].value === 'unsure'
      && opts.every((o) => o.hint.length > 0 && o.hint.length <= 34 && !o.hint.includes('{{'))
      && !/Not sure yet|A free inspection will tell us|Storm or hail damage|Repair or leak/.test(built);
    line(ok, 'MD3', 'built page: the same words three times, the 4th is the inspection',
      built ? `headings=${heads.join(' | ')} hint4=${opts[3] && opts[3].hint}` : 'build failed');
  }

  /* MD4 */
  {
    const built = build('example');
    const heads = built ? serviceHeadings(built) : [];
    const ok = !!built && heads.length === 4 && same(modalOptions(built).map((o) => o.title), heads) && same(noscriptOptions(built).map((o) => o.title), heads)
      && !heads.includes('Free roof inspection') && same(modalOptions(built).map((o) => o.value), VALUES);
    line(ok, 'MD4', 'another client: its own four services, the same values', built ? heads.join(' | ') : 'build failed');
  }
  fs.rmSync(OUT, { recursive: true, force: true });

  /* MD5 */
  {
    const C = await import('../lib/content.js');
    const labels = SERVICES.map((v) => C.serviceLabel(v));
    const ok = same(Object.keys(C.LABELS.service), SERVICES) && labels.every((l, i) => l && l !== SERVICES[i])
      && C.serviceLabel('unsure') === 'Roof inspection' && !labels.includes('Not sure');
    line(ok, 'MD5', 'every stored value has a label; the 4th is "Roof inspection"', labels.join(' | '));
  }

  /* MD6: the page's own scripts, in JSDOM. */
  {
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://alder.test/',
      virtualConsole: new (await import('jsdom')).VirtualConsole(),   // external scripts are not loaded: their errors are noise
      beforeParse(window) {
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        window.scrollTo = () => {};
        window.CSS = { supports: () => true };
      },
    });
    const w = dom.window, d = w.document;
    const root = d.getElementById('est');
    const opener = d.querySelector('[data-open-estimate]');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    const isOpen = () => root.classList.contains('open') && root.getAttribute('aria-hidden') === 'false';
    const scrim = d.querySelector('.est-scrim');

    click(opener); await wait(120);
    const opened = isOpen();
    // Something typed, then a click (and a touch-style mousedown / mouseup) beside the dialog.
    const zip = d.getElementById('e-zip'); zip.value = '50265';
    const pick = d.querySelector('input[name="service"][value="unsure"]'); pick.checked = true;
    for (const type of ['mousedown', 'mouseup']) scrim.dispatchEvent(new w.MouseEvent(type, { bubbles: true }));
    click(scrim); click(root); await wait(120);
    const stayed = isOpen() && zip.value === '50265' && pick.checked === true;
    const marked = !scrim.hasAttribute('data-close') && d.querySelectorAll('#est [data-close]').length === 2;
    // The deliberate ways out.
    click(d.querySelector('.est-x')); await wait(120);
    const byX = !isOpen() && zip.value === '50265';                 // closing by hand keeps the answers
    click(opener); await wait(120);
    const again = isOpen();
    w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(120);
    const byEsc = !isOpen();
    click(opener); await wait(120);
    const closeBtn = d.querySelector('.est-done .btn.ghost[data-close]');
    click(closeBtn); await wait(120);
    const byClose = !!closeBtn && closeBtn.textContent === 'Close' && !isOpen();
    w.close();
    line(opened && stayed && marked && byX && again && byEsc && byClose, 'MD6', 'outside click does nothing; X, Escape and Close close',
      `opened=${opened} stayed=${stayed} marked=${marked} x=${byX} esc=${byEsc} close=${byClose}`);
  }

  /* MD7 */
  {
    const block = (sel) => { const m = new RegExp(sel.replace(/[.:]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(css); return m ? m[1].replace(/\s+/g, ' ') : ''; };
    const media = (px) => {
      const found = [], needle = `@media (max-width: ${px}px)`;
      let from = 0;
      for (;;) {
        const i = css.indexOf(needle, from);
        if (i < 0) break;
        const open = css.indexOf('{', i);
        let depth = 0, close = -1;
        for (let j = open; j < css.length; j++) {
          if (css[j] === '{') depth++;
          else if (css[j] === '}') { depth--; if (depth === 0) { close = j; break } }
        }
        if (close < 0) break;
        found.push(css.slice(open, close + 1));
        from = close + 1;
      }
      return found;
    };
    const x = block('.est-x'), after = block('.est-x::after'), svg = block('.est-x svg');
    const size = /width: 32px;/.test(x) && /height: 32px;/.test(x) && /position: relative;/.test(x);
    const desktopPress = /content: "";/.test(after) && /position: absolute;/.test(after) && /inset: -6px/.test(after);
    /* BEFORE: the one base ::after rule (inset:-6px => 44px) was asserted for every screen.
       AFTER: that rule is the desktop target; at <=760px a second rule sets inset:0, so the
       press area is the visible 32px box. The icon and box size are unchanged everywhere. */
    const phonePress = media(760).some(b => /\.est-x::after\s*\{[^}]*inset:\s*0\s*;?\s*\}/.test(b));
    // One box rule only: no media query gives the button another size.
    const once = (css.match(/\.est-x\s*\{/g) || []).length === 1;
    const button = /<button type="button" class="est-x" data-close aria-label="Close"/.test(strip(html));
    line(size && desktopPress && phonePress && once && /width: 16px;/.test(svg) && button,
      'MD7', 'the X: 32px + 16px icon everywhere, 44px desktop / 32px phone press area',
      `size=${size} desktop=${desktopPress} phone=${phonePress} once=${once} button=${button}`);
  }

  /* MD8: the thank-you pane. It is three groups now, not five siblings, so the
     reveal order must not be numbered by position. Parsed as DOM, not as text:
     "the buttons are inside the group" is a nesting question, and an index
     comparison cannot answer it. The three "what happens next" lines are the
     visitor's promise, so they are held to the line budget measured in a
     browser: the text box is 246px wide at 320px and the longest of the three
     measures 192px, about 6.6px a character. 34 characters keeps every one of
     them on a single line at 320, 375 and desktop width. */
  {
    const d = new JSDOM(html).window.document;
    const pane = d.querySelector('.est-done');
    // MEANING CHANGE 2026-11-28 (item 16): a held answer inserts its amber
    // notice box between the heading and the recap. It is hidden on the normal
    // success screen, so the three reveal groups and their order stay as they
    // were. The DOM now has four children, in this order.
    const kids = pane ? [...pane.children].map((c) => c.className) : [];
    const order = same(kids, ['est-done-top', 'est-warn', 'est-recap', 'est-next-group']);
    // group 1: the mark and the split heading, side by side
    const top = pane && pane.querySelector(':scope > .est-done-top');
    const topOk = !!top && !!top.querySelector('.est-ok') && top.querySelector('.est-head h3#est-thanks')?.textContent.trim().length > 0
      && top.querySelector('.est-head p.lead')?.textContent.trim().length > 0;
    // group 3: the steps and BOTH buttons, inside the group
    const group = pane && pane.querySelector(':scope > .est-next-group');
    const steps = group ? [...group.querySelectorAll('.est-after .est-steps > li')].map((li) => li.textContent.trim()) : [];
    const nextOk = !!group && !!group.querySelector(':scope > .est-after') && !!group.querySelector(':scope > .est-actions')
      && !!group.querySelector('.est-actions button.btn.ghost[data-close]')
      && /^tel:/.test(group.querySelector('.est-actions a.btn.phone')?.getAttribute('href') || '')
      && d.querySelectorAll('.est-done .est-actions').length === 1;
    // the reveal order lives on the groups' classes, never on a child index
    const revealOk = /\.est-done-top\s*\{\s*--i:\s*0\s*\}/.test(css) && /\.est-done>\.est-recap\s*\{\s*--i:\s*1\s*\}/.test(css)
      && /\.est-next-group\s*\{\s*--i:\s*2\s*\}/.test(css)
      && !/\.est-done[^{]*:nth-child/.test(css) && /\.est-done:not\(\[hidden\]\)>\*\s*\{/.test(css);
    // the copy: one line each, and no promise that cannot fit on one
    const copyOk = steps.length === 3 && steps.every((t) => t.length > 0 && t.length <= 34 && !t.includes('{{'));
    line(order && topOk && nextOk && revealOk && copyOk, 'MD8', 'thank-you: three groups, class-set reveal order, one-line steps',
      `order=${order} top=${topOk} next=${nextOk} reveal=${revealOk} copy=${copyOk} longest=${Math.max(0, ...steps.map((t) => t.length))}`);
  }

  /* MD9: the draft. Contact data goes to sessionStorage and nowhere else (it
     must die with the tab), it is written on every step change and every input,
     it comes back when the modal is opened again in the same tab, and it is
     cleared on a definite answer from the server. A browser that refuses
     storage must behave exactly as it did before: the answers live in the open
     page only. Each scenario gets its own page so the storage starts empty. */
  {
    const { VirtualConsole } = await import('jsdom');
    const KEY = 'alder-est-draft-v1';
    const boot = (extra) => {
      const errors = [];
      const vc = new VirtualConsole();
      vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
      const dom = new JSDOM(html, {
        runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://alder.test/', virtualConsole: vc,
        beforeParse(window) {
          window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
          window.scrollTo = () => {};
          window.CSS = { supports: () => true };
          if (extra) extra(window);
        },
      });
      return { dom, w: dom.window, d: dom.window.document, errors };
    };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    const visibleStep = (d) => [...d.querySelectorAll('.est-pane[data-step]')].findIndex((p) => !p.hidden) + 1;
    const draft = (w) => JSON.parse(w.sessionStorage.getItem(KEY) || 'null');

    /* A. an untouched open leaves nothing behind, and typing writes the answers */
    const a = boot();
    click(a.w, a.d.querySelector('[data-open-estimate]'));
    await wait(120);
    click(a.w, a.d.querySelector('.est-x'));
    await wait(120);
    const untouched = a.w.sessionStorage.getItem(KEY) === null;      // the select's own default is not an answer
    click(a.w, a.d.querySelector('[data-open-estimate]'));
    await wait(120);
    const pick = a.d.querySelector('input[name="service"][value="unsure"]');
    pick.checked = true; pick.dispatchEvent(new a.w.Event('change', { bubbles: true }));
    const zip = a.d.getElementById('e-zip');
    zip.value = '50265'; zip.dispatchEvent(new a.w.Event('input', { bubbles: true }));
    const afterTyping = draft(a.w);
    const saves = !!afterTyping && afterTyping.touched === true && afterTyping.values.zip === '50265'
      && afterTyping.values.service === 'unsure' && afterTyping.step === 0;
    /* B. a step change writes the step */
    click(a.w, a.d.querySelector('.est-next'));
    await wait(260);
    const stepped = draft(a.w);
    const stepSaved = stepped && stepped.step === 1 && stepped.values.zip === '50265';
    /* C. reopening in the same tab restores both */
    click(a.w, a.d.querySelector('.est-x'));
    await wait(120);
    click(a.w, a.d.querySelector('[data-open-estimate]'));
    await wait(200);
    const restartBtn = a.d.querySelector('.est-restart');
    const restored = visibleStep(a.d) === 2 && a.d.getElementById('e-zip').value === '50265'
      && (a.d.querySelector('input[name="service"]:checked') || {}).value === 'unsure'
      && !!restartBtn && restartBtn.hidden === false && restartBtn.textContent.trim() === 'Start over';
    /* D. Start over throws the draft away and returns to step 1 */
    click(a.w, restartBtn);
    await wait(220);
    const overOk = a.w.sessionStorage.getItem(KEY) === null && visibleStep(a.d) === 1
      && a.d.getElementById('e-zip').value === '' && !a.d.querySelector('input[name="service"]:checked')
      && a.d.querySelector('.est-restart').hidden === true;
    /* E. a definite answer from the server clears it */
    zip.value = '50267'; zip.dispatchEvent(new a.w.Event('input', { bubbles: true }));
    const beforeAnswer = a.w.sessionStorage.getItem(KEY) !== null;
    a.w.estimateShowSent({ name: 'Sam Ortiz', zip: '50267', phone: '+1 515 555 0100', claim: false }, false, '');
    await wait(80);
    const cleared = a.w.sessionStorage.getItem(KEY) === null && a.d.querySelector('.est-restart').hidden === true;
    /* F. localStorage holds preferences only: a stamp or a flag. The answers and
       the contact details belong in sessionStorage, which dies with the tab. */
    const stored = Object.entries({ ...a.w.localStorage });
    const noLocal = stored.every(([, v]) => /^\d+$/.test(String(v)))
      && !/50265|50267|Sam|Ortiz|unsure|515/.test(JSON.stringify(stored));
    a.w.close();
    line(untouched && saves && stepSaved && restored && overOk && beforeAnswer && cleared && noLocal,
      'MD9', 'draft: written on input and on a step, restored, cleared, no contact in localStorage',
      `untouched=${untouched} saves=${saves} step=${stepSaved} restored=${restored} over=${overOk} cleared=${cleared} local=${noLocal}`);

    /* G. a browser that refuses storage: the modal still works, exactly as before */
    const g = boot((window) => Object.defineProperty(window, 'sessionStorage', { configurable: true, get() { throw new Error('storage blocked'); } }));
    let threw = false;
    try { void g.w.sessionStorage; } catch { threw = true; }
    click(g.w, g.d.querySelector('[data-open-estimate]'));
    await wait(120);
    const openOk = g.d.getElementById('est').classList.contains('open');
    const gzip = g.d.getElementById('e-zip');
    g.d.querySelector('input[name="service"][value="repair"]').checked = true;
    gzip.value = '50266'; gzip.dispatchEvent(new g.w.Event('input', { bubbles: true }));
    click(g.w, g.d.querySelector('.est-next'));
    await wait(260);
    // jsdom has no IntersectionObserver or media pipeline: those errors are the
    // harness, not the page. What must not appear is the storage error escaping.
    const survived = openOk && visibleStep(g.d) === 2 && g.d.getElementById('e-zip').value === '50266'
      && g.errors.filter((m) => /storage blocked/.test(m)).length === 0;
    g.w.close();
    line(threw && survived, 'MD9b', 'storage that throws: no error, the form works as before',
      `threw=${threw} open=${openOk} survived=${survived} errors=${g.errors.length}`);
  }

  /* MD10: the invitation. One automatic open per tab session, 10 s after load
     on a desktop and 8 s on a phone, from one config object. jsdom has no
     layout and no clock, so the two things the rule reads are stubbed on
     purpose: the section's rect (this suite proves the rule READS a rect, not
     what a browser computes) and the timer (the page's timer is captured by its
     own name, so the delay constant can be asserted instead of waited for). */
  {
    const { VirtualConsole } = await import('jsdom');
    const boot = ({ width = 1024, rectBottom = 100, seed = {}, visibility = 'visible' } = {}) => {
      const timers = [], vis = { now: visibility };
      const dom = new JSDOM(html, {
        runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://alder.test/', virtualConsole: new VirtualConsole(),
        beforeParse(window) {
          window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
          window.scrollTo = () => {};
          window.CSS = { supports: () => true };
          Object.defineProperty(window, 'innerWidth', { configurable: true, get: () => width });
          Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => vis.now });
          window.Element.prototype.getBoundingClientRect = function () {
            return { top: rectBottom - 100, bottom: rectBottom, left: 0, right: 320, width: 320, height: 100, x: 0, y: rectBottom - 100 };
          };
          const realSetTimeout = window.setTimeout.bind(window);
          window.setTimeout = function (fn, ms) { timers.push({ fn, ms }); return realSetTimeout(fn, ms); };
          for (const [k, v] of Object.entries(seed)) window.localStorage.setItem(k, v);
        },
      });
      const w = dom.window;
      return { dom, w, d: w.document, vis, invite: () => timers.filter((t) => t.fn && t.fn.name === 'estInvite') };
    };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    const isOpen = (x) => x.d.getElementById('est').classList.contains('open');
    const invited = (x) => x.w.sessionStorage.getItem('alder-est-invited-v1');
    const fire = async (x) => { const t = x.invite(); if (t.length === 1) t[0].fn(); await wait(150); return t; };

    /* the delay, and never on first paint */
    const desk = boot();
    const deskTimers = desk.invite();
    const noFirstPaint = !isOpen(desk);
    await fire(desk);
    const openedOnce = isOpen(desk) && deskTimers.length === 1 && deskTimers[0].ms === 10000 && invited(desk) === '1';
    click(desk.w, desk.d.querySelector('.est-x'));
    await wait(120);
    await fire(desk);
    const oncePerSession = !isOpen(desk);       /* the second call has nothing left to do */
    desk.w.close();
    const mob = boot({ width: 375 });
    const mobTimers = mob.invite();
    await fire(mob);
    const phoneDelay = mobTimers.length === 1 && mobTimers[0].ms === 8000 && isOpen(mob);
    mob.w.close();
    line(noFirstPaint && openedOnce && oncePerSession && phoneDelay,
      'MD10', 'invitation: 10 s desktop, 8 s phone, opened once per session',
      `paint=${noFirstPaint} opened=${openedOnce} once=${oncePerSession} phone=${phoneDelay}`);

    /* every guard, one at a time */
    const closed = boot(); await fire(closed);
    click(closed.w, closed.d.querySelector('.est-x')); await wait(120);
    const stamp = Number(closed.w.localStorage.getItem('alder-est-closed-until-v1'));
    const stampOk = Math.abs(stamp - (Date.now() + 30 * 24 * 3600 * 1000)) < 5 * 60000;
    closed.w.close();
    const suppressed = boot({ seed: { 'alder-est-closed-until-v1': String(Date.now() + 29 * 24 * 3600 * 1000) } });
    await fire(suppressed); const heldByClose = !isOpen(suppressed); suppressed.w.close();
    const expired = boot({ seed: { 'alder-est-closed-until-v1': String(Date.now() - 1000) } });
    await fire(expired); const expiredInvites = isOpen(expired); expired.w.close();
    const sent = boot({ seed: { 'alder-est-sent-v1': '1' } });
    await fire(sent); const afterSubmit = !isOpen(sent); sent.w.close();
    const sending = boot();
    sending.d.getElementById('est').classList.add('open');          /* the modal, opened by hand */
    await fire(sending); const whileOpen = invited(sending) === null; sending.w.close();
    const menu = boot();
    menu.d.getElementById('menu').classList.add('open');            /* the menu overlay */
    await fire(menu); const whileMenu = !isOpen(menu) && invited(menu) === null; menu.w.close();
    const scrolled = boot({ rectBottom: -40 });                     /* scrolled past the first section */
    await fire(scrolled); const pastFirst = !isOpen(scrolled); scrolled.w.close();
    const clicked = boot();
    click(clicked.w, clicked.d.querySelector('[data-open-estimate]')); await wait(120);
    click(clicked.w, clicked.d.querySelector('.est-x')); await wait(120);
    clicked.w.localStorage.clear();               /* the 30-day stamp is not the reason here; the click is */
    await fire(clicked); const afterCta = !isOpen(clicked) && invited(clicked) === null; clicked.w.close();
    /* a real answer writes the permanent flag, and a hidden tab waits for its return */
    const answered = boot();
    click(answered.w, answered.d.querySelector('[data-open-estimate]')); await wait(120);
    answered.w.estimateShowSent({ name: 'Sam Ortiz', zip: '50265', phone: '+1 515 555 0100', claim: false }, false, '');
    await wait(80);
    const sentFlag = answered.w.localStorage.getItem('alder-est-sent-v1') === '1' && invited(answered) === null;
    answered.w.close();
    const hiddenTab = boot({ visibility: 'hidden' });
    await fire(hiddenTab);
    const notWhileHidden = !isOpen(hiddenTab) && invited(hiddenTab) === null;
    hiddenTab.vis.now = 'visible';
    hiddenTab.d.dispatchEvent(new hiddenTab.w.Event('visibilitychange'));
    await wait(150);
    const invitedOnReturn = isOpen(hiddenTab) && invited(hiddenTab) === '1';
    hiddenTab.w.close();
    line(stampOk && heldByClose && expiredInvites && afterSubmit && whileOpen && whileMenu && pastFirst && afterCta && sentFlag && notWhileHidden && invitedOnReturn,
      'MD11', 'invitation guards: 30-day stamp, expired, sent, open modal/menu, scrolled, CTA, hidden tab',
      `stamp=${stampOk} closed=${heldByClose} expired=${expiredInvites} sent=${afterSubmit} open=${whileOpen} menu=${whileMenu} scrolled=${pastFirst} cta=${afterCta} flag=${sentFlag} hidden=${notWhileHidden} returned=${invitedOnReturn}`);
  }

  /* MD12: the radius is permanent, so the DEV panel no longer has a radius row.
     The auto-open delay row stays. */
  {
    const noRadiusUi = !/data-dbg="radius"|data-radius-px|data-radius="(default|custom)"|dataset\.radius/.test(html);
    const delaysStay = /data-dbg="auto-delay"/.test(html) && /data-delay="desktop"/.test(html) && /data-delay="mobile"/.test(html);
    line(noRadiusUi && delaysStay, 'MD12',
      'debug panel: no radius control, auto-open delays remain',
      `noRadius=${noRadiusUi} delays=${delaysStay}`);
  }

  /* MD13: the two auto-open inputs. AUTO is defined after the panel script, so these are written
     at input time through window.AUTO. The timer is already pending, so the change is for the next
     session/timer; the comment says so and nothing is persisted. */
  {
    const { VirtualConsole } = await import('jsdom');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/', virtualConsole: new VirtualConsole(),
      beforeParse(window) {
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        window.scrollTo = () => {};
        window.CSS = { supports: () => true };
        window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      },
    });
    const w = dom.window, d = w.document;
    await wait(60);
    const desk = d.querySelector('[data-delay="desktop"]'), mob = d.querySelector('[data-delay="mobile"]');
    const markup = !!desk && !!mob && +desk.value === 10000 && +mob.value === 8000
      && desk.min === '0' && desk.max === '300000' && mob.min === '0' && mob.max === '300000';
    const set = (el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
    set(desk, '12345');
    const wrote = !!w.AUTO && !!w.AUTO.delayMs && w.AUTO.delayMs.desktop === 12345;
    set(mob, '999999');
    const clampedHi = !!w.AUTO && w.AUTO.delayMs.mobile === 300000 && +mob.value === 300000;
    set(desk, '-10');
    const clampedLo = !!w.AUTO && w.AUTO.delayMs.desktop === 0 && +desk.value === 0;
    const from = html.indexOf('---- Auto-open delay'), to = html.indexOf('---- Hero type');
    const handler = from > -1 && to > from ? html.slice(from, to) : '';
    const noStorage = !!handler && !/torage|setItem|removeItem/.test(handler) && /a\.delayMs\[key\]/.test(handler);
    const note = /timer is scheduled at load/.test(handler) && /NEXT session\/timer/.test(handler);
    w.close();
    line(markup && wrote && clampedHi && clampedLo && noStorage && note, 'MD13',
      'auto-open ms inputs write AUTO.delayMs live, clamped, no storage',
      `markup=${markup} wrote=${wrote} hi=${clampedHi} lo=${clampedLo} noStore=${noStorage} note=${note}`);
  }

  /* MD17: the DEV gate must not be openable on a production host by URL. Local
     and Vercel preview hosts may still use ?dev=1; the production alias may not. */
  {
    const { VirtualConsole } = await import('jsdom');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const gateHtml = html.replace('{{prodHost}}', 'alder-roofing.vercel.app')
      .replace('{{prodVercelHost}}', 'alder-roofing.vercel.app');
    const boot = async (url) => {
      const dom = new JSDOM(gateHtml, {
        runScripts: 'dangerously', pretendToBeVisual: true, url, virtualConsole: new VirtualConsole(),
        beforeParse(window) {
          window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
          window.scrollTo = () => {};
          window.CSS = { supports: () => true };
          window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
        },
      });
      await wait(80);
      const noDev = dom.window.document.documentElement.classList.contains('no-dev');
      const panel = !!dom.window.document.querySelector('.dbg');
      dom.window.close();
      return { noDev, panel };
    };
    const prod = await boot('https://alder-roofing.vercel.app/?dev=1');
    const preview = await boot('https://alder-roofing-git-hardening.vercel.app/?dev=1');
    const local = await boot('http://localhost:8791/?dev=1');
    const noAlias = !/[?&]debug=1/.test(html);
    line(prod.noDev && !preview.noDev && !local.noDev && noAlias, 'MD17',
      'DEV panel: ?dev=1 denied on production, allowed on local and preview',
      `prod=${prod.noDev} preview=${preview.noDev} local=${local.noDev} noAlias=${noAlias}`);
  }

  /* MD20: production can also be reached through its Vercel alias. That host
     must be denied as well as the client's own domain. */
  {
    const { VirtualConsole } = await import('jsdom');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const gateHtml = html.replace('{{prodHost}}', 'alder-roofing.vercel.app')
      .replace('{{prodVercelHost}}', 'alder-roofing.vercel.app');
    const boot = async (url) => {
      const dom = new JSDOM(gateHtml, {
        runScripts: 'dangerously', pretendToBeVisual: true, url, virtualConsole: new VirtualConsole(),
        beforeParse(window) {
          window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
          window.scrollTo = () => {};
          window.CSS = { supports: () => true };
          window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
        },
      });
      await wait(80);
      const noDev = dom.window.document.documentElement.classList.contains('no-dev');
      dom.window.close();
      return noDev;
    };
    const aliasDenied = await boot('https://alder-roofing.vercel.app/?dev=1');
    const previewAllowed = !(await boot('https://alder-roofing-git-hardening.vercel.app/?dev=1'));
    line(aliasDenied && previewAllowed, 'MD20',
      'DEV gate denies the Vercel production alias, allows preview',
      `aliasDenied=${aliasDenied} previewAllowed=${previewAllowed}`);
  }

  /* MD21: if either production host is missing or still a placeholder, the
     gate fails closed: no Vercel host may be treated as a preview. */
  {
    const { VirtualConsole } = await import('jsdom');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const boot = async (variant) => {
      const dom = new JSDOM(variant, {
        runScripts: 'dangerously', pretendToBeVisual: true,
        url: 'https://alder-roofing-git-x.vercel.app/?dev=1', virtualConsole: new VirtualConsole(),
        beforeParse(window) {
          window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
          window.scrollTo = () => {};
          window.CSS = { supports: () => true };
          window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
        },
      });
      await wait(80);
      const noDev = dom.window.document.documentElement.classList.contains('no-dev');
      dom.window.close();
      return noDev;
    };
    const good = html.replace('{{prodHost}}', 'alder-roofing.vercel.app').replace('{{prodVercelHost}}', 'alder-roofing.vercel.app');
    const emptyHost = good.replace('data-prod-host="alder-roofing.vercel.app"', 'data-prod-host=""');
    const placeholderHost = good.replace('data-prod-host="alder-roofing.vercel.app"', 'data-prod-host="{{prodHost}}"');
    const emptyAlias = good.replace('data-prod-vercel-host="alder-roofing.vercel.app"', 'data-prod-vercel-host=""');
    const placeholderAlias = good.replace('data-prod-vercel-host="alder-roofing.vercel.app"', 'data-prod-vercel-host="{{prodVercelHost}}"');
    const denied = await Promise.all([emptyHost, placeholderHost, emptyAlias, placeholderAlias].map(boot));
    const previewOk = !(await boot(good));
    line(denied.every(Boolean) && previewOk, 'MD21',
      'DEV gate fails closed on missing or placeholder production hosts',
      `denied=${denied.map(Number).join('')} preview=${previewOk}`);
  }

  /* MD19: the auto-open guard must measure the masthead (hero + stats), not
     the first <section>, which is About further down the page. */
  {
    const guard = /var first = document\.querySelector\('main > \.masthead'\) \|\| document\.querySelector\('main > section'\)/.test(html);
    const stubBlind = /getBoundingClientRect/.test(html) && /bottom <= 0/.test(html);
    line(guard && stubBlind, 'MD19', 'auto-open first-section guard uses the masthead',
      `guard=${guard} stillChecks=${stubBlind}`);
  }

  /* MD18: closing during a send is allowed, but reopening must not hand the
     request a new idempotency key, and a second send while busy is ignored. */
  {
    const at = (s, e) => { const a = html.indexOf(s), b = html.indexOf(e, a); return a > -1 && b > a ? html.slice(a, b) : ''; };
    const openFn = at('function open(t, auto)', 'function close()');
    const closeFn = at('function close()', '/* ---------- the one invitation');
    const sendFn = at('function send()', '/* The two panels');
    const resume = /state === 'sending'/.test(openFn) && /if \(!resuming && window\.estimateReset\)/.test(openFn)
      && /setBusy\(true\)/.test(openFn);
    const guarded = /if \(state === 'sending'\) return;/.test(sendFn);
    const closeAllowed = !/if \(state === 'sending'\) return;/.test(closeFn);
    line(resume && guarded && closeAllowed, 'MD18',
      'close during send: reopen keeps the key, second send ignored',
      `resume=${resume} guarded=${guarded} closeAllowed=${closeAllowed}`);
  }

  /* MD22: the resting look of the form's controls, as words in the source.
     One border per control, the selected dropdown row told apart by weight and
     the accent check mark (never by an accent bar), a pointer on every pressable
     button, one consent sentence, and an auto-opened dialog that takes the focus
     itself instead of landing on a field nobody chose. */
  {
    const noBar = !/box-shadow:\s*inset 3px 0 0 var\(--accent\)/.test(css)
      && /\.sel-list li\[aria-selected="true"\]\s*\{[^}]*box-shadow:\s*none/.test(css);
    const accentCheck = /stroke='%23d93917'/.test(css) && !/stroke='%23f7f4ef'/.test(css);
    const pointer = /:where\(button, \[role="button"\]\):not\(:disabled\):not\(\[aria-disabled="true"\]\)\s*\{\s*cursor:\s*pointer/.test(css);
    const mouseNoRing = /\.f input:focus:not\(:focus-visible\),\s*\.f textarea:focus:not\(:focus-visible\),\s*\.sel-btn:focus:not\(:focus-visible\)/.test(css);
    // The keyboard ring stays on buttons and option cards, but a form control
    // shows focus only by turning its one border primary — no outer outline.
    const noFieldOutline = /\.f input:focus-visible,\s*\.f textarea:focus-visible,\s*\.sel-btn:focus-visible,\s*\.opt :is\(input, \[type="radio"\]\):focus-visible\s*\{\s*outline:\s*none/.test(css)
      && /\.est :focus-visible\s*\{\s*outline:\s*2px solid var\(--sel\)/.test(css);
    const consent = (html.match(/We only use your details to contact you about your estimate\./g) || []).length === 1
      && !/We only use your details to contact you|by support|Support has reactivated/.test(html.replace(/We only use your details to contact you about your estimate\./g, ''));
    const openFn = (() => { const a = html.indexOf('function open(t, auto)'), b = html.indexOf('function close()', a); return a > -1 && b > a ? html.slice(a, b) : ''; })();
    const dialogFirst = /var byVisitor = auto !== true;/.test(openFn) && /else if \(byVisitor \|\| restored\) focusFirst\(\);/.test(openFn)
      && /if \(!dlg\.contains\(document\.activeElement\)\) dlg\.focus\(\{ preventScroll: true \}\)/.test(openFn);
    const inviteAuto = /open\(t, true\)/.test((() => { const a = html.indexOf('function invite()'), b = html.indexOf('/* The delay is a wait', a); return a > -1 && b > a ? html.slice(a, b) : ''; })())
      && /open\(a\)/.test(html);
    line(noBar && accentCheck && pointer && mouseNoRing && noFieldOutline && consent && dialogFirst && inviteAuto, 'MD22',
      'one border, accent check mark, pointer buttons, keyboard-only ring, auto-open focus',
      `bar=${noBar} check=${accentCheck} ptr=${pointer} noRing=${mouseNoRing} fieldRing=${noFieldOutline} consent=${consent} focus=${dialogFirst} auto=${inviteAuto}`);
  }

  /* MD23: a draft is only restored when it can be a continuation: it holds a
     real answer, it is from this day, and it does not contradict what is
     already in the form. A stale or empty draft is cleared instead. */
  {
    const { VirtualConsole } = await import('jsdom');
    const KEY = 'alder-est-draft-v1';
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const boot = (extra) => {
      const vc = new VirtualConsole();
      vc.on('jsdomError', () => {});
      const dom = new JSDOM(html, {
        runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://alder.test/', virtualConsole: vc,
        beforeParse(window) {
          window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
          window.scrollTo = () => {};
          window.CSS = { supports: () => true };
          if (extra) extra(window);
        },
      });
      return { w: dom.window, d: dom.window.document };
    };
    const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    const visibleStep = (d) => [...d.querySelectorAll('.est-pane[data-step]')].findIndex((p) => !p.hidden) + 1;
    const seed = (values, at, step) => (window) => window.sessionStorage.setItem(KEY,
      JSON.stringify({ step: step || 0, touched: true, at, values: Object.assign({ service: '', zip: '', home: '', age: 'Not sure', timing: '', name: '', phone: '', email: '', notes: '', claim: false }, values) }));

    /* A. yesterday's answers are not this visit's */
    const stale = boot(seed({ service: 'repair', zip: '50265' }, Date.now() - 25 * 3600 * 1000, 1));
    click(stale.w, stale.d.querySelector('[data-open-estimate]'));
    await wait(200);
    const staleIgnored = visibleStep(stale.d) === 1 && stale.d.getElementById('e-zip').value === ''
      && stale.d.querySelector('.est-restart').hidden === true && stale.w.sessionStorage.getItem(KEY) === null;
    stale.w.close();

    /* B. a draft that holds only the selects' own defaults is nothing to restore */
    const empty = boot(seed({}, Date.now(), 1));
    click(empty.w, empty.d.querySelector('[data-open-estimate]'));
    await wait(200);
    const emptyIgnored = visibleStep(empty.d) === 1 && empty.d.querySelector('.est-restart').hidden === true
      && empty.w.sessionStorage.getItem(KEY) === null;
    empty.w.close();

    /* C. today's answers, same form: restored, and the focus goes to the field
       the visitor was on, not to the dialog */
    const live = boot(seed({ service: 'repair', zip: '50266' }, Date.now(), 1));
    click(live.w, live.d.querySelector('[data-open-estimate]'));
    await wait(220);
    const liveRestored = visibleStep(live.d) === 2 && live.d.getElementById('e-zip').value === '50266'
      && live.d.querySelector('.est-restart').hidden === false
      && live.d.contains(live.d.activeElement) && live.d.activeElement !== live.d.querySelector('.est-dialog');
    live.w.close();

    /* D. an invitation opens by itself and the dialog takes the focus: no field,
       card or radio may look chosen or ringed on its own */
    let timers = [];
    const auto = boot((window) => {
      const t = window.setTimeout;
      window.setTimeout = function (fn, ms) { timers.push({ fn, ms }); return t.call(window, fn, ms); };   /* jsdom has no layout: the first section is on screen */
      window.Element.prototype.getBoundingClientRect = function () { return { top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100 }; };
    });
    const inv = timers.filter((x) => x.fn && x.fn.name === 'estInvite');
    if (inv.length === 1) inv[0].fn();
    await wait(220);
    const autoFocus = auto.d.getElementById('est').classList.contains('open')
      && auto.d.activeElement === auto.d.querySelector('.est-dialog')
      && !auto.d.querySelector('input[name="service"]:checked')
      && auto.d.querySelector('.est-restart').hidden === true;
    auto.w.close();

    line(staleIgnored && emptyIgnored && liveRestored && autoFocus, 'MD23',
      'a stale or empty draft is not restored; an invitation focuses the dialog',
      `stale=${staleIgnored} empty=${emptyIgnored} live=${liveRestored} auto=${autoFocus}`);
  }

  /* MD24 (item 16): a held request still has the visitor's recap. The heading
     thanks them by first name, the subtitle says the request is saved, and a
     separate amber notice box above the recap tells them to call. No reply
     promise; the Call button stays; no "what happens next" steps. */
  {
    const { VirtualConsole } = await import('jsdom');
    const vc = new VirtualConsole();
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://alder.test/', virtualConsole: vc,
      beforeParse(window) {
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        window.scrollTo = () => {};
        window.CSS = { supports: () => true };
        window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      },
    });
    const w = dom.window, d = w.document;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const click = (win, el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    click(w, d.querySelector('[data-open-estimate]'));
    await wait(120);
    const choice = (name, value) => {
      const el = d.querySelector(`input[name="${name}"][value="${value}"]`);
      el.checked = true;
      return el.closest('.opt').querySelector('b').textContent.trim();
    };
    const service = choice('service', 'repair'), home = choice('home', 'house'), start = choice('timing', 'asap');
    d.getElementById('e-age').value = '10 to 20 years';
    const data = { name: 'Sam Ortiz', zip: '50265', phone: '+1 515 555 0100', claim: false };
    w.estimateShowSent(data, false, 'held');
    await wait(120);
    const done = d.querySelector('.est-done');
    const title = done.querySelector('#est-thanks').textContent.trim();
    const body = done.querySelector('.est-head .lead').textContent.trim();
    const warn = done.querySelector('.est-warn');
    const recap = done.querySelector('.est-recap');
    const recapText = recap.textContent.replace(/\s+/g, ' ');
    const BODY = "This business can't respond through this form right now. Please call them directly for the fastest help.";
    const beforeRecap = !!warn && !!(warn.compareDocumentPosition(recap) & w.Node.DOCUMENT_POSITION_FOLLOWING);
    const ok = title === 'Thanks, Sam.' && body === 'Your request is saved.' && !body.startsWith(title)
      && beforeRecap && warn.hidden === false && warn.textContent.trim() === BODY
      && recap.hidden === false && recap.children.length === 5
      && [service, home + ' · ZIP 50265', '10 to 20 years', start, data.phone].every((v) => recapText.includes(v))
      && !!done.querySelector('.est-actions .btn.phone[href^="tel:"]')
      && !/we will reply|reply within|within one business day/i.test(done.textContent)
      && done.querySelector('.est-after').hidden === true;
    line(ok, 'MD24', 'held answer: thanks, saved subtitle, amber notice above the recap',
      `title=${JSON.stringify(title)} sub=${JSON.stringify(body)} warn=${beforeRecap} recap=${recap.hidden === false} rows=${recap.children.length}`);
    w.close();
  }

  /* MD28 (item 17): an active business is the ordinary success screen —
     the same thanks heading, "We got your request.", recap and next steps,
     with the warning badge and notice box still hidden. */
  {
    const { VirtualConsole } = await import('jsdom');
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://alder.test/', virtualConsole: new VirtualConsole(),
      beforeParse(window) {
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        window.scrollTo = () => {};
        window.CSS = { supports: () => true };
        window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      },
    });
    const w = dom.window, d = w.document;
    const wait2 = (ms) => new Promise((r) => setTimeout(r, ms));
    d.querySelector('[data-open-estimate]').dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    await wait2(120);
    w.estimateShowSent({ name: 'Sam Ortiz', zip: '50265', phone: '+1 515 555 0100', claim: false }, false, '');
    await wait2(120);
    const done = d.querySelector('.est-done');
    const title = done.querySelector('#est-thanks').textContent.trim();
    const sub = done.querySelector('.est-head .lead').textContent.trim();
    const ok = title === 'Thanks, Sam.' && sub === 'We got your request.'
      && done.querySelector('.est-warn').hidden === true
      && !done.hasAttribute('data-kind') && !done.classList.contains('est-plain')
      && done.querySelector('.est-recap').hidden === false && done.querySelector('.est-after').hidden === false
      && !/can't respond|call them directly/i.test(done.textContent);
    line(ok, 'MD28', 'active business keeps the ordinary success screen',
      `title=${JSON.stringify(title)} sub=${JSON.stringify(sub)} warn=${done.querySelector('.est-warn').hidden} after=${done.querySelector('.est-after').hidden}`);
    w.close();
  }

  /* MD14: sitewide coverage. Every visible box, including ::before/::after boxes
     and the images that a parent's radius cannot clip, is in the ONE live rule.
     Full-viewport layers and the two things that must stay round stay out. */
  {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');   /* comments name excluded selectors; strip them */
    const uses = (clean.match(/border-radius:\s*var\(--box-radius\)/g) || []).length;
    const rule = /([^{}]+)\{\s*border-radius:\s*var\(--box-radius\)[^}]*\}/.exec(clean);
    const list = rule ? rule[1].split(',').map(s => s.trim()).filter(Boolean) : [];
    const required = ['.btn', '.btn i', '.menu-btn', '.menu-close', '.dbg', '.dbg .dbg-toggle', '.bar', '.card', '.card-text', '.photo', '.ph', '.ph::after',
      '.cta-img', '.hero-video', '[data-hero-video]', '.frame', '.badge::before', '.label::before',
      '.cta-sec .label::before', '.ft-trust>span', '.ft-trust>span::before', '.ft-social a',
      '.steps::before', '.steps::after', '.step .n', '.ba-nav button', '.tag', '.handle::before',
      '.pair figcaption', '.rv', '.rv-media', '.rv-media img', '.rv-text', '.fi', '.q', '.tot',
      '.menu-top', '.menu-acts', '.menu-foot', '.menu nav a::before', '.est-dialog', '.est-dots li',
      '.est-x', '.opt', '.opt::after', '.f input', '.f textarea', '.sel-btn', '.sel-list', '.sel-list li',
      '.sel-list li[aria-selected="true"]::after', '.chk', '.chk input', '.est-alert', '.est-back', '.est-restart',
      '.est-ok', '.est-warn', '.est-recap',
      '.est-next-group', '.est-after', '.est-steps li::before', '.est-actions', '.dbg button', '.dbg input.dbg-num'];
    const missing = required.filter(s => !list.includes(s));
    const keepOut = ['.av', '.est-next.busy::after', '.est', '.est-scrim', '.menu', '.pre'];
    const leaked = keepOut.filter(s => list.includes(s));
    // The main sitewide rule plus the review image's own clipping rule both
    // read the same token; there is no second numeric value anywhere.
    line(uses === 2 && missing.length === 0 && leaked.length === 0, 'MD14',
      'radius covers every box sitewide; overlays and round-by-design stay out',
      `uses=${uses} missing=${missing.join(',') || 'none'} leaked=${leaked.join(',') || 'none'}`);
  }

  /* MD15: the white arrow square on every primary CTA is painted by the button-hover
     system as a background gradient on .bx-p, not by <i>. It is now a REAL rounded box
     permanently, 7px (12px button radius minus the 6px right padding plus 1px). */
  {
    const bxOff = /html\.bx \.bx-p\s*\{\s*background-image:\s*none/.test(css);
    const bxOn = /html\.bx \.bx-p i\s*\{\s*background:\s*var\(--bx-fill\)/.test(css);
    const bxRadius = /html\.bx \.bx-p i\s*\{\s*border-radius:\s*var\(--radius-arrow\)/.test(css);
    line(bxOff && bxOn && bxRadius, 'MD15',
      'primary CTA square is a real box with a 7px radius',
      `off=${bxOff} on=${bxOn} radius=${bxRadius}`);
  }

  /* MD16: the permanent radii and the single focus ring. */
  {
    const base = /--box-radius:\s*12px/.test(tokensCss) && /--radius-image:\s*24px/.test(tokensCss)
      && /--radius-section:\s*48px/.test(tokensCss) && /--radius-arrow:\s*7px/.test(tokensCss);
    const dbl = /calc\(var\(--box-radius\) \* 2\)/.test(css);
    const quad = /calc\(var\(--box-radius\) \* 4\)/.test(css);
    const img12 = /\.rv-media img\s*\{\s*border-radius:\s*var\(--box-radius\)/.test(css);
    const images = /\.photo,[\s\S]{0,200}\.ph,[\s\S]{0,200}\.frame,[\s\S]{0,200}\.cta-img,[\s\S]{0,200}\.rv,[\s\S]{0,200}\.rv-media\s*\{\s*border-radius:\s*calc\(var\(--box-radius\) \* 2\)/.test(css);
    const cta = /\.cta-sec\s*\{\s*border-radius:\s*calc\(var\(--box-radius\) \* 4\)/.test(css);
    const ctaFill = /\.page\s*\{[^}]*background:\s*linear-gradient\([^}]*var\(--ink\)/.test(css);
    const totRing = /class="ring"[\s\S]{0,140}<path d="M13 1H35A12 12/.test(html);
    /* One resting border for input, textarea and the themed dropdown; focus
       changes its COLOUR (accent) and nothing else. The white --ctl-focus
       border is gone, and an open dropdown no longer repaints its border. */
    const singleRing = !/var\(--ctl-focus\)/.test(css)
      && /\.f input:focus,\s*\.f textarea:focus,\s*\.sel-btn:focus\s*\{\s*border-color:\s*var\(--sel\)/.test(css)
      && /\.f input,\s*\.f textarea,\s*\.sel-btn\s*\{\s*border:\s*1px solid var\(--ctl-line\)/.test(css)
      && !/\.sel\.open \.sel-btn\s*\{\s*border-color:\s*var\(--ctl-focus\)/.test(css);
    // MD25 (item 14): fields and option cards have the SAME resting border.
    // The opaque --ctl-line made the fields look almost solid white next to the
    // cards' translucent edge, so it now aliases --line; focus only recolours.
    const sameToken = /--ctl-line:\s*var\(--line\)/.test(css);
    const cardBorder = /\.opt\s*\{[^}]*border:\s*1px solid var\(--line\)/.test(css);
    const fieldBorder = /\.f input,\s*\.f textarea,\s*\.sel-btn\s*\{\s*border:\s*1px solid var\(--ctl-line\)/.test(css)
      || /\.f input\[type="text"\][\s\S]{0,300}border:\s*1px solid var\(--ctl-line\)/.test(css);
    line(sameToken && cardBorder && fieldBorder, 'MD25',
      'fields and option cards share one resting border token',
      `token=${sameToken} card=${cardBorder} field=${fieldBorder}`);

    // MD26 (item 15): the success/held panel is not itself focused — that drew
    // a red ring around the whole card. Focus moves to its heading, with no
    // outline; the panel never shows a focus ring.
    const headingFocusable = /<h3 id="est-thanks"[^>]*tabindex="-1"/.test(html);
    const helper = /function focusSent\(\)\s*\{\s*var h = done\.querySelector\('#est-thanks'\);\s*\(h \|\| done\)\.focus\(\{ preventScroll: true \}\);\s*\}/.test(html);
    const noPaneFocus = !/done\.focus\(\{ preventScroll: true \}\)/.test(html);
    const noRing = /\.est-done:focus,\s*\.est-done:focus-visible,\s*\.est-done h3:focus,\s*\.est-done h3:focus-visible\s*\{\s*outline:\s*none\s*\}/.test(css);
    line(headingFocusable && helper && noPaneFocus && noRing, 'MD26',
      'success panel has no focus ring; focus lands on its heading',
      `heading=${headingFocusable} helper=${helper} noPane=${noPaneFocus} noRing=${noRing}`);

    // MD27 (item 16): the amber warning badge and notice box, and a long name
    // still wraps. The check mark is untouched on the normal success screen.
    const badge = /class="est-ok"[\s\S]{0,500}est-check[\s\S]{0,300}est-warn-icon/.test(html);
    const warning = /\.est-ok \.est-warn-icon\s*\{\s*display:\s*none/.test(css)
      && /\.est-done\[data-kind\] \.est-ok \.est-check\s*\{\s*display:\s*none/.test(css)
      && /\.est-done\[data-kind\] \.est-ok \.est-warn-icon\s*\{\s*display:\s*block/.test(css);
    const warnCss = [...css.matchAll(/\.est-warn\s*\{([^}]*)\}/g)].map((m) => m[1]).join('\n');
    const amber = /background:\s*rgb\(224 168 0\/\.10\)/.test(warnCss)
      && /border:\s*1px solid rgb\(224 168 0\/\.18\)/.test(warnCss);
    const wrapName = /#est-thanks\s*\{[\s\S]{0,160}overflow-wrap:\s*anywhere/.test(css)
      || /\.est-head h3\s*\{[\s\S]{0,160}overflow-wrap:\s*anywhere/.test(css);
    line(badge && warning && amber && wrapName, 'MD27',
      'warning badge + amber notice above recap, long headings wrap',
      `badge=${badge} warning=${warning} amber=${amber} wrap=${wrapName}`);
    line(base && dbl && quad && img12 && images && cta && ctaFill && totRing && singleRing, 'MD16',
      '12px base, 24px images/cards, 48px CTA, footer corners, rounded back-to-top, one ring',
      `base=${base} dbl=${dbl} quad=${quad} img12=${img12} images=${images} cta=${cta} fill=${ctaFill} tot=${totRing} ring=${singleRing}`);
  }
} catch (e) {
  line(false, 'MD0', 'modal suite threw', (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)));
}

console.log(`\n${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
