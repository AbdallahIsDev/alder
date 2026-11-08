#!/usr/bin/env node
// scripts/send-test-lead.mjs <slug> --email <addr> --phone <number> --yes [--url <origin>]
//
// Submits ONE clearly labelled test lead through the REAL deployed endpoint, so
// the owner can watch the whole path with a second account: the Telegram alert,
// the owner email, the customer auto-reply (once MAIL_REDIRECT_TO is off).
//
// No default email and no default phone: the auto-reply goes to --email, and a
// placeholder address would mail a stranger. Both are required.
//
// Prints the HTTP status and the lead id (8 chars). Nothing else.

import { loadEnv } from '../lib/env.js';

loadEnv();

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : null; };
const slug = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--email' && argv[argv.indexOf(a) - 1] !== '--phone' && argv[argv.indexOf(a) - 1] !== '--url');

function fail(msg) { console.error('test-lead: ' + msg); process.exit(1); }

if (!slug) fail('usage: send-test-lead.mjs <slug> --email <addr> --phone <number> --yes [--url <origin>]');
if (!/^[a-z0-9-]{2,60}$/.test(slug)) fail('that does not look like a slug');
if (!has('--yes')) fail('refusing to submit without --yes (it sends a real email)');
const email = val('--email');
const phone = val('--phone');
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('--email is required and must look like an address');
if (!phone || phone.replace(/\D/g, '').length < 7) fail('--phone is required and must look like a phone number');

const origin = (val('--url') || process.env.SITE_URL || '').replace(/\/+$/, '');
if (!origin) fail('no --url and no SITE_URL');

const key = 'manual-test-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
const body = {
  service: 'repair', home: 'house', timing: 'asap', age: 'Not sure', zip: '50265',
  phone, name: 'Test Lead 1', email, notes: 'manual test lead', claim: false, website: '',
  elapsed: 5000, slug, idempotencyKey: key,
};

let res, json = null;
try {
  res = await fetch(origin + '/api/lead', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  json = await res.json().catch(() => null);
} catch (e) {
  fail('request failed (' + ((e && e.name) || 'error') + ')');
}

const id = json && typeof json.id === 'string' ? json.id.slice(0, 8) : '(none)';
console.log('status ' + res.status);
console.log('lead   ' + id);
if (json && json.duplicate) console.log('note   duplicate: an earlier lead matched this phone or email');
