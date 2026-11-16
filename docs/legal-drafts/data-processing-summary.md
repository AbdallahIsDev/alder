# Data processing summary (DRAFT, not reviewed by a lawyer)

A plain description of what happens to the data, for the business and its
lawyer. It is the starting point for a data processing agreement, not the
agreement.

## Roles

- **The business** decides what the form asks and what the requests are used
  for (in most laws: the controller).
- **[Your legal name]** stores and delivers the requests for the business (in
  most laws: the processor).

## The data

| Data | About whom | Where it is |
|---|---|---|
| Name, phone, email, ZIP, request details, note | the visitor | database table `leads` |
| What happened to a request (sent, failed, marked) | the visitor's request | table `lead_events` |
| Review feedback, if given | the visitor | table `review_feedback` |
| Telegram chat ids of the connected phones | the business's staff | table `business_chats` |
| Owner email, business name, paid-until date | the business | table `businesses` |
| Which notice was sent, by which channel, with which result | the business | table `business_events` (no text, no address) |

## Where it is stored and who carries it

- Database: [provider, region].
- Hosting: [provider, region].
- Email: [provider].
- Telegram, for the alerts.

## Who can see what

- The business's connected chats and email: the full request.
- The operator's Telegram screens: the service, the status and the age of a
  request only.
- The operator, with database access: everything. Access is by [who, how it
  is protected].

## The life of the data

| Event | What happens to the data |
|---|---|
| The service is active | requests are stored and delivered |
| The service is suspended (payment 5 days late, or by the operator) | new requests are stored and held; nothing is deleted |
| The service is terminated (payment 15 days late, or by the operator) | no new request is stored; nothing is deleted |
| 60 days after termination | the business's data may be deleted, by hand, with the offboard script |
| The business asks for one request to be deleted | done by hand with the `delete:lead` script |
| The business asks for a copy | done by hand with a database export |

## What is not built yet

- Automatic deletion after the retention period.
- An export function.
- A log of who read what.

Say so in the agreement, or build it first.
