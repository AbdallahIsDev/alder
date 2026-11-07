// lib/email-layout.js — one shared shell for every email the system sends.
//
// Table-based, role="presentation", ALL styles inline except the single <style>
// block the shell adds for @font-face and one small mobile rule. One image only:
// the brand logo as a CID inline image (cid:brand-logo, attached by lib/mail.js).
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

/**
 * Every HTML email this system sends carries this attribute on <body>. It is the
 * one thing a sender can be checked against without asserting on copy: a body
 * that came out of shell() has it, a hand-written <pre> does not.
 */
export const LAYOUT_MARKER = 'data-alder-layout="1"';

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
    + `<style>${fontFaces(brand)}:root{color-scheme:light only}@media (max-width:480px){.outer{padding:0!important}.card{border-radius:0!important;border:0!important}.px{padding-left:16px!important;padding-right:16px!important}}</style>`;
}

/** Wordmark fallback when the brand has no logo (the business name in the heading font). */
function wordmark(name, size, color, stack) {
  return `<div style="font:600 ${size}px/1.2 ${stack};color:${color}">${esc(name)}</div>`;
}

/**
 * The owner email header: dark brand band with the logo, title "New estimate
 * request", subtitle, then a 4 px accent bar. There is exactly one design.
 */
export function ownerHeader({ business, received, brand }) {
  const c = brand.colors;
  const logo = brand.logo;
  // CID inline image (attached by lib/mail.js): 32x32 reserved, alt empty
  // because the business name is printed right next to it.
  const logoImg = () =>
    `<img src="cid:brand-logo" width="32" height="32" alt="" style="display:block;border:0;width:32px;height:32px;">`;
  const logoBrand = (inner) =>
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr><td style="padding:0;vertical-align:middle">${inner}</td><td style="padding:0 0 0 10px;vertical-align:middle"><div style="font:600 18px/24px ${brand.fonts.headingStack};color:${c.onBg};white-space:nowrap">${esc(business.name)}</div></td></tr></table>`;
  const logoHtml = logo
    ? logoBrand(logoImg())
    : wordmark(business.name, 20, c.onBg, brand.fonts.headingStack);
  return `<tr><td class="px" bgcolor="${c.bg}" style="padding:18px 24px;border-radius:10px 10px 0 0">${logoHtml}`
    + `<div style="font:600 20px/26px ${brand.fonts.headingStack};color:${c.onBg};padding-top:18px">New estimate request</div>`
    + `<div style="font:400 13px/20px ${brand.fonts.bodyStack};color:${c.onBgMuted};padding-top:2px">${esc(received)}</div></td></tr>`
    + `<tr><td height="4" bgcolor="${c.accent}" style="font-size:0;line-height:0">&nbsp;</td></tr>`;
}

/**
 * A customer-facing header: the same dark band as the owner email, but logo
 * only (no title, no subtitle).
 */
export function customerHeader({ business, brand }) {
  const c = brand.colors;
  const logo = brand.logo;
  const logoImg = () =>
    `<img src="cid:brand-logo" width="32" height="32" alt="" style="display:block;border:0;width:32px;height:32px;">`;
  const logoBrand = (inner) =>
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr><td style="padding:0;vertical-align:middle">${inner}</td><td style="padding:0 0 0 10px;vertical-align:middle"><div style="font:600 18px/24px ${brand.fonts.headingStack};color:${c.onBg};white-space:nowrap">${esc(business.name)}</div></td></tr></table>`;
  const logoHtml = logo
    ? logoBrand(logoImg())
    : wordmark(business.name, 20, c.onBg, brand.fonts.headingStack);
  return `<tr><td class="px" bgcolor="${c.bg}" style="padding:18px 24px;border-radius:10px 10px 0 0">${logoHtml}</td></tr>`
    + `<tr><td height="4" bgcolor="${c.accent}" style="font-size:0;line-height:0">&nbsp;</td></tr>`;
}

/**
 * An operations header: the same dark band and logo as the owner email, but no
 * business name and no lead language. `title` is the message's own name, so the
 * body does not have to repeat it.
 */
export function opsHeader({ title, subtitle, brand }) {
  const c = brand.colors;
  const logoImg = () =>
    `<img src="cid:brand-logo" width="32" height="32" alt="" style="display:block;border:0;width:32px;height:32px;">`;
  const logoHtml = brand.logo
    ? logoImg()
    : wordmark('Lead Alerts', 20, c.onBg, brand.fonts.headingStack);
  return `<tr><td class="px" bgcolor="${c.bg}" style="padding:18px 24px;border-radius:10px 10px 0 0">${logoHtml}`
    + `<div style="font:600 20px/26px ${brand.fonts.headingStack};color:${c.onBg};padding-top:18px">${esc(title)}</div>`
    + (subtitle ? `<div style="font:400 13px/20px ${brand.fonts.bodyStack};color:${c.onBgMuted};padding-top:2px">${esc(subtitle)}</div>` : '')
    + `</td></tr>`
    + `<tr><td height="4" bgcolor="${c.accent}" style="font-size:0;line-height:0">&nbsp;</td></tr>`;
}

/** A labelled card with a heading. */
export function card(title, body, brand) {
  const c = brand.colors;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid ${c.border};border-radius:8px;overflow:hidden">
<tr><td style="padding:18px 20px 6px;font:600 15px/22px ${brand.fonts.headingStack};color:${c.text}">${esc(title)}</td></tr>
<tr><td style="padding:0 20px 18px">${body}</td></tr></table>`;
}

/** Label/value rows in the new compact style (label 96, 8px padding, 13/15px). */
export function rows(pairs, brand) {
  const c = brand.colors;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">${pairs
    .map(([k, v], i) => {
      const border = i < pairs.length - 1 ? `border-bottom:1px solid ${c.border};` : '';
      return `<tr><td width="96" valign="top" style="padding:8px 12px 8px 0;${border}font:400 13px/18px ${brand.fonts.bodyStack};color:${c.muted}">${esc(k)}</td><td valign="top" style="padding:8px 0;${border}font:500 15px/21px ${brand.fonts.bodyStack};color:${c.text};word-break:break-word">${v}</td></tr>`;
    })
    .join('')}</table>`;
}

/** Notes box, inside the Job section. Escape first, then convert line breaks. No border-left. */
export function notesBox(text, brand) {
  const c = brand.colors;
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  return `<div style="font:400 13px/18px ${brand.fonts.bodyStack};color:${c.muted};">Notes</div>`
    + `<div style="background:${c.tint};border-radius:6px;padding:12px 14px;font:400 15px/21px ${brand.fonts.bodyStack};color:${c.text}">${lines.map((l) => esc(l)).join('<br>')}</div>`;
}

/** Exactly two buttons below the Job card: Call (accent) and Email (dark bg). */
export function buttons({ callHref, callLabel, emailHref, emailLabel, brand }) {
  const c = brand.colors;
  const callBtn = `<td width="49%" align="center" bgcolor="${c.accent}" style="border-radius:8px"><a href="${callHref}" style="display:block;padding:15px 10px;font:600 16px/20px ${brand.fonts.headingStack};color:${c.accentText};text-decoration:none;border-radius:8px">${callLabel}</a></td>`;
  if (!emailHref) {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate"><tr>`
      + `<td width="100%" align="center" bgcolor="${c.accent}" style="border-radius:8px"><a href="${callHref}" style="display:block;padding:15px 10px;font:600 16px/20px ${brand.fonts.headingStack};color:${c.accentText};text-decoration:none;border-radius:8px">${callLabel}</a></td></tr></table>`;
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate"><tr>`
    + callBtn
    + `<td width="2%" style="font-size:0;line-height:0">&nbsp;</td>`
    + `<td width="49%" align="center" bgcolor="${c.bg}" style="border-radius:8px"><a href="${emailHref}" style="display:block;padding:15px 10px;font:600 16px/20px ${brand.fonts.headingStack};color:${c.onBg};text-decoration:none;border-radius:8px">${emailLabel}</a></td></tr></table>`;
}

/**
 * Full document. `preheader` is hidden from the layout but shown by some clients
 * as the list preview. Title/subtitle/body/footer arrive escaped where dynamic.
 */
export function shell({ preheader, header, body, footer, brand }) {
  const c = brand.colors;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">${headMeta(brand)}</head>
<body ${LAYOUT_MARKER} style="margin:0;padding:0;background:${c.canvas};font-family:${brand.fonts.bodyStack};color:${c.text}">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${preheader}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${c.canvas}"><tr><td class="outer" align="center" style="padding:24px 12px">
<table class="card" role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:${c.card};border:1px solid ${c.border};border-radius:10px;border-collapse:separate">
${header}
<tr><td style="padding:24px 24px" class="px">${body}</td></tr>
<tr><td style="padding:8px 24px 24px" class="px">${footer}</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

