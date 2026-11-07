# SESSION HANDOFF: Alder roofing lead platform (orchestrator continuation)

> **Purpose.** Give this file to any cloud AI assistant so it can continue as the **orchestrator** for this project without the owner re-explaining anything.
> **Last updated:** 2026-11-07 (end of the fixture-safety / `/code` bundle).
> **Rule for the local agent:** after every task, update the change log and any section whose facts changed. Never put secret values in it.

---

## 1. How we work (read first)

### Review artefact rule (set 2026-11-07)

Exactly ONE review file per task: `_debug/patches/ops-audience-review.diff` =
`git diff origin/main...ops-audience` (every commit from main to the branch head,
combined). No `.patch`, no last-N, no per-area splits. Report its size, line count,
`git apply --check` against a fresh `origin/main` worktree, and a secret scan
(counts only). Older `.patch` files may stay on disk; do not add more.

### Backup/restore rule (set 2026-11-07)

The backup, reset and restore touch ONLY the `businesses` columns of `alder-demo`.
`business_chats` is never read for a restore, never deleted, never re-inserted: a
phone can be connected at any moment. `seed-check` reports the chat count and does
not require it to be zero. The runner fails a run that adds or removes a chat,
leaks a test-shaped lead, or grows the live unused bind-code count of a real business.

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
- Standard rules: never print secret values (names/counts/8-char ids/tails only); every behaviour change gets a **test plus a mutation check** (break the code, show the test fails, revert); one commit per logical item with hashes; **schema changes are proposals only** (never apply a migration, never leave an unapplied one in `supabase/migrations/`); never loosen or delete an assertion — if one must change, stop and report before/after.
- Production-DB rule: suites run against production until `.env.test` exists. Take a fresh timestamped backup of the `businesses` columns before any run. The owner's phones (tails `6109`, `6852`) stay connected; `business_chats` and the three `alder-demo` leads / two feedback rows must be unchanged after every run.
- **EDGE-CASE RULE:** list the cases beyond the owner's list and report a table: case / current behaviour / decision (test ID, proposal, n/a).
- **BUDGET RULE:** priority order; after each group, run the touched suites, push dry-run, add a handoff entry. If budget runs low, stop at a clean commit and list what is left.
- **FINAL REPORT:** Critical/High at the top; one section per group with commit hashes, tests, mutation results, changed assertions, what was NOT verified; suites run and which database; per-suite times; chat tails and lead/event/feedback counts before/after; `git status`; `git log --oneline -20`.
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
| Hosting | Vercel **Hobby** (one cron/day; non-commercial; Pro needed before paid clients) |
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
- Latest npm/security audit: no Critical/High.

---

## 5. Environment variables (names only)

Required in Vercel: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `IP_HASH_SALT`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `RESEND_API_KEY`, `MAIL_FROM`, `SITE_URL`, `HEALTH_SECRET`, `CRON_SECRET` (set both; selfcheck/digest return 503 if `HEALTH_SECRET` is unset even when `CRON_SECRET` is set).

Optional: `TELEGRAM_CHAT_ID`, `MAIL_REDIRECT_TO`, `MAIL_REDIRECT_PREFIX` (**remove before first real client**), `AUTOREPLY_DAILY_CAP` (40), `DIGEST_ENABLED` (unset = no-op), `DIGEST_UNTOUCHED_DAYS` (14), `RECIPIENTS_MAX` (5), `INVITES_MAX` (3), `TELEGRAM_BOT_USERNAME`, `DATABASE_URL` (migrations only), `VERCEL_ENV`.

New in `ops-audience` (not deployed): `OPERATOR_CHAT_ID` (falls back to `TELEGRAM_CHAT_ID`), `OPERATOR_EMAIL`.

Test-only: `.env.test` (**does not exist**), `TEST_ENV=1`, `ALLOW_PROD_TESTS`.

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
| Resolved | `/invite` message bug: PR #7 is merged (GitHub state observed 2026-11-07). |

### Production data (verified 2026-11-07)
`alder-demo`: 3 leads (all `done`, review tokens), 2 `review_feedback` (5★), chat tail `6109`. `second-demo`: 0 leads, chat tail `6852`. Both `owner_email` domains are `example.com` placeholders. `MAIL_REDIRECT_TO` is active (intentional, demo).

### Test counts
Last full run before this bundle: 385.2 s / 384.4 s / 385.6 s, all green. This bundle adds `fixture-safety` (7 checks) and four OP tests; targeted runs are green (see Section 9).

---

## 8. Still missing / not done

1. **Separate test Supabase project (Phase C), BLOCKED on the owner.** `.env.test` does not exist. Plan in `docs/TEST_PROJECT.md`: Paris project, migrations with `TEST_ENV=1`, fixtures replace `alder-demo` literals, make the prod guard absolute, remove `ALLOW_PROD_TESTS` and the backup ritual.
2. **Summary schedule** (proposal only, `docs/PROPOSALS.md` §5d): four presets, per-business timezone, one column, hourly cron on Pro.
3. Self-check is operator-only and not owner-configurable (decision).
4. Quiet hours / 15-minute reminders: parked; Hobby crons are daily.
5. Pre-launch checklist: remove `MAIL_REDIRECT_TO`, verify Resend domain, real `owner_email`, `OPERATOR_CHAT_ID`, Vercel Pro, Resend plan, hard-fail redirect check, retention decision, real Gmail/Outlook rendering, review handoff on a phone.
6. Prompt queue, unsent: README rewrite + CI without secrets + preview check + fresh-eyes review of `main` + test-quality audit.
7. Telegram command menus: after merge, `npm run tg:commands`, then `tg-webhook set` and `info` (the `my_chat_member` handler only arrives if `allowed_updates` is re-registered).
8. Known minor: stale handoff lines, `sharp` bump deferred, 13 images without width/height (CLS 0), `--timing` flag.
9. A5 is done (`scripts/purge-expired.mjs`, dry run default). A2 is done: every bind test runs on `zz-test-bind-<run>` and F8 bans a real-business mint. Still open: keyset paging (report only, not small), hostile-reviewer pass.
10. Proposals only, not implemented: `robots.txt` and `sitemap.xml` hard-coded to `alderroof.com` (pre-launch item); one brand per deployment; `/clients` and `/stats <slug>` on `v_client_leads`; retention predicates; `npm run new-client`.

---

## 9. Testing and verification status

### Verified by automated tests (fakes + production DB)
Lead intake validation, rate limits, idempotency, honeypot; Telegram callbacks (C1-C36); fallbacks (B9-B15); health/selfcheck/digest (H, S, D); recipients (R1-R14); operator commands (OP1-OP16); bot text artifact guard (T1-T7); network guard; email layout; modal a11y; brand tests; fixture-safety F1-F7.

### This bundle's runs (production DB, `ALLOW_PROD_TESTS=1`)
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

## 12. Git state (as of this report)

- `main` = `e981e0c` (deploys to production).
- `ops-audience` (PR #6): 36 commits ahead of `main`, head `0b55342`. GitHub reports it **OPEN and not a draft** (observed 2026-11-07), contrary to the standing instruction that it stays draft; it was not marked ready by this work. Latest: fixture safety `82a0abc`, `/code` two messages `6198e67`, throwaway code business `e11877b`, handoff rewrite `fb1eb8e`.
- `fix-invite-message` (PR #7): head `a2bbd67`; GitHub reports **MERGED** (observed 2026-11-07).
- Review artefact: `_debug/patches/ops-audience-review.diff` (gitignored), single file.
- Remote: `origin https://github.com/AbdallahIsDev/alder.git`. Never push to `main`, never force, no tags.

### How PRs work here (PR map)
| Branch | PR | Role |
|---|---|---|
| `main` | — | deploys to production; never pushed by an agent |
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
