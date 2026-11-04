// Vercel serverless function behind /r/:token.
//
// GET  /r/:token      — review page (server-rendered, works with JS disabled)
// GET  /r/:token/go   — record the click, then 302 to the roofer's Google review URL
// POST /r/:token      — optional private rating; always 303 back to the page
//
// Review gating is banned. The Google button is rendered identically on every visit,
// before any rating and after every rating, and is never hidden, delayed, disabled or
// de-emphasised. A rating is never required for the link to work.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { getBusinessById, addEvent, hitRateLimit } from '../lib/db.js';
import { getLeadByReviewToken, getFeedback, upsertFeedback, markGoogleClicked } from '../lib/review-db.js';
import { reviewPage } from '../lib/content.js';
import { sendLowRatingAlert } from '../lib/notify.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOT_FOUND = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not found</title></head><body><p>Not found.</p></body></html>';

function notFound(res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(404).send(NOT_FOUND);
}

function tokenFrom(req) {
  const q = req.query || {};
  if (q.token) return String(q.token);
  // Fallback for runtimes that only expose the rewritten URL.
  const u = String(req.url || '');
  const m = /\/r\/([^/?]+)/.exec(u);
  return m ? decodeURIComponent(m[1]) : '';
}

function usableGoogleUrl(v) {
  return typeof v === 'string' && /^https:\/\//.test(v) && v !== '#' ? v : null;
}

function clientIp(req) {
  const first = (v) => String(v || '').split(',')[0].trim();
  return first(req.headers['x-real-ip']) || first(req.headers['x-vercel-forwarded-for'])
    || first(req.headers['x-forwarded-for']) || String((req.socket && req.socket.remoteAddress) || '');
}

/* A test-only hook, guarded by the .test-mode marker. It lets Gate D prove that a
   failed click write cannot stop the redirect. It never exists in a deployment. */
function forceWriteFailure(req) {
  const dev = !process.env.VERCEL_ENV || process.env.VERCEL_ENV === 'development';
  return dev && fs.existsSync(path.join(ROOT, '.test-mode')) && req.headers['x-review-force-fail'] === '1';
}

export default async function handler(req, res) {
  const token = tokenFrom(req);
  res.setHeader('Cache-Control', 'no-store');
  if (!token || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) return notFound(res);

  let lead;
  try { lead = await getLeadByReviewToken(token); } catch { lead = null; }
  if (!lead) return notFound(res);

  let business;
  try { business = await getBusinessById(lead.business_id); } catch { business = null; }
  if (!business) return notFound(res);
  const googleUrl = usableGoogleUrl(business.google_review_url);

  /* ---------- /go ---------- */
  if (req.query && req.query.go === '1') {
    // The click WRITE here is best effort: a failed write is logged and cannot block
    // the 302. The lead and business lookups above are NOT best effort — if they fail,
    // this handler never reaches this line and the visitor gets a 404 instead.
    const location = googleUrl || '/r/' + encodeURIComponent(token);
    try {
      if (forceWriteFailure(req)) throw new Error('forced');
      await markGoogleClicked(lead.id);
      await addEvent(lead.id, 'review_clicked', {});
    } catch (e) {
      console.error('review_click_write_failed', (e && e.code) || 'no_code');
    }
    res.setHeader('Location', location);
    return res.status(302).end();
  }

  /* ---------- POST rating ---------- */
  if (req.method === 'POST') {
    let b = req.body;
    if (typeof b === 'string') {
      try { b = Object.fromEntries(new URLSearchParams(b)); } catch { b = {}; }
    }
    if (!b || typeof b !== 'object') b = {};
    const stars = Number(b.stars);
    const comment = typeof b.comment === 'string' ? b.comment.slice(0, 1000) : '';
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
      res.setHeader('Location', '/r/' + encodeURIComponent(token));
      return res.status(303).end();
    }
    // Rate limit, fail open like the lead endpoint.
    const salt = process.env.IP_HASH_SALT || '';
    try {
      const key = createHash('sha256').update(clientIp(req) + salt).digest('hex');
      if (!(await hitRateLimit('review:' + key, 3600, 20))) {
        res.setHeader('Location', '/r/' + encodeURIComponent(token));
        return res.status(303).end();
      }
    } catch (e) {
      console.error('review_rate_limit_failed', (e && e.code) || 'no_code');
    }
    try { await upsertFeedback(lead.id, stars, comment); } catch (e) {
      console.error('review_feedback_write_failed', (e && e.code) || 'no_code');
    }
    try { await addEvent(lead.id, 'rating', { stars }); } catch (e) {
      console.error('review_rating_event_failed', (e && e.code) || 'no_code');
    }
    if (stars <= 2) {
      await sendLowRatingAlert({ business, lead: { name: lead.name, phone: lead.phone }, stars, comment });
    }
    res.setHeader('Location', '/r/' + encodeURIComponent(token));
    return res.status(303).end();
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end();
  }

  /* ---------- GET page ---------- */
  let rating = null;
  try { const f = await getFeedback(lead.id); rating = f && f.rating ? f.rating : null; } catch {}
  const page = reviewPage({ business, token, googleUrl, rating });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(page.html);
}
