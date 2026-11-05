// Vercel serverless function behind /r/:token.
//
// GET  /r/:token      — review page (server-rendered, works with JS disabled)
// GET  /r/:token/go   — record the click, then 302 to the roofer's Google review URL
// GET  /r/:token?s=N  — landing page for the review-request email (GET NEVER WRITES)
// GET  /r/:token?go=1 — same landing page without stars (GET NEVER WRITES)
// POST /r/:token      — optional private rating; always 303 back to the page.
//                        Also accepts go=1 to record the Google click mark sent by
//                        the landing page's JavaScript (a GET is never trusted to
//                        record anything: mail scanners open every link).
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
import { reviewPage, googleUrlAllowed } from '../lib/content.js';
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
  if (!googleUrlAllowed(googleUrl)) {
    console.error('review_google_url_invalid');
  }

  /* ---------- GET rating page: one interactive page for every entry point.
     Legacy ?s=N, ?go=1 and /r/<token>/go (mapped to go=1 by the rewrite) render
     this same page. A GET never writes; only the page's POST (below) records. */
  if (req.method === 'GET') {
    const n = req.query && req.query.s === undefined ? 0 : Number(req.query.s);
    const stars = Number.isInteger(n) && n >= 1 && n <= 5 ? n : 0;
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    const page = reviewPage({ business, token, googleUrl, stars });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(page.html);
  }

  /* ---------- POST rating (and go=1 click mark from the rating page) ----------
     The landing page's own JS sends go=1 before it redirects. A POST carrying
     go=1 records the click mark; a POST carrying a valid stars writes the rating.
     Either may be absent, and a POST with neither writes nothing. */
  if (req.method === 'POST') {
    let b = req.body;
    if (typeof b === 'string') {
      try { b = Object.fromEntries(new URLSearchParams(b)); } catch { b = {}; }
    }
    if (!b || typeof b !== 'object') b = {};
    const stars = Number(b.stars);
    const comment = typeof b.comment === 'string' ? b.comment.slice(0, 1000) : '';
    const hasStars = Number.isInteger(stars) && stars >= 1 && stars <= 5;
    const hasGo = b.go === '1' || b.go === 1;

    if (hasGo) {
      try { await markGoogleClicked(lead.id); } catch (e) {
        console.error('review_click_write_failed', (e && e.code) || 'no_code');
      }
      try { await addEvent(lead.id, 'review_clicked', {}); } catch (e) {
        console.error('review_click_event_failed', (e && e.code) || 'no_code');
      }
    }
    if (!hasStars) {
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
    // Read the stored rating BEFORE the upsert. The owner is alerted only when the
    // rating MOVES into the 1-2 range: no previous rating, or a previous rating of 3
    // or more. A repeat low rating never alerts twice. If this read fails, previous
    // counts as "no previous rating" and the alert may fire again.
    let previous = null;
    try { const f = await getFeedback(lead.id); previous = f && f.rating ? f.rating : null; } catch (e) {
      console.error('review_prev_rating_failed', (e && e.code) || 'no_code');
    }
    try { await upsertFeedback(lead.id, stars, comment); } catch (e) {
      console.error('review_feedback_write_failed', (e && e.code) || 'no_code');
    }
    try { await addEvent(lead.id, 'rating', { stars }); } catch (e) {
      console.error('review_rating_event_failed', (e && e.code) || 'no_code');
    }
    if (stars <= 2 && (previous === null || previous >= 3)) {
      await sendLowRatingAlert({ business, lead: { name: lead.name, phone: lead.phone }, stars, comment });
    }
    res.setHeader('Location', '/r/' + encodeURIComponent(token));
    return res.status(303).end();
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).end();
}
