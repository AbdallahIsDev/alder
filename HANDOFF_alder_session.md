# Alder handoff

Living handoff for continuing sessions. Update after each task bundle. No secrets here — names only.

## Current state

- Branch `db-backend` (never push to `main`).
- Baseline before this bundle (pre-bundle code, all green): `db-wall 27, lead-api 44, notify 37, webhook 42, review 21, fallback 7, brand 6, outbound 4` = **188 tests**.
- Final full run after this bundle (all green): `db-wall 27, lead-api 44, notify 37, webhook 42, review 21, fallback 7, brand 6, outbound 7` = **191 tests**. Outbound went 4 → 7 because F5–F7 were added; no test was removed or skipped (191 PASS/FAIL lines in the run log).
- Production is live; suites read the production database (see caveat below).

## What changed in this bundle (test speed)

- Measured before/after, full run, same machine. Before (`_debug/before-run.txt`, pre-bundle code): total **411.4 s**, of which dev-ready 55.8 s; lead-api **125.9 s**, notify 32.9 s, webhook **102.9 s**, review 64.6 s, fallback 16.8 s, db-wall 7.7 s, brand 0.3 s, outbound 0.07 s. After (`_debug/final5-run.txt`): total **304.2 s**; lead-api **85.7 s**, notify 28.3 s, webhook **89.5 s**, review 44.6 s, fallback 16.5 s, db-wall 7.7 s, brand 0.3 s, outbound 0.1 s. The eight suites sum to 272.7 s, so 31.5 s of the 304.2 s is process overhead (npx version check, dev start, canary, cleanup).
- **The 180 s target was NOT met.** 304.2 s total, and 272.7 s even with all startup overhead removed. Nothing in the run log supports a lower figure.
- Earlier drafts of this file carried estimates (lead-api "~40 s", webhook "~80 s", review "~35 s", notify "~20 s", total "~200 s class"). Those were projections, not measurements — no log in `_debug/` records a run with those numbers. The only measured pre-bundle total is 352.3 s (`_debug/timing-warm.txt`, dev-ready 7.4 s), which is a warm-`vercel dev` run of the same pre-bundle code; 411.4 s is the same code with a cold 55.8 s dev start.
- One shared `vercel dev` for all suites; suites run sequentially; dev-ready poll is 60× (fetch 1500 ms timeout + 1000 ms sleep). That poll quantises readiness to 1 s and, in the worst case, can take 150 s, not the 60 s the error message claims.
- `lib/outbound.js` reads `OUTBOUND_TIMEOUT_MS` only when `isDev()` — `isDev()` is `!process.env.VERCEL_ENV || VERCEL_ENV === 'development'`, so an unset value counts as dev; an integer 200–3000 is honoured, anything else falls back to `TIMEOUT_MS` 3000. `tests/run.mjs` sets 1000 for the dev server and for every suite child; fake hang durations went 6000→2500 ms (7 sites: notify A4 + B7; webhook C23, C27, C28 twice, C29). Each hang now costs ~1000 ms of wall time, not 3000: measured A4 2287 ms and B7 2460 ms on a later run. Tests F5–F7 cover the override; 3× stable notify/webhook runs.
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

## Env files and the test project

- One loader, `lib/env.js`, used by the runner, every suite and every script (`bind`, `tg:commands`, `db:apply`, `live-smoke`). Precedence, highest first: **`process.env` > `.env.test` (only when `TEST_ENV=1`) > `.env.local` > `.env`**. `.env.*` is gitignored; `.env.example` carries names only and must ship.
- `.env` is the production reference. It is never edited to point the tests elsewhere.
- To point the suite at a separate Supabase project: create `.env.test` with `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (and `DATABASE_URL` if `npm run db:apply` should build it), then run `TEST_ENV=1 node tests/run.mjs`.
- Guard: the runner refuses to start when the resolved `SUPABASE_URL` equals the value in `.env`. The comparison is by value and neither URL is printed. `ALLOW_PROD_TESTS=1` is the explicit opt-out and prints a warning; it exists only until `.env.test` exists.
- `npm run db:apply` refuses a `DATABASE_URL` that came from the shell unless `TEST_ENV=1`, so a stray export cannot point a schema apply at another database.

## Test workflow

- `node tests/run.mjs [suites...]` — one shared `vercel dev` for the run; suites run sequentially in the listed order. Per-suite seconds and total always print. Flags: `--seed-check` runs the read-only alder-demo seed check only (no tests, exits 1 on mismatch). There is no `--timing` flag — per-suite seconds always print, and any unknown `--flag` is now rejected with exit 1 instead of being silently dropped (test E6). The suites that need no HTTP are `db-wall`, `migrations`, `notify`, `webhook`, `brand`, `outbound`; `vercel dev` and the canary are skipped only when **every** selected suite is in that set, not suite by suite. `TEST_ENV=1` switches the loader to `.env.test`; `ALLOW_PROD_TESTS=1` overrides the production guard.
- During an item, run only the suites you touched. Run `--seed-check` instead of a full baseline run whenever the last recorded green HEAD equals START. Run the full suite once at the end.
- Outbound timeout rule: production code uses 3000 ms always. In tests only, `OUTBOUND_TIMEOUT_MS=1000` is honoured when `VERCEL_ENV` is unset or `development` (integer 200–3000); fake "hang" durations must stay above it (2500 ms).
- Biggest remaining win is a nearby dedicated test Supabase project. Measured per-test instrumentation (2026-11-06, not committed): lead-api makes 400 Supabase requests in 82.6 s and webhook 450 in 91.5 s; at the measured 192 ms median round trip that is 76.8 s and 86.4 s — i.e. ~93–95 % of each suite is database round-trip time, and the fake Telegram/Resend servers plus the 7 deliberate 1 s hangs account for the rest. `vercel dev` itself is no longer a suite cost: startup is ~10 s (9,972 ms measured today; the 55.8 s baseline figure was a cold `npx` cache, not a fixed cost), and only 4 lead-api tests call it (10, 12, 12b, 14) plus one reachability probe.

## How to create a bind code

- `npm run bind -- <slug>` — reads the same files as everything else (`process.env`, then `.env.test` when `TEST_ENV=1`, then `.env.local`, then `.env`). Mints a single-use code, 24 h expiry, prints the business name, code, expiry and deep link. Delete the row after a test mint.

## How to register commands

- `npm run tg:commands` (set), `npm run tg:commands:info` (list names). Never run `scripts/tg-commands.mjs` directly in tests; test mode blocks real calls.

## Env var names in use

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `IP_HASH_SALT`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`, `RESEND_API_KEY`, `MAIL_FROM`, `MAIL_REDIRECT_TO`, `MAIL_REDIRECT_PREFIX`, `SITE_URL`, `DATABASE_URL`, `RESEND_API_BASE`, `TELEGRAM_API_BASE`, `VERCEL_ENV`.

- `VERCEL_ENV`: referenced in `lib/outbound.js` and `api/review.js`; Vercel sets it (`production`/`preview`/`development`). The `*_API_BASE` overrides are honoured only when it is unset or `development`.

- `MAIL_REDIRECT_TO`: when set, every email recipient is redirected there and the subject gets a `[TEST for ...]` prefix.
- `MAIL_REDIRECT_PREFIX`: value `off` removes the `[TEST for ...]` subject prefix; recipients are still redirected.

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
10. Double-tap Try again race: two concurrent `r:` callbacks can both pass `hasReviewSent`, record both `review_requested` and `review_request_failed`, and leave the message on the error view after an email was sent. The shared Resend idempotency key prevents a duplicate email; a re-check of `hasReviewSent` immediately before sending only shrinks the window, so it was described but not implemented.
11. ~~Client/server phone minimum mismatch~~ Resolved: North America is `[10, 10]` on both sides now (see follow-up bundle above).
12. Owner bot plan: a second bot could reuse `lib/tg.js` by threading a per-call token (today it reads `TELEGRAM_BOT_TOKEN` from env in `call()`). Not implemented.
13. Live chat idea needs planning (no design yet).
