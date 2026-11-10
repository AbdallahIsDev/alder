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

/** A bound chat that pastes a code does not move. One sentence: anything more
 *  reads as a second instruction, and the code stays unused either way. */
export const BOT_ALREADY_CONNECTED_CODE = `This chat is already connected to a business, so that code was not used.`;
export const BOT_BAD_CODE = `That setup link isn't valid or has expired.\n\nAsk for a new one.`;
export const BOT_PLAIN_TEXT = `I only respond to commands.\n\nSend /leads to see your latest requests, or /help.`;
/* ---------- callback toasts ----------
   The one-line answers Telegram shows above the keyboard. They live here, not in
   api/tg.js, so the artifact guard covers them like every other user-facing text. */

export const TOAST_LEAD_GONE = 'That request is no longer here.';
export const TOAST_NOT_FOUND = 'Not found.';
export const TOAST_ALREADY_DONE = 'This lead is already completed.';
export const TOAST_CONTACT_FIRST = 'Mark this lead as contacted first.';
export const TOAST_NOTHING_TO_RETRY = 'Nothing to retry.';
export const TOAST_GENERIC_ERROR = 'Something went wrong. Try again.';
export const TOAST_ALREADY_UPDATED = 'Already updated.';
export const TOAST_TOO_MANY_OPENS = 'Too many opens in the last hour. Try again later.';
export const TOAST_OWNER_ONLY = 'Only the main phone can do this.';
/* A page with nothing on it is never shown as an edit: the list is the only way
   back, so the tap is answered and the message is left exactly as it was. */
export const TOAST_NO_OLDER = 'No older requests.';
export const TOAST_NO_LEADS = 'No requests yet.';
export const TOAST_NO_REMOVE = 'No requests to remove.';
/** First of the two /invite messages, before the forwardable one. */
export const BOT_INVITE_FORWARD_HINT = `Forward the next message to the person you want to add. Do not tap it yourself.`;
export const BOT_OWNER_ONLY = 'Only the main phone can do this.\n\nAsk the person whose phone was connected first, or the operator.';

/** Operator-only: a lead arrived for a business with nobody connected. No buttons. */
export function operatorNoPhoneText({ business }) {
  // Business name and slug only: the operator acts on the business, and the
  // customer's name in an ops message is one more place PII can leak.
  return `📵 New request for ${oneLine(business.name)} (${business.slug}), but no phone is connected to that business.\n\nNobody was alerted in Telegram. Send /phones ${business.slug} once a phone is connected.`;
}

/** Operator-only: a connected phone cannot be reached any more. */
export function operatorUnreachableText({ business, chatId }) {
  return `📵 The bot was blocked, or the chat deleted, by a phone connected to ${oneLine(business.name)} (${business.slug}).\n\nThat phone will not receive alerts. Send /phones ${business.slug} to remove it, then /code ${business.slug} for a new invite.\n\nChat ending ${String(chatId).slice(-4)}.`;
}

/* ---------- recipients ---------- */

export const BOT_INVITE_CAPPED = `This business already has the maximum number of phones connected.\n\nSend /recipients to remove one first.`;
export const BOT_INVITE_CANCEL_BUTTON = 'Cancel old, make new';
export const BOT_INVITE_CANCELLED = 'Old invites cancelled. The new one is below.';
export const BOT_INVITE_CANCEL_ALREADY = 'Those invites were already cancelled. Use the newest invite below.';
export const BOT_INVITE_RATE_LIMIT = 'Too many invites this hour. Try again later.';

/**
 * The cap reply. It names how many invites are waiting and when each lapses,
 * never the codes themselves: a forwarded message would hand them out. Hours
 * are precomputed by the caller so this stays a pure function.
 */
export function botInvitePendingText({ hours = [] } = {}) {
  const n = hours.length;
  const lines = hours.map((h, i) => `Invite ${i + 1} · expires in ${h} h`);
  return `This business already has ${n} unused ${n === 1 ? 'invite' : 'invites'}. Each one works once.\n\n${lines.join('\n')}`;
}

export const BOT_RECIPIENTS_PENDING = (n) => (n > 0 ? `Pending invites: ${n}.` : 'No pending invites.');
export const BOT_BOUND_ELSEWHERE = 'This phone is already connected to a business. The code was not used.';
/** The operator pressing a client's link. Written for the operator, not a client. */
export const OPERATOR_ALREADY_CONNECTED_CODE = 'This chat is already connected to a business. The code was not used and is still valid for the client.';
export const OPERATOR_CODE_USED = 'This chat is already connected to a business. That code has already been used.';
export const OPERATOR_CODE_EXPIRED = 'This chat is already connected to a business. That code has expired.';
export const OPERATOR_CODE_UNKNOWN = 'This chat is already connected to a business. That code was not used here.';
/** An unbound operator chat opening a client link would bind the operator and burn the code. */
export const OPERATOR_WELCOME = 'This is the operator chat. Send /operator for the commands.';
export const OPERATOR_DO_NOT_OPEN = 'This is the operator chat. Send the link to the client, do not open it yourself.';
export const BOT_BIND_FAILED = 'Something went wrong. Ask for a new code.';
export const BOT_RECIPIENT_SELF = 'You cannot remove this phone.';
export const BOT_RECIPIENT_LAST = `You cannot remove the last phone.\n\nSend /invite to connect a second one first.`;
export const BOT_RECIPIENT_REMOVED = `Removed.`;
export const BOT_RECIPIENT_GONE = `That phone was already removed.`;
export const BOT_RECIPIENTS_EMPTY = `No phones are connected yet.\n\nSend /invite to connect one.`;

/** Owner-only note on the recipients list. */

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
const CLIENT_INTRO = 'Tap here to connect your lead alerts on Telegram, then press Start.';
const LINK_WORDS = 'connect your lead alerts';

/**
 * The one message a client receives, whether it comes from /invite or from
 * /code. Plain text plus an `entities` array: no parse_mode, and nothing from
 * user data is ever parsed as markup. Only the four link words carry the
 * deep link; the code is visible once, on its own last line, as a code entity.
 *
 * With no bot username there is no link to put behind the words, so the
 * fallback keeps `/start CODE` visible and gives it the code entity instead.
 */
export function clientInviteMessage({ code, username = null, hours = 24 }) {
  const link = username ? `https://t.me/${username}?start=${code}` : null;
  if (!link) {
    const start = `/start ${code}`;
    // No link, so no link sentence: start with what the client must do.
    const text = `Connect your lead alerts on Telegram. Open the bot and send it this code: ${start}\n\nIt works once and expires in ${hours} hours.`;
    return { text, entities: [{ type: 'code', offset: text.indexOf(start), length: start.length }] };
  }
  const text = `${CLIENT_INTRO}\n\nIt works once and expires in ${hours} hours. If the link does not open the bot, open the bot and send it the code below:\n\n${code}`;
  return {
    text,
    entities: [
      { type: 'text_link', offset: text.indexOf(LINK_WORDS), length: LINK_WORDS.length, url: link },
      { type: 'code', offset: text.lastIndexOf(code), length: code.length },
    ],
  };
}

/** Same shape, kept for the /invite call site. */
export function botInviteText(code, { username = null, hours = 24 } = {}) {
  return clientInviteMessage({ code, username, hours });
}

/** A recipient's display name: the stored label, else its position in bind order. */
/** Phones, not recipients: the list is a phone list. */
export function recipientName(row, index) {
  return `Phone ${index + 1}`;
}

export function botRecipientsText(rows) {
  if (!rows.length) return BOT_RECIPIENTS_EMPTY;
  const lines = rows.map((r, i) => {
    const label = i > 0 && r.label ? ` (${oneLine(r.label)})` : '';
    return `Phone ${i + 1}${i === 0 ? ' · you (main)' : ''}${label}`;
  });
  return `Phones connected to this business\n\n${lines.join('\n')}`;
}

/** One Remove button per row except this chat's own row. */
export function recipientsKeyboard(rows, { selfChatId = null } = {}) {
  const buttons = [];
  rows.forEach((r, i) => {
    if (selfChatId != null && String(r.tg_chat_id) === String(selfChatId)) return;
    buttons.push([{ text: `Remove Phone ${i + 1}`, callback_data: 'x:' + r.id }]);
  });
  return { inline_keyboard: buttons };
}

export const LAST_PHONE_WARNING = 'This is the last phone. Nobody will receive alerts for this business until a new phone is connected.';

export function recipientConfirmText(row, index, { isLast = false } = {}) {
  return `Phone ${index + 1}\n\n${isLast ? LAST_PHONE_WARNING : 'It will stop receiving alerts.'}`;
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
 * tappable numbers. Field order is name, job type, phone, status, age: the age
 * is last because it is the only value that changes while the message sits.
 */
export function renderLeadList(leads, nowMs = Date.now()) {
  const blocks = (leads || []).map((l, i) => {
    const name = oneLine(l.name || '');
    const shown = name.length > 28 ? name.slice(0, 27) + '…' : name;
    return [
      `${i + 1}. ${shown}`,
      `${serviceLabel(l.service)} · ${displayPhone(l.phone)}`,
      `${statusLine(l.status)} · ${relativeAge(l.created_at, nowMs)}`,
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
 * A review URL is only usable if it also carries the value that identifies the
 * business. https://g.page/r/ and ...writereview?placeid= are both on an
 * allowed host with the right scheme and both lead nowhere, so they count as
 * invalid (health) and render no button (review page).
 */
const REVIEW_ID_HOSTS = new Set(['g.page', 'goo.gl', 'maps.app.goo.gl']);

export function googleReviewUrlOk(v) {
  // Strict about what is STORED: no "ttps://" repair here. Health reports the
  // column as it is; the page repairs at render time and logs it.
  if (typeof v !== 'string') return false;
  let u;
  try { u = new URL(v.trim()); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  if (!GOOGLE_HOSTS.includes(u.hostname)) return false;
  const segs = u.pathname.split('/').filter(Boolean);
  if (REVIEW_ID_HOSTS.has(u.hostname)) {
    const i = segs.indexOf('r');
    if (i >= 0 && !segs[i + 1]) return false;
    if (i < 0 && segs.length === 0) return false;
  }
  if (u.hostname === 'search.google.com' && u.pathname.startsWith('/local/writereview')) {
    const place = (u.searchParams.get('placeid') || '').trim();
    if (!place) return false;
  }
  if ((u.hostname === 'www.google.com' || u.hostname === 'google.com') && u.pathname.startsWith('/search')) {
    const q = (u.searchParams.get('q') || '').trim();
    const place = (u.searchParams.get('placeid') || '').trim();
    if (!q && !place) return false;
  }
  return true;
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

export const OPERATOR_USAGE_CODE = 'Usage: /code [slug]';
export const OPERATOR_LEADS_HINT = 'This is the operator chat. Pick a business with /phones or /code. Lead lists are on the owner phones.';
export const OPERATOR_REMOVE_LEAD = 'Owners remove requests from their own phone.';
export const OPERATOR_PICK_TEXT = 'Which business?';
export const OPERATOR_NO_BUSINESSES = 'No businesses yet.';

/** Business names as buttons. The payload is the id, so a stale list cannot act on a slug. */
export function operatorPickerKeyboard(rows, prefix) {
  return {
    reply_markup: {
      inline_keyboard: rows.map((r) => [{ text: String(r.name || r.slug).slice(0, 20), callback_data: `${prefix}:${r.id}` }]),
    },
  };
}
export const OPERATOR_USAGE_PHONES = 'Usage: /phones [slug]';
export const OPERATOR_UNKNOWN_SLUG = 'No business with that slug. Send /businesses to see the list.';
export const OPERATOR_CAPPED = 'Too many codes for that business in the last hour. Wait, then try again.';
export const OPERATOR_NO_PHONES = 'No phones are connected to that business yet.';
export const OPERATOR_PHONE_REMOVED = 'Removed.';
export const OPERATOR_PHONE_GONE = 'That phone was already removed.';
export function operatorIdMessage(chatId, { operator = false } = {}) {
  const text = `This chat's ID: ${chatId}\n\n${operator
    ? 'This chat is the operator chat.'
    : 'Set OPERATOR_CHAT_ID to this value to make this chat the operator chat.'}`;
  return { text, entities: [{ type: 'code', offset: text.indexOf(String(chatId)), length: String(chatId).length }] };
}
export const OPERATOR_HELP = 'Operator commands\n\n/code [slug] · one single-use invite\n/phones [slug] · connected phones\n/businesses · every business, its status and phone count\n/id · this chat\'s ID\n\nOwner commands (/leads, /invite, /recipients, /help) act on the business this chat is connected to.';

/**
 * The message the operator forwards to a client. It is the SECOND message /code
 * sends, and it contains nothing else: no slug, no business name, no operator
 * wording. A client who forwards it onward must not learn who the operator is.
 *
 * "send it this code" — the pronoun is the BOT. The old wording said "send me
 * this code in the chat", which reads as the operator when the message has been
 * forwarded, and that is exactly the wrong person to send a bind code to.
 */
export function botForwardText({ code, username, hours = 24 }) {
  return clientInviteMessage({ code, username, hours });
}

/** Operator message 1: slug, code, human expiry, and what the next message is. */
export function operatorCodeText({ slug, code, hours = 24, cancelled = 0 }) {
  const note = cancelled > 0 ? ` ${cancelled} older ${cancelled === 1 ? 'invite was' : 'invites were'} cancelled.` : '';
  const text = `Code for ${oneLine(slug)}: ${code}\n\nExpires in ${hours} hours.${note} The next message is for the client — forward it as it is.`;
  return { text, entities: [{ type: 'code', offset: text.indexOf(code), length: code.length }] };
}

/** Sent only when message 2 could not be delivered. */
export function operatorCodeResendText({ code, hours = 24 }) {
  const text = `The forward text did not send. The code is ${code} and it expires in ${hours} hours. Send it to the client yourself.`;
  return { text, entities: [{ type: 'code', offset: text.indexOf(code), length: code.length }] };
}

/** Operator view of a business's phones. Owner = the oldest connected phone. */
export function operatorPhonesText({ business, rows, ownerId, selfChatId = null, duplicateName = false }) {
  const title = `${business.name}${duplicateName ? ` (${business.slug})` : ''}`;
  if (!rows.length) return `${title} has no phones connected.`;
  const lines = rows.map((r, i) => {
    const tags = [];
    if (r.id === ownerId) tags.push('main phone');
    if (selfChatId != null && String(r.tg_chat_id) === String(selfChatId)) tags.push('this chat');
    const label = r.label ? ` (${oneLine(r.label)})` : '';
    return `Phone ${i + 1}${tags.length ? ` · ${tags.join(', ')}` : ''}${label}`;
  });
  return [title, '', ...lines].join('\n');
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
    ? `${who}\n\n${LAST_PHONE_WARNING}`
    : `${who}\n\nIt will stop receiving alerts.`;
}

export function operatorConfirmRemoveKeyboard(rowId) {
  return { reply_markup: { inline_keyboard: [[
    { text: 'Remove', callback_data: 'P:' + rowId, style: 'danger' },
    { text: 'Cancel', callback_data: 'q:' + rowId },
  ]] } };
}

/** /businesses — slug, status, phone count. No names, no PII. */
export function operatorBusinessesText(rows) {
  if (!rows.length) return 'No businesses.';
  const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
  // phones === null means the count query failed. Say "?" rather than "0":
  // a business with phones must never be reported as having none.
  return rows.map((r) => {
    const phones = r.phones === null || r.phones === undefined
      ? '?'
      : `${r.phones} phone${r.phones === 1 ? '' : 's'}`;
    return `${r.name || r.slug} · ${cap(r.status)} · ${phones}`;
  }).join('\n\n');
}

/** /leads — numbers matching the list, one row, plus Newer/Older when needed. */
export const REMOVE_LEAD_TITLE = 'Which request do you want to remove?';
export const REMOVE_LEAD_DONE = 'Removed.';
export const REMOVE_LEAD_GONE = 'That request is no longer here.';

/** /remove_lead list: number, name, service and age. No phone, no actions. */
export function removeLeadListText(leads, nowMs = Date.now()) {
  const blocks = (leads || []).map((l, i) => [
    `${i + 1}. ${oneLine(l.name || '')}`,
    `${serviceLabel(l.service)} · ${relativeAge(l.created_at, nowMs)}`,
  ].join('\n'));
  return `${REMOVE_LEAD_TITLE}\n\n${blocks.join('\n\n')}`;
}

export function removeLeadKeyboard(leads, page, hasOlder, hasNewer = page > 0) {
  const rows = [];
  const nums = (leads || []).map((l, i) => ({ text: String(i + 1), callback_data: 'rl:' + l.id }));
  if (nums.length) rows.push(nums);
  const nav = [];
  if (hasNewer) nav.push({ text: 'Newer', callback_data: 'rm:' + Math.max(0, page - 1) });
  if (hasOlder) nav.push({ text: 'Older', callback_data: 'rm:' + (page + 1) });
  if (nav.length) rows.push(nav);
  return { reply_markup: { inline_keyboard: rows } };
}

export function removeLeadConfirmText(lead, nowMs = Date.now()) {
  return `${oneLine(lead.name || '')}\n${serviceLabel(lead.service)} · ${relativeAge(lead.created_at, nowMs)}\n\nRemove this request? It cannot be undone.`;
}

export function removeLeadConfirmKeyboard(leadId) {
  return { reply_markup: { inline_keyboard: [[
    { text: 'Remove', callback_data: 'RL:' + leadId, style: 'danger' },
    { text: 'Cancel', callback_data: 'rc:' + leadId },
  ]] } };
}

export function leadListKeyboard(leads, page, hasOlder, hasNewer = page > 0) {
  const rows = [];
  const numbers = leads.map((l, i) => ({ text: String(i + 1), callback_data: 'o:' + l.id }));
  if (numbers.length) rows.push(numbers);
  const nav = [];
  if (hasNewer) nav.push({ text: 'Newer', callback_data: 'l:' + Math.max(0, page - 1) });
  if (hasOlder) nav.push({ text: 'Older', callback_data: 'l:' + (page + 1) });
  if (nav.length) rows.push(nav);
  return { reply_markup: { inline_keyboard: rows } };
}
