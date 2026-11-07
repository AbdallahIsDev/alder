# SESSION HANDOFF: Alder roofing lead platform (orchestrator continuation)

> **Purpose.** Give this file to any cloud AI assistant so it can continue as the **orchestrator** for this project without the owner re-explaining anything.
> **Last updated:** 2026-11-07 (end of the "ops-audience / operator channel" bundle).
> **Rule for the local agent:** after every task, update this file (Section 13 "Change log" and any section whose facts changed). Never put secret values in it.

---

## 1. How we work (read first)

### Review artefact rule (set 2026-11-07)

Exactly ONE review file per task: `_debug/patches/ops-audience-review.diff` =
`git diff origin/main...ops-audience` (every commit from main to the branch head,
combined). No `.patch`, no last-N, no per-area splits for this task; old files may
stay, do not add more. Report its size, line count, `git apply --check` result
against a fresh `origin/main` worktree, and a secret scan (counts only).

### Backup/restore rule (set 2026-11-07)

The backup, reset and restore touch ONLY the `businesses` columns of `alder-demo`.
`business_chats` is never read for a restore, never deleted, never re-inserted:
a phone can be connected at any moment. `seed-check` reports the chat count and
does not require it to be zero. The runner fails a run that adds or removes a
chat or leaks a test-shaped lead.



### Roles
| Role | Who | Does |
|---|---|---|
| **Owner** | The human (Cairo, Egypt, GMT+2; Windows, PowerShell) | Decides, tests on real phones, creates accounts and secrets, relays prompts and reports |
| **Orchestrator** | You, the cloud assistant | Never touches the repo. Writes **prompts for the local agent**, reviews its reports and code, answers the owner's questions, keeps the queue |
| **Local agent** | AI agent on the owner's machine (`C:\Users\11\projects\Roofing-2`) | Reads/changes code, runs tests, commits, pushes branches, opens PRs, writes reports |

### The loop
1. Owner describes a goal or problem. The orchestrator clarifies, **thinks of edge cases itself** (the owner does not want to brainstorm them), and writes **one complete prompt** for the local agent.
2. Owner pastes the prompt to the local agent. The agent works and returns a **final report**.
3. Owner pastes the report back. The orchestrator **reviews it critically** (see Section 2), answers the agent's numbered questions, and writes the next prompt.

### Prompt-writing rules (every prompt must include)
- **CONTEXT** block: branch, "never push to main", no force, no tags, push dry-run first.
- Standard rules: never print secret values (names/counts only); every behaviour change gets a **test plus a mutation check** (break the code, show the test fails, revert); one commit per logical item with hashes; **schema changes are proposals only** (never apply a migration, never leave an unapplied migration in `supabase/migrations/`); update `HANDOFF_alder_session.md` and `docs/`.
- Production-DB rule: do not run suites against prod unless required; if so, **back up once with a timestamped filename, never overwrite a backup, verify the chat row is inside it before any reset, restore from that exact file**, confirm by column names and counts only.
- **EDGE-CASE RULE:** for each feature, the agent writes the edge cases it can think of beyond the owner's list (abuse, races, stale UI, missing data, multiple businesses/phones) and reports a table: case / current behaviour / decision (test ID, proposal, or n/a).
- **FINAL REPORT FORMAT:** one section per step with commit hashes, tests added, mutation results, changed assertions (before/after), what was NOT verified; suites run and **which database**; `git status`; `git log --oneline`; anything stopped/reverted; **Critical/High at the top**; numbered questions.
- **REVIEW HAND-OFF block:** every commit as a full URL `https://github.com/AbdallahIsDev/alder/commit/<40-char sha>`, compare URLs, PR URLs, and `.patch` + `.diff` files in `_debug/patches/` (gitignored), each under ~900 KB, verified to apply to a fresh worktree of main, secret-scanned (counts only), absolute paths printed.
- **HANDOFF UPDATE (mandatory in every prompt):** "Update `SESSION_HANDOFF.md` (root) with what you completed, what changed in the state, new issues, and new open questions. Do not include secret values."
- Keep the owner's UX principles in mind (Section 3).

### Pending-prompt tracking rule
**Assume a prompt has NOT been sent to the agent until the owner pastes a report for it.** Keep the queue (Section 11) accurate so nothing given earlier is forgotten when new topics come up. When new work arrives, say what is still outstanding.

---

## 2. How the orchestrator reviews code

The orchestrator reviews from three sources, in this order of preference:

1. **The agent's final report**: check evidence, mutation results, honest disclosures, what was "not verified", and whether any assertion was changed or loosened.
2. **Commit links** (`github.com/.../commit/<full sha>`): fetch with the web-fetch tool. Limitations learned: **only full URLs that appear in the owner's message can be fetched; a bare hash cannot**, and the commit page **truncates after ~5 of N files**. So for big commits ask for the `.patch`.
3. **The `.patch` / `.diff` files** (attached by the owner): read these for a complete line-by-line review. Note: a branch that contains a merge commit cannot be replayed with `git am`; `git apply` of the `.diff` works.

Also review: the PR description, the branch/merge workflow, the suites run and **against which database**, and the commit granularity.

What to look for: unhandled rejections, fail-open paths, module-level state across warm invocations, PII in logs/messages, cross-tenant leaks (one business seeing another's data, operator text reaching owners), idempotency-key collisions, tests that assert too little (the `//n` bug passed because the test only checked "no banned words"), dead code, stale comments, loosened assertions, tests coupled to production data.

Report review results to the owner, then fold any findings into the next prompt.

---

## 3. Owner preferences and working style

- Wants the **easiest possible client experience** and **fewer support tickets**: owners should fix problems themselves (recover a lost message, reconnect, etc.).
- **Few options, not many.** Presets (2-4 choices) beat free-form settings. Avoid overengineering.
- Wants the orchestrator to **warn and push back** when an idea is insecure or wrong, explain why, and offer a better alternative (or say the current approach is already best).
- Wants **edge cases identified proactively**, so a feature is done properly the first time.
- Quality bar: visual quality of the hero video is **non-negotiable**; close button stays 40 px; keep the existing look unless asked.
- Wants prompts that are complete, copy-paste ready, in one block, with the handoff-update instruction.
- Wants to **see** changes visually (preview gallery, real Telegram/Gmail); see Section 9.
- Open question to the owner (still unanswered): **which country are the first roofing clients in?** It decides digest hour, phone defaults and the WhatsApp cost question.

---

## 4. The project

**Alder**: a lead platform for roofing contractors. A homeowner fills a multi-step estimate form on a public landing page; the contractor is alerted instantly on **Telegram** (with buttons) and by email; the system can auto-reply to the customer by email, request a Google review after the job, and send operational summaries.

| Item | Value |
|---|---|
| Repo | `https://github.com/AbdallahIsDev/alder` |
| Local path | `C:\Users\11\projects\Roofing-2` |
| Live site | `https://alder-roofing.vercel.app` (deploys from **`main`**) |
| Hosting | Vercel **Hobby** (cron once per day max; non-commercial; Pro needed before paid clients) |
| DB | Supabase Postgres, project in **us-east-1** (median round trip ~192 ms from Cairo) |
| Telegram | Bot via webhook `api/tg.js`; helper `lib/tg.js` |
| Email | Resend (`lib/notify.js`, `lib/email-layout.js`, `lib/email-builders.js`) |
| Local dev | `npx vercel@48.12.1 dev` (pinned) on port 3000 |
| Tests | Custom runner `tests/run.mjs`, suites `tests/*.test.mjs`, fake Telegram/Resend loopback servers, JSDOM for the modal |

### Key files
`api/lead.js` (submission), `api/tg.js` (webhook + callbacks), `api/review.js` (review pages/tokens), `api/health.js`, `api/selfcheck.js`, `api/digest.js`, `lib/db.js`, `lib/digest-db.js`, `lib/lead-intake.js`, `lib/notify.js`, `lib/ops-delivery.js`, `lib/ops-copy.js`, `lib/operator.js`, `lib/bind-codes.js`, `lib/request.js` (`clientIp`, `secretMatches`), `lib/content.js` (all bot/customer copy), `lib/outbound.js`, `scripts/` (apply-migrations, make-bind-code, preview, live-smoke, tg-commands, delete-lead, offboard-business, sweep-demo-leads, send-test-lead, preview-send), `supabase/migrations/0001..0004` + `seed.sql`, `index.html` (landing page + modal), `build-static.js` (builds `dist/`), `docs/`, `HANDOFF_alder_session.md` (the agent's own repo handoff; **different** from this file).

### Security/architecture facts (verified)
- RLS on all tables, deny-by-default, no policies; app uses the **service role** server-side only. `v_client_leads` is `security_invoker`. Roofer-facing code never SELECTs directly from `leads` (test C10 enforces it; that is why `findRecentDuplicate` and `digestCounts` live in separate modules).
- Telegram authorization: business is derived **only** from `business_chats.tg_chat_id`; callbacks are anchored-regex validated; lead lookups are scoped by `id + business_id`; transitions are conditional UPDATEs.
- Bind codes: single use, 24 h, same minting function everywhere (`lib/bind-codes.js`).
- Secrets: `HEALTH_SECRET` and `CRON_SECRET` are **different** values, compared in constant time. They were once visible in chat and were **rotated**; `/api/digest` with bearer returns 200.
- `OUTBOUND_TIMEOUT_MS` override and `*_API_BASE` overrides only honoured in dev (`isDev()` is fail-open on unset `VERCEL_ENV`; evaluated, documented).
- Latest npm audit and security audit: **no Critical/High** findings (earlier bundle).

---

## 5. Environment variables (names only)

Required in Vercel: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `IP_HASH_SALT`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `RESEND_API_KEY`, `MAIL_FROM`, `SITE_URL`, `HEALTH_SECRET`, `CRON_SECRET` (different from HEALTH_SECRET; selfcheck/digest return **503 if `HEALTH_SECRET` is unset even when `CRON_SECRET` is set**, so set both).

Optional: `TELEGRAM_CHAT_ID`, `MAIL_REDIRECT_TO`, `MAIL_REDIRECT_PREFIX` (**remove before first real client**), `AUTOREPLY_DAILY_CAP` (default 40), `DIGEST_ENABLED` (**currently unset = digest is a no-op**), `DIGEST_UNTOUCHED_DAYS` (14), `RECIPIENTS_MAX` (5), `INVITES_MAX` (3), `TELEGRAM_BOT_USERNAME` (new, optional override), `DATABASE_URL` (migrations only), `VERCEL_ENV` (set by Vercel).

New in `ops-audience` (not yet deployed): `OPERATOR_CHAT_ID` (falls back to `TELEGRAM_CHAT_ID`), `OPERATOR_EMAIL` (email fallback for operator alarms).

Test-only: `.env.test` (**does not exist yet**; see Section 8), `TEST_ENV=1`, `ALLOW_PROD_TESTS`.

---

## 6. Timeline: what has been done

### Phase 1 to 3: test speed and hardening (branch `db-backend`, now merged)
- Test-speed bundle: suites in-process, runner timing, dev-only timeout override. Total 411 s to ~272-304 s. The 180 s target was **not** met: ~93 % of remaining time is DB round trips to us-east-1.
- Fixed handoff numbers, closed #6 (unused import) and #7 (emoji statuses already done).
- Security audit: no Critical/High. Fixed: `0004` missing from `ALL_FILES`, inverted env precedence, dev-ready message, stale `hangMs`, shared `clientIp`, `fakeRes`, constant-time secret compare.
- Reliability: cross-channel fallback (if both Telegram and email fail, each is retried once, recorded with `meta.fallback`), `/api/health`, `/api/selfcheck`, daily cron, `MAIL_REDIRECT_TO` loud warning, 40/day auto-reply cap (via `hit_rate_limit`, 24 h bucket), duplicate-lead detection (`duplicate_of`, "Possible repeat" line), double-tap Try-again mutex (`retry:<leadId>`, released in `finally`), deletion scripts (dry-run default), flaky C9 fixed, handleCallback dispatch table (C31 anchors updated with approval).
- Accessibility: one live region, field errors linked by `aria-describedby`, form-control borders ≥3:1 (`#9aa0a8`), orphan 11 MB PNG removed, OG image 501 to 204 KB.
- Digest (`/api/digest`): per business counts only, Telegram then email fallback, claim per business per UTC day, released if nobody was reached, active businesses only, 14-day lookback, chunked/paged queries, cron `0 13 * * *`; selfcheck cron `0 9 * * *`.
- Multiple recipients: `/invite`, `/recipients` (caps 5 phones / 3 pending invites, scoped removal, last phone protected).
- Lighthouse (mobile, simulated): perf ~0.79, a11y 0.96, LCP ~4.1 s (hero video 5.87 MB is the LCP element, **kept as is by owner decision**), CLS 0. Only a11y failure: `ol.steps` contains a `<span>` (**fix not yet approved or done**).
- Pushed and **merged to `main`** (main = `0f97cf6` at last check). Cron secrets rotated and verified in production.

### Phase 4: diagnosis of "New" and "Not found" (read-only, done)
No data lost. The three manual-test leads are `done` with full event trails. "New" rows in `/leads` are five newer **test-debris** leads (suite/canary/measure/form keys) that sort above them. "Not found." came from tapping Mark contacted on a lead already `done` (the DB refuses `open to contacted`). Production totals unchanged: 8 leads / 50 events / 2 review_feedback.

### Phase 5: branch `ops-audience` (PR #6, DRAFT)
- Per-business self-check counts, audience rule, one shared branded email layout (`lib/email-builders.js`, `LAYOUT_MARKER`), plain-English copy ("Your lead summary", "Alert check"), preview gallery additions, docs/PROPOSALS.md §5d (summary schedule proposal). Commits `5cc59aa`, `81e2132`, `92eefa2`.
- Findings: the first manual `/api/selfcheck` sent Telegram + email because `second-demo` has no chat (falls back to email); the later cron sent Telegram only because the idempotency key `selfcheck:<id>:<UTC date>` repeated within Resend's 24 h window. Tomorrow's key changes, so both may arrive again.
- Disclosed: an intermediate test set `VERCEL_ENV=production` and two sends reached the real Telegram/Resend APIs (rejected, nothing delivered). Fixed with the network guard below.

### Phase 6: operator channel bundle (latest report, on `ops-audience` + `fix-invite-message`)
- **`fix-invite-message` (PR #7, DRAFT, from main):** `/invite` text had a typo `//n//n` instead of `\n\n` (`lib/content.js:193`) and no tappable link. Now a real `https://t.me/<bot>?start=<CODE>` link (bot username via cached `getMe()`, fail-soft), plain code, expiry. New `tests/bot-text.test.mjs` renders 42 bot strings and fails on literal `\n`, `//n`, `${`, `undefined`, `[object `. Commits `b5bb654` (also holds the network guard), `a2bbd67`. **This bug is LIVE on main until PR #7 is merged.**
- **Network guard (Step 0):** `tests/env.mjs` throws on any non-loopback, non-Supabase host regardless of `VERCEL_ENV` (N1-N5).
- **Operator channel (`f404b4e`):** `lib/operator.js`; operator-only text goes only to the operator chat; owner messages are per business and never contain operator text; one aggregated operator alarm (Telegram, then email, then `operator_alarm_undelivered` shown in `/api/health`); recipient de-dupe removed; the `TELEGRAM_CHAT_ID` button fallback removed (no-chat lead sends the operator one buttonless notice).
- **Commands and recovery (`0c9c07c`):** `/code <slug>`, `/phones <slug>`, `/businesses`, `/operator`, `/id` (any private chat, unlisted); owner = oldest connected phone, only it may `/invite` or remove phones; paste-a-code onboarding for unbound chats (rate limited, generic failure); `/leads` = newest 8 with Open buttons + Older; `o:` sends a fresh card; stale taps answer "Already updated." and refresh the card; blocked-bot (403 / `my_chat_member`) notice to operator. Tests OP1-OP13.
- **Tools (`963e340`, `2d21cd5`, `e56caee`):** `scripts/send-test-lead.mjs`, `scripts/preview-send.mjs`, sweep recognises `manual-test-`, `docs/MANUAL_TESTING.md` (20 steps).

---

## 7. Issues and state RIGHT NOW

### Open problems from the latest report (must be resolved before merging `ops-audience`)
| Severity | Issue |
|---|---|
| **HIGH** | `review` suite **red: 8 failures** (`D2, D3, D5, D8, I4, I5, I6, I9`), page-render assertions (`widget=false`, `svg=false`, `badAllowed=` empty). Reverting the agent's test edit did not fix it, so the cause is in the page path. **Do not merge.** The agent ran out of budget. |
| Medium | `notify` B1/B2b fail in a full run but pass standalone (45/45 twice): order dependence (fixture chat vs earlier suite). |
| Medium | A stray `business_chats` row (chat tail `6852`, 12:58Z) appeared during a run. Restored from timestamped backup: 1 chat, 6 columns, 0 mismatched. Needs root cause (a suite writing to prod `business_chats`). |
| Low | `ops-audience.patch` fails `git am` because of a merge commit; use the `.diff`. |
| Live bug | `/invite` message broken on production `main` until PR #7 merges. |

### Unconfirmed items from earlier prompts (the reports did not mention them; ask the agent)
- Decision: split the digest failure count by kind in plain words (alert / owner email / customer confirmation email / review request).
- Decision: run the debris sweep for the five test leads (`sweep-demo-leads alder-demo`: dry run, backup JSON, then `--yes --confirm`; expect leads 5 / events 20 / feedback 0; keep the three done leads).
- Decision: delete `assets/css/style.css` and `assets/js/main.js` and the README lines (owner approved; not reported done).
- `ol.steps` a11y fix: owner has **not** answered; ask again or drop.

### Production data
`alder-demo` (demo) has 8 leads (3 real manual tests `done`, 5 debris `open`), 1 bound chat (account A). `second-demo` (demo): 0 chats, 0 leads. Both `owner_email` domains are `example.com` (reserved, not ours): **with `MAIL_REDIRECT_TO` removed they would email nobody real; fix before launch.** `MAIL_REDIRECT_TO` is active in production (intentional, demo).

### Test counts
Last clean full run (before ops-audience): 14 suites, ~329 s, against **production** (no test project yet). Latest run: everything green except `review` (8 failures) and order-dependent `notify` B1/B2b.

---

## 8. Still missing / not done

1. **Separate test Supabase project (Phase C), BLOCKED on the owner.** `.env.test` does not exist, so all suites still run against **production** with the backup/reset/restore ritual. Docs exist: `docs/TEST_PROJECT.md`, `.env.test.example`, `npm run test:env-check`. Plan: create the project in **eu-west-3 (Paris)** (measured ~63 ms connect vs 145 ms to us-east-1), apply migrations `0001, seed, 0002, 0003, 0004` with `TEST_ENV=1 npm run db:apply`, then Phase C: fixtures replace hardcoded `alder-demo` literals in 7 suites, make the prod guard absolute, remove `ALLOW_PROD_TESTS` and the backup ritual, per-run rate-limit key prefix/port probe/per-run `.test-mode` for concurrency. Expected ~225-235 s; reaching 180 s also needs fewer round trips.
2. **Summary schedule (proposal only, `docs/PROPOSALS.md` §5d):** `/summary` with four presets (every morning 8:00, every evening 18:00, morning and evening, off), per business timezone, one column on `businesses`, hourly cron on **Pro only**. Backfill decision: existing businesses `'off'`, new `'morning'`. Not built. On Hobby the digest stays at one fixed daily time. Free-form intervals and "every few hours" are deliberately **not** offered.
3. **Self-check is operator-only and not owner-configurable** (decision). Owners get "Your lead summary" (digest) instead.
4. Quiet hours with queued alerts: parked until a client asks. 15-minute lead reminders: impossible on Hobby crons (daily summary of untouched leads instead, or external scheduler on Pro).
5. Pre-launch checklist (also in the repo handoff): remove `MAIL_REDIRECT_TO` (confirm `/api/health` shows `mail_redirect_active:false`), verify Resend domain, owner_email of every business must be an address we control, `OPERATOR_CHAT_ID` set, Vercel Pro, Resend plan sized to `AUTOREPLY_DAILY_CAP`, flip the redirect check to a hard failure, choose retention window (24 months is only a placeholder; build explicit deletion scripts only, no `on delete cascade`), check logo in real Gmail/Outlook, review-page Google handoff on a phone.
6. **Prompt queue, unsent:** the README rewrite + CI-without-secrets + preview-deployment check (GET only against `https://alder-roofing.vercel.app`) + fresh-eyes review of the code **now on main** + test-quality audit prompt (branch, draft PR; do **not** reference PR #5).
7. Telegram command menus: after the operator work merges, owner runs `npm run tg:commands` (scoped operator menu) and `/id` to confirm the operator chat.
8. Known minor: stale-handoff lines, `sharp` bump deferred (dev-only), 13 images without width/height (CLS already 0, leave), `--timing` flag, `OUTBOUND` guard notes. See the repo `HANDOFF_alder_session.md`.

---

## 9. Testing and verification status

### Verified (by automated tests with mutation checks, against a mix of fakes and production DB)
Lead intake validation, rate limits, idempotency, honeypot; Telegram callbacks authorization (C1-C36); fallbacks (B9-B14); health/selfcheck/digest auth and logic (H, S, D series); recipients (R1-R13, partly changed since); operator commands (OP1-OP13); bot text artifact guard; network guard; email layout guard; modal a11y (P23, F7); brand tests.

### Verified live in production by the owner
`/api/health` 200; selfcheck via cron secret works (Telegram + email arrived 4:20 AM manual test; real cron at ~11:26 Cairo Telegram only); digest bearer 200 (no-op); `/invite` + `/start <CODE>` on a second account **works** (B said connected). An invite code was exposed in a screenshot (a live code; it was consumed by B or expires in 24 h). Never screenshot codes.

### NOT verified / not yet tested
- Real Gmail/Outlook/Apple Mail rendering of the new branded ops emails; real Telegram rendering of new messages (use `scripts/preview-send.mjs` or the preview gallery).
- Operator commands in real Telegram (`/code`, `/phones`, `/businesses`, `/operator`, `/id`): not deployed (branch only).
- Whether Vercel actually fires both crons (first selfcheck cron fired; digest cron untested while `DIGEST_ENABLED` is unset).
- Real-device LCP; retry mutex across two function instances; `authenticated` role with a real JWT; the migration post-checks on a fresh DB; delete-script tests (skipped without a test project); the digest query plan on a large table.
- Owner's manual checklist (not yet reported back): `/recipients` on A and B; a real lead reaches both phones; stale card on phone B (expect old "Not found." until fix merges, then "Already updated."); remove B then re-invite; later account C as owner of `second-demo`.
- Delete-chat behaviour in real Telegram (expected: binding is keyed by chat id, so Start says "connected"); block/unblock behaviour.

### How to see changes visually
```powershell
git fetch origin
git checkout ops-audience
node scripts/preview.mjs
start _debug\previews\index.html
git checkout main
```
(Check `package.json` if the script name differs.) For the real look in Telegram/Gmail: `scripts/preview-send.mjs --to <chat id> --yes [--email <addr>]` (refuses chats bound to a business unless `--allow-bound`).

---

## 10. Decisions already made (do not re-litigate)

- **WhatsApp:** not building. Telegram is the channel (WhatsApp needs a business account, paid per message, 24-hour window, 3-button limit). A client-facing reply was drafted; if a client insists, offer "paid add-on later". Email with signed action links is the universal fallback idea; a channel abstraction (notifyOwner/renderAlert/handleAction) is a sketched future design.
- **Telegram-ID pre-authorization rejected:** needs a third-party bot to find the ID, typos authorize strangers, no proof of ownership. Codes/links are better. A "share my phone number" button is a possible later option.
- **Operator vs owner separation:** the operator is a dedicated chat (`OPERATOR_CHAT_ID`, falls back to `TELEGRAM_CHAT_ID`), **not** "any demo business". Operator text never reaches owner chats. Owner = oldest connected phone; staff phones cannot invite/remove.
- **Owner messages per business, never merged.** Every email uses the shared branded template. Emoji in Telegram always next to words; emails readable without emoji.
- **MAIL_REDIRECT_TO:** loud but not a hard failure until the first real client.
- **Retention:** explicit scripts, no cascade, window is a business/legal decision.
- **BIZ_LIMIT stays 200;** auto-reply cap 40/day; digest cron 13:00 UTC; selfcheck 09:00 UTC; `#9aa0a8` control border accepted; hero video untouched; close button stays 40 px; sharp bump deferred; PR #6 stays draft.

---

## 11. Queue (what to do next)

| # | Item | State |
|---|---|---|
| 1 | Merge **PR #7** (`fix-invite-message`) to fix the live `/invite` bug; review its 2 commits first | Ready for review (send commit URLs / patch) |
| 2 | Prompt: diagnose and fix the **`review` suite failures**, the order-dependent `notify` B1/B2b, and the stray `business_chats` row; make `.patch` replayable or drop it (use `.diff`) | **Next prompt to write** |
| 3 | Owner runs the manual checks in Section 9 and reports | Owner |
| 4 | Review `ops-audience` line by line from the `.diff` | Waiting for the owner to attach `_debug/patches/ops-audience.diff` |
| 5 | Answer the agent's 3 questions: (1) review failures next, yes; (2) set `OPERATOR_CHAT_ID` in Vercel after merge (otherwise fallback applies), recommended; (3) `/code` should print the forwardable message as a **separate copy-paste block**, recommended | Owner to confirm |
| 6 | Owner creates `.env.test` (Paris project) then Phase C prompt | Blocked on owner |
| 7 | Unconfirmed items (digest failure split, debris sweep, delete style.css/main.js, ol.steps) | Fold into a prompt |
| 8 | README + CI + preview check + review of main + test-quality audit prompt | **Unsent** (edit: target main, GET only, new draft PR) |
| 9 | Summary schedule implementation | Proposal only; needs Pro + migration approval |
| 10 | Country of first clients | Ask the owner |

---

## 12. Git state (as of the last report)

- `main` = `0f97cf6` (PR #5 and earlier work merged; deploys to production).
- `ops-audience` (PR #6, **draft**): `5cc59aa`, `81e2132`, `92eefa2`, then `f404b4e`, `58d2707` (merge of fix-invite-message), `0c9c07c`, `963e340`, `2d21cd5`, `e56caee`. **Red `review` suite.**
- `fix-invite-message` (PR #7, **draft**): `b5bb654`, `a2bbd67`.
- Patch files (owner's machine): `C:\Users\11\projects\Roofing-2\_debug\patches\fix-invite-message.{patch,diff}` and `ops-audience.{patch,diff}`.
- Prod backup used: `_debug/prod-backup-20261107T110745Z.json`. Debug files live in gitignored `_debug/`.
- Remote: `origin https://github.com/AbdallahIsDev/alder.git`. Never push to `main`, never force, no tags.

---

## 13. Change log (local agent appends below after every task)

| Date | Branch | Commits | What changed | State changes / new issues / open questions |
|---|---|---|---|---|
| 2026-11-07 | (orchestrator) | n/a | Created this file from all prior reports | Baseline |

## 2026-11-07 — review page, chat guard

- **Review page was broken in production**: `google_review_url` begins `ttps://`
  (missing the `h`). `usableGoogleUrl` and `googleUrlAllowed` both rejected it, so
  customers saw "Review link unavailable" with no stars. Both now repair that one
  typo (host allowlist and https-only still apply) and log
  `review_google_url_repaired`. The stored value should still be corrected.
- **A test deleted a real binding.** The lead-api/review fixtures bound
  `TELEGRAM_CHAT_ID` and deleted it in cleanup. Both now use fixture id 770010.
  The owner's chat row is currently absent and must be re-invited (`/start`).
- **New guard**: the runner snapshots `business_chats` and fails a run that
  changes it.
- Not done in this bundle: notify order-dependence, digest failure split by kind,
  `/code` as two messages, debris sweep.

## 8. Operator / owner / recovery (current state, 2026-11-07)

- **Two roles, never mixed.** Operator chat = `OPERATOR_CHAT_ID` (falls back to
  `TELEGRAM_CHAT_ID`); `OPERATOR_EMAIL` is the alarm fallback. Operator-only
  content — redirect warning, aggregates, slugs, "no phone connected" — goes only
  there. `status=demo` is a lifecycle state, not an audience.
- **Owner phone = the oldest connected phone**, ordered by `created_at` then `id`
  (deterministic). Only it may `/invite` or remove a phone; every phone keeps
  alerts, buttons and `/leads`.
- **Recovery**: an unbound chat can paste a code (case/spaces/hyphens ignored,
  one generic failure answer, 10 tries/hour per chat). `/leads` is newest 8 with
  Open buttons and Older paging. A stale tap answers "Already updated." and
  refreshes the card to its current state.
- **Blocked bot**: 403 on the only phone, or `my_chat_member` kicked, sends the
  operator one notice per business per day.
- **Commands**: `/code`, `/phones`, `/businesses`, `/operator` (operator chat
  only); `/id` everywhere and unlisted. Menus via `npm run tg:commands`.
- **Ops messages**: owner digest "Your lead summary" and owner alert check per
  business, own counts only; one aggregated operator alarm that stays quiet when
  nothing is wrong.

## 9. Change log — 2026-11-07 (review fix, data hygiene, run trust)

- Review page was broken in production: `google_review_url` began `ttps://`.
  Repaired in code (both gates) and in the data; `/api/health` now reports
  `review_links_invalid`.
- 21 leads left by a killed webhook run were deleted after classification
  (`_debug/sweep-yw55whku-20261107T163054Z.json`). alder-demo is back to 3 leads /
  2 review_feedback, all three with tokens. second-demo has 0.
- Suites now sweep their own test-shaped leftovers at start and in `finally`; the
  runner fails a run that leaks one, and fails if it cannot read `business_chats`.
- `notify` is scoped to its fixture chat and the live business name (two real
  phones are bound: tails 6109, 6852).

### Remaining work

1. `notify` B14/B15 are red: `duplicate_of` is missing from the `created` event.
   `findRecentDuplicate` works when called directly, so the defect is in the
   endpoint path (`api/lead.js` around the dupPromise/leadId discard).
2. Three full runs (twice, plus reversed order) not done.
3. `/code` as two messages (operator line + forwardable block) not done.
4. Pasted-code global ceiling 200 -> 600 with `bind_ceiling_hit`, and the
   claim-then-bindChat failure path, not done.
5. `/start@botname` suffix, `/leads` keyset paging, hostile-reviewer pass: not done.
6. `listBusinessChatsDetailed` tiebreak has a source-text test (R14), not a
   two-rows-same-timestamp DB test.

## 10. Change log — 2026-11-07 (evening): B14/B15, sweep safety, three full runs

- **B14/B15 were test bugs, not a duplicate-detection defect.** B14 indexed the
  raw send list (two real phones => two sends per post); B15 could match a lead
  an earlier run left behind. Both fixed without touching product code.
- **Sweeps are narrow:** `isTestKey()` accepts only `<8 alnum>-` and `canary-`,
  and excludes UUIDs (a UUID's first segment is 8 hex chars). `manual-test-`,
  `form-` and `measure-` are never swept or counted.
- **Three full runs green:** 385.2 s, 384.4 s, and 385.6 s with the order
  reversed (outbound kept last by design). `business_chats unchanged
  (2: 6109,6852)`, `test-shaped leads unchanged` after each.
- **Pre-launch:** no suite may run against production once a real client is
  onboarded; `.env.test` is a hard requirement (OPERATIONS §9).

### Remaining work

1. `/code` as two messages (operator line + forwardable block) — not done.
2. Pasted-code ceiling 200 -> 600 with `bind_ceiling_hit`; claim-then-`bindChat`
   failure path — not done.
3. `/start@botname` suffix; `/leads` keyset paging; hostile-reviewer pass — not done.
