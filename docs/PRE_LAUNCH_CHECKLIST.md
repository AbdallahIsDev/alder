# Pre-launch checklist

What must be true before the first paying customer is switched on. Each line
is one check you can do in a few minutes. Do them in order: the later ones
assume the earlier ones.

This list is about the billing and lifecycle rules. The general setup
(secrets, mail domain, Telegram commands) is in `docs/OPERATIONS.md`,
sections 1, 6b and 7.

## 1. Database

- [ ] Migration `0006_business_billing.sql` is applied to production. Check:
      a business screen in `/businesses` ends with `Billing: not tracked`,
      not `Billing: unavailable`.
- [ ] Migration `0007_lifecycle.sql` is applied to production. Check in the
      SQL editor: `select count(*) from public.business_events;` answers a
      number, and `select held_at from public.leads limit 1;` does not fail.
- [ ] Applying them changed nothing for the existing businesses: every
      `paid_until` is NULL, so no business is billed yet.

## 2. Configuration

- [ ] `OPERATOR_CHAT_ID` is set. `/id` in the operator chat returns the same
      number.
- [ ] `OPERATOR_EMAIL` is set to an inbox a person reads. It is the Reply-To
      of every billing email and the fallback for operator alerts.
- [ ] `SUPPORT_TELEGRAM_URL` in `lib/lifecycle-config.js` opens the right
      Telegram account. Tap **Contact support** in a notice on the test
      project to check.
- [ ] The durations in `lib/lifecycle-config.js` are the ones in the
      customer's terms: reminder 3 days before, grace 5 days, suspended 10
      days, termination at 15 days, data kept 60 days.
- [ ] `npm run tg:commands` has been run since `/status` was added. The
      command menu of an owner chat lists `/status`.
- [ ] The daily cron runs: the Vercel log of yesterday has a `billing_job`
      line and a `notice_audit` line.

## 3. One full rehearsal on the TEST project

Run steps 27b to 27n of `docs/MANUAL_TESTING.md` with a phone you hold.

- [ ] Each notice arrives in Telegram and by email, with the right date.
- [ ] No line of a Telegram notice wraps in the middle of a sentence on your
      phone.
- [ ] **Contact support** opens the support chat. Replying to the email
      reaches `OPERATOR_EMAIL`.
- [ ] While suspended: `/status` answers, `/leads` shows nothing, a form
      submission is saved and the visitor is told to call.
- [ ] While terminated: the estimate form is replaced by "This website is
      currently unavailable." (no form, no progress, no close button, no
      navigation) and a POST to `/api/lead` for that host answers 410 and stores
      nothing. The rest of the page still loads.
- [ ] `GET /api/site-state` on the real host answers `{"ok":true,"state":"served"}`
      while active and `{"ok":true,"state":"terminated"}` after Terminate;
      an unknown host answers `{"ok":false,"state":"served"}` with HTTP 200.
      Every answer carries `cache-control: no-store`.
- [ ] After **Extend 30 days**: the service is back, the held leads are in
      `/leads`, and no row was deleted at any step.
- [ ] `public.business_events` has an `expected` row and an outcome row for
      every notice of the rehearsal.
- [ ] Replace phone, end to end: steps 6a, 6b and 6c of
      `docs/MANUAL_TESTING.md`. The question appears, **Cancel** leaves the old
      phone connected, and **Confirm replace** ends its access, mints a new
      invite, and answers "Already replaced." on a second tap.
- [ ] Re-run every billing lifecycle stage on the TEST project: reminder,
      overdue, final warning, suspension, termination warning, termination and
      **Extend 30 days** restore (steps 27b to 27n of `docs/MANUAL_TESTING.md`;
      rules in `docs/OPERATIONS.md` section 3b). Step 27g leaves the business
      `active`, so the billing job enforces it.
- [ ] The form itself, on a real phone: every field draws the same 1px border
      at rest; tapping a field changes that border's colour and draws no ring;
      Tab draws the accent ring; no dropdown row shows a bar down its edge; every
      button shows a pointer. The consent line under the form reads
      "We only use your details to contact you about your estimate."
- [ ] The draft: type an answer, close the form, reopen it — the step and the
      answers come back with **Start over**. Clear the tab's storage and reopen
      after a day-old stamp: nothing is restored, and no card looks chosen.
- [ ] The invitation: after the delay the dialog opens by itself and NO field,
      card or radio is focused or ringed; the X closes it and it does not come
      back in that tab.
- [ ] On a business still marked `demo`, expect no billing enforcement at all
      (`docs/OPERATIONS.md` section 3b). Check only the off-state behaviour:
      suspended holds the form and tells the visitor to call; terminated makes
      the form unavailable and stores nothing; `/status` answers with no lead
      detail. No billing notice or state change is due on a demo.

## 4. The customer's paperwork

- [ ] The customer has read and accepted the terms. The drafts are in
      `docs/legal-drafts/`. **They are drafts written by a developer, not
      legal advice. Have a lawyer review them before a customer signs.** The
      review flags and proposed clauses for the gaps are indexed in
      `docs/legal-drafts/LAWYER_REVIEW.md`.
- [ ] The terms the customer accepted state the same durations as
      `lib/lifecycle-config.js`.
- [ ] The customer's website has a privacy notice that names you as the
      service that stores form submissions.
- [ ] You know how the customer pays, and where you will see that a payment
      arrived. The system does not see payments: you press **Extend 30 days**.
- [ ] The payment provider account is live and can pay out: fees, payout method
      and the Egypt-specific options are in `docs/WHOP.md`. Confirm the payout
      route on the dashboard before the first customer pays.

## 4b. Stage-2 gates, before the first live payment

There is no payment-provider integration yet (roadmap). These are gates for
when it is built, not checks of code that exists today.

- [ ] Whop sandbox webhooks: replay the same `webhook-id`, send a duplicate and
      send an older event after a newer one; check the handler answers 2xx
      within five seconds and does not double-apply a payment. Reference
      `docs/WHOP.md` sections 6.4 and 6.7. Sandbox does not cover every live
      payment method.
- [ ] Hosting: Vercel Hobby is non-commercial and allows one cron run per job
      per day. Decide and switch to a commercially permitted plan (Pro or
      another host) before taking payment. `docs/OPERATIONS.md` section 8 and
      `SESSION_HANDOFF.md` section 7, fact 1.

## 5. Switching the customer on

- [ ] The business's status is `active`, not `demo`. A demo business is never
      billed and never suspended.
- [ ] The owner's phone is connected (`Telegram: Connected`).
- [ ] `owner_email` is the customer's real address.
- [ ] Press **Extend 30 days** on the day the first payment arrives. The
      screen says `Paid until: <date>`. Billing for this business starts now.
- [ ] Put the date minus three days in your own calendar for the first cycle,
      and compare with the reminder the system sends.

## 6. Every month, per customer

- [ ] A payment arrived: press **Extend 30 days**, the same day.
- [ ] Read the `Billing today` message when it comes. `Notice not delivered`
      means a customer does not know what is about to happen: contact them
      yourself.
- [ ] A business terminated more than 60 days ago: decide with the customer,
      then delete it with the offboard script (`docs/OPERATIONS.md`, section
      2). Nothing deletes it for you.
