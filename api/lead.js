// Vercel serverless function: POST /api/lead
// Server-side checks for the estimate form. The browser checks are for convenience only; this is the real gate.
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, IP_HASH_SALT, TELEGRAM_BOT_TOKEN,
// TELEGRAM_CHAT_ID, TELEGRAM_WEBHOOK_SECRET, RESEND_API_KEY, MAIL_FROM, MAIL_REDIRECT_TO, SITE_URL
//
// Nothing here logs a name, phone, email, note, raw IP, token or URL. Failures are codes only.

import { randomUUID } from 'node:crypto';
import TOKENS from '../lib/design-tokens.js';
import { hashIp } from '../lib/hash.js';
import { clientIp } from '../lib/request.js';
import { isValidPhoneNumber, parsePhoneNumber } from 'libphonenumber-js/max';
import { insertLead, addEvent, hitRateLimit, getBusinessById, getLeadForReplay, getLeadDeliveryState, claimLeadNotification, releaseLeadNotification } from '../lib/db.js';
import { findRecentDuplicate } from '../lib/lead-intake.js';
import { isOwnerEmailReplayRetryable, notifyAllAfterLead } from '../lib/notify.js';
import { resolveTenant } from '../lib/tenant.js';
import { announceHeldLead } from '../lib/held-leads.js';
import { normalizePhone } from '../lib/phone.js';

const SERVICES = ['replacement', 'storm', 'repair', 'unsure'];

/* What the visitor is told when the business is suspended (the lead is HELD)
   or terminated (nothing is stored). Neither promises a reply. The page's own
   modal carries the same two sentences next to a Call button (index.html). */
export const HELD_MESSAGE = 'Your request was saved, but this business can\u2019t respond through this form right now. For the fastest help, please call them directly.';
export const UNAVAILABLE_MESSAGE = 'This business isn\u2019t accepting requests through this form right now. Please call them directly.';
const HOMES = ['house', 'multi', 'commercial', 'other'];
const TIMINGS = ['asap', 'month', 'quarter', 'planning'];
const AGES = ['Under 10 years', '10 to 20 years', 'Over 20 years', 'Not sure'];

// Exactly the keys the form sends. Anything else is a 400.
const ALLOWED = new Set([
  'service', 'home', 'timing', 'age', 'zip', 'phone', 'name', 'email', 'notes',
  'claim', 'website', 'elapsed', 'slug', 'business_id', 'idempotencyKey',
]);

const MAX_BODY = 10 * 1024;
/* Duplicate detection window. Advisory only — the lead is always stored. */
const DUPLICATE_WINDOW_DAYS = 30;
const IP_LIMIT = { window: 3600, max: 10 };
const BIZ_LIMIT = { window: 3600, max: 200 };

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const clean = (v) => String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');   // strip control characters, keep \n and \t

/* Small standalone page for the no-JS form. Inline styles only (the CSP allows them). */
function htmlPage(title, message, businessName) {
  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:40px 20px;background:#fafafa;font:16px/1.6 Arial,Helvetica,sans-serif;color:#1c1f24"><main style="max-width:480px;margin:0 auto;background:#fff;padding:32px;border-radius:${TOKENS.radius.apiCard}">
<h1 style="font-size:22px;margin:0 0 16px">${esc(businessName || 'Request')}</h1>
<p>${esc(message)}</p>
<p style="margin-top:24px"><a href="/" style="color:#1c1f24">Back to the site</a></p>
</main></body></html>`;
}

/**
 * Announce a stored lead, at most once at a time.
 *
 * The fixed-window claim (lib/db.js) stops most overlapping sends, but two calls
 * straddling a bucket edge can both win. It is released when this attempt finishes
 * — success or failure — so a retry after a failed alert is allowed again. Fails
 * open: an owner alert matters more than the best-effort claim.
 *
 * `recheck` is for the replay path: two requests can both read "nothing has been
 * delivered" before either takes the claim, so the holder looks once more before
 * sending. A failed re-check propagates to the caller, which logs a code and
 * answers as before — the claim is still released.
 */
async function announceLead(ctx, recheck) {
  let claimed = true;
  try {
    claimed = await claimLeadNotification(ctx.leadId);
  } catch (e) {
    console.error('lead_notify_claim_failed', (e && e.code) || 'no_code');
  }
  if (!claimed) return;
  try {
    if (recheck) {
      ctx.replay = true;
      const state = await getLeadDeliveryState(ctx.leadId);
      const partialTelegram = state.delivered && state.failedChatHashes.length > 0;
      if (state.delivered && !partialTelegram && state.emailOwnerSent) return;
      ctx.deliveredChatHashes = state.deliveredChatHashes;
      ctx.retryTelegramOnly = partialTelegram && state.emailOwnerSent;
      ctx.retryEmailOnly = state.delivered && !state.emailOwnerSent && state.failedChatHashes.length === 0;
      ctx.skipOwnerEmail = !state.emailOwnerSent && state.emailOwnerFailureRecorded
        && !isOwnerEmailReplayRetryable(state.lastEmailOwnerFailureStatus);
    }
    await notifyAllAfterLead(ctx);
  } finally {
    try {
      await releaseLeadNotification(ctx.leadId);
    } catch (e) {
      console.error('lead_notify_release_failed', (e && e.code) || 'no_code');
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  res.setHeader('Cache-Control', 'no-store');

  const ctype = String(req.headers['content-type'] || '').toLowerCase();
  const isJson = ctype.startsWith('application/json');
  const isForm = ctype.startsWith('application/x-www-form-urlencoded');
  if (!isJson && !isForm) return res.status(415).json({ ok: false });

  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_BODY) return res.status(413).json({ ok: false });

  const htmlReply = (code, title, message, businessName) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(code).send(htmlPage(title, message, businessName));
  };
  const badForm = (businessName) => htmlReply(400, 'Check your details', 'Please go back and check your details.', businessName);
  const tenantNotFound = () => isForm
    ? htmlReply(404, 'Not found', 'Not found.', null)
    : res.status(404).json({ ok: false });

  let b = req.body;
  if (typeof b === 'string') {
    if (Buffer.byteLength(b) > MAX_BODY) return res.status(413).json({ ok: false });
    if (isForm) {
      const o = {};
      for (const [k, v] of new URLSearchParams(b)) o[k] = v;
      b = o;
    } else {
      try { b = JSON.parse(b); } catch { return res.status(400).json({ ok: false }); }
    }
  } else if (isForm && b && typeof b === 'object') {
    // Some runtimes already decode urlencoded bodies into an object.
    b = { ...b };
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return res.status(400).json({ ok: false });

  // A no-JS form cannot measure how long it was open, and cannot mint a UUID. Both are
  // supplied by the server for that content type. Every other check still applies.
  if (isForm) {
    b.claim = b.claim === true || b.claim === 'on' || b.claim === 'true' || b.claim === '1';
    b.elapsed = 5000;
    if (!str(b.idempotencyKey)) b.idempotencyKey = 'form-' + randomUUID();
  }

  // Bots: honeypot filled, or finished in under 2 s. Answer "ok" so they learn nothing, deliver nothing.
  // The log line names the reason only; nothing from the payload goes near it.
  if (str(b.website)) {
    console.warn('lead_dropped_honeypot');
    return isForm ? htmlReply(200, 'Thank you', 'Thank you.', null) : res.status(200).json({ ok: true });
  }
  if (!(Number(b.elapsed) >= 2000)) {
    console.warn('lead_dropped_timing');
    return isForm ? htmlReply(200, 'Thank you', 'Thank you.', null) : res.status(200).json({ ok: true });
  }

  // Reject anything the form does not send, so a typo in the payload fails loudly here.
  for (const k of Object.keys(b)) if (!ALLOWED.has(k)) {
    return isForm ? badForm(null) : res.status(400).json({ ok: false });
  }

  // Allow-lists and length caps (same limits as the form's maxlength).
  // Phone is validated AFTER the business lookup, but the region is always
  // 'US': lib/db.js getActiveBusinessBySlug does not select a country column
  // (the businesses table has none), so business.country is never present.
  const service = str(b.service), home = str(b.home), timing = str(b.timing), age = str(b.age);
  const zip = str(b.zip), phone = clean(str(b.phone)), name = clean(str(b.name)), notes = clean(str(b.notes));
  // Lowercased once, at the boundary: storage, the auto-reply recipient and the
  // duplicate lookup all use this value, so 'A@b.com' and 'a@b.com' are the same
  // address everywhere. Rows written before this change keep their original case
  // and will not match a lowercased address in the duplicate check.
  const email = clean(str(b.email)).toLowerCase();

  // slug/business_id are accepted only for backward-compatible payloads and are
  // deliberately ignored. Host alone selects the tenant; forwarded Host is unused.
  const idem = str(b.idempotencyKey);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(idem)) return isForm ? badForm(null) : res.status(400).json({ ok: false });

  // The tenant comes from Host and from nothing else. Unlike every other
  // public endpoint, this one also resolves a suspended and a terminated
  // business, because each has its own answer:
  //   demo / active   the lead is stored and announced (unchanged)
  //   paused          HOLD: stored with held_at, announced to nobody
  //   churned         UNAVAILABLE: nothing is stored, nothing is sent
  const tenant = await resolveTenant(req, { anyStatus: true });
  if (!tenant) return tenantNotFound(); // unknown/malformed host, or lookup failure
  const { business } = tenant;
  let held = business.status === 'paused';
  if (business.status === 'churned') {
    // Its own result: not ok, not a 404, and never the generic 5xx panel.
    return isForm
      ? htmlReply(410, 'Not available', UNAVAILABLE_MESSAGE, business.name)
      : res.status(410).json({ ok: false, unavailable: true });
  }
  // Rate limit 1: per caller, keyed by a salted hash. It runs AFTER the tenant
  // check so a terminated host always answers its own 410, never a generic
  // 429 from an unrelated flood. The raw IP is never stored or logged.
  const ipHash = hashIp(clientIp(req));
  if (!ipHash) {
    console.error('lead_rate_limit_salt_missing');
    return isForm ? htmlReply(500, 'Try again', 'Please try again shortly.', null) : res.status(500).json({ ok: false });
  }
  try {
    if (!(await hitRateLimit(ipHash, IP_LIMIT.window, IP_LIMIT.max))) {
      return isForm ? htmlReply(429, 'Try again', 'Please try again later.', null) : res.status(429).json({ ok: false });
    }
  } catch (e) {
    console.error('lead_rate_limit_failed', (e && e.code) || 'no_code');
  }
  if (!held && business.status !== 'demo' && business.status !== 'active') return tenantNotFound();
  const okReply = (forceHeld = held) => {
    if (forceHeld) return isForm ? htmlReply(200, 'Request saved', HELD_MESSAGE, business.name) : res.status(200).json({ ok: true, held: true });
    return isForm ? htmlReply(200, 'Request received', 'We received your request.', business.name) : res.status(200).json({ ok: true });
  };

  // Phone: the browser and this handler call the SAME rule in lib/phone.js.
  // Normalisation comes first: Arabic-Indic digits become ASCII, "00" becomes
  // "+", and 10/11-digit NANP shapes (including 555) store as +1XXXXXXXXXX.
  // Fewer than 10 digits, more than 11, letters and a 0/1 area code are 400s.
  // Everything else is checked by strictPhone below with libphonenumber-js/max.
  // The number is never logged.
  const region = (business && typeof business.country === 'string' && /^[A-Za-z]{2}$/.test(business.country)) ? business.country.toUpperCase() : 'US';
  // Non-NANP numbers keep the strict max-metadata check, including the single
  // trunk zero retry. NANP shapes — including the 555 range — are decided by
  // the shared rule before this callback is ever reached.
  const strictPhone = (value) => {
    try {
      if (isValidPhoneNumber(value, region)) return parsePhoneNumber(value, region).number;
    } catch { /* try the trunk-zero form below */ }
    try {
      const parsed = parsePhoneNumber(value, region);
      const cc = parsed && String(parsed.countryCallingCode || '');
      const nat = parsed && String(parsed.nationalNumber || '');
      if (cc && nat.startsWith('0')) {
        const retry = '+' + cc + nat.slice(1);
        if (isValidPhoneNumber(retry, region)) return parsePhoneNumber(retry, region).number;
      }
    } catch { /* keep the refusal */ }
    return null;
  };
  const phoneResult = normalizePhone(phone, { table: null, defaultCc: '1' }, strictPhone);
  const phoneE164 = phoneResult.ok ? phoneResult.value : null;
  const phoneBad = !phoneResult.ok;
  // Per-field errors for the JSON path: the modal maps each one to that
  // field's existing message and stays on step 4. No values are echoed back.
  const fieldErrors = {};
  if (!SERVICES.includes(service)) fieldErrors.service = 'Choose what you need help with.';
  if (!HOMES.includes(home)) fieldErrors.home = 'Choose a property type.';
  if (!TIMINGS.includes(timing)) fieldErrors.timing = 'Choose when you want to start.';
  if (!AGES.includes(age)) fieldErrors.age = 'Choose the roof’s approximate age.';
  if (!/^\d{5}$/.test(zip)) fieldErrors.zip = 'Enter your 5-digit ZIP code.';
  if (phoneBad) fieldErrors.phone = 'Enter a valid phone number.';
  if (name.length < 2 || name.length > 80) fieldErrors.name = 'Enter your name.';
  if (email.length > 254 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) fieldErrors.email = 'Enter a valid email or leave it blank.';
  if (notes.length > 2000) fieldErrors.notes = 'Keep notes under 2000 characters.';
  const bad = Object.keys(fieldErrors).length > 0;
  if (bad) {
    if (isForm && phoneBad) return htmlReply(400, 'Check your details', 'Enter a valid phone number.', business.name);
    if (isForm) return badForm(null);
    if (Object.keys(fieldErrors).length > 0) return res.status(400).json({ ok: false, errors: fieldErrors });
    return res.status(400).json({ ok: false });
  }

  // Rate limit 2: per business, so one site cannot flood its own roofer. Also fails open.
  try {
    if (!(await hitRateLimit('biz:' + business.id, BIZ_LIMIT.window, BIZ_LIMIT.max))) {
      return isForm ? htmlReply(429, 'Try again', 'Please try again later.', null) : res.status(429).json({ ok: false });
    }
  } catch (e) {
    console.error('lead_rate_limit_failed', (e && e.code) || 'no_code');
  }

  // Start the duplicate lookup before the insert and collect it after: the two
  // overlap instead of queueing, so the customer waits for max(insert, lookup)
  // rather than for the sum.
  const dupSince = new Date(Date.now() - DUPLICATE_WINDOW_DAYS * 86400 * 1000).toISOString();
  const dupPromise = findRecentDuplicate(business.id, phoneE164, email || null, dupSince)
    .catch((e) => {
      console.error('lead_duplicate_check_failed', (e && e.code) || 'no_code');
      return null;
    });

  // The tenant row was read before validation. A support action in that window
  // can change the state: decide held vs normal from a fresh row immediately
  // before the insert, so a lead that arrives after reactivation is never
  // marked held and a lead that arrives after termination is never stored.
  const current = await getBusinessById(business.id).catch((e) => {
    console.error('lead_status_read_failed', (e && e.code) || 'no_code');
    return null;
  });
  if (current) {
    if (current.status === 'churned') {
      return isForm
        ? htmlReply(410, 'Not available', UNAVAILABLE_MESSAGE, business.name)
        : res.status(410).json({ ok: false, unavailable: true });
    }
    held = current.status === 'paused';
  }

  let leadId;
  try {
    leadId = await insertLead({
      business_id: business.id,
      name, phone: phoneE164, email: email || null, zip, service, home, timing,
      roof_age: age, insurance_claim: b.claim === true,
      notes: notes || null, source: isForm ? 'form-nojs' : 'form', idempotency_key: idem,
      // Hold mode: the mark that keeps this lead out of every alert.
      ...(held ? { held_at: new Date().toISOString() } : {}),
    });
  } catch (e) {
    console.error('lead_insert_failed', (e && e.code) || 'no_code');
    return isForm ? htmlReply(500, 'Try again', 'Please try again shortly.', business.name) : res.status(500).json({ ok: false });
  }

  // Already stored under this key. This is a retry, and it is the last chance to
  // announce a lead whose first invocation was killed before (or while) alerting:
  // the old code returned "ok" here and the owner never heard about that lead.
  // A retry sends only when nothing was delivered, or when recorded per-chat
  // outcomes identify phones still missing a partial Telegram alert. Confirmed
  // chats and an already-delivered owner email are not repeated. A failed read is
  // not a reason to guess: log a code and leave the lead for the next attempt.
  if (leadId === null) {
    // A retry while the business is suspended announces nothing: the lead is
    // held, and its one notice belongs to the request that stored it.
    if (held) return okReply();
    try {
      const stored = await getLeadForReplay(business.id, idem);
      if (stored) {
        // The row was held when it was stored and was never announced. A later
        // reactivation must not turn this replay into the first announcement:
        // that would leak the visitor's details after the fact.
        if (stored.held_at) return okReply(true);
        const state = await getLeadDeliveryState(stored.id);
        // The first invocation can also die between the insert and its first
        // event. The retry writes the missing created row, with the same advisory
        // the first attempt would have written (its lookup is already in flight).
        let duplicateOf = state.duplicateOf;
        if (!state.created) {
          duplicateOf = await dupPromise;
          if (duplicateOf === stored.id) duplicateOf = null;
          try {
            await addEvent(stored.id, 'created', {
              source: isForm ? 'form-nojs' : 'form',
              slug: business.slug,
              ...(duplicateOf ? { duplicate_of: duplicateOf } : {}),
            });
          } catch (e) {
            console.error('lead_event_created_failed', (e && e.code) || 'no_code');
          }
        }
        if (!state.delivered || state.failedChatHashes.length || !state.emailOwnerSent) {
          await announceLead({
            leadId: stored.id, business, duplicate: !!duplicateOf,
            deliveredChatHashes: state.deliveredChatHashes,
            retryTelegramOnly: state.delivered && state.failedChatHashes.length > 0 && state.emailOwnerSent,
            retryEmailOnly: state.delivered && !state.emailOwnerSent && state.failedChatHashes.length === 0,
            lead: {
              name: stored.name, phone: stored.phone, email: stored.email || '', zip: stored.zip,
              service: stored.service, home: stored.home, timing: stored.timing,
              roof_age: stored.roof_age, insurance_claim: stored.insurance_claim === true,
              notes: stored.notes || '',
            },
          }, true);
        }
      }
    } catch (e) {
      console.error('lead_replay_failed', (e && e.code) || 'no_code');
    }
    return okReply();
  }

  // Advisory: is this the same phone or email as a recent request for this
  // business? The lead is stored either way; the answer only adds one line to the
  // owner alert and one meta field on the created event. The earlier lead's
  // details are never read out, only its id. A lookup that matched this very row
  // (it started before the insert committed) is not a duplicate of anything.
  let duplicateOf = await dupPromise;
  if (duplicateOf === leadId) duplicateOf = null;

  try {
    await addEvent(leadId, 'created', {
      source: isForm ? 'form-nojs' : 'form',
      slug: business.slug,
      ...(duplicateOf ? { duplicate_of: duplicateOf } : {}),
      ...(held ? { held: true } : {}),
    });
  } catch (e) {
    console.error('lead_event_created_failed', (e && e.code) || 'no_code');
  }

  // HOLD MODE. The lead is stored and nothing about it leaves the system: no
  // owner email with its details, no Telegram alert with its details, no
  // customer auto-reply. The business's phones get one short notice with no
  // personal data, and the owner address at most one count a day
  // (lib/held-leads.js). Nothing below can change the response.
  if (held) {
    try { await announceHeldLead({ business }); } catch (e) { console.error('held_notice_failed', (e && e.code) || 'no_code'); }
    return okReply();
  }

  // Save first, notify second. Nothing below can change the response. The
  // fixed-window claim reduces concurrent duplicate sends (see announceLead).
  await announceLead({
    leadId, business, duplicate: !!duplicateOf,
    lead: { name, phone: phoneE164, email, zip, service, home, timing, roof_age: age, insurance_claim: b.claim === true, notes },
  }, false);

  return okReply();
}
