// lib/content.js — every piece of outbound copy lives here.
//
// Branding rule: anything a CUSTOMER sees carries only the roofer's business name.
// No studio name, no "AI", no automatic Google posting, no missed-call text-back,
// no time promise. Owner-facing messages may use the neutral "Lead Alerts".

import { escHtml, safeHeader } from './mail.js';
import TOKENS from './design-tokens.generated.json' with { type: 'json' };
import {
  esc as escMail,
  ownerHeader, customerHeader, rows as mailRows,
  notesBox as mailNotes, buttons as mailButtons, shell as mailShell,
} from './email-layout.js';
import { getBrand } from './brand.js';
import { billingLine, billingDate, encodePaidUntil, EXTEND_DAYS } from './billing.js';

export const LABELS = {
  service: {
    replacement: 'Roof replacement', storm: 'Storm damage', repair: 'Repair',
    // The form's fourth card is "Free roof inspection" (the services section's
    // own fourth service). The stored value stays 'unsure': it is what every
    // existing lead of that card holds, and the API's allow-list.
    unsure: 'Roof inspection',
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
  // Sections are plain (no inner cards): heading, rows, a 16 px spacer, the
  // edge-to-edge divider, the Job heading (16 px above it), rows, then the
  // buttons below a 16 px spacer.
  const body = `<div style="font:600 13px/18px ${brand.fonts.headingStack};color:${c.muted};padding:14px 0 4px">Customer</div>`
    + customerSection
    + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td height="16" style="font-size:0;line-height:0">&nbsp;</td></tr></table>`
    + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td height="1" style="font-size:0;line-height:0;border-top:1px solid ${c.border}">&nbsp;</td></tr></table>`
    + `<div style="font:600 13px/18px ${brand.fonts.headingStack};color:${c.muted};padding:16px 0 4px">Job</div>`
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
export const BOT_HELP = `How this works\n\nNew estimate requests from your website appear here as soon as they come in.\n\nFor each request:\n• Mark contacted after you call the customer.\n• Job completed when the work is done, to send a review request.\n\nCommands:\n/leads · your latest requests\n/invite · connect a second phone\n/recipients · who receives alerts\n/status · your service and billing\n/help · this message`;
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
  return `📵 New request for ${oneLine(business.name)} (${business.slug}), but no phone is connected to that business.\n\nNobody was alerted in Telegram. Send /invite ${business.slug} to connect a phone, then check it in /businesses.`;
}

/** Operator-only: a connected phone cannot be reached any more. */
export function operatorUnreachableText({ business, chatId }) {
  return `📵 The bot was blocked, or the chat deleted, by a phone connected to ${oneLine(business.name)} (${business.slug}).\n\nThat phone will not receive alerts. The owner can remove it with /recipients. Send /invite ${business.slug} for a new invite.\n\nChat ending ${String(chatId).slice(-4)}.`;
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
/** Also the operator chat's answer to anything that is not one of its commands. */
export const OPERATOR_WELCOME = 'This is the operator chat. Send /help for the commands.';
export const OPERATOR_DO_NOT_OPEN = 'This is the operator chat. Send the link to the client, do not open it yourself.';
export const BOT_BIND_FAILED = 'Something went wrong. Ask for a new code.';
export const BOT_RECIPIENT_SELF = 'You cannot remove this phone.';
/** Sent together with ReplyKeyboardRemove when a chat is disconnected: its
 *  persistent keyboard went stale the moment the binding row was deleted. */
export const BOT_DISCONNECTED = 'This chat was disconnected from lead alerts.';
/** Sent together with ReplyKeyboardRemove to every phone the operator's
 *  "Replace phone" has just removed. It names no business and shows no data. */
export const BOT_ACCESS_ENDED = 'Your access to lead alerts for this business was ended by support.';
/* ---------- suspended service ----------
   A suspended business keeps its phones, its invites and its data; it is only
   not served. These three lines are everything a business chat is told about
   it, and none of them names the business or shows any data. */

/* The suspension, termination and reactivation texts live in
   lib/lifecycle-text.js (one place for everything a business is told). */
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
  if (lead.held_at) groups[1].push('Received while suspended');
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
 * A lead that arrived while the business was suspended carries one extra
 * line, "held", so the row order and the five-per-page contract never move:
 * the number buttons and the offset paging depend on that order.
 */
export function renderLeadList(leads, nowMs = Date.now()) {
  const blocks = (leads || []).map((l, i) => {
    const name = oneLine(l.name || '');
    const shown = name.length > 28 ? name.slice(0, 27) + '…' : name;
    return [
      `${i + 1}. ${shown}`,
      `${serviceLabel(l.service)} · ${displayPhone(l.phone)}`,
      `${statusLine(l.status)} · ${relativeAge(l.created_at, nowMs)}`,
      ...(l.held_at ? ['held'] : []),
    ].join('\n');
  });
  return 'Recent requests\n\n' + blocks.join('\n\n');
}

/**
 * /leads with the held leads in their OWN group. Nothing about paging moves:
 * the number, the lead id in the callback and the five rows per page are the
 * same, only displayed in two sections. The fourth "held" line stays on every
 * held row, so a renewed business still shows which requests arrived while it
 * was off. `heldTotal` is the business-wide count (the renewal notice quotes
 * that number); when it was not read, the rows on this page are the minimum.
 */
export function renderHeldLeadList(leads, nowMs = Date.now(), heldTotal = 0) {
  const rows = (leads || []).map((l, i) => {
    const name = oneLine(l.name || '');
    const shown = name.length > 28 ? name.slice(0, 27) + '…' : name;
    return {
      held: !!l.held_at,
      block: [
        `${i + 1}. ${shown}`,
        `${serviceLabel(l.service)} · ${displayPhone(l.phone)}`,
        `${statusLine(l.status)} · ${relativeAge(l.created_at, nowMs)}`,
        ...(l.held_at ? ['held'] : []),
      ].join('\n'),
    };
  });
  const held = rows.filter((r) => r.held).map((r) => r.block);
  const other = rows.filter((r) => !r.held).map((r) => r.block);
  const sections = ['Recent requests'];
  // heldTotal is authoritative when it was read; only a failed read passes
  // null, and then the rows on this page are the minimum. An older held row
  // that is still marked must not inflate the current suspension's count.
  const total = heldTotal === null || heldTotal === undefined ? held.length : Math.max(0, Number(heldTotal) || 0);
  if (held.length) sections.push(`Received while suspended: ${total}`, held.join('\n\n'));
  if (other.length) {
    if (held.length) sections.push('Other requests');
    sections.push(other.join('\n\n'));
  }
  return sections.join('\n\n');
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
  const body = `<div style="padding:4px 0 6px"><h1 style="font:600 22px/28px ${brand.fonts.headingStack};color:${c.text};margin:0 0 8px;text-wrap: balance;">Thank you for choosing ${escMail(business.name)}.</h1><p style="font:400 15px/22px ${brand.fonts.bodyStack};color:${c.muted};margin:0 0 18px">We’d love to hear how we did.</p><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr><td bgcolor="${c.accent}" style="border-radius:${TOKENS.radius.reviewControl}"><a href="${escMail(url)}" style="display:block;padding:15px 28px;font:600 15px/20px ${brand.fonts.headingStack};color:${c.accentText};text-decoration:none;border-radius:${TOKENS.radius.reviewControl}">Share your feedback</a></td></tr></table></div>`;
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
      + `<textarea id="comment" name="comment" maxlength="1000" rows="4" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid ${c.border};border-radius:${TOKENS.radius.reviewControl};font:400 16px/20px ${brand.fonts.bodyStack};color:${c.text};resize:vertical"></textarea>`
      + `<p style="font:400 13px/18px ${brand.fonts.bodyStack};color:${c.muted};margin:6px 0 16px;text-wrap: balance;">This note goes to ${name}. Your public review is written on Google next.</p>`
      + `<button id="continue" type="button" disabled style="display:block;width:100%;padding:14px 28px;border:0;border-radius:${TOKENS.radius.reviewControl};background:${c.accent};color:${c.accentText};font:600 16px/20px ${brand.fonts.headingStack};cursor:pointer">Continue to Google</button>`
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
  // heading font preloaded; favicon links mirror index.html. No card below 640px:
  // the content sits directly on the page background with a 24px gutter. From
  // 640px it is a white card, because the same page is read on a laptop.
  const facesCss = (brand.fonts.faces || []).map((f) =>
    `@font-face{font-family:'${f.family}';font-weight:${f.weight};font-display:swap;src:url('/assets/fonts/${f.file}') format('woff2')}`).join('');
  const rvCss = `.rv { width: 100%; max-width: 420px; margin: 0 auto; box-sizing: border-box }
@media (min-width: 640px) { .rv { max-width: 468px; padding: 24px; background: ${c.card}; border: 1px solid ${c.border}; border-radius: ${TOKENS.radius.reviewCard} } }`;
  const headingFace = (brand.fonts.faces || []).find((f) => f.family === brand.fonts.heading);
  const preload = headingFace ? `<link rel="preload" as="font" href="/assets/fonts/${headingFace.file}" type="font/woff2" crossorigin>` : '';
  const icons = `<link rel="icon" href="/assets/icons/favicon.svg" type="image/svg+xml">`
    + `<link rel="icon" href="/assets/icons/favicon-32x32.png" sizes="32x32" type="image/png">`
    + `<link rel="apple-touch-icon" href="/assets/icons/apple-touch-icon-v1.png" sizes="180x180">`;
  return {
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
      + `<title>Review ${name}</title>${icons}${preload}<style>${facesCss}${rvCss}</style></head>`
      + `<body style="box-sizing:border-box;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:0 24px;background:${c.canvas};margin:0">`
      + `<main class="rv">${body}</main>${script}</body></html>`,
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

export const OPERATOR_USAGE_INVITE = 'Usage: /invite [slug]';
export const OPERATOR_NO_BUSINESSES = 'No businesses yet.';
export const OPERATOR_UNKNOWN_SLUG = 'No business with that slug. Send /businesses to see the list.';
export const OPERATOR_CAPPED = 'Too many invites for that business in the last hour. Wait, then try again.';
export function operatorIdMessage(chatId, { operator = false } = {}) {
  const text = `This chat's ID: ${chatId}\n\n${operator
    ? 'This chat is the operator chat.'
    : 'Set OPERATOR_CHAT_ID to this value to make this chat the operator chat.'}`;
  return { text, entities: [{ type: 'code', offset: text.indexOf(String(chatId)), length: String(chatId).length }] };
}
export const OPERATOR_HELP = 'Operator commands\n\n/businesses · every business: phones, leads, Suspend\n/invite [slug] · one single-use invite link\n/help · this list\n/id · this chat\'s ID';

/**
 * The message the operator forwards to a client. It is the SECOND message of
 * /invite <slug>,
 * and it contains nothing else: no slug, no business name, no operator
 * wording. A client who forwards it onward must not learn who the operator is.
 *
 * "send it this code" — the pronoun is the BOT. The old wording said "send me
 * this code in the chat", which reads as the operator when the message has been
 * forwarded, and that is exactly the wrong person to send a bind code to.
 */
export function botForwardText({ code, username, hours = 24 }) {
  return clientInviteMessage({ code, username, hours });
}

/** What else the invite did, as short sentences with a leading space each:
 *  phones a Replace removed (and notices that did not reach them), then older
 *  unused invites that were cancelled. Nothing at all for a plain invite. */
function inviteNotes({ removed = 0, failed = 0, cancelled = 0 } = {}) {
  const undelivered = failed > 0 ? ` (${failed} ${failed === 1 ? 'notice' : 'notices'} not delivered)` : '';
  const gone = removed > 0 ? ` ${removed} ${removed === 1 ? 'phone' : 'phones'} removed${undelivered}.` : '';
  const old = cancelled > 0 ? ` ${cancelled} older ${cancelled === 1 ? 'invite was' : 'invites were'} cancelled.` : '';
  return gone + old;
}

/**
 * Operator message 1, the guidance: slug, code, human expiry, and what the
 * next message is. From a button it is the browser message itself, edited,
 * with Back under it; from the typed shortcut it is a new message. `removed`
 * and `failed` are set only by Replace phone.
 */
export function operatorCodeText({ slug, code, hours = 24, cancelled = 0, removed = 0, failed = 0 }) {
  const note = inviteNotes({ removed, failed, cancelled });
  const text = `Code for ${oneLine(slug)}: ${code}\n\nExpires in ${hours} hours.${note} The next message is for the client — forward it as it is.`;
  return { text, entities: [{ type: 'code', offset: text.indexOf(code), length: code.length }] };
}

/** Shown in place of the guidance only when message 2 could not be delivered. */
export function operatorCodeResendText({ code, hours = 24, cancelled = 0, removed = 0, failed = 0 }) {
  const text = `The forward text did not send. The code is ${code} and it expires in ${hours} hours. Send it to the client yourself.${inviteNotes({ removed, failed, cancelled })}`;
  return { text, entities: [{ type: 'code', offset: text.indexOf(code), length: code.length }] };
}

/* ---------- operator business browser ----------
   /businesses and /invite are each ONE message that is edited in place, like
   the owner's /leads. Callback data, all operator-only and all re-validated
   against the database on every tap:
     bl:<page>                         the business list
     bd:<page>:<business>              one business (page = where Back goes)
     bs:<page>:<business>              ask to suspend
     bS:<page>:<business>              suspend
     br:<page>:<business>              reactivate
     be:<page>:<business>              ask to extend the paid period
     bE:<page>:<business>:<until>      extend it to exactly <until> (a paid-until
                                       moment, whole seconds in base 36; see
                                       encodePaidUntil in lib/billing.js). The date
                                       travels in the button, so a second tap asks
                                       for the same date and changes nothing.
     bn:<page>                         the /invite list
     bi:<page>:<business>              an invite picked from that list (Back = the list page)
     bp, bP, bc :<page>:<business>     from that list: ask to replace the phones, replace
                                       them, cancel (back to "Already connected")
     bv:<page>:<business>              an invite for that business (Back = the business)
     bw, bW, bu :<page>:<business>     from the business: ask to replace, replace, cancel
     bq:<leadPage>:<page>:<business>   that business's leads
     bo:<leadPage>:<page>:<b22><l22>   one lead (two packed ids, see packUuid)
     pc:<business>                     the old /code picker: the same as bi on page 0
   Retired, answered with OPERATOR_SCREEN_EXPIRED and changing nothing:
     bt, bT (Terminate), pb (the /phones picker), p, P, q (Remove Phone).
   The longest is 54 bytes; Telegram allows 64. */

export const OPERATOR_BUSINESS_GONE = 'That business is no longer here.';
export const OPERATOR_SCREEN_EXPIRED = 'That screen expired. Here is the current screen.';
export const OPERATOR_PAGE_GONE = 'That page is gone. Here is the first one.';
export const OPERATOR_SUSPENDED = 'Suspended.';
export const OPERATOR_REACTIVATED = 'Reactivated.';
export const OPERATOR_ALREADY_SUSPENDED = 'Already suspended.';
export const OPERATOR_ALREADY_ACTIVE = 'Already active.';
export const OPERATOR_TERMINATED = 'Terminated.';
export const OPERATOR_ALREADY_TERMINATED = 'Already terminated.';
/** The toast for the same refusal: terminated, and Extend 30 days is the way. */
export const OPERATOR_TERMINATED_EXTEND = 'Terminated. Extend 30 days.';
export const OPERATOR_BILLING_EXTEND = 'Payment needed. Extend 30 days.';
export const OPERATOR_EXTENDED = 'Extended.';
export const OPERATOR_ALREADY_EXTENDED = 'Already extended.';
export const OPERATOR_BILLING_UNAVAILABLE = 'Billing is not available yet: the database migration (0006) has not been applied.';
export const OPERATOR_NO_INVITABLE = 'No business to invite.';
export const OPERATOR_ALREADY_REPLACED = 'Already replaced.';
export const OPERATOR_NO_PHONE_NOW = 'No phone is connected now.';
export const OPERATOR_NO_LEADS = 'No leads yet.';
export const OPERATOR_NO_OLDER_LEADS = 'No older leads.';
export const OPERATOR_LEAD_GONE = 'That lead is no longer here.';
/** How far back "in the last N days" on the business screen looks. */
export const OPERATOR_RECENT_DAYS = 30;

/** The business status as the operator reads it. `paused` is what Suspend
 *  writes; the word on screen is Suspended. */
// 'churned' is the stored value of a TERMINATED business (there is no
// 'terminated' value in the status column); nothing shows the word "churned".
const BUSINESS_STATUS_WORDS = { demo: 'Demo', active: 'Active', paused: 'Suspended', churned: 'Terminated' };
export function businessStatusWord(status) {
  return BUSINESS_STATUS_WORDS[status] || oneLine(status);
}
/** null or undefined means the count could not be read. Say "?" rather than
 *  "0": a business with phones must never be reported as having none. */
const phoneCountText = (n) => (n === null || n === undefined ? '?' : `${n} phone${n === 1 ? '' : 's'}`);
const businessName = (b) => oneLine((b && (b.name || b.slug)) || '');

/**
 * A uuid as 22 base64url characters, and back. Two uuids do not fit in the 64
 * bytes of a callback as text (72 with the dashes), and a lead is always
 * addressed by its business AND its own id. unpackUuid answers null for
 * anything that is not exactly one packed uuid; what it returns is still only
 * an address, and every use of it is checked against the database.
 */
export function packUuid(id) {
  const hex = String(id || '').replace(/-/g, '');
  return /^[0-9a-f]{32}$/i.test(hex) ? Buffer.from(hex, 'hex').toString('base64url') : '';
}
export function unpackUuid(packed) {
  if (!/^[A-Za-z0-9_-]{22}$/.test(String(packed || ''))) return null;
  const hex = Buffer.from(String(packed), 'base64url').toString('hex');
  if (hex.length !== 32) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** "N. Name" with the slug added only where two rows on the page share a name. */
function numberedBusinessNames(rows) {
  const names = rows.map(businessName);
  return rows.map((r, i) => {
    const twin = names.filter((n) => n === names[i]).length > 1;
    return `${i + 1}. ${names[i]}${twin ? ` (${r.slug})` : ''}`;
  });
}

/** The list: "N. Name · Status · N phones", one line per business. No lead data. */
export function operatorBusinessListText(rows) {
  if (!rows || !rows.length) return OPERATOR_NO_BUSINESSES;
  const heads = numberedBusinessNames(rows);
  const lines = rows.map((r, i) => `${heads[i]} · ${businessStatusWord(r.status)} · ${phoneCountText(r.phones)}`);
  return 'Businesses\n\n' + lines.join('\n');
}

/**
 * One business. `rows` are its phones, oldest first (the first is the main
 * phone); null when they could not be read. `stats` is { total, recent,
 * lastAt }: every lead of the business, those of the last OPERATOR_RECENT_DAYS
 * days, and when the newest arrived; a null part could not be read and shows
 * as "?". Each number appears once. The last line is the billing line
 * (billingLine in lib/billing.js).
 */
export function operatorBusinessDetailText({ business, rows, stats, nowMs = Date.now() }) {
  const lines = [businessName(business), `${businessStatusWord(business.status)} · ${business.slug}`, ''];
  if (rows === null || rows === undefined) {
    lines.push('Telegram: ?');
  } else if (!rows.length) {
    lines.push('Telegram: Not connected');
  } else {
    lines.push('Telegram: Connected');
    rows.forEach((r, i) => {
      lines.push(`Phone ${i + 1}${i === 0 ? ' · main phone' : ''}${r.label ? ` (${oneLine(r.label)})` : ''}`);
    });
  }
  const shown = (n) => (n === null || n === undefined ? '?' : String(n));
  const total = stats ? stats.total : null;
  const recent = stats ? stats.recent : null;
  lines.push('', `Leads: ${shown(total)} total`, `Last ${OPERATOR_RECENT_DAYS} days: ${shown(recent)}`);
  if (total > 0 && stats.lastAt) lines.push(`Last lead: ${relativeAge(stats.lastAt, nowMs)}`);
  // Leads stored while the business is suspended (leads.held_at): a count.
  if (stats && stats.held > 0) lines.push(`Held leads: ${stats.held}`);
  lines.push(billingLine(business, nowMs));
  return lines.join('\n');
}

/* ----- billing: Extend 30 days ----- */

/** The question. `target` is the paid-until moment Confirm will set. */
export function operatorExtendConfirmText({ business, target, suspended = false }) {
  const ask = `Extend ${businessName(business)} to ${billingDate(target)}?`;
  if (!suspended) return ask;
  // The terminated wording is deliberate: Extend is the ONLY way back from
  // terminated, and saying "reactivates" here made the two paths look alike.
  return `${ask}\n\n${business && business.status === 'churned'
    ? 'This business was terminated.\nExtending restores the service.'
    : 'This business was suspended.\nExtending restores the service.'}`;
}
/**
 * One result screen after a state change: a title, then the two delivery
 * facts, one per line. No "· N failed" tail and no second numbering. `notice`
 * is sendOwnerNotice's result; a missing notice is reported as such rather
 * than guessed at.
 */
export function operatorStateResultText({ title, notice = null, facts = [] }) {
  const lines = [title, ...facts];
  if (!notice) return [...lines, 'Telegram: not reported', 'Email: not reported'].join('\n');
  const phones = Number(notice.phones) || 0;
  const sent = Number(notice.phonesOk) || 0;
  if (phones === 0 || notice.nobody) lines.push('Telegram: no phone connected');
  else if (sent === phones) lines.push(`Telegram: sent to ${sent} phone${sent === 1 ? '' : 's'}`);
  else lines.push('Telegram: failed (alert sent)');
  lines.push(notice.email === 'sent' ? 'Email: sent'
    : notice.email === 'failed' ? 'Email: failed (alert sent)' : 'Email: not configured');
  return lines.join('\n');
}

/** What Confirm did: the date it stored, then the two delivery facts. */
export function operatorExtendedText({ business, paidUntil, reactivated = false, notice = null }) {
  return operatorStateResultText({
    title: `Extended: ${businessName(business)}`,
    notice,
    facts: [`Paid until: ${billingDate(paidUntil)}`, ...(reactivated ? ['Service: reactivated'] : [])],
  });
}
/** A second Confirm: the date is already stored, nothing changed. */
export function operatorAlreadyExtendedText({ business, paidUntil }) {
  return `${businessName(business)} is already paid until ${billingDate(paidUntil)}. Nothing changed.`;
}

/* ----- suspend / reactivate ----- */

export function operatorSuspendConfirmText(business) {
  return `Suspend ${businessName(business)}?\nAlerts and emails stop.\nThe site keeps saving\nrequests and holds them.\nNothing is deleted.\nThe owner can see the count.`;
}
export function operatorSuspendedText({ business, notice = null }) {
  return operatorStateResultText({ title: `Suspended: ${businessName(business)}`, notice });
}
export function operatorReactivateConfirmText(business) {
  return `Reactivate ${businessName(business)}?\nAlerts and emails resume.\nRequests held while it was\noff become visible again.\nNothing is deleted.`;
}
export function operatorReactivatedText(business, { notice = null } = {}) {
  return operatorStateResultText({ title: `Reactivated: ${businessName(business)}`, notice });
}
export function operatorTerminateConfirmText(business) {
  return `Terminate ${businessName(business)}?\nAlerts and emails stop.\nThe website form shows\n"not available".\nNothing is deleted: Extend\n30 days puts it back.`;
}
export function operatorTerminatedText({ business, notice = null }) {
  return operatorStateResultText({ title: `Terminated: ${businessName(business)}`, notice });
}
export function operatorAlreadyTerminatedText(business) {
  return `${businessName(business)} is already terminated.`;
}
/** A stale Reactivate (the question or the confirm) on a terminated business.
 *  Extend 30 days is the only way back since 2026-11-17, and the screen says so
 *  instead of offering a confirm it cannot honour. Two lines: the state with
 *  the name, then the way back (27 characters on the sample names). */
export function operatorTerminatedReactivateText(business) {
  return `${businessName(business)} is terminated.\nExtend 30 days restores it.`;
}

/** A stale Reactivate on a billing suspension: payment, not a button, unlocks it. */
export function operatorBillingReactivateText(business) {
  return `${businessName(business)} is suspended because\npayment was not received.\nExtend 30 days restores it.`;
}
export function operatorAlreadySuspendedText(business) {
  return `${businessName(business)} is already suspended.`;
}
export function operatorAlreadyActiveText(business) {
  return `${businessName(business)} is already active.`;
}
/** The line for an invite asked of a business that is not in service. Used as a
 *  toast (Telegram shows at most 200 characters) and as a reply. One function,
 *  two states: a suspended business is put back by Reactivate, a terminated one
 *  by Extend 30 days only (2026-11-17), and that case reuses
 *  operatorTerminatedReactivateText so the operator reads one sentence
 *  everywhere. */
export function operatorInviteSuspendedText(business) {
  if (business && business.status === 'churned') return operatorTerminatedReactivateText(business);
  return `${businessName(business).slice(0, 120)} is suspended. Reactivate it first.`;
}

/* ----- /invite: the list and the result ----- */

/** "N. Name · Status": the businesses an invite can be made for. */
export function operatorInviteListText(rows) {
  if (!rows || !rows.length) return OPERATOR_NO_INVITABLE;
  const heads = numberedBusinessNames(rows);
  return 'Invite: pick a business\n\n' + rows.map((r, i) => `${heads[i]} · ${businessStatusWord(r.status)}`).join('\n');
}

/* An invite is never added on top of a connected phone. A business that has
   a phone gets this screen instead, and nothing is created or written: the
   owner adds phones with the owner's own /invite, and the operator can only
   REPLACE the phones, after one confirmation. */

/** "<Name> · Already connected · N phone(s)". */
export function operatorAlreadyConnectedText({ business, phones }) {
  return `${businessName(business)} · Already connected · ${phoneCountText(phones)}`;
}
/** What Replace phone does, said before it is done. */
export function operatorReplaceConfirmText({ business, phones }) {
  const one = phones === 1;
  return `Replace the ${one ? 'phone' : 'phones'} of ${businessName(business)}? The ${phones} current ${one ? 'phone stops' : 'phones stop'} receiving alerts and ${one ? 'loses' : 'lose'} access immediately, and a new invite is created. Alerts on Telegram stay off until the new phone connects; new leads are still saved and emailed.`;
}
/** No invite could be stored (the cap, the counter or the database). With
 *  `replace` it also says the one thing that matters: no phone was removed. */
export function operatorInviteFailedText({ business, capped = false, replace = false }) {
  const what = capped ? OPERATOR_CAPPED : `Could not create an invite for ${businessName(business)}. Try again.`;
  return replace ? `${what} No phone was removed.` : what;
}
/** The new invite was stored but the phones could not be removed; the new
 *  invite was taken back. */
export function operatorReplaceFailedText(business) {
  return `Could not replace the phones of ${businessName(business)}. No phone was removed. Try again.`;
}

/* ----- the operator's view of leads: data minimization -----
   The operator supports every business and has no need for a customer's
   identity, so a lead is shown to the operator as these fields and nothing
   else. OPERATOR_LEAD_FIELDS is the ONE place that decides it: the columns
   that are read from the database, the list row and the card are all derived
   from it. Showing the name later is one word added to this array. */

export const OPERATOR_LEAD_FIELDS = Object.freeze(['service', 'status', 'age']);

/** Everything a field needs: its column, its label on the card, its text.
 *  A field that is defined here but not listed above is never read. */
const OPERATOR_LEAD_FIELD_DEFS = Object.freeze({
  service: { column: 'service', label: 'Service', show: (l) => serviceLabel(l.service) },
  status: { column: 'status', label: 'Status', show: (l) => statusWord(l.status) },
  age: { column: 'created_at', label: 'Received', show: (l, nowMs) => relativeAge(l.created_at, nowMs) },
  name: { column: 'name', label: 'Name', show: (l) => oneLine(l.name || '') },
});
const operatorLeadDefs = (fields) => (fields || []).map((f) => OPERATOR_LEAD_FIELD_DEFS[f]).filter(Boolean);

/** The lead columns the operator view reads (the id is added by the query). */
export function operatorLeadColumns(fields = OPERATOR_LEAD_FIELDS) {
  return [...new Set(operatorLeadDefs(fields).map((d) => d.column))];
}

/** The business's leads, read-only: "N. Service · Status · Age" under the name. */
export function operatorLeadListText(business, leads, leadPage = 0, nowMs = Date.now(), fields = OPERATOR_LEAD_FIELDS) {
  const name = businessName(business);
  if (!leads || !leads.length) return `${name}\n${leadPage > 0 ? OPERATOR_NO_OLDER_LEADS : OPERATOR_NO_LEADS}`;
  const defs = operatorLeadDefs(fields);
  const rows = leads.map((l, i) => `${i + 1}. ${defs.map((d) => oneLine(d.show(l, nowMs))).join(' · ')}`);
  return `${name}\nLeads\n\n${rows.join('\n')}`;
}

/** One lead, read-only: one "Label: value" line per allowed field. */
export function operatorLeadCardText(business, lead, nowMs = Date.now(), fields = OPERATOR_LEAD_FIELDS) {
  const lines = operatorLeadDefs(fields).map((d) => `${d.label}: ${oneLine(d.show(lead, nowMs))}`);
  return `${businessName(business)}\nLead\n\n${lines.join('\n')}`;
}

const backButton = (data) => ({ text: iconLabel('back', 'Back'), callback_data: data });
const clampLeadPage = (page) => Math.max(0, Math.min(99, Number(page) || 0));

/** Number buttons 1..N (bd:page:id), then the same navigation rule as /leads. */
export function operatorBusinessListKeyboard(rows, page, hasOlder, hasNewer = page > 0) {
  return browserKeyboard(rows, 'bd', 'bl', page, hasOlder, hasNewer);
}

/** The /invite list: number buttons (bi:page:id), navigation by bn:page. */
export function operatorInviteListKeyboard(rows, page, hasOlder, hasNewer = page > 0) {
  return browserKeyboard(rows, 'bi', 'bn', page, hasOlder, hasNewer);
}

/** The label of the Extend button; the number is the one the code adds. */
export const OPERATOR_EXTEND_LABEL = `Extend ${EXTEND_DAYS} days`;

/**
 * Under one business. The rows depend on the CURRENT state and phone count:
 * active with no phone gets Invite, active with a phone gets Replace phone
 * (bw, never bv); a billing suspension has no Reactivate because payment is
 * the only unlock; a manual suspension has one; terminated has no Reactivate
 * and no Terminate. Back returns to the exact list page.
 */
export function operatorBusinessDetailKeyboard(businessId, page, {
  suspended = false, terminated = false, connected = false, billingSuspended = false,
} = {}) {
  const p = clampPage(page);
  const leads = { text: 'Leads', callback_data: `bq:0:${p}:${businessId}` };
  const extend = { text: OPERATOR_EXTEND_LABEL, callback_data: `be:${p}:${businessId}`, style: 'primary' };
  // bx / bX. The letters bt / bT belong to a retired Terminate that DELETED
  // data; they are never reused, so an old button can never end a service.
  const terminate = { text: 'Terminate', callback_data: `bx:${p}:${businessId}`, style: 'danger' };
  const reactivate = { text: 'Reactivate', callback_data: `br:${p}:${businessId}`, style: 'primary' };
  const back = backButton('bl:' + p);
  let rows;
  if (terminated) rows = [[extend, leads], [back]];
  else if (suspended && billingSuspended) rows = [[extend, leads], [terminate], [back]];
  else if (suspended) rows = [[reactivate, leads], [extend], [terminate], [back]];
  else {
    const invite = connected
      ? { text: 'Replace phone', callback_data: `bw:${p}:${businessId}`, style: 'primary' }
      : { text: 'Invite', callback_data: `bv:${p}:${businessId}`, style: 'primary' };
    rows = [
      [{ text: 'Suspend', callback_data: `bs:${p}:${businessId}`, style: 'danger' }, invite],
      [extend, leads],
      [terminate],
      [back],
    ];
  }
  return { reply_markup: { inline_keyboard: rows } };
}

export function operatorTerminateConfirmKeyboard(businessId, page) {
  const p = clampPage(page);
  return { reply_markup: { inline_keyboard: [[
    { text: 'Confirm terminate', callback_data: `bX:${p}:${businessId}`, style: 'danger' },
    { text: 'Cancel', callback_data: `bd:${p}:${businessId}` },
  ]] } };
}

/** Under the Extend question: Confirm (carries the exact date it will set)
 *  and Cancel (back to the business). */
export function operatorExtendConfirmKeyboard(businessId, page, target) {
  const p = clampPage(page);
  return { reply_markup: { inline_keyboard: [[
    { text: 'Confirm', callback_data: `bE:${p}:${businessId}:${encodePaidUntil(target)}`, style: 'success' },
    { text: 'Cancel', callback_data: `bd:${p}:${businessId}` },
  ]] } };
}

/** br asks, bR does. A stale br opens this question, never the action. */
export function operatorReactivateConfirmKeyboard(businessId, page) {
  const p = clampPage(page);
  return { reply_markup: { inline_keyboard: [[
    { text: 'Confirm reactivate', callback_data: `bR:${p}:${businessId}`, style: 'success' },
    { text: 'Cancel', callback_data: `bd:${p}:${businessId}` },
  ]] } };
}

export function operatorSuspendConfirmKeyboard(businessId, page) {
  const p = clampPage(page);
  return { reply_markup: { inline_keyboard: [[
    { text: 'Confirm suspend', callback_data: `bS:${p}:${businessId}`, style: 'danger' },
    { text: 'Cancel', callback_data: `bd:${p}:${businessId}` },
  ]] } };
}

/**
 * The invite flow is opened from the /invite list (`from` 'list') or from a
 * business screen ('business'). The two differ only in where Back leads and
 * in the letters of their callbacks, so one stale button can never land on
 * the other origin's screen.
 */
const INVITE_FLOW = {
  list: { ask: 'bp', confirm: 'bP', cancel: 'bc' },
  business: { ask: 'bw', confirm: 'bW', cancel: 'bu' },
};
const inviteFlow = (from) => INVITE_FLOW[from === 'business' ? 'business' : 'list'];
const inviteBackButton = (businessId, page, from) =>
  backButton(from === 'business' ? `bd:${clampPage(page)}:${businessId}` : 'bn:' + clampPage(page));

/** Under "Already connected": Replace phone (danger, left) and Back (right). */
export function operatorAlreadyConnectedKeyboard(businessId, page, from) {
  return { reply_markup: { inline_keyboard: [[
    { text: 'Replace phone', callback_data: `${inviteFlow(from).ask}:${clampPage(page)}:${businessId}`, style: 'primary' },
    inviteBackButton(businessId, page, from),
  ]] } };
}

/** Under the question: Confirm replace (danger) and Cancel, side by side.
 *  Cancel returns to "Already connected" and can never create an invite. */
export function operatorReplaceConfirmKeyboard(businessId, page, from) {
  const p = clampPage(page);
  const f = inviteFlow(from);
  return { reply_markup: { inline_keyboard: [[
    { text: 'Confirm replace', callback_data: `${f.confirm}:${p}:${businessId}`, style: 'danger' },
    { text: 'Cancel', callback_data: `${f.cancel}:${p}:${businessId}` },
  ]] } };
}

/** Back to the business: under a suspend or reactivate result. */
export function operatorBackToBusinessKeyboard(businessId, page) {
  return { reply_markup: { inline_keyboard: [[backButton(`bd:${clampPage(page)}:${businessId}`)]] } };
}

/** Back to a page of the /invite list, under an invite picked from it. */
export function operatorBackToInviteListKeyboard(page) {
  return { reply_markup: { inline_keyboard: [[backButton('bn:' + clampPage(page))]] } };
}

/** Back to where the invite flow was opened: the list page or the business. */
export function operatorInviteBackKeyboard(businessId, page, from) {
  return from === 'business' ? operatorBackToBusinessKeyboard(businessId, page) : operatorBackToInviteListKeyboard(page);
}

/** Read-only lead list: numbers, Newer/Older where real, then Back to the
 *  business. No status, remove or copy button anywhere. */
export function operatorLeadListKeyboard({ businessId, leads, leadPage, page, hasOlder }) {
  const lp = clampLeadPage(leadPage);
  const p = clampPage(page);
  const b = packUuid(businessId);
  const rows = [];
  const numbers = (leads || []).map((l, i) => ({ text: String(i + 1), callback_data: `bo:${lp}:${p}:${b}${packUuid(l.id)}` }));
  if (numbers.length) rows.push(numbers);
  const nav = [];
  if (lp > 0) nav.push({ text: 'Newer', callback_data: `bq:${lp - 1}:${p}:${businessId}` });
  if (hasOlder && lp < 99) nav.push({ text: 'Older', callback_data: `bq:${lp + 1}:${p}:${businessId}` });
  if (nav.length) rows.push(nav);
  rows.push([backButton(`bd:${p}:${businessId}`)]);
  return { reply_markup: { inline_keyboard: rows } };
}

/** One lead, read-only: Back to the list page it was opened from. */
export function operatorLeadDetailKeyboard({ businessId, leadPage, page }) {
  return { reply_markup: { inline_keyboard: [[backButton(`bq:${clampLeadPage(leadPage)}:${clampPage(page)}:${businessId}`)]] } };
}

/** /leads and /remove_lead: shared copy for the browser lists. */
export const REMOVE_LEAD_TITLE = 'Which request do you want to remove?';
export const REMOVE_LEAD_GONE = 'That request is no longer here.';

/**
 * The confirmation after a delete: what was removed, and nothing else. No phone,
 * no email, no notes — this line sits in a chat that may be read over a shoulder,
 * and the name is the only thing the owner needs to know which row went.
 * The job uses the same wording as the lists.
 */
export function removedText(lead) {
  const name = oneLine(lead && lead.name) || 'a request';
  return `Removed: ${name} · ${serviceLabel(lead && lead.service)}`;
}

/** /remove_lead list: number, name, service and age. No phone, no actions. */
export function removeLeadListText(leads, nowMs = Date.now()) {
  const blocks = (leads || []).map((l, i) => [
    `${i + 1}. ${oneLine(l.name || '')}`,
    `${serviceLabel(l.service)} · ${relativeAge(l.created_at, nowMs)}`,
  ].join('\n'));
  return `${REMOVE_LEAD_TITLE}\n\n${blocks.join('\n\n')}`;
}

/* ---------- /leads browser: one message, numbers, nav, detail ----------
   The list text is the only place a lead's details appear. Under it sits ONE
   row of number buttons (1..N, N up to the page size) matching the numbers in
   the text, then at most one navigation row. Nothing is duplicated between
   the text and the buttons, so the whole keyboard is never taller than two
   rows. Callback data carries only a bounded page and the lead uuid — never
   anything a customer typed. */

/** Page numbers are bounded everywhere (the anchored regexes allow three
 *  digits; api/tg.js clamps to LEADS_PAGE_MAX before paging), so a callback can
 *  never grow past Telegram's 64-byte limit. */
const PAGE_CAP = 999;
const clampPage = (page) => Math.max(0, Math.min(PAGE_CAP, Number(page) || 0));

/** One row of number buttons, 1..N, matching the numbers in the list text. */
function numberRow(leads, prefix, page) {
  return (leads || []).map((l, i) => ({ text: String(i + 1), callback_data: `${prefix}:${page}:${l.id}` }));
}

/**
 * The navigation row: only the ends that lead somewhere. First page with older
 * rows: Older alone. Middle pages: Newer and Older side by side. Last page:
 * Newer alone. A single page: no row at all (an empty array). There is no
 * disabled button and no placeholder; a stale tap is answered server-side.
 */
function navRow(prefix, page, hasOlder, hasNewer) {
  const nav = [];
  if (hasNewer && page > 0) nav.push({ text: 'Newer', callback_data: `${prefix}:${page - 1}` });
  if (hasOlder && page < PAGE_CAP) nav.push({ text: 'Older', callback_data: `${prefix}:${page + 1}` });
  return nav;
}

/** Numbers row, then the navigation row when it has anything in it. */
function browserKeyboard(leads, rowPrefix, navPrefix, page, hasOlder, hasNewer) {
  const p = clampPage(page);
  const rows = [];
  const numbers = numberRow(leads, rowPrefix, p);
  if (numbers.length) rows.push(numbers);
  const nav = navRow(navPrefix, p, hasOlder, hasNewer);
  if (nav.length) rows.push(nav);
  return { reply_markup: { inline_keyboard: rows } };
}

/** /leads list keyboard: number buttons (L:page:leadId edits the same message
 *  to the detail), then Newer/Older where they are real. */
export function leadListKeyboard(leads, page, hasOlder, hasNewer = page > 0) {
  return browserKeyboard(leads, 'L', 'l', page, hasOlder, hasNewer);
}

/** /remove_lead list keyboard: the same layout in removal mode. A number tap
 *  (Q:page:leadId) asks for confirmation instead of opening the detail. */
export function removeLeadKeyboard(leads, page, hasOlder, hasNewer = page > 0) {
  return browserKeyboard(leads, 'Q', 'rm', page, hasOlder, hasNewer);
}

export function removeLeadConfirmText(lead, nowMs = Date.now()) {
  return `${oneLine(lead.name || '')}\n${serviceLabel(lead.service)} · ${relativeAge(lead.created_at, nowMs)}\n\nRemove this request? It cannot be undone.`;
}

/**
 * The removal confirmation keyboard. With a page (the /remove_lead browser)
 * Cancel returns to that page and Remove addresses E:. Without one — a tap on
 * an rl: button from a message sent before the browser existed — the old
 * RL:/rc: pair is kept, so those buttons keep working exactly as they did.
 */
export function removeLeadConfirmKeyboard(leadId, page = null) {
  if (page === null || page === undefined) {
    return { reply_markup: { inline_keyboard: [[
      { text: 'Remove', callback_data: 'RL:' + leadId, style: 'danger' },
      { text: 'Cancel', callback_data: 'rc:' + leadId },
    ]] } };
  }
  const p = clampPage(page);
  return { reply_markup: { inline_keyboard: [[
    { text: 'Remove', callback_data: `E:${p}:${leadId}`, style: 'danger' },
    { text: 'Cancel', callback_data: 'rm:' + p },
  ]] } };
}

/**
 * The lead detail keyboard inside the /leads browser. Same actions and styles
 * as the alert card, then Back on its own row (l:page restores the exact list
 * page). No copy button: the phone number is already tappable in the text.
 * `kind`: new | contacted | confirm | done | error, matching the card state.
 */
export function leadDetailKeyboard(kind, leadId, page, lead = null) {
  const p = clampPage(page);
  const back = { text: iconLabel('back', 'Back'), callback_data: 'l:' + p };
  const rows = [];
  if (kind === 'new') {
    rows.push([{ text: 'Mark contacted', callback_data: `C:${p}:${leadId}`, style: 'primary' }]);
  } else if (kind === 'contacted') {
    rows.push([{ text: 'Job completed', callback_data: `D:${p}:${leadId}`, style: 'primary' }]);
  } else if (kind === 'confirm') {
    rows.push([
      { text: lead && lead.email ? 'Send request' : 'Mark done', callback_data: `Y:${p}:${leadId}`, style: 'success' },
      { text: 'Cancel', callback_data: `N:${p}:${leadId}`, style: 'danger' },
    ]);
  } else if (kind === 'error') {
    rows.push([{ text: 'Try again', callback_data: `R:${p}:${leadId}`, style: 'primary' }]);
  }
  // 'done' has no status action left; every state keeps Back.
  rows.push([back]);
  return { reply_markup: { inline_keyboard: rows } };
}

/* ---------- button icons ----------
   One seam for every button icon, kept for the future. Today NO button carries
   an icon: BUTTON_ICONS is empty, so buttonIcon() answers null for every name
   and iconLabel() returns the label unchanged — every button label in the bot
   is plain text. Extension point (NOT implemented): Bot API
   InlineKeyboardButton.icon_custom_emoji_id, which needs a Premium bot owner.
   If that is ever wanted, BUTTON_ICONS grows an entry per name and the
   builders attach it beside the label. Icons are presentation only: they never
   go into callback data. The table is a parameter so a test can prove the seam
   still works without shipping an icon. */
export const BUTTON_ICONS = Object.freeze({});

/** The icon for a button, or null when it has none (today: always null). */
export function buttonIcon(name, icons = BUTTON_ICONS) {
  const icon = icons && Object.prototype.hasOwnProperty.call(icons, name) ? icons[name] : null;
  return typeof icon === 'string' && icon ? icon : null;
}

/** The button label with its icon in front, when one exists. */
export function iconLabel(name, label, icons = BUTTON_ICONS) {
  const text = String(label == null ? '' : label);
  const icon = buttonIcon(name, icons);
  return icon && text ? `${icon} ${text}` : text;
}

/* ---------- persistent reply keyboard (one per role) ----------
   At most TWO buttons, side by side in ONE row, plain text. Everything else a
   role may do stays in the native command menu (setMyCommands). The array
   order is the on-screen order, left to right. */

/** Owner (the oldest connected phone). */
export const OWNER_KEYBOARD_LABELS = ['Invite', 'Leads'];
/** Staff phones: read and navigate, nothing owner-only. */
export const STAFF_KEYBOARD_LABELS = ['Leads'];
/** The operator chat only. Never sent to a business chat. */
export const OPERATOR_KEYBOARD_LABELS = ['Invite', 'Businesses'];

/**
 * Labels the keyboard carried before it was cut to two buttons. A phone keeps
 * the keyboard it was last sent until the bot sends it a new one, so a press
 * on one of these can still arrive; it keeps doing what it says.
 */
export const LEGACY_KEYBOARD_LABELS = {
  Recipients: '/recipients', Help: '/help', Phones: '/phones', Operator: '/operator', Code: '/code',
};

/**
 * A keyboard press arrives as the button's plain text. These mappings turn the
 * known labels back into their commands; the handlers' own permission checks
 * are the only authorization, so a pressed label can never do more than typing
 * the command would. An unknown text is not a press at all.
 */
export const KEYBOARD_LABELS = {
  Leads: '/leads', Invite: '/invite',
  Businesses: '/businesses',
  // The one button of a suspended or terminated business's phone
  // (STATUS_BUTTON_LABEL in lib/lifecycle-text.js).
  Status: '/status',
  ...LEGACY_KEYBOARD_LABELS,
};

/** KeyboardButton.text values only, all in ONE row, persistent and resized. */
export function persistentKeyboard(labels) {
  return {
    keyboard: [(labels || []).map((text) => ({ text }))],
    is_persistent: true,
    resize_keyboard: true,
  };
}
