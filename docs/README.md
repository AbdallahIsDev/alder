# Docs index

One line per document. The code is the source of truth; these explain how to work with it.

| Document | What it is for |
|---|---|
| [`OPERATIONS.md`](OPERATIONS.md) | Runbook: onboard/offboard a business, add or remove a phone, read the alerts, incident playbooks, secret rotation, post-merge checklist, known limitations. |
| [`PRE_LAUNCH_CHECKLIST.md`](PRE_LAUNCH_CHECKLIST.md) | What must be true before the first paying customer: migrations, configuration, one full rehearsal of the billing lifecycle, the customer's paperwork. |
| [`WHOP.md`](WHOP.md) | The payment provider: fees, payouts from Egypt, reserves, what may be sold, the API/webhook model, and how it feeds `applyPayment()`. |
| [`legal-drafts/`](legal-drafts/README.md) | **Drafts, not legal advice**: terms of service, a privacy notice for form visitors and a data processing summary, stating what the software actually does. For a lawyer to review. |
| [`ONBOARDING.md`](ONBOARDING.md) | The long version of onboarding: the `businesses` row, minting a bind code, the bot menu and buttons, and the first test lead end to end. |
| [`EMAIL_SYSTEM.md`](EMAIL_SYSTEM.md) | How the emails and Telegram alerts are built and sent: brand tokens, templates, the outbound timeout, and the test hooks. |
| [`TEST_PROJECT.md`](TEST_PROJECT.md) | Pointing the suite at a separate Supabase project: create it, fill `.env.test`, run `npm run test:env-check`, apply migrations, run. |
| [`MANUAL_TESTING.md`](MANUAL_TESTING.md) | The three-account script: every tap and the exact text it must produce, including the billing and lifecycle rows, plus the isolation checklist. |
| [`audits/`](audits/telegram-bot-audit.md) | What the Telegram bot does today, the three changes still worth making, and what is closed on purpose. |
| [`MULTI_TENANT_DESIGN.md`](MULTI_TENANT_DESIGN.md) | The target architecture for serving many clients from one deployment, with §9 recording what is built, what is partial and what is missing. |
| [`proposals/`](proposals/multi-client-architecture.md) | Design records that are not code: the multi-client decision (A, with B as an escape hatch), the notification outbox, the uptime check, the sharp upgrade. |
| [`PROPOSALS.md`](PROPOSALS.md) | Designs that are **not** implemented — quiet hours, a per-client summary schedule — each with what it touches and whether it needs a schema change. |
| [`../SESSION_HANDOFF.md`](../SESSION_HANDOFF.md) | **The** state file: decisions, invariants, what exists today, known limits, the roadmap, and the short change log. |
| [`../AGENTS.md`](../AGENTS.md) | Rules for any agent working here — including the rule that the handoff is updated in the same task, not later. |
| [`../README.md`](../README.md) | The site itself: what it is, how to build it, and the image/font pipeline. |
