// Vercel serverless function: POST /api/lead
// Server-side checks for the estimate form. The browser checks are for convenience only; this is the real gate.
// Env vars (Vercel project settings): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, IP_HASH_SALT,
// TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//
// Nothing here logs a name, phone, email, note or raw IP. Failures are logged as codes only.

import { createHash } from 'node:crypto';
import { getActiveBusinessBySlug, insertLead, addEvent, hitRateLimit } from '../lib/db.js';
import { sendMessage } from '../lib/tg.js';

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

/* Plain text on purpose: no parse_mode, so anything the customer typed (<a href=...>, *, _, etc.)
   is shown as text, never rendered. If you ever switch to parse_mode "HTML", escape &, < and >
   in every customer value first. */
function telegramText(v, leadId) {
  const body = [
    'New estimate request',
    'Service: ' + v.service,
    'Property: ' + v.home + ', ZIP ' + v.zip,
    'Roof age: ' + v.age,
    'Start: ' + v.timing + (v.claim === true ? ' (insurance claim)' : ''),
    'Name: ' + v.name,
    'Phone: ' + v.phone,
    v.email ? 'Email: ' + v.email : '',
    v.notes ? 'Notes: ' + v.notes : '',
  ].filter(Boolean).join('\n').slice(0, 3900);
  return body + '\nLead ID: ' + String(leadId).slice(0, 8);
}

/* Routing is unchanged for this step: every alert goes to TELEGRAM_CHAT_ID.
   The transport moved to lib/tg.js, which owns the timeout, the plain-text rule,
   the dev-only base override and the .test-mode interlock. */
async function notify(text) {
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!chat) return { ok: false, status: 'missing_env' };
  return sendMessage(chat, text);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  res.setHeader('Cache-Control', 'no-store');

  const ctype = String(req.headers['content-type'] || '').toLowerCase();
  if (!ctype.startsWith('application/json')) return res.status(415).json({ ok: false });

  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_BODY) return res.status(413).json({ ok: false });

  let b = req.body;
  if (typeof b === 'string') {
    if (Buffer.byteLength(b) > MAX_BODY) return res.status(413).json({ ok: false });
    try { b = JSON.parse(b); } catch { return res.status(400).json({ ok: false }); }
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return res.status(400).json({ ok: false });

  // Bots: honeypot filled, or finished in under 2 s. Answer "ok" so they learn nothing, deliver nothing.
  // The log line names the reason only; nothing from the payload goes near it.
  if (str(b.website)) {
    console.warn('lead_dropped_honeypot');
    return res.status(200).json({ ok: true });
  }
  if (!(Number(b.elapsed) >= 2000)) {
    console.warn('lead_dropped_timing');
    return res.status(200).json({ ok: true });
  }

  // Reject anything the form does not send, so a typo in the payload fails loudly here.
  for (const k of Object.keys(b)) if (!ALLOWED.has(k)) return res.status(400).json({ ok: false });

  // Rate limit 1: per caller, keyed by a salted hash. The raw IP is never stored or logged.
  // Fail open: if the counter itself is unreachable, a real lead matters more than the cap.
  const ipHash = hashIp(clientIp(req));
  if (!ipHash) {
    console.error('lead_rate_limit_salt_missing');
    return res.status(500).json({ ok: false });
  }
  try {
    if (!(await hitRateLimit(ipHash, IP_LIMIT.window, IP_LIMIT.max))) return res.status(429).json({ ok: false });
  } catch (e) {
    console.error('lead_rate_limit_failed', (e && e.code) || 'no_code');
  }

  // Allow-lists and length caps (same limits as the form's maxlength).
  const service = str(b.service), home = str(b.home), timing = str(b.timing), age = str(b.age);
  const zip = str(b.zip), phone = clean(str(b.phone)), name = clean(str(b.name)), email = clean(str(b.email)), notes = clean(str(b.notes));
  const phoneDigits = phone.replace(/\D/g, '');
  const bad =
    !SERVICES.includes(service) || !HOMES.includes(home) || !TIMINGS.includes(timing) || !AGES.includes(age) ||
    !/^\d{5}$/.test(zip) ||
    !/^[+()\-.\s\d]{7,32}$/.test(phone) || phoneDigits.length < 7 || phoneDigits.length > 15 ||
    name.length < 2 || name.length > 80 ||
    email.length > 254 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ||
    notes.length > 2000;
  if (bad) return res.status(400).json({ ok: false });

  const slug = str(b.slug);
  if (!/^[a-z0-9-]{2,60}$/.test(slug)) return res.status(400).json({ ok: false });

  const idem = str(b.idempotencyKey);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(idem)) return res.status(400).json({ ok: false });

  let business;
  try {
    business = await getActiveBusinessBySlug(slug);
  } catch (e) {
    console.error('lead_business_lookup_failed', (e && e.code) || 'no_code');
    return res.status(500).json({ ok: false });
  }
  if (!business) return res.status(400).json({ ok: false });                  // unknown, paused or churned

  // Rate limit 2: per business, so one site cannot flood its own roofer. Also fails open.
  try {
    if (!(await hitRateLimit('biz:' + business.id, BIZ_LIMIT.window, BIZ_LIMIT.max))) {
      return res.status(429).json({ ok: false });
    }
  } catch (e) {
    console.error('lead_rate_limit_failed', (e && e.code) || 'no_code');
  }

  let leadId;
  try {
    leadId = await insertLead({
      business_id: business.id,
      name,
      phone,
      email: email || null,
      zip,
      service,
      home,
      timing,
      roof_age: age,
      insurance_claim: b.claim === true,
      notes: notes || null,
      source: 'form',
      idempotency_key: idem,
    });
  } catch (e) {
    console.error('lead_insert_failed', (e && e.code) || 'no_code');
    return res.status(500).json({ ok: false });
  }

  // Already stored under this key: say ok, notify nobody, write no second event.
  if (leadId === null) return res.status(200).json({ ok: true });

  try {
    await addEvent(leadId, 'created', { source: 'form', slug: business.slug });
  } catch (e) {
    console.error('lead_event_created_failed', (e && e.code) || 'no_code');
  }

  // The lead is saved at this point. Telegram is best effort: a failure never loses the lead.
  const tg = await notify(telegramText({ service, home, zip, age, timing, claim: b.claim === true, name, phone, email, notes }, leadId));
  try {
    await addEvent(leadId, tg.ok ? 'tg_sent' : 'tg_failed', tg.ok ? {} : { status: tg.status });
  } catch (e) {
    console.error('lead_event_tg_failed', (e && e.code) || 'no_code');
  }

  return res.status(200).json({ ok: true });
}
