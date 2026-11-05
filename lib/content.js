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

/**
 * A value starting with + is shown unchanged (never prefix a second +);
 * otherwise a value with exactly 10 digits gets +1 (legacy rows) and an
 * 11-digit value starting with 1 gets +, so Telegram makes it tappable.
 * toTelHref() applies the same rule to tel: links.
 */
export function displayPhone(phone) {
  const raw = String(phone || '').trim();
  if (raw.startsWith('+')) return raw;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + raw;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + raw;
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

export function ownerEmail({ business, lead }) {
  const brand = getBrand();
  const c = brand.colors;
  const service = label('service', lead.service);
  const subject = safeHeader(`New lead: ${lead.name}, ${service} (ZIP ${lead.zip})`);
  const preheader = `${lead.name} · ${service} · ZIP ${lead.zip}`;
  const first = String(lead.name || '').trim().split(/\s+/)[0] || 'the customer';
  const telHref = toTelHref(lead.phone);
  const mailtoHref = `mailto:${escMail(lead.email || '')}`;
  const customerSection = mailRows([
    ['Name', escMail(lead.name)],
    ['Phone', `<a href="${telHref}" style="color:${c.text};text-decoration:none">${escMail(lead.phone)}</a>`],
    ['Email', lead.email ? `<a href="${mailtoHref}" style="color:${c.text};text-decoration:none;word-break:break-all">${escMail(lead.email)}</a>` : '—'],
  ], brand);
  const jobSection = mailRows([
    ['Service', escMail(service)],
    ['Timing', escMail(label('timing', lead.timing))],
    ['Property', escMail(label('home', lead.home))],
    ['Roof age', escMail(lead.roof_age)],
    ['Insurance claim', escMail(lead.insurance_claim ? 'Yes' : 'No')],
    ['ZIP', escMail(lead.zip)],
  ], brand) + (lead.notes ? mailNotes(lead.notes, brand) : '');
  const btns = mailButtons({
    callHref: telHref, callLabel: `Call ${escMail(first)}`,
    emailHref: lead.email ? mailtoHref : null, emailLabel: `Email ${escMail(first)}`,
    brand,
  });
  // Sections are plain (no inner cards): heading, rows, an edge-to-edge divider,
  // Job heading, rows, then the buttons below a 16 px spacer.
  const body = `<div style="font:700 13px/18px ${brand.fonts.headingStack};color:${c.muted};padding:14px 0 4px">Customer</div>`
    + customerSection
    + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td height="1" style="font-size:0;line-height:0;border-top:1px solid ${c.border}">&nbsp;</td></tr></table>`
    + `<div style="font:700 13px/18px ${brand.fonts.headingStack};color:${c.muted};padding:14px 0 4px">Job</div>`
    + jobSection
    + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td height="16" style="font-size:0;line-height:0">&nbsp;</td></tr></table>`
    + btns;
  const received = `Received ${receivedAt(business.timezone)} (${business.timezone || 'America/Chicago'})`;
  const footer = `<p style="margin:0 0 8px;font:400 13px/20px ${brand.fonts.bodyStack};color:${c.muted}">Reply to this email to answer ${escMail(first)} directly.</p>`
    + `<p style="margin:0;font:400 12px/18px ${brand.fonts.bodyStack};color:${c.muted}">Sent by Lead Alerts</p>`;
  const html = mailShell({
    preheader: escMail(preheader),
    header: ownerHeader({ business, received, brand }),
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
 * view: 'new' | 'contacted' | 'confirm' | 'done' | 'error'. Only the last
 * block changes: one fact per line, every line at most 40 characters for a
 * sample first name "John", and the email address never appears there.
 * Plain text only: parse_mode is never set anywhere in the Telegram path.
 * reviewResult (view 'done' only): 'sent' | 'failed' | 'no_email' | null.
 * 'failed' (any view) renders the error block, same as view 'error'.
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
  if (view === 'error' || reviewResult === 'failed') {
    tail.push('❌ Status: Error');
    tail.push('⚠️ Review request couldn\'t be sent');
  } else if (view === 'contacted') {
    tail.push('🔵 Status: Contacted');
  } else if (view === 'confirm') {
    tail.push('🔵 Status: Contacted');
    tail.push(lead.email
      ? `Send a review request to ${first}?`
      : 'No email on file. Can\'t send a request.');
    if (lead.email) tail.push('They get an email with a rating link.');
  } else if (view === 'done') {
    if (reviewResult === 'sent') {
      tail.push('✅ Status: Done');
      tail.push('✉️ Review request sent');
    } else {
      tail.push('✅ Status: Done');
      tail.push('ℹ️ No email on file, none was sent.');
    }
  } else {
    tail.push('🟡 Status: New');
  }
  groups.push(tail);
  return groups.map((g) => g.join('\n')).join('\n\n');
}

export function telegramAlertText({ business, lead }) {
  return renderAlert({ business, lead, view: 'new', reviewResult: null });
}

export function alertKeyboard(leadId) {
  return {
    inline_keyboard: [[{ text: 'Mark contacted', callback_data: 'c:' + leadId, style: 'primary' }]],
  };
}

/** Step 2: the job is being done. Tapping asks for confirmation, not an email. */
export function jobDoneKeyboard(leadId) {
  return {
    inline_keyboard: [[{ text: 'Job completed', callback_data: 'd:' + leadId, style: 'primary' }]],
  };
}

/** Error state: one retry button. `r:` resends the review email only. */
export function tryAgainKeyboard(leadId) {
  return {
    inline_keyboard: [[{ text: 'Try again', callback_data: 'r:' + leadId, style: 'primary' }]],
  };
}

/** Step 3: only now does the roofer choose whether the customer gets the email. */
export function confirmKeyboard(leadId) {
  return {
    inline_keyboard: [[
      { text: 'Yes, send review request', callback_data: 'y:' + leadId, style: 'success' },
      { text: 'Cancel', callback_data: 'n:' + leadId, style: 'danger' },
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
    header: customerHeader({ business, brand }),
    body,
    footer: `<p style="margin:0;font:400 12px/18px ${brand.fonts.bodyStack};color:${c.muted}">Sent by ${escMail(business.name)}</p>`,
    brand,
  });
  return { subject, html, text };
}

/* ---------- review request: one feedback link ---------- */

export function reviewEmail({ business, token, siteUrl }) {
  const brand = getBrand();
  const c = brand.colors;
  const base = String(siteUrl || '').replace(/\/+$/, '');
  const subject = safeHeader(`How did we do, ${business.name}?`);
  const url = base + '/r/' + encodeURIComponent(token);
  // No horizontal padding here: the shell's body cell (.px, 24px) is the one
  // horizontal inset, so heading, line and button share the same left edge.
  const body = `<div style="padding:4px 0 6px"><h1 style="font:700 22px/28px ${brand.fonts.headingStack};color:${c.text};margin:0 0 8px">Thank you for choosing ${escMail(business.name)}.</h1><p style="font:400 15px/22px ${brand.fonts.bodyStack};color:${c.muted};margin:0 0 18px">We’d love to hear how we did.</p><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr><td bgcolor="${c.accent}" style="border-radius:8px"><a href="${escMail(url)}" style="display:block;padding:15px 28px;font:700 15px/20px ${brand.fonts.headingStack};color:${c.accentText};text-decoration:none;border-radius:8px">Share your feedback</a></td></tr></table></div>`;
  const html = mailShell({
    preheader: escMail(`Thank you for choosing ${business.name}.`),
    header: customerHeader({ business, brand }),
    body, footer: `<p style="margin:0;font:400 12px/18px ${brand.fonts.bodyStack};color:${c.muted}">Sent by ${escMail(business.name)}</p>`,
    brand,
  });
  const text = `Thank you for choosing ${business.name}.\n\nWe’d love to hear how we did.\n\nShare your feedback: ${url}`;
  return { subject, html, text, link: url };
}

/* ---------- review rating page ---------- */

export function reviewPage({ business, token, googleUrl, stars = 0 }) {
  const brand = getBrand();
  const c = brand.colors;
  const link = googleUrlAllowed(googleUrl);
  const initialStars = Number.isInteger(stars) && stars >= 1 && stars <= 5 ? stars : 0;
  const name = escHtml(business.name);
  const postUrl = '/r/' + encodeURIComponent(token);
  const starPath = 'M12 2.5l2.9 6.1 6.6.9-4.8 4.6 1.2 6.6L12 17.4 6.1 20.7l1.2-6.6L2.5 9.5l6.6-.9z';
  const starButtons = [1, 2, 3, 4, 5].map((n) => `<button type="button" role="radio" aria-checked="false" aria-label="${n} stars" data-star="${n}" style="display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;min-width:44px;min-height:44px;padding:0;border:0;background:transparent;cursor:pointer;user-select:none;-webkit-user-select:none"><svg width="34" height="34" viewBox="0 0 24 24" aria-hidden="true" style="display:block;fill:none;stroke:#9AA0A6;stroke-width:1.5;user-select:none;-webkit-user-select:none"><path d="${starPath}"/></svg></button>`).join('');
  const cfg = JSON.stringify({ googleUrl: link || '', postUrl, stars: initialStars, doGo: !link }).replace(/</g, '\\u003c');
  const body = link
    ? `<h1 style="font:700 24px/30px ${brand.fonts.headingStack};color:${c.text};text-align:center;margin:0 0 14px">How was your experience with ${name}?</h1>`
      + `<div id="stars" role="radiogroup" aria-label="Rating" style="display:flex;justify-content:center;gap:2px;margin:14px 0 18px">${starButtons}</div>`
      + `<label for="comment" style="display:block;font:400 14px/20px ${brand.fonts.bodyStack};color:${c.text};margin:0 0 6px">Anything you’d like to tell ${name}? (optional)</label>`
      + `<textarea id="comment" name="comment" maxlength="1000" rows="4" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid ${c.border};border-radius:6px;font:400 15px/21px ${brand.fonts.bodyStack};color:${c.text};resize:vertical"></textarea>`
      + `<p style="font:400 13px/18px ${brand.fonts.bodyStack};color:${c.muted};margin:6px 0 16px">This note goes to ${name}. Your public review is written on Google next.</p>`
      + `<button id="continue" type="button" disabled style="display:block;width:100%;padding:15px 28px;border:0;border-radius:8px;background:${c.accent};color:${c.accentText};font:700 15px/20px ${brand.fonts.headingStack};cursor:pointer">Continue to Google</button>`
      + `<noscript><p style="text-align:center;margin:16px 0 0"><a href="${escHtml(link)}" style="color:${c.text};font:400 15px/22px ${brand.fonts.bodyStack}">Continue to Google</a></p></noscript>`
    : `<h1 style="font:700 24px/30px ${brand.fonts.headingStack};color:${c.text};text-align:center;margin:0 0 12px">How was your experience with ${name}?</h1>`
      + `<p style="font:400 15px/22px ${brand.fonts.bodyStack};color:${c.muted};text-align:center;margin:0">Review link unavailable</p>`;
  const script = `<script>(function(){var C=${cfg};if(C.doGo)return;
var group=document.getElementById('stars');var btn=document.getElementById('continue');var comment=document.getElementById('comment');
if(!group||!btn)return;var buttons=Array.prototype.slice.call(group.querySelectorAll('button[data-star]'));
var selected=C.stars||0;
function paint(n){buttons.forEach(function(b){var v=Number(b.getAttribute('data-star'));var sel=v<=n;var p=b.querySelector('path');if(p){p.setAttribute('fill',sel?'#F4B400':'none');p.setAttribute('stroke',sel?'#F4B400':'#9AA0A6');}b.setAttribute('aria-checked',v===selected?'true':'false');});}
function choose(n){selected=Number(n)||0;btn.disabled=!selected;paint(selected);}
buttons.forEach(function(b){var n=Number(b.getAttribute('data-star'));b.addEventListener('pointerenter',function(){paint(n)});b.addEventListener('pointerleave',function(){paint(selected)});b.addEventListener('focus',function(){paint(n)});b.addEventListener('blur',function(){paint(selected)});b.addEventListener('click',function(){choose(n);b.focus();});b.addEventListener('keydown',function(e){if(e.key==='ArrowRight'||e.key==='ArrowUp'||e.key==='ArrowDown'||e.key==='ArrowLeft'){e.preventDefault();var d=(e.key==='ArrowRight'||e.key==='ArrowUp')?1:-1;choose(Math.min(5,Math.max(1,(selected||n)+d)));}});});
paint(selected);btn.disabled=!selected;
btn.addEventListener('click',function(){if(btn.disabled)return;btn.disabled=true;var body=new URLSearchParams();body.set('stars',String(selected));body.set('comment',comment?comment.value:'');body.set('go','1');var settled=false;function go(){if(!settled){settled=true;window.location.assign(C.googleUrl);}}var request=fetch(C.postUrl,{method:'POST',body:body,keepalive:true}).catch(function(){});var timer=setTimeout(go,1500);request.then(function(){clearTimeout(timer);go();});});})();
</script>`;
  return {
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
      + `<title>Review ${name}</title></head>`
      + `<body style="box-sizing:border-box;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:16px;background:${c.canvas};margin:0">`
      + `<main style="width:100%;max-width:480px;margin:0;box-sizing:border-box;background:${c.card};padding:28px;border-radius:8px;border:1px solid ${c.border}">${body}</main>${script}</body></html>`,
    googleButton: !!link,
  };
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
 * Backwards-compatible name for the interactive rating page used by every
 * legacy entry point (?s=N, ?go=1 and /r/<token>/go). It renders exactly the
 * same page as reviewPage() and never writes on GET.
 */
export function reviewLandingPage({ business, token, googleUrl, stars = 0 }) {
  return reviewPage({ business, token, googleUrl, stars }).html;
}


