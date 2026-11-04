// lib/email-layout.js — one shared shell for every email the system sends.
//
// Table-based, role="presentation", ALL styles inline, system font stack, no
// images, no remote resources, no <script>, no tracking pixels. Colours stay
// readable under automatic dark-mode inversion (dark text on light backgrounds
// only; no background images). A hidden preheader gives inbox list previews a
// human-readable summary. Nothing is fetched from a URL.
//
// The keep-everything-nothing-external rule is deliberate: this file is small
// enough to audit by eye, and it never imports anything.

/** Escape text and attribute values alike (covers &, <, >, ", '). */
export function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Bulletproof button: a real `<a>` for the link, wrapped in padded table cells.
 * `href` is already escaped when built by the caller.
 */
export function button(href, label, { align = 'left' } = {}) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${align}" style="border-collapse:collapse"><tr>
<td align="center" bgcolor="#1c1f24" style="padding:12px 22px;border-radius:6px"><a href="${href}" style="display:inline-block;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700"><span style="color:#ffffff;text-decoration:none">${label}</span></a></td>
</tr></table>`;
}

export function card(title, body) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid #e3e6ea;border-radius:8px;margin:14px 0">
<tr><td style="padding:14px 18px"><strong style="font-size:15px;color:#1c1f24">${esc(title)}</strong></td></tr>
<tr><td style="padding:0 18px 14px">${body}</td></tr></table>`;
}

export function rows(pairs) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">${pairs
    .map(([k, v]) => `<tr><td width="150" valign="top" style="padding:4px 10px 4px 0;color:#5b636e;font-size:13px">${esc(k)}</td><td style="padding:4px 0;color:#1c1f24;font-size:14px">${v}</td></tr>`)
    .join('')}</table>`;
}

/** A quoted box that preserves the customer's line breaks. Escape first, then split. */
export function quote(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  return `<div style="border-left:4px solid #1c1f24;background:#f4f6f8;padding:10px 14px;margin:8px 0;color:#1c1f24;font-size:14px">${lines.map((l) => esc(l)).join('<br>')}</div>`;
}

/**
 * The full document. `preheader` is hidden from the layout but shown by some
 * clients as the list preview. `title`, `subtitle`, `preheader` and the body are
 * escaped by the caller where dynamic.
 */
export function shell({ preheader, title, subtitle, body, footer }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#eef0f2;font-family:Arial,Helvetica,sans-serif;color:#1c1f24">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${preheader}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#eef0f2"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #dfe3e8;border-radius:8px">
<tr><td style="background:#1c1f24;color:#ffffff;padding:18px 24px;border-radius:8px 8px 0 0"><div style="font-size:18px;font-weight:700">${title}</div>${subtitle ? `<div style="font-size:13px;color:#d6dae0;margin-top:4px">${subtitle}</div>` : ''}</td></tr>
<tr><td style="padding:20px 24px">${body}</td></tr>
<tr><td style="padding:0 24px 18px;color:#6b7280;font-size:12px">${footer}</td></tr>
</table>
</td></tr></table>
</body></html>`;
}
