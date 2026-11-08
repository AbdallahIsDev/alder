// scripts/purge-expired.mjs — delete dead rows the daily sweep would delete.
//
//   node scripts/purge-expired.mjs                      # dry run: counts only
//   node scripts/purge-expired.mjs --yes --confirm purge-expired
//
// Same predicates as lib/housekeeping.js: UNUSED bind codes expired more than
// 7 days ago, and rate_limits rows whose window ended more than 2 days ago. A
// USED code is never deleted; it is the record of who connected when.
//
// Guards, in this order and before any connection is opened:
//   --yes is required to delete, and it also needs --confirm purge-expired
//   a DATABASE_URL equal to the one in .env (production) needs
//   --i-know-this-is-prod
// Counts and table names only: never a code, a key or a business.

import { resolveTarget, connect, out, hasYes, confirmed, fail } from './delete-lib.mjs';

const NAME = 'purge-expired';
const CONFIRM = 'purge-expired';
const CODE_DAYS = 7;
const LIMIT_DAYS = 2;
const DAY = 86400000;
const CHUNK = 100;

const argv = process.argv.slice(2);
const yes = hasYes(argv);
if (yes && !confirmed(argv, CONFIRM, NAME)) {
  fail(`${NAME}: --yes also needs --confirm ${CONFIRM}. Nothing was deleted.`);
}
const { dsn, isProd } = resolveTarget(argv, { name: NAME });

const client = await connect(dsn);
try {
  const now = Date.now();
  const codeCutoff = new Date(now - CODE_DAYS * DAY).toISOString();
  const limitCutoff = new Date(now - LIMIT_DAYS * DAY).toISOString();

  const countCodes = async () => Number((await client.query(
    'select count(*)::int as n from public.bind_codes where used_at is null and expires_at < $1', [codeCutoff],
  )).rows[0].n);
  const countLimits = async () => Number((await client.query(
    'select count(*)::int as n from public.rate_limits where window_start < $1', [limitCutoff],
  )).rows[0].n);

  const codes = await countCodes();
  const limits = await countLimits();
  out(`${NAME}: target=${isProd ? 'production (acknowledged)' : 'non-production'}`);
  out(`${NAME}: would delete ${codes} unused bind_codes and ${limits} rate_limits rows.`);

  if (!yes) {
    out(`${NAME}: dry run, nothing deleted. Re-run with --yes --confirm ${CONFIRM}.`);
  } else {
    let deletedCodes = 0;
    for (;;) {
      const rows = (await client.query(
        'select code from public.bind_codes where used_at is null and expires_at < $1 limit $2',
        [codeCutoff, CHUNK],
      )).rows.map((r) => r.code);
      if (!rows.length) break;
      deletedCodes += (await client.query(
        'delete from public.bind_codes where code = any($1) and used_at is null and expires_at < $2 returning code',
        [rows, codeCutoff],
      )).rowCount;
    }

    let deletedLimits = 0;
    for (;;) {
      const keys = (await client.query(
        'select distinct key from public.rate_limits where window_start < $1 limit $2',
        [limitCutoff, CHUNK],
      )).rows.map((r) => r.key);
      if (!keys.length) break;
      deletedLimits += (await client.query(
        'delete from public.rate_limits where key = any($1) and window_start < $2 returning key',
        [keys, limitCutoff],
      )).rowCount;
    }
    out(`${NAME}: deleted ${deletedCodes} bind_codes and ${deletedLimits} rate_limits rows.`);
  }
} finally {
  await client.end();
}
