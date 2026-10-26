#!/usr/bin/env node
/* ============================================================================================
   build-static.js : bake the BIZ config into plain HTML (no JavaScript needed to show the details)

   The landing page keeps every client-specific detail in one BIZ object and fills {{tokens}} in
   the HTML when the page loads. This script does that work ahead of time, so the HTML you hand
   to a client already contains the real phone number, email, hours and so on:
     - every {{token}} in text and attributes (title, meta, aria-labels, tel:/mailto: links) is replaced
     - the {{phone}} text and the tel: link both come from the same phone value (+ countryCode)
     - social icons with an empty link are removed
     - the "hide the page until values load" guard is removed
     - the BIZ block is removed (no other script reads it; if one ever does, the build keeps a copy of the values)

   Usage
     node build-static.js                                   uses ./alder-landing-prototype.html -> ./dist/index.html
     node build-static.js page.html --out dist/acme.html
     node build-static.js page.html --config clients/acme.json --out dist/acme/index.html

   --config is a JSON file with only the BIZ keys you want to override for that client, so one
   template can produce many clients without editing the HTML:  { "name": "Acme Roofing", "phone": "(515) 555-0100" }

   If an assets/ folder sits next to the input file it is copied next to the output (the page
   references assets/images/*). Needs Node 16.7+. No dependencies.
   ============================================================================================ */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

/* ---- arguments ---- */
const args = process.argv.slice(2), opt = { input: null, config: null, out: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--config') opt.config = args[++i];
  else if (a === '--out') opt.out = args[++i];
  else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^[^\n]*\n/, '')); process.exit(0); }
  else if (a.startsWith('--')) fail('Unknown option ' + a);
  else if (!opt.input) opt.input = a;
  else fail('Unexpected argument ' + a);
}
opt.input = opt.input || path.join(__dirname, 'alder-landing-prototype.html');
opt.out = opt.out || path.join('dist', 'index.html');
function fail(msg) { console.error('build-static: ' + msg); process.exit(1); }
const warnings = [];

/* ---- read the template and its BIZ object ---- */
if (!fs.existsSync(opt.input)) fail('Input file not found: ' + opt.input);
let html = fs.readFileSync(opt.input, 'utf8');

const blockRe = /<script>\s*\/\* =+ BUSINESS CONFIG[\s\S]*?<\/script>/;
const block = html.match(blockRe);
if (!block) fail('Could not find the BUSINESS CONFIG script block in ' + opt.input + '. Was it renamed or removed?');
const lit = block[0].match(/var BIZ = (\{[\s\S]*?\n\});/);
if (!lit) fail('Could not find "var BIZ = { ... };" inside the BUSINESS CONFIG block.');
let template;
try { template = vm.runInNewContext('(' + lit[1] + ')', Object.create(null), { timeout: 1000 }); }
catch (e) { fail('The BIZ object does not parse: ' + e.message); }

/* ---- merge client overrides ---- */
let biz = Object.assign({}, template);
if (opt.config) {
  if (!fs.existsSync(opt.config)) fail('Config file not found: ' + opt.config);
  let over; try { over = JSON.parse(fs.readFileSync(opt.config, 'utf8')); } catch (e) { fail('Config is not valid JSON: ' + e.message); }
  Object.keys(over).forEach(k => { if (!(k in template) && k !== 'year') warnings.push('Config key "' + k + '" is not in the BIZ object and is ignored by the page.'); });
  biz = Object.assign(biz, over);
}
['name', 'brand', 'phone', 'countryCode', 'email'].forEach(k => { if (!String(biz[k] || '').trim()) fail('BIZ.' + k + ' is empty. It is required.'); });

/* same derivation as the runtime script: tel link = countryCode + 10-digit number */
let digits = String(biz.phone).replace(/\D/g, ''); const cc = String(biz.countryCode).replace(/\D/g, '');
if (digits.length > 10 && digits.indexOf(cc) === 0) digits = digits.slice(cc.length);
biz.tel = biz.countryCode + digits;
if (!biz.year) biz.year = new Date().getFullYear();
Object.keys(biz).forEach(k => { biz[k] = String(biz[k]); });

/* ---- 1. remove the BIZ block (its values are baked in below) ---- */
html = html.replace(blockRe, () => '');
let keptBiz = false;
if (/\bBIZ\b/.test(html.replace(/<style\b[\s\S]*?<\/style>/gi, ''))) {          /* some other script reads BIZ: keep the final values for it */
  html = html.replace(/<\/body>/i, () => '<script>window.BIZ=' + JSON.stringify(biz).replace(/</g, '\\u003c') + ';</script>\n</body>'); keptBiz = true;
  warnings.push('A script outside the config still reads BIZ, so a copy of the values was kept in the page.');
}

/* ---- 2. drop the "hide the page until the values are filled in" guard ---- */
html = html
  .replace(/,\s*'biz-pending'/, '')
  .replace(/setTimeout\(function\(\)\{document\.documentElement\.classList\.remove\('biz-pending'\)\},3000\);?/, '')
  .replace(/[ \t]*html\.biz-pending body \{ visibility: hidden \}\r?\n/, '');
if (/biz-pending/.test(html)) warnings.push('The "biz-pending" guard was only partly removed. Check the <head> script and the CSS.');

/* ---- 3. social icons with an empty link disappear (same as the runtime) ---- */
html = html.replace(/<div class="ft-social">[\s\S]*?<\/div>/, group =>
  group.replace(/<a href="\{\{(\w+)\}\}"[^>]*>[\s\S]*?<\/a>/g, (a, key) => (key in biz && biz[key].trim() === '' ? '' : a)));

/* ---- 4. replace the tokens, but only in markup (never inside script, style or comments) ---- */
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const jsonEsc = s => JSON.stringify(s).slice(1, -1);
const unknown = new Set(), used = new Set();
const fill = (text, enc) => text.replace(/\{\{(\w+)\}\}/g, (m, k) => { if (!(k in biz)) { unknown.add(k); return m; } used.add(k); return enc(biz[k]); });
const parts = html.split(/(<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->)/i);
html = parts.map((seg, i) => {
  if (i % 2 === 0) return fill(seg, esc);                                   /* markup */
  if (/^<script[^>]*type=["']application\/ld\+json["']/i.test(seg)) return fill(seg, jsonEsc); /* structured data */
  return seg;                                                               /* scripts, styles, comments untouched */
}).join('');
if (unknown.size) fail('Unknown token(s) in the HTML: ' + [...unknown].map(k => '{{' + k + '}}').join(', ') + '. Add them to BIZ or fix the typo.');

/* ---- 5. no-JS fallback for the estimate buttons ----
   With JavaScript the button opens the estimate modal. Without it, #estimate-form points at nothing,
   so it becomes an email link. (JS still intercepts the click, so nothing changes for normal visitors.) */
const mailto = 'mailto:' + biz.email + '?subject=' + encodeURIComponent('Free estimate request');
html = html.replace(/(<a\b[^>]*?)href="#estimate-form"([^>]*?data-open-estimate)/g, (m, a, b) => a + 'href="' + esc(mailto) + '"' + b);
html = html.replace(/(<a\b[^>]*?data-open-estimate[^>]*?)href="#estimate-form"/g, (m, a) => a + 'href="' + esc(mailto) + '"');
if (/href="#estimate-form"/.test(html)) warnings.push('Some "#estimate-form" links were not rewritten to the email fallback.');

/* ---- 6. header comment, then write ---- */
html = html.replace(/<head>/i, '<head>\n  <!-- Static build: business details are baked in from the BIZ config by build-static.js. Rebuild after changing them. The footer year below is the year this build ran; the page corrects it to the current year on load, so it stays right without a rebuild. -->');
const outDir = path.dirname(path.resolve(opt.out));
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(opt.out, html, 'utf8');

const assets = path.join(path.dirname(path.resolve(opt.input)), 'assets');
let copied = '';
if (fs.existsSync(assets) && path.resolve(outDir) !== path.dirname(path.resolve(opt.input))) {
  fs.cpSync(assets, path.join(outDir, 'assets'), { recursive: true }); copied = ' (assets/ copied)';
}

/* ---- 7. heads-up about placeholder values that should not ship ---- */
const looksPlaceholder = {
  phone: v => /555/.test(v), email: v => /example|\.test\b/i.test(v),
  founder: v => /^\[.*\]$/.test(v), address: v => /123 Main/i.test(v),
  facebook: v => v === '#', instagram: v => v === '#', youtube: v => v === '#', google: v => v === '#'
};
Object.keys(looksPlaceholder).forEach(k => { if (k in biz && looksPlaceholder[k](biz[k])) warnings.push('BIZ.' + k + ' looks like a placeholder: "' + biz[k] + '"'); });
const left = ['rating', 'reviews', 'roofs', 'warranty'].filter(k => k in template && !opt.config);
if (left.length) warnings.push('Stats (' + left.join(', ') + ') are still the demo values unless you pass a --config. Confirm them with the client.');

const kb = (fs.statSync(opt.out).size / 1024).toFixed(0);
console.log('Built ' + opt.out + ' (' + kb + ' KB)' + copied);
console.log('  tokens filled: ' + [...used].sort().join(', '));
console.log('  phone shown as "' + biz.phone + '", dials ' + biz.tel);
const emptySocial = ['facebook', 'instagram', 'youtube', 'google'].filter(k => !biz[k].trim());
if (emptySocial.length) console.log('  social icons removed: ' + emptySocial.join(', '));
warnings.forEach(w => console.log('  ! ' + w));
