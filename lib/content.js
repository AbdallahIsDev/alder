// lib/content.js — every piece of outbound copy lives here.
//
// Branding rule: anything a CUSTOMER sees carries only the roofer's business name.
// No studio name, no "AI", no automatic Google posting, no missed-call text-back,
// no time promise. Owner-facing messages may use the neutral "Lead Alerts".

import { escHtml, safeHeader } from './mail.js';
import {
  esc as escMail,
  ownerHeader, customerHeader, card as mailCard, rows as mailRows,
  notesBox as mailNotes, buttons as mailButtons, shell as mailShell,
} from './email-layout.js';
import { getBrand } from './brand.js';

/** The owner email's design variant shown to the roofer. Switch here to repaint
 *  every owner email without touching the builder (see docs/EMAIL_SYSTEM.md). */
export const OWNER_VARIANT = 'O1';

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

export function ownerEmail({ business, lead, variant = OWNER_VARIANT }) {
  const brand = getBrand();
  const c = brand.colors;
  const service = label('service', lead.service);
  const subject = safeHeader(`New lead: ${lead.name}, ${service} (ZIP ${lead.zip})`);
  const preheader = `${lead.name} · ${service} · ZIP ${lead.zip}`;
  const first = String(lead.name || '').trim().split(/\s+/)[0] || 'the customer';
  const telHref = toTelHref(lead.phone);
  const mailtoHref = `mailto:${escMail(lead.email || '')}`;
  const customerCard = mailCard('Customer', mailRows([
    ['Name', escMail(lead.name)],
    ['Phone', `<a href="${telHref}" style="color:${c.text};text-decoration:none">${escMail(lead.phone)}</a>`],
    ['Email', lead.email ? `<a href="${mailtoHref}" style="color:${c.text};text-decoration:none">${escMail(lead.email)}</a>` : '—'],
  ], brand), brand);
  const jobCard = mailCard('Job', mailRows([
    ['Service', escMail(service)],
    ['Timing', escMail(label('timing', lead.timing))],
    ['Property', escMail(label('home', lead.home))],
    ['Roof age', escMail(lead.roof_age)],
    ['Insurance claim', escMail(lead.insurance_claim ? 'Yes' : 'No')],
    ['ZIP', escMail(lead.zip)],
  ], brand) + (lead.notes ? mailNotes(lead.notes, brand) : ''), brand);
  const btns = mailButtons({
    callHref: telHref, callLabel: `Call ${escMail(first)}`,
    emailHref: lead.email ? mailtoHref : null, emailLabel: `Email ${escMail(first)}`,
    brand, variant,
  });
  const body = customerCard
    + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td height="16" style="font-size:0;line-height:0">&nbsp;</td></tr></table>`
    + jobCard
    + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td height="16" style="font-size:0;line-height:0">&nbsp;</td></tr></table>`
    + btns;
  const received = `Received ${receivedAt(business.timezone)} (${business.timezone || 'America/Chicago'})`;
  const footer = `<p style="margin:0 0 8px;font:400 13px/20px ${brand.fonts.bodyStack};color:${c.muted}">Reply to this email to answer ${escMail(first)} directly.</p>`
    + `<p style="margin:0;font:400 12px/18px ${brand.fonts.bodyStack};color:${c.muted}">Sent by Lead Alerts</p>`;
  const html = mailShell({
    preheader: escMail(preheader),
    header: ownerHeader({ business, variant, received, brand }),
    body, footer, brand,
  });
  const text = [
    'New estimate request',
    received,
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
    `Call: ${lead.phone}`,
    `Email: ${lead.email || ''}`,
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
  const brand = getBrand();
  const c = brand.colors;
  const first = String(lead.name || '').trim().split(/\s+/)[0] || 'there';
  const subject = safeHeader(`We received your request, ${first}`);
  const text = `Hi ${first},\n\nWe received your request and ${business.name} will be in touch about it.\n\nThank you.`;
  const body = `<p style="font-size:15px;margin:0 0 12px">Hi ${escMail(first)},</p><p style="font-size:15px;margin:0 0 12px">We received your request and ${escMail(business.name)} will be in touch about it.</p><p style="font-size:15px;margin:0 0 12px">Thank you.</p>`;
  const html = mailShell({
    preheader: escMail(`We received your request, ${first}`),
    header: customerHeader({ business, variant: OWNER_VARIANT, brand }),
    body,
    footer: `<p style="margin:0;font:400 12px/18px ${brand.fonts.bodyStack};color:${c.muted}">Sent by ${escMail(business.name)}</p>`,
    brand,
  });
  return { subject, html, text };
}

/* ---------- review request ---------- */

export function reviewEmail({ business, token, siteUrl, variant = 'R1' }) {
  const brand = getBrand();
  const c = brand.colors;
  const base = String(siteUrl || '').replace(/\/+$/, '');
  const subject = safeHeader(`How did we do, ${business.name}?`);
  const heading = `<div style="font:700 22px/28px ${brand.fonts.headingStack};color:${c.text};padding:32px 28px 0">Thank you for choosing ${escMail(business.name)}.</div>`;

  if (variant === 'R2') {
    const stars = [1, 2, 3, 4, 5].map((n) =>
      `<td width="20%" align="center"><a href="${escMail(base + '/r/' + encodeURIComponent(token) + '?s=' + n)}" aria-label="${n} stars" title="${n} stars" style="display:block;padding:6px 0;font:400 38px/44px Arial,sans-serif;color:#E0A800;text-decoration:none">&#9734;&#xFE0E;</a></td>`
    ).join('');
    const body = `<div style="padding:4px 28px 6px"><p style="font:400 15px/22px ${brand.fonts.bodyStack};color:${c.text};margin:0 0 8px">How did we do? Tap a star to rate your experience.</p>`
      + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse"><tr>${stars}</tr></table></div>`;
    const html = mailShell({
      preheader: escMail(`Thank you for choosing ${business.name}. Tap a star to rate your experience.`),
      header: customerHeader({ business, variant: OWNER_VARIANT, brand }),
      body, footer: `<p style="margin:0;font:400 12px/18px ${brand.fonts.bodyStack};color:${c.muted}">Sent by ${escMail(business.name)}</p>`,
      brand,
    });
    const text = `Thank you for choosing ${business.name}.\n\nHow did we do? Tap a star to rate your experience.\n\n${[1, 2, 3, 4, 5].map((n) => `${n} stars: ${base}/r/${encodeURIComponent(token)}?s=${n}`).join('\n')}`;
    return { subject, html, text, link: base + '/r/' + encodeURIComponent(token) + '?s=1' };
  }

  // R1 (default): a single button.
  const link = base + '/r/' + encodeURIComponent(token) + '?go=1';
  const text = `Thank you for choosing ${business.name}. If you have a minute, we would really appreciate a Google review. This link will take you there: ${link}`;
  const html = mailShell({
    preheader: escMail(`Thank you for choosing ${business.name}. Leave a Google review.`),
    header: customerHeader({ business, variant: OWNER_VARIANT, brand }),
    body: `<div style="padding:32px 28px 28px"><p style="font:400 15px/22px ${brand.fonts.bodyStack};color:${c.text};margin:0 0 14px">If you have a minute, we would really appreciate a Google review.</p>`
      + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr><td align="center" bgcolor="#FFFFFF" style="border:1px solid #DADCE0;border-radius:8px"><a href="${escMail(link)}" style="display:block;padding:14px 22px;font:700 15px/20px ${brand.fonts.headingStack};color:#3C4043;text-decoration:none"><img src="${escMail(base + '/assets/email/google-g.png')}" width="20" height="20" alt="" style="vertical-align:middle;border:0;margin-right:10px">Leave a Google review</a></td></tr></table></div>`,
    footer: `<p style="margin:0;font:400 12px/18px ${brand.fonts.bodyStack};color:${c.muted}">Sent by ${escMail(business.name)}</p>`,
    brand,
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

/** Google review hosts a business may point at. Anything else is rejected. */
export const GOOGLE_HOSTS = ['www.google.com', 'google.com', 'search.google.com', 'maps.google.com', 'g.page', 'maps.app.goo.gl', 'goo.gl'];

export function googleUrlAllowed(v) {
  if (typeof v !== 'string') return null;
  let u;
  try { u = new URL(v); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (!GOOGLE_HOSTS.includes(u.hostname)) return null;
  return u.toString();
}

/**
 * The new single-purpose landing page served by /r/<token>?s=N and ?go=1.
 * A GET never writes anything; the page's own JavaScript POSTs the rating.
 * Values are embedded as JSON with < escaped as \u003c. No app URL schemes:
 * a plain https redirect lets Google hand off to the Maps app or the browser.
 */
export function reviewLandingPage({ business, token, googleUrl, stars }) {
  const brand = getBrand();
  const c = brand.colors;
  const link = googleUrlAllowed(googleUrl);
  const name = escHtml(business.name);
  const postUrl = '/r/' + encodeURIComponent(token);
  const starRow = `<div id="stars" aria-hidden="true" style="font:400 40px/48px Arial,sans-serif;text-align:center;letter-spacing:6px;margin:10px 0;color:${c.muted}">`
    + [1, 2, 3, 4, 5].map(() => '<span>&#9734;</span>').join('') + `</div>`;
  const cfg = JSON.stringify({
    googleUrl: link || '',
    postUrl,
    stars: stars || 0,
    doGo: !link,
  }).replace(/</g, '\\u003c');
  const body = link
    ? `<h1 style="font:700 24px/30px ${brand.fonts.headingStack};color:${c.text};text-align:center;margin:0 0 8px">Thank you!</h1>`
      + `<p style="font:400 15px/22px ${brand.fonts.bodyStack};color:${c.muted};text-align:center;margin:0 0 20px">Taking you to Google to finish your review...</p>`
      + (stars ? starRow : '')
      + `<p style="text-align:center;margin:0 0 24px"><a href="${escHtml(link)}" style="color:${c.text};text-decoration:underline;font:400 15px/22px ${brand.fonts.bodyStack}">Continue to Google</a></p>`
    : `<h1 style="font:700 24px/30px ${brand.fonts.headingStack};color:${c.text};text-align:center;margin:0 0 8px">Thank you!</h1>`
      + `<p style="font:400 15px/22px ${brand.fonts.bodyStack};color:${c.muted};text-align:center;margin:0">Review link unavailable</p>`;
  // One keepalive POST records both the rating and the Google click mark; the
  // handler tells them apart by field (stars + go=1). The redirect happens
  // regardless of whether the POST finished.
  const script = `<script>(function(){var C=${cfg};if(C.doGo)return;
function post(){var body=new URLSearchParams();if(C.stars){body.set('stars',String(C.stars));body.set('comment','');}body.set('go','1');
fetch(C.postUrl,{method:'POST',body:body,keepalive:true}).catch(function(){});}
if(C.stars){var st=document.getElementById('stars');if(st){var nodes=st.querySelectorAll('span');
var reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
var fill=function(n){for(var i=0;i<nodes.length;i++){nodes[i].innerHTML=i<n?'\\u2605':'\\u2606';nodes[i].style.color=i<n?'#F4B400':'#73777D';}};
if(reduce){fill(C.stars);setTimeout(function(){location.replace(C.googleUrl);},400);}
else{var i=0;var tick=function(){if(i<C.stars){i++;fill(i);setTimeout(tick,90);}else{setTimeout(function(){location.replace(C.googleUrl);},1000);}};tick();}}}
post();
if(!C.stars)setTimeout(function(){location.replace(C.googleUrl);},150);
}
})();
</script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + (link ? `<noscript><meta http-equiv="refresh" content="1;url=${escHtml(link)}"></noscript>` : '')
    + `<title>Review ${name}</title></head>`
    + `<body style="margin:0;padding:32px 20px;background:${c.canvas}"><main style="max-width:480px;margin:0 auto;background:${c.card};padding:28px;border-radius:8px;border:1px solid ${c.border}">
${body}
</main>${script}</body></html>`;
}


