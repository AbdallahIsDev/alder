#!/usr/bin/env node
// tests/db-wall-guard.test.mjs — Gate W.
// HARNESS: one local HTTP server that answers like PostgREST. No database.
//
// What it proves:
//   W1  a permission denial (403 / 42501) counts as proof the wall holds
//   W2  an invalid or retired key (401 "Invalid API key") does NOT — it fails
//   W3  an empty 200 counts (RLS filters rows instead of erroring)
//   W4  a network failure does NOT count
//   W5  an unrecognised error does NOT count
//
// WHY. `!!error` used to be the pass condition, so a retired key turned the whole
// suite green while proving nothing. The classifier is what makes the difference.
//
// Mutation: make classifyAnonDenial return 'rls' for everything and W2/W5 fail.

import http from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { classifyAnonDenial, isWallProof, isSchemaProof, DENIAL } from './denial.mjs';

let total = 0;
let failed = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(52)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};

const server = http.createServer((req, res) => {
  const url = String(req.url || '');
  const send = (code, body, headers = {}) => {
    res.writeHead(code, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  if (url.includes('/denied')) return send(403, { code: '42501', message: 'permission denied for table denied' });
  if (url.includes('/badkey')) return send(401, { message: 'Invalid API key' });
  if (url.includes('/empty')) {
    res.writeHead(200, { 'content-type': 'application/json', 'content-range': '*/0' });
    return res.end('[]');
  }
  // The schema is an Accept-Profile header, not a path segment.
  if (String(req.headers['accept-profile'] || '') === 'private') {
    return send(406, { code: 'PGRST106', message: 'The schema must be one of the following: public' });
  }
  if (url.includes('/boom')) return send(500, { message: 'boom' });
  return send(404, { message: 'not found' });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const client = createClient(`http://127.0.0.1:${port}`, 'fake-key', opts);

try {
  {
    const { data, error } = await client.from('denied').select('*').limit(1);
    line(classifyAnonDenial(error) === DENIAL.RLS && isWallProof({ error, rows: data }), 'W1',
      'permission denial counts as proof', `verdict=${classifyAnonDenial(error)} code=${error && error.code}`);
  }
  {
    const { data, error } = await client.from('badkey').select('*').limit(1);
    line(classifyAnonDenial(error) === DENIAL.INVALID_KEY && !isWallProof({ error, rows: data }), 'W2',
      'a rejected key is a failure, not a pass', `verdict=${classifyAnonDenial(error)}`);
  }
  {
    const { data, error } = await client.from('empty').select('*').limit(1);
    line(!error && isWallProof({ error, rows: data }), 'W3',
      'an empty 200 counts as proof', `rows=${data ? data.length : 'null'} err=${error ? 'yes' : 'no'}`);
  }
  {
    const dead = createClient('http://127.0.0.1:9', 'fake-key', opts);
    const { data, error } = await dead.from('leads').select('*').limit(1);
    line(!isWallProof({ error, rows: data }) && classifyAnonDenial(error) === DENIAL.NETWORK, 'W4',
      'a network failure is a failure', `verdict=${classifyAnonDenial(error)}`);
  }
  {
    const { data, error } = await client.from('boom').select('*').limit(1);
    line(!isWallProof({ error, rows: data }) && classifyAnonDenial(error) === DENIAL.UNKNOWN, 'W5',
      'an unrecognised error is a failure', `verdict=${classifyAnonDenial(error)}`);
  }
  {
    /* A schema the API does not expose is its own proof — and must not be
       accepted as proof for a table. */
    const { data, error } = await client.schema('private').from('lead_financials').select('*').limit(1);
    line(classifyAnonDenial(error) === DENIAL.SCHEMA && isSchemaProof({ error }) && !isWallProof({ error, rows: data }),
      'W6', 'a refused schema is proof, but not for a table', `verdict=${classifyAnonDenial(error)}`);
  }
} finally {
  server.close();
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
