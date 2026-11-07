# Docs index

One line per document. The code is the source of truth; these explain how to work with it.

| Document | What it is for |
|---|---|
| [`OPERATIONS.md`](OPERATIONS.md) | Runbook: onboard/offboard a business, add or remove a phone, read the alerts, incident playbooks, secret rotation, post-merge checklist, known limitations. |
| [`ONBOARDING.md`](ONBOARDING.md) | The long version of onboarding: the `businesses` row, minting a bind code, the bot menu and buttons, and the first test lead end to end. |
| [`EMAIL_SYSTEM.md`](EMAIL_SYSTEM.md) | How the emails and Telegram alerts are built and sent: brand tokens, templates, the outbound timeout, and the test hooks. |
| [`TEST_PROJECT.md`](TEST_PROJECT.md) | Pointing the suite at a separate Supabase project: create it, fill `.env.test`, run `npm run test:env-check`, apply migrations, run. |
| [`PROPOSALS.md`](PROPOSALS.md) | Designs that are **not** implemented — reminders, digests, quiet hours — each with what it touches and whether it needs a schema change. |
| [`../HANDOFF_alder_session.md`](../HANDOFF_alder_session.md) | Session handoff: what changed in each bundle, the current known issues, and the env names in use. |
| [`../README.md`](../README.md) | The site itself: what it is, how to build it, and the image/font pipeline. |
