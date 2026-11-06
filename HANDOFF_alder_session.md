# Alder handoff

Living handoff for continuing sessions. Update after each task bundle. No secrets here — names only.

## Current state

- Branch `db-backend` (never push to `main`).
- Baseline before this bundle: `db-wall 27, lead-api 40, notify 36, webhook 36, review 20, fallback 7, brand 6, outbound 4` (all green).
- Final full run after this bundle: see report (per-suite counts before and after).
- Production is live; suites read the production database (see caveat below).

## What changed in this bundle (bot copy / phone / review)

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

## How to create a bind code

- `npm run bind -- <slug>` — reads `.env` + `.env.local` (process env, then `.env.local`, then `.env`). Mints a single-use code, 24 h expiry, prints the business name, code, expiry and deep link. Delete the row after a test mint.

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
6. Stale comment in `api/review.js` and unused `mailCard` import.
7. `/leads` reply does not use the new emoji statuses. (Still open: the `/leads` list still prints plain status words.)
8. Domain verification in Resend and removal of `MAIL_REDIRECT_TO` before real clients.
9. Vercel Hobby is non-commercial; Pro needed once a client pays.
10. Double-tap Try again race: two concurrent `r:` callbacks can both pass `hasReviewSent`, record both `review_requested` and `review_request_failed`, and leave the message on the error view after an email was sent. The shared Resend idempotency key prevents a duplicate email; a re-check of `hasReviewSent` immediately before sending only shrinks the window, so it was described but not implemented.
11. ~~Client/server phone minimum mismatch~~ Resolved: North America is `[10, 10]` on both sides now (see follow-up bundle above).
12. Owner bot plan: a second bot could reuse `lib/tg.js` by threading a per-call token (today it reads `TELEGRAM_BOT_TOKEN` from env in `call()`). Not implemented.
13. Live chat idea needs planning (no design yet).
