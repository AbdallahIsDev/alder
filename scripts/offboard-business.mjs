#!/usr/bin/env node
// scripts/offboard-business.mjs <slug> [--yes --confirm <slug>] [--i-know-this-is-prod]
//
// Removes one business and everything that belongs to it. Dry run by default.
//
//   npm run offboard -- alder-demo
//   npm run offboard -- alder-demo --yes --confirm alder-demo
//
// Order, because leads.business_id has no ON DELETE CASCADE:
//   1. lead_events / review_feedback / private.lead_financials for this business's leads
//   2. leads for this business
//   3. business_chats
//   4. bind_codes
//   5. the businesses row
// Step 1 is explicit even though the database cascades it from leads: the dry run
// has to be able to say what will go, and a failure part-way must be visible.
//
// Every statement filters by business_id or by the slug's id, so no other
// business is touched. Prints counts, table names and the slug only.

import { resolveTarget, connect, out, pad, fail, hasYes, confirmed, count } from './delete-lib.mjs';

const NAME = 'offboard-business';
const argv = process.argv.slice(2);
const slug = argv.find((a) => !a.startsWith('--'));
if (!slug) fail(`${NAME}: usage: offboard-business.mjs <slug> [--yes --confirm <slug>]`);
if (!/^[a-z0-9-]{2,60}$/.test(slug)) fail(`${NAME}: that does not look like a slug.`);

const { dsn, isProd } = resolveTarget(argv, { name: NAME });
const client = await connect(dsn);

out(`${NAME}`);
out(`${pad('target', 24)}${isProd ? 'PRODUCTION' : 'non-production'} database`);
out(`${pad('slug', 24)}${slug}`);
out('');

const found = await client.query('select id from public.businesses where slug = $1', [slug]);
if (!found.rows.length) {
  out('no business with that slug — nothing to do.');
  await client.end();
  process.exit(0);
}
const biz = found.rows[0].id;

const SCOPED = [
  ['public.lead_events', 'select count(*)::int from public.lead_events e join public.leads l on l.id = e.lead_id where l.business_id = $1'],
  ['public.review_feedback', 'select count(*)::int from public.review_feedback f join public.leads l on l.id = f.lead_id where l.business_id = $1'],
  ['private.lead_financials', 'select count(*)::int from private.lead_financials f join public.leads l on l.id = f.lead_id where l.business_id = $1'],
  ['public.leads', 'select count(*)::int from public.leads where business_id = $1'],
  ['public.business_chats', 'select count(*)::int from public.business_chats where business_id = $1'],
  ['public.bind_codes', 'select count(*)::int from public.bind_codes where business_id = $1'],
  ['public.businesses', 'select count(*)::int from public.businesses where id = $1'],
];

const counts = [];
for (const [label, sql] of SCOPED) counts.push([label, await count(client, sql, [biz])]);
const others = await count(client, 'select count(*)::int from public.businesses where id <> $1', [biz]);

out('rows that would be removed');
for (const [label, n] of counts) out(`  ${pad(label, 28)}${n}`);
out('');
out(`${pad('other businesses', 24)}${others} (untouched)`);
out('');

if (!hasYes(argv)) {
  out('dry run: nothing deleted. Re-run with --yes --confirm <slug>.');
  await client.end();
  process.exit(0);
}
if (!confirmed(argv, slug)) {
  out('refusing: --yes also needs --confirm <slug> with the same slug.');
  await client.end();
  process.exit(1);
}

try {
  await client.query('begin');
  await client.query('delete from public.lead_events e using public.leads l where l.id = e.lead_id and l.business_id = $1', [biz]);
  await client.query('delete from public.review_feedback f using public.leads l where l.id = f.lead_id and l.business_id = $1', [biz]);
  await client.query('delete from private.lead_financials f using public.leads l where l.id = f.lead_id and l.business_id = $1', [biz]);
  await client.query('delete from public.leads where business_id = $1', [biz]);
  await client.query('delete from public.business_chats where business_id = $1', [biz]);
  await client.query('delete from public.bind_codes where business_id = $1', [biz]);
  await client.query('delete from public.businesses where id = $1', [biz]);
  await client.query('commit');
} catch (e) {
  try { await client.query('rollback'); } catch {}
  fail(`${NAME}: rolled back (${e.code || 'error'}). Nothing was deleted.`);
}

let leftover = 0;
for (const [label, sql] of SCOPED) leftover += await count(client, sql, [biz]);
const othersAfter = await count(client, 'select count(*)::int from public.businesses where id <> $1', [biz]);
out(`deleted. rows left for this business=${leftover} other businesses=${othersAfter}`);
await client.end();
process.exit(leftover === 0 && othersAfter === others ? 0 : 1);
