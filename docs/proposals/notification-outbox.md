# Proposal — durable notification outbox (AUDIT B2/B3)

**Status: NOT IMPLEMENTED.** Nothing here is applied. `supabase/migrations/` is
unchanged, so `npm run db:apply` still produces exactly the schema in production
today. The SQL below is written to be copied into `supabase/migrations/` only
after this document is accepted.

**Touches:** one new table, one new function, three read/write paths
(`api/lead.js`, the new drain, the purge script). No change to `leads`,
`lead_events`, the wall, or the review flow.

**Why.** Today one request is the whole retry story: primary attempt, one
fallback, then silence. A Resend 5xx at 09:00 on a Saturday means that lead's
owner alert is gone forever, and the `lead_events` row is the only trace. The
outbox makes "this lead was never announced" a queryable fact with a retry
schedule, instead of a log line nobody reads.

---

## 1. What "delivered" means

Per lead, per channel:

| State | Meaning |
|---|---|
| `pending` | a row exists, nobody has delivered it, the next attempt is due at `next_attempt_at` |
| `delivered` | at least one bound phone got the Telegram alert, or the owner email was accepted |
| `dead` | `attempts` reached the cap; this is now an operator problem, not a retry problem |

The rule that matters: **the outbox row is written before the first send**, in
the same code path that inserts the lead. A process that dies mid-send leaves a
`pending` row behind, which is exactly the case the current code loses.

## 2. Schema (proposal, not applied)

```sql
-- 0005_notification_outbox.sql — a durable second chance for owner alerts.
-- One row per (lead, channel). Never visible to a client: no grants for anon
-- or authenticated, same posture as rate_limits.

create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  channel text not null check (channel in ('telegram', 'email_owner')),
  -- The exact key every attempt must reuse, so a resend can never become a
  -- second message (see the B6 fix: one key per lead per channel).
  idempotency_key text not null,
  state text not null default 'pending' check (state in ('pending', 'delivered', 'dead')),
  attempts int not null default 0 check (attempts >= 0),
  -- Last definite answer (a status number or a short code). Never a message.
  last_status text,
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  claimed_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lead_id, channel)
);
create index notification_outbox_due on public.notification_outbox (state, next_attempt_at);
create index notification_outbox_claim on public.notification_outbox (id) where state = 'pending';

alter table public.notification_outbox enable row level security;
-- No policies: service_role only, like every other table in this schema.
revoke all on public.notification_outbox from anon, authenticated;

-- Claim one due row and mark it in flight, atomically. SKIP LOCKED is what makes
-- two drains (an overlapping cron and a manual run) take different rows instead
-- of both sending the same lead.
create or replace function public.claim_notification(p_worker text, p_limit int default 5)
returns setof public.notification_outbox
language sql security definer set search_path = public as $$
  update public.notification_outbox o
     set claimed_at = now(), claimed_by = p_worker, updated_at = now()
   where o.id in (
     select c.id from public.notification_outbox c
      where c.state = 'pending'
        and c.next_attempt_at <= now()
        and (c.claimed_at is null or c.claimed_at < now() - interval '10 minutes')
      order by c.next_attempt_at
      limit p_limit
      for update skip locked
   )
  returning o.*;
$$;
revoke all on function public.claim_notification(text,int) from public, anon, authenticated;
grant execute on function public.claim_notification(text,int) to service_role;
```

`0005` must also re-assert the `0002`/`0003` posture (default privileges
revoked from anon/authenticated, service_role grants) exactly as
`0004_lead_event_kinds.sql` does.

## 3. Write path

In `api/lead.js`, after the lead row is known and before `announceLead`:

1. `insert into notification_outbox (lead_id, business_id, channel, idempotency_key)`
   for `telegram` and `email_owner`, `on conflict (lead_id, channel) do nothing`
   (an idempotent replay must not create a second row).
2. Announce as today.
3. On a definite success for a channel, set that row `state = 'delivered'`.
4. On a definite failure, leave it `pending` with `next_attempt_at` set by the
   backoff table and `attempts` incremented. On a timeout, do the same but with
   the **same** idempotency key — a timeout is unknown, not failed (B6), so the
   retry relies on the provider's dedupe rather than on a new key.

If step 1 fails, the lead must still be stored and announced: the outbox is a
safety net, never a gate. That failure writes `lead_outbox_failed` (a code, no
ids) and the request continues.

## 4. Drain

Backoff: `2 min, 5 min, 15 min, 1 h, 4 h`, then `state = 'dead'` after 5
attempts (~6 h of coverage). Rows are drained oldest-due first, at most 5 per
claim, at most 20 per run, so one drain stays inside a 10 s function.

**The scheduling problem, stated plainly.** The project is on a Hobby plan,
which allows **one cron run per day**. A daily drain turns a 6 h retry window
into a 24 h one — better than nothing, still not a queue. There are two honest
options:

- **Option A (no new infrastructure):** drain at the start of the existing daily
  `/api/selfcheck`, before it counts anything, so the day's numbers include what
  the drain just fixed. Coverage: up to 24 h. Cost: zero.
- **Option B (recommended before paying clients):** an external scheduler
  (GitHub Actions on `*/5 * * * *`, or the same host used by the uptime check in
  `uptime-check.md`) calls `GET /api/drain` with `Authorization: Bearer
  $DRAIN_SECRET`. Coverage: ~2 min. This needs no Vercel plan change, which is
  why it is the recommendation while the Hobby constraint stands.

The drain is idempotent and safe to run concurrently with itself (the claim
function above). It answers 200 with counts only: `claimed`, `delivered`,
`failed`, `dead`.

## 5. Alarm when both channels fail (B2)

The alarm must not travel over the two channels that just failed. Today's
operator alarm uses Telegram, then email (Resend) — both are the failing paths.

Design:

- The drain, and `/api/selfcheck`, count leads whose `telegram` **and**
  `email_owner` rows are `dead` in the last 24 h.
- When that count is above zero, one alarm is sent over an **independent
  transport**: an incoming webhook to a different vendor — a Slack or Discord
  webhook (`OPS_WEBHOOK_URL`) — with a fixed sentence and a count. Not
  Telegram, not Resend, not Supabase.
- If `OPS_WEBHOOK_URL` is unset, the alarm falls back to today's operator
  channel and logs `operator_alarm_degraded`, so the gap is visible rather than
  silent.
- The same count is exposed as a **number** on `/api/health`
  (`alerts_dead_24h`), which the external uptime check watches: an alerting
  path that is down is then discovered by something that is not itself an alert.

One message per run, never one per lead: the operator needs "3 alerts are
stuck", not three messages about it.

## 6. Purge and retention

`scripts/purge-expired.mjs` gains one clause: `delivered` rows older than 7 days
are deleted, `dead` rows are kept until an operator clears them (they are a
record of what was lost). No size risk: one row per lead per channel, a few
thousand rows a year at current volume.

## 7. Tests the implementation must ship with

| Test | Asserts |
|---|---|
| outbox row written before the first send | a killed send leaves `pending`, not nothing |
| replays do not duplicate rows | two requests, one key: one row per channel |
| definite failure schedules a retry | `attempts = 1`, `next_attempt_at > now()` |
| timeout keeps the same key | the retried row's key equals the original |
| drain claims a row once | two concurrent drains, one send |
| dead after the cap | 5 failures -> `state = 'dead'`, one operator alarm |
| degraded alarm | no `OPS_WEBHOOK_URL` -> fallback channel + `operator_alarm_degraded` |
| health number | `alerts_dead_24h` is a number and never leaks ids |

Each with the usual mutation check (break the claim, the key reuse, the cap, the
fallback — the matching test must fail).

## 8. Rollout

1. Migration `0005` on the **test project only** first; the suite runs with
   `TEST_ENV=1` against it.
2. Ship the write path with the drain disabled (`DRAIN_ENABLED` unset): rows
   accumulate, nothing retries. A week of rows answers "how often does this
   actually happen" before anything is retried automatically.
3. Enable Option A (daily drain in the self-check), watch `dead` counts.
4. Enable Option B (external 5-minute drain) when the first paying client is
   onboarded — at the same time as the plan question in AUDIT B10.

Rollback: stop the drain, keep the table. Nothing reads it on the request path.