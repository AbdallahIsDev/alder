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

**Last updated:** 2026-11-28.

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
  binding and never `TELEGRAM_CHAT_ID` (that old single-tenant variable is not a
  fallback). Operator text never reaches an owner chat.
- Alerts are best-effort. A guaranteed outbox is a future implementation, not a
  current promise.
- The demo client's only production host is `alder-roofing.vercel.app` in both
  `domain` and `vercelProdHost`. Canonical, OG, sitemap, robots and the fail-closed
  DEV gate all use that host. Real clients bring their own domains later.
- Non-NANP numbers keep a deliberate boundary: the browser uses the baked
  calling-code length table, the server uses libphonenumber-js/max and is the
  final authority; a refusal shows as the inline phone-field error. US shapes
  are byte-identical on both sides. Full cross-country equality would need
  ~64 KB of type patterns shipped to the page (probe in `_debug/probe-pattern-table.mjs`).
- Phone normalisation is ONE rule in `lib/phone.js`, copied into `index.html`
  and checked byte-for-byte by test PH6. NANP shapes (10 digits, or 11 starting
  with 1) store as `+1XXXXXXXXXX`, including 555 numbers; fewer than 10, more
  than 11, letters and a 0/1 area code are refused. Arabic-Indic and Persian
  digits become ASCII first. Non-NANP numbers keep libphonenumber-js/max on the
  server and the baked calling-code table in the browser.
- Review flow: everyone is sent to the Google review link, whatever the rating.

**Lifecycle and money**

- Every duration lives in `lib/lifecycle-config.js` and nowhere else: reminder at
  D−3, grace 5 days, suspended 10 days, termination at D+15, one payment = 30
  days, data kept 60 days. `BL1d` fails if the support address is written
  elsewhere; `BL1e` fails if a duration is declared or a period is hardcoded
  elsewhere (ms-per-day conversions and copy such as "Extend 30 days" are not
  durations).
- `paid_until` NULL means **not billing-enforced**. Nothing is charged, warned or
  suspended for that business.
- Termination is the existing status `churned`, displayed as "Terminated". Nothing
  is ever deleted by the code; **Extend 30 days** is what restores a terminated
  business. Reactivate applies to a suspended business only: the terminated
  screen does not offer it, and a stale `br:`/`bR:` refuses with "Extend 30 days
  restores it.", writing nothing (`handleOperatorReactivate`, 2026-11-17).
  `reactivateBusiness()` still accepts `churned` for Extend and `applyPayment()`.
- A held lead keeps its number, id, callback and date order in `/leads` after
  reactivation; it is shown in its own **"Received while suspended"** group,
  with the remaining rows under "Other requests", and every held row keeps a
  fourth `held` line so it stays marked. The group heading states the **total**
  held rows still in the group (`heldGroupCount`), from ANY suspension inside
  HELD_GROUP_DAYS after its reactivation, never just the rows on the page
  The old current-suspension-only count put "1" above two rows. The count is
  read only when the page carries a held row, so an ordinary `/leads` costs
  what it always did. A page with no held row has no group. One detail fact
  names the state.
- A suspended business's form **holds** leads: stored whole with `leads.held_at`,
  owner told a count and no detail, visitor told to call. A terminated business's
  form answers 410 and stores nothing. Every held-lead Telegram notice opens
  with two exact lines, `New lead received.` and `Your lead is saved safely.`,
  then the reason-specific help; billing and manual notices differ afterwards.
- Retention is 60 days after termination, kept **by hand**. There is no purge job.
  To be reviewed by a lawyer; drafts in `docs/legal-drafts/`.
- A terminated host's page is not taken down. It asks `GET /api/site-state` once
  and replaces the estimate form with exactly one sentence, "This website is
  currently unavailable."; the header, the sections and the phone number stay.
  `/api/site-state` answers one of three words (`served`, `suspended`,
  `terminated`), carries nothing about the business, is `no-store`, allows only
  `GET`/`HEAD`, and answers `{ok:false,state:'served'}` with HTTP 200 for an
  unknown host or an unreadable database. **A bad answer never hides a live
  site** (`tests/site-state.test.mjs`, gate SS; part 4 of the 2026-11-28 round).

**Landing page**

- Hero video quality is non-negotiable. No re-encode, resize, replacement or
  slider change without an explicit instruction. Measured cost accepted:
  LCP ≈ 4.1 s on simulated mobile.
- The estimate form's close button is a 32 px box with a 16 px icon on every
  screen. The press area is 44 px on desktop and 32 px on phones (≤ 760 px;
  owner decision 2026-11-17, reversing the earlier all-screen 44 px rule). A
  click outside the form does not close it.
- The estimate form draws ONE resting border per control (input, textarea and the
  themed dropdown all `1px solid var(--ctl-line)`); since 2026-11-28
  `--ctl-line` ALIASES `--line`, the option cards' translucent white, so fields
  no longer look solid white next to the cards. Focus changes that border's
  colour to the accent (`--sel`) and nothing else; the ring is `:focus-visible`
  only. The white `--ctl-focus` token is retired. A dropdown's selected row is
  told apart by its weight and the accent check mark, never by an edge bar.
  Every pressable button has a pointer. `MD16`/`MD22`/`MD25` pin it; `F7` no
  longer requires the opaque 3:1 rest (1.66:1 now) and checks the accent focus
  (1.93:1) and error states instead.
- The consent line under the form is one sentence: "We only use your details to
  contact you about your estimate."
- A draft is restored only when it holds an answer the visitor actually chose (a
  select's default is not one), is less than 24 hours old, and does not
  contradict answers already in the open form; otherwise it is cleared. It
  restores its step and offers **Start over**. A dialog the visitor opened goes
  to its first field; the automatic invitation focuses the dialog itself, so
  nothing looks chosen or ringed. `MD9`/`MD23` pin it (part 5).
- The thank-you screen is three groups, each one beat of the reveal: the mark
  with a split heading ("Thanks." + "We got your request."), the tinted recap,
  then "What happens next" with Close and Call. Delays 160/240/320 ms after the
  mark's 50 ms pop, set on the groups' classes, not on `:nth-child`. Each of the
  three next-step lines stays on ONE line at 320 px: the reply promise is
  deliberately NOT repeated here (it measured 2–3 lines at 320 px) and lives in
  the fine print of step 4. Since 2026-11-28 the held panel thanks the visitor
  by name, says `Your request is saved.`, shows a warning triangle in the same
  square badge, then an amber notice box above the same recap, then Close and
  Call. Focus lands on its heading with no outline (`MD26`, `MD28`); the normal
  success screen is unchanged.
- The estimate answers persist in **sessionStorage** (`alder-est-draft-v1`:
  `{ step, touched, values }`), never localStorage, and die with the tab. Saved
  on every step change and input, restored on open, cleared on a definite answer
  from the server, and a "Start over" button (shown only while a restored draft
  exists) clears it. Every storage call is guarded: a browser that refuses
  storage behaves as before. The honeypot field is never stored.
- The form may open itself **once per tab session**: 10 s on a desktop, 8 s on a
  phone (≤ 760 px), never on first paint, and only for a visitor who has not
  used an estimate button, has not scrolled past the first section, is in a
  visible tab, and has no open dialog. Closing stores a 30-day expiry stamp in
  localStorage; a definite answer from the server stores a permanent flag
  there. All constants in one `AUTO` object in `index.html`, also exposed on
  `window` and editable from the DEV-gated debug menu (in memory only; the timer
  already scheduled at load is unaffected).
- The permanent corner radius is **12 px**, set once as `--box-radius: 12px`.
  It applies to EVERY visible box: buttons, badge and label dots (`::before`),
  step squares, before/after arrows and tags, FAQ cards, the modal's option
  cards, fields, checkboxes (row and box), the close button and the whole
  success screen. Multiples of the SAME token cover the exceptions: 24 px
  (2×) for standalone images (About, services, before/after viewer, CTA) and
  for review cards; 12 px for the image inside a review card (24 px card minus
  its padding); 48 px (4×) for the CTA section; 7 px for the white arrow square
  inside a primary button (12 px button radius − 6 px right padding + 1 px).
  That square is a real background on `<i>`, not the hover gradient, so it can
  be rounded. Three things stay out: full-viewport overlays (`.est`,
  `.est-scrim`, `.menu`, the disabled preloader), round-by-design avatars and
  the busy spinner, and SVG paths.
- The DEV-gated debug menu has **no corner-radius control**; it keeps only the
  auto-open delay inputs. The radius is permanent, in the stylesheet.
- The CTA section's 48 px bottom corners reveal the footer colour, not the
  page's white ground: the bottom strip of `.page` is painted in `var(--ink)`.
- The back-to-top button's progress ring is a rounded square with the same
  12 px radius as the button, so the outline no longer draws a sharp square
  inside a rounded box. `pathLength="100"` and the scroll-progress dash are
  unchanged.
- Form focus shows ONE ring, the accent `:focus-visible` outline. The old white
  focus border on inputs and the open select was removed, and the `--ctl-focus`
  token went with it in the lifecycle round: every field (text box, textarea,
  themed dropdown) draws the same 1px `--ctl-line` border at rest and focus
  changes that border's COLOUR to the accent (`--sel`). The accent measures
  1.93:1 against the field fill, so the border colour alone is not a WCAG 1.4.11
  indicator; the 2px accent outline is what carries the focus state visually and
  `F7` in `tests/brand.test.mjs` records the trade rather than hiding it.
- Progressive fallbacks (`vh`→`lvh`, `hidden`→`clip`, `attr()`→alt text) use one
  property reading a token plus `@supports`, never two declarations of the same
  property in one block (Biome `noDuplicateProperties` stays clean).
- Copy is plain, human and specific. No staccato fragments ("No fluff. Just
  results."), no comma-couplets used as a sentence, no colon-fragment openers.
  Full sentences with a reason in them.

**2026-11-28, `ui-fixes-2` (owner-authorised round):**

- Every confirmation screen puts a blank line between its question and the
  explanation, and its affirmative button reads exactly `Confirm` (Cancel,
  callbacks and styles unchanged). The held-lead notice opens with two exact
  lines: `New lead received.` / `Your lead is saved safely.`
- The owner's `/status` for a manual suspension reads `Status: Suspended` with
  NO `Next:` line, no `(manual)` suffix and no termination-date wording. The
  operator screen keeps `Suspended (manual)` and `Next: none (manual hold)`;
  a billing suspension keeps `Next` and the real termination date.
- The held group in `/leads` counts every held row while the group is open
  (`heldGroupCount`, HELD_GROUP_DAYS after the reactivation), so two suspension
  cycles show one heading equal to the rows listed. One held lead at
  reactivation is sent as its full detail with Back to `/leads`; 2+ keep the
  numbered list, whose own `HL`/`hL`/`hl` callbacks Back to that held list.
- The operator daily summary names businesses suspended by hand for more than
  `MANUAL_SUSPENSION_REMINDER_DAYS` (14) from the suspension notice log; no
  log means no guessed age. The once-per-UTC-day held-summary email rule is
  deliberately UNCHANGED.
- Owner email Reply-To is the visitor's address or nothing; the "reply to this
  email" line and Email button exist only then (mailto subject `Your roofing
  estimate request`, empty body). Email paragraphs glue their last THREE words
  with NBSP; manual suspension email says nothing about a termination date and
  keeps one CTA. The visitor confirmation uses the shared title section.
- The phone field filters at ENTRY time to digits and `+ ( ) - .` and space,
  with caps of 15 digits and 20 raw characters. The shared validator, submit
  path and server checks are unchanged. Form controls now share the option
  cards' translucent resting border (`--ctl-line` aliases `--line`); focus
  turns only that border primary. The held panel uses a warning badge and an
  amber notice above the recap, and no focus ring; normal success is unchanged.

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

Commands: `npm run serve` (dependency-free static server for the repo root on
127.0.0.1:8791, `npm run serve -- 3000` for another port), `npm run build` (bake
a client config into `dist/`), `images`, `icons`, `og`, `db:apply`,
`bind -- <slug>`, `tg:commands` / `tg:commands:info`, `purge:expired`,
`delete:lead`, `offboard`, `test:env-check`, `test:port-guard`.
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
rate limits, allow-lists, shared-rule phone normalisation to E.164, idempotency key, duplicate
advisory (30 days, never blocks), store first and notify second, replay
re-announces a lead whose first attempt died before alerting. Unknown host fails
closed with the same response as an unknown token.

**Telegram** — owner and operator flows. Owner: `/leads` (5 per page, one message
edited in place, numbers 1..N, Newer/Older only where real; held rows sit in a
"Received while suspended" group with the remaining rows under "Other requests",
keep a fourth `held` line, and the group heading states the business's total
held leads without changing the order or the paging; a page with no held row has
no group),
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
finished. `docs/OPERATIONS.md` §3b carries the payment-provider stage design
notes (period end as the source of `paid_until`, idempotency by delivery id, 2xx
within 5 s, repeats and out-of-order deliveries, cancellation does not terminate,
refund = Terminate, chargeback = suspend).

**Ops** — `GET /api/health` (event counts, no PII, `x-health-secret`),
`GET /api/selfcheck` (per-business, daily 09:00 UTC), `GET /api/digest` (daily
13:00 UTC, off unless `DIGEST_ENABLED=1`).

**Multi-client** — `businesses.site_host` + `resolveTenant`; `clients/<slug>.json`
drives the build; one deployment serves every client.

**Public site state** — `GET /api/site-state` is the one public answer about the
host the page is on: `{ok, state}` with `state` one of `served`, `suspended`,
`terminated`, derived from the business `status` and nothing else. No name, id,
address, date, billing state or lead count leaves it, and every answer is
`no-store`. An unknown host or an unreadable database answers 200
`{ok:false,state:'served'}`, so a blip never hides a paying client's site. The
page uses it only to replace the estimate form with
"This website is currently unavailable." (`tests/site-state.test.mjs`, gate SS).

---

## 6. Landing page design rules that still bind

- Light page with dark cinematic sections: dark masthead (nav + hero + stats), then
  light sections. Page background white / warm off-white (`#F7F4EF` for cards);
  charcoal `#1C1F24`; red-orange accent for arrows, badges, symbols.
- Clean grotesque sans, tight tracking on headings. Small labels never below
  13–14 px; contrast at least 4.5:1. The modal's control and option-card borders
  share one translucent token (`--ctl-line: var(--line)`); the old opaque
  `#9aa0a8` control border is retired.
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
11. **A terminated host still serves the landing page.** The page asks
    `GET /api/site-state` once and, on `terminated`, replaces the estimate form
    with one neutral sentence ("This website is currently unavailable."). The
    rest of the page — the header, the sections, the phone number — is still
    served, so the site keeps describing a business that is not taking work.
    A whole-host holding page would need the HTML render to resolve the tenant,
    which it does not do; the three options and their costs are written in
    `docs/OPERATIONS.md` §3b. A failed or unknown answer never hides a live
    site.

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
| **Terminated-site presentation** | Partly built: `/api/site-state` plus one neutral sentence in the form (`docs/OPERATIONS.md` §3b). A whole-host holding page or a redirect to the operator's contact page is still open; the owner decides. |
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
| 2026-11-17 | Operator business screen: two-line lead counts, four button matrices, asks and confirms, one fact per line (Part 1). |
| 2026-11-17 | Copy only, no behaviour: the terminate question says "Extend 30 days puts it back", the invite refusal for a terminated business says "Extend 30 days restores it." (one sentence with the Reactivate refusal; suspended keeps "Reactivate it first."), and the two section comments say Extend restores a terminated business while Reactivate is suspended-only. |
| 2026-11-17 | Terminated businesses are restored by Extend 30 days only: `handleOperatorReactivate` refuses a `churned` row on both the question and the confirm, with a new refusal screen and toast, writing nothing. `reactivateBusiness()` untouched. New OP61b/c/d, OB10 and OB29 assert the refusal and that Extend still restores. |
| 2026-11-17 | `tests/webhook.test.mjs` brought up to Part 1: OP61 split into ask/perform/second-confirm, `bR:` added to the forged and stale lists, forged sweep now also proves the row is unchanged, OP63 drives Replace phone (`bw:`/`bW:` and `bp:`/`bP:`) instead of the old Invite button, and the terminated screen is asserted to offer no Reactivate. The mail-subject assertion reads `MAIL_REDIRECT_TO` instead of assuming a machine without it. Green: 115/115, 155 s. |
| 2026-11-17 | Estimate modal: thank-you screen in three groups with a class-set reveal, one-line next steps, the held state really hides the recap and the steps, draft in sessionStorage with "Start over", one automatic open per session at 8 s / 10 s with a 30-day close suppression. `/leads` header states the total held leads. A support suspension says "Contact support to restore it." instead of "Renew". `npm run serve`. Payment-provider design notes in `docs/OPERATIONS.md` §3b. |
| 2026-11-17 | Task-gap round: DEV debug menu gained a live `--box-radius` [Default]/[Custom] control and the AUTO delay inputs; X press area 44 px desktop / 32 px phone. `/leads` held rows moved into their own "Received while suspended" group. `/start` excluded from the suspended reply, no free-text cap while off, and the suspended/terminated reply always states a date (or that none is set) and the countdown. Extend's terminated question now says "This business was terminated. Extending restores the service." Held notices use the same four core lines for both reasons. Operator identity is `OPERATOR_CHAT_ID` only. New `BL1e` duration gate. Checklists and `docs/legal-drafts/LAWYER_REVIEW.md` added. |
| 2026-11-18 | Radius audit: the one `--box-radius` rule now covers every visible box sitewide, including `::before`/`::after` boxes, arrow squares, step squares, before/after tags, review cards and their images, FAQ cards, modal option cards, fields, checkboxes, the X button and the whole success screen. Overlays, round avatars, the busy spinner and SVG paths stay out. `MD14` pins the coverage. |
| 2026-11-18 | The white arrow square of each primary CTA is a background gradient on `.bx-p`, not the `<i>`, so `border-radius` could not round it. In radius mode the panel set an in-memory `data-radius="custom"` flag and CSS swapped that gradient for a real, rounded background on `<i>` (`MD15`). The field's cap became 36 px. |
| 2026-11-18 | Permanent radii: `--box-radius` is now 12 px in production. 24 px for standalone images and review cards, 12 px for the image inside a review card, 48 px for the CTA section, 7 px for the primary button's white arrow square (button radius − right padding + 1). The CTA square is permanently a real box, so the hover gradient flood no longer plays. The checkbox row in step 3 gained the 12 px radius. Focus now shows one accent ring: the white focus border on fields and the open select was removed. `MD16` pins the values. |
| 2026-11-18 | Removed the corner-radius row (markup and JS) from the DEV panel; the auto-open delay inputs stay. The CTA's rounded bottom corners now reveal the footer colour by painting the page's bottom strip in `var(--ink)`. Fixed the six duplicated CSS properties flagged by Biome using token + `@supports` fallbacks; `CSS8` pins it. |
| 2026-11-18 | The back-to-top progress ring became a rounded square with the button's 12 px radius. Its SVG path and the stale square-cap comment were updated; `MD16` checks the new path. |
| 2026-11-26 | Hardening phase 0: TEST project restored; the runner's `site_host` failure now prints a sanitised, 200-char `error.message` and `error.status` (`RD1`). Migration `0007` applied to TEST only; `leads.held_at` and `business_events` now present. 43 suites registered. |
| 2026-11-26 | Hardening phase 1: baseline runner (41 suites; two production-reading suites skipped) had four failures — stale build hash, 2 GB disk floor, B19 regex, B1d timing. All fixed; the five affected suites were re-run green. B1d is now DB-clock-checked with a bounded retry. |
| 2026-11-26 | Hardening phase 2: fresh five-pass re-audit, 76 rows (DONE 54 / PARTIAL 13 / MISSING 9) in `_debug/audit-report.md`. Two new highs: held-lead replay PII leak after reactivation and modal close-during-send key reset. |
| 2026-11-26 | Hardening phase 3: fixed DEV gate on production hosts, silent cron owner emails, notice-alert claim release, stale billing Reactivate, held-lead replay leak and status race, modal key on close/reopen, scoped held count, stale Extend token, lifecycle date copy, docs and serve. New tests MD17–MD19, OF1–OF5, LC17, LB26, BL9c, OB31, PL1–PL3. |
| 2026-11-26 | Hardening phase 4: one design-token file (`design-tokens.json`) drives CSS custom properties and numeric email values through `npm run tokens`; radius default stays 12px. `docs/DESIGN_TOKENS.md` and `DT1`–`DT3` added. |
| 2026-11-26 | Hardening phase 5: production host is a `{{prodHost}}` build token instead of a hardcoded Alder domain; build baseline and OP61 copy updated; C35 made deterministic with DB-clock feedback. `npm run build` exit 0 with no leftover `{{`. |
| 2026-11-27 | Pre-launch verify: production migration 0007 applied; PR #39 description added. Phase 3 fixes — delayed Extend Confirm accepted with its original 30-day end, held replay stays held, fresh status read logs a code, build bakes both production hosts, token JSON uses `createRequire`, Vercel production alias is denied by the DEV gate. |
| 2026-11-27 | Phase 4 e2e on localhost + TEST: 46 scenarios in `_debug/e2e-report.md` (30 PASS, 14 suite-covered, 1 production DEV-gate exposure found and fixed, 1 real-phone check not run). Production smoke lead created and deleted; 0007 before/after counts unchanged (2 businesses, 8 leads). |
| 2026-11-27 | Production smoke after PR #40: Vercel alias served merged code, DEV panel hidden with `?dev=1`/`?debug=1`, smoke lead stored with four events and deleted. The old custom domain never existed and was removed from the demo client in FV2; Vercel dashboard is login-gated. |
| 2026-11-27 | Follow-ups branch: DEV gate fails closed on missing/placeholder production hosts and build refuses a client without `vercelProdHost`; Extend Confirm tokens expire after 10 minutes with OB32/BL9e; `vercel.json` includes both generated JSON files for all functions via the valid single-string glob `lib/*.generated.json`. |
| 2026-11-27 | Phone root cause fixed on `final-verify`: the browser and the API now call one rule (`lib/phone.js`) before validation. The strict libphonenumber-js check rejected all 555/NANP shapes and did not read Arabic-Indic digits. PH1–PH6 (DB-free) and P24/P25 (TEST API) pin ten accepted shapes, six refusals and one stored value `+15551234567`. |
| 2026-11-27 | Domain cleanup: `clients/alder.json` uses `https://alder-roofing.vercel.app` for both `domain` and `vercelProdHost`; generated canonical/OG/robots/sitemap and `data-prod-host` follow. Tests and README updated; C17 pins the only real host. C1 build baselines moved deliberately (HTML d0e12fd3→62efb2a7, robots dcd93cf0→9a24e9a8, sitemap f90e45bd→2a79589d; manifest unchanged). |
| 2026-11-27 | `final-verify` branch: full localhost/TEST E2E in `_debug/e2e-final.md`. 44 suites / 633 assertions green, `npm run build` exit 0, review diff `_debug/patches/final-verify-review.diff`. Five fix-and-retest rounds: a mis-ranged canary fixture chat, a transient B6h, and a load-sensitive B5d assertion were fixed in the test harness only. No production data touched. PR opened, not merged. |
| 2026-11-27 | Final review fixes: `tests/phone.test.mjs` registered in `DEFAULT_SUITES` with N3 pinning it; `docs/EMAIL_SYSTEM.md` phone section rewritten for the shared rule; P24/P25 wording corrected. Reviewer's non-NANP finding accepted as a recorded ruling, not a code change. Free disk fell below the 1 GB suite floor; generated `_debug/e2e-build`, `_debug/e2e-dev-root` and `dist` scratch were deleted (no user work). Final: 45 suites / 634 assertions green. |
| 2026-11-27 | Production smoke after PR #42 merge/deploy: alias and `?dev=1`/`?debug=1` showed no console errors and no `.dbg`; both production host attributes are the Vercel alias. One `ZZ PROD CHECK` lead submitted through the real form returned HTTP 200, stored `+15551234567`, produced `created`/`tg_sent`/`email_owner_sent`/`autoreply_sent`, then was deleted with all four events. Lead count 8 -> 9 -> 8; sentinel count 0 before and after. |
| 2026-11-28 | Lifecycle/site-lifecycle round, Parts 0–5: one generated `docs/MESSAGE_PREVIEW.md` (Part 0b) and `docs/LIFECYCLE_EXPLAINED.md` (Part 0a); operator business screen and the one status formatter (Part 1); the held group, the two-message reactivation, the owner texts without "by support" (Part 2); owner emails with no repeated sentence (Part 3); `GET /api/site-state` answering one word (Part 4); the form's resting look and the draft guards (Part 5). |
| 2026-11-28 | Owner authorised a one-time push to `origin/main` and asked to skip the full suite. Merging `final-verify` (production smoke handoff + owner's `update styles` commit) into main. Assertion-meaning change recorded: MD14 previously required `.est-recap div` in the sitewide radius list; the owner's commit removes it, so recap rows no longer carry the 12 px radius, only the recap container does. Review artefact `_debug/patches/main-push-review.diff`: 3,853 bytes, 50 lines, apply-check 0, secret scan all 0. Stale branches (codex/pr27, multi-client-prep, telegram-widgets, visual-polish, whop-notes) are 67–129 commits behind main and hold superseded code or docs-only notes; left out. |
| 2026-11-28 | PR #43 review fixes on the PR branch: webhook OP24/OP61/OP63 pinned to the status block, three-row buttons and two-message reactivation; held visitor pane keeps its recap and drops the repeated heading (MD24); OPERATIONS runbook follows the code and names the 24 h draft expiry; generated preview samples corrected; T21 gates orphan last lines (and `orphanWord()` now sees one-word paragraphs); T22 bans "by support" in every owner text; MD22 adds no outer outline on form controls. No webhook ack-order or db-timeout change. |
| 2026-11-28 | `ui-fixes-2` round (17 items + gates): confirm screens, held notice lines, owner status wording, held-group count across two cycles, single-lead reactivation detail and held-list Back chain, 14-day manual-suspension summary; owner/visitor email layout, Reply-To rule, three-word NBSP orphan guard, reactivation copy; entry-time phone filter, shared field border, no panel focus ring, held success redesign. TEST project only. Item 12 finding: the missing second "New requests are waiting" email is the deliberate once-per-UTC-day bucket `held:mail:<business>` (`hitRateLimit(key,86400,1)`), confirmed by two same-day suspended cycles in TEST `business_events` (14:32:55 sent, 14:32:58 only held_lead); rule unchanged. |

---

## 11. Unverified state — check before starting

These were left open by the last live test and cannot be confirmed from the repo:

1. Settled: `alder-demo` was temporarily `active` for a billing simulation;
   `_debug/e2e-restore.mjs` put it back to `demo` before the 2026-11-28 suite
   run, which printed `ALDER_DEMO_STATUS=demo`.
2. A test business `ZZ Billing Test` may still exist in production. Remove it and
   its leads if it does.
3. Migration `0007` was applied to TEST on 2026-11-26 and to production on
   2026-11-27 with the owner's explicit authorisation; both projects have
   `leads.held_at` and `business_events`.
4. `npm run tg:commands` after the lifecycle deploy — the live operator menu was
   out of date once before.

Open after the 2026-11-17 modal round:

5. **Settled 2026-11-17: Extend 30 days is the only way back from terminated.**
   `handleOperatorReactivate` refuses a `churned` row on both paths (`br:` and
   `bR:`), answers "Terminated. Extend 30 days." and writes nothing.
   `tests/webhook.test.mjs` OP61b/OP61c pin the refusal and OP61d that a
   `paused` row still reactivates; `operator-browser` OB10 (the refusal) and
   OB29 (Extend is the way back) cover it without a database.
   `reactivateBusiness()` is unchanged, so Extend and `applyPayment()` still
   restore. The copy that still promised Reactivate is fixed (2026-11-17): the
   terminate question ends "Nothing is deleted: Extend / 30 days puts it back.",
   and an invite asked of a terminated business answers "… is terminated. /
   Extend 30 days restores it." — the same sentence as the Reactivate refusal,
   because `operatorInviteSuspendedText` calls `operatorTerminatedReactivateText`
   for `churned`. A suspended business keeps "Reactivate it first.".
6. `tests/lead-api.test.mjs`, `tests/review.test.mjs`, `tests/fallback.test.mjs`
   and `tests/isolation.test.mjs` were not run this round (they need a live
   `vercel dev` and/or the TEST project).
7. The automatic open and the draft were measured in Chrome at a 375 px viewport
   (8.3 s open, 6.3 s closed, no second open after a reload) and at 1280 px
   (open after 9.9 s, closed before). Not yet on a real phone, and not with a
   real `sessionStorage` that is disabled by the visitor.
8. The three next-step lines were measured at 320, 375 and 1440 px (one line
   each, longest 192 px of the 246 px box at 320). Not measured in Safari or
   Firefox.
9. The `--box-radius` control, its sitewide coverage and the phone-sized X press
   area were verified by JSDOM and CSS text assertions only, not in a real
   browser on a phone.
10. Settled 2026-11-26: B1d now uses a 4 s margin, DB-clock feedback and a bounded
   retry; 62/62 after the change. The 10 s claim is still a fixed bucket, not a hard lock.
11. `ui-fixes-2` (2026-11-28): modal computed styles and focus were measured in
   local Chrome at 320/375/1280 px (`.opt`, `#e-zip`, `.sel-btn`, `#e-phone`,
   notes all `rgba(255,255,255,.18)` at rest, accent on focus, no outline).
   Screenshots in `_debug/ui2-modal-*.png`; emitted Telegram texts in
   `_debug/ui2-telegram-texts.png`. Native Telegram rendering on a real phone,
   Safari/Firefox and Vercel dashboard internals were not verified.
