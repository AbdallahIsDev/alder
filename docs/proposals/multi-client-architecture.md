# Multi-client architecture decision

**Status:** comparison and recommendation only. This document does not make the product multi-client-ready. No schema or deployment changes are applied here.

## Read this first

The current build makes one client's page at a time. The database already gives each business a stable `id` and `slug`, but the public lead endpoint currently accepts the slug from the request body. That is the A1 finding in `_debug/audit/OPEN_QUESTIONS.md` and must be fixed before a second real client.

Both choices below keep one Supabase database and one Telegram bot. That means a code bug in either choice can still cross business boundaries: the server uses a service-role key that can read every business. Tenant filters and tests are required everywhere. Neither choice gives database-enforced separation. If that is not enough for the owner's cross-client leak requirement, neither option is ready; use separate databases or tenant-scoped credentials before launch.

### Recommendation in five lines

1. Start with **Option B**, one project and one static build per client; it fits the current single-client build and is easier to stage and roll back.
2. Resolve each public deployment from a required server-side `CLIENT` value; ignore or reject the body slug and fail closed if the configured business is missing.
3. Keep one central project as the shared Telegram webhook; Telegram accepts one active webhook URL per bot, and a chat remains bound to one business.
4. Scope each deployment's self-check and digest to its business; keep operator alarms and housekeeping on one hub, with the current atomic claims as a backstop.
5. Use Vercel Pro or a commercially permitted host before taking payment; do not serve a paying client on Hobby.

This is a short-term recommendation, not a claim of hard database isolation. Before the second client, ship the A1 fix, tenant isolation tests, settings model, cron scoping, and a verified client-config bundle. Review retention and legal text with a lawyer before contracts.

## The two choices

### Option A — one shared deployment

One Vercel project serves every client's static page. A server-side allowlist maps the request's `Host` header to a business. `/api/lead` never reads the business slug from the body. Unknown or malformed hosts fail closed. Every follow-up lookup must also prove that the lead belongs to the business selected by the host.

`Host` selects the public tenant; it is not authentication. The site is public, and a caller can send a custom Host header. Therefore no API may expose another tenant's lead, review page, sender settings, or operational detail just because the caller named a known host. Do not trust `slug`, `business_id`, `X-Forwarded-Host`, query strings, or cookies as alternate tenant selectors.

### Option B — one deployment per client

Each Vercel project builds one client's page from the same repo. `CLIENT`, `SITE_URL`, `MAIL_FROM`, phone rules, and client credentials belong to that project's environment. The server uses `CLIENT` to choose the business; it never lets a visitor choose a tenant in the body. Each client project that sends owner alerts needs the shared `TELEGRAM_BOT_TOKEN` for outbound messages. The webhook stays in one central project, because the bot has one active webhook URL. That hub must load per-business settings from the database when it handles a chat or sends that business an email.

Option B matches today's one-client build more closely. It does not isolate the shared database or shared bot: every deployment with the service-role key can still access all business rows if its code has a query bug.

### Effort scale

S = about 1–2 engineer-days; M = about 3–5; L = about 1–2 weeks. Estimates follow the portability review in `_debug/audit/OPEN_QUESTIONS.md` and assume one engineer familiar with Node. They are planning estimates, not vendor commitments.

## Changes by area

### Static pages — `build-static.js`, `clients/*.json`

- **A — L:** build each client's page and generated `robots.txt`, sitemap, manifest, and email brand. Add a host-to-page map and prevent the first client's brand from becoming the default.
- **B — S–M:** keep one page per project using required `CLIENT`; validate the config at build time and prevent a production build from silently falling back to `alder`. The build already supports one selected client.

### Public APIs — `api/lead.js`, `api/review.js`, `api/health.js`

- **A — M–L:** select the lead business by allowlisted Host; reject or ignore body `slug`; validate with that business's phone/postal rules; scope rate limits, duplicate lookup, insert, reads, and review-token lookup by `business_id`. Wrong-host and missing review tokens return the same not-found response. Health returns only the selected host's status; global status stays operator-only.
- **B — M:** resolve the tenant from required server `CLIENT`; scope lead and review operations by its `business_id`; return only that client's health data. A missing or inactive configured business fails closed.

### Daily APIs — `api/selfcheck.js`, `api/digest.js`

- **A — M:** one daily run covers all active businesses. Keep per-business owner messages and one global operator alarm; load each business's own sender and site settings.
- **B — M:** each project filters owner notices and digest work to `CLIENT`. Only the ops hub sends the global operator alarm and runs housekeeping. A shared atomic claim is a duplicate backstop, not a tenant filter.

### Bot — `api/tg.js`, `lib/tg.js`, `lib/operator.js`, `lib/content.js`

- **A — M:** one webhook handles every chat. Resolve business only through the existing chat binding and load that business's sender, site, legal, and phone settings. Keep owner messages tenant-scoped and operator messages global.
- **B — L:** keep one central webhook project, not one webhook per client project. Each lead project also needs the shared bot token for outbound alerts. The hub handles every bound chat and loads per-business settings from the shared database.

### Tenant data — `lib/client.js`, `lib/db.js`, `lib/request.js`, `lib/env.js`

- **A — L:** replace the one-client file lookup with a fail-closed Host resolver and business-config loader. Do not cache one tenant at module scope across warm invocations.
- **B — M:** require `CLIENT` in every client project and resolve its active business per request. The hub resolves through chat bindings instead. Production must not use a default client fallback.

### Validation and copy — `lib/lead-intake.js`, `lib/content.js`, `lib/hash.js`

- **A — M:** pass resolved business settings to phone/postal validation, page labels, bot copy, timestamp formatting, and the lead rate-limit key. Keep wording English.
- **B — M:** build page rules from the selected project config and pass per-business settings to server validation and the central bot. Include client identity in rate-limit keys.

### Other database and operations libraries — `lib/digest-db.js`, `lib/review-db.js`, `lib/bind-codes.js`, `lib/ops-*`, `lib/housekeeping.js`

- **A — S–M:** retain global aggregation in the single job, but preserve per-business grouping and destinations. Keep review-token and bind-code operations scoped to the owning business.
- **B — M:** add `CLIENT` filtering to owner/digest work; keep review-token and bind-code operations business-scoped; guard operator work and housekeeping to the hub.

### Emails — `lib/mail.js`, `lib/brand.js`, `lib/email-builders.js`, `lib/email-layout.js`, `lib/notify.js`

- **A — L:** make sender, canonical URL, timezone, locale, legal footer, and brand explicit per-business inputs. A process-wide `SITE_URL` is insufficient.
- **B — M–L:** public client projects can use their own env, but the bot hub and global jobs need per-business sender and site settings. Pass the chosen config explicitly into every send path.

### Runtime config and tests — `vercel.json`, `tests/run.mjs`, `tests/env.mjs`, isolation suites

- **A — M–L:** add and test Host routing for static files and APIs, per-business generated assets, and preserve current headers and review routes. Add two-Host and forged-input checks across API boundaries. No untested include pattern.
- **B — M–L:** every project reads the same repo cron definitions, so filter each invocation or add an env guard; do not copy config into drifting forks. Test at least two `CLIENT` environments, forged body slugs, hub chat routing, per-client cron scope, and project-config drift.

Other libraries such as `lib/outbound.js`, `lib/migrations.js`, and `lib/sample-texts.js` need no new tenant-selection behavior. Keep outbound guards unchanged; implement schema only in a separately approved migration.

## Schema proposal — text only, not a migration

`businesses.timezone` already exists (`supabase/migrations/0001_init.sql`). Do not add it again. The other country, website, sender, legal, and retention settings do not currently exist in that row. A simple per-business record keeps API, bot, email, and cron code on one source of truth.

Option A also needs an allowlisted host. This one-host version is enough for the first domain per business; if aliases are required, use a separate `business_domains` table with a unique normalized host instead.

```sql
-- Proposal only. Do not apply until the owner chooses an architecture and
-- legal counsel reviews retention and the required legal text.
alter table public.businesses
  add column site_host text unique,
  add column country_code text,
  add column phone_region text,
  add column locale text not null default 'en-US',
  add column postal_code_label text,
  add column site_url text,
  add column mail_from text,
  add column privacy_url text,
  add column terms_url text,
  add column lead_notice text,
  add column lead_retention_days integer,
  add column delete_after_churn_days integer,
  add column churned_at timestamptz;
```

For Option A, `site_host` is required and must be normalized and unique. For Option B, `site_host` is not needed to select the public tenant, but the other fields are still needed by the central bot and global jobs unless a separate config registry is maintained. A separate registry would create a second source of truth and is not recommended. `timezone` is already available. Retention columns express policy; they do not delete data. Export, request deletion, a grace period, audit evidence, and a scheduled purge still need design and implementation.

No schema is changed by this branch. The SQL above belongs in a future reviewed migration only after the owner decisions below.

## A1 and isolation tests

Today `api/lead.js` accepts `slug` in the request body and calls `getActiveBusinessBySlug`; that lets the visitor choose which business row receives the lead. Fix this before Option A or B.

- **Option A:** normalize the request Host, look it up in the server-side host allowlist, then use that business ID through intake. Missing/unknown Host returns not found. Ignore or reject a body slug even when it names a real client. Never let `X-Forwarded-Host` override the Host unless Vercel documents that exact field as a platform-owned value and a deployment test proves it.
- **Option B:** require `CLIENT` at runtime, resolve it to one active business, and scope the lead, duplicate check, and rate limits to that business. A missing or invalid `CLIENT` is a server error; do not fall back to a default client in production. Ignore or reject a body slug that differs.
- For both: prove a Client A request cannot read or mutate Client B's lead or review token; a valid token on the wrong tenant returns the same not-found response; a Telegram chat receives only its bound business; all query helpers include `business_id`; unknown clients fail closed. Include negative tests with forged `slug`, `business_id`, query, and forwarded-host values.
- Test that one Telegram chat cannot bind to two businesses. `business_chats.tg_chat_id` is already unique (`0001_init.sql`), so one account can belong to one business only. Another person for the same business uses a separate Telegram account and the existing invite flow.

Tests must run through the existing TEST project (`TEST_ENV=1` and `.env.test`) with fake outbound services. Never verify isolation with production leads.

## Daily jobs and duplicate risk

Today `/api/selfcheck` loops over all active businesses. It can send one owner notice per business, one aggregate operator alarm, then sweeps expired bind codes and stale rate limits. `/api/digest` loops over all active businesses and sends each eligible business a digest.

If every Option B project deploys the same `vercel.json`, each project's two daily schedules hit these global loops:

- **Owner self-check notices:** every deployment can send each business the same notice. Owner Telegram notices have no atomic claim. Owner email uses a stable business/day idempotency key, which may suppress an identical payload, but it is not an atomic database claim; differing deployment brand or sender can become a payload mismatch. Do not rely on this as the fix.
- **Operator alarms:** every deployment can compute and try the global alarm. Existing per-problem/day atomic claims usually let only the first delivery proceed. Claim failures fail open, so duplicates remain possible. The claim bucket can repeat near a fixed-window boundary.
- **Digests:** every deployment can compute and try every business's digest. Existing per-business/day atomic claims normally suppress the extra runs. Claim errors fail open; a duplicate remains possible. If no channel sends, the handler releases that business's claim so a later run can try again.
- **Housekeeping:** every self-check deployment can sweep the same expired codes and stale rate limits. The bounded deletes are safe to repeat but waste work.

Smallest safe Option B change: filter owner self-check targets, digest targets, and their count work by required `CLIENT`; run the aggregate operator alarm and housekeeping only when `OPS_HUB=1` in the single designated hub. Keep the existing atomic claims for races, not as the tenant filter. Add tests that call each client's job twice: each owner/digest reaches only that client, operator alarm goes out once per claimed problem, a failed claim follows the current fail-open rule, and no-client configuration performs no sends. Option A keeps the current one-run/all-business shape and needs no duplicate schedule fan-out.

## Manual provisioning counts

These are the manual steps after the needed code, config schema, and isolation tests exist. Today the setup is still manual and the server-side `CLIENT`/Host enforcement is not complete.

### Option A — client 2 (8 steps)

1. Confirm the commercial host plan and client domain ownership.
2. Add one `businesses` row with the approved country, phone, timezone, site, sender, legal, retention, and unique host settings.
3. Point the client's DNS at the existing shared project and attach the domain there.
4. Add the client's page copy/assets to the build input and check the generated page, sitemap, robots file, and manifest.
5. Verify the Host allowlist maps only to the new business and all unknown hosts fail closed.
6. Verify email sender/domain and legal links; no real send until the redirect is removed under the launch checklist.
7. Mint a bind code in the existing bot. Bind one Telegram account to this business; do not reuse an account already bound to another business.
8. Run the two-tenant isolation, lead, email, Telegram, review, self-check, digest, and offboarding checks, then deploy the shared release.

### Option A — client 5 (9 steps)

1. Confirm the commercial host plan and the new domain.
2. Add the fifth business and complete its per-business settings.
3. Point DNS at the shared project and attach the domain.
4. Add the fifth page and assets to the build inputs.
5. Verify all five hosts map to five distinct business IDs; test unknown and forged hosts.
6. Verify sender, legal URLs, phone/postal rules, and country-local display settings.
7. Mint and bind a new Telegram account to business 5; never move an account already assigned to another business.
8. Run pairwise isolation checks across the five tenants plus the delivery and offboarding checks.
9. Deploy one shared release and confirm all five sites/build outputs together.

### Option B — client 2 (10 steps)

1. Confirm the commercial plan and the client's domain.
2. Add one business row with approved business and lifecycle settings.
3. Add and review `clients/<slug>.json` for the page build.
4. Create a new Vercel project from the same repository in the same controlled team.
5. Set that project's `CLIENT`, `SITE_URL`, `MAIL_FROM`, country/phone rules, `TELEGRAM_BOT_TOKEN`, and shared service secrets in the right environment; use TEST values for previews.
6. Add the domain to this project and update DNS.
7. Deploy and verify the page, API tenant, sender, legal links, and phone/postal validation.
8. Do not set the Telegram webhook on this project; add the client to the central bot's business config.
9. Mint a bind code in the central bot and bind one Telegram account to business 2.
10. Run API/body-slug isolation, cross-token denial, lead, email, bot, self-check, digest, and offboarding checks.

### Option B — client 5 (11 steps)

1. Confirm the commercial plan and the fifth domain.
2. Add the fifth business row and approved settings.
3. Add and review `clients/<slug>.json` for this build.
4. Create a fifth project from the same repository under the controlled team.
5. Set `CLIENT`, `SITE_URL`, `MAIL_FROM`, country/phone settings, `TELEGRAM_BOT_TOKEN`, and shared service secrets; use TEST values for previews.
6. Add the domain and update DNS.
7. Deploy and verify the page, API tenant, sender, legal links, and phone/postal validation.
8. Do not set another Telegram webhook; add business 5's config to the central bot data.
9. Bind a new Telegram account to business 5; one account cannot serve multiple businesses.
10. Review cron filters and environment drift across all five projects; only the hub may send global alarms or sweep.
11. Run five-tenant isolation, delivery, and lifecycle checks.

The counts exclude legal advice and provider signup work that cannot be done by a repo change. They also exclude the engineering prerequisites above.

## Security, blast radius, and migration

| Concern | Option A | Option B |
|---|---|---|
| Tenant selection | Host allowlist in server code. Host is public routing input, not authentication. Unknown host must fail closed. | Server `CLIENT` env. Body slug is ignored/rejected. Missing env fails closed. |
| Secrets | One deployment stores shared database, Telegram, email, and operator secrets for every client. A bad deployment or leaked secret affects all clients. | Each lead project stores the shared database service key, email credentials, and Telegram bot token for outbound alerts. The hub stores the bot token, webhook secret, and global operator secrets. A leak can affect every client. Per-project env separates settings, not data access. |
| Bad code deploy | One shared deploy changes all customers at once; rollback is one action. | A client project can be staged or rolled back alone, but code drift increases with project count and the central bot is shared. |
| Database access | Shared service-role key crosses every tenant; all queries must be scoped and tested. | Same. Separate projects are not database isolation. |

Do not put customer secrets in `clients/*.json`, source control, or preview environments. Keep production secrets out of previews; rotate any leaked shared credential across every project. Before onboarding, the isolation test must prove cross-client reads/writes fail at each API boundary.

Option B can move to A without changing lead IDs if the stable `businesses.id` and `slug` remain the keys, and the proposed business settings become the shared source of truth. Add and verify the host allowlist; build all client pages; deploy a shadow shared project; run each client's host and negative-isolation tests; move one custom domain at a time; then remove the old per-client project only after its pages, API, email links, bot actions, and daily jobs pass. Keep one central bot URL throughout. No data copy is required when both options share the same database. A host-provider change is a separate migration: see the portability review below.

## Hosting and cost

The current app is Vercel-specific: API files use Vercel `req`/`res`, `vercel.json` holds rewrites, headers and crons, and the test runner starts a pinned `vercel dev` in a generated `.vercel` test root. The Q1 portability review in `_debug/audit/OPEN_QUESTIONS.md` estimates Cloudflare at L for handler conversion, Netlify at M for adapters, and plain Node at S–M for the closest runtime. Their routing, function packaging, cron, headers, auth, and harness still need translation.

- **Commercial plan:** Vercel says Hobby is only for non-commercial personal use; commercial deployments require Pro or Enterprise. Do not accept payment while using Hobby. [Vercel Fair Use Guidelines](https://vercel.com/docs/limits/fair-use-guidelines).
- **Vercel cost:** current Pro platform fee is $20/month for one deploying seat and includes $20/month of usage credit; extra usage and taxes may apply. The fee is per team, not one $20 fee per project, so Option B's projects can share one Pro team. Current project-per-repo limits are 25 on Hobby and 150 on Pro. Recheck before purchase. [Vercel Pro plan](https://vercel.com/docs/plans/pro-plan), [Vercel limits](https://vercel.com/docs/limits).
- **Vercel schedules:** current docs list 100 cron jobs per project on all plans. Hobby runs each job once daily with ±59 minute timing; Pro supports per-minute schedules. Today's two daily routes fit the frequency limit, but every Option B project gets its own invocations. [Cron usage and pricing](https://vercel.com/docs/schedules/cron-jobs/usage-and-pricing).
- **Cloudflare:** the current Workers Free table lists 100,000 requests/day and 10 ms CPU per invocation. Cron calls a `scheduled()` handler on UTC. Existing Vercel handlers do not run unchanged. Check current account quotas and the Supabase/network design before choosing it. [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).
- **Netlify:** scheduled functions use UTC, have a 30-second limit, run automatically only on published deploys, and cannot be invoked directly by a production URL. Function adapter and test harness still need work. Account-level quotas and commercial fit for this workload are **NOT VERIFIED**. [Scheduled Functions](https://docs.netlify.com/build/functions/scheduled-functions/).
- **Plain Node:** closest API runtime, but the owner must choose a host, TLS/reverse proxy, process manager, deployment/rollback, monitoring, and scheduler. Hosting and commercial terms are **NOT VERIFIED** for any candidate host.

Recommendation: use Vercel Pro for the near-term second-client path because the existing build and test harness already target Vercel. Choose another host only if its compliant price is better enough to justify the handler, packaging, cron, and harness migration. No other provider's commercial terms, exact account quotas, regional latency, or free-tier reliability are verified here.

## Function bundle: `clients/<slug>.json`

**Finding:** `lib/client.js` builds a runtime path from the selected slug and calls `readFileSync` on `clients/<slug>.json`. Current `vercel.json` sets `includeFiles` to exactly `lib/brand.generated.json` for `api/lead.js` and `api/*.js`; it does not explicitly include `clients/*.json`. Vercel documents `includeFiles` as a glob that adds files to a function bundle. The code's runtime-built path may or may not be found by Vercel's automatic Node file tracing. Therefore the client JSON is **not guaranteed by the current explicit config; actual inclusion is NOT VERIFIED**. Do not change `vercel.json` based on a guessed glob.

**Preview-deployment checklist before relying on this file:**

1. Build a private Vercel Preview deployment with a TEST database and non-production outbound interlocks; do not attach a customer's live domain.
2. Inspect the generated function artifact for the tested route (for example, the local build output `api/lead.func`) and confirm the exact `clients/<configured-slug>.json` path exists inside that bundle. Do not print or copy its contents into logs.
3. Invoke a temporary, secret-protected diagnostic that reports only `client_config_loaded: true/false` and `configured_slug_matches: true/false`; never return config fields, recipient addresses, or secrets. Expected: both booleans are `true` on the deployment, and the page plus lead endpoint use the same business.
4. Remove the temporary diagnostic after recording the result. If the file is absent or the booleans differ, do not onboard the client; move runtime settings to the database/environment or design and separately test a narrowly scoped `includeFiles` pattern.

No live deployment was created or inspected for this review.

## Q5 second-client blockers mapped to both choices

| Q5 | Option A | Option B |
|---|---|---|
| 1. One brand per static build | Build every client page and route by allowlisted Host; **L**. | Keep one build per project using `CLIENT`; already closest to today's build; **S–M**. |
| 2. Deployment-wide site URL and sender | Read site and sender from the matched business config for all APIs, emails, and bot actions; **M–L**. | Client project env handles its public API, but central bot/jobs need the same settings per business from the shared config row; **M–L**. |
| 3. US-only postal and phone rules | Store country/phone region and validate from Host-selected config in page and API; **L**. | Set page rules per project and server rules from `CLIENT`; hub must read per-business rules; **M**. |
| 4. Placeholder legal links/text | Build or render per-business approved URLs/text; **M**. | Put legal settings in each page config and shared business config for bot/lead notice; **M**. |
| 5. No export/request deletion/grace period | Shared lifecycle system and auditable tenant-scoped export/delete. Schema and job do not implement themselves; **L**. | Same work. Separate projects do not create data lifecycle controls; **L**. |
| 6. Hobby commercial restriction | One Pro project or another commercial host before payment; **M** decision. | Same rule; one Pro team can own multiple projects, with usage and project limits; **M** decision. |
| 7. Manual provisioning | Host, business config, build input, sender, bind, test, one shared deploy; counted above; **M** ongoing. | Repeat project/env/domain/build and test steps for every client; central webhook unchanged; **M** ongoing. |
| 8. No guaranteed alert delivery | Still best-effort until outbox/monitoring is separately designed; **M–L** later. | Same; multiple projects do not make alerts durable; **M–L** later. |
| 9. Shared Telegram bot | One central webhook; existing chat binding scopes each account to one business. | One central webhook project is mandatory; do not set the shared token's webhook from every client project. |
| 10. English-only copy | Keep English and format country-specific phone/date/postal rules from business config. | Same; configure per-project page and central bot formatting without translating copy. |

## Owner decisions pending

1. **Architecture:** choose A (shared Host-routed project) or B (project per client). **Default: B for the next client**, with the hub and isolation gates above.
2. **Hosting:** choose Vercel Pro or a compliant alternative before taking payment. **Default: Vercel Pro**, since the app and test harness already depend on Vercel.
3. **Retention and legal text:** have a lawyer approve the retention window, deletion promise, privacy/terms URLs, and lead notice before contracts. **Default: no client contract until reviewed.**

## Evidence and sources

- Repository: `build-static.js`, `lib/client.js`, `api/lead.js`, `api/review.js`, `api/selfcheck.js`, `api/digest.js`, `api/tg.js`, `lib/db.js`, `lib/digest-db.js`, `vercel.json`, `tests/run.mjs`, `supabase/migrations/0001_init.sql`, and `_debug/audit/OPEN_QUESTIONS.md` Q1/Q5.
- Vercel documents `includeFiles` as a function-bundle glob: [Static Configuration with vercel.json](https://vercel.com/docs/project-configuration/vercel-json).
- Telegram's Bot API sets one webhook URL for a bot and reports one current URL through `getWebhookInfo`: [Telegram Bot API](https://core.telegram.org/bots/api).
- Provider pages checked 2026-11-12. Prices and limits can change; check again before a hosting decision.
