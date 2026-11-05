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
in `.env` (or the environment):

```bash
npm run bind -- <slug>
```

The script prints exactly four lines to stdout — the business name, a single-use
12-character code, its expiry (24 hours), and a `https://t.me/<bot>?start=<code>`
deep link. Every failure is one `bind: …` line to stderr with exit 1 and no
code is minted.

Send the roofer the deep link (or the code itself). They open the link and send
`/start <code>` to the bot, or send the bare code. The webhook claims the code
once — one update, one `business_chats` row — and the roofer's chat is bound to
that business. An expired or reused code binds nothing and says so in the chat.

Codes are minted only by this local script. No public endpoint creates them.

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
- An invalid phone is a 400 on the server and never stored.
- The anon key still cannot read or write `businesses`, `bind_codes`, or
  `leads` (`tests/db-wall.test.mjs` proves the wall; run it through
  `node tests/run.mjs`).
- If the bind code was never claimed, the business has no chat binding and
  the owner sees a `tg_failed` event — a prompt to rerun `npm run bind`.

Env var names the code reads (never values): `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`, `RESEND_API_KEY`, `MAIL_FROM`,
`MAIL_REDIRECT_TO`, `SITE_URL`, `IP_HASH_SALT`.
