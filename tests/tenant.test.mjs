#!/usr/bin/env node
// DB-free tenant parsing and environment-gate checks.
import { normalizeHost, tenantSiteHost } from '../lib/tenant.js';

let total = 0, failed = 0;
function line(ok, id, text) { total++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${text}`); }
const good = [
  ['Example.COM:443', 'example.com'], ['roof.example.', 'roof.example'],
  ['localhost:3000', 'localhost'], ['127.0.0.1:3000', '127.0.0.1'],
];
line(good.every(([raw, want]) => normalizeHost(raw) === want), 'T1', 'lowercase, strip port and trailing root dot');
const bad = [undefined, '', ' example.com', 'example.com ', 'example.com/path', 'example.com,other.test',
  'user@example.com', 'example.com:abc', 'example.com:65536', '[::1]:3000', '-bad.example', 'bad_.example', 'a..example'];
line(bad.every((raw) => normalizeHost(raw) === null), 'T2', 'missing and malformed Host values fail closed');

const saved = { env: process.env.VERCEL_ENV, test: process.env.TEST_ENV, map: process.env.TENANT_HOST_MAP };
try {
  process.env.TENANT_HOST_MAP = JSON.stringify({ 'preview.example': 'canonical.test' });
  process.env.VERCEL_ENV = 'preview'; delete process.env.TEST_ENV;
  line(tenantSiteHost({ headers: { host: 'preview.example:443' } }) === 'canonical.test', 'T3', 'preview alias maps to canonical site_host');
  process.env.VERCEL_ENV = 'production';
  line(tenantSiteHost({ headers: { host: 'preview.example' } }) === 'preview.example', 'T4', 'production ignores alias configuration');
  process.env.VERCEL_ENV = 'development';
  line(tenantSiteHost({ headers: { host: 'canonical.test', 'x-forwarded-host': 'other.test' } }) === 'canonical.test', 'T5', 'X-Forwarded-Host is not a selector');
  process.env.TENANT_HOST_MAP = '{bad json';
  line(tenantSiteHost({ headers: { host: 'preview.example' } }) === null, 'T6', 'malformed alias configuration fails closed');
} finally {
  for (const [key, name] of [['env', 'VERCEL_ENV'], ['test', 'TEST_ENV'], ['map', 'TENANT_HOST_MAP']]) {
    if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key];
  }
}
console.log(`\n${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
