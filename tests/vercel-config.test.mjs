#!/usr/bin/env node
// tests/vercel-config.test.mjs — Gate V.
// HARNESS: in-process, no network. Parses vercel.json only.
//
// What it proves:
//   V1  git.deploymentEnabled exists and the only branch enabled is main
//   V2  a branch name resolves the way Vercel resolves it: a branch matching a
//       true rule deploys, a branch matching no rule deploys by default, and
//       'main-preview' must not match 'main'.
//   V2b a partial config proves the no-rule default without touching the real one
//   V3  the keys that were already in vercel.json are still there and intact
//   V4  api/lead.js and api/tg.js declare maxDuration 10 (the Hobby default as
//       the branch author understood it - NOT VERIFIED against the provider's
//       current docs, so the value is the conservative one) and every function
//       entry still carries the brand includeFiles
//
// The matcher below models the documented behaviour (minimatch patterns, a
// branch matching a true rule deploys, no match deploys by default). The config
// uses '**' and an exact name, so the model is unambiguous here — this is not a
// minimatch clone.
//
// Mutation: delete the "main": true entry and V1/V2 fail; put '*' back instead of
// '**' and the feature/hero-copy case fails, because '*' does not cross a slash.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

let failed = 0;
let total = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(52)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};

/** minimatch subset: ** crosses '/', * does not, ? is one non-slash char. */
function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') { out += '.*'; i++; } else { out += '[^/]*'; }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * True when `branch` deploys under this deploymentEnabled map, using Vercel's
 * documented rule: a branch matching at least one rule deploys when any matching
 * rule is true; a branch matching NO rule deploys by default.
 */
function deploys(enabled, branch) {
  const matching = Object.entries(enabled || {}).filter(([p]) => globToRegExp(p).test(branch));
  if (!matching.length) return true;
  return matching.some(([, value]) => value === true);
}

const enabled = (CONFIG.git && CONFIG.git.deploymentEnabled) || null;

/* V1: the block is there, main is the only true rule, and at least one rule
   turns the rest off. Which glob does that is V2's business. */
{
  const trues = enabled ? Object.keys(enabled).filter((k) => enabled[k] === true) : [];
  const falses = enabled ? Object.keys(enabled).filter((k) => enabled[k] === false) : [];
  const ok = !!enabled && trues.join(',') === 'main' && falses.length >= 1;
  line(ok, 'V1', 'deploymentEnabled: only main is enabled',
    enabled ? `true=${trues.join(',') || 'none'} false=${falses.join(',') || 'none'}` : 'git.deploymentEnabled missing');
}

/* V2: resolution, including the slash and prefix traps. */
{
  const cases = [
    ['main', true],
    ['feature/hero-copy', false],
    ['a/b/c', false],
    ['main-preview', false],
    ['operator-redirects', false],
    ['vercel-storage', false],
  ];
  const bad = enabled ? cases.filter(([b, want]) => deploys(enabled, b) !== want) : cases.map(([b]) => b);
  line(!!enabled && bad.length === 0, 'V2', 'a branch deploys only when a true rule matches',
    bad.length ? `wrong: ${bad.join(',')}` : `${cases.length} branches resolve`);
}

/* V2b: a config that matches only some branches still deploys the rest. This
   object exists only inside the test; the real config must match everything. */
{
  const partial = { main: true };
  const ok = deploys(partial, 'feature/hero-copy') === true
    && deploys(partial, 'a/b/c') === true
    && deploys(partial, 'main') === true;
  line(ok, 'V2b', 'a branch matching no rule deploys by default',
    `partial=${JSON.stringify(partial)}`);
}

/* V3: nothing that was already in the file was changed. */
{
  const ok = CONFIG.buildCommand === 'node build-static.js index.html --out dist/index.html'
    && CONFIG.outputDirectory === 'dist'
    && CONFIG.functions && CONFIG.functions['api/*.js']
    && CONFIG.functions['api/*.js'].includeFiles === 'lib/brand.generated.json'
    && Array.isArray(CONFIG.rewrites) && CONFIG.rewrites.length === 2
    && Array.isArray(CONFIG.crons) && CONFIG.crons.length === 2
    && Array.isArray(CONFIG.headers) && CONFIG.headers.length >= 4;
  line(ok, 'V3', 'existing keys are intact',
    `rewrites=${(CONFIG.rewrites || []).length} crons=${(CONFIG.crons || []).length} headers=${(CONFIG.headers || []).length}`);
}

/* V4: the two functions that send alerts declare a maxDuration the Hobby plan is
   understood to allow (10 s, the plan default). NOT VERIFIED: this repository
   contains no copy of the provider's limit, so the owner must confirm the current
   maximum in the Vercel dashboard before raising it. Nothing else in `functions`
   changed:
   every key keeps includeFiles. A number, not a string: a string is rejected at
   deploy time, which is exactly the kind of mistake this catches before a push. */
{
  const lead = CONFIG.functions && CONFIG.functions['api/lead.js'];
  const tg = CONFIG.functions && CONFIG.functions['api/tg.js'];
  const allInclude = Object.values(CONFIG.functions || {})
    .every((f) => f && f.includeFiles === 'lib/brand.generated.json');
  const ok = !!lead && !!tg
    && lead.maxDuration === 10 && tg.maxDuration === 10
    && Number.isInteger(lead.maxDuration) && Number.isInteger(tg.maxDuration)
    && allInclude;
  line(ok, 'V4', 'lead and tg: maxDuration 10, every function keeps includeFiles',
    `lead=${lead && lead.maxDuration} tg=${tg && tg.maxDuration} includeFiles=${allInclude}`);
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
