# Proposal — external uptime check for `/api/health` (AUDIT B4)

**Status: NOT IMPLEMENTED.** Nothing here is wired up; this is the note the
audit asked for so the decision is on record.

**Why.** Every existing "alerts are broken" warning travels over Telegram and
Resend — the same two channels that fail. If both are down, the owner hears
nothing and nothing else notices: `/api/health` answers 200 to nobody.

## What to monitor

One synthetic check, polled every 5 minutes from at least two regions, against
`GET https://<domain>/api/health`:

| Check | Response | Meaning | Action |
|---|---|---|---|
| endpoint answers | `200` and `ok: true` | the function, the database and the secret all work | — |
| `mail_redirect_active` is `false` | boolean | the redirect left on means no customer receives anything | page the operator |
| `ok: false` with `503` | `HEALTH_SECRET` missing or the query failed | the function is deployed but not configured, or PostgREST is unreachable | page the operator |
| `401` | the checker's secret is wrong | the secret was rotated and the checker was not updated | page the operator |
| `5xx` / timeout | the function is down or slow | deploy failure, Supabase outage | page the operator |
| `alerts_dead_24h > 0` (once the outbox exists) | number | leads whose alerts never landed | page the operator |

Deliberately **not** monitored: `last_hour` and `last_24h` counts. Lead volume
is legitimately zero at night, so a "no leads" alert is noise that trains people
to ignore the checks. Volume belongs on the daily digest.

A synthetic lead (the "canary" the audit suggests) is a second, optional check:
one POST to `/api/lead` per day against the **demo** business, then confirm the
`created` event exists. It proves the whole path, but it puts a fake lead in the
owner's alert stream, so it must stay daily and be labelled. Not part of the
minimum.

## What the endpoint must return, and must never return

It may return numbers and booleans only — that is what it does today
(`api/health.js`, H3/H4 in `tests/health.test.mjs`):

```
{ ok, last_hour{7 counts}, last_24h{7 counts}, review_links_invalid,
  operator_chat_bound, mail_redirect_active, webhook_secret_set, salt_set,
  operator_chat_set, operator_email_set, operator_reachable }
```

It must never return: a chat id, a token, a key, an env value, an email address,
a business name or slug, a lead id, or a count that identifies a single lead.
`MAIL_REDIRECT_TO` appears as `mail_redirect_active` — a boolean, never the
address (tested by B12a).

## Authentication

- The secret travels in the **`x-health-secret` header**, never in the query
  string: query strings end up in proxy logs, CDN logs and error reports.
- A public, unauthenticated `/api/health` is not an option: the counts are
  business volume, and the flags describe the deployment's configuration.
- The checker stores the secret in its own vault, not in this repository.

## Suggested hosts

Any of: healthchecks.io (dead-man's-switch style), Better Stack, UptimeRobot,
or a GitHub Actions workflow with `schedule` + `curl`. Cost: free tier.
The alert channel must be **independent of Telegram and Resend** — Slack or
Discord webhook, or SMS from the checker's vendor.

## Owner questions

1. Which single person receives these pages, and on which channel? (An alarm
   with no named recipient is the failure mode this whole proposal is about.)
2. Is a 5-minute detection window acceptable, or does the escalation path need
   to be faster than that?