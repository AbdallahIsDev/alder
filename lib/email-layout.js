// lib/email-layout.js — one shared shell for every email the system sends.
//
// Table-based, role="presentation", ALL styles inline except the single <style>
// block the shell adds for @font-face and one small mobile rule. No images except
// the brand logo and the Google "G" letter that arrive as absolute https URLs.
// No <script>, no tracking pixels, no CSS custom properties (mail clients do not
// support them, nor oklch/hsl — all colours arrive as #RRGGBB brand tokens).
//
// Font caveat (true of every webfont in email): Gmail and Outlook ignore web
// fonts and render the Arial/Helvetica fallback; Apple Mail loads them. The
// fallback stack keeps the layout intact either way.
//
// Nothing is fetched from a URL by this file, and it never imports anything, so
// it stays small enough to audit by eye.
import { getBrand } from './brand.js';

/** Escape text and attribute values alike (covers &, <, >, ", '). */
export function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Desktop/mobile shell. `fonts` is brand.fonts with absolute URLs. */
function fontFaces(brand) {
  return (brand.fonts.faces || []).map((f) =>
    `@font-face{font-family:'${f.family}';font-weight:${f.weight};font-style:${f.style};src:url('${f.url}') format('woff2')}`
  ).join('');
}

export function headMeta(brand) {
  return `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">`
    + `<style>${fontFaces(brand)}:root{color-scheme:light only}@media (max-width:480px){.px{padding-left:16px!important;padding-right:16px!important}}</style>`;
}

/** Wordmark fallback when the brand has no logo (the business name in the heading font). */
function wordmark(name, size, color, stack) {
  return `<div style="font:700 ${size}px/1.2 ${stack};color:${color}">${esc(name)}</div>`;
}

/**
 * Totally rewritten header for the owner email. `variant` is O1 | O2 | O3.
 */
export function ownerHeader({ business, variant, received, brand }) {
  const c = brand.colors;
  const logo = brand.logo;
  const initial = String(business.name || '').trim().split(/\s+/)[0] || 'there';
  const logoImg = (src, color) =>
    `<img src="${esc(src)}" height="36" alt="${esc(business.name)}" style="display:block;border:0;height:36px;width:auto;max-width:180px;color:${color};font:700 18px/36px ${brand.fonts.headingStack}">`;

  if (variant === 'O2') {
    const logoHtml = logo
      ? logoImg(logo.onLight, c.text)
      : wordmark(business.name, 20, c.text, brand.fonts.headingStack);
    return `<tr><td height="4" bgcolor="${c.accent}" style="font-size:0;line-height:0">&nbsp;</td></tr>`
      + `<tr><td bgcolor="${c.card}" style="padding:22px 28px 18px;border-bottom:1px solid ${c.border}">${logoHtml}`
      + `<div style="font:700 22px/28px ${brand.fonts.headingStack};color:${c.text};padding-top:18px">New estimate request</div>`
      + `<div style="font:400 13px/20px ${brand.fonts.bodyStack};color:${c.muted};padding-top:4px">${esc(received)}</div></td></tr>`;
  }

  if (variant === 'O3') {
    const src = c.accentText === '#FFFFFF' && logo ? logo.onDark : (logo ? logo.onLight : null);
    const logoHtml = src
      ? logoImg(src, c.accentText)
      : wordmark(business.name, 20, c.accentText, brand.fonts.headingStack);
    return `<tr><td bgcolor="${c.accent}" style="padding:24px 28px;border-radius:10px 10px 0 0">${logoHtml}`
      + `<div style="font:700 22px/28px ${brand.fonts.headingStack};color:${c.accentText};padding-top:18px">New estimate request</div>`
      + `<div style="font:400 13px/20px ${brand.fonts.bodyStack};color:${c.accentText};padding-top:4px">${esc(received)}</div></td></tr>`;
  }

  // O1 (default): dark band with the logo, title, subtitle, then an accent bar.
  const logoHtml = logo
    ? logoImg(logo.onDark, c.onBg)
    : wordmark(business.name, 20, c.onBg, brand.fonts.headingStack);
  return `<tr><td bgcolor="${c.bg}" style="padding:24px 28px 20px;border-radius:10px 10px 0 0">${logoHtml}`
    + `<div style="font:700 22px/28px ${brand.fonts.headingStack};color:${c.onBg};padding-top:18px">New estimate request</div>`
    + `<div style="font:400 13px/20px ${brand.fonts.bodyStack};color:${c.onBgMuted};padding-top:4px">${esc(received)}</div></td></tr>`
    + `<tr><td height="4" bgcolor="${c.accent}" style="font-size:0;line-height:0">&nbsp;</td></tr>`;
}

/**
 * A customer-facing header: the same variant band as the owner email, but logo
 * only (no title, no subtitle). `colorMode` picks the dark or light treatment.
 */
export function customerHeader({ business, variant, brand }) {
  const c = brand.colors;
  const logo = brand.logo;
  if (variant === 'O2') {
    const logoHtml = logo
      ? `<img src="${esc(logo.onLight)}" height="36" alt="${esc(business.name)}" style="display:block;border:0;height:36px;width:auto;max-width:180px;color:${c.text};font:700 18px/36px ${brand.fonts.headingStack}">`
      : wordmark(business.name, 20, c.text, brand.fonts.headingStack);
    return `<tr><td height="4" bgcolor="${c.accent}" style="font-size:0;line-height:0">&nbsp;</td></tr>`
      + `<tr><td bgcolor="${c.card}" style="padding:20px 28px;border-bottom:1px solid ${c.border}">${logoHtml}</td></tr>`;
  }
  if (variant === 'O3') {
    const src = c.accentText === '#FFFFFF' && logo ? logo.onDark : (logo ? logo.onLight : null);
    const logoHtml = src
      ? `<img src="${esc(src)}" height="36" alt="${esc(business.name)}" style="display:block;border:0;height:36px;width:auto;max-width:180px;color:${c.accentText};font:700 18px/36px ${brand.fonts.headingStack}">`
      : wordmark(business.name, 20, c.accentText, brand.fonts.headingStack);
    return `<tr><td bgcolor="${c.accent}" style="padding:20px 28px;border-radius:10px 10px 0 0">${logoHtml}</td></tr>`
      + `<tr><td height="4" bgcolor="${c.accent}" style="font-size:0;line-height:0">&nbsp;</td></tr>`;
  }
  const logoHtml = logo
    ? `<img src="${esc(logo.onDark)}" height="36" alt="${esc(business.name)}" style="display:block;border:0;height:36px;width:auto;max-width:180px;color:${c.onBg};font:700 18px/36px ${brand.fonts.headingStack}">`
    : wordmark(business.name, 20, c.onBg, brand.fonts.headingStack);
  return `<tr><td bgcolor="${c.bg}" style="padding:20px 28px;border-radius:10px 10px 0 0">${logoHtml}</td></tr>`
    + `<tr><td height="4" bgcolor="${c.accent}" style="font-size:0;line-height:0">&nbsp;</td></tr>`;
}

/** A labelled card with a heading. */
export function card(title, body, brand) {
  const c = brand.colors;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid ${c.border};border-radius:8px;overflow:hidden">
<tr><td style="padding:18px 20px 6px;font:700 15px/22px ${brand.fonts.headingStack};color:${c.text}">${esc(title)}</td></tr>
<tr><td style="padding:0 20px 18px">${body}</td></tr></table>`;
}

/** Label/value rows. Every row except the last gets a 1 px bottom border. */
export function rows(pairs, brand) {
  const c = brand.colors;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">${pairs
    .map(([k, v], i) => {
      const border = i < pairs.length - 1 ? `border-bottom:1px solid ${c.border};` : '';
      return `<tr><td width="140" valign="top" style="padding:10px 12px 10px 0;${border}font:400 13px/20px ${brand.fonts.bodyStack};color:${c.muted}">${esc(k)}</td><td valign="top" style="padding:10px 0;${border}font:500 15px/22px ${brand.fonts.bodyStack};color:${c.text}">${v}</td></tr>`;
    })
    .join('')}</table>`;
}

/** Notes box, inside the Job card. Escape first, then convert line breaks. No border-left. */
export function notesBox(text, brand) {
  const c = brand.colors;
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  return `<div style="font:400 13px/20px ${brand.fonts.bodyStack};color:${c.muted};padding:14px 0 6px">Notes</div>`
    + `<div style="background:${c.tint};border-radius:6px;padding:14px 16px;font:400 15px/23px ${brand.fonts.bodyStack};color:${c.text}">${lines.map((l) => esc(l)).join('<br>')}</div>`;
}

/** Two half-width buttons, with a 2% spacer; one full-width button when there is no email. */
export function buttons({ callHref, callLabel, emailHref, emailLabel, brand, variant }) {
  const c = brand.colors;
  const emailBg = variant === 'O3' ? c.text : (variant === 'O2' ? c.bg : c.accent);
  const emailColor = variant === 'O3' ? c.card : (variant === 'O2' ? c.onBg : c.accentText);
  const callBtn = `<td width="49%" align="center" bgcolor="${c.accent}" style="border-radius:8px"><a href="${callHref}" style="display:block;padding:15px 10px;font:700 15px/20px ${brand.fonts.headingStack};color:${c.accentText};text-decoration:none;border-radius:8px">${callLabel}</a></td>`;
  if (!emailHref) {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate"><tr>`
      + `<td width="100%" align="center" bgcolor="${c.accent}" style="border-radius:8px"><a href="${callHref}" style="display:block;padding:15px 10px;font:700 15px/20px ${brand.fonts.headingStack};color:${c.accentText};text-decoration:none;border-radius:8px">${callLabel}</a></td></tr></table>`;
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate"><tr>`
    + callBtn
    + `<td width="2%" style="font-size:0;line-height:0">&nbsp;</td>`
    + `<td width="49%" align="center" bgcolor="${emailBg}" style="border-radius:8px"><a href="${emailHref}" style="display:block;padding:15px 10px;font:700 15px/20px ${brand.fonts.headingStack};color:${emailColor};text-decoration:none;border-radius:8px">${emailLabel}</a></td></tr></table>`;
}

/**
 * Full document. `preheader` is hidden from the layout but shown by some clients
 * as the list preview. Title/subtitle/body/footer arrive escaped where dynamic.
 */
export function shell({ preheader, header, body, footer, brand }) {
  const c = brand.colors;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">${headMeta(brand)}</head>
<body style="margin:0;padding:0;background:${c.canvas};font-family:${brand.fonts.bodyStack};color:${c.text}">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${preheader}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${c.canvas}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:${c.card};border:1px solid ${c.border};border-radius:10px;border-collapse:separate">
${header}
<tr><td style="padding:28px" class="px">${body}</td></tr>
<tr><td style="padding:20px 28px 28px" class="px">${footer}</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

