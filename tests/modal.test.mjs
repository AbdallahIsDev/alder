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
//   MD7 the X is 32px on every screen, with a 44px press area
//   MD8 the thank-you pane: three groups in order (mark + heading, recap,
//       next steps with both buttons), the reveal order set on those groups'
//       own classes rather than on :nth-child, and every "what happens next"
//       line short enough to stay one line in the 246px box it gets at 320px
//
// Mutations (each breaks the check named):
//   put a literal title back into an option                      -> MD1, MD3
//   change a stored value (unsure -> inspection)                 -> MD1, MD5
//   put data-close back on .est-scrim                            -> MD6
//   make the X 40px again                                        -> MD7
//   move the buttons back out of .est-next-group                 -> MD8
//   go back to :nth-child delays                                 -> MD8
//   lengthen one "what happens next" line past 34 characters     -> MD8

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
    const x = block('.est-x'), after = block('.est-x::after'), svg = block('.est-x svg');
    const size = /width: 32px;/.test(x) && /height: 32px;/.test(x) && /position: relative;/.test(x);
    const press = /content: "";/.test(after) && /position: absolute;/.test(after) && /inset: -6px/.test(after);
    // One rule only: no media query gives it another size.
    const once = (css.match(/\.est-x\s*\{/g) || []).length === 1;
    const button = /<button type="button" class="est-x" data-close aria-label="Close"/.test(strip(html));
    line(size && press && once && /width: 16px;/.test(svg) && button, 'MD7', 'the X: 32px everywhere, 44px press area, still a labelled button',
      `size=${size} press=${press} once=${once} button=${button}`);
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
    const kids = pane ? [...pane.children].map((c) => c.className) : [];
    const order = same(kids, ['est-done-top', 'est-recap', 'est-next-group']);
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
    /* F. localStorage is never touched: this is contact data */
    const noLocal = a.w.localStorage.length === 0;
    a.w.close();
    line(untouched && saves && stepSaved && restored && overOk && beforeAnswer && cleared && noLocal,
      'MD9', 'draft: written on input and on a step, restored, cleared, sessionStorage only',
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
} catch (e) {
  line(false, 'MD0', 'modal suite threw', (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)));
}

console.log(`\n${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
