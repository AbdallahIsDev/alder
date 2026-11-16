# Legal drafts

**These are drafts written by a developer. They are not legal advice and no
lawyer has reviewed them. Do not give them to a customer as they are.** Have
a lawyer who knows the law of the place where you and your customers do
business review and adapt them first.

What they are for: they state, in plain words, what the software actually
does, so that the lawyer starts from facts and the final documents do not
promise something the system does not do.

| File | For whom | What it covers |
|---|---|---|
| `terms-of-service.md` | the business that buys the service | payment, the grace period, suspension, termination, data retention |
| `privacy-notice.md` | the people who fill in a customer's website form | what is stored, who sees it, how long it is kept |
| `data-processing-summary.md` | the business, and its lawyer | who decides about the data, who only stores it, where it is stored |

## Keep them equal to the code

Every number in these drafts is a constant in `lib/lifecycle-config.js`:

| In the drafts | Constant | Value today |
|---|---|---|
| reminder before the due date | `RENEWAL_REMINDER_DAYS` | 3 days |
| grace period | `GRACE_DAYS` | 5 days |
| suspended period | `SUSPENDED_DAYS` | 10 days |
| termination after the due date | `TERMINATE_AFTER_DAYS` | 15 days |
| data kept after termination | `RETENTION_DAYS` | 60 days |
| one paid period | `EXTEND_DAYS` | 30 days |

If you change a constant, change the drafts. If the lawyer changes a number,
change the constant. A customer must never read one number and get another.

## What the software does not do (say so, or build it)

- It does not take payments. A payment is recorded by hand.
- It does not delete data on a schedule. Deletion after the retention period
  is done by hand with the offboard script.
- It has no export button. An export is a database query done by hand.
- It does not delete one person's data on request by itself. That is the
  `delete:lead` script, run by hand.

Text in [square brackets] is a blank to fill in.
