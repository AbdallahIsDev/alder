// lib/content.js — every piece of outbound copy lives here.
//
// Branding rule: anything a CUSTOMER sees carries only the roofer's business name.
// No studio name, no "AI", no automatic Google posting, no missed-call text-back,
// no time promise. Owner-facing messages may use the neutral "Lead Alerts".

import { escHtml, safeHeader } from './mail.js';

export const LABELS = {
  service: {
    replacement: 'Roof replacement', storm: 'Storm damage', repair: 'Repair', unsure: 'Not sure',
  },
  home: {
    house: 'House', multi: 'Townhome or duplex', commercial: 'Commercial', other: 'Other',
  },
  timing: {
    asap: 'As soon as possible', month: 'Within a month', quarter: 'In 1 to 3 months', planning: 'Just planning ahead',
  },
};

const label = (kind, value) => LABELS[kind]?.[value] || String(value || '');

export function receivedAt(timezone) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'America/Chicago',
      dateStyle: 'medium', timeStyle: 'short',
    }).format(new Date());
  } catch {
    return new Date().toISOString();
  }
}

/** A 10-digit number gets +1, an 11-digit starting with 1 gets +, so Telegram makes it tappable. */
export function displayPhone(phone) {
  const raw = String(phone || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (/^\d{10}$/.test(raw)) return '+1' + raw;
  if (/^\d{11}$/.test(raw) && raw.startsWith('1')) return '+' + raw;
  if (digits.length === 10 && /^[+\s().-]*\d/.test(raw)) return '+1' + raw;
  return raw;
}

export function phoneDigits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

/* ---------- owner email ---------- */

export function ownerEmail({ business, lead }) {
  const subject = safeHeader(`New estimate request: ${label('service', lead.service)}, ZIP ${lead.zip}`);
  const rows = [
    ['Name', lead.name],
    ['Phone', `<a href="tel:${phoneDigits(lead.phone)}">${escHtml(lead.phone)}</a>`],
    ['Email', lead.email || '—'],
    ['Service', label('service', lead.service)],
    ['Property', label('home', lead.home)],
    ['Start', label('timing', lead.timing)],
    ['Roof age', lead.roof_age],
    ['Insurance claim', lead.insurance_claim ? 'Yes' : 'No'],
    ['ZIP', lead.zip],
    ['Notes', lead.notes || '—'],
    ['Received', receivedAt(business.timezone)],
  ];
  const htmlRows = rows.map(([k, v], i) => {
    const value = i === 1 ? v : escHtml(v);            // the tel: link is ours, already escaped inside
    return `<tr><td style="padding:6px 14px 6px 0;color:#555">${escHtml(k)}</td><td style="padding:6px 0">${value}</td></tr>`;
  }).join('');
  const html = `<div style="font:15px/1.5 Arial,Helvetica,sans-serif;color:#1c1f24"><h2 style="font-size:18px;margin:0 0 12px">New estimate request</h2><table cellpadding="0" cellspacing="0">${htmlRows}</table></div>`;
  const text = ['New estimate request', ...rows.map(([k, v], i) => `${k}: ${i === 1 ? lead.phone : v}`)].join('\n');
  return { subject, html, text };
}

/* ---------- Telegram lead alert ---------- */

export function telegramAlertText({ business, lead }) {
  const lines = [
    'New lead for ' + business.name,
    lead.name,
    displayPhone(lead.phone),
    [label('service', lead.service), label('home', lead.home), label('timing', lead.timing)].join(' · '),
    `Roof age: ${lead.roof_age} · Insurance claim: ${lead.insurance_claim ? 'yes' : 'no'}`,
    'ZIP ' + lead.zip,
  ];
  if (lead.notes) lines.push('Notes: ' + String(lead.notes).slice(0, 300));
  return lines.join('\n');
}

export function alertKeyboard(leadId) {
  return {
    inline_keyboard: [[
      { text: 'Contacted', callback_data: 'c:' + leadId },
      { text: 'Job done', callback_data: 'd:' + leadId },
    ]],
  };
}

/* ---------- customer auto-reply ---------- */

export function autoReply({ business, lead }) {
  const first = String(lead.name || '').trim().split(/\s+/)[0] || 'there';
  const subject = safeHeader(`We received your request, ${first}`);
  const text = `Hi ${first},\n\nWe received your request and ${business.name} will be in touch about it.\n\nThank you.`;
  const html = `<div style="font:15px/1.6 Arial,Helvetica,sans-serif;color:#1c1f24"><p>Hi ${escHtml(first)},</p><p>We received your request and ${escHtml(business.name)} will be in touch about it.</p><p>Thank you.</p></div>`;
  return { subject, html, text };
}

/* ---------- review request ---------- */

export function reviewEmail({ business, token, siteUrl }) {
  const link = siteUrl.replace(/\/+$/, '') + '/r/' + encodeURIComponent(token);
  const subject = safeHeader(`How did we do, ${business.name}?`);
  const text = `Thank you for choosing ${business.name}. If you would like to leave a Google review, this link will take you there: ${link}\n\nYou can also share private feedback on the same page. The Google link works whether or not you leave feedback.`;
  const html = `<div style="font:15px/1.6 Arial,Helvetica,sans-serif;color:#1c1f24"><p>Thank you for choosing ${escHtml(business.name)}.</p><p><a href="${escHtml(link)}" style="display:inline-block;padding:12px 20px;background:#1c1f24;color:#fff;text-decoration:none;border-radius:4px">Leave a Google review</a></p><p>You can also share private feedback on the same page. The Google link works whether or not you leave feedback.</p></div>`;
  return { subject, html, text, link };
}

/* ---------- review page ---------- */

export function reviewPage({ business, token, googleUrl, rating, googleButton = true }) {
  const name = escHtml(business.name);
  const go = '/r/' + encodeURIComponent(token) + '/go';
  // The Google button is ALWAYS visible and identical for every visitor and every rating.
  const button = googleUrl
    ? `<a href="${escHtml(go)}" style="display:block;text-align:center;padding:18px 24px;background:#1c1f24;color:#fff;text-decoration:none;font-size:19px;font-weight:700;border-radius:6px;margin:0 0 28px">Leave a Google review</a>`
    : '';
  const thanks = rating
    ? `<p style="font:15px Arial,Helvetica,sans-serif;color:#333">Thank you for your feedback.</p>`
    : '';
  const form = `<form method="post" action="/r/${encodeURIComponent(token)}" style="font:15px Arial,Helvetica,sans-serif;color:#333">
      <p style="margin:0 0 8px">Optional: share private feedback with ${name}.</p>
      <label for="stars">Rating (1 to 5)</label>
      <select id="stars" name="stars" style="padding:8px;margin:0 0 12px">
        <option value="">Choose</option><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option><option value="5">5</option>
      </select><br>
      <label for="comment">Comment (optional, up to 1000 characters)</label><br>
      <textarea id="comment" name="comment" maxlength="1000" rows="4" style="width:100%;max-width:480px;padding:8px;margin:6px 0 12px"></textarea><br>
      <button type="submit" style="padding:10px 18px;background:#fff;color:#1c1f24;border:1px solid #1c1f24;border-radius:4px;cursor:pointer">Send feedback</button>
    </form>`;
  const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review ${name}</title></head>
<body style="margin:0;padding:32px 20px;background:#fafafa"><main style="max-width:520px;margin:0 auto;background:#fff;padding:28px;border-radius:8px">
<h1 style="font:700 24px Arial,Helvetica,sans-serif;color:#1c1f24;margin:0 0 20px">${name}</h1>
${button}${thanks}${form}
</main></body></html>`;
  return { html: doc, googleButton: !!googleUrl };
}
