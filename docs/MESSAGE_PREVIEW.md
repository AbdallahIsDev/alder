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
Your payment is due on
Dec 14 (4 days left).

[[link:https://t.me/AbdallahIsDev]]Renew now[[/link]] to keep
your service running.
```

**Email** — subject: **Your payment is due soon** · heading: **Your payment is due soon**

```text
Your payment is due on Dec 14 (4 days left).

Renewing before that date keeps your service running and your website taking requests.

Send /status to the Lead Alerts bot on Telegram at any time to see your dates.

Reply to this email and we will help.
```

### `overdue` — grace begins: the paid date has passed

Overdue, still fully working. The suspension date is named.

**Telegram** (every phone):

```text
Your payment was due on
Dec 14 and has not arrived.

Your service works
until Dec 19, then it is
suspended (5 days left).

[[link:https://t.me/AbdallahIsDev]]Renew now[[/link]] to keep it running.
```

**Email** — subject: **Payment overdue** · heading: **Payment overdue**

```text
Your payment was due on Dec 14 and has not arrived.

Your service keeps working until Dec 19 (5 days left). After that it is suspended and your website pauses new requests.

Renewing now keeps everything running without a break.

Reply to this email and we will help.
```

### `final_warning` — grace, last day: one day before suspension

The last warning before the service is switched off.

**Telegram** (every phone):

```text
Final notice: your
payment is overdue.

Your service will be suspended
on Dec 19 (1 day left)
unless payment arrives.

[[link:https://t.me/AbdallahIsDev]]Renew now[[/link]] to keep it running.
```

**Email** — subject: **Final notice: payment overdue** · heading: **Final notice: payment overdue**

```text
This is the last reminder before your service is suspended.

The payment is still outstanding. The service is suspended on Dec 19 (1 day left) unless payment arrives.

Renewing takes a minute and keeps your website taking requests.

Reply to this email and we will help.
```

### `suspension` — suspended for non-payment

Billing reason: the site still saves requests, the termination date is named, the primary action is to renew.

**Telegram** (every phone):

```text
Your service is suspended
because payment was overdue.

Your website still saves new
requests. They are visible
again after you renew.

The service terminates
on Dec 29 (10 days left).

[[link:https://t.me/AbdallahIsDev]]Renew now[[/link]] to restore the service.

Need help? [[link:https://t.me/AbdallahIsDev]]Contact support[[/link]]
```

**Email** — subject: **Your service has been suspended** · heading: **Your service has been suspended**

```text
Your website still saves every request. Each one is kept safely and will wait for you when service returns.

The service is terminated on Dec 29 (10 days left) unless payment is received.

Renewing restores the service and shows every request that came in.

Reply to this email and we will help.
```

### `termination_warning` — suspended: 5 days before termination

A reminder that termination is coming.

**Telegram** (every phone):

```text
Your service is still suspended
and payment has not arrived.

It will be terminated
on Dec 29 (5 days left).

[[link:https://t.me/AbdallahIsDev]]Renew now[[/link]] to keep it running.
```

**Email** — subject: **Your service will be terminated** · heading: **Your service will be terminated**

```text
Your service is still suspended and the payment has not arrived.

It will be terminated on Dec 29 (5 days left) unless payment arrives.

A terminated service stops accepting requests, and putting it back takes a new payment.

Reply to this email and we will help.
```

### `termination` — terminated

The service is off. Nothing was deleted.

**Telegram** (every phone):

```text
Your service has been terminated
because payment was overdue.

Your website has stopped
accepting requests. Your
data has not been deleted.

[[link:https://t.me/AbdallahIsDev]]Renew now[[/link]] to restore the service.

Need help? [[link:https://t.me/AbdallahIsDev]]Contact support[[/link]]
```

**Email** — subject: **Your service has been terminated** · heading: **Your service has been terminated**

```text
Your website has stopped accepting requests. Everything you had is still stored: no lead, no phone and no setting was deleted.

A new payment restores the service and brings every saved request back.

Reply to this email and we will help.
```

## 2. Suspension and termination by hand

A manual suspension says only that the service is suspended: no reason and
no countdown, because nothing was scheduled and nobody was late.

### `suspension` — manual

**Telegram**:

```text
Your service has been suspended.

Your website still saves new
requests. They are kept safely and
shown once the service is back.

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]] to resolve it.
```

**Email** — subject: **Your service has been suspended**

```text
Your website still saves every request. Each one is kept safely and will wait for you when service returns.

Reply to this email and we will help.
```

### `termination` — manual

**Telegram**:

```text
Your service has been terminated.

Your website has stopped
accepting requests. Your
data has not been deleted.

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]] to
restore the service.
```

**Email** — subject: **Your service has been terminated**

```text
Your website has stopped accepting requests. Everything you had is still stored: no lead, no phone and no setting was deleted.

The service can be restored; contact support to arrange it.

Reply to this email and we will help.
```

## 3. Back in service

The first message says one thing only: the service is active again. If
there are held leads, a SECOND message follows immediately with those leads,
in the same shape as `/leads`.

### `reactivation` — Extend 30 days, no held leads

**Telegram** (first message):

```text
Your service is active again.
```

**Email** — subject: **Your service is active again**

```text
Your service is paid until Jan 18.

Your website is taking requests again.
```

### `reactivation` — Extend 30 days, 3 held leads (then the second message)

**Telegram** (first message):

```text
Your service is active again.
```

**Email** — subject: **Your service is active again**

```text
Your service is paid until Jan 18.

Your website is taking requests again.
```

### `reactivation` — Reactivate, no held leads

**Telegram** (first message):

```text
Your service is active again.
```

**Email** — subject: **Your service is active again**

```text
Your website is taking requests again.
```

### `reactivation` — Reactivate, 2 held leads (then the second message)

**Telegram** (first message):

```text
Your service is active again.
```

**Email** — subject: **Your service is active again**

```text
Your website is taking requests again.
```

## 4. A new request while the service is suspended

One Telegram message per held lead to every phone (at most 20
an hour), with no personal data at all. The details stay in the database
and are visible after the service is back.

### `held_lead` — billing suspension

**Telegram**:

```text
New lead received. Your
lead is saved safely.

[[link:https://t.me/AbdallahIsDev]]Renew now[[/link]] to see the details.

Need help? [[link:https://t.me/AbdallahIsDev]]Contact support[[/link]]
```

### `held_lead` — manual suspension

**Telegram**:

```text
New lead received. Your
lead is saved safely.

The details stay hidden while
the service is suspended.

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]] to resolve it.
```

## 5. The daily email about waiting requests

At most one per business per UTC day, and it carries a count, never a
detail and never a name.

### `held_summary` — one request

**Email** — subject: **New requests are waiting**

```text
1 request came in through your website form while the service was suspended.

The details are hidden until the service is active again, and every one of them is saved in full.

Renewing shows all of them.
```

### `held_summary` — four requests

**Email** — subject: **New requests are waiting**

```text
4 requests came in through your website form while the service was suspended.

The details are hidden until the service is active again, and every one of them is saved in full.

Renewing shows all of them.
```

## 6. Every other message while the service is off

The owner keeps one button, **Status**. `/status` and `/start` still work.
Anything else gets this short answer with the same button.

### Reply — suspended for non-payment

```text
Your service is suspended
because payment was overdue.

It terminates on Dec
24 (26 days left).

New requests are still saved
and shown after you renew.

[[link:https://t.me/AbdallahIsDev]]Renew now[[/link]] to restore the service.
```

### Reply — suspended by hand

```text
Your service has been suspended.

New requests are still
saved and kept safely
until the service is back.

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]] to resolve it.
```

### Reply — terminated

```text
Your service has been terminated
because payment was overdue.

Your website accepts no
new requests. Your data
has not been deleted.

[[link:https://t.me/AbdallahIsDev]]Renew now[[/link]] to restore the service.
```

### Button taps while off (a toast, plain text, 200 characters at most)

```text
suspended: This service is suspended.
terminated: This service was terminated.
```

### A valid invite code used while off

```text
This service is suspended.
A new phone cannot be
connected right now.
```

### …while terminated

```text
This service was terminated.
A new phone cannot be
connected right now.
```

## 7. `/status`, in every state

The same facts as the operator's screen, in the owner's words.

### /status — paid

```text
Status: Paid
Next: Due soon in 3 days
Paid until: Dec 14
```

### /status — due soon

```text
Status: Due soon
Next: Overdue in 3 days
Paid until: Dec 14
```

### /status — grace (overdue)

```text
Status: Overdue (grace)
Next: Suspension tomorrow
Paid until: Dec 14
```

### /status — suspended for non-payment

```text
Status: Suspended (payment)
Next: Termination in 10 days
Terminates: Dec 29

Reason: payment was overdue.

Leads waiting: 2

Their details are hidden
until the service is back.

[[link:https://t.me/AbdallahIsDev]]Renew now[[/link]] to restore the service.
```

### /status — suspended by hand

```text
Status: Suspended (manual)
Next: none (manual hold)

The service was suspended.

Leads waiting: 1

Their details are hidden
until the service is back.

[[link:https://t.me/AbdallahIsDev]]Contact support[[/link]] to
restore the service.
```

### /status — terminated

```text
Status: Terminated
Terminated: Dec 29

Payment was not received.

Your data has not been deleted.

[[link:https://t.me/AbdallahIsDev]]Renew now[[/link]] to restore the service.
```

### /status — not tracked (a demo)

```text
Status: Not tracked
No payment date recorded
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

Status: Overdue (grace)
Next: Suspension in 5 days
Paid until: Dec 14
```

### Buttons — active, a phone connected

```text
[Replace phone] [Extend 30 days]
[Suspend] [Terminate]
[Leads] [Back]
```

### Business screen — active, no phone connected

```text
Alder Roofing
Active · alder-demo

Telegram: Not connected

Leads: 7 total
Last 30 days: 7
Last lead: 14d ago

Status: Overdue (grace)
Next: Suspension in 5 days
Paid until: Dec 14
```

### Buttons — active, no phone connected

```text
[Invite] [Extend 30 days]
[Suspend] [Terminate]
[Leads] [Back]
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

Status: Due soon
Next: Overdue in 3 days
Paid until: Dec 14
```

### Buttons — due soon

```text
[Replace phone] [Extend 30 days]
[Suspend] [Terminate]
[Leads] [Back]
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

Status: Overdue (grace)
Next: Suspension tomorrow
Paid until: Dec 14
```

### Buttons — grace

```text
[Replace phone] [Extend 30 days]
[Suspend] [Terminate]
[Leads] [Back]
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

Status: Suspended (payment)
Next: Termination in 10 days
Terminates: Dec 29
Held leads: 2
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

Status: Suspended (manual)
Next: none (manual hold)
Held leads: 2
```

### Buttons — suspended by hand

```text
[Reactivate] [Extend 30 days]
[Terminate] [Leads]
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

Status: Terminated
Terminated: Dec 29
Held leads: 2
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

Status: Not tracked
No payment date recorded
```

### Buttons — billing not tracked

```text
[Replace phone] [Extend 30 days]
[Suspend] [Terminate]
[Leads] [Back]
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
Lifts the suspension.
Paid date does not change.
Held requests become visible.
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
Adds 30 days from today.
New date: Jan 18.
Restores the service.
```

### Ask: extend, a terminated business

```text
Extend Alder Roofing to Jan 28?

This business was terminated.
Adds 30 days from today.
New date: Jan 28.
Restores the service.
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
the request and thanks the visitor by name; a terminated business shows a
neutral page and accepts nothing. Neither promises a reply.

### Site — suspended business (request saved, then held)

The no-JS page keeps these words. The modal thanks the visitor by name ("Thanks, Sam."), says **Your request is saved.**, then shows a notice box — "This business can't respond through this form right now. Please call them directly for the fastest help." — above their recap and the Call button.

```text
Your request was saved, but this business can’t respond through this form right now. For the fastest help, please call them directly.
```

### Site — terminated business (the form is not available)

```text
This business isn’t accepting requests through this form right now. Please call them directly.
```

### Site — terminated business: the whole page

Only the form is replaced by this sentence; the page keeps its header, its sections and its phone number. The form API answers the same refusal.

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

After 7 days the same page is one list, in date order, with no group;
each held row keeps its `held` line.

---

Generated by `npm run messages:preview` from the code, not typed by hand.
