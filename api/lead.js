// Vercel serverless function: POST /api/lead
// Server-side checks for the estimate form. The browser checks are for convenience only; this is the real gate.
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, IP_HASH_SALT, TELEGRAM_BOT_TOKEN,
// TELEGRAM_CHAT_ID, TELEGRAM_WEBHOOK_SECRET, RESEND_API_KEY, MAIL_FROM, MAIL_REDIRECT_TO, SITE_URL
//
// Nothing here logs a name, phone, email, note, raw IP, token or URL. Failures are codes only.

import { createHash, randomUUID } from 'node:crypto';
import { isValidPhoneNumber, parsePhoneNumber } from 'libphonenumber-js/max';
import { getActiveBusinessBySlug, insertLead, addEvent, hitRateLimit } from '../lib/db.js';
import { notifyAllAfterLead } from '../lib/notify.js';

const SERVICES = ['replacement', 'storm', 'repair', 'unsure'];
const HOMES = ['house', 'multi', 'commercial', 'other'];
const TIMINGS = ['asap', 'month', 'quarter', 'planning'];
const AGES = ['Under 10 years', '10 to 20 years', 'Over 20 years', 'Not sure'];

// Exactly the keys the form sends. Anything else is a 400.
const ALLOWED = new Set([
  'service', 'home', 'timing', 'age', 'zip', 'phone', 'name', 'email', 'notes',
  'claim', 'website', 'elapsed', 'slug', 'idempotencyKey',
]);

const MAX_BODY = 10 * 1024;
const IP_LIMIT = { window: 3600, max: 10 };
const BIZ_LIMIT = { window: 3600, max: 200 };

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const clean = (v) => String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');   // strip control characters, keep \n and \t

/* Vercel's edge sets x-real-ip and x-vercel-forwarded-for; x-forwarded-for is the last resort
   (and the only one a client can influence, which is why it is not first). */
function clientIp(req) {
  const first = (v) => String(v || '').split(',')[0].trim();
  return (
    first(req.headers['x-real-ip']) ||
    first(req.headers['x-vercel-forwarded-for']) ||
    first(req.headers['x-forwarded-for']) ||
    String((req.socket && req.socket.remoteAddress) || '')
  );
}

function hashIp(ip) {
  const salt = process.env.IP_HASH_SALT;
  if (!salt) return null;                                    // no salt means a trivially reversible hash; fail closed
  return createHash('sha256').update(ip + salt).digest('hex');
}

/* Small standalone page for the no-JS form. Inline styles only (the CSP allows them). */
function htmlPage(title, message, businessName) {
  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:40px 20px;background:#fafafa;font:16px/1.6 Arial,Helvetica,sans-serif;color:#1c1f24"><main style="max-width:480px;margin:0 auto;background:#fff;padding:32px;border-radius:8px">
<h1 style="font-size:22px;margin:0 0 16px">${esc(businessName || 'Request')}</h1>
<p>${esc(message)}</p>
<p style="margin-top:24px"><a href="/" style="color:#1c1f24">Back to the site</a></p>
</main></body></html>`;
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

  // Rate limit 1: per caller, keyed by a salted hash. The raw IP is never stored or logged.
  // Fail open: if the counter itself is unreachable, a real lead matters more than the cap.
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

  // Allow-lists and length caps (same limits as the form's maxlength).
  // Phone is validated AFTER the business lookup so the business region can
  // be used (business.country when present, else 'US'. The businesses table
  // has no country column today — see lib/db.js — so 'US' applies).
  const service = str(b.service), home = str(b.home), timing = str(b.timing), age = str(b.age);
  const zip = str(b.zip), phone = clean(str(b.phone)), name = clean(str(b.name)), email = clean(str(b.email)), notes = clean(str(b.notes));

  const slug = str(b.slug);
  if (!/^[a-z0-9-]{2,60}$/.test(slug)) return isForm ? badForm(null) : res.status(400).json({ ok: false });

  const idem = str(b.idempotencyKey);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(idem)) return isForm ? badForm(null) : res.status(400).json({ ok: false });

  let business;
  try {
    business = await getActiveBusinessBySlug(slug);
  } catch (e) {
    console.error('lead_business_lookup_failed', (e && e.code) || 'no_code');
    return isForm ? htmlReply(500, 'Try again', 'Please try again shortly.', null) : res.status(500).json({ ok: false });
  }
  if (!business) return isForm ? badForm(null) : res.status(400).json({ ok: false });     // unknown, paused or churned

  // Phone: validated and normalised to E.164 (business country, else US).
  // Anything that does not parse as a valid number is a 400; stored value
  // is always E.164; the number is never logged.
  // The /max build checks real per-country patterns; the /min build (and the
  // default entry point) only check general length ranges and let through
  // e.g. an 8-digit +20 "mobile" that needs 10.
  let phoneE164 = null;
  let phoneBad = false;
  const region = (business && typeof business.country === 'string' && /^[A-Za-z]{2}$/.test(business.country)) ? business.country.toUpperCase() : 'US';
  try {
    if (!phone || !isValidPhoneNumber(phone, region)) phoneBad = true;
    else phoneE164 = parsePhoneNumber(phone, region).number;
  } catch { phoneBad = true; }
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

  let leadId;
  try {
    leadId = await insertLead({
      business_id: business.id,
      name, phone: phoneE164, email: email || null, zip, service, home, timing,
      roof_age: age, insurance_claim: b.claim === true,
      notes: notes || null, source: isForm ? 'form-nojs' : 'form', idempotency_key: idem,
    });
  } catch (e) {
    console.error('lead_insert_failed', (e && e.code) || 'no_code');
    return isForm ? htmlReply(500, 'Try again', 'Please try again shortly.', business.name) : res.status(500).json({ ok: false });
  }

  // Already stored under this key: say ok, notify nobody, write no second event.
  if (leadId === null) {
    return isForm ? htmlReply(200, 'Request received', 'We received your request.', business.name) : res.status(200).json({ ok: true });
  }

  try {
    await addEvent(leadId, 'created', { source: isForm ? 'form-nojs' : 'form', slug: business.slug });
  } catch (e) {
    console.error('lead_event_created_failed', (e && e.code) || 'no_code');
  }

  // Save first, notify second. Nothing below can change the response.
  await notifyAllAfterLead({
    leadId, business,
    lead: { name, phone: phoneE164, email, zip, service, home, timing, roof_age: age, insurance_claim: b.claim === true, notes },
  });

  return isForm ? htmlReply(200, 'Request received', 'We received your request.', business.name) : res.status(200).json({ ok: true });
}
