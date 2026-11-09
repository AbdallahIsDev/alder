# Test project (`alder-test`)

A separate Supabase project for the suites. The production project is never a
test target; the runner refuses it unless `ALLOW_PROD_TESTS=1` is set by hand.

## What the owner does, once

1. In the `alder-test` project: **SQL Editor** → paste `_debug/test-project/schema.sql` → Run.
   It is every file in `supabase/migrations/`, in order, unchanged.
   `create extension if not exists pgcrypto` is supported on a hosted project
   (Supabase ships it). No statement needs superuser; `create schema private`
   and the grants run as the project owner.
2. Same editor → paste `_debug/test-project/seed.sql` → Run. Two businesses
   (`alder-demo`, `second-demo`), status `demo`, `example.com` emails, no chats.
   Idempotent (`on conflict (slug) do nothing`).
3. **Project Settings → API**: copy the Project URL, the `anon` key and the
   `service_role` key. **Project Settings → Database → Connection string →
   Session pooler**: copy the URI for `DATABASE_URL`.
4. Copy `.env.test.example` to `.env.test` and fill those names. `.env.test` is
   gitignored; never put production values in it. Do not add
   `TELEGRAM_API_BASE` or `RESEND_API_BASE` — the runner refuses a file that
   defines them.
5. `npm run test:env-check` prints the host, whether it is production, the row
   count per table, and the security posture. It never prints a key or a URL.

## How the suites pick it up

`lib/env.js` loads `process.env` first, then `.env.test` (only when
`TEST_ENV=1`), then `.env.local`, then `.env`. `tests/env.mjs` installs a fetch
guard that allows loopback and the `SUPABASE_URL` host only.

## Verify the guard

- With `.env.test` absent: `node tests/run.mjs` prints the production warning
  and exits unless `ALLOW_PROD_TESTS=1`.
- With `.env.test` present and `TEST_ENV=1`: it runs against the test host and
  prints that host's name in the summary.

## Security posture

`npm run test:env-check` reports, for the target project: RLS per public table,
anon/authenticated table grants, and whether `public.rls_auto_enable` exists.
Production today: RLS on all 7 public tables, 0 policies, no anon/authenticated
table grants, `rls_auto_enable` present. The test project must match; if it does
not, `schema.sql` is the place to add the missing `enable row level security`
or `revoke` statements — never the migrations.
