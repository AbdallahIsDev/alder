// scripts/sync-brand.mjs — extract the landing page's brand tokens into lib/brand.generated.json.
//
// Reads index.html ONCE at build time (the :root variables, @font-face rules and
// the logo SVG), derives the email tokens, writes lib/brand.generated.json, and
// renders the two logo PNGs with sharp. Runs as part of build-static.js and can
// be run standalone: `node scripts/sync-brand.mjs`.
// Reads NO env, opens NO network connection, touches NO database.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = path.join(ROOT, 'index.html');
/* The tokens and the @font-face rules moved into their own file on 2026-11-10.
   Read the CSS when it is there; fall back to the page so an older checkout
   (before the move) still builds. The logo SVG is still in the page. */
const CSS = path.join(ROOT, 'assets', 'css', 'styles.css');
/* A sample build must not overwrite the tracked brand file: build-static points
   this elsewhere for any client but the default. */
const OUT = process.env.BRAND_OUT
  ? path.resolve(process.env.BRAND_OUT)
  : path.join(ROOT, 'lib', 'brand.generated.json');
const LOGO_DIR = path.join(ROOT, 'assets', 'email');

const page = fs.readFileSync(PAGE, 'utf8');
const styleText = fs.existsSync(CSS) ? fs.readFileSync(CSS, 'utf8') : page;

function fail(msg) { console.error('sync-brand: ' + msg); process.exit(1); }

/* ---------- read :root variables ---------- */
const rootBlock = (styleText.match(/:root\s*\{([\s\S]*?)\}/) || [])[1];
if (!rootBlock) fail('no :root block in ' + (styleText === page ? 'index.html' : 'assets/css/styles.css'));
const vars = {};
for (const line of rootBlock.split(/\r?\n/)) {
  const m = /^\s*(--[a-zA-Z0-9-]+)\s*:\s*([^;\r\n]+);?/.exec(line);
  if (m) vars[m[1]] = m[2].trim();
}

/* ---------- read @font-face rules ---------- */
const faces = [];
for (const m of styleText.matchAll(/@font-face\s*\{([\s\S]*?)\}/g)) {
  const body = m[1];
  const family = /font-family:\s*['"]([^'"]+)['"]/.exec(body);
  const src = /src:\s*url\(([^)]+)\)/.exec(body);
  if (!family || !src) continue;
  // The url is relative to the CSS file now ("../fonts/x.woff2"); the set of
  // files on disk is keyed by the bare name either way.
  const file = src[1].replace(/['"]/g, '').replace(/^(?:\.\.\/|assets\/)?fonts\//, '');
  faces.push({ family: family[1], weight: 700, style: 'normal', file });
}

/* ---------- read fonts used by --f and --f2 ---------- */
function familyFromVar(v) {
  const m = /^\s*['"]([^'"]+)['"]/.exec(String(v || ''));
  return m ? m[1] : '';
}
// --f is Geist (sans used for body text), --f2 is Inter. Keep the mapping explicit.
// On the page, headings inherit --f (Geist); the "reading weight" face for running
// text is --f2 (Inter). For email that mapping is the convenient one: brand/heading
// face = Geist, body/reading face = Inter.
const headingFamily = familyFromVar(vars['--f']) || 'Geist';
const bodyFamily = familyFromVar(vars['--f2']) || headingFamily;
const stack = (family) => `'${family}', Arial, Helvetica, sans-serif`;

/* ---------- colour helpers (emails cannot use var(), oklch() or hsl()) ---------- */
function hexOf(v) {
  const m = /#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/.exec(String(v || ''));
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return '#' + h.toUpperCase();
}
const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb) => '#' + rgb.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase()).join('');
const blend = (fg, bg, alpha) => toHex(toRgb(fg).map((n, i) => n * alpha + toRgb(bg)[i] * (1 - alpha)));
function relLuminance(hex) {
  const [r, g, b] = toRgb(hex).map((n) => {
    const c = n / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [relLuminance(a), relLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** Darken `hex` toward `toward` until it reaches `target` contrast on `against`. */
function darkenTo(hex, against, target, toward = '#000000') {
  let cur = hex;
  for (let i = 0; i < 200 && contrast(cur, against) < target; i++) {
    cur = blend(toward, cur, 0.05);
  }
  return cur;
}

/* ---------- derive the token set ---------- */
const white = '#FFFFFF', ink = hexOf(vars['--ink']) || '#1C1F24';
const vWhite = hexOf(vars['--white']) || '#FFFFFF';
const accent = hexOf(vars['--accent']) || '#D93917';
const ink2 = hexOf(vars['--ink2']) || '#1C1F24';
const pageMuted = hexOf(vars['--muted']) || '#A9ADB3';

const bg = ink;                                   // the page's darkest brand surface
const onBg = vWhite;                              // text on the dark surface
const onBgMuted = blend(onBg, bg, 0.7);           // onBg blended 70% over bg
const accentText = contrast('#FFFFFF', accent) >= 4.5 ? '#FFFFFF' : '#111111';
const text = ink2;                                // the page's primary text on white
const muted = contrast(pageMuted, white) >= 4.5 ? pageMuted : darkenTo(pageMuted, white, 4.5, ink2);

const colors = {
  canvas: '#F2F3F5',   // spec default: lightest neutral of the email page
  card: white,
  bg,
  onBg,
  onBgMuted,
  accent,
  accentText,
  text,
  muted,
  border: '#E3E6EA',   // spec default
  tint: '#F4F5F7',     // spec default
};

/* ---------- client name (for the JSON's name field) ----------
   The page template no longer carries values; it only lists the keys. The name
   comes from clients/<slug>.json, the same file the build reads. CLIENT is set
   by build-static.js when it spawns this script. */
const clientSlug = String(process.env.CLIENT || 'alder').trim();
let bizName = '';
try {
  const clientFile = path.join(ROOT, 'clients', clientSlug + '.json');
  bizName = String(JSON.parse(fs.readFileSync(clientFile, 'utf8')).biz.name || '').trim();
} catch { /* no file: leave it empty and fail below */ }
if (!bizName) {
  console.error('sync-brand: clients/' + clientSlug + '.json has no biz.name');
  process.exit(1);
}

/* ---------- logo: 256×256 PNGs, two colours, from the favicon geometry ----------
   Roof and chimney take the brand accent; the house takes the colour it sits on.
   Transparent background and no rounded square: the header band already supplies
   the ground. The geometry is the favicon's, so the email mark and the browser
   tab are the same drawing. 256 px because it is shown at 32 px and needs to
   survive a 2× or 3× screen. */
const LOGO_SIZE = 256;
const LOGO_VIEWBOX = '48 48 416 416';
/* The page's ink ground, not the body text colour: the house has to read as the
   same dark as the header band on a light surface. */
const logoInk = hexOf(vars['--ink']) || '#1C1F24';
function logoSvg(houseFill) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${LOGO_VIEWBOX}" width="${LOGO_SIZE}" height="${LOGO_SIZE}">`
    + `<path fill="${accent}" d="M64 240L256 80L448 240V296L256 136L64 296Z"/>`
    + `<rect x="336" y="96" width="56" height="104" fill="${accent}"/>`
    + `<path fill="${houseFill}" d="M256 172L400 292V432H288V344H224V432H112V292Z"/>`
    + '</svg>';
}
const logoMatch = page.match(/<a class="logo"[^>]*><svg viewBox="0 0 512 512"[\s\S]*?<\/svg>/);
let logo = null;
if (logoMatch) {
  fs.mkdirSync(LOGO_DIR, { recursive: true });
  const onDarkFile = 'logo-on-dark.png';
  const onLightFile = 'logo-on-light.png';
  await sharp(Buffer.from(logoSvg(onBg))).resize(LOGO_SIZE, LOGO_SIZE).png().toFile(path.join(LOGO_DIR, onDarkFile));
  await sharp(Buffer.from(logoSvg(logoInk))).resize(LOGO_SIZE, LOGO_SIZE).png().toFile(path.join(LOGO_DIR, onLightFile));
  // The on-dark PNG bytes, base64, bundled with the serverless function as a
  // CID inline image (lib/mail.js attaches it). The hosted PNG files above
  // stay for the preview gallery only; the function never reads assets/ at
  // run time, it reads this field via lib/brand.js.
  const onDarkB64 = fs.readFileSync(path.join(LOGO_DIR, onDarkFile)).toString('base64');
  /* The URL carries the first 8 hex of the file's own hash. The file name never
     changes, so without this a browser that cached the old mark keeps showing it
     after a re-render. A query string is ignored by the static route. */
  const logoSha = (file) => createHash('sha256').update(fs.readFileSync(path.join(LOGO_DIR, file))).digest('hex').slice(0, 8);
  logo = {
    onDark: '/assets/email/' + onDarkFile + '?v=' + logoSha(onDarkFile),
    onLight: '/assets/email/' + onLightFile + '?v=' + logoSha(onLightFile),
    height: 36, onDarkB64,
  };
}

/* ---------- font faces: only .woff2 that exist on disk, max 4 ---------- */
const fontFiles = new Set(fs.readdirSync(path.join(ROOT, 'assets', 'fonts')).filter((f) => f.endsWith('.woff2')));
const wanted = [];
for (const f of faces) if (fontFiles.has(f.file)) wanted.push(f);
const fonts = {
  heading: headingFamily,
  body: bodyFamily,
  fallback: 'Arial, Helvetica, sans-serif',
  headingStack: stack(headingFamily),
  bodyStack: stack(bodyFamily),
  faces: wanted.slice(0, 4).map((f) => ({ family: f.family, weight: f.weight, style: f.style, file: f.file })),
};

const out = {
  name: bizName,
  siteUrlPath: '/assets',
  colors,
  fonts,
  logo,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log('wrote ' + OUT);
for (const [k, v] of Object.entries(colors)) {
  console.log(`  ${k.padEnd(10)} ${v}`);
}
console.log('  fonts      heading=' + fonts.heading + ' body=' + fonts.body + ' faces=' + fonts.faces.map((f) => `${f.family}/${f.weight}/${f.file}`).join(', '));
console.log('  logo       ' + (logo ? logo.onDark + ' + ' + logo.onLight : 'none'));
console.log('  contrast   text=' + contrast(colors.text, colors.card).toFixed(2)
  + ' muted=' + contrast(colors.muted, colors.card).toFixed(2)
  + ' accentText=' + contrast(colors.accentText, colors.accent).toFixed(2)
  + ' onBg=' + contrast(colors.onBg, colors.bg).toFixed(2));
