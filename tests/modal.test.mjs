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
//
// Mutations (each breaks the check named):
//   put a literal title back into an option                      -> MD1, MD3
//   change a stored value (unsure -> inspection)                 -> MD1, MD5
//   put data-close back on .est-scrim                            -> MD6
//   make the X 40px again                                        -> MD7

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
} catch (e) {
  line(false, 'MD0', 'modal suite threw', (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)));
}

console.log(`\n${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
