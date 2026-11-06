# Onboarding a roofer

How a new business gets a lead page, a Telegram link, and the first test lead.
No secrets, no pricing — only the steps and the env var names.

- **Create the business row** — one row per roofer.
- **Mint a bind code** — `npm run bind -- <slug>`.
- **Link the Telegram chat** — the roofer sends the code to the bot.
- **Send a test lead** — one lead end to end.
- **What to check** — the quiet verifications.

---

## Create the business row

In the Supabase SQL editor (service role, never the anon key), add one row to
`public.businesses`:

- `slug` — the subdomain slug, e.g. `acme-roofing` (lowercase letters,
  digits, hyphens, 2 to 60 chars).
- `name` — the business name as the customer should see it.
- `status` — `active` (or `demo` for the practice site).
- `timezone` — e.g. `America/Chicago`.
- `owner_email` — the owner's email for lead alerts.
- `google_review_url` — the Google review link (https).

The seed (`supabase/seed.sql`) shows a demo row. Never insert a business
through the anon key or from a browser — the anon wall rejects it by design.

The site build reads its own tokens from `index.html` and
`lib/brand.generated.json`; the business row only supplies the name, timezone,
owner email and review link above. Run `npm run build` after any page change.

## Mint a bind code

From the repo root, with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set
in `.env.local` (preferred) — otherwise in `.env` or the environment —
a non-empty value already in the environment wins, then `.env.local`,
then `.env`:

```bash
npm run bind -- <slug>
```

The script prints exactly four lines to stdout — the business name, a single-use
12-character code, its expiry (24 hours), and a `https://t.me/<bot>?start=<code>`
deep link. Every failure is one `bind: …` line to stderr with exit 1 and no
code is minted. A missing variable names the missing variable(s) only; an
unknown slug lists the valid slugs (slug and status only).

Send the roofer the deep link (or the code itself). They open the link and send
`/start <code>` to the bot, or send the bare code. The webhook claims the code
once — one update, one `business_chats` row — and the roofer's chat is bound to
that business. An expired or reused code binds nothing and says so in the chat.

Codes are minted only by this local script. No public endpoint creates them.

## Telegram menu and buttons

The bot menu has exactly two entries (names only, no secrets):

- `leads` — Your latest requests
- `help` — How this bot works

After deploy, run `npm run tg:commands` once: it sets the two commands plus
the bot description and short description (`setMyDescription` /
`setMyShortDescription`); print the names afterwards with
`npm run tg:commands:info`. The profile photo is set manually in BotFather
with `/setuserpic`. Every bot message reads as if the bot belongs to this
one business only. Unlinked chats get the "not connected" message and never
any business data. Plain (non-command) text gets a short hint, at most 3 per
chat per hour.

Inline buttons use the Bot API `style` field (only `primary`, `success`,
`danger` exist; older clients ignore it):

- Mark contacted — `primary`
- Job completed — `primary`
- Send request — `success` ("Mark done" when the lead has no email)
- Cancel — `danger`
- Try again — `primary` (only after a failed review email; resends the
  review email with the existing token, never changes status)

## Send a test lead

Open the client's page (or the demo), run through the estimate modal with a
real phone number, and submit. Check, in order:

1. The success view appears (thanks, recap, Close and Call).
2. One row appears in `leads` with the phone stored as E.164.
3. The owner gets an email ("New estimate request") and the Telegram alert
   points at the bound chat.
4. The customer gets the auto-reply; the review request carries one
   "Share your feedback" link to `/r/<token>`.

## What to check

- The phone lands as E.164 (e.g. `+15155550142`), never bare digits.
- An invalid phone is a 400 on the server and never stored. The server uses
  `libphonenumber-js/max` (real per-country patterns), and the modal caps
  digits per calling code from the same metadata (inlined at build time by
  `build-static.js`). A leading `00` works like `+`; one trunk `0` after the
  calling code is accepted and removed (Italy keeps its zero); North American
  numbers must have exactly 10 national digits. A 400 that names the phone
  shows "Enter a valid phone number." under the field and stays on step 4.
- Emails carry the logo as a CID inline image (attached by `lib/mail.js`
  from `logo.onDarkB64` in `lib/brand.generated.json`); the hosted PNGs in
  `assets/email/` are for the preview gallery only. `MAIL_REDIRECT_PREFIX`
  set to `off` removes the `[TEST for ...]` subject prefix while recipients
  are still redirected via `MAIL_REDIRECT_TO` (names only here, never values).
- The anon key still cannot read or write `businesses`, `bind_codes`, or
  `leads` (`tests/db-wall.test.mjs` proves the wall; run it through
  `node tests/run.mjs`).
- If the bind code was never claimed, the business has no chat binding and
  the owner sees a `tg_failed` event — a prompt to rerun `npm run bind`.

Env var names the code reads (never values): `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`, `RESEND_API_KEY`, `MAIL_FROM`,
`MAIL_REDIRECT_TO`, `SITE_URL`, `IP_HASH_SALT`.
