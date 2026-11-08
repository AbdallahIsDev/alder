// lib/email-builders.js — every HTML email body the system can send, in one place.
//
// Two jobs:
//
//   1. The ops messages (self-check, digest) get the same shell as the product
//      emails: same logo, same header band, same footer, same padding. The logo
//      arrives as a CID inline image attached by lib/mail.js, so it is actually
//      referenced by the HTML — an attachment nobody references is what a mail
//      client shows as a stray "logo.png" card.
//
//   2. EMAIL_BUILDERS is the registry the guard test walks. A new sender that
//      builds its own HTML instead of calling one of these is caught by
//      tests/email-layout.test.mjs, which also refuses a module that calls
//      sendMail() without importing this file.
//
// Nothing here reads the environment or the database.

import { getBrand } from './brand.js';
import { shell, opsHeader, ownerHeader, esc } from './email-layout.js';
import { ownerEmail, autoReply, reviewEmail } from './content.js';
import {
  selfCheckBody, digestBody,
  SELFCHECK_TITLE, SELFCHECK_SUBTITLE, DIGEST_TITLE, DIGEST_SUBTITLE, OPERATOR_TITLE,
} from './ops-copy.js';

export { ownerEmail, autoReply, reviewEmail };

/**
 * The shell every operations email uses. The body arrives as the plain text the
 * Telegram message also uses: blank lines become spacing, every other line is a
 * paragraph. Nothing is bolded or coloured by meaning, so the message reads the
 * same when a client strips styling — and emoji are decoration, never the only
 * carrier of a fact.
 */
/**
 * Emails carry no emoji. The Telegram messages keep theirs, and several ops
 * strings are shared, so the email gets its own variant by stripping the
 * pictographs at this boundary rather than forking the copy. Variation
 * selectors and ZWJ are removed too; a leftover double space is collapsed.
 */
export function stripEmoji(v) {
  // Remove the pictograph, its variation selector / ZWJ, and ONE following
  // space. Nothing else: the digest and self-check bodies are indented on
  // purpose, and a global whitespace collapse would flatten that.
  return String(v == null ? '' : v)
    .replace(/\p{Extended_Pictographic}[\uFE0F\u200D\u20E3]*[ \t]?/gu, '');
}

export function opsEmail({ title, subtitle, text, business = null }) {
  const brand = getBrand();
  const c = brand.colors;
  title = stripEmoji(title);
  subtitle = stripEmoji(subtitle);
  text = stripEmoji(text);
  const body = String(text || '').split('\n').map((line) => (line.trim() === ''
    ? '<div style="height:10px;line-height:10px;font-size:0">&nbsp;</div>'
    : `<div style="font:400 15px/22px ${brand.fonts.bodyStack};color:${c.text};padding:1px 0">${esc(line)}</div>`)).join('');
  const footer = `<p style="margin:0;font:400 12px/18px ${brand.fonts.bodyStack};color:${c.muted}">Sent by Lead Alerts</p>`;
  return shell({
    preheader: esc(title),
    // Company emails carry the company's own header; only the operator alarm
    // (no business) uses the platform header.
    header: business
      ? ownerHeader({ business, brand, title, subtitle })
      : opsHeader({ title, subtitle, brand }),
    body, footer, brand,
  });
}

/** Self-check email: same counts as the Telegram message, in the shared shell. */
export function selfCheckEmail(day, dateKey, business = null) {
  const body = selfCheckBody(day);
  return {
    subject: `Alert check — ${dateKey}`,
    text: stripEmoji([SELFCHECK_TITLE, SELFCHECK_SUBTITLE, '', body].join('\n')),
    html: opsEmail({ title: SELFCHECK_TITLE, subtitle: SELFCHECK_SUBTITLE, text: body, business }),
  };
}

/** The operator alarm by email: same body as the Telegram message. */
export function operatorAlarmEmail(body, dateKey) {
  return {
    subject: `Alert check — operator — ${dateKey}`,
    text: stripEmoji([OPERATOR_TITLE, SELFCHECK_SUBTITLE, '', body].join('\n')),
    html: opsEmail({ title: OPERATOR_TITLE, subtitle: SELFCHECK_SUBTITLE, text: body }),
  };
}

/** Owner digest email: same counts as the Telegram message, in the shared shell. */
export function digestEmail(day, dateKey, business = null) {
  const body = digestBody(day);
  return {
    subject: `Your lead summary — ${dateKey}`,
    text: stripEmoji([DIGEST_TITLE, DIGEST_SUBTITLE, '', body].join('\n')),
    html: opsEmail({ title: DIGEST_TITLE, subtitle: DIGEST_SUBTITLE, text: body, business }),
  };
}

/** The guard test's list. Adding a sender means adding it here. */
export const EMAIL_BUILDERS = {
  ownerEmail, autoReply, reviewEmail, selfCheckEmail, digestEmail, operatorAlarmEmail,
};
