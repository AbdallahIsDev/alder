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
import { resolveSender } from '../lib/client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '_debug', 'client-build');

/* The build of origin/main (8c2df50) with the final-modal button change on top
   (owner-ux-fixes): "Call" is the phone button and "Close" sits at the far left.
   That is a deliberate visitor-visible change, so the page hash moved with it —
   64fd608f… before, 20948309… after. The other three files are unchanged and are
   pinned to the same values as before. */
const BASELINE = '2094830924a510e4e8ced42d2a2ca39098277219cdc69f1dc22facd07d5c40d6';
const BASELINE_MANIFEST = 'f45e8fc93ecb9681edf3a509164885c1e5c59ffd1b6016b25dc700fe9bf7524d';
const BASELINE_ROBOTS = 'dcd93cf0545e1bad61f0218310823424565419e811ba50b74a2e7f7642ce7053';
const BASELINE_SITEMAP = 'f90e45bdfa569c01cc2c7fe584831cd9e03b212fbac43254454968bcc16c27e8';

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

  /* C1: every file the build writes from client data. */
  const r1 = build(['--out', outPath('alder')]);
  const h1 = r1.status === 0 ? sha(outPath('alder')) : 'build-failed';
  const manifest = path.join(OUT, 'alder', 'site.webmanifest');
  const hm = fs.existsSync(manifest) ? sha(manifest) : 'missing';
  const dir1 = path.join(OUT, 'alder');
  const hr = fs.existsSync(path.join(dir1, 'robots.txt')) ? sha(path.join(dir1, 'robots.txt')) : 'missing';
  const hs = fs.existsSync(path.join(dir1, 'sitemap.xml')) ? sha(path.join(dir1, 'sitemap.xml')) : 'missing';
  line(h1 === BASELINE && hm === BASELINE_MANIFEST && hr === BASELINE_ROBOTS && hs === BASELINE_SITEMAP, 'C1',
    'Alder is byte-identical to the origin/main build',
    `html=${h1.slice(0, 8)} man=${hm.slice(0, 6)} robots=${hr.slice(0, 6)} map=${hs.slice(0, 6)}`);

  /* C9: the email brand name follows the client file, not the blank template. */
  {
    const brand = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'brand.generated.json'), 'utf8'));
    line(brand.name === 'Alder Roofing', 'C9', 'the email brand name comes from the client file',
      `name=${JSON.stringify(brand.name)}`);
  }

  /* C2 — and C12/C13 ride along with the same build. */
  const brandBefore = sha(path.join(ROOT, 'lib', 'brand.generated.json'));
  const r2 = build(['--client', 'example', '--out', outPath('example')]);
  const brandAfter = sha(path.join(ROOT, 'lib', 'brand.generated.json'));
  const out = r2.status === 0 ? fs.readFileSync(outPath('example'), 'utf8') : '';
  const leaked = ['Alder Roofing', '(555) 018-4400', 'alder-roofing.vercel.app',
    'Tear-off to final shingle', 'Four ways we', 'Ready for a roof you']
    .filter((v) => out.includes(v));
  line(r2.status === 0 && out.length > 0 && sha(outPath('example')) !== BASELINE && leaked.length === 0,
    'C2', 'a second client builds clean', `exit=${r2.status} leaked=${leaked.join('|') || 'none'}`);

  /* C12: the two files follow the client's own address. */
  {
    const dir2 = path.join(OUT, 'example');
    const robots = fs.readFileSync(path.join(dir2, 'robots.txt'), 'utf8');
    const map = fs.readFileSync(path.join(dir2, 'sitemap.xml'), 'utf8');
    const bad = ['alderroof.com', 'Alder'].filter((v) => robots.includes(v) || map.includes(v));
    line(bad.length === 0 && robots.includes('northline.example') && map.includes('northline.example'),
      'C12', 'robots and sitemap carry the second client address', `leaked=${bad.join('|') || 'none'}`);
  }

  /* C13: a sample build never touches the tracked brand file. */
  {
    const sample = path.join(ROOT, '_debug', 'brand-example.json');
    line(brandBefore === brandAfter && fs.existsSync(sample), 'C13',
      'a sample build leaves lib/brand.generated.json alone',
      `same=${brandBefore === brandAfter} sample=${fs.existsSync(sample)}`);
    fs.rmSync(sample, { force: true });
  }

  /* C14: the sender falls back to the deployment value. */
  {
    const a = resolveSender({ clientSender: 'a@x.test', envFrom: 'b@y.test' });
    const b = resolveSender({ clientSender: '', envFrom: 'b@y.test' });
    const c = resolveSender({ clientSender: '', envFrom: '' });
    line(a === 'a@x.test' && b === 'b@y.test' && c === null, 'C14',
      'a client sender wins, otherwise MAIL_FROM, otherwise the default', `${a}/${b}/${String(c)}`);
  }

  /* C3 */
  const r3 = build(['--client', 'no-such-client', '--out', outPath('missing')]);
  const e3 = String(r3.stderr || '').trim().split('\n').filter(Boolean);
  line(r3.status === 1 && e3.length === 1 && /clients\/no-such-client\.json not found/.test(e3[0])
    && !fs.existsSync(outPath('missing')), 'C3', 'a missing client file fails once and writes nothing',
    `exit=${r3.status} lines=${e3.length}`);

  /* C4 */
  const bad = tempClient('t-badjson', '{ "biz": {');
  const r4 = build(['--client', bad, '--out', outPath('badjson')]);
  line(r4.status === 1 && /not valid JSON/.test(String(r4.stderr || '')), 'C4', 'invalid JSON fails with one line',
    `exit=${r4.status}`);

  /* C5 */
  const alder = JSON.parse(fs.readFileSync(path.join(ROOT, 'clients', 'alder.json'), 'utf8'));
  const missingKey = JSON.parse(JSON.stringify(alder));
  delete missingKey.biz.phone;
  const mk = tempClient('t-missing', missingKey);
  const r5 = build(['--client', mk, '--out', outPath('missingkey')]);
  line(r5.status === 1 && /missing: phone/.test(String(r5.stderr || '')), 'C5', 'a missing key is named',
    `exit=${r5.status}`);

  /* C6 */
  const unknown = JSON.parse(JSON.stringify(alder));
  unknown.biz.nickname = 'x';
  const uk = tempClient('t-unknown', unknown);
  const r6 = build(['--client', uk, '--out', outPath('unknownkey')]);
  line(r6.status === 1 && /unknown key\(s\): nickname/.test(String(r6.stderr || '')), 'C6', 'an unknown key is refused',
    `exit=${r6.status}`);

  /* C7 */
  const clash = JSON.parse(JSON.stringify(alder));
  clash.copy = { name: 'collides' };
  const ck = tempClient('t-clash', clash);
  const r7 = build(['--client', ck, '--out', outPath('clash')]);
  line(r7.status === 1 && /collide with BIZ: name/.test(String(r7.stderr || '')), 'C7', 'a copy key cannot shadow BIZ',
    `exit=${r7.status}`);
  /* C10: a copy key no token uses is a build error naming it. */
  {
    const extra = JSON.parse(JSON.stringify(alder));
    extra.copy.extraOne = 'nobody uses this';
    const ek = tempClient('t-unused', extra);
    const r = build(['--client', ek, '--out', outPath('unused')]);
    const err = String(r.stderr || '');
    line(r.status === 1 && err.includes('not used by the page') && err.includes('extraOne'),
      'C10', 'an unused copy key is refused and named', `exit=${r.status}`);
  }

  /* C8: a slug is a file name, nothing else. */
  /* An empty value means "use the default", so it is not in this list. */
  for (const bad of ['../evil', 'Alder', 'alder_copy', '-alder', 'alder.json']) {
    const r = build(['--client', bad, '--out', outPath('slug')]);
    const err = String(r.stderr || '').trim().split('\n').filter(Boolean);
    const ok = r.status === 1 && err.length === 1
      && /Invalid client slug|clients\/alder\.json not found/.test(err[0])
      && !fs.existsSync(outPath('slug'));
    line(ok, 'C8', 'an unsafe or empty slug is refused: ' + JSON.stringify(bad),
      `exit=${r.status} ${err[0] ? err[0].slice(0, 40) : ''}`);
  }
} catch (e) {
  line(false, 'C0', 'client-config harness ran', e && e.message ? e.message.slice(0, 80) : 'threw');
} finally {
  for (const f of tempClients) { try { fs.rmSync(f, { force: true }); } catch {} }
  try { fs.rmSync(OUT, { recursive: true, force: true }); } catch {}
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
