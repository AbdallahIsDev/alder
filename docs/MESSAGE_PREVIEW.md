# Every message, as it is sent

**Generated file.** `npm run messages:preview` writes it from the same
builders the bot and the mailer call. Do not edit it by hand: change the
builder in `lib/lifecycle-text.js`, `lib/content.js` or `api/lead.js`, then
run the command and read the diff.

How to read it:

- `[[link:URL]]Renew now[[/link]]` is one blue link that Telegram underlines
  on those words. There is no `parse_mode`: the link is an entity with an
  explicit offset and length.
- A fenced `text` block keeps every line break exactly as it is sent. No
  line of a Telegram message is longer than 34 characters, so nothing wraps
  in the middle of a phrase on a phone.
- The sample period is **paid until 14 December 2026**, so every date and
  countdown is the one in `docs/LIFECYCLE_EXPLAINED.md`.

## Numbers this file is built from

| Constant | Value |
|---|---|
| `RENEWAL_REMINDER_DAYS` | 3 days before the paid date |
| `GRACE_DAYS` | 5 days of full service after it |
| `SUSPENDED_DAYS` | 10 days suspended |
| `TERMINATE_AFTER_DAYS` | termination at D + 15 days |
| `EXTEND_DAYS` | one payment = 30 days |
| `RETENTION_DAYS` | data kept 60 days after termination (by hand) |
| `HELD_GROUP_DAYS` | the held group shows for 7 days after reactivation |
| `HELD_NOTICES_PER_HOUR` | at most 20 held-lead notices an hour |

## 1. The billing notices

Each is sent once per paid period, to every connected phone and to the
owner email. The Telegram text and the email say the same thing; the email
has no buttons and its Reply-To is the support address.

### `renewal_reminder` — due soon: 3 days before the paid date

The paid date is 3 days away. Everything still works.

**Telegram** (every phone):

```text
Your payment is due on Dec 14
(4 days left).

Renew before that date to keep
your service running.

Send /status to see your dates.

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]]
```

**Email** — subject: **Your payment is due soon** · heading: **Your payment is due soon**

```text
Your payment is due on Dec 14 (4 days left).

Renew before that date to keep your service running.

Send /status to see your dates.

Reply to this email and we will help.
```

### `overdue` — grace begins: the paid date has passed

Overdue, still fully working. The suspension date is named.

**Telegram** (every phone):

```text
Your payment was due on Dec 14
and has not been received.

Your service keeps working until
Dec 19 (5 days left).
After that it is suspended.

Send /status to see the
countdown.

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]]
```

**Email** — subject: **Payment overdue** · heading: **Payment overdue**

```text
Your payment was due on Dec 14 and has not been received.

Your service keeps working until Dec 19 (5 days left). After that it is suspended.

Send /status to see the countdown.

Reply to this email and we will help.
```

### `final_warning` — grace, last day: one day before suspension

The last warning before the service is switched off.

**Telegram** (every phone):

```text
Final notice: your payment is
overdue.

Your service will be suspended
on Dec 19 (1 day left)
unless payment is received.

Send /status to see the
countdown.

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]]
```

**Email** — subject: **Final notice: payment overdue** · heading: **Final notice: payment overdue**

```text
Final notice: your payment is overdue.

Your service will be suspended on Dec 19 (1 day left) unless payment is received.

Send /status to see the countdown.

Reply to this email and we will help.
```

### `suspension` — suspended for non-payment

Billing reason: the site still saves requests, the termination date is named, the primary action is to renew.

**Telegram** (every phone):

```text
Your service is suspended
because payment was not
received on time.

It will be terminated on
Dec 29 (10 days left)
unless payment is received.

Your website still saves new
requests. You will see them
when the service is active
again.

Send /status to see the
countdown.

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]]
```

**Email** — subject: **Your service has been suspended** · heading: **Your service has been suspended**

```text
Your service is suspended because payment was not received on time.

It will be terminated on Dec 29 (10 days left) unless payment is received.

Your website still saves new requests. You will see them when the service is active again.

Send /status to see the countdown.

Reply to this email and we will help.
```

### `termination_warning` — suspended: 5 days before termination

A reminder that termination is coming.

**Telegram** (every phone):

```text
Your service is still suspended
and payment has not been
received.

It will be terminated on
Dec 29 (5 days left).

Send /status to see the
countdown.

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]]
```

**Email** — subject: **Your service will be terminated** · heading: **Your service will be terminated**

```text
Your service is still suspended and payment has not been received.

It will be terminated on Dec 29 (5 days left).

Send /status to see the countdown.

Reply to this email and we will help.
```

### `termination` — terminated

The service is off. Nothing was deleted.

**Telegram** (every phone):

```text
Your service has been
terminated because payment was
not received.

Your website form no longer
accepts requests. Your data has
not been deleted.

Send /status at any time to see
the current state.

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]]
```

**Email** — subject: **Your service has been terminated** · heading: **Your service has been terminated**

```text
Your service has been terminated because payment was not received.

Your website form no longer accepts requests. Your data has not been deleted.

Send /status at any time to see the current state.

Reply to this email and we will help.
```

## 2. Suspension and termination by hand

A manual suspension says only that the service is suspended: no reason and
no countdown, because nothing was scheduled and nobody was late.

### `suspension` — manual

**Telegram**:

```text
Your service has been suspended
by support.

Your website still saves new
requests. You will see them
when the service is active
again.

Send /status at any time to see
the current state.

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]]
```

**Email** — subject: **Your service has been suspended**

```text
Your service has been suspended by support.

Your website still saves new requests. You will see them when the service is active again.

Send /status at any time to see the current state.

Reply to this email and we will help.
```

### `termination` — manual

**Telegram**:

```text
Your service has been
terminated by support.

Your website form no longer
accepts requests. Your data has
not been deleted.

Send /status at any time to see
the current state.

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]]
```

**Email** — subject: **Your service has been terminated**

```text
Your service has been terminated by support.

Your website form no longer accepts requests. Your data has not been deleted.

Send /status at any time to see the current state.

Reply to this email and we will help.
```

## 3. Back in service

The first message says one thing only: the service is active again. If
there are held leads, a SECOND message follows immediately with those leads,
in the same shape as `/leads`.

### `reactivation` — Extend 30 days, no held leads

**Telegram** (first message):

```text
Your service is active again.
Thank you for your payment.

Paid until: Jan 18.

Send /status at any time to see
the current state.

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]]
```

**Email** — subject: **Your service is active again**

```text
Your service is active again. Thank you for your payment.

Paid until: Jan 18.

Send /status at any time to see the current state.

Reply to this email and we will help.
```

### `reactivation` — Extend 30 days, 3 held leads (then the second message)

**Telegram** (first message):

```text
Your service is active again.
Thank you for your payment.

Paid until: Jan 18.

3 leads came in while your
service was suspended.
Send /leads to see them.

Send /status at any time to see
the current state.

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]]
```

**Email** — subject: **Your service is active again**

```text
Your service is active again. Thank you for your payment.

Paid until: Jan 18.

3 leads came in while your service was suspended. Send /leads to see them.

Send /status at any time to see the current state.

Reply to this email and we will help.
```

### `reactivation` — Reactivate, no held leads

**Telegram** (first message):

```text
Your service is active again.
Support has reactivated it.

Send /status at any time to see
the current state.

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]]
```

**Email** — subject: **Your service is active again**

```text
Your service is active again. Support has reactivated it.

Send /status at any time to see the current state.

Reply to this email and we will help.
```

### `reactivation` — Reactivate, 2 held leads (then the second message)

**Telegram** (first message):

```text
Your service is active again.
Support has reactivated it.

2 leads came in while your
service was suspended.
Send /leads to see them.

Send /status at any time to see
the current state.

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]]
```

**Email** — subject: **Your service is active again**

```text
Your service is active again. Support has reactivated it.

2 leads came in while your service was suspended. Send /leads to see them.

Send /status at any time to see the current state.

Reply to this email and we will help.
```

## 4. A new request while the service is suspended

One Telegram message per held lead to every phone (at most 20
an hour), with no personal data at all. The details stay in the database
and are visible after the service is back.

### `held_lead` — billing suspension

**Telegram**:

```text
A new lead just submitted your
form. Your service is suspended,
so the details are hidden.
Renew to see them.

Send /status to see the
countdown.

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]]
```

### `held_lead` — manual suspension

**Telegram**:

```text
A new lead just submitted your
form. Your service is suspended,
so the details are hidden.
Renew to see them.

Contact support to restore it.

Send /status to see the current
state.

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]]
```

## 5. The daily email about waiting requests

At most one per business per UTC day, and it carries a count, never a
detail and never a name.

### `held_summary` — one request

**Email** — subject: **New requests are waiting**

```text
1 new request has come in through your website form while your service is suspended.

The details are hidden until the service is active again.

Reply to this email and we will help.
```

### `held_summary` — four requests

**Email** — subject: **New requests are waiting**

```text
4 new requests have come in through your website form while your service is suspended.

The details are hidden until the service is active again.

Reply to this email and we will help.
```

## 6. Every other message while the service is off

The owner keeps one button, **Status**. `/status` and `/start` still work.
Anything else gets this short answer with the same button.

### Reply — suspended for non-payment

```text
This service is suspended
because payment was not
received on time.

It will be terminated on
Dec 24 (27 days left).

Send /status to see the
countdown.

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]]
```

### Reply — suspended by hand

```text
This service has been suspended
by support.

No termination date is set.

Send /status at any time to see
the current state.

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]]
```

### Reply — terminated

```text
This service was terminated
because payment was not
received.

Terminated on Dec 14.

Days left: 0. Send /status
to see the current state.

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]]
```

### Button taps while off (a toast, plain text, 200 characters at most)

```text
suspended: This service is suspended. Send /status.
terminated: This service was terminated. Send /status.
```

### A valid invite code used while off

```text
This service is suspended.
A new phone cannot be connected
right now.

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]]
```

### …while terminated

```text
This service was terminated.
A new phone cannot be connected
right now.

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]]
```

## 7. `/status`, in every state

The same facts as the operator's screen, in the owner's words.

### /status — paid

```text
Status: Active, payment overdue

Payment was due on Dec 14.

Your service will be suspended
on Dec 19 (5 days left).

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]]
```

### /status — due soon

```text
Status: Active

Paid until: Dec 14
(3 days left).

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]]
```

### /status — grace (overdue)

```text
Status: Active, payment overdue

Payment was due on Dec 14.

Your service will be suspended
on Dec 19 (1 day left).

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]]
```

### /status — suspended for non-payment

```text
Status: Suspended

Reason: payment was not
received on time.

Terminates on Dec 29
(10 days left).

Leads waiting: 2
Their details are hidden until
the service is active again.

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]]
```

### /status — suspended by hand

```text
Status: Suspended

Reason: suspended by support.

Leads waiting: 1
Their details are hidden until
the service is active again.

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]]
```

### /status — terminated

```text
Status: Terminated

Payment was not received.
Terminated on Dec 29.

Your website form no longer
accepts requests. Your data has
not been deleted.

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]]
```

### /status — not tracked (a demo)

```text
Status: Active

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]]
```

## 8. The operator's screens

The operator sees one business at a time: a status block built by the same
formatter the owner's `/status` uses, then the buttons for that state.

### Business screen — active, a phone connected

```text
Alder Roofing
Active · alder-demo

Telegram: Connected
Phone 1 · main phone

Leads: 7 total
Last 30 days: 7
Last lead: 14d ago
Overdue since Dec 14 · suspends Dec 19
```

### Buttons — active, a phone connected

```text
[Suspend] [Replace phone]
[Extend 30 days] [Leads]
[Terminate]
[Back]
```

### Business screen — active, no phone connected

```text
Alder Roofing
Active · alder-demo

Telegram: Not connected

Leads: 7 total
Last 30 days: 7
Last lead: 14d ago
Overdue since Dec 14 · suspends Dec 19
```

### Buttons — active, no phone connected

```text
[Suspend] [Invite]
[Extend 30 days] [Leads]
[Terminate]
[Back]
```

### Business screen — due soon

```text
Alder Roofing
Active · alder-demo

Telegram: Connected
Phone 1 · main phone

Leads: 7 total
Last 30 days: 7
Last lead: 11d ago
Paid until: Dec 14 · due in 3 days
```

### Buttons — due soon

```text
[Suspend] [Replace phone]
[Extend 30 days] [Leads]
[Terminate]
[Back]
```

### Business screen — grace

```text
Alder Roofing
Active · alder-demo

Telegram: Connected
Phone 1 · main phone

Leads: 7 total
Last 30 days: 7
Last lead: 18d ago
Overdue since Dec 14 · suspends Dec 19
```

### Buttons — grace

```text
[Suspend] [Replace phone]
[Extend 30 days] [Leads]
[Terminate]
[Back]
```

### Business screen — suspended for non-payment

```text
Alder Roofing
Suspended · alder-demo

Telegram: Connected
Phone 1 · main phone

Leads: 7 total
Last 30 days: 7
Last lead: 19d ago
Held leads: 2
Suspended since Dec 19 · terminates Dec 29
```

### Buttons — suspended for non-payment

```text
[Extend 30 days] [Leads]
[Terminate]
[Back]
```

### Business screen — suspended by hand

```text
Alder Roofing
Suspended · alder-demo

Telegram: Connected
Phone 1 · main phone

Leads: 7 total
Last 30 days: 7
Last lead: 19d ago
Held leads: 2
Overdue since Dec 14
```

### Buttons — suspended by hand

```text
[Reactivate] [Leads]
[Extend 30 days]
[Terminate]
[Back]
```

### Business screen — terminated

```text
Alder Roofing
Terminated · alder-demo

Telegram: Connected
Phone 1 · main phone

Leads: 7 total
Last 30 days: 7
Last lead: 29d ago
Held leads: 2
Terminated Dec 29
```

### Buttons — terminated

```text
[Extend 30 days] [Leads]
[Back]
```

### Business screen — billing not tracked

```text
Alder Roofing
Demo · alder-demo

Telegram: Connected
Phone 1 · main phone

Leads: 7 total
Last 30 days: 7
Last lead: 14d ago
Billing: not tracked
```

### Buttons — billing not tracked

```text
[Suspend] [Replace phone]
[Extend 30 days] [Leads]
[Terminate]
[Back]
```

## 9. The operator's questions and their answers

### Ask: suspend

```text
Suspend Alder Roofing?
Alerts and emails stop.
The site keeps saving
requests and holds them.
Nothing is deleted.
The owner can see the count.
```

### Ask: reactivate

```text
Reactivate Alder Roofing?
Alerts and emails resume.
Requests held while it was
off become visible again.
Nothing is deleted.
```

### Ask: terminate

```text
Terminate Alder Roofing?
Alerts and emails stop.
The website form shows
"not available".
Nothing is deleted: Extend
30 days puts it back.
```

### Ask: extend, an active business

```text
Extend Alder Roofing to Jan 13?
```

### Ask: extend, a suspended business

```text
Extend Alder Roofing to Jan 18?

This business was suspended.
Extending restores the service.
```

### Ask: extend, a terminated business

```text
Extend Alder Roofing to Jan 28?

This business was terminated.
Extending restores the service.
```

### Result: suspended

```text
Suspended: Alder Roofing
Telegram: sent to 1 phone
Email: sent
```

### Result: reactivated

```text
Reactivated: Alder Roofing
Telegram: sent to 1 phone
Email: sent
```

### Result: terminated

```text
Terminated: Alder Roofing
Telegram: sent to 1 phone
Email: sent
```

### Result: extended

```text
Extended: Alder Roofing
Paid until: Jan 13
Telegram: sent to 1 phone
Email: sent
```

### Result: extended and restored

```text
Extended: Alder Roofing
Paid until: Jan 18
Service: reactivated
Telegram: sent to 1 phone
Email: sent
```

### Already extended

```text
Alder Roofing is already paid until Dec 14. Nothing changed.
```

### Already suspended

```text
Alder Roofing is already suspended.
```

### Already active

```text
Alder Roofing is already active.
```

### Already terminated

```text
Alder Roofing is already terminated.
```

### Refusal: Reactivate on a terminated business

```text
Alder Roofing is terminated.
Extend 30 days restores it.
```

### Refusal: Reactivate on a billing suspension

```text
Alder Roofing is suspended because
payment was not received.
Extend 30 days restores it.
```

### Refusal: an invite for a suspended business

```text
Alder Roofing is suspended. Reactivate it first.
```

### Refusal: an invite for a terminated business

```text
Alder Roofing is terminated.
Extend 30 days restores it.
```

## 10. What the visitor reads

Two answers are not "sent" and are not a failure: a suspended business saves
the request and shows **Request saved** with the Call button; a terminated
business shows a neutral page and accepts nothing. Neither promises a reply.

### Site — suspended business (request saved, then held)

The panel's heading is **Request saved**; the summary of what the visitor typed is shown above these words.

```text
Your request was saved, but this business can’t respond through this form right now. For the fastest help, please call them directly.
```

### Site — terminated business (the form is not available)

```text
This business isn’t accepting requests through this form right now. Please call them directly.
```

### Site — terminated business: the whole page

No form, no business name, no contact details on the page. The form API answers the same refusal.

```text
This website is currently unavailable.
```

### No-JS form — suspended business (stored, held)

The no-JS page is a plain HTML page, one paragraph, no promise of a reply.

```text
Your request was saved. The business will see it when its service is active again.
```

### No-JS form — terminated business (nothing stored)

```text
This business isn't accepting requests through this form right now.
```

## 11. `/leads` after a reactivation

For 7 days after the service comes back, the leads received while it was
suspended are a group of their own at the top. After that they are ordinary
rows in date order. Their number, date and the `held` line never change.

```text
Recent requests

Received while suspended: 2

1. Maria Lopez
Repair · (555) 501-9876
New · 2d ago
held

2. Daniel Whitaker
Replacement · (555) 501-2345
New · 3d ago
held

Other requests

3. Sam Reed
Storm damage · (555) 501-1111
Contacted · 9d ago
```

After 7 days the same page is one list, in date order, with no group
and no `held` line.

---

Generated by `npm run messages:preview` from the code, not typed by hand.
