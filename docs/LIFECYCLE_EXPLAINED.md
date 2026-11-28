# The lifecycle, in plain English

For the owner of a business using Lead Alerts, and for anyone who has to explain
it to a customer. No code, no jargon. Every number here is one constant in
`lib/lifecycle-config.js`; if that file changes, this one must change with it.

---

## 1. What "paid until" means

Every business has one date on file: the day its paid period **ends**. We call it
`paid_until`, and the letter **D** below always means that date (midnight UTC, so
it is the same date for everybody).

A period is **30 days**. One payment = 30 days.

> **Example used throughout this document.** A business paid on **14 November**.
> Its `paid_until` is **14 December**. So **D = 14 December**.

**"Billing: not tracked"** means the business has no `paid_until` at all. That is
the case for a demo and for a business nobody has billed yet. The daily job
ignores it completely: no reminder, no suspension, no termination, ever. Nothing
in the section below applies to it.

---

## 2. The five states, with dates

| State | When it starts | When it ends | What it means |
|---|---|---|---|
| **Paid** | any time | D − 3 days | Everything works. Nothing to do. |
| **Due soon** | D − 3 days | D | Everything works. It is time to pay. |
| **Grace** | D | D + 5 days | Still fully working, but overdue. |
| **Suspended** | D + 5 days | D + 15 days | Service is off. The site keeps saving new requests. |
| **Terminated** | D + 15 days | — | Service is off. The site accepts nothing. |
| *(data kept)* | D + 15 days | D + 15 days + 60 days | The row still exists, by hand only. |

Worked example, D = **14 December**:

| Date | State | The owner can… |
|---|---|---|
| 1 – 10 Dec | Paid | everything |
| **11 Dec** (D − 3) | Due soon | everything — the reminder goes out |
| **14 Dec** (D) | Grace begins | everything — the overdue notice goes out |
| **18 Dec** (D + 4) | Grace, last day | everything — the final warning goes out |
| **19 Dec** (D + 5) | **Suspended** | `/status` only; the site saves requests |
| **24 Dec** (D + 10) | Suspended | the termination warning goes out |
| **29 Dec** (D + 15) | **Terminated** | `/status` only; the site accepts nothing |
| **27 Feb** (D + 15 + 60) | Terminated, retention over | for a person to decide (see §6) |

The durations, in one place:

- reminder **3 days** before D (`RENEWAL_REMINDER_DAYS`)
- grace **5 days** after D (`GRACE_DAYS`)
- suspended **10 days** (`SUSPENDED_DAYS`), so termination is at **D + 15**
  (`TERMINATE_AFTER_DAYS`)
- one payment = **30 days** (`EXTEND_DAYS`)
- data kept **60 days** after termination (`RETENTION_DAYS`)
- the "received while suspended" group shows for **7 days** after a reactivation
  (`HELD_GROUP_DAYS`)

The six notices, each sent **once** per period:

| # | Notice | When |
|---|---|---|
| 1 | renewal reminder | D − 3 days |
| 2 | overdue | D |
| 3 | final warning | D + 4 days |
| 4 | suspension notice | D + 5 days |
| 5 | termination warning | D + 10 days |
| 6 | termination notice | D + 15 days |

---

## 3. What the owner sees

**The website.** Nothing changes in any state until the business is suspended.
From suspension on, a visitor who sends the form gets "Request saved" with a
**Call** button instead of the usual thank-you, because the business cannot reply
through the form. A terminated business's page keeps its header, sections and
phone number, but the estimate form is replaced by one sentence — "This website
is currently unavailable." — with no form, no step counter and no close button.
The page learns that from `GET /api/site-state`, which answers one word about the
host and nothing about the business; a failed or unknown answer leaves the page
exactly as it was.

**The bot.** In service, every command works. While suspended or terminated the
keyboard shrinks to one button, **Status**, and `/status` answers with the state,
the reason and the dates. Every other message gets a short answer with the
**Contact support** link. No lead data is shown.

**New requests while suspended** are saved in full and marked as held. The owner
gets one short message per lead with no personal data at all — just "a new lead
came in, it is saved safely" and what to do about it — and at most one email a
day carrying a count. Nothing is lost; nothing is shown until the service is
back.

**The held leads.** A reactivation puts them back in `/leads` under a
**"Received while suspended: N"** heading for 7 days; after that they join the
ordinary list in date order. Their number, callback, date and the small `held`
mark are kept throughout.

---

## 4. The three buttons

| Button | Where it appears | What it does |
|---|---|---|
| **Suspend** | an active business | Switches the service off by hand. The owner is told the service is suspended, with no reason and no countdown. The site keeps saving requests. |
| **Terminate** | an active or a suspended business | Switches it off for good. The site shows the neutral page and accepts nothing. **Nothing is deleted.** |
| **Reactivate** | a suspended business only | Switches it back on. **The paid date does not change.** A manual suspension has no payment attached, so this is the only way back. It does not exist on a billing suspension (paying is) or on a terminated business. |
| **Extend 30 days** | any business | Records one payment: **30 days from the payment moment**, and restores the service if it was off. This is the only way back from terminated. |

Two differences the screens state out loud, because they are easy to mix up:

- **Reactivate** — "Lifts the suspension. Paid date does not change."
- **Extend** — "Adds 30 days from today (new date: …) and restores the service."

A business suspended **for non-payment** has no Reactivate button at all.
Paying is the only unlock: the daily job would switch it off again the next
morning otherwise.

---

## 5. Suspended for billing vs suspended by hand

Both states look the same to a visitor. They differ in three ways:

|| **Suspended (billing)** | **Suspended (manual)** |
|---|---|---|
| Why | the paid date passed and the daily job ran | a person pressed Suspend |
| Reason told to the owner | "payment was not received on time" | "Your service has been suspended." — no reason, no blame |
| Countdown | yes: terminates on a date, with the days left | none: it stays until a person reactivates it |
| The way back | **Renew now** | the support link, or **Reactivate** |
| Reactivate button | no | yes |

A business suspended by hand is never touched by the daily job, however old its
paid date is.

---

## 6. What "purge" means

After the 60-day retention window a terminated business *may* be permanently
deleted: its leads, its phone bindings, its invites and the business row itself.

**This is not automated.** Nothing in the code deletes anything, ever. The
documented procedure is a person running `npm run offboard` after checking the
date. Whether to delete at 60 days — or ever — is a legal decision that has not
been made; the drafts are in `docs/legal-drafts/`.

Until that decision is recorded, treat the 60 days as a promise to the customer,
kept by hand, not as a job.

---

## 7. Quick reference for a support call

- "When am I suspended?" — `paid_until` + 5 days.
- "When am I terminated?" — `paid_until` + 15 days.
- "How do I get back?" — pay (**Extend 30 days**), or ask support to
  **Reactivate** a manual suspension.
- "Did I lose my requests?" — No. They were saved, hidden while the service was
  off, and are back in `/leads`.
- "Where are my old dates?" — the bot's **Status** button, or `/status`.
