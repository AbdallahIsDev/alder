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
- [ ] While terminated: the form says it is not available and stores nothing.
- [ ] After **Extend 30 days**: the service is back, the held leads are in
      `/leads`, and no row was deleted at any step.
- [ ] `public.business_events` has an `expected` row and an outcome row for
      every notice of the rehearsal.

## 4. The customer's paperwork

- [ ] The customer has read and accepted the terms. The drafts are in
      `docs/legal-drafts/`. **They are drafts written by a developer, not
      legal advice. Have a lawyer review them before a customer signs.**
- [ ] The terms the customer accepted state the same durations as
      `lib/lifecycle-config.js`.
- [ ] The customer's website has a privacy notice that names you as the
      service that stores form submissions.
- [ ] You know how the customer pays, and where you will see that a payment
      arrived. The system does not see payments: you press **Extend 30 days**.

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
