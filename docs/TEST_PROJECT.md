# Running the tests against a dedicated Supabase project

Today every suite reads the **production** database: it needs the `alder-demo` row at
seed values, and any test run has to be preceded by a backup and followed by a
restore. This document is the way out of that: one test project, one env file, and the
production guard in `tests/run.mjs` stops being an obstacle.

Nothing here changes production. Do it once.

The project name used throughout is `alder-test`. Any name works.

---

## 1. Create the project

1. Supabase dashboard → **New project**.
2. **Region: `eu-west-3` (Paris).** Measured from this machine: Paris 63 ms, London
   70 ms, Frankfurt 69 ms, and the production project (`us-east-1`) 145 ms per TCP
   connect. That difference is most of the suite's runtime — the suites spend ~93 %
   of their time waiting on database round trips.
3. Pick any name. The free plan is fine; note the pause rule in §7.
4. Save the database password somewhere safe — you need it once, in §3.

## 2. Copy four values

Dashboard → **Project Settings**.

| Value | Where | Goes into |
|---|---|---|
| Project URL (`https://<ref>.supabase.co`) | API Settings | `SUPABASE_URL` |
| `anon` / public key | API Settings → Project API keys | `SUPABASE_ANON_KEY` |
| `service_role` / secret key | API Settings → Project API keys | `SUPABASE_SERVICE_ROLE_KEY` |
| Session-pooler connection string | Connect → Connection string → **Session pooler** | `DATABASE_URL` |

The pooler string looks like
`postgresql://postgres.<ref>:<password>@aws-0-eu-west-3.pooler.supabase.com:5432/postgres`.
Percent-encode any character in the password that is not URL-safe (`@` → `%40`,
`#` → `%23`, and so on). Use the **session** pooler, not the transaction pooler —
`scripts/apply-migrations.mjs` runs multi-statement transactions.

## 3. Fill in `.env.test`

```powershell
Copy-Item .env.test.example .env.test
```

```bash
cp .env.test.example .env.test
```

`.env.test` is gitignored (`.gitignore` line 21, `.env.*`, with an explicit exception
for the `.example`). Fill in the four values above, plus the dummy values the suites
need — Telegram, Resend, the webhook secret and the mail addresses all point at the
local fake servers during a test run, so any non-empty string works. The template says
which is which.

Two rules:

- **Never** put `TELEGRAM_API_BASE` or `RESEND_API_BASE` in this file. The runner
  refuses to start if a file defines them, because a file value would shadow the
  loopback override that points the functions at the fakes.
- `MAIL_FROM` must not be the built-in default sender, or `sendMail()` answers
  `no_verified_sender` when no redirect is set.

## 4. Check it

```powershell
npm run test:env-check
```

```bash
npm run test:env-check
```

It prints which required names are present or missing and whether `SUPABASE_URL` and
`DATABASE_URL` still match `.env` (production). It never prints a value, a URL, a key
or a host. Exit code 1 means fix something first. This is the check to run before
every suite run; it reads files only, so a paused project still passes it.

There is an optional deeper report:

```powershell
npm run test:env-check -- --db
```

It connects, prints the **host name only**, whether that host is production, the row
count per table, and the security posture: RLS per public table, `anon`/`authenticated`
table grants, and whether `public.rls_auto_enable` exists. Production today: RLS on all
7 public tables, 0 policies, no `anon`/`authenticated` table grants, `rls_auto_enable`
present. The test project must match; if it does not, `schema.sql` is the place to add
the missing `enable row level security` or `revoke` statements — never the migrations.

## 5. Build the schema

Two routes. Use either; they produce the same schema.

**Route A — `npm run db:apply` (the normal route).**

```powershell
$env:TEST_ENV = "1"; npm run db:apply
```

```bash
TEST_ENV=1 npm run db:apply
```

This applies, in order: `0001_init.sql`, `seed.sql`, `0002_default_privileges.sql`,
`0003_service_role_grants.sql`, `0004_lead_event_kinds.sql`. The script refuses to run
if `public.businesses` already exists, so it is safe to re-run by mistake — it will
just stop.

**Route B — the SQL editor (when the pooler or the password is fighting you).**

1. **SQL Editor** → paste `_debug/test-project/schema.sql` → Run. It is every file in
   `supabase/migrations/`, in order, unchanged. `create extension if not exists
   pgcrypto` is supported on a hosted project (Supabase ships it). No statement needs
   superuser; `create schema private` and the grants run as the project owner.
2. Same editor → paste `_debug/test-project/seed.sql` → Run. Two businesses
   (`alder-demo`, `second-demo`), status `demo`, `example.com` emails, no chats.
   Idempotent (`on conflict (slug) do nothing`).

`supabase/seed.sql` is the single source of the seed values. The copy under
`_debug/test-project/` exists only because the SQL editor cannot include a file, and
`tests/migrations.test.mjs` (M5) fails if the two ever disagree — edit
`supabase/seed.sql` first, then mirror it.

What neither route creates: the `pgcrypto`, `uuid-ossp`, `pg_stat_statements` and
`supabase_vault` extensions, the `anon`/`authenticated`/`service_role` roles, and
`public.rls_auto_enable`. Supabase creates all of those on every new project. The
migration script ends with a sweep that fails if `anon` or `authenticated` can reach
any table, so a bad apply is loud.

## 6. Run the suite

```powershell
$env:TEST_ENV = "1"; node tests/run.mjs
```

```bash
TEST_ENV=1 node tests/run.mjs
```

`TEST_ENV=1` switches the loader to `.env.test`; everything else is unchanged. The
runner still refuses if `SUPABASE_URL` matches `.env`, which it no longer does, so
`ALLOW_PROD_TESTS` is not needed and can be retired once this works.

In PowerShell the variable stays set for the rest of the session. To unset it:

```powershell
Remove-Item Env:TEST_ENV
```

Expected: the same counts as a production run, faster. The projection from the
measured round-trip difference is roughly 225–235 s against 272 s.

## 7. The free project pauses

Supabase pauses free projects after about a week without activity. A paused project
does not answer, so:

- `npm run test:env-check` still passes (it only reads the file).
- `TEST_ENV=1 npm run db:apply` fails at connect.
- `TEST_ENV=1 node tests/run.mjs` fails at the canary with a database error.

**To wake it:** dashboard → the project → **Restore project**. It takes a few minutes
and the data is kept. Re-run `npm run test:env-check` and then the suite.

If you would rather not think about it, run the suite at least once a week, or move
the project to a paid plan.

## 8. When this is working

Then, and only then:

1. Delete `ALLOW_PROD_TESTS` from `tests/run.mjs` and make the production guard
   absolute (decision 7 from the earlier bundle).
2. Replace the hardcoded `alder-demo` fixtures with `tests/fixtures.mjs`, seeding a
   dedicated `test-fixture` business per run.
3. Remove the backup/reset/restore ritual from `HANDOFF_alder_session.md` and from
   the test workflow section.

None of that is done yet: the suite still runs against production until `.env.test`
exists.
