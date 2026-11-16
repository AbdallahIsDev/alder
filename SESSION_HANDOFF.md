# Alder — session handoff

The one handoff file. It replaces `alder-session-history.md` and
`HANDOFF_alder_session.md`, which were deleted on 2026-11-16 after their live
content was folded in here. Everything below describes **the code as it is now**
and **what is planned next**; the per-branch history that used to fill this file
is gone on purpose, except for a short log at the end.

> **Update rule (binding):** every task ends by editing this file. If a fact in
> here stopped being true — a column, a command, a duration, a limit, a decision —
> change it in the same task, not later. `AGENTS.md` carries the same rule for any
> agent working in this repo. Never write a secret value in this file; names only.

**Last updated:** 2026-11-17.

---

## 1. How we work

| Role | Who | Does |
|---|---|---|
| **Owner** | The human (Cairo, GMT+2; Windows) | Decides, tests on real phones, creates accounts and secrets, relays prompts and reports |
| **Orchestrator** | A cloud assistant | Never touches the repo. Writes prompts, reviews reports and diffs, keeps the queue |
| **Agent** | Local or cloud, works in the repo | Reads and changes code, runs tests, commits, pushes branches, opens PRs, writes reports |

The loop: the owner states a goal → the orchestrator writes **one** complete
prompt → the agent works and reports → the owner pastes the report back → the
orchestrator reviews and writes the next prompt.

Rules every prompt carries:

- Never push to `main`, never force, no tags. Push dry-run first.
- One review artefact per task: `_debug/patches/<branch>-review.diff`
  (`git diff origin/main...<branch>`), with its byte size, line count, an
  apply-check against a fresh `origin/main` worktree, and a secret scan (counts
  only). No `.patch`, no per-area splits.
- Every behaviour change gets a test **and** a mutation check: break the code,
  show the test fails, revert.
- Never weaken an assertion without recording its before/after meaning.
- Schema changes ship as a numbered migration file; the agent applies it to the
  TEST project, the **owner** applies it to production.
- Never print secret values, chat identifiers, bind codes, or lead data.
- Final report: critical items first, commit hashes, tests run and which database,
  what was **not** verified, `git status`.

Review discipline: read the agent's report, then the diff line by line. Look for
unhandled rejections, fail-open paths, module-level state across warm invocations,
PII in logs or messages, cross-tenant leaks, idempotency-key collisions, tests
that assert too little, dead code, stale comments.

**Vercel CLI rule.** Never run `vercel dev` or any Vercel CLI command from a
directory with no `.vercel` link, and never create or link a project while
probing. `vercel dev` in an unlinked directory creates a project on the account,
and in a directory with `.env` it gives that file precedence. The test runner
avoids both by starting from a dev root with a copied `.vercel/project.json` and
no `.env` (`tests/dev-root.mjs`).

---

## 2. Decisions already made — do not re-litigate

**Architecture**

- **A is the direction: one shared deployment, one Host-routed tenant.** B (a
  separate project per client) stays possible as an escape hatch for a client
  needing a custom UI or a separate SEO surface. Nothing may block either.
- The tenant comes from the request `Host` only, resolved by `resolveTenant()` in
  `lib/tenant.js` against `businesses.site_host`. Body `slug`, `business_id`,
  query, cookies and `X-Forwarded-Host` are never tenant selectors.
- Per-client settings are **data**, not code. No `if (client === ...)`.
- One shared Telegram bot serves every client. One Telegram account belongs to one
  business, always, through `business_chats.tg_chat_id` (unique).

**Product**

- Telegram is the channel; email is the universal fallback. WhatsApp is not built.
- Owner = the oldest connected phone. Only it may invite or remove phones; staff
  phones read leads and nothing else.
- The operator is a separate private chat (`OPERATOR_CHAT_ID`), never a business
  binding. Operator text never reaches an owner chat.
- Alerts are best-effort. A guaranteed outbox is a future implementation, not a
  current promise.
- Review flow: everyone is sent to the Google review link, whatever the rating.

**Lifecycle and money**

- Every duration lives in `lib/lifecycle-config.js` and nowhere else: reminder at
  D−3, grace 5 days, suspended 10 days, termination at D+15, one payment = 30
  days, data kept 60 days. A test (Gate BL) fails if a duration is written
  anywhere else.
- `paid_until` NULL means **not billing-enforced**. Nothing is charged, warned or
  suspended for that business.
- Termination is the existing status `churned`, displayed as "Terminated". Nothing
  is ever deleted by the code; Extend or Reactivate brings a business back.
- A held lead keeps its date order in `/leads` after reactivation; it is marked
  with a fourth `held` line, not split into a separate section. One page header
  counts the held rows on that page and one detail fact names the state.
- A suspended business's form **holds** leads: stored whole with `leads.held_at`,
  owner told a count and no detail, visitor told to call. A terminated business's
  form answers 410 and stores nothing.
- Retention is 60 days after termination, kept **by hand**. There is no purge job.
  To be reviewed by a lawyer; drafts in `docs/legal-drafts/`.

**Landing page**

- Hero video quality is non-negotiable. No re-encode, resize, replacement or
  slider change without an explicit instruction. Measured cost accepted:
  LCP ≈ 4.1 s on simulated mobile.
- The estimate form's close button is 32 px with a 44 px press area (owner
  decision 2026-11-16; it was 40 px). A click outside the form does not close it.
- Copy is plain, human and specific. No staccato fragments ("No fluff. Just
  results."), no comma-couplets used as a sentence, no colon-fragment openers.
  Full sentences with a reason in them.

---

## 3. The project

**Alder** is a lead platform for roofing contractors. A homeowner fills a
multi-step estimate form; the contractor is alerted on **Telegram** (with buttons)
and by **email**; the system auto-replies to the customer, can request a Google
review, sends daily operational summaries, and enforces a monthly subscription.

| Item | Value |
|---|---|
| Repo | `https://github.com/AbdallahIsDev/alder` |
| Local path | `C:\Users\11\projects\Roofing-2` |
| Live site | `https://alder-roofing.vercel.app` (deploys from `main`) |
| Bot | `@getleadalerts_bot` |
| Hosting | Vercel **Hobby** — each cron job runs at most daily, and commercial use needs a paid plan |
| DB | Supabase Postgres, `us-east-1` (~192 ms median from Cairo) |
| Email | Resend |
| Local dev | `npx vercel@48.12.1 dev` on port 3000 (pinned) |

Commands: `npm run build` (bake a client config into `dist/`), `images`, `icons`,
`og`, `db:apply`, `bind -- <slug>`, `tg:commands` / `tg:commands:info`,
`purge:expired`, `delete:lead`, `offboard`, `test:env-check`, `test:port-guard`.
Tests: `node tests/run.mjs [suites...]`.

Key files: `api/{lead,tg,review,health,selfcheck,digest,billing}.js`;
`lib/{db,tenant,lead-intake,notify,outbound,content,operator,billing,billing-ops,service-status,lifecycle-config,lifecycle-text,lifecycle-notify,held-leads,notice-audit}.js`;
`supabase/migrations/0001..0007`; `index.html`; `build-static.js`; `clients/*.json`;
`docs/`.

Migrations, all additive and idempotent: `0001_init`, `0002_default_privileges`,
`0003_service_role_grants`, `0004_lead_event_kinds`, `0005_business_site_host`,
`0006_business_billing`, `0007_lifecycle`.

**Environment (names only).** Required in Vercel: `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `IP_HASH_SALT`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `RESEND_API_KEY`, `MAIL_FROM`,
`SITE_URL`, `HEALTH_SECRET`, `CRON_SECRET`, `OPERATOR_CHAT_ID`, `OPERATOR_EMAIL`.
Optional: `TELEGRAM_CHAT_ID`, `MAIL_REDIRECT_TO`, `MAIL_REDIRECT_PREFIX`,
`AUTOREPLY_DAILY_CAP`, `DIGEST_ENABLED`, `DIGEST_UNTOUCHED_DAYS`,
`RECIPIENTS_MAX`, `INVITES_MAX`, `TELEGRAM_BOT_USERNAME`, `DATABASE_URL`,
`TENANT_HOST_MAP` (JSON host aliases; ignored in production). Test-only:
`.env.test` plus `TEST_ENV=1`. One loader, `lib/env.js`: `process.env` >
`.env.test` (only when `TEST_ENV=1`) > `.env.local` > `.env`.

---

## 4. Architecture and invariants

**Data and access**

- RLS is on everywhere with deny-all and no policies; the app uses the service
  role server-side only. `v_client_leads` is `security_invoker`.
- Roofer-facing code never `SELECT`s directly from `leads` (test C10). That is why
  `findRecentDuplicate` and `digestCounts` live in their own modules.
- `leads.business_id` has no `ON DELETE` action, so offboarding deletes leads
  first. `lead_events`, `review_feedback` and `private.lead_financials` cascade.
- Bind codes: single use, 24 h, one minting function (`lib/bind-codes.js`).

**Telegram**

- The business is derived from `business_chats.tg_chat_id` on every update; the
  binding is never cached.
- Every callback is anchored-regex validated before a query runs, and every lead
  read, transition and delete is scoped by `id` **and** `business_id`.
- Transitions are conditional UPDATEs, so a stale tap cannot overwrite a newer
  state.
- No `parse_mode` anywhere (test C40). Messages are plain text plus explicit
  `entities`; links are `text_link` entities.
- Button labels are plain text. `BUTTON_ICONS` is an empty frozen table and
  `iconLabel()` returns the bare label — that is the seam for custom emoji later,
  not a missing feature.
- One `[tg-timing]` JSON log line per update (`lib/timing.js`): handler name,
  cold-start flag, region, total ms, DB/Telegram step timings. Fixed names and
  numbers only; it never reads call arguments or results.
- Tap rules: the toast goes out together with the edit once its text is known; the
  lead and business rows are read side by side; the owner check runs alone, before
  the read or write it guards.

**Email**

- One shared layout (`lib/email-builders.js` registry, `shell()` with
  `data-alder-layout="1"`). The logo is a referenced `cid:brand-logo`, never an
  unreferenced attachment.
- Emoji are stripped at the builder boundary. One lockup: platform brand for
  owner/ops mail, company brand for customer mail.
- `MAIL_REDIRECT_TO` redirects **every** recipient and prefixes the subject. It is
  loud, not a hard failure, until the first real client.

**Secrets and limits**

- `HEALTH_SECRET` and `CRON_SECRET` are different values, compared in constant
  time. `/api/selfcheck` and `/api/digest` return 503 when `HEALTH_SECRET` is
  unset even if `CRON_SECRET` is set.
- `OUTBOUND_TIMEOUT_MS` and `*_API_BASE` are honoured only when `VERCEL_ENV` is
  exactly `development`. An unset value is not dev.
- `BIZ_LIMIT` 200 leads/hour per business; `AUTOREPLY_DAILY_CAP` 40/day per
  business; 5 phones per business; 3 live invites per business; 10 invites per
  business per hour.

---

## 5. What exists today

**Landing page** — one self-contained `index.html` (inline CSS/JS, serialized DOM
with `data-page-node-id`). Client copy and values come from `clients/<slug>.json`
and are baked by `build-static.js`, which also generates `robots.txt` and
`sitemap.xml` from the client's domain. Sections: header, hero (video), stats,
about, services, how we work, projects, reviews, FAQ, CTA, footer, estimate modal.
The debug panel and the hero switches are still in every build but gated by a
`DEV` flag: they run only on `localhost`/`file://`, or on any host with
`?dev=1`, so the published site never renders them. Deleting them means deleting
the gate script, the `.dbg` markup, the DEBUG CSS block and the panel script.
Images go through `npm run images` only; a changed image needs a new `-v2`
filename because crawlers cache by URL.

**Lead intake** — `POST /api/lead`: honeypot, timing check, per-IP and per-business
rate limits, allow-lists, E.164 phone normalisation, idempotency key, duplicate
advisory (30 days, never blocks), store first and notify second, replay
re-announces a lead whose first attempt died before alerting. Unknown host fails
closed with the same response as an unknown token.

**Telegram** — owner and operator flows. Owner: `/leads` (5 per page, one message
edited in place, numbers 1..N, Newer/Older only where real; held rows carry a
fourth `held` line and the page header counts them without changing the order),
lead detail with status actions and Back to the same page, `/remove_lead`
(owner only, confirm before delete, no held mark), `/invite`, `/recipients`,
`/status`, `/help`. A persistent reply
keyboard carries the role's two buttons (`Invite` `Leads` for the owner, `Leads`
for staff, `Status` for a switched-off business). Operator: `/businesses` browser,
business screen (status, phones, lead counts, billing line), Suspend / Reactivate
/ Terminate / Extend 30 days, invite with Replace phone, read-only lead view.

**Email** — owner alert, customer auto-reply, review request, daily digest, daily
alert check, and every lifecycle notice (reminder, overdue, final warning,
suspension, termination warning, termination). Each lifecycle notice goes to
Telegram and email with the same words.

**Billing and lifecycle** — `paid_until` per business, pure rules in
`lib/billing.js`, one daily job at the end of `/api/selfcheck` (also callable by
hand at `GET /api/billing`), one notice per business per UTC day, a stage recorded
only when somebody was reached, and `applyPayment()` in `lib/billing-ops.js` as the
single seam a payment provider will call. The operator presses **Extend 30 days**
and confirms an exact date; a double tap adds nothing. Every notice round is
logged in `business_events`, and `lib/notice-audit.js` reports a round that never
finished.

**Ops** — `GET /api/health` (event counts, no PII, `x-health-secret`),
`GET /api/selfcheck` (per-business, daily 09:00 UTC), `GET /api/digest` (daily
13:00 UTC, off unless `DIGEST_ENABLED=1`).

**Multi-client** — `businesses.site_host` + `resolveTenant`; `clients/<slug>.json`
drives the build; one deployment serves every client.

---

## 6. Landing page design rules that still bind

- Light page with dark cinematic sections: dark masthead (nav + hero + stats), then
  light sections. Page background white / warm off-white (`#F7F4EF` for cards);
  charcoal `#1C1F24`; red-orange accent for arrows, badges, symbols.
- Clean grotesque sans, tight tracking on headings. Small labels never below
  13–14 px; contrast at least 4.5:1; borders `#9aa0a8`.
- Spacing comes from the main container's `gap`, not per-section padding. The
  masthead wraps hero and stats with `gap: 0` and one shared dark background.
- Images: warm morning or daytime light, **never sunset**. Replace AI images with
  real client photos before the client sees the page.
- Motion: split-text only on titles and subtitles (plus the footer text). Flags,
  buttons, cards, before/after and footer each have their own reveal (`data-rv`,
  selected by `html[data-a-*]`). A flag animates as one component. Clip-path
  reveals never combine with opacity or blur. Every `<img>` gets a clip-path wipe
  automatically (`data-no-reveal` opts out; hero, header, menu, modal and
  before/after are skipped).
- Any scrollable overlay needs `data-lenis-prevent`, or `lenis.stop()` blocks wheel
  and touch scrolling inside it.
- Reduced motion and no-JS must show everything: full opacity, static image, real
  text in the HTML.

**Placeholders that must be replaced before a client sees the page:** phone
number, stats, Google rating and review count, warranty term, founder name and
photo, the About story, crew photos, the service list, the reply-time promise, and
the modal's thank-you steps.

---

## 7. Known limitations

1. **Hosting.** Vercel Hobby is non-commercial and allows one cron run per job per
   day. A paying client needs Pro or another compliant host.
2. **No hard tenant isolation.** Every project shares one service-role key, so a
   bug in tenant scoping exposes everyone. RLS or per-tenant credentials would be
   needed for real isolation.
3. **Onboarding is manual** — about eight steps per client (domain attach,
   business row, site_host, invite). It does not scale to many clients a week.
4. **Retention has no code.** No purge job; deletion is manual SQL.
5. **The digest's failure line is generic** — one total, not split by kind.
6. **`lead_events` has no index on `(kind, created_at)`**, so health and selfcheck
   counts are sequential scans. Fine at this size.
7. **No alert when the check itself stops running.**
8. **Supabase retires the legacy JWT keys in early 2027.** Nothing in the code
   decodes a key, so this should be an env swap; `tests/db-wall.test.mjs` counts
   any error as a pass and would stay green for the wrong reason.
9. **`sharp@0.34.5` has one High advisory** in dev-only image tooling. Fix is
   `0.35.5`, not lockfile-only. Plan in `docs/proposals/sharp-upgrade.md`.
10. **Unverified on real devices:** Gmail/Outlook/Apple Mail rendering, the review
    page handoff on a phone, Telegram button colours on clients older than
    Feb 2026.
11. **A terminated host still serves the full landing page.** Only the form
    answers "not available". Three options with their real costs are written in
    `docs/OPERATIONS.md`; only option 1 exists today.

---

## 8. Pre-launch checklist

1. Remove `MAIL_REDIRECT_TO` from production, then confirm `/api/health` reports
   `mail_redirect_active: false`.
2. Verify the Resend sending domain and set `MAIL_FROM` to an address on it.
3. Match the Resend plan to `AUTOREPLY_DAILY_CAP`.
4. Move to a commercially permitted host before taking payment.
5. Set real `owner_email` values; `example.com` placeholders are still in place.
6. Lawyer review of the retention window, the deletion promise, and the
   privacy/terms text in `docs/legal-drafts/`.
7. Apply migration `0007` to production and re-run `npm run tg:commands` after
   deploy (`/status` is new in the owner menu).
8. One full rehearsal of the billing lifecycle on a real business, end to end.

---

## 9. Roadmap — not built

| Item | State |
|---|---|
| **Whop integration** | Reference written (`docs/WHOP.md`). Next: webhook → verify signature → re-read membership → `applyPayment()`. Needs an API key in Vercel env, a webhook secret, and a sandbox run first. |
| **One deployment, many clients** | The routing seam is built (`site_host` + `resolveTenant`, tested). Missing: per-host HTML rendering, content in the database, assets out of the deployment, `new-client` / `publish-client`, per-site brand and `noindex`. Step-by-step status in `docs/MULTI_TENANT_DESIGN.md` §9. |
| **Multi-client onboarding automation** | Domain attach via API + business row creation, so a client is minutes not an afternoon. |
| **Notification outbox** | Guaranteed delivery, claim/drain design. `docs/proposals/notification-outbox.md`. |
| **Uptime / outage alerting** | Proposal only. `docs/proposals/uptime-check.md`. |
| **Per-client summary schedule** | Four presets, local hour, needs one column and an hourly cron (Pro). `docs/PROPOSALS.md` §5d. |
| **Keyset paging for `/leads`** | Deferred. Offset paging with an `id` tie-breaker is enough at 5 rows a page. |
| **Terminated-site presentation** | Three options documented in `docs/OPERATIONS.md` (serve today, per-host holding page, redirect to operator contact). Not built; owner decides later. |
| **Telegram audit leftovers** | Named lead buttons (name/service/age instead of 1..5) and merging `/remove_lead` into the lead detail. Everything else in `docs/audits/telegram-bot-audit.md` is done or rejected on purpose. |
| **Retention automation** | A purge job matching the 60-day rule. |
| **Supabase key migration** | Swap env values before early 2027; tighten `db-wall` first. |

---

## 10. Change log (recent rounds only)

| Date | What changed |
|---|---|
| 2026-11-14 | Operator rounds 5–6: `/businesses` browser, business screen, Suspend/Reactivate, invite with Replace phone, two-message invite, exact command menus. |
| 2026-11-15 | Bot UI/UX: persistent role keyboard, 5-per-page lead browser edited in place, numbered buttons, no disabled buttons. |
| 2026-11-16 | Billing stage 1: `paid_until`, grace, daily warnings, auto-suspension, Extend 30 days, `applyPayment()` seam. Migration `0006`. |
| 2026-11-16 | Service lifecycle: one config file for every duration, reminder → grace → suspension → termination, held leads, `/status`, `business_events` notice log with a daily audit. Migration `0007`. |
| 2026-11-16 | Docs: `docs/WHOP.md` (one payment reference), Telegram audit status review, Creem/Polar pages isolated and ignored. |
| 2026-11-17 | Held leads marked in `/leads` and detail without reordering or paging changes; held notice gained "Renew to see them."; terminated-site options documented, no implementation. |

---

## 11. Unverified state — check before starting

These were left open by the last live test and cannot be confirmed from the repo:

1. `alder-demo` was temporarily set to `status = 'active'` for a billing
   simulation. Confirm it is back to `demo`, with `paid_until` NULL,
   `billing_warning_stage` 0 and `suspended_for_billing` false.
2. A test business `ZZ Billing Test` may still exist in production. Remove it and
   its leads if it does.
3. Migration `0007` application status on the TEST project and on production.
4. `npm run tg:commands` after the lifecycle deploy — the live operator menu was
   out of date once before.
