// lib/content.js — every piece of outbound copy lives here.
//
// Branding rule: anything a CUSTOMER sees carries only the roofer's business name.
// No studio name, no "AI", no automatic Google posting, no missed-call text-back,
// no time promise. Owner-facing messages may use the neutral "Lead Alerts".

import { escHtml, safeHeader } from './mail.js';
import {
  esc as escMail,
  ownerHeader, customerHeader, rows as mailRows,
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

/** Service label shared by the lead alert and the /leads list. */
export function serviceLabel(value) { return label('service', value); }

/** One shared status map for renderAlert and the lead list. Unknown
 *  statuses show the raw word with no emoji. */
export const STATUS_LABELS = {
  open: 'New', contacted: 'Contacted', quoted: 'Quoted', won: 'Won', lost: 'Lost', done: 'Done',
};
export const STATUS_EMOJI = {
  open: '🟡', contacted: '🔵', quoted: '🟣', won: '🏆', lost: '⚪', done: '✅',
};
export function statusWord(status) { return STATUS_LABELS[status] || String(status || ''); }

/** Collapse every whitespace run (including CR/LF) to one space.
 *  Plain-text alerts are line-structured, so a value that carries a newline can
 *  forge a line ("Name: John\n\n\u2705 Status: Done"). Used for single-line fields
 *  only; notes and comments stay multi-line on purpose. */
export function oneLine(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}
export function statusLine(status) {
  const e = STATUS_EMOJI[status];
  return (e ? e + ' ' : '') + statusWord(status);
}

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
  const body = `<div style="font:600 13px/18px ${brand.fonts.headingStack};color:${c.muted};padding:14px 0 4px">Customer</div>`
    + customerSection
    + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td height="1" style="font-size:0;line-height:0;border-top:1px solid ${c.border}">&nbsp;</td></tr></table>`
    + `<div style="font:600 13px/18px ${brand.fonts.headingStack};color:${c.muted};padding:14px 0 4px">Job</div>`
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

/* ---------- Telegram bot copy (roofer-facing, plain text) ----------
   One bot per business: nothing here may suggest other businesses share it.
   Exact texts (no parse_mode anywhere in the Telegram path). */

export function botLinkedText(name) {
  return `You're connected to ${name}. ✅\n\nNew estimate requests from your website will appear here the moment they come in.\n\nFor each request:\n• Tap Mark contacted after you call the customer.\n• Tap Job completed when the work is done. You can then send the customer a review request.\n\nSend /leads to see your latest requests, or /help any time.`;
}
export const BOT_HELP = `How this works\n\nNew estimate requests from your website appear here as soon as they come in.\n\nFor each request:\n• Mark contacted after you call the customer.\n• Job completed when the work is done, to send a review request.\n\nCommands:\n/leads · your latest requests\n/invite · connect a second phone\n/recipients · who receives alerts\n/help · this message`;
export const BOT_ALREADY_CONNECTED = `You're all set. New requests will appear here.\n\nSend /help to see what I can do.`;
export const BOT_NOT_CONNECTED = `This chat isn't connected yet.

If you were sent a setup link, tap it and press Start. If you have a setup code, send it to me here.

No link or code? Ask the person who set up your lead alerts for a new one.`;

/** One generic answer for invalid / expired / used / unknown codes: no oracle. */
export const BOT_CODE_BAD = `That code didn't work. It may have expired or been used. Ask for a new one.`;

/** A bound chat that pastes a code does not move; say how a move happens. */
export const BOT_ALREADY_CONNECTED_CODE = `This chat is already connected to a business, so that code was not used.

To move it, ask the person who set up your lead alerts to remove this phone first.`;
export const BOT_BAD_CODE = `That setup link isn't valid or has expired.\n\nAsk for a new one.`;
export const BOT_PLAIN_TEXT = `I only respond to commands.\n\nSend /leads to see your latest requests, or /help.`;
/* ---------- callback toasts ----------
   The one-line answers Telegram shows above the keyboard. They live here, not in
   api/tg.js, so the artifact guard covers them like every other user-facing text. */

export const TOAST_NOT_FOUND = 'Not found.';
export const TOAST_ALREADY_DONE = 'This lead is already completed.';
export const TOAST_CONTACT_FIRST = 'Mark this lead as contacted first.';
export const TOAST_NOTHING_TO_RETRY = 'Nothing to retry.';
export const TOAST_GENERIC_ERROR = 'Something went wrong. Try again.';
export const TOAST_ALREADY_UPDATED = 'Already updated.';
export const TOAST_TOO_MANY_OPENS = 'Too many opens in the last hour. Try again later.';
export const TOAST_OWNER_ONLY = 'Only the main phone can do this.';
export const BOT_OWNER_ONLY = 'Only the main phone can do this.\n\nAsk the person whose phone was connected first, or the operator.';

/** Operator-only: a lead arrived for a business with nobody connected. No buttons. */
export function operatorNoPhoneText({ business, lead }) {
  const name = oneLine((lead && lead.name) || '');
  const who = name ? ` (${name})` : '';
  return `📵 New request for ${oneLine(business.name)}${who}, but no phone is connected to that business.\n\nNobody was alerted in Telegram. Send /phones ${business.slug} once a phone is connected.`;
}

/** Operator-only: a connected phone cannot be reached any more. */
export function operatorUnreachableText({ business, chatId }) {
  return `📵 The bot was blocked, or the chat deleted, by a phone connected to ${oneLine(business.name)} (${business.slug}).\n\nThat phone will not receive alerts. Send /phones ${business.slug} to remove it, then /code ${business.slug} for a new invite.\n\nChat ending ${String(chatId).slice(-4)}.`;
}

/* ---------- recipients ---------- */

export const BOT_INVITE_CAPPED = `This business already has the maximum number of phones connected.\n\nSend /recipients to remove one first.`;
export const BOT_INVITE_PENDING = `There are already too many unused invite codes for this business.\n\nEach one expires 24 hours after it was made, so use one or wait for the others to lapse.`;
export const BOT_RECIPIENT_LAST = `You cannot remove the last phone.\n\nSend /invite to connect a second one first.`;
export const BOT_RECIPIENT_REMOVED = `Removed. That phone will stop receiving alerts.`;
export const BOT_RECIPIENT_GONE = `That phone was already removed.`;
export const BOT_RECIPIENTS_EMPTY = `No phones are connected yet.\n\nSend /invite to connect one.`;

/** Owner-only note on the recipients list. */
export const BOT_RECIPIENTS_OWNER_NOTE = `The main phone is the one connected first. Only it can invite or remove phones.`;

/**
 * The invite itself. One code, one use, 24 hours.
 *
 * The deep link is the whole point: a code alone asks the recipient to find the
 * bot, type /start and paste a string, and a phone number typed by hand is where
 * that stops. `username` comes from getMe() (lib/tg.js), cached per instance.
 * Without it the message still works — it falls back to /start plus the code,
 * with real line breaks — and the caller logs bot_username_unavailable.
 *
 * Line breaks are real \n characters in the template. There is no escaping step
 * anywhere in this path, so a literal "//n" in the output can only mean a typo
 * in this string; the artifact guard in tests/bot-text.test.mjs exists because
 * exactly that shipped.
 */
export function botInviteText(code, { username = null, hours = 24 } = {}) {
  const expiry = `The code works once and expires in ${hours} hours.`;
  if (!username) {
    return [
      'Send this to the person you want to add:',
      `/start ${code}`,
      'They send that to the bot and press Start.',
      expiry,
    ].join('\n');
  }
  return [
    'Send this to the person you want to add:',
    `https://t.me/${username}?start=${code}`,
    `They tap it and press Start. If the link doesn't open the bot, they can send this code to the bot instead: ${code}`,
    expiry,
  ].join('\n');
}

/** A recipient's display name: the stored label, else its position in bind order. */
export function recipientName(row, index) {
  const label = row && row.label ? oneLine(row.label) : '';
  return label || `Recipient ${index + 1}`;
}

export function botRecipientsText(rows) {
  if (!rows.length) return BOT_RECIPIENTS_EMPTY;
  const lines = rows.map((r, i) => `${i + 1}. ${recipientName(r, i)}`);
  return `Phones connected to this business\n\n${lines.join('\n')}\n\nTap Remove to disconnect one.`;
}

/** One Remove button per row. The id is the business_chats row, not the chat id. */
export function recipientsKeyboard(rows) {
  return {
    inline_keyboard: rows.map((r, i) => [{ text: `Remove ${recipientName(r, i)}`, callback_data: 'x:' + r.id }]),
  };
}

export function recipientConfirmText(row, index) {
  return `Disconnect ${recipientName(row, index)}?\n\nThey will stop receiving new requests for this business.`;
}

export function recipientConfirmKeyboard(rowId) {
  return {
    inline_keyboard: [[
      { text: 'Yes, remove', callback_data: 'X:' + rowId, style: 'danger' },
      { text: 'Cancel', callback_data: 'v:' + rowId },
    ]],
  };
}

export const BOT_DESCRIPTION = `Get your website's new estimate requests here the moment they arrive. To connect, open the setup link you were given.`;
export const BOT_SHORT_DESCRIPTION = `New estimate requests from your website, delivered instantly.`;

/* ---------- Telegram lead alert ---------- */

/**
 * One rendering for the lead alert that every Telegram surface shares.
 * view: 'new' | 'contacted' | 'confirm' | 'done' | 'error'. Only the last
 * block changes: one fact per line, every line at most 26 characters, and
 * the customer's name and email never appear there.
 * Plain text only: parse_mode is never set anywhere in the Telegram path.
 * reviewResult (view 'done' only): 'sent' | 'failed' | 'no_email' | null.
 * 'failed' (any view) renders the error block, same as view 'error'.
 */
export function renderAlert({ business, lead, view = 'new', reviewResult = null, duplicate = false }) {
  const notes = lead.notes ? String(lead.notes).slice(0, 300) : '';
  const groups = [
    [`New lead · ${oneLine(business.name)}`],
    [`Name: ${oneLine(lead.name)}`, `Phone: ${displayPhone(lead.phone)}`],
  ];
  if (lead.email) groups[1].push(`Email: ${lead.email}`);
  // Advisory only, and never any detail of the earlier lead.
  if (duplicate) groups.push(['⚠️ Possible repeat of an earlier request']);
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
    tail.push('⚠️ Review email failed');
  } else if (view === 'contacted') {
    tail.push(`${STATUS_EMOJI.contacted} Status: ${STATUS_LABELS.contacted}`);
  } else if (view === 'confirm') {
    tail.push(`${STATUS_EMOJI.contacted} Status: ${STATUS_LABELS.contacted}`);
    if (lead.email) {
      tail.push('Send a review request?');
      tail.push('They get a rating link.');
    } else {
      tail.push('No email on file.');
      tail.push('Can\'t send a request.');
    }
  } else if (view === 'done') {
    if (reviewResult === 'sent') {
      tail.push(`${STATUS_EMOJI.done} Status: ${STATUS_LABELS.done}`);
      tail.push('✉️ Review request sent');
    } else {
      tail.push(`${STATUS_EMOJI.done} Status: ${STATUS_LABELS.done}`);
      tail.push('ℹ️ No email, none sent.');
    }
  } else {
    tail.push(`${STATUS_EMOJI.open} Status: ${STATUS_LABELS.open}`);
  }
  groups.push(tail);
  return groups.map((g) => g.join('\n')).join('\n\n');
}

export function telegramAlertText({ business, lead, duplicate = false }) {
  return renderAlert({ business, lead, view: 'new', reviewResult: null, duplicate });
}

/** "5m ago" style age used by the /leads list. */
export function relativeAge(iso, nowMs = Date.now()) {
  const ms = nowMs - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (!Number.isFinite(m) || m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Totally spaced /leads format (plain text): title, blank line, then one
 * three-line block per lead separated by a blank line (none after the last).
 * No numbering, no dashes; " · " only as a separator. Names truncate to 28
 * chars. Phones go through displayPhone so E.164 and legacy rows both show
 * tappable numbers.
 */
export function renderLeadList(leads, nowMs = Date.now()) {
  const blocks = (leads || []).map((l) => {
    const name = oneLine(l.name || '');
    const shown = name.length > 28 ? name.slice(0, 27) + '…' : name;
    return [
      shown,
      `${serviceLabel(l.service)} · ${displayPhone(l.phone)}`,
      `${relativeAge(l.created_at, nowMs)} · ${statusLine(l.status)}`,
    ].join('\n');
  });
  return 'Recent requests\n\n' + blocks.join('\n\n');
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
export function confirmKeyboard(leadId, hasEmail) {
  return {
    inline_keyboard: [[
      { text: hasEmail ? 'Send request' : 'Mark done', callback_data: 'y:' + leadId, style: 'success' },
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
  const body = `<div style="padding:4px 0 6px"><h1 style="font:600 22px/28px ${brand.fonts.headingStack};color:${c.text};margin:0 0 8px;text-wrap: balance;">Thank you for choosing ${escMail(business.name)}.</h1><p style="font:400 15px/22px ${brand.fonts.bodyStack};color:${c.muted};margin:0 0 18px">We’d love to hear how we did.</p><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr><td bgcolor="${c.accent}" style="border-radius:8px"><a href="${escMail(url)}" style="display:block;padding:15px 28px;font:600 15px/20px ${brand.fonts.headingStack};color:${c.accentText};text-decoration:none;border-radius:8px">Share your feedback</a></td></tr></table></div>`;
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
    ? `<h1 style="font:600 20px/26px ${brand.fonts.headingStack};color:${c.text};text-align:center;text-wrap:balance;margin:0 0 14px">How was your experience with ${name}?</h1>`
      + `<div id="stars" role="radiogroup" aria-label="Rating" style="display:flex;justify-content:center;gap:2px;margin:14px 0 18px">${starButtons}</div>`
      + `<label for="comment" style="display:block;font:500 14px/20px ${brand.fonts.bodyStack};color:${c.text};margin:0 0 6px;text-wrap: balance;">Anything you’d like to tell ${name}? (optional)</label>`
      + `<textarea id="comment" name="comment" maxlength="1000" rows="4" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid ${c.border};border-radius:8px;font:400 16px/20px ${brand.fonts.bodyStack};color:${c.text};resize:vertical"></textarea>`
      + `<p style="font:400 13px/18px ${brand.fonts.bodyStack};color:${c.muted};margin:6px 0 16px;text-wrap: balance;">This note goes to ${name}. Your public review is written on Google next.</p>`
      + `<button id="continue" type="button" disabled style="display:block;width:100%;padding:14px 28px;border:0;border-radius:8px;background:${c.accent};color:${c.accentText};font:600 16px/20px ${brand.fonts.headingStack};cursor:pointer">Continue to Google</button>`
      + `<noscript><p style="text-align:center;margin:16px 0 0"><a href="${escHtml(link)}" style="color:${c.text};font:400 16px/22px ${brand.fonts.bodyStack}">Continue to Google</a></p></noscript>`
    : `<h1 style="font:600 20px/26px ${brand.fonts.headingStack};color:${c.text};text-align:center;text-wrap:balance;margin:0 0 12px">How was your experience with ${name}?</h1>`
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
  // Same fonts as the landing page (brand.fonts.faces, same-origin files),
  // heading font preloaded; favicon links mirror index.html. No card: the
  // content sits directly on the page background with a 24px gutter.
  const facesCss = (brand.fonts.faces || []).map((f) =>
    `@font-face{font-family:'${f.family}';font-weight:${f.weight};font-display:swap;src:url('/assets/fonts/${f.file}') format('woff2')}`).join('');
  const headingFace = (brand.fonts.faces || []).find((f) => f.family === brand.fonts.heading);
  const preload = headingFace ? `<link rel="preload" as="font" href="/assets/fonts/${headingFace.file}" type="font/woff2" crossorigin>` : '';
  const icons = `<link rel="icon" href="/assets/icons/favicon.svg" type="image/svg+xml">`
    + `<link rel="icon" href="/assets/icons/favicon-32x32.png" sizes="32x32" type="image/png">`
    + `<link rel="apple-touch-icon" href="/assets/icons/apple-touch-icon-v1.png" sizes="180x180">`;
  return {
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
      + `<title>Review ${name}</title>${icons}${preload}<style>${facesCss}</style></head>`
      + `<body style="box-sizing:border-box;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:0 24px;background:${c.canvas};margin:0">`
      + `<main style="width:100%;max-width:420px;margin:0 auto;box-sizing:border-box">${body}</main>${script}</body></html>`,
    googleButton: !!link,
  };
}

/** Google review hosts a business may point at. Anything else is rejected. */
export const GOOGLE_HOSTS = ['www.google.com', 'google.com', 'search.google.com', 'maps.google.com', 'g.page', 'maps.app.goo.gl', 'goo.gl'];

export function googleUrlAllowed(v) {
  if (typeof v !== 'string') return null;
  let raw = v.trim();
  // A stored value that lost its leading "h" ("ttps://…") is a one-character
  // typo, not a different scheme. Repair it here so the page still works, log a
  // fixed event, and keep every other check (https only, host allowlist).
  if (/^ttps:\/\//i.test(raw)) {
    raw = 'h' + raw;
    console.error('review_google_url_repaired');
  }
  let u;
  try { u = new URL(raw); } catch { return null; }
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



/* ---------- operator copy ----------
   Every string below is for the operator's private chat only. They may name a
   business, a slug or a count; none of them may ever be sent to a business_chats
   recipient. tests/bot-text.test.mjs covers them like the rest. */

export const OPERATOR_USAGE_CODE = 'Usage: /code <slug>\n\nMints one single-use code for that business and gives you a message to forward.';
export const OPERATOR_USAGE_PHONES = 'Usage: /phones <slug>\n\nLists the phones connected to that business, with a Remove button each.';
export const OPERATOR_UNKNOWN_SLUG = 'No business with that slug. Send /businesses to see the list.';
export const OPERATOR_CAPPED = 'Too many codes for that business in the last hour. Wait, then try again.';
export const OPERATOR_NO_PHONES = 'No phones are connected to that business yet.';
export const OPERATOR_LAST_PHONE_WARNING = 'This is the last phone. Removing it means nobody will receive alerts for this business until a new one is connected.';
export const OPERATOR_PHONE_REMOVED = 'Removed.';
export const OPERATOR_PHONE_GONE = 'That phone was already removed.';
export const OPERATOR_ID_TEXT = (chatId) => `This chat's id is ${chatId}.\n\nSet OPERATOR_CHAT_ID to this value to make this chat the operator chat.`;
export const OPERATOR_HELP = 'Operator commands\n\n/code <slug> · one single-use invite for a business\n/phones <slug> · connected phones, with Remove\n/businesses · every business, its status and phone count\n/id · this chat\'s id\n\nOwner commands (/leads, /invite, /recipients, /help) work here too.';

/** The message the operator forwards to a client. No slug, no operator wording. */
export function botForwardText({ business, code, username, hours = 24 }) {
  const link = username ? `https://t.me/${username}?start=${code}` : null;
  const first = link
    ? `Hi! Here is your link to connect your lead alerts on Telegram: ${link}. Tap it, then press Start.`
    : `Hi! Here is your code to connect your lead alerts on Telegram: ${code}. Open the bot, send /start and paste the code.`;
  const fallback = link
    ? `It works once and expires in ${hours} hours. If the link does not open the bot, install Telegram, tap it again, or send me this code in the chat: ${code}.`
    : `It works once and expires in ${hours} hours.`;
  return `${first} ${fallback}\n\nCode: ${code}`;
}

/** Operator view of a business's phones. Owner = the oldest connected phone. */
export function operatorPhonesText({ business, rows, ownerId }) {
  if (!rows.length) return `📵 ${business.name} (${business.slug}) has no phones connected.`;
  const lines = rows.map((r, i) => {
    const tag = r.id === ownerId ? ' · main phone' : '';
    const label = r.label ? ` (${oneLine(r.label)})` : '';
    return `Phone ${i + 1}${tag}${label}`;
  });
  return [`📱 ${business.name} (${business.slug})`, '', ...lines, '', 'Remove a phone:'].join('\n');
}

export function operatorPhonesKeyboard(rows) {
  return {
    reply_markup: {
      inline_keyboard: rows.map((r, i) => [{
        text: `Remove Phone ${i + 1}`,
        callback_data: 'p:' + r.id,
      }]),
    },
  };
}

export function operatorConfirmRemoveText({ row, index, isLast }) {
  const who = `Phone ${index + 1}${row && row.label ? ` (${oneLine(row.label)})` : ''}`;
  return isLast
    ? `${who}\n\n⚠️ ${OPERATOR_LAST_PHONE_WARNING}\n\nRemove it?`
    : `${who}\n\nRemove it? That phone stops receiving alerts.`;
}

export function operatorConfirmRemoveKeyboard(rowId) {
  return { reply_markup: { inline_keyboard: [[
    { text: 'Remove', callback_data: 'P:' + rowId },
    { text: 'Cancel', callback_data: 'q:' + rowId },
  ]] } };
}

/** /businesses — slug, status, phone count. No names, no PII. */
export function operatorBusinessesText(rows) {
  if (!rows.length) return 'No businesses.';
  return ['Businesses', '', ...rows.map((r) => `${r.slug} · ${r.status} · ${r.phones} phone${r.phones === 1 ? '' : 's'}`)].join('\n');
}

/** /leads — one Open button per lead, first name only, plus Older when needed. */
export function leadListKeyboard(leads, page, hasOlder) {
  const rows = leads.map((l) => {
    const first = oneLine(String(l.name || '').trim().split(/\s+/)[0] || 'Lead').slice(0, 20);
    return [{ text: `Open ${first}`, callback_data: 'o:' + l.id }];
  });
  if (hasOlder) rows.push([{ text: 'Older', callback_data: 'l:' + (page + 1) }]);
  return { reply_markup: { inline_keyboard: rows } };
}
