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

/* The build of origin/main (fa6030d) with the CSS moved out of the page and
   linked root-absolute (visual-polish): the <style> block is gone and a <link>
   takes its place, so the page hash moved — 20948309… before, 23af892b… with a
   relative href, be79571b… with /assets/css/styles.css.

   lead-safety moved it to aa71755b… with the bounded form retry. This review
   moves it aa71755bf242ae8a7a9af32833d29bb52abfe5731e74ee05a3069a40ef4d20d5
   -> 80d6281c5d4a333db88b411d749b2acc42801b49ddb7c849f2731fa4c9cddbef
   (index.html only): the timeout rationale now matches maxDuration 30, and an
   in-page duplicate hides unsent edited recap values. The other three output
   hashes below are unchanged and prove no other client-data output changed.

   The lifecycle round moves it 80d6281c… -> 27a08c72… (index.html and
   clients/alder.json): the form has a panel for a held request and for an
   unavailable business; its four service options and the no-JS form print
   the services section's own keys (the 4th is "Free roof inspection", with
   the new copy key footer12); the dimmed area no longer closes the form.
   The manifest, robots and sitemap hashes are unchanged.

   The modal round moves it 27a08c72… -> 193536b8… (index.html and
   assets/css/styles.css): the thank-you screen is three groups instead of five
   siblings, its three "what happens next" lines are one line each at 320px, the
   held state really hides the recap and the next steps, the answers survive a
   close in sessionStorage, and the form may invite itself once per session.
   The manifest, robots and sitemap hashes are unchanged.

   The radius rounds move the HTML to e9dccc4d… (permanent 12 px scale,
   sitewide radius rule, CTA corners, back-to-top ring, no DEV radius row).
   Before 2026-11-26 this assertion pinned the origin/main build 193536b8…;
   after it pins this branch's build. Cost: an accidental HTML edit still fails
   until the baseline is moved deliberately. */
// 2026-11-28: moved deliberately for the site-lifecycle round (Parts 4-5:
// the neutral sentence for a terminated host, the estimate form's one border
// and the draft/focus rules). The manifest, robots and sitemap hashes below
// did not move.
const BASELINE = '1b9229150d23aa463af9b3c4986c4c7d63dac1a3ad2f145fe21ff982663bb9b6';
const BASELINE_MANIFEST = 'f45e8fc93ecb9681edf3a509164885c1e5c59ffd1b6016b25dc700fe9bf7524d';
const BASELINE_ROBOTS = '9a24e9a883cd788ab55016368f3afe111de0bc812a2ab16b2c96b1c80a2efdaf';
const BASELINE_SITEMAP = '2a79589d7992a9780b47c810763ef32c364aae607dc6f0c393f97c7ed63bc244';

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

  /* C17: the demo client's only production host is the deployment alias.
     Canonical, OG, data-prod-host, robots and sitemap must all use it; a host
     that does not resolve must appear nowhere in a generated file. */
  {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'clients', 'alder.json'), 'utf8'));
    const host = 'alder-roofing.vercel.app';
    const out = fs.readFileSync(outPath('alder'), 'utf8');
    const robots = fs.readFileSync(path.join(OUT, 'alder', 'robots.txt'), 'utf8');
    const map = fs.readFileSync(path.join(OUT, 'alder', 'sitemap.xml'), 'utf8');
    const files = [out, robots, map];
    const expected = [
      'rel="canonical" href="https://' + host + '/"',
      'data-prod-host="' + host + '"',
      'data-prod-vercel-host="' + host + '"',
    ];
    const stale = ['alderroof.com', 'www.alderroof.com'].filter((v) => files.some((f) => f.includes(v)));
    const ok = cfg.domain === 'https://' + host && cfg.vercelProdHost === host
      && expected.every((v) => out.includes(v)) && robots.includes(host) && map.includes(host)
      && stale.length === 0;
    line(ok, 'C17', 'demo client generates only the real Vercel host',
      `cfg=${cfg.domain} expected=${expected.filter((v) => out.includes(v)).length}/${expected.length} stale=${stale.join('|') || 'none'}`);
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
    const bad = ['alder-roofing.vercel.app', 'Alder'].filter((v) => robots.includes(v) || map.includes(v));
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

  /* C15: the DEV gate's production host is baked from the client domain, not
     left empty or as a placeholder token. */
  {
    const hostOf = (name) => {
      const m = /data-prod-host="([^"]*)"/.exec(fs.readFileSync(outPath(name), 'utf8'));
      return m ? m[1] : '';
    };
    const aliasOf = (name) => {
      const m = /data-prod-vercel-host="([^"]*)"/.exec(fs.readFileSync(outPath(name), 'utf8'));
      return m ? m[1] : '';
    };
    const alderHost = hostOf('alder'), exampleHost = hostOf('example');
    const alias = aliasOf('alder');
    const ok = /^[a-z0-9.-]+$/.test(alderHost) && /^[a-z0-9.-]+$/.test(exampleHost)
      && alderHost !== exampleHost && /^[a-z0-9.-]+$/.test(alias);
    line(ok, 'C15', 'build bakes real production hosts for each client',
      `alder=${alderHost || '(empty)'} example=${exampleHost || '(empty)'} alias=${alias || '(empty)'}`);
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

  /* C16: a client without a Vercel production alias cannot build. */
  {
    const noAlias = JSON.parse(JSON.stringify(alder));
    delete noAlias.vercelProdHost;
    const mk = tempClient('t-no-alias', noAlias);
    const r = build(['--client', mk, '--out', outPath('noalias')]);
    line(r.status === 1 && /vercelProdHost/.test(String(r.stderr || '')) && !fs.existsSync(outPath('noalias')),
      'C16', 'a client without vercelProdHost is refused', `exit=${r.status}`);
  }

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
