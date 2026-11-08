# Alder handoff

Living handoff for continuing sessions. Update after each task bundle. No secrets here — names only.

## Current state

- Branch `db-backend` (never push to `main`).
- Baseline before this bundle (pre-bundle code, all green): `db-wall 27, lead-api 44, notify 37, webhook 42, review 21, fallback 7, brand 6, outbound 4` = **188 tests**.
- Final full run after this bundle (all green): `db-wall 27, lead-api 44, notify 37, webhook 42, review 21, fallback 7, brand 6, outbound 7` = **191 tests**. Outbound went 4 → 7 because F5–F7 were added; no test was removed or skipped (191 PASS/FAIL lines in the run log).
- Production is live; suites read the production database (see caveat below).

## What changed in this bundle (operator, owner, recovery — 2026-11-07)

- **Two roles, never mixed.** The operator chat is `OPERATOR_CHAT_ID` (falling back to
  `TELEGRAM_CHAT_ID`); `OPERATOR_EMAIL` is the alarm fallback. Operator-only content —
  redirect warning, aggregates, slugs, "no phone connected" — goes only there. The
  `status=demo` audience rule is gone; a demo business is a lifecycle state.
- **One alarm.** `/api/selfcheck` sends one aggregated operator message (problems first,
  each affected business by slug), then owner messages per business. No recipient
  de-duplication: two businesses sharing an inbox get two messages.
- **Operator commands**: `/code`, `/phones`, `/businesses`, `/operator`, all authorised by
  chat id in a private chat; `/id` works everywhere and is not in the menu. Menus are
  registered by `npm run tg:commands` (owner default, operator chat-scoped).
- **Owner phone = oldest connected phone.** Only it may `/invite` or remove; every phone
  keeps alerts, buttons and `/leads`.
- **Recovery**: paste a code in an unbound chat; `/leads` newest 8 with Open buttons and
  Older paging; a stale tap answers "Already updated." and refreshes the card.
- **Blocked bot**: 403 on the only phone, or `my_chat_member` kicked, sends the operator
  one notice per business per day. `setWebhook` now subscribes to `my_chat_member`.
- **Tests guard**: `tests/env.mjs` installs a fetch guard — any non-loopback, non-Supabase
  host throws `network_guard_blocked` whatever `VERCEL_ENV` says.
- **`/invite` fixed** on `fix-invite-message` (merged here): real deep link, real line
  breaks, and `tests/bot-text.test.mjs` scans every user-facing string for artifacts.
- Not applied: any migration. `docs/PROPOSALS.md` §5d is still the only schema proposal.

## What changed in this bundle (ops audience, branch `ops-audience`)

- **The self-check is per business.** It used to count every `*_failed` event globally and send
  that one text to every target, so a demo business was told about another business's failures.
  `eventCountsByBusiness` (lib/digest-db.js) now returns `Map<business_id, {kind: n}>` from two
  paged queries, and each message carries only its own numbers.
- **Audience rule, no new env var.** `shouldAlertBusiness` (lib/ops-copy.js): a `demo` business
  is told when it has a failure **or** the mail redirect is on; an `active` client is told only
  when one of its own sends failed, and never sees the redirect warning or a setting name. A
  paused or churned business is never told anything.
- **One recipient, one message.** `deliverToBusinesses` de-dupes chat ids and (via `mailKeyFor`)
  owner addresses per run. Targets are sorted worst-first, so a shared inbox keeps the message
  with the most failures. The response gained `deduped`.
- **Every email now uses the shared layout.** `lib/email-builders.js` is the registry;
  `selfCheckEmail` and `digestEmail` render through `shell()`/`opsHeader()`, so the logo is a
  referenced `cid:brand-logo` instead of an attachment nobody points at (that stray "logo.png"
  card). `shell()` carries `data-alder-layout="1"` as the checkable marker.
- **Copy rewritten in plain words.** "Your lead summary" (digest) and "Alert check" (self-check):
  no event names, no underscores, no "tg", problems first, and a "Needs attention" section that
  does not exist when nothing failed.
- **Guard test:** `tests/email-layout.test.mjs` (L1–L4) asserts every registered builder produces
  the marker, the ops email references the CID logo, the detector rejects a hand-rolled body, and
  every module that calls `sendMail()` imports the registry.
- **Preview gallery:** `node scripts/preview.mjs` now renders the digest email, both alert-check
  emails and the four ops text variants.
- Proposal only: owner-controlled summary schedule, `docs/PROPOSALS.md` §5d. No migration, no code.

## What changed in this bundle (test speed)

- Measured before/after, full run, same machine. Before (`_debug/before-run.txt`, pre-bundle code): total **411.4 s**, of which dev-ready 55.8 s; lead-api **125.9 s**, notify 32.9 s, webhook **102.9 s**, review 64.6 s, fallback 16.8 s, db-wall 7.7 s, brand 0.3 s, outbound 0.07 s. After (`_debug/final5-run.txt`): total **304.2 s**; lead-api **85.7 s**, notify 28.3 s, webhook **89.5 s**, review 44.6 s, fallback 16.5 s, db-wall 7.7 s, brand 0.3 s, outbound 0.1 s. The eight suites sum to 272.7 s, so 31.5 s of the 304.2 s is process overhead (npx version check, dev start, canary, cleanup).
- **The 180 s target was NOT met.** 304.2 s total, and 272.7 s even with all startup overhead removed. Nothing in the run log supports a lower figure.
- Earlier drafts of this file carried estimates (lead-api "~40 s", webhook "~80 s", review "~35 s", notify "~20 s", total "~200 s class"). Those were projections, not measurements — no log in `_debug/` records a run with those numbers. The only measured pre-bundle total is 352.3 s (`_debug/timing-warm.txt`, dev-ready 7.4 s), which is a warm-`vercel dev` run of the same pre-bundle code; 411.4 s is the same code with a cold 55.8 s dev start.
- One shared `vercel dev` for all suites; suites run sequentially; dev-ready poll is 60× (fetch 1500 ms timeout + 1000 ms sleep). That poll quantises readiness to 1 s and, in the worst case, can take 150 s, not the 60 s the error message claims.
- `lib/outbound.js` reads `OUTBOUND_TIMEOUT_MS` only when `isDev()`, which is `VERCEL_ENV === 'development'` and nothing else — an unset value is NOT dev and gets `TIMEOUT_MS` 3000 (fail-closed). An integer 200–3000 is honoured, anything else falls back to 3000. `tests/run.mjs` sets **200** for the dev server and for every suite child; fake hang durations went 6000→2500 ms (7 sites: notify A4 + B7; webhook C23, C27, C28 twice, C29). Each hang now costs ~200 ms of wall time: measured A4 1537 ms and B7 1707 ms, down from 2287/2460 at 1000 ms. Tests F5–F8 cover the override; 3× stable notify/webhook runs at 200 ms.
- Runner: per-suite seconds + total always printed; `--seed-check` is a read-only gate that exits 1 on a mismatch; `--timing` is accepted but does nothing (timing always prints). **The dev-server skip is per run, not per suite:** `NEEDS_DEV` is true if *any* selected suite needs HTTP, so with the default list `notify`/`webhook` still run while `vercel dev` is up (they just never call it). `vercel dev` and the canary are skipped only when every selected suite is in-process — e.g. `node tests/run.mjs tests/webhook.test.mjs`.
- lead-api/review logic tests moved in-process (same IDs/assertions); real HTTP kept only for lead 10/12/12b/13/14 and review D2/D4/D8/I1 (rewrites, headers, dev log, full round trips). Mutation checks: 5/5 kill tests.
- Supabase round trip from this machine: median 192 ms (20 SELECTs: min 175, median 192, max 401; an earlier 20-sample run gave min 178 / median 196 / max 354). Request counts per op: lead POST success 9, 400 POST 2, /start bind 5, /leads 2, c+d callbacks 11, y: 8, r: 4.
- Tests that stayed on real HTTP: lead-api 10 (GET 405), 12/12b (page estimateDeliver end-to-end), 13/14 (dev LOG assertions); review D2 (full GET page), D4 (404 + dev generic page), D8 (/go rewrite), I1 (rewrite variants). fallback stays fully HTTP (urlencoded platform parsing). Test 13 makes no HTTP call of its own — it reads the dev-server log, so it needs `vercel dev` to have run.

## What changed in the previous bundle (bot copy / phone / review)

- Phone for all countries: modal `00` → `+`, one trunk `0` after the calling code allowed past the cap while typing and stripped on submit; server retries once without that `0` and stores only valid E.164 (Italy zero kept). North America code `1` overridden to `[10, 10]` in `build-static.js`. Exhaustive proof: 245 regions, 490 mobile-example strings (E.164 + international), 0 digit drops, 0 phoneOk/server failures. Tests P19–P22.
- Telegram status block now ≤26 chars (no name/email), confirm buttons "Send request"/"Mark done". `/leads` uses a shared status map + `renderLeadList` (spaced blocks, truncated names, emoji statuses). Tests S1, C32, L1.
- Bot copy is single-tenant (linked/help/already/unconnected/bad-code/plain-text constants in `lib/content.js`); plain text gets a hint rate-limited 3/chat/hour (fail closed); bot description + short description via `lib/tg.js` and `npm run tg:commands`. Tests D1–D5.
- Review page: no card (24px gutter, 420px max, centred), 20px balanced title, landing-page @font-face (Geist/Inter, swap, heading preload) + favicon links, CSP allows them. Test R1.
- Item 5B facts (names only): schema columns/statuses/event kinds as in the report; code never touches money (`private.lead_financials` only in schema); a second bot could reuse `lib/tg.js` by threading a per-call token (not implemented).
- HANDOFF #11 resolved (US strictness). TypeScript decided: not now (use `@ts-check` + JSDoc later/at dashboard start).

## What changed in the previous bundle (follow-up 2)

- Corrected retry-key rule: a timeout reuses the EXACT key of the timed-out attempt, recorded in that failure's `lead_events.meta` as `{ status, key }`; any other failure gets a fresh `<leadId>:review:r<count>`. `getReviewFailureInfo` now returns `{ count, lastStatus, lastKey }` (null for legacy rows). Tests C21–C24 unchanged, C27–C30 new.
- Post-done error handling: the post-transition part of kind `y` is wrapped so a throw logs `tg_callback_failed` and best-effort renders the error view (or the no-email done view) with no second answer. No uncaught query exists there today, so the test is static (C31).
- Modal: server errors for earlier-step fields now navigate to that step before focusing (`firstErrorStep`, exposed as `window.estimateFirstErrorStep`; test P18); `setField` sets `aria-invalid` on textarea too. Error-clearing on edit already worked via the `input` listener + `check()` (covers notes and server-set errors). Client `phoneOk` accepts 7–9 digit bare US numbers the server rejects (report only).
- Bundling: `vercel.json` gained `functions: { "api/*.js": { "includeFiles": "lib/brand.generated.json" } }` (headers untouched) so the logo bytes are guaranteed in the function bundle; test F6 asserts the module loads real PNG bytes.
- `api/tg.js` try-body reindent (whitespace only, own commit; `git diff -w` empty).

## What changed in the previous bundle (reviewer follow-up)

- Review retry idempotency keys: first send uses `<leadId>:review`. `r:` (Try again) reads earlier `review_request_failed` events via `getReviewFailureInfo` (count + most recent `meta.status`); if the last status is `timeout` it reuses the plain key (the first request may have delivered), otherwise it uses `<leadId>:review:r<n>`. `sendReviewRequest` takes an optional `idempotencyKey`. Tests C21–C24.
- Callback error handling: `handleCallback` (after the binding check) is wrapped in try/catch; any throw logs only `tg_callback_failed` + code and answers once with "Something went wrong. Try again." (answer-once flag). Tests C25–C26 (throw injected by wrapping fetch and failing the targeted PostgREST query).
- Notes field error: `api/lead.js` returns `errors.notes` ("Keep notes under 2000 characters.") for notes over 2000 chars; the modal gained a notes error element (`data-f="notes"` + `.err`), an `R.notes` validator, and textarea focus/aria wiring, so a 400 with errors never shows the generic panel. Tests P16–P17.
- Comments only: `api/review.js` header now matches actual GET-never-writes behaviour; `api/lead.js` phone comments state region is always US (select has no country column); `lib/db.js` retry-read comment; unused `mailCard` import removed (grep showed only the import line).
- ITEM 5 findings (no code change): double-tap Try again can record both `review_requested` and `review_request_failed` and can leave the message showing Error after a send (Resend key dedupes the email itself); longest Telegram alert is 1070 chars (notes truncated to 300), well under 4096; all three emails carry the CID attachment via `sendMail` (892-char base64); `VERCEL_ENV` is referenced in `api/`+`lib/` but was missing from the env names list below (added).

## What changed in the previous bundle

- ITEM 1 phone: `api/lead.js` switched to `libphonenumber-js/max`; per-field 400 bodies (`{ ok: false, errors: {...} }`); modal shows field errors under the field, focuses it, stays on step 4; generic panel only for network/5xx. `build-static.js` inlines `PHONE_CC` (min/max national length per calling code, 206 codes, 2514 bytes) and the default calling code into the built HTML; modal caps digits per country and validates national length on submit. Tests P10–P15.
- ITEM 2 Telegram phone formatter: `displayPhone` in `lib/content.js` shows a leading `+` unchanged (no more `+1+20...`); bare 10 digits get `+1`, bare 11 digits starting with 1 get `+`. Same rule in `toTelHref` and in the low-rating alert (`lib/notify.js`). Test G1b.
- ITEM 3 Telegram status block + Try again: emoji status lines, one fact per line, ≤40 chars for first name "John", email never in the block. Failed review email re-renders the error view with one **Try again** (`r:`, primary) button. `r:` is allowed only when the lead is `done` and no `review_requested` event exists; it resends with the existing token, never changes status. New db helpers `getDoneLeadForRetry` / `hasReviewSent` (no schema change). Tests S1, C17–C20.
- ITEM 4 emails: logo as CID inline image (`cid:brand-logo`, 32×32, `alt=""`) attached via Resend single `/emails` from `logo.onDarkB64` in `lib/brand.generated.json` (written by `scripts/sync-brand.mjs`); function never reads `assets/` at run time; hosted PNGs stay for the preview only. One padding system: header/body/footer `.px` 24px horizontal; header 18px top/bottom, body 24/24, footer 8px top 24px bottom; review wrapper inset removed, button left-aligned. Tests A1c, S2; G8 rewritten.
- ITEM 5 preview/docs/handoff: `scripts/preview.mjs` shows six Telegram views and the three emails with the logo (data-URI rewrite in the gallery only). `docs/EMAIL_SYSTEM.md` and `docs/ONBOARDING.md` updated (CID logo, `MAIL_REDIRECT_PREFIX`, status block + Try again, phone rules).

## Production-database test caveat and backup/reset/restore

- Suites read the **production** Supabase database and expect the seed values for the `alder-demo` business row; they fail if the row was edited or a phone is bound.
- Before any test run: back up the `alder-demo` businesses row (all columns) and every `business_chats` row for it to `_debug/prod-backup.json` (gitignored). Print only differing column names and row counts, never values.
- Reset the differing columns to the seed values (`supabase/seed.sql` / migrations) and delete only that business's `business_chats` rows. Touch nothing else.
- After the final full test run and before the push: restore the saved rows exactly; confirm by column names and counts only.
- **Back up once per session, before the first reset — never again after it.** `_debug/prod-backup.mjs` writes a single fixed path, so running it a second time captures the *reset* state and overwrites the only copy of the real one. That happened on 2026-11-07 and was recovered from `_debug/businesses-backup.json` and `_debug/business_chats-backup.json` (2026-11-05 snapshots). If a run needs a fresh backup, move the existing file aside first.

## Env files and the test project

- One loader, `lib/env.js`, used by the runner, every suite and every script (`bind`, `tg:commands`, `db:apply`, `live-smoke`). Precedence, highest first: **`process.env` > `.env.test` (only when `TEST_ENV=1`) > `.env.local` > `.env`**. `.env.*` is gitignored; `.env.example` carries names only and must ship.
- `.env` is the production reference. It is never edited to point the tests elsewhere.
- To point the suite at a separate Supabase project: copy `.env.test.example` to `.env.test`, fill it in, run `npm run test:env-check`, then `TEST_ENV=1 npm run db:apply` and `TEST_ENV=1 node tests/run.mjs`. **Full step-by-step: `docs/TEST_PROJECT.md`** (region, keys, pooler string, the free-project pause, and the three follow-ups that only become possible once it works).
- Guard: the runner refuses to start a suite when the resolved `SUPABASE_URL` equals the value in `.env`. The comparison is by value and neither URL is printed. `ALLOW_PROD_TESTS=1` is the explicit opt-out and prints a warning; it exists only until `.env.test` exists. `--seed-check` is exempt (two SELECTs, then exit) so the read-only check keeps working against production — test E8.
- `npm run db:apply` refuses a `DATABASE_URL` that came from the shell unless `TEST_ENV=1`, so a stray export cannot point a schema apply at another database.

## Test workflow

- `node tests/run.mjs [suites...]` — one shared `vercel dev` for the run; suites run sequentially in the listed order. Per-suite seconds and total always print. Flags: `--seed-check` runs the read-only alder-demo seed check only (no tests, exits 1 on mismatch). There is no `--timing` flag — per-suite seconds always print, and any unknown `--flag` is now rejected with exit 1 instead of being silently dropped (test E6). The suites that need no HTTP are `db-wall`, `migrations`, `notify`, `webhook`, `brand`, `outbound`; `vercel dev` and the canary are skipped only when **every** selected suite is in that set, not suite by suite. `TEST_ENV=1` switches the loader to `.env.test`; `ALLOW_PROD_TESTS=1` overrides the production guard.
- During an item, run only the suites you touched. Run `--seed-check` instead of a full baseline run whenever the last recorded green HEAD equals START. Run the full suite once at the end.
- Outbound timeout rule: production code uses 3000 ms always. In tests only, `OUTBOUND_TIMEOUT_MS` is honoured when `VERCEL_ENV` is **exactly `development`** (integer 200–3000); an unset `VERCEL_ENV` is not dev and gets 3000 ms. Fake "hang" durations must stay above it (2500 ms).
- Biggest remaining win is a nearby dedicated test Supabase project. Measured per-test instrumentation (2026-11-06, not committed): lead-api makes 400 Supabase requests in 82.6 s and webhook 450 in 91.5 s; at the measured 192 ms median round trip that is 76.8 s and 86.4 s — i.e. ~93–95 % of each suite is database round-trip time, and the fake Telegram/Resend servers plus the 7 deliberate 1 s hangs account for the rest. `vercel dev` itself is no longer a suite cost: startup is ~10 s (9,972 ms measured today; the 55.8 s baseline figure was a cold `npx` cache, not a fixed cost), and only 4 lead-api tests call it (10, 12, 12b, 14) plus one reachability probe.

## How to create a bind code

- `npm run bind -- <slug>` — reads the same files as everything else (`process.env`, then `.env.test` when `TEST_ENV=1`, then `.env.local`, then `.env`). Mints a single-use code, 24 h expiry, prints the business name, code, expiry and deep link. Delete the row after a test mint.
- The minting lives in `lib/bind-codes.js` (`mintBindCode`), shared with the bot's `/invite`: one alphabet (31 unambiguous characters), 12 characters, 24 h. Two minters would drift.

## How to register commands

- `npm run tg:commands` (set), `npm run tg:commands:info` (list names). Never run `scripts/tg-commands.mjs` directly in tests; test mode blocks real calls.
- Registered commands: `/leads`, `/invite`, `/recipients`, `/help` (the `COMMANDS` array in `scripts/tg-commands.mjs` is the source).

## Env var names in use

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `IP_HASH_SALT`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`, `RESEND_API_KEY`, `MAIL_FROM`, `MAIL_REDIRECT_TO`, `MAIL_REDIRECT_PREFIX`, `SITE_URL`, `DATABASE_URL`, `RESEND_API_BASE`, `TELEGRAM_API_BASE`, `VERCEL_ENV`, `HEALTH_SECRET`, `CRON_SECRET`, `AUTOREPLY_DAILY_CAP` (optional, default 40), `DIGEST_ENABLED` (optional, unset = digest off), `DIGEST_UNTOUCHED_DAYS` (optional, default 14), `RECIPIENTS_MAX` (optional, default 5), `INVITES_MAX` (optional, default 3) (test-only: `TEST_ENV`, `ALLOW_PROD_TESTS`).

- `VERCEL_ENV`: read in `lib/outbound.js` only (`api/review.js` imports `isDev()` from it). Vercel sets it (`production`/`preview`/`development`). Two predicates with opposite polarity, on purpose: `isDev()` is `=== 'development'` and gates everything that WEAKENS a guard (shorter timeout, loopback host) — fail-closed; `testModeActive()` is `!isDeployed() && marker` and decides whether to BLOCK a real send — fail-safe. An unset `VERCEL_ENV` therefore gets production timeouts, real hosts, and still blocks when the marker is present.

- `MAIL_REDIRECT_TO`: when set, every email recipient is redirected there and the subject gets a `[TEST for ...]` prefix. In production this now logs `mail_redirect_active` once per instance; sending is unchanged.
- `AUTOREPLY_DAILY_CAP`: per-business ceiling on customer auto-replies, **default 40**. A 24 h `hit_rate_limit` bucket, so it resets at UTC midnight. Over the cap the reply is skipped and `autoreply_capped` is logged; the lead is still saved and the owner is still alerted. Sized against Resend's free plan — **100 emails/day, 3,000/month; Pro has no daily limit, 50,000/month** (resend.com/pricing, read 2026-11-07). A capped lead still costs one uncapped owner email, so the cap must stay under half the daily limit: 40 → worst case 80, leaving ~20 for review requests and the self-check. 60 would put the worst case at 120.
- `MAIL_REDIRECT_PREFIX`: value `off` removes the `[TEST for ...]` subject prefix; recipients are still redirected.

## Pre-launch checklist (before the first real client)

1. **Remove `MAIL_REDIRECT_TO`** from the Vercel production environment. While it is set, every customer email (auto-reply, review request, owner alert, digest) goes to the redirect address. Confirm it is gone by calling `/api/health` and reading `mail_redirect_active: false` — the code also logs `mail_redirect_active` once per instance and `/api/selfcheck` reports it daily, but none of that stops the redirect.
2. Verify the Resend sending domain, and set `MAIL_FROM` to an address on it (otherwise `sendMail` returns `no_verified_sender` and sends nothing).
3. **Set the Resend plan to match `AUTOREPLY_DAILY_CAP`.** The cap is sized for the free plan (100 emails/day): 40 auto-replies → at most 80 emails a day with the uncapped owner alert. On a paid plan raise both together, or leave the cap at 40 and treat it as a flood brake rather than a quota limit.
4. Move to Vercel Pro (Hobby is non-commercial) — and Pro is what allows more than one cron run a day if the digest ever needs to be hourly.
5. Set `HEALTH_SECRET` and `CRON_SECRET` to **two different values**; `/api/health` takes the first as a header, `/api/selfcheck` and `/api/digest` take either (header or `Authorization: Bearer`). Neither is accepted in the other's place, and both must exist — a missing `HEALTH_SECRET` returns 503 even when `CRON_SECRET` is set.
6. Only then, flip the redirect check to a hard failure (currently it is a warning by decision). That change is not made.
7. Decide the retention window and run `npm run offboard -- <slug>` for anything that should not ship with the client.

## Ops endpoints

- `GET /api/health` — seven event counts for the last hour and the last 24 hours (`created`, `tg_sent`, `tg_failed`, `email_owner_sent`, `email_owner_failed`, `autoreply_failed`, `review_request_failed`) plus `mail_redirect_active`, `webhook_secret_set`, `salt_set`. Numbers and booleans only; no PII, no business names, no env values. Auth: `x-health-secret` compared in constant time; **503 when `HEALTH_SECRET` is unset**, 401 otherwise, 405 for anything but GET.
- `GET /api/selfcheck` — per-business counts for the last 24 h. A `demo` business is messaged when one of its own sends failed **or** `MAIL_REDIRECT_TO` is set while `VERCEL_ENV=production`; an `active` client only when one of its own sends failed. Each message carries that business's numbers only, and only a demo business sees the redirect warning. **If a business has no chat, or none of its sends landed, the same text goes to its `owner_email` instead** — a fallback, never a second copy. Two businesses sharing one inbox get one message per run (worst-first). Clean state sends nothing. The response is `{ ok, sent, emailed, deduped, failed, redirect_active }`, where `failed` is the sum across active businesses.
- `vercel.json` schedules `/api/selfcheck` daily at `0 9 * * *`. Vercel documents **Hobby as one run per day minimum interval** — a more frequent expression fails the deployment — and Pro/Enterprise as once per minute, so daily is legal on every plan (source: https://vercel.com/docs/schedules/cron-jobs/usage-and-pricing, read 2026-11-06). Cron Jobs are marked legacy there in favour of "Schedules".
- Auth: `/api/health` accepts `x-health-secret` = `HEALTH_SECRET` only. `/api/selfcheck` accepts that header **or** `Authorization: Bearer $CRON_SECRET`; the two secrets are independent and neither is accepted in the other's place. Both comparisons are constant-time.
- **Both secrets must be set in Vercel.** `/api/selfcheck` returns **503 when `HEALTH_SECRET` is unset even if `CRON_SECRET` is set** — the health secret is the gate, the cron secret is only the second way to present it. A cron with only `CRON_SECRET` configured therefore fails loudly every day instead of silently doing nothing.
- `GET /api/digest` — daily owner digest, **off unless `DIGEST_ENABLED=1`** (returns `200 {ok:true, enabled:false}` and sends nothing). Same auth as `/api/selfcheck`. For every **active** business (`status` in `demo`/`active`; paused and churned are never messaged) with a bound chat or an `owner_email` it counts the last 24 h — new leads, possible repeats (`duplicate_of` on the `created` event), still-open leads older than 24 h but newer than `DIGEST_UNTOUCHED_DAYS` with no `contacted` event, and failed alerts — and sends one message. **Counts only**: no name, phone, email, note or business name, so the same text is safe by email. A business with 0 new, 0 untouched and 0 failed gets nothing.
- The digest claims `digest:<businessId>` in `rate_limits` for 86 400 s before sending, so a cron retry or a second scheduler finds the slot taken and sends nothing; the email idempotency key is `digest:<businessId>:<date>`. **If nothing reached the business (sent 0 and emailed 0) the claim is released**, so a later run the same day can try again. The window is the last 24 h and the date key is the **UTC day** — a roofer in America/Chicago gets "yesterday evening to this evening" labelled with the UTC date. No per-business timezone arithmetic.
- `vercel.json` also schedules `/api/digest` daily at `0 13 * * *` (selfcheck is `0 9 * * *`; H6 pins both schedules exactly, both daily, both resolving, different hours).
- **Future upgrade path (proposal only, `docs/PROPOSALS.md` §5d):** on Vercel Pro the cron can run hourly. The digest would send only when a business's *local* hour matches its chosen slot, using `businesses.timezone` (already stored), with one claim per business per slot (`digest:<id>:<local-date>:<morning|evening>`). That needs one `summary_schedule` column on `businesses` and a `/summary` command; neither is implemented, and `vercel.json` must keep the single daily entry until the plan is Pro.
- Neither ops endpoint is linked from the site and all three set `Cache-Control: no-store`.

## Multiple recipients (2026-11-07 bundle)

- **Commands.** `/invite` mints one single-use code for the caller's own business — tenancy comes from `business_chats`, never from message text or callback data. `/recipients` lists every phone with one Remove button each.
- **Caps.** 5 bound chats per business (`RECIPIENTS_MAX`) and 3 unused live invites per business (`INVITES_MAX`). `/invite` is also limited to 5 per chat per hour, failing closed (no reply) like the plain-text hint. Over a cap the bot answers with a short plain message.
- **Removal.** Ask once (`x:`), confirm (`X:`), cancel (`v:`). The delete is scoped by business AND row id, so a forged callback from another business finds nothing; the last remaining phone cannot be removed; a second confirm says "already removed" instead of throwing.
- **Labels.** `business_chats.label` is shown when set; otherwise "Recipient N" by bind order (oldest first). Nothing in the list is PII.
- **Binding.** `bindChat` still upserts on `tg_chat_id`: a chat already bound elsewhere gets the existing "you're all set" reply and the code stays unused. One chat belongs to one business, always.
- **Callback grammar.** `x:`/`X:`/`v:` join `c:`/`d:`/`y:`/`n:`/`r:`; all are `<kind>:<uuid>` and the regex rejects anything else before a query runs.

## Alerting behaviour (2026-11-06 bundle)

- **Fallback.** Owner email and Telegram still both send. If exactly one fails the owner already has the alert and nothing else is sent; if **both** fail and less than 2 s of the outbound budget has been spent, each channel that could still work gets one retry, recorded with `meta.fallback = true`. Tests B9-B12.
- **Daily auto-reply cap.** `AUTOREPLY_DAILY_CAP` (default 40) per business, 24 h `hit_rate_limit` bucket, resets at UTC midnight. Over the cap the reply is skipped and `autoreply_capped` is logged; the lead is saved and the owner is still alerted.
- **Possible repeat.** A lead whose phone or email matches one from the same business in the last 30 days gets `duplicate_of` on its `created` event and one line in the owner's Telegram alert. Never blocked, never merged, no detail of the earlier lead. Test B14.

## Security posture (audit 2026-11-06)

- **Secrets:** 116 commits scanned for key-shaped strings (Resend `re_`, JWTs, Telegram tokens, `postgres://user:pass@`, GitHub/AWS/Slack, private-key blocks) — **zero hits**. Only `.env.example` was ever committed and it carries names with empty values. `dist/` and `index.html` contain no key-shaped string; no anon key or service key reaches the browser.
- **Database:** anon gets `42501` on every table and on `v_client_leads`, on INSERT, and on `hit_rate_limit`; the `private` schema answers `PGRST106`. `authenticated` holds no table privileges and no USAGE on `private`. The view is `security_invoker=on`. No policies exist and none are needed (RLS on + revoke-all is deny-by-default).
- **Latent DB risk:** the revoke covers objects created by `postgres` only. Default ACLs for objects created by `supabase_admin` still grant `anon` everything, so a table created outside the migration runner would be world-readable until the next `db:apply` sweep catches it. Create tables only through `supabase/migrations/`.
- **Webhook:** constant-time secret compare, 503 when the secret is unset, 401 on mismatch, tenancy always derived from the chat id (a bound chat cannot act on another business's lead), `callback_data` regex-anchored, chat type must be `private`.
- **Review tokens:** 192-bit, regex-anchored, `no-store`, GET never writes, `/go` redirects to a relative path only, the Google URL is https + host-allowlisted.
- **Headers:** HSTS preload, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, Permissions-Policy, noindex. CSP needs `'unsafe-inline'` because the page and the review page use inline scripts — there is no known injection point, but that removes the backstop.
- **Logging:** every `console.*` in `api/` and `lib/` prints a fixed event name plus an error code. No PII, token, URL or message body.
- Open items are tracked in the list below (#14-#18).

## Commit notes

- `700b13a` (alerts: collapse CR/LF) also carries the owner's pre-existing unstaged edit to `lib/content.js`: the review textarea `border-radius` 6px → 8px. Same file, committed together; the change is intentional.

## Page notes (2026-11-07, third bundle)

- **Hero quality is non-negotiable.** No re-encode, resize, re-tier, replacement, or change to the hero video, its sources, the poster markup or the slider. Measured cost, accepted: **LCP ≈ 4.1 s on simulated mobile**, and the hero `<video>` is 5.87 MB of a 7.8 MB page (71%). Do not "optimise" this without an explicit instruction.
- **A poster preload does not help.** Measured 3 Lighthouse runs each way: baseline LCP 4,247 ms median vs 4,254 ms with `<link rel=preload as=image href=…hero-poster-mobile.avif>`, and the LCP element stays the `<video>` in both. At 390 px the page really uses `hero-poster-mobile.avif` (one request, the preload is reused, no double download); at 1280 px the same tag fetches the mobile poster **and** `hero-poster.avif`, so a bare preload is wrong on desktop. Not applied.
- **The close button in the estimate modal is 40 × 40 and stays that way.** It is below the 44/48 tap-target guidance by choice; Lighthouse's `target-size` audit passes because WCAG 2.2 asks for 24 px. The back button is 50 × 46 and the rest of the controls are ≥ 48.
- **The how-we-work connector is a pseudo-element.** `ol.steps` used to hold `<span class="line"><i></i></span>`, which made the list invalid and failed Lighthouse's `list` audit. It is now `.steps::before` (track) and `.steps::after` (accent fill reading `--p`), verified pixel-identical at 390/768/1280 (0 differing pixels). Accessibility is **1.00** with no failing audits.
- **`assets/css/style.css` and `assets/js/main.js` are gone.** They were the old direction, loaded by nothing, and only README described them; the README lines went with them.

## Known issues / next

1. The suites run against the production database and should move to a separate Supabase project.
2. `businesses` has no country column; the phone default country is US.
3. Logo CID not verified in real Gmail/Outlook/Apple Mail.
4. Telegram button colours show only on clients newer than Feb 2026.
5. Review-page Google handoff on mobile (Maps app vs browser) unverified.
6. ~~Stale comment in `api/review.js` and unused `mailCard` import.~~ **Resolved** in `a9e7bb2`: the header now states GET-never-writes (matches tests D2/D4/I1), and `grep -rn "mailCard" --include=*.js --include=*.mjs .` returns nothing outside `node_modules`. Nothing to do.
7. ~~`/leads` reply does not use the new emoji statuses.~~ **Resolved**: `api/tg.js:52-54` builds the reply with `renderLeadList(leads)`; `lib/content.js:258-269` renders each block through `statusLine()`, which prepends `STATUS_EMOJI` (`lib/content.js:37-44`). Test L1 asserts the spaced format. The line in the "previous bundle" section above is the accurate one; this entry was stale.
8. Domain verification in Resend and removal of `MAIL_REDIRECT_TO` before real clients.
9. Vercel Hobby is non-commercial; Pro needed once a client pays.
10. ~~Double-tap Try again race~~ **Resolved**: the `r:` branch takes a `rate_limits` mutex keyed `retry:<leadId>`, released in a `finally` after the attempt, so a concurrent second tap answers "Nothing to retry." and sends nothing. Test C33 fires two callbacks with `Promise.all` and asserts one email. A proper `review_attempt` counter column would be cleaner; this needs no schema change.
11. ~~Client/server phone minimum mismatch~~ Resolved: North America is `[10, 10]` on both sides now (see follow-up bundle above).
12. Owner bot plan: a second bot could reuse `lib/tg.js` by threading a per-call token (today it reads `TELEGRAM_BOT_TOKEN` from env in `call()`). Not implemented.
13. Live chat idea needs planning (no design yet).
14. `MAIL_REDIRECT_TO` in a production environment silently sends **every** customer email (auto-reply, review request) to the redirect address, with no error anywhere. Nothing in the code refuses it when `VERCEL_ENV=production`. Check the Vercel production env before the next client.
15. No retention or deletion path. `leads.business_id` has no `on delete cascade`, so removing a business needs its leads deleted first; `lead_events`, `review_feedback` and `private.lead_financials` cascade from `leads`. A customer deletion request is manual SQL today.
16. The per-business cap is 200 leads/hour. At two emails per lead that exhausts a Resend free-plan daily quota (100/day) in about 15 minutes, after which owner emails and auto-replies stop while Telegram keeps working. **Partly addressed:** the customer auto-reply now has its own daily ceiling (`AUTOREPLY_DAILY_CAP`, default 40). The owner email is deliberately not capped, so a flood can still exhaust the quota through owner alerts alone.
17. `sharp` 0.34.5 carries libvips/libheif/librsvg advisories (`npm audit`: 1 high). Dev-only image pipeline, fed only local trusted files; the fix is sharp 0.35.5, a breaking change. **Deferred by decision** — revisit before the next image-pipeline run.
18. ~~No observability~~ Partly addressed: `/api/health` (counts on demand) and `/api/selfcheck` (daily, only speaks when something failed). Still missing: an alert when the *check itself* stops running.
19. **The digest's failure line is generic.** `digestCounts` returns one `failed` total, so the
    message says "N messages could not be delivered" rather than naming the kind. The self-check
    does name the kind because it reads the events per business. Splitting the digest count by kind
    is a small change to `digestCounts`, not done here.
20. **A shared owner email loses one business's numbers.** De-duplication keeps one message per
    recipient per run (worst-first) instead of merging two businesses' counts. In production the
    two owner addresses are distinct, so this is theoretical today.
21. `lead_events` has no index on `(kind, created_at)` — only `(lead_id, created_at)`. Every health/selfcheck count is a sequential scan. Fine at this size; add `create index lead_events_kind_created on public.lead_events (kind, created_at desc)` when the table grows. **Schema change, not applied.**
