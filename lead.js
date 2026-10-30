// Vercel serverless function: POST /api/lead
// Server-side checks for the estimate form. The browser checks are for convenience only; this is the real gate.
// Env vars (Vercel project settings): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//
// To connect the form, define this once in the page (before the form script runs), e.g. in a small script tag:
//   window.estimateDeliver = function (data) {
//     return fetch('/api/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
//       .then(function (r) { if (!r.ok) throw new Error('send failed'); });
//   };

const SERVICES = ['replacement', 'storm', 'repair', 'unsure'];
const HOMES = ['house', 'multi', 'commercial', 'other'];
const TIMINGS = ['asap', 'month', 'quarter', 'planning'];
const AGES = ['Under 10 years', '10 to 20 years', 'Over 20 years', 'Not sure'];

// Best-effort rate limit: ~3 per IP per hour. In-memory, so it resets on cold starts and is per instance.
// For a hard limit use Vercel KV / Upstash Redis (INCR + EXPIRE) or Vercel's WAF rate limiting.
const hits = new Map();
function limited(ip) {
  const now = Date.now(), hour = 3600 * 1000;
  const list = (hits.get(ip) || []).filter((t) => now - t < hour);
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 3;
}

const str = (v, max) => (typeof v === 'string' ? v.trim() : '');
const clean = (v) => String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');   // strip control characters, keep \n and \t

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }
  res.setHeader('Cache-Control', 'no-store');

  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (limited(ip)) return res.status(429).json({ ok: false });

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { return res.status(400).json({ ok: false }); } }
  if (!b || typeof b !== 'object') return res.status(400).json({ ok: false });

  // Bots: honeypot filled, or finished in under 2 s. Answer "ok" so they learn nothing, deliver nothing.
  if (str(b.website) || !(Number(b.elapsed) >= 2000)) return res.status(200).json({ ok: true });

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

  // Plain text on purpose: no parse_mode, so anything the customer typed (<a href=...>, *, _, etc.) is shown as text, never rendered.
  // If you ever switch to parse_mode "HTML", escape &, < and > in every customer value first.
  const text = [
    'New estimate request',
    'Service: ' + service,
    'Property: ' + home + ', ZIP ' + zip,
    'Roof age: ' + age,
    'Start: ' + timing + (b.claim === true ? ' (insurance claim)' : ''),
    'Name: ' + name,
    'Phone: ' + phone,
    email ? 'Email: ' + email : '',
    notes ? 'Notes: ' + notes : '',
  ].filter(Boolean).join('\n').slice(0, 4000);

  try {
    const r = await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
    if (!r.ok) return res.status(502).json({ ok: false });
  } catch { return res.status(502).json({ ok: false }); }

  return res.status(200).json({ ok: true });
};
