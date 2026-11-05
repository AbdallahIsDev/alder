# Alder handoff

Living handoff for continuing sessions. Update after each task bundle. No secrets here — names only.

## Current state

- Branch `db-backend` (never push to `main`).
- Baseline before this bundle: `db-wall 27, lead-api 31, notify 32, webhook 21, review 20, fallback 7, brand 5, outbound 4` (all green).
- Final full run after this bundle: see report (per-suite counts before and after).
- Production is live; suites read the production database (see caveat below).

## What changed in this bundle

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

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `IP_HASH_SALT`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`, `RESEND_API_KEY`, `MAIL_FROM`, `MAIL_REDIRECT_TO`, `MAIL_REDIRECT_PREFIX`, `SITE_URL`, `DATABASE_URL`, `RESEND_API_BASE`, `TELEGRAM_API_BASE`.

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
