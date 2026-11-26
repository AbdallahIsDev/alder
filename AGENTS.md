# AGENTS.md

Rules for any AI agent working in this repository. They apply to every session,
every task, and every model. Read this file before touching anything.

---

## 1. The handoff is part of the task, not a follow-up

`SESSION_HANDOFF.md` is the single source of truth for the state of this project.
There used to be three handoff files; they were merged into this one on 2026-11-16
and the other two were deleted.

**Whenever the user asks for anything — a change, a decision, a fix, a new
rule — update `SESSION_HANDOFF.md` in the same task, before you report back.**

Not at the end of the week. Not "when there is time". The same task. If the change
alters architecture, a schema, a command, a duration, a limit, a decision, a known
limitation, or the roadmap, the file must say so by the time you reply.

Concretely:

- A new rule from the user → add it to §2 "Decisions already made".
- A schema change → §3 migrations list, §4 if it changes an invariant.
- A new command, endpoint, or button → §5 "What exists today".
- A new limitation discovered → §7.
- Work finished on something in §9 → move it out of the roadmap.
- Anything you could not verify → §11, in plain words.

Write the fact, not the narrative. "Grace is 5 days" is useful; "we discussed the
grace period and decided…" is not. Never write a secret, a chat id, a bind code,
or lead data in this file — names only.

If a fact in the file has become false, **delete or correct it** in the same pass.
A stale handoff is worse than a short one.

---

## 2. Read first

1. `SESSION_HANDOFF.md` — state, decisions, invariants, roadmap.
2. `docs/OPERATIONS.md` — how to run and fix the thing.
3. `docs/WHOP.md` — payments, fees, payouts, the webhook model.

Do not re-litigate a decision recorded in §2 of the handoff. If you believe it is
wrong, say so with evidence and let the owner decide — do not quietly reverse it.

---

## 3. Hard rules

- **Never push to `main`.** Never force-push. No tags. Push a dry-run first.
  The owner merges; an agent never does.
- **Never print or commit a secret**: no env values, no tokens, no chat ids, no
  bind codes, no lead data. `.env*` is gitignored; `.env.example` carries names
  only and must ship.
- **One review artefact per task**: `_debug/patches/<branch>-review.diff`. Report
  its size, line count, an apply-check against a fresh `origin/main`, and a secret
  scan (counts only).
- **Never commit anything under `_debug/`.** It is scratch.
- **Do not delete a user's uncommitted work.** Back it up, say where, then proceed.

## 4. Tests

- Suites run only with `TEST_ENV=1` and `.env.test`. `tests/run.mjs` refuses the
  production URL and checks a canary before starting. Never run the suite against
  production.
- Every behaviour change gets a test **and** a mutation check: break the code,
  show the test fails, revert, show it passes.
- Never weaken an assertion without recording its before/after meaning.
- 43 suites are registered in `tests/run.mjs`; the DB-free ones run without a
  database, the rest need the TEST project.

## 5. Migrations

- Additive, idempotent, numbered: `supabase/migrations/000N_name.sql`, registered
  in `lib/migrations.js` and in the migration tests.
- The agent applies a migration to the **TEST** project only. The **owner** applies
  it to production.
- Never leave an unapplied migration in `supabase/migrations/` without saying so in
  the handoff and in the final report.

## 6. The landing page

- `index.html` is one huge serialized file. **Never rewrite it wholesale.** Patch
  it with a targeted string replacement that asserts the match count, then verify
  the line and byte count. A full rewrite once turned 2,319 lines into 5,003.
- Headings are pre-split `.sw › .w › .wi` with a hidden `.sr`. Never paste plain
  text into a heading.
- Client-specific values come from `clients/<slug>.json` through the `{{token}}`
  system. The build fails on a leftover `{{`.
- Images only through `npm run images`; a changed image needs a new `-v2`
  filename, because crawlers cache by URL.
- Do not touch the hero video, the modal's 32 px close button, or the motion
  system without an explicit instruction.

## 7. Reporting

End every task with: what changed (files), what you verified and how, what you
could **not** verify, and the exact commands you ran. Lead with the outcome. If
something in the request was wrong or over-built, say so plainly.
