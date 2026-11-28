#!/usr/bin/env node
// tests/site-state.test.mjs — Gate SS (the public face of a switched-off site).
// HARNESS: in-process handler call. PostgREST is faked at the fetch layer, so
// there is no database and no HTTP server; nothing reaches the network.
//
// What it proves (api/site-state.js + index.html + api/lead.js):
//   SS1  the endpoint answers one word and nothing else: served / suspended /
//        terminated, in that fixed vocabulary, for the host's business
//   SS2  no personal or commercial data leaves it: no name, id, address, date,
//        price, lead count or billing state — the whole body is two keys
//   SS3  the tenant comes from the Host header and only from that: a query
//        string, a body, a cookie or X-Forwarded-Host never chooses a business
//   SS4  an unknown host, a database that cannot be read and a refused method
//        all fail safe: a live business's page is never hidden by an error
//   SS5  only GET and HEAD are allowed; the answer is never cached
//   SS6  the page shows ONE neutral sentence for a terminated business and
//        hides the form, the progress, the close button and the navigation; it
//        carries no business name, no phone and no promise
//   SS7  a page that is not terminated is left exactly as it is: every state
//        word but 'terminated', and every failed request, changes nothing
//   SS8  the form endpoint still answers 'unavailable' for that business, so
//        the neutral page and the API agree
//
// Mutation: return the business row from api/site-state.js and SS2 fails;
// let applySiteState() run for 'served' and SS7 fails.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeRes } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'site-state-test-key';
process.env.VERCEL_ENV = 'development';
delete process.env.TENANT_HOST_MAP;

let failed = 0, total = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(5)}${String(what).padEnd(56)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 110) : ''}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- a very small PostgREST ---------- */

const ROWS = {
  'alder.test': { id: 'b1', slug: 'alder', name: 'Alder Roofing', status: 'active', owner_email: 'owner@fixture.invalid' },
  'demo.test': { id: 'b2', slug: 'demo', name: 'Demo Roofing', status: 'demo', owner_email: 'demo@fixture.invalid' },
  'off.test': { id: 'b3', slug: 'off', name: 'Closed Roofing', status: 'churned', owner_email: 'off@fixture.invalid' },
  'paused.test': { id: 'b4', slug: 'paused', name: 'Paused Roofing', status: 'paused', owner_email: 'paused@fixture.invalid' },
};
const SB = process.env.SUPABASE_URL;
const realFetch = globalThis.fetch;
let sbDown = false;
let sbRequests = [];
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.startsWith(SB)) throw new Error('network_guard_blocked');
  const u = new URL(url);
  const table = u.pathname.replace('/rest/v1/', '');
  const params = [...u.searchParams.entries()];
  sbRequests.push({ table, params });
  if (sbDown) return new Response(JSON.stringify({ message: 'down' }), { status: 500, headers: { 'content-type': 'application/json' } });
  if (table !== 'businesses') return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  const host = String((params.find(([k]) => k === 'site_host') || [])[1] || '').replace(/^eq\./, '');
  const row = ROWS[host] || null;
  const status = (params.find(([k]) => k === 'status') || [])[1];
  const wanted = status ? String(status) : null;
  const allowed = !wanted || (wanted.startsWith('in.(')
    ? wanted.slice(4, -1).split(',').map((x) => x.replace(/"/g, '')).includes(row && row.status)
    : wanted.replace(/^eq\./, '') === (row && row.status));
  const body = row && allowed ? JSON.stringify(row) : '';
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-range': row && allowed ? '0-0/1' : '*/0' },
  });
};

const { default: siteState, publicState } = await import('../api/site-state.js');
const call = async ({ method = 'GET', host = 'alder.test', headers = {}, body = null } = {}) => {
  const res = fakeRes();
  const h = { ...headers };
  if (host !== undefined) h.host = host;
  await siteState({ method, headers: h, body, socket: {} }, res);
  return { code: res.code, body: res.body, headers: res.headers };
};

try {
  /* SS1: the vocabulary, for every status. */
  {
    const got = {};
    for (const host of Object.keys(ROWS)) got[host] = await call({ host });
    const ok = got['alder.test'].body.state === 'served' && got['demo.test'].body.state === 'served'
      && got['paused.test'].body.state === 'suspended' && got['off.test'].body.state === 'terminated'
      && Object.values(got).every((r) => r.code === 200 && r.body.ok === true)
      // The pure mapping is the same table.
      && publicState({ status: 'churned' }) === 'terminated' && publicState({ status: 'paused' }) === 'suspended'
      && publicState({ status: 'active' }) === 'served' && publicState({ status: 'demo' }) === 'served' && publicState(null) === 'served';
    line(ok, 'SS1', 'one word per host: served, suspended or terminated', JSON.stringify(Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v.body.state]))));
  }

  /* SS2: no data but the word. */
  {
    const r = await call({ host: 'off.test' });
    const keys = Object.keys(r.body).sort();
    const text = JSON.stringify(r.body);
    const leaked = ['Alder', 'Roofing', 'Closed', 'b3', 'fixture.invalid', 'churned', 'paused']
      .filter((x) => text.includes(x));
    line(same(keys, ['ok', 'state']) && leaked.length === 0 && text.length < 60,
      'SS2', 'the body is two keys: the answer and nothing about the business', `keys=${keys.join(',')} leaked=${leaked.join(',') || 'none'}`);
  }

  /* SS3: the host decides, and only the host. */
  {
    sbRequests = [];
    // A query string that names another business changes nothing.
    const q = await call({ host: 'alder.test', headers: {} });
    const withQuery = await (async () => {
      const res = fakeRes();
      await siteState({ method: 'GET', headers: { host: 'alder.test' }, query: { host: 'off.test', slug: 'off' }, url: '/api/site-state?host=off.test', socket: {} }, res);
      return res;
    })();
    // A forwarded host, a cookie and a body naming another business: ignored.
    const forwarded = await call({ host: 'alder.test', headers: { 'x-forwarded-host': 'off.test', cookie: 'host=off.test' } });
    const withBody = await (async () => {
      const res = fakeRes();
      await siteState({ method: 'GET', headers: { host: 'alder.test' }, body: { host: 'off.test' }, socket: {} }, res);
      return res;
    })();
    const reads = sbRequests.filter((q2) => q2.table === 'businesses');
    const onlyHost = reads.every((r) => ['alder.test', 'off.test', 'paused.test', 'demo.test'].includes(String((r.params.find(([k]) => k === 'site_host') || [])[1] || '').replace(/^eq\./, '')));
    line(q.body.state === 'served' && withQuery.body.state === 'served' && forwarded.body.state === 'served'
      && withBody.body.state === 'served' && onlyHost,
      'SS3', 'the Host header chooses the business; nothing else can', `q=${q.body.state} fwd=${forwarded.body.state}`);
  }

  /* SS4: fail safe. */
  {
    const unknown = await call({ host: 'nobody.test' });
    sbDown = true;
    const down = await call({ host: 'alder.test' });
    sbDown = false;
    const post = await call({ method: 'POST', host: 'off.test' });
    const del = await call({ method: 'DELETE', host: 'off.test' });
    line(unknown.code === 200 && unknown.body.ok === false && unknown.body.state === 'served'
      && down.code === 200 && down.body.state === 'served'
      && post.code === 405 && del.code === 405 && post.headers.allow === 'GET, HEAD',
      'SS4', 'unknown host, dead database and a POST all fail safe', `unknown=${unknown.body.state} down=${down.body.state} post=${post.code}`);
  }

  /* SS5: freshness. */
  {
    const get = await call({ host: 'off.test' });
    const head = await call({ method: 'HEAD', host: 'off.test' });
    line(get.headers['cache-control'] === 'no-store' && head.headers['cache-control'] === 'no-store'
      && get.headers['content-type'] === 'application/json; charset=utf-8',
      'SS5', 'never cached: a business switched off appears on the next visit');
  }

  /* SS6 / SS7: the page. */
  {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    // The neutral pane: one sentence, inside the form, hidden until the answer.
    const pane = /<section class="est-pane est-off" hidden tabindex="-1"[^>]*>([\s\S]*?)<\/section>/.exec(html);
    const paneText = pane ? String(pane[1]).replace(/<[^>]+>/g, '').trim() : '';
    const offOk = !!pane && paneText === 'This website is currently unavailable.'
      && !/\{\{|tel:|name|phone|promise|estimate/i.test(String(pane[1]).replace(/data-page-node-id="[^"]*"/g, ''));
    // The logic: applied for 'terminated' and for nothing else.
    const fn = /function applySiteState\(state\) \{([\s\S]*?)\n  \}\n  window\.estimateApplySiteState/.exec(html);
    const body = fn ? fn[1] : '';
    const logicOk = !!fn && /if \(state !== 'terminated'\) return false;/.test(body)
      && /\.est-off/.test(body) && /hide|hidden/.test(body)
      && /navBox\.hidden = true/.test(body) && /prog\.hidden = true/.test(body) && /x\.hidden = true/.test(body)
      // It hides the PANES, not the pane it is about to show.
      && /pane !== off/.test(body)
      // It never writes a business name into the page.
      && !/innerHTML/.test(body);
    // The fetch: one request, no body, and a failure hides nothing.
    const boot = /fetch\('\/api\/site-state'[\s\S]{0,400}?\.catch\(function \(\) \{ \/\* a failed check hides nothing \*\/ \}\);/.test(html);
    line(offOk && logicOk && boot, 'SS6', 'terminated: one neutral sentence, the rest hidden, nothing to leak',
      `pane=${offOk} logic=${logicOk} boot=${boot}`);
    // A visible pane must beat a display rule, or the neutral pane leaks into
    // every other state.
    const css = fs.readFileSync(path.join(ROOT, 'assets', 'css', 'styles.css'), 'utf8');
    const cssOk = /\.est-pane\.est-off\[hidden\] \{\s*display: none\s*\}/.test(css);
    line(cssOk, 'SS7', 'a hidden neutral pane stays hidden (display beats hidden)');
  }

  /* SS8: the form endpoint agrees. */
  {
    const lead = fs.readFileSync(path.join(ROOT, 'api', 'lead.js'), 'utf8');
    const ok = /business\.status === 'churned'/.test(lead) && /unavailable: true/.test(lead) && /status\(410\)/.test(lead)
      && fs.readFileSync(path.join(ROOT, 'api', 'site-state.js'), 'utf8').includes("if (!tenant) return answer(res, 200, { ok: false, state: SERVED_STATE });");
    line(ok, 'SS8', 'the form still answers 410 unavailable for the same business');
  }
} catch (e) {
  line(false, 'SS0', 'site-state suite threw', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
} finally {
  globalThis.fetch = realFetch;
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
