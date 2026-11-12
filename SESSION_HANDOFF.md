# SESSION HANDOFF: Alder roofing lead platform (orchestrator continuation)

> **Purpose.** Give this file to any cloud AI assistant so it can continue as the **orchestrator** for this project without the owner re-explaining anything.
> **Last updated:** 2026-11-12 (lead-safety retry, throttle, and audit follow-up).
> **Rule for the local agent:** after every task, update the change log and any section whose facts changed. Never put secret values in it.

---

## 1. How we work (read first)

### Review artefact rule (set 2026-11-07)

Exactly ONE review file per task: `_debug/patches/<branch>-review.diff` =
`git diff origin/main...<branch>` (every commit from main to the branch head,
combined). For this task: `_debug/patches/multi-client-prep-review.diff`. No
`.patch`, no last-N, no per-area splits. Report its size, line count,
`git apply --check` against a fresh `origin/main` worktree, and a secret scan
(counts only). Older `.patch` files may stay on disk; do not add more.

### Test-project rule (updated 2026-11-12)

Run suites only with `TEST_ENV=1` and `.env.test`. `tests/run.mjs` refuses a missing
test URL or one equal to the production URL in `.env`, then checks that its canary
lands in the test project. No production backup/reset/restore ritual is part of a test
run. Never print env values, service credentials, chat identifiers, bind codes, or
lead data.

### Vercel CLI rule (set 2026-11-09)

Never run `vercel dev` or any Vercel CLI command from a directory that has no
`.vercel` link, and never create or link a remote project while probing. Measured
the hard way: `vercel dev` in an unlinked directory creates a project on the
account, and `vercel dev` in a directory with a `.env` gives that file precedence
over the environment it was started with. The test runner avoids both by starting
the server from a dev root that has a copied `.vercel/project.json` and no `.env`
(`tests/dev-root.mjs`).

### Roles
| Role | Who | Does |
|---|---|---|
| **Owner** | The human (Cairo, Egypt, GMT+2; Windows, PowerShell) | Decides, tests on real phones, creates accounts and secrets, relays prompts and reports |
| **Orchestrator** | You, the cloud assistant | Never touches the repo. Writes prompts for the local agent, reviews reports and code, answers questions, keeps the queue |
| **Local agent** | AI agent on `C:\Users\11\projects\Roofing-2` | Reads/changes code, runs tests, commits, pushes branches, opens PRs, writes reports |

### The loop
1. Owner describes a goal or problem. The orchestrator clarifies, thinks of edge cases itself, and writes one complete prompt for the local agent.
2. Owner pastes the prompt. The agent works and returns a final report.
3. Owner pastes the report back. The orchestrator reviews it critically (Section 2), answers the agent's questions, and writes the next prompt.

### Prompt-writing rules (every prompt must include)
- **CONTEXT:** branch, "never push to main", no force, no tags, push dry-run first.
- Standard rules: never print secret values or PII; every behaviour change gets a **test plus a mutation check** (break the code, show the test fails, revert); one commit per logical item with hashes; **schema changes are proposals only** (never apply a migration, never leave an unapplied one in `supabase/migrations/`); never weaken an assertion without recording its before/after meaning.
- Test-database rule: every suite run uses `TEST_ENV=1` and `.env.test`; verify with `npm run test:env-check`. The runner refuses production before starting and checks its canary. Never back up, reset, or restore production test fixtures.
- **EDGE-CASE RULE:** list the cases beyond the owner's list and report a table: case / current behaviour / decision (test ID, proposal, n/a).
- **BUDGET RULE:** priority order; after each group, run the touched suites, push dry-run, add a handoff entry. If budget runs low, stop at a clean commit and list what is left.
- **FINAL REPORT:** Critical/High at the top; one section per group with commit hashes, tests, mutation results, changed assertions, what was NOT verified; suites run and which database; per-suite times; `git status`; `git log --oneline -20`. Do not include secrets, identifiers, or lead data.
- **HANDOFF UPDATE (mandatory):** update this file with what changed, new issues and open questions.

### Pending-prompt tracking rule
Assume a prompt has NOT been sent until the owner pastes a report for it. Keep the queue (Section 11) accurate.

---

## 2. How the orchestrator reviews code

1. **The agent's final report**: evidence, mutation results, honest disclosures, and whether any assertion changed.
2. **Commit links** (`github.com/.../commit/<full sha>`): only full URLs present in the owner's message can be fetched; the page truncates after ~5 files.
3. **The single `.diff`**: read it line by line. A branch with a merge commit cannot be replayed with `git am`; `git apply` of the diff works.

Look for: unhandled rejections, fail-open paths, module-level state across warm invocations, PII in logs/messages, cross-tenant leaks, idempotency-key collisions, tests that assert too little, dead code, stale comments, loosened assertions, tests coupled to production data.

---

## 3. Owner preferences and working style

- Easiest possible client experience, fewer support tickets; owners should fix problems themselves.
- Few options, not many. Presets (2-4) beat free-form settings.
- Warn and push back when an idea is insecure or wrong; explain why and offer the alternative.
- Edge cases identified proactively.
- Visual quality of the hero video is non-negotiable; close button stays 40 px; keep the existing look.
- Prompts complete, copy-paste ready, in one block, with the handoff instruction.
- Wants to see changes visually (preview gallery, real Telegram/Gmail).
- Open question: which country the first roofing clients are in. It decides digest hour, phone defaults and the WhatsApp cost question.

---

## 4. The project

**Alder**: a lead platform for roofing contractors. A homeowner fills a multi-step estimate form; the contractor is alerted on **Telegram** (with buttons) and by email; the system can auto-reply, request a Google review, and send operational summaries.

| Item | Value |
|---|---|
| Repo | `https://github.com/AbdallahIsDev/alder` |
| Local path | `C:\Users\11\projects\Roofing-2` |
| Live site | `https://alder-roofing.vercel.app` (deploys from **`main`**) |
| Hosting | Vercel **Hobby** (each cron job runs at most daily; commercial use needs a paid plan) |
| DB | Supabase Postgres, **us-east-1** (~192 ms median from Cairo) |
| Telegram | Webhook `api/tg.js`; helper `lib/tg.js` |
| Email | Resend (`lib/notify.js`, `lib/email-layout.js`, `lib/email-builders.js`) |
| Local dev | `npx vercel@48.12.1 dev` on port 3000 (pinned) |
| Tests | `tests/run.mjs`, suites `tests/*.test.mjs`, loopback Telegram/Resend fakes, JSDOM |

### Key files
`api/lead.js`, `api/tg.js`, `api/review.js`, `api/health.js`, `api/selfcheck.js`, `api/digest.js`, `lib/db.js`, `lib/digest-db.js`, `lib/lead-intake.js`, `lib/notify.js`, `lib/ops-delivery.js`, `lib/ops-copy.js`, `lib/operator.js`, `lib/bind-codes.js`, `lib/request.js`, `lib/content.js`, `lib/outbound.js`, `scripts/`, `supabase/migrations/0001..0004` + `seed.sql`, `index.html`, `build-static.js`, `docs/`, `HANDOFF_alder_session.md` (the agent's own repo handoff; different from this file).

### Security/architecture facts (verified)
- RLS on all tables, deny-all, no policies; the app uses the service role server-side only. `v_client_leads` is `security_invoker`. Roofer-facing code never SELECTs directly from `leads` (test C10; that is why `findRecentDuplicate` and `digestCounts` live in separate modules).
- Telegram authorization: business derived only from `business_chats.tg_chat_id`; callbacks anchored-regex validated; lead lookups scoped by `id + business_id`; transitions are conditional UPDATEs.
- Bind codes: single use, 24 h, one minting function (`lib/bind-codes.js`).
- Secrets: `HEALTH_SECRET` and `CRON_SECRET` are different values, compared in constant time; rotated after an earlier exposure.
- `OUTBOUND_TIMEOUT_MS` and `*_API_BASE` overrides only honoured in dev.
- `npm audit` checked 2026-11-12: one High advisory in devDependency `sharp@0.34.5`; fix is `0.35.5` and requires a package manifest range change, so no lockfile-only upgrade was applied. See `docs/proposals/sharp-upgrade.md`.

---

## 5. Environment variables (names only)

Required in Vercel: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `IP_HASH_SALT`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `RESEND_API_KEY`, `MAIL_FROM`, `SITE_URL`, `HEALTH_SECRET`, `CRON_SECRET` (set both; selfcheck/digest return 503 if `HEALTH_SECRET` is unset even when `CRON_SECRET` is set).

Optional: `TELEGRAM_CHAT_ID`, `MAIL_REDIRECT_TO`, `MAIL_REDIRECT_PREFIX` (**remove before first real client**), `AUTOREPLY_DAILY_CAP` (40), `DIGEST_ENABLED` (unset = no-op), `DIGEST_UNTOUCHED_DAYS` (14), `RECIPIENTS_MAX` (5), `INVITES_MAX` (3), `TELEGRAM_BOT_USERNAME`, `DATABASE_URL` (migrations only), `VERCEL_ENV`.

New in `ops-audience` (not deployed): `OPERATOR_CHAT_ID` (falls back to `TELEGRAM_CHAT_ID`), `OPERATOR_EMAIL`.

Test-only: `.env.test` (exists since 2026-11-09), `TEST_ENV=1`. `ALLOW_PROD_TESTS` is gone.

---

## 6. Timeline: what has been done

### Phase 1-3: test speed and hardening (branch `db-backend`, merged)
Suites in-process; runner timing; dev-only timeout override (411 s → ~272-304 s; the 180 s target was not met — ~93 % is DB round trips). Security audit clean; fixed `0004` missing from `ALL_FILES`, inverted env precedence, shared `clientIp`, constant-time secret compare. Reliability: cross-channel fallback, `/api/health`, `/api/selfcheck`, daily cron, redirect warning, 40/day auto-reply cap, duplicate detection, retry mutex, deletion scripts, handleCallback dispatch table. Accessibility: live region, `aria-describedby`, 3:1 borders, OG image 501 → 204 KB. Digest and selfcheck crons (`0 13 * * *`, `0 9 * * *`). Multiple recipients (`/invite`, `/recipients`; 5 phones / 3 pending invites). Merged to `main`.

### Phase 4: diagnosis of "New" and "Not found" (read-only)
No data lost. "New" rows were test debris sorting above the three real `done` leads. "Not found." came from tapping Mark contacted on an already-`done` lead.

### Phase 5: branch `ops-audience` (PR #6, DRAFT)
Per-business self-check counts, audience rule, shared branded email layout, plain-English copy, preview gallery, `docs/PROPOSALS.md` §5d. Commits `5cc59aa`, `81e2132`, `92eefa2`. Disclosed: an intermediate test set `VERCEL_ENV=production` and two sends reached the real APIs (rejected). Fixed by the network guard.

### Phase 6: operator channel bundle
- **`fix-invite-message` (PR #7, from main):** `/invite` had a literal `//n//n` and no tappable link. Now a real deep link, plain code, expiry. `tests/bot-text.test.mjs` guards every bot string. Commits `b5bb654`, `a2bbd67`. **GitHub reports PR #7 as MERGED** (observed 2026-11-07 22:10 UTC); the live bug is closed.
- **Network guard:** `tests/env.mjs` throws on any non-loopback, non-Supabase host (N1-N5).
- **Operator channel (`f404b4e`):** `lib/operator.js`; operator text only to the operator chat; per-business owner messages; one aggregated operator alarm (Telegram → email → `operator_alarm_undelivered`); no `TELEGRAM_CHAT_ID` button fallback.
- **Commands and recovery (`0c9c07c`):** `/code`, `/phones`, `/businesses`, `/operator`, `/id`; owner = oldest phone; paste-a-code onboarding; `/leads` with Open and Older; stale taps answer "Already updated."; blocked-bot notice. OP1-OP13.
- **Tools:** `send-test-lead.mjs`, `preview-send.mjs`, `docs/MANUAL_TESTING.md`.

### Phase 7: review fix, data hygiene, run trust
- Stored `google_review_url` began `ttps://`; both gates rejected it. Repaired in code and data; `/api/health` reports `review_links_invalid`.
- 21 leads from a killed webhook run deleted after classification; `alder-demo` back to 3 leads / 2 feedback.
- Suites sweep their own test-shaped leftovers at start and in `finally`; runner guards chats and debris.
- B14/B15 were **test bugs**, not duplicate-detection defects: B14 indexed the raw send list, B15 could match an older lead. Both fixed in tests only.
- Three full runs green: 385.2 s, 384.4 s, 385.6 s reversed.

### Phase 8: fixture safety and `/code` (this bundle)
- Fixture chat ids moved to a reserved range (`5e15` base, below 2^53), unique per suite. The runner pre-cleans anything at or above the base before snapshotting.
- The sweep needs two signals: suite key shape AND an `@fixture.invalid` address. Reads page past PostgREST's 1000-row cap and are scoped to this deployment's businesses.
- `/code` sends exactly two messages: the operator line (slug, code, human expiry) and the client-forwardable text (no slug, no business name). The old "send me this code" now says "open the bot and send it this code". If the second send fails, the operator gets the code back.
- The no-phone operator notice no longer carries the customer's name.
- `/code` fixtures mint on a throwaway `zz-test-<run>` business; the runner fails if live unused codes for a real business grow.

---

## 7. Issues and state RIGHT NOW

### Resolved in this branch
| Was | Now |
|---|---|
| `review` suite red (8 failures) | Green; caused by the `ttps://` stored URL |
| `notify` B1/B2b order dependence | Green in a full run |
| Stray chat `6852` | It is the owner's **second account, bound to `second-demo`** — not a stray. The earlier "two real phones on alder-demo" explanation was wrong: B14's extra send was the fixture chat bound to `alder-demo`, not a second owner phone |
| `/code` one message, ambiguous "send me" | Two messages, bot-directed wording |
| Fixture ids in the real Telegram id space | Reserved range + runner pre-clean + guard |

### Open
| Severity | Issue |
|---|---|
| **High (ops) — RESOLVED** | The owner deleted every unused code in production (217). `/invite` is unblocked. The owner minted one more invite through the live bot, so two live unused codes exist; neither is a suite's. The runner fails a run that grows that number. |
| **RESOLVED** | Claim-then-bind now reads the binding back; on a mismatch or a throw it restores the claim and says so. Global bind ceiling raised to 600/hour with `bind_ceiling_hit`. |
| **RESOLVED** | Ceiling 600/h, `bind_ceiling_hit` logged. |
| Medium | `leads.business_id` has no `ON DELETE` action; offboarding must delete leads first. |
| **RESOLVED** | `/invite` at the cap offers one button that expires the old invites and mints a fresh one (owner only, 60 s mutex, budget checked before expiring). `/recipients` states the pending count. |
| Low | `/businesses` shows 0 phones for paused/churned clients (it re-fetches through `getBusinessActiveBySlug`). |
| Low | `public.rls_auto_enable()` is SECURITY DEFINER with EXECUTE to `anon`/`authenticated` (event-trigger function, not directly callable). |
| **High (dated, platform)** | Supabase retires the legacy JWT `anon`/`service_role` keys in early 2027 for `sb_publishable_` / `sb_secret_`. Nothing here decodes a key — every use is `createClient(url, key)`, no migration calls `auth.jwt()` or `auth.role()`, and the anon key never reaches the browser. The switch should be env values only; the gap is `tests/db-wall.test.mjs`, which counts any error as a pass. Detail and steps in §8 item 11. |
| Resolved | `/invite` message bug: PR #7 is merged (GitHub state observed 2026-11-07). |

### Production data (verified 2026-11-07)
`alder-demo`: 3 leads (all `done`, review tokens), 2 `review_feedback` (5★), chat tail `6109`. `second-demo`: 0 leads, chat tail `6852`. Both `owner_email` domains are `example.com` placeholders. `MAIL_REDIRECT_TO` is active (intentional, demo).

### Test counts
Last full run before this bundle: 385.2 s / 384.4 s / 385.6 s, all green. This bundle adds `fixture-safety` (7 checks) and four OP tests; targeted runs are green (see Section 9).

---

## 8. Still missing / not done

1. **Separate test Supabase project (Phase C), DONE 2026-11-09.** `.env.test` exists; all suites require it with `TEST_ENV=1`, and no production-test override exists. Fixtures use seeded businesses in the test project. No production backup/reset/restore is part of test runs.
2. **Summary schedule** (proposal only, `docs/PROPOSALS.md` §5d): four presets, per-business timezone, one column, hourly cron on Pro.
3. Self-check is operator-only and not owner-configurable (decision).
4. Quiet hours / 15-minute reminders: parked; Hobby crons are daily.
5. Pre-launch checklist: remove `MAIL_REDIRECT_TO`, verify Resend domain, real `owner_email`, `OPERATOR_CHAT_ID`, Vercel Pro, Resend plan, hard-fail redirect check, retention decision, real Gmail/Outlook rendering, review handoff on a phone.
6. Prompt queue, unsent: README rewrite + CI without secrets + preview check + fresh-eyes review of `main` + test-quality audit.
7. Telegram command menus: after merge, `npm run tg:commands`, then `tg-webhook set` and `info` (the `my_chat_member` handler only arrives if `allowed_updates` is re-registered).
8. Known minor: sharp High advisory deferred under the conditions in `docs/proposals/sharp-upgrade.md`; 13 images without width/height (CLS 0); `--timing` flag.
9. A5 is done (`scripts/purge-expired.mjs`, dry run default). A2 is done: every bind test runs on `zz-test-bind-<run>` and F8 bans a real-business mint. Keyset paging is report-only. Hostile review: 409 and bind read-error are fixed; `botUsername()` cache (Low) and the retry lock window edge (Low) remain. The retry lock should become a unique index in the next migration proposal — no migration file is added now.
10. Proposals only, not implemented: one brand per deployment; `/clients` and `/stats <slug>` on `v_client_leads`; retention predicates; `npm run new-client`. `robots.txt` and `sitemap.xml` are generated from the selected client's `domain` by `build-static.js`.
    CI proposal: run `npm run test:port-guard` **before** `tests/run.mjs`. It binds port 3000 and therefore cannot live in the suite list, so a CI job that only runs the suite would silently skip the guard.
11. **Supabase key format (read-only review, 2026-11-09).** Legacy JWT keys retire in early 2027; the replacements are `sb_publishable_…` (public) and `sb_secret_…` (server), which are not JWTs. What the code assumes: nothing. There is no JWT decode, no `eyJ` check, no key-length check, no raw `fetch` to `/rest/v1` in app code — `lib/db.js`, `lib/digest-db.js`, `lib/lead-intake.js`, `lib/review-db.js` and `api/health.js` all call `createClient(url, key)` (supabase-js 2.118.0), which sends `apikey` and `Authorization: Bearer` and does not care what the string looks like. No migration calls `auth.jwt()` or `auth.role()`, so RLS does not depend on claims. The anon key is used only by `tests/db-wall.test.mjs`; it never reaches the browser (the page has no Supabase code). **What would break:** `db-wall` treats any error as a pass, so a rejected or retired key would leave it green for the wrong reason; `test:env-check` only checks that a name is present. **Smallest steps:** (1) create the new keys in the dashboard, (2) put them in `.env.test` and run `db-wall` alone, (3) tighten `db-wall` so a 401 "invalid API key" fails while an RLS denial passes, (4) swap the production env values and redeploy, (5) delete the legacy keys, (6) repeat step 2. Unverified: that this project's PostgREST accepts `sb_secret_` in the `Authorization: Bearer` header as well as in `apikey` — test it in step 2 before touching production.

---

## 9. Testing and verification status

### Verified by automated tests (fakes + test database)
Lead intake validation, rate limits, idempotency, honeypot; Telegram callbacks (C1-C36); fallbacks (B9-B15); health/selfcheck/digest (H, S, D); recipients (R1-R14); operator commands (OP1-OP16); bot text artifact guard (T1-T7); network guard; email layout; modal a11y; brand tests; fixture-safety F1-F7.

### This bundle's runs (historical production DB; do not repeat)
| Run | Result |
|---|---|
| `fixture-safety` | 7/7, 0.7 s; mutation: old id `880001` back → F7 fails |
| `recipients` | 14/14, 0.2 s |
| `lead-api` | 45/45, 95.4 s |
| `notify` | 45/45, 59.7 s |
| `webhook` | 62/62, 143.2 s; mutation: one `/code` message → OP2/OP14/OP16 fail |
| `bot-text` | 7/7; mutation: "send me" → T6 fails |
| Full run ×2 | 396.2 s default order, 394.9 s reversed (outbound last); all suites green; chats 6109/6852, 215 unused codes, 0 debris before and after |

Each run ended with `business_chats unchanged (2: 6109,6852)`, `unused bind codes unchanged`, `test-shaped leads unchanged (0)`.

### NOT verified
- Real Gmail/Outlook/Apple Mail rendering; real Telegram rendering of the new `/code` pair.
- Operator commands in real Telegram (branch only).
- Whether Vercel fires both crons; `DIGEST_ENABLED` unset.
- Real-device LCP; retry mutex across instances; `authenticated` with a real JWT; fresh-DB migrations; digest query plan at scale.
- The owner's manual checklist: `/recipients` on A and B; a real lead reaches both phones; stale card on B; remove/re-invite; account C as owner of `second-demo`.

### How to see changes visually
```powershell
git fetch origin
git checkout ops-audience
node scripts/preview.mjs
start _debug\previews\index.html
git checkout main
```
For real Telegram/Gmail: `scripts/preview-send.mjs --to <chat id> --yes [--email <addr>]` (refuses bound chats unless `--allow-bound`).

---

## 10. Decisions already made (do not re-litigate)

- **WhatsApp:** not building. Telegram is the channel; email is the universal fallback.
- **Telegram-ID pre-authorization rejected:** codes/links are better.
- **Operator vs owner separation:** dedicated operator chat; operator text never reaches owner chats; owner = oldest phone; staff phones cannot invite/remove.
- **`/code` is two messages.** The client-forwardable one is **anonymous** (no business name, no slug). The operator's own message names the slug.
- **The forward text points at the bot**, never "send me".
- **No customer name in operator no-phone notices.**
- **Owner messages per business, never merged.** One branded email template. Emoji only next to words.
- **`MAIL_REDIRECT_TO`:** loud, not a hard failure until the first real client.
- **Retention:** explicit scripts, no cascade; window is a business/legal decision.
- **Fixture ids:** reserved range `5e15`+; never a real-space id. The sweep needs key shape + `.invalid` marker.
- `BIZ_LIMIT` 200; auto-reply 40/day; digest 13:00 UTC; selfcheck 09:00 UTC; `#9aa0a8` borders; hero video untouched; close button 40 px; sharp bump deferred; PR #6 stays draft.

---

## 11. Queue (what to do next)

| # | Item | State |
|---|---|---|
| 1 | ~~Merge PR #7~~ | **MERGED** (observed) |
| 2 | Review `ops-audience` from the single `.diff` | Waiting for the artefact |
| 3 | ~~A3 cancel pending invites~~ | **Done** (R15-R21, OP17-OP19) |
| 4 | ~~A4/A5 purge~~ | **Done** (K1-K8) |
| 5 | GROUP 3: ceiling 600, claim-then-bind, `/start@botname`, `tg-webhook` docs | **Done** (R22-R24, C37) |
| 5b | Keyset paging for `/leads` Older | Report only: not small (cursor in callbacks, both directions, index check) |
| 6 | GROUP 5: hostile-reviewer pass over the branch diff | Not started |
| 7 | Owner runs the manual checks in Section 9 and reports | Owner |
| 8 | Owner creates `.env.test` (Paris), then Phase C prompt | Blocked on owner |
| 9 | README + CI + preview check + review of `main` + test-quality audit | Unsent |
| 10 | Summary schedule implementation | Proposal only |
| 11 | Country of first clients | Ask the owner |

---

## Decisions (2026-11-12)

- Leads belong to the client. The business owner is the data owner; the platform
  operator provides the system.
- Retention is one global rule, stored as a per-client config field with the same
  default for everyone: keep leads while the client is active; delete on request
  within 30 days; delete all client data 30 days after the client leaves. **To be
  reviewed by a lawyer before any contract.**
- Alerts are best-effort for now. The guaranteed notification outbox is **FUTURE
  IMPLEMENTATION**, planned for when the hosting plan is upgraded; nothing is built
  now.
- Uptime and outage alerting is **ON HOLD** and remains a proposal only.
- Country, phone format, timezone and legal text are configurable per client.
  Language stays English.
- Review flow decision for page work, not implemented here: everyone is sent to
  the Google review link, whatever the rating.
- One shared Telegram bot serves all clients; one Telegram account/chat belongs
  to one business only. Vercel Hobby is non-commercial, so no paying client may
  use it. Choose Vercel Pro or another commercially permitted host first.
- Working method: the owner uses a local worker and an online worker; a separate
  assistant reviews; every task ends with a diff file for review.

### Owner decisions pending

- **Architecture — DECIDED:** A, one shared Host-routed deployment. B remains an
  escape hatch for a client needing a separate custom project; do not fork code.
- **Hosting:** Vercel Pro or a compliant alternative before accepting payment.
  Default: Vercel Pro because the repo and TEST harness already target Vercel.
- **Retention/legal:** lawyer review of the retention window, deletion promise,
  privacy/terms URLs, and lead notice before a contract. Default: do not sign
  until reviewed.

## 12. Git state (as of this report)

- `origin/main` = `1d2c748fd779f0b6a1c789dca969eb2698791d1a`; PR #25 was verified
  merged into it on 2026-11-12 before starting this branch. Never push to `main`.
- `ops-audience` (PR #6): merged to `main` on GitHub (`4348b24`); local `main` = `origin/main`.
- `fix-code-copy`: merged to `main` as `1e3be74` (PR #8).
- `operator-ux`: merged to `main` as `baf15d1` (PR #9).
- `email-brand`: merged to `main` as `fb4680c` (PR #10).
- `operator-roles`: merged to `main` as `a29f36d` (PR #11).
- `operator-views`: merged to `main` as `6bd7bb4` (PR #12, menu only).
- `operator-redirects` (PR #13): merged to `main` as `df3a4b8`. The local branch is deleted; its one post-merge commit lives on as `7110a8f`.
- `operator-redirects-2` (PR #14): merged to `main` as `de2c8fe`; head was `7110a8f`.
- `vercel-storage` (from `origin/main`): builds `main` only; `**` catches branch names with a slash; head `8366d37`. Draft PR #15.
- `test-isolation` (from `origin/main`): dev root (hardened removal), production canary, shape checks, strict db-wall, absolute guard, disk preflight, build-output cleanup and startup sweep, port-guard test, canary rate-limit reset; head `5639d3c`. Draft PR #17.
- `client-config` (from `origin/main` at `455245e`): `clients/<slug>.json` drives the build; head `af4cbc8`. Draft PR.
- `client-identity` (from `origin/main` at `07caea0`): address, sender, unused-key check; head `3eae101`. Draft PR.
- `owner-ux-fixes` (from `origin/main` at `8c2df50`): paging, row order, invite pair, one-sentence reply, modal buttons, three-account manual script; head `d2e5749`. Draft PR.
- `visual-polish` (from `origin/main` at `fa6030d`): CSS file, modal button, email layout and logo, review card, list paging, removal line, absolute href, logo cache; head `8a6523d`. Draft PR.
- `polish-followup` (from `origin/main` at `78f1827`, five commits cherry-picked): narrow modal widths, not-modified edit; head `835f3ee`. Draft PR.
- `multi-tenant-design` (from `origin/main`, not from `vercel-storage`): design doc only; head `67b38f2`. Draft PR #16.
- `lead-safety` (from `origin/main` at `aab66e4`, PR #23 verified merged before starting): stored-but-silent
  leads are re-announced on an idempotent replay, one claim per lead, one bounded notification round with a
  6 s deadline, parallel phone fan-out, a timeout treated as unknown, one idempotency key for the owner email,
  a form that cannot hang, and a shared redirect predicate for health and the daily check; outbox and
  uptime-check proposals only. Independent-review follow-up: lead `maxDuration` 30 with no tg override;
  truthful Resend replay/409 handling; salted per-chat outcomes and targeted partial retries; honest
  fixed-window claim docs; duplicate-panel recap hidden; built page `aa71755b` -> `80d6281c`, other output
  hashes unchanged. Review branch `arena/9c9b4995-alder` is based on this branch; `origin/lead-safety`
  is an ancestor. Local verification uses `.env.test`, never production. Draft PR #25 targeted `main`
  and superseded #24; #24 remains untouched. PR #25 was later merged into `origin/main` at
  `1d2c748fd779f0b6a1c789dca969eb2698791d1a`. Current verification and mutation results are in the
  2026-11-12 change-log row below. Review artifacts are `_debug/patches/arena-fix-delta-2.diff` and
  `_debug/patches/lead-safety-review.diff`.
  No schema change. The review branch was pushed after a dry-run and merged by its owner.
- `multi-client-prep` is based directly on the merged `origin/main` above. Commit `dd34ba9`
  contains the architecture comparison, replay fix, and onboarding/handoff updates. It was
  pushed after a successful dry-run; draft PR #26 targets `main`.
- Owner state: **A (6109) operator only, unbound; B (6852) owner of alder-demo; second-demo 0 phones**.
- `ops-audience` (PR #6): merged; `git merge-tree` against `main` is clean.
- `fix-invite-message` (PR #7): head `a2bbd67`; GitHub reports **MERGED** (observed 2026-11-07).
- Review artefact: `_debug/patches/ops-audience-review.diff` (gitignored), single file.
- Remote: `origin https://github.com/AbdallahIsDev/alder.git`. Never push to `main`, never force, no tags.

### How PRs work here (PR map)
| Branch | PR | Role |
|---|---|---|
| `main` | — | deploys to production; never pushed by an agent |
| `arena/9c9b4995-alder` | #25 | lead-safety corrections; merged to `main` at `1d2c748` |
| `multi-client-prep` | #26 | multi-client comparison + replay guard; draft, base `main` |
| `ops-audience` | #6 | the operator work and every fix that came out of reviewing it; one review `.diff` against `main` |
| `fix-invite-message` | #7 | cut from `main`, merged into `ops-audience` as `58d2707`; GitHub reports it merged |

One bundle = one branch off `main`, one review artefact, push dry-run first. A PR
description may be edited; draft state and merges are the owner's decision.

---

## 13. Change log (one row per bundle)

| Date | Branch | Commits | What changed | State / issues |
|---|---|---|---|---|
| 2026-11-07 | `db-backend` | (merged) | Test speed, security audit, reliability, digest, recipients | Merged to `main` |
| 2026-11-07 | `ops-audience` | `5cc59aa` `81e2132` `92eefa2` | Per-business selfcheck, audience rule, branded email, proposals | PR #6 draft |
| 2026-11-07 | `fix-invite-message` | `b5bb654` `a2bbd67` | `/invite` newlines + deep link; bot-text guard; network guard | PR #7 draft; live bug until merged |
| 2026-11-07 | `ops-audience` | `f404b4e` `0c9c07c` `963e340` `2d21cd5` `e56caee` | Operator channel, commands, recovery, tools | OP1-OP13 |
| 2026-11-07 | `ops-audience` | `22cff44` `f36afbe` `33a7d27` `1f1910a` `0c1bb02` `6fc03c9` | B14/B15 test bugs, sweep safety, three green runs | Review suite green |
| 2026-11-07 | `ops-audience` | `82a0abc` | Reserved fixture ids, pre-clean, two-signal sweep, paged reads | F1-F7 |
| 2026-11-07 | `ops-audience` | `6198e67` | `/code` two messages, bot-directed wording, no customer name in ops notice | OP2/OP14/OP15/OP16, T6/T7 |
| 2026-11-07 | `ops-audience` | `e11877b` | `/code` fixtures on `zz-test-<run>`; unused-code leak guard | Owner cap root cause |
| 2026-11-07 | `ops-audience` | (docs) | This handoff rewritten as one coherent document; drifted §8/§9/§10 blocks folded in; corrected the "two real phones on alder-demo" claim | Docs only |
| 2026-11-07 | `ops-audience` | `c8d45bf` | Bounded housekeeping in the daily selfcheck (codes 7 d, rate limits 2 d, 1000/run, used codes never) | K1-K7 |
| 2026-11-07 | `ops-audience` | `b953c88` | `/invite` cancel button; bind read-back + claim restore; 600/h ceiling; health requires a review identifier | R4/R5, R15-R24, H1b |
| 2026-11-08 | `ops-audience` | `45ef16e` | Bind tests on `zz-test-bind-<run>`; F8 bans real-business mints; OP17-OP20 real-DB cancel/restore | F8, OP17-OP20 |
| 2026-11-08 | `ops-audience` | `829cc1e` | `/command@thisbot`; two-account MANUAL_TESTING; tg-webhook set/info docs | C37 |
| 2026-11-08 | `ops-audience` | `0b55342` | `scripts/purge-expired.mjs` (dry run, two guards) | K8 |
| 2026-11-08 | `ops-audience` | `45f32f7` | Retry lock keyed by failure generation; C33 loops 20x; OP21 pins unset OPERATOR_CHAT_ID | C33-C35, OP21 |
| 2026-11-08 | `ops-audience` | `dbb7eec` | Resend idempotency 409 = duplicate; bind read error says "something went wrong" and restores the claim | C38/C39, R25 |
| 2026-11-08 | `ops-audience` | `fafa5d8` | Client message is text + entities (no parse_mode, no visible URL, code once); link replies are role-aware, and an unbound operator cannot bind itself | T2/T3/T6/T7, OP2/OP16, W1-W5 |
| 2026-11-08 | `fix-code-copy` | `f710cc7` | No `parse_mode` anywhere (C40); resend is text + entities; fallback drops the link sentence; operator link replies read the code state; preview renders entities | T3/T7/T8, OP14, W2 |
| 2026-11-08 | `operator-ux` | `1c900e2` | Numeric /leads (5/page), phone list without self-remove, operator names + pickers, /id operator wording, /code cancels older codes, copy audit | OP7/11/12/22/23/24, R8/R10, T9 |
| 2026-11-08 | `email-brand` | `e118554` | Emails strip emoji at the builder boundary; one lockup renders logo + name (platform for owner/ops, company for customers) | L5, L6 |
| 2026-11-08 | `email-brand` | `7a96514` `057f783` `d435dcd` | Company header on every company email; digest targets carry the name; preview uses current builders; OP3 boundary retry | L6b/L7-L9, D-name, T8, OP3 |
| 2026-11-08 | `operator-roles` | `d06d404` | `/remove_lead` (owner only, scoped, confirm + danger), operator welcome, never bound | OP25-OP28, T10 |
| 2026-11-09 | `operator-redirects` | `b24aa76` `4da4a0b` `f7eeb60` | Operator answers for /invite /recipients /help /leads /remove_lead; /businesses counts paused phones; self-check email header on its own line (S4b); test-project schema/seed/docs/env-check | OP33/OP34, S4b, T1 |
| 2026-11-09 | `operator-redirects-2` | `7110a8f` | Env check back to names-only readiness by default with the posture report behind `--db`; docs restored and merged with the SQL-editor route; one seed (`Alder Roofing`) with M5/M6 drift guards; `/businesses` says `?` when the count fails | PR #14 **merged** (`de2c8fe`); 382 assertions green |
| 2026-11-09 | `vercel-storage` | `7a931f7` | `git.deploymentEnabled` builds `main` only; V1–V3 test; OPERATIONS §10 on deployment storage and retention | PR #15 draft |
| 2026-11-09 | `multi-tenant-design` | `67b38f2` | One deployment for many clients: inventory, three-table proposal, content schema, rendering comparison and recommendation, assets, commands, migration plan | PR #16 draft, docs only |
| 2026-11-09 | `vercel-storage` | `8366d37` | `**` catch-all so branch names with a slash are covered; V2b models Vercel's no-rule default; sourced Pro storage and domain facts; Phase C green on the test project; Supabase key-format review added as an open item | PR #15 draft; 391 assertions on the test project |
| 2026-11-09 | `test-isolation` | `6789644` | `vercel dev` runs from a dev root with no .env; canary checks production and aborts; env shape validation (URL, DSN, key format, swap); db-wall passes only on a real denial; SKIP lines counted in the runner summary | Draft PR; suite counts in the PR |
| 2026-11-09 | `test-isolation` | (this branch) | `ALLOW_PROD_TESTS` removed — a suite run needs `TEST_ENV=1` plus `.env.test`; `--seed-check` renamed to `--read-production-seed` with a deprecated alias; `build-static.js` copies assets with `dereference: true`, so the dev root links them | PR #17 draft |
| 2026-11-09 | `test-isolation` | `8fe7200` | Disk preflight: the runner refuses to start under 2 GB free, `DISK_MIN_BYTES` can raise the floor but not lower it; `statfsSync` works on Windows, Linux and macOS | PR #17 draft |
| 2026-11-09 | `test-isolation` | `c991e67` | The runner removes `_debug/build-test` on every exit, exact path only; the port-3000 refusal now applies only to runs that start a server, so a DB-only or nested run can share the machine | PR #17 draft |
| 2026-11-09 | `test-isolation` | `8610a99` | Startup sweep for `_debug/build-test` (a killed run never reaches cleanup); the port-3000 guard is proven by a standalone test that binds the port; the suite list is deduped (two suites were registered twice) | PR #17 draft |
| 2026-11-10 | `test-isolation` | `c87d1a0` | The runner clears the canary business's rate-limit rows after the canary proves the host (exact key, max 100, never on production or an unknown host); `tests/suite-list` fails on a duplicate registration; `npm run test:port-guard` is the required check when `tests/run.mjs` changes | PR #17 draft |
| 2026-11-10 | `test-isolation` | `5639d3c` | `removeDevRoot` re-scans after unlinking and refuses the recursive delete if a link survived; one fixed WARN line for every canary-reset skip reason except none; CI proposal recorded | PR #17 draft |
| 2026-11-10 | `client-config` | `af4cbc8` | Alder's page is built from `clients/alder.json`; `--client`/`CLIENT` selects one; the build refuses a missing, invalid, incomplete or unknown-key file with one line; a sample client builds clean; Alder's output is byte-identical | Draft PR |
| 2026-11-10 | `client-copy` | `876ec81` | The rest of the page copy (66 blocks) moved into the client file; the template BIZ is now a key list with empty values; tag-bearing blocks split around the tag; slugs validated; `sync-brand` reads the client file | Draft PR |
| 2026-11-10 | `client-identity` | `3eae101` | Unused copy keys fail the build; `robots.txt` and `sitemap.xml` generated from the client's `domain`; optional per-client `sender`; sample builds cannot overwrite the tracked brand file | Draft PR |
| 2026-11-10 | `owner-ux-fixes` | `d2e5749` | Empty list pages answer the tap instead of replacing the message; /leads puts the age last; /invite sends the instruction then the forwardable message; a bound chat gets one sentence; owner commands re-proved per command and per forged callback; final modal Call/Close row | Draft PR; 462 assertions on the test project |
| 2026-11-10 | `visual-polish` | `69bb14c` | CSS moved to `assets/css/styles.css` and linked; modal Call filled at 52px; owner email stacks its buttons on a phone, 124px labels, 16px around the divider; logo is two colours at 256px from the favicon; review page is a card from 640px | Draft PR; page hash 20948309 → 23af892b |
| 2026-11-11 | `visual-polish` | `8a6523d` | A stale list page is rewritten after the toast (numbers now, Older only when real, empty text with no buttons); the removal line names the request and the job; the stylesheet href is root-absolute; both logo URLs carry the file hash | Draft PR; page hash 23af892b → be79571b |
| 2026-11-11 | `polish-followup` | `835f3ee` | Modal buttons share one row down to 354px and stack below; the dialog no longer stretches past the screen on a long label; the fake can answer 400 not-modified and the bot treats it as success | Draft PR; CSS hash 4b24ccda → 7ecc159a |
| 2026-11-11 | `lead-safety` | `c674d03` | A replay of an idempotent lead re-announces it when no channel delivered; per-lead claim in `rate_limits` (10 s bucket, released in a finally, fails open); the missing `created` event is written once | B1a-B1f, 51/51 |
| 2026-11-11 | `lead-safety` | `9fd9919` | Telegram fan-out is `Promise.allSettled` over every bound phone, one 6000 ms round deadline shared with the fallback, abandoned phones recorded as `timeout` + `abandoned`; `maxDuration: 10` for `api/lead.js` and `api/tg.js` | B5p/B5d, notify 53/53, vercel-config 5/5 |
| 2026-11-11 | `lead-safety` | `f771b5a` | A timeout is unknown, not failed: never retried; the fallback owner email reuses `<leadId>:owner`, so a lost answer cannot double-alert | B6a/B6b, notify 55/55 |
| 2026-11-11 | `lead-safety` | `48e0c4a` | The form aborts each attempt at 12 s, retries once after 700 ms under the same key, posts nothing when offline and says so, and shows the already-received panel for an in-page duplicate (B19) | 12c-12e, B19, lead-api 49/49; page hash `be79571b` -> `aa71755b` |
| 2026-11-11 | `lead-safety` | `c3529ce` | `mailRedirectConfigured()` / `mailRedirectInProduction()` in `lib/mail.js` are the one answer for `/api/health`'s flag, the production log line and the daily operator line | B12a/B12b, health 31/31 |
| 2026-11-11 | `lead-safety` | `cf85761` | `docs/proposals/notification-outbox.md` (0005 SQL as text, claim/drain design, independent alarm channel) and `docs/proposals/uptime-check.md` | Docs only; `supabase/migrations/` untouched |
| 2026-11-11 | `lead-safety` | (this commit) | `docs/OPERATIONS.md` §4c/§4d/§8: how one lead is announced, how to find a silent lead, the form's retry rules, the timeout and redirect semantics | Docs only |
| 2026-11-11 | `lead-safety` review | (this wrap-up) | Lead `maxDuration` 30; truthful Resend replay/409 outcomes; partial Telegram retries by salted chat hash; claim/browser/recap honesty; stale docs and tests corrected | Draft PR #24; no schema. Static/mutations green; DB/full suite blocked by unset `SUPABASE_URL` |
| 2026-11-12 | `arena/9c9b4995-alder` | `2173631` | Re-verified partial-chat retries and concurrent 409 handling; suppressed owner-email retries after uncertain Resend 5xx, corrected delayed-500 fake support, isolated digest fake idempotency state, and recorded decisions | B1a–B1f, B5p/B5d/B5r, B6a/B6b, C38/C39 passed; touched suites 245/0/0 in 254.6s; full 502/0/0 in 320.6s (baseline 496); mutations failed as intended; review diffs are gitignored at _debug/patches/lead-safety-review.diff and _debug/patches/arena-fix-delta.diff; no schema |
| 2026-11-12 | `arena/9c9b4995-alder` | `e01b7e4` | Restored owner-email 5xx fallback and replay retries with one attempt per replay; replay now retries both missing paths after partial Telegram delivery; operator alarms claim each problem with fail-open behavior; documented digest claim outcomes; assessed sharp High and deferred non-lockfile upgrade; corrected stale test, cron, self-check, and build docs | D5 strict and B12 restored to baseline strength; interim D5/B12 suppression was weaker and is fixed. Touched 170/0/0 in 131.7s plus notify rerun 62/0/0 in 67.3s; full 506/0/0 in 313.2s (prior 502/0/0 in 320.6s); mutations failed as intended; PR #25 merged to `main` on 2026-11-12; no schema |
| 2026-11-12 | `multi-client-prep` | `dd34ba9` | Added A/B architecture decision memo, honest manual onboarding limits, owner decisions, and replay guard for recorded structural email failures | B8b added; no assertions weakened. Touched suites: lead-api 51/51 + notify 62/62, 136s. Full TEST project: 507/0/0 across 34 suites in 329.6s (+16.4s vs baseline 506/0/0 in 313.2s). B8b mutation: 50/51, failed as expected (ownerAttempts=1). No schema. Pushed after dry-run; draft PR #26 targets main. Review diff: 49,243 bytes / 572 lines, zero secret-pattern hits; apply-check passed on fresh `origin/main` worktree |

### Edge cases — operator redirects (R1a) and T1
| Case | Behaviour |
|---|---|
| Operator chat bound or not | the operator answers come from `OPERATOR_CHAT_ID`, never from a binding |
| `/leads second-demo` from an owner | the slug is ignored; only that chat's business is listed |
| Unbound non-operator chat | client text (`This chat isn't connected yet`) unchanged |
| Paused/churned business in `/businesses` | real phone count by id, not 0 |
| Many businesses | the picker refuses more than 8 with the usage text |
| Test project missing `.env.test` | runner refuses the production host; `test:env-check` reports `is production host: true` |
| Test project posture | RLS per table, anon grants and `rls_auto_enable` compared to production (7/7, none, present) |
