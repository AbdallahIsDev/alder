#!/usr/bin/env node
// scripts/sweep-demo-leads.mjs <slug> [--yes --confirm <slug>] [--i-know-this-is-prod]
//                                    [--before <iso>] [--include-suite] [--include-nojs]
//
// PROPOSAL — not run against production. Removes test debris from ONE business
// without touching anything a human interacted with.
//
// Dry run by default. Deleting needs --yes AND --confirm <slug> with the same
// slug. Refuses the database named in .env unless --i-know-this-is-prod.
//
// What counts as debris (all four must hold):
//   1. the lead belongs to <slug>'s business
//   2. created_at < the cutoff (--before, default: today 00:00 UTC)
//   3. review_token IS NULL — anything a roofer marked done is kept, because a
//      customer may hold that link
//   4. the idempotency key has a test shape:
//        canary-%            the runner's canary row, always safe
//        ^[0-9a-z]{8}-…      suite runs; needs --include-suite
//        form-%              server-minted no-JS key; needs --include-nojs,
//                            because a real no-JS visitor gets the same shape
//
// The page mints a UUID key (crypto.randomUUID), so a genuine submission is never
// matched by rule 4. Rows are deleted in child-first order, scoped by business_id
// and lead id; nothing outside the predicate is read for deletion.

import { resolveTarget, connect, out, pad, fail, hasYes, confirmed, count } from './delete-lib.mjs';

const NAME = 'sweep-demo-leads';
const argv = process.argv.slice(2);
const slug = argv.find((a) => !a.startsWith('--'));
if (!slug) fail(`${NAME}: usage: sweep-demo-leads.mjs <slug> [--yes --confirm <slug>]`);
if (!/^[a-z0-9-]{2,60}$/.test(slug)) fail(`${NAME}: that does not look like a slug.`);

const includeSuite = argv.includes('--include-suite');
const includeNojs = argv.includes('--include-nojs');
const bi = argv.indexOf('--before');
const before = bi > -1 ? argv[bi + 1] : new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
if (Number.isNaN(Date.parse(before))) fail(`${NAME}: --before is not a date.`);

const { dsn, isProd } = resolveTarget(argv, { name: NAME });
const client = await connect(dsn);

const found = await client.query('select id from public.businesses where slug = $1', [slug]);
if (!found.rows.length) {
  out('no business with that slug — nothing to do.');
  await client.end();
  process.exit(0);
}
const biz = found.rows[0].id;

const shapes = ["idempotency_key like 'canary-%'"];
// Suite runs mint '<8 base36>-<rest>'; 'measure-' is a one-off manual probe that
// has the same character. Both are opt-in because neither is a page-minted key.
if (includeSuite) shapes.push("(idempotency_key ~ '^[0-9a-z]{8}-' and idempotency_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-') or idempotency_key like 'measure-%'");
if (includeNojs) shapes.push("idempotency_key like 'form-%'");

const PREDICATE = `business_id = $1
  and created_at < $2
  and review_token is null
  and (${shapes.join(' or ')})`;

out(`${NAME}`);
out(`${pad('target', 24)}${isProd ? 'PRODUCTION' : 'non-production'} database`);
out(`${pad('slug', 24)}${slug}`);
out(`${pad('before', 24)}${before}`);
out(`${pad('shapes', 24)}canary${includeSuite ? ' + suite' : ''}${includeNojs ? ' + no-js' : ''}`);
out('');

const candidates = await client.query(
  `select id, idempotency_key from public.leads where ${PREDICATE}`, [biz, before],
);
const ids = candidates.rows.map((r) => r.id);

const byShape = {};
for (const r of candidates.rows) {
  const s = /^canary-/.test(r.idempotency_key) ? 'canary'
    : /^form-/.test(r.idempotency_key) ? 'no-js'
      : 'suite';
  byShape[s] = (byShape[s] || 0) + 1;
}

const kept = await count(client,
  `select count(*)::int from public.leads where business_id = $1 and id not in (
     select id from public.leads where ${PREDICATE})`, [biz, before]);

out('leads matching the debris predicate');
if (!ids.length) {
  out('  (none)');
} else {
  for (const [s, n] of Object.entries(byShape)) out(`  ${pad(s, 24)}${n}`);
}
out(`  ${pad('total', 24)}${ids.length}`);
out(`${pad('leads kept', 24)}${kept} (no token, or newer, or page-minted key)`);
out('');

if (ids.length) {
  const ev = await count(client, `select count(*)::int from public.lead_events where lead_id = any($1::uuid[])`, [ids]);
  const fb = await count(client, `select count(*)::int from public.review_feedback where lead_id = any($1::uuid[])`, [ids]);
  const lf = await count(client, `select count(*)::int from private.lead_financials where lead_id = any($1::uuid[])`, [ids]);
  out('rows that would be removed');
  out(`  ${pad('public.leads', 28)}${ids.length}`);
  out(`  ${pad('public.lead_events', 28)}${ev}`);
  out(`  ${pad('public.review_feedback', 28)}${fb}`);
  out(`  ${pad('private.lead_financials', 28)}${lf}`);
  out('');
}

if (!hasYes(argv)) {
  out('dry run: nothing deleted. Re-run with --yes --confirm <slug> and the same flags.');
  await client.end();
  process.exit(0);
}
if (!confirmed(argv, slug)) {
  out('refusing: --yes also needs --confirm <slug> with the same slug.');
  await client.end();
  process.exit(1);
}
if (!ids.length) {
  out('nothing to delete.');
  await client.end();
  process.exit(0);
}

try {
  await client.query('begin');
  await client.query('delete from public.lead_events where lead_id = any($1::uuid[])', [ids]);
  await client.query('delete from public.review_feedback where lead_id = any($1::uuid[])', [ids]);
  await client.query('delete from private.lead_financials where lead_id = any($1::uuid[])', [ids]);
  await client.query('delete from public.leads where id = any($1::uuid[])', [ids]);
  await client.query('commit');
} catch (e) {
  try { await client.query('rollback'); } catch {}
  fail(`${NAME}: rolled back (${e.code || 'error'}). Nothing was deleted.`);
}

const left = await count(client, `select count(*)::int from public.leads where ${PREDICATE}`, [biz, before]);
out(`deleted ${ids.length}. rows still matching the predicate: ${left}`);
await client.end();
process.exit(left === 0 ? 0 : 1);
