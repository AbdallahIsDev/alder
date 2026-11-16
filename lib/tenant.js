// lib/tenant.js — the only public-request tenant selector.
// Host chooses a canonical site_host; body/query/cookies/X-Forwarded-Host never do.

import { getActiveBusinessByHost, getBusinessByHost } from './db.js';

export function normalizeHost(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()) return null;
  if (value.length > 254 || /[\s\/\\@?#,]/.test(value)) return null;
  let host = value.toLowerCase();
  const port = /:(\d{1,5})$/.exec(host);
  if (port) {
    if (Number(port[1]) > 65535) return null;
    host = host.slice(0, -port[0].length);
  }
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (!host || host.includes(':')) return null;
  const labels = host.split('.');
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return host;
}

/** Explicit canonical-host aliases for TEST and non-production previews only. */
function mappedHost(host) {
  // This production assertion is deliberate: mapping cannot be enabled there.
  if (process.env.VERCEL_ENV === 'production') return host;
  const allowed = process.env.TEST_ENV === '1'
    || process.env.VERCEL_ENV === 'development' || process.env.VERCEL_ENV === 'preview';
  if (!allowed || !process.env.TENANT_HOST_MAP) return host;
  try {
    const map = JSON.parse(process.env.TENANT_HOST_MAP);
    const mapped = map && !Array.isArray(map) && typeof map[host] === 'string' ? map[host] : null;
    return mapped ? normalizeHost(mapped) : host;
  } catch {
    return null; // malformed explicit configuration fails closed
  }
}

export function tenantSiteHost(req) {
  const host = normalizeHost(req && req.headers && req.headers.host);
  return host ? mappedHost(host) : null;
}

/**
 * Return { business } or null. No tenant is cached across warm invocations.
 *
 * By default only a business that is being served (demo, active) resolves:
 * the review page, the self-check and the digest must keep treating a
 * suspended or terminated business as absent. `anyStatus: true` is for the
 * lead endpoint alone: it resolves a suspended ('paused') and a terminated
 * ('churned') business too, with business.status, so the endpoint can hold
 * the lead or answer "unavailable" instead of a generic 404. The tenant still
 * comes from the Host header and from nothing else.
 */
export async function resolveTenant(req, { anyStatus = false } = {}) {
  const siteHost = tenantSiteHost(req);
  if (!siteHost) return null;
  try {
    const business = anyStatus ? await getBusinessByHost(siteHost) : await getActiveBusinessByHost(siteHost);
    return business ? { business } : null;
  } catch {
    return null;
  }
}
