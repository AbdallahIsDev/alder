// lib/content.js — every piece of outbound copy lives here.
//
// Branding rule: anything a CUSTOMER sees carries only the roofer's business name.
// No studio name, no "AI", no automatic Google posting, no missed-call text-back,
// no time promise. Owner-facing messages may use the neutral "Lead Alerts".

import { escHtml, safeHeader } from './mail.js';
import { esc as escMail, button as mailButton, card as mailCard, rows as mailRows, quote as mailQuote, shell as mailShell } from './email-layout.js';

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

/**
 * Normalise a phone number for the owner email's tel: link, keeping the display
 * text separate. Strip everything except digits and a leading +.
 *  +1 prefix stays; 10 digits gets +1; 11 digits starting with 1 gets +; anything
 * else is the digits as typed, with no added prefix.
 */
export function toTelHref(raw) {
  const s = String(raw || '').trim();
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+')) return 'tel:+' + digits;
  if (digits.length === 10) return 'tel:+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return 'tel:+' + digits;
  return 'tel:' + digits;
}

/* ---------- owner email ---------- */

export function ownerEmail({ business, lead }) {
  const service = label('service', lead.service);
  const subject = safeHeader(`New lead: ${lead.name}, ${service} (ZIP ${lead.zip})`);
  const preheader = `${lead.name} · ${service} · ZIP ${lead.zip}`;
  const first = String(lead.name || '').trim().split(/\s+/)[0] || 'the customer';
  const telHref = toTelHref(lead.phone);
  const mailtoHref = `mailto:${escMail(lead.email || '')}`;
  const customerCard = mailCard('Customer', mailRows([
    ['Name', escMail(lead.name)],
    ['Phone', `<a href="${telHref}" style="color:#1c1f24;text-decoration:none">${escMail(lead.phone)}</a>`],
    ['Email', lead.email ? `<a href="${mailtoHref}" style="color:#1c1f24;text-decoration:none">${escMail(lead.email)}</a>` : '—'],
  ]));
  const jobCard = mailCard('Job', mailRows([
    ['Service', escMail(service)],
    ['Timing', escMail(label('timing', lead.timing))],
    ['Property', escMail(label('home', lead.home))],
    ['Roof age', escMail(lead.roof_age)],
    ['Insurance claim', escMail(lead.insurance_claim ? 'Yes' : 'No')],
    ['ZIP', escMail(lead.zip)],
  ]) + (lead.notes ? mailQuote(lead.notes) : ''));
  const buttonsRow = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr><td style="padding-right:10px">${mailButton(telHref, `Call ${escMail(first)}`)}</td><td>${mailButton(mailtoHref, `Email ${escMail(first)}`)}</td></tr></table>`;
  const body = buttonsRow + customerCard + jobCard;
  const subtitle = `Received ${receivedAt(business.timezone)} (${business.timezone || 'America/Chicago'})`;
  const footer = `Reply to this email to answer ${escMail(first)} directly.<br>Sent by Lead Alerts`;
  const html = mailShell({ preheader: escMail(preheader), title: 'New estimate request', subtitle: escMail(subtitle), body, footer });
  const text = [
    'New estimate request',
    `Received ${receivedAt(business.timezone)} (${business.timezone || 'America/Chicago'})`,
    '',
    'Customer',
    `Name: ${lead.name}`,
    `Phone: ${lead.phone}`,
    `Email: ${lead.email || '—'}`,
    '',
    'Job',
    `Service: ${service}`,
    `Timing: ${label('timing', lead.timing)}`,
    `Property: ${label('home', lead.home)}`,
    `Roof age: ${lead.roof_age}`,
    `Insurance claim: ${lead.insurance_claim ? 'Yes' : 'No'}`,
    `ZIP: ${lead.zip}`,
    ...(lead.notes ? ['', `Notes: ${lead.notes}`] : []),
    '',
    `Reply to this email to answer ${first} directly.`,
    'Sent by Lead Alerts',
  ].join('\n');
  return { subject, html, text };
}

/* ---------- Telegram lead alert ---------- */

/**
 * One rendering for the lead alert that every Telegram surface shares.
 * view: 'new' | 'contacted' | 'confirm' | 'done'. Only the last block changes.
 * Plain text only: parse_mode is never set anywhere in the Telegram path.
 * reviewResult (view 'done' only): 'sent' | 'failed' | 'no_email' | null.
 */
export function renderAlert({ business, lead, view = 'new', reviewResult = null }) {
  const first = String(lead.name || '').trim().split(/\s+/)[0] || 'there';
  const notes = lead.notes ? String(lead.notes).slice(0, 300) : '';
  const groups = [
    [`New lead · ${business.name}`],
    [`Name: ${lead.name}`, `Phone: ${displayPhone(lead.phone)}`],
  ];
  if (lead.email) groups[1].push(`Email: ${lead.email}`);
  groups.push([
    `Service: ${label('service', lead.service)}`,
    `Timing: ${label('timing', lead.timing)}`,
    `Property: ${label('home', lead.home)}`,
    `Roof age: ${lead.roof_age}`,
    `Insurance claim: ${lead.insurance_claim ? 'Yes' : 'No'}`,
    `ZIP: ${lead.zip}`,
  ]);
  if (notes) groups.push([`Notes: ${notes}`]);

  const tail = [];
  if (view === 'contacted') {
    tail.push('Status: Contacted');
  } else if (view === 'confirm') {
    tail.push('Status: Contacted');
    tail.push(lead.email
      ? `Send a review request to ${first}? This emails ${lead.email} a link to rate your work.`
      : 'No email on file, so no review request can be sent.');
  } else if (view === 'done') {
    if (reviewResult === 'sent') tail.push(`Status: Done. Review request sent to ${lead.email}.`);
    else if (reviewResult === 'failed') tail.push('Status: Done. Review request could not be sent.');
    else tail.push('Status: Done. No email on file, no review request sent.');
  } else {
    tail.push('Status: New');
  }
  groups.push(tail);
  return groups.map((g) => g.join('\n')).join('\n\n');
}

export function telegramAlertText({ business, lead }) {
  return renderAlert({ business, lead, view: 'new', reviewResult: null });
}

export function alertKeyboard(leadId) {
  return {
    inline_keyboard: [[{ text: 'Mark contacted', callback_data: 'c:' + leadId }]],
  };
}

/** Step 2: the job is being done. Tapping asks for confirmation, not an email. */
export function jobDoneKeyboard(leadId) {
  return {
    inline_keyboard: [[{ text: 'Job completed', callback_data: 'd:' + leadId }]],
  };
}

/** Step 3: only now does the roofer choose whether the customer gets the email. */
export function confirmKeyboard(leadId) {
  return {
    inline_keyboard: [[
      { text: 'Yes, send review request', callback_data: 'y:' + leadId },
      { text: 'Cancel', callback_data: 'n:' + leadId },
    ]],
  };
}

/* ---------- customer auto-reply ---------- */

export function autoReply({ business, lead }) {
  const first = String(lead.name || '').trim().split(/\s+/)[0] || 'there';
  const subject = safeHeader(`We received your request, ${first}`);
  const text = `Hi ${first},\n\nWe received your request and ${business.name} will be in touch about it.\n\nThank you.`;
  const body = `<p style="font-size:15px;margin:0 0 12px">Hi ${escMail(first)},</p><p style="font-size:15px;margin:0 0 12px">We received your request and ${escMail(business.name)} will be in touch about it.</p><p style="font-size:15px;margin:0 0 12px">Thank you.</p>`;
  const html = mailShell({ preheader: escMail(`We received your request, ${first}`), title: escMail(business.name), subtitle: '', body, footer: 'Sent by Lead Alerts' });
  return { subject, html, text };
}

/* ---------- review request ---------- */

export function reviewEmail({ business, token, siteUrl }) {
  const link = siteUrl.replace(/\/+$/, '') + '/r/' + encodeURIComponent(token);
  const subject = safeHeader(`How did we do, ${business.name}?`);
  const text = `Thank you for choosing ${business.name}. If you would like to leave a Google review, this link will take you there: ${link}\n\nYou can also share private feedback on the same page. The Google link works whether or not you leave feedback.`;
  const html = mailShell({
    preheader: escMail(`Thank you for choosing ${business.name}. Leave a Google review.`),
    title: escMail(business.name),
    subtitle: '',
    body: `<p style="font-size:15px;margin:0 0 14px">Thank you for choosing ${escMail(business.name)}.</p>`
      + mailButton(escMail(link), 'Leave a Google review', { align: 'center' })
      + `<p style="font-size:14px;margin:16px 0 0">You can also share private feedback on the same page. The Google link works whether or not you leave feedback.</p>`,
    footer: 'Sent by Lead Alerts',
  });
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
