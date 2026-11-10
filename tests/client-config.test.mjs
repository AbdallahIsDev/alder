#!/usr/bin/env node
// tests/client-config.test.mjs — Gate C.
// HARNESS: runs build-static.js a few times into _debug/client-build. No network.
//
// What it proves:
//   C1  Alder's page is byte-identical to the build from origin/main (455245e)
//   C2  clients/example.json builds a different page with none of Alder's name,
//       phone or domain left in it
//   C3  a missing client file fails with one line and writes nothing
//   C4  invalid JSON fails with one line
//   C5  a missing key is named
//   C6  an unknown key is refused
//   C7  a copy key that collides with BIZ is refused
//
// Mutation: change one value in clients/alder.json and C1 fails. Put the phone
// back inline in index.html and C2 fails.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '_debug', 'client-build');

/* The build of origin/main (455245e), before any value moved into a data file. */
const BASELINE = '64fd608ff69a1055e0a57730c6adcb8d2afb8c6ed6ebc5f8759adbf8d0fc39b6';

let total = 0;
let failed = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(52)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};

const build = (args) => spawnSync(process.execPath, ['build-static.js', 'index.html', ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 120000,
});
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const outPath = (name) => path.join(OUT, name, 'index.html');

const tempClients = [];
const tempClient = (name, body) => {
  const file = path.join(ROOT, 'clients', name + '.json');
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  tempClients.push(file);
  return name;
};

try {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  /* C1 */
  const r1 = build(['--out', outPath('alder')]);
  const h1 = r1.status === 0 ? sha(outPath('alder')) : 'build-failed';
  line(h1 === BASELINE, 'C1', 'Alder is byte-identical to the origin/main build', `hash=${h1.slice(0, 12)}`);

  /* C2 */
  const r2 = build(['--client', 'example', '--out', outPath('example')]);
  const out = r2.status === 0 ? fs.readFileSync(outPath('example'), 'utf8') : '';
  const leaked = ['Alder Roofing', '(555) 018-4400', 'alder-roofing.vercel.app']
    .filter((v) => out.includes(v));
  line(r2.status === 0 && out.length > 0 && sha(outPath('example')) !== BASELINE && leaked.length === 0,
    'C2', 'a second client builds clean', `exit=${r2.status} leaked=${leaked.join('|') || 'none'}`);

  /* C3 */
  const r3 = build(['--client', 'no-such-client', '--out', outPath('missing')]);
  const e3 = String(r3.stderr || '').trim().split('\n').filter(Boolean);
  line(r3.status === 1 && e3.length === 1 && /clients\/no-such-client\.json not found/.test(e3[0])
    && !fs.existsSync(outPath('missing')), 'C3', 'a missing client file fails once and writes nothing',
    `exit=${r3.status} lines=${e3.length}`);

  /* C4 */
  const bad = tempClient('_t-badjson', '{ "biz": {');
  const r4 = build(['--client', bad, '--out', outPath('badjson')]);
  line(r4.status === 1 && /not valid JSON/.test(String(r4.stderr || '')), 'C4', 'invalid JSON fails with one line',
    `exit=${r4.status}`);

  /* C5 */
  const alder = JSON.parse(fs.readFileSync(path.join(ROOT, 'clients', 'alder.json'), 'utf8'));
  const missingKey = JSON.parse(JSON.stringify(alder));
  delete missingKey.biz.phone;
  const mk = tempClient('_t-missing', missingKey);
  const r5 = build(['--client', mk, '--out', outPath('missingkey')]);
  line(r5.status === 1 && /missing: phone/.test(String(r5.stderr || '')), 'C5', 'a missing key is named',
    `exit=${r5.status}`);

  /* C6 */
  const unknown = JSON.parse(JSON.stringify(alder));
  unknown.biz.nickname = 'x';
  const uk = tempClient('_t-unknown', unknown);
  const r6 = build(['--client', uk, '--out', outPath('unknownkey')]);
  line(r6.status === 1 && /unknown key\(s\): nickname/.test(String(r6.stderr || '')), 'C6', 'an unknown key is refused',
    `exit=${r6.status}`);

  /* C7 */
  const clash = JSON.parse(JSON.stringify(alder));
  clash.copy = { name: 'collides' };
  const ck = tempClient('_t-clash', clash);
  const r7 = build(['--client', ck, '--out', outPath('clash')]);
  line(r7.status === 1 && /collide with BIZ: name/.test(String(r7.stderr || '')), 'C7', 'a copy key cannot shadow BIZ',
    `exit=${r7.status}`);
} catch (e) {
  line(false, 'C0', 'client-config harness ran', e && e.message ? e.message.slice(0, 80) : 'threw');
} finally {
  for (const f of tempClients) { try { fs.rmSync(f, { force: true }); } catch {} }
  try { fs.rmSync(OUT, { recursive: true, force: true }); } catch {}
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
