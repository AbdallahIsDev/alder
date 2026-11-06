#!/usr/bin/env node
// scripts/delete-lead.mjs <lead-id> [--yes --confirm <lead-id>] [--i-know-this-is-prod]
//
// Deletes one lead and everything hanging off it. Dry run by default.
//
//   npm run delete:lead -- 3f2a…            # counts only, deletes nothing
//   npm run delete:lead -- 3f2a… --yes --confirm 3f2a…
//
// Order: lead_events, review_feedback, private.lead_financials, then leads.
// The database would cascade all three from leads; deleting them explicitly
// means a failure part-way is visible instead of silent, and the dry run can
// tell you exactly what will go.
//
// Prints counts and table names only. Never a name, phone, email or note.

import { resolveTarget, connect, out, pad, fail, hasYes, confirmed, count } from './delete-lib.mjs';

const NAME = 'delete-lead';
const argv = process.argv.slice(2);
const leadId = argv.find((a) => !a.startsWith('--'));
if (!leadId) fail(`${NAME}: usage: delete-lead.mjs <lead-id> [--yes --confirm <lead-id>]`);
if (!/^[0-9a-f-]{36}$/i.test(leadId)) fail(`${NAME}: that does not look like a lead id.`);

const { dsn, isProd } = resolveTarget(argv, { name: NAME });
const client = await connect(dsn);

const CHILDREN = [
  ['public.lead_events', 'select count(*)::int from public.lead_events where lead_id = $1'],
  ['public.review_feedback', 'select count(*)::int from public.review_feedback where lead_id = $1'],
  ['private.lead_financials', 'select count(*)::int from private.lead_financials where lead_id = $1'],
];

out(`${NAME}`);
out(`${pad('target', 24)}${isProd ? 'PRODUCTION' : 'non-production'} database`);
out(`${pad('lead', 24)}${leadId}`);
out('');

const exists = await count(client, 'select count(*)::int from public.leads where id = $1', [leadId]);
if (!exists) {
  out('no lead with that id — nothing to do.');
  await client.end();
  process.exit(0);
}

const counts = [];
for (const [label, sql] of CHILDREN) counts.push([label, await count(client, sql, [leadId])]);
const businessId = (await client.query('select business_id from public.leads where id = $1', [leadId])).rows[0].business_id;

out('rows that would be removed');
for (const [label, n] of counts) out(`  ${pad(label, 28)}${n}`);
out(`  ${pad('public.leads', 28)}1`);
out('');
out(`${pad('business', 24)}${businessId}`);
out(`${pad('other rows', 24)}untouched (every statement is scoped to this lead)`);
out('');

if (!hasYes(argv)) {
  out('dry run: nothing deleted. Re-run with --yes --confirm <lead-id>.');
  await client.end();
  process.exit(0);
}
if (!confirmed(argv, leadId)) {
  out('refusing: --yes also needs --confirm <lead-id> with the same id.');
  await client.end();
  process.exit(1);
}

try {
  await client.query('begin');
  await client.query('delete from public.lead_events where lead_id = $1', [leadId]);
  await client.query('delete from public.review_feedback where lead_id = $1', [leadId]);
  await client.query('delete from private.lead_financials where lead_id = $1', [leadId]);
  await client.query('delete from public.leads where id = $1', [leadId]);
  await client.query('commit');
} catch (e) {
  try { await client.query('rollback'); } catch {}
  fail(`${NAME}: rolled back (${e.code || 'error'}). Nothing was deleted.`);
}

let leftover = 0;
for (const [label, sql] of CHILDREN) leftover += await count(client, sql, [leadId]);
const stillThere = await count(client, 'select count(*)::int from public.leads where id = $1', [leadId]);
out(`deleted. leads=${stillThere} child rows left=${leftover}`);
await client.end();
process.exit(stillThere === 0 && leftover === 0 ? 0 : 1);
