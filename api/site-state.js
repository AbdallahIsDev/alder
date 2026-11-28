// api/site-state.js — the one public answer a page may ask for about ITS host.
//
// The page is one deployment serving many client hosts, so the only thing that
// decides which business a visitor is looking at is the Host header, through
// the same tenant selector api/lead.js uses (lib/tenant.js: Host and nothing
// else; body, query, cookies and X-Forwarded-Host never choose a tenant).
//
// This endpoint exists so a terminated business can show a neutral page
// without the browser ever holding the business row. It answers one question:
//
//   { ok: true, state: 'served' }       the page shows everything, as today
//   { ok: true, state: 'suspended' }    the page stays, the form is held
//   { ok: true, state: 'terminated' }   the website is not available
//
// `state` is one of three fixed words. No name, no id, no address, no date, no
// billing state and no lead count leaves this endpoint, and `no-store` keeps
// the answer fresh for a page that a business was switched off between visits.
//
// A host this deployment does not serve answers { ok: false } with 200 and the
// page keeps its ordinary behaviour; the form's own tenant check still refuses
// that host's submissions. A database that cannot be read answers 'served':
// a blip must never make a paying client's website look dead.

import { resolveTenant } from '../lib/tenant.js';

export const SERVED_STATE = 'served';
export const SUSPENDED_STATE = 'suspended';
export const TERMINATED_STATE = 'terminated';

/**
 * The state word for a business row: 'churned' is the column, \"terminated\" is
 * what a visitor may be told. The only place this mapping is written.
 */
export function publicState(business) {
  const status = String((business && business.status) || '');
  if (status === 'churned') return TERMINATED_STATE;
  if (status === 'paused') return SUSPENDED_STATE;
  return SERVED_STATE;
}

const answer = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  // res.status().json() is the shape every other endpoint here uses, and the
  // one the suite's fake response understands.
  if (typeof res.status === 'function' && typeof res.json === 'function') return res.status(status).json(body);
  res.end(JSON.stringify(body));
  return res;
};

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('allow', 'GET, HEAD');
    return answer(res, 405, { ok: false });
  }
  const tenant = await resolveTenant(req, { anyStatus: true });
  // resolveTenant answers null for an unknown host AND for an unreadable
  // database. Either way the page must not be hidden: the form still decides.
  if (!tenant) return answer(res, 200, { ok: false, state: SERVED_STATE });
  return answer(res, 200, { ok: true, state: publicState(tenant.business) });
}
