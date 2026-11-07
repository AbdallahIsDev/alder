# Operations runbook

What to do when a business joins, leaves, adds a phone, or something breaks.
Every command and env name here was checked against the code in this repo.
No secret values appear anywhere in this document — names only.

Related: `docs/ONBOARDING.md` (the long version of step 1), `docs/TEST_PROJECT.md`
(pointing the suite at a separate Supabase project), `HANDOFF_alder_session.md`
(what changed and why).

---

## 1. Onboard a business

The full walkthrough is `docs/ONBOARDING.md`. The short version:

1. **Create the row** in `public.businesses` (Supabase SQL editor, service role):
   `slug`, `name`, `status` (`active` or `demo`), `timezone`, `owner_email`,
   `google_review_url`. Never insert from a browser — the anon key cannot.
2. **Mint a code**: `npm run bind -- <slug>`. It prints the business name, a
   single-use 12-character code, the 24 h expiry and a `https://t.me/<bot>?start=<code>`
   deep link.
3. **The roofer sends `/start <code>`** to the bot (or opens the deep link).
   The webhook claims the code once and writes one `business_chats` row.
4. **Send a test lead** through the site's modal with a real phone number, then check
   `/api/health`: `last_24h.created` and `last_24h.tg_sent` should both be at least 1.
5. **Mail settings**: `MAIL_FROM` must be an address on a domain verified in Resend,
   and `MAIL_REDIRECT_TO` must be **absent** in production (see §7).
6. **Commands**: after the first deploy that adds or renames a command, run
   `npm run tg:commands` once (see §7).

A business with `status` `paused` or `churned` is never messaged: the digest and the
self-check only target `demo` and `active` rows, and `getActiveBusinessBySlug` refuses
to serve its page.

## 2. Offboard a business, or delete one lead

Both scripts are **dry runs by default**: they print per-table counts and delete
nothing. Deleting needs `--yes` **and** `--confirm <same slug or id>`, and they refuse
to touch the database named in `.env` unless `--i-know-this-is-prod` is also passed.

```bash
npm run offboard -- alder-demo                                  # counts only
npm run offboard -- alder-demo --yes --confirm alder-demo --i-know-this-is-prod
npm run delete:lead -- 3f2a1c9e-…                               # counts only
npm run delete:lead -- 3f2a1c9e-… --yes --confirm 3f2a1c9e-… --i-know-this-is-prod
```

Deletion order (children first, so a part-way failure is visible):

1. `public.lead_events`, `public.review_feedback`, `private.lead_financials`
2. `public.leads`
3. `public.business_chats`
4. `public.bind_codes`
5. `public.businesses`

`leads.business_id` has **no** `on delete cascade`, so removing a business by hand
would fail while its leads exist — that is why the order above matters. Every
statement filters by `business_id` or the slug's id; no other business is touched, and
the offboard dry run prints how many other businesses exist before and after.

Test debris from the suites can be swept with `scripts/sweep-demo-leads.mjs` (also a
dry run; `--before`, `--include-suite`, `--include-nojs`). It never touches a lead that
has a `review_token`.

## 3. Add or remove a phone

**Add.** A chat that is already bound sends `/invite`. The bot mints one single-use
code for **that chat's business** and prints `/start <code>`. The second phone sends
it; it becomes a second `business_chats` row and receives every alert from then on.

Caps (env-overridable, `RECIPIENTS_MAX` / `INVITES_MAX`):

- 5 bound phones per business, 3 unused live invites per business;
- `/invite` itself is limited to 5 per chat per hour and fails closed (no reply).

**Remove.** `/recipients` lists every phone as "Recipient 1, 2, …" (or the stored
`business_chats.label` when set) with one **Remove** button each. Removing asks once;
the last remaining phone cannot be removed. A second tap on an already-removed row
answers "already removed" and changes nothing.

A chat belongs to exactly one business. Sending a code from a chat that is already
bound elsewhere answers "You're all set" and leaves the binding alone; the code stays
unused.

## 4. Reading the alerts

| Where | What it means | What to do |
|---|---|---|
| Alert check, `⚠️ Needs attention` / "N alerts could not be delivered" | `tg_failed` over 24 h for **that business** is non-zero | open `/api/health` and read `last_24h`; §5 |
| Alert check, "N alert emails to you did not go out" | `email_owner_failed` for that business | check Resend and the sender domain; §5 |
| Alert check, "N confirmation emails to a customer failed" | `autoreply_failed` for that business | the customer got no acknowledgement; §5 |
| Alert check, "N review requests to a customer failed" | `review_request_failed` for that business | the owner can retry from the bot; §5 |
| Alert check, "⚠️ Test mode is on …" | `MAIL_REDIRECT_TO` is set while `VERCEL_ENV=production` | remove it (§7). Demo businesses only — a client never sees this line |
| Digest section `⚠️ Needs attention` | the same four kinds, same 24 h window, for that business | same as above |
| `/api/health` → `mail_redirect_active: true` | `MAIL_REDIRECT_TO` is set, in **any** environment | if production, remove it |
| `/api/health` → `webhook_secret_set: false` | `TELEGRAM_WEBHOOK_SECRET` missing → `/api/tg` answers 503 | set it (§6) |
| `/api/health` → `salt_set: false` | `IP_HASH_SALT` missing → `/api/lead` answers 500 | set it (§6) |
| Log line `owner_alert_fallback` | both owner channels failed and each was retried once | check Telegram and Resend |
| Log line `autoreply_capped` | the business hit `AUTOREPLY_DAILY_CAP` (default 40) | expected on a flood; raise the cap or the plan |
| Log line `mail_redirect_active` | first send in production with a redirect configured | remove the redirect |

**Who receives what.** Every message carries only the counts of the business that
receives it. A business with status `demo` is the operator's own: it also gets the
redirect warning and, in a clearly separated last line, the setting name. A business
with status `active` is a client: it hears from us only when one of its own sends
failed, and it never sees operator text. Two businesses that share an owner email get
one message per run, not two — the one with more failures wins, and the response's
`deduped` count records the suppressed copy.

`/api/health` and `/api/selfcheck` and `/api/digest` all answer **503 when
`HEALTH_SECRET` is unset**, even if `CRON_SECRET` is set. `/api/health` takes
`x-health-secret`; the other two also accept `Authorization: Bearer $CRON_SECRET`.

## 5. Incident playbooks

**Telegram down, or the bot token revoked.**
Symptom: `last_24h.tg_failed` climbing, `tg_sent` flat, the owner gets the email
fallback instead (or `owner_alert_fallback` in the logs).
Check the token: `node scripts/tg-webhook.mjs info` prints `ok`, `status` and the
webhook **host** only. If Telegram rejects the token, create a new one in BotFather
(`/revoke`), then follow §6 for `TELEGRAM_BOT_TOKEN` and re-register the webhook.

**Resend quota hit.**
Symptom: `email_owner_failed` / `autoreply_failed`, and Resend returns 429.
The free plan allows 100 emails a day. Each lead costs up to two: one owner alert
(never capped) and one auto-reply (capped by `AUTOREPLY_DAILY_CAP`, default 40), so
the worst case at the default is 80 a day. Options: raise the Resend plan, or lower
`AUTOREPLY_DAILY_CAP` — the owner alert is deliberately never capped, so the cap only
bounds the customer half.

**Supabase down or paused.**
Symptom: every endpoint 500s; `/api/health` returns 500 with `health_query_failed`;
`/api/lead` answers 500 and logs `lead_insert_failed`, so the customer sees the
failure — the lead is **not** stored, and there is no local buffer to replay.
Free Supabase projects pause after a period of inactivity — restore the project in the
dashboard, then confirm `/api/health` returns 200 and `last_24h.created` is sane.
Nothing in the app buffers leads while the database is unreachable.

**Webhook secret rotated, or Telegram starts returning 401.**
Every update is rejected until the registered secret matches. Set the new
`TELEGRAM_WEBHOOK_SECRET` in Vercel, redeploy, then re-register so Telegram starts
sending the new header:

```bash
node scripts/tg-webhook.mjs set https://<host>/api/tg
```

**Leaked secret.**
Rotate the specific secret (§6), redeploy, and check the endpoint that uses it. A
leaked `SUPABASE_SERVICE_ROLE_KEY` is the worst case: rotate it in Supabase first, then
Vercel, then redeploy — the old key stops working the moment it is rotated, so expect a
short outage until the new value is live.

## 6. Rotating a secret

Every secret lives in two places at most: the Vercel project env (Production, and
Preview if previews should work) and the local `.env` / `.env.local` used by the
scripts and the test suite. Rotate in this order: provider → Vercel → redeploy →
verify.

| Secret | Change it in | Also | Verify | Breaks in between |
|---|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather `/revoke`, then Vercel env | re-register the webhook: `node scripts/tg-webhook.mjs set https://<host>/api/tg` | `node scripts/tg-webhook.mjs info` → `ok=true`; send `/help` from a bound chat | every send fails with 401 until the redeploy; `tg_failed` climbs |
| `TELEGRAM_WEBHOOK_SECRET` | Vercel env (and local `.env` for the script) | re-register: `node scripts/tg-webhook.mjs set https://<host>/api/tg` | Telegram delivers again; `/api/health` → `webhook_secret_set: true` | `/api/tg` answers 401 to every update; Telegram retries for a while, then drops |
| `HEALTH_SECRET` | Vercel env | — | `curl -H "x-health-secret: …" /api/health` → 200 | 503 if unset, 401 if the caller still has the old value |
| `CRON_SECRET` | Vercel env | — | the next scheduled run returns 200 (check Vercel logs) | the cron bearer is refused; `/api/selfcheck` and `/api/digest` answer 401 |
| `IP_HASH_SALT` | Vercel env | — | `/api/health` → `salt_set: true`; submit one lead | `/api/lead` 500s while missing; after a change every rate-limit key is new, so counters reset (no data is lost) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → API keys, then Vercel | — | `/api/health` 200 | every function 500s until the redeploy |
| `SUPABASE_ANON_KEY` | Supabase dashboard, then Vercel if any surface uses it | — | `tests/db-wall.test.mjs` still proves the anon wall | nothing user-facing (no client code uses it) |
| `RESEND_API_KEY` | Resend dashboard, then Vercel | — | `node scripts/live-smoke.mjs --live` | every email fails with 401; Telegram keeps working |
| `DATABASE_URL` | Supabase (session pooler URI) → local `.env` only | — | `npm run db:apply` connects | the migration and delete scripts stop; the functions do not use it |

`node scripts/live-smoke.mjs --live` sends one real Telegram message and one real
email. It refuses to run while `.test-mode` exists or either `*_API_BASE` override is
set, so it cannot be pointed at a fake by accident.

## 7. Post-merge checklist

1. **Set every variable in both scopes.** Vercel → Project → Settings → Environment
   Variables: Production **and** Preview. A preview deployment with a missing
   `SUPABASE_URL` or `HEALTH_SECRET` fails exactly like production would.
2. **Remove `MAIL_REDIRECT_TO`** from Production, then confirm
   `/api/health` → `mail_redirect_active: false`.
3. **Run `npm run tg:commands`** after the first deploy that adds a command. The menu
   is `/leads`, `/invite`, `/recipients`, `/help`; the script also sets the bot
   description and short description. `npm run tg:commands:info` lists what is live.
4. **Enable the digest** with `DIGEST_ENABLED=1` (it is off by default), redeploy, then
   `curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/digest` → the body
   has `"enabled": true`. The first message goes out at the next 13:00 UTC run; until
   then the endpoint is the only way to see it. Leave it unset to keep the digest off.
5. **Read `/api/health`** once after the deploy: `webhook_secret_set` and `salt_set`
   must both be `true`, and `last_hour.created` tells you whether leads are arriving.

## 8. Known limitations

- **The digest uses the UTC day.** A roofer in America/Chicago gets "yesterday evening
  to this evening" labelled with the UTC date. There is no per-business timezone
  arithmetic; doing it properly needs a `digest_hour` column and an hourly cron (Pro).
- **Hobby crons run once a day.** Both scheduled jobs are daily for that reason. A more
  frequent expression fails the deployment rather than silently skipping runs.
- **The tests run against the production database** until `.env.test` exists. The
  runner backs up and restores `alder-demo` around a run; `ALLOW_PROD_TESTS=1` is the
  explicit opt-out of the guard. See `docs/TEST_PROJECT.md`.
- **WhatsApp is not supported.** Its Business API needs a business account, is paid,
  and only allows free-form messages inside a 24-hour window opened by the customer —
  a lead alert arrives outside that window, so it would need pre-approved templates.
  Telegram has none of those constraints.
- **No queue for alerts.** If both Telegram and email fail for a lead, the lead is
  still stored and both failures are recorded as events; nothing retries later.
- **A shared inbox gets one message.** Two businesses with the same `owner_email` are
  de-duplicated per run, worst-first. The second business's numbers are not merged into
  the message, so its counts are missing from that run. Distinct inboxes are the normal
  case; this only bites an operator running several demo businesses on one address.
- **The self-check is per business but its window is global.** Each message counts the
  last 24 h for that business only, so two messages can cover slightly different
  windows if the run takes long enough to cross a second boundary. At this size it does
  not happen; it would at hundreds of businesses.
