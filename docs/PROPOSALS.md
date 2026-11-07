# Proposals — not implemented

Each section says what it touches and whether it needs a schema change. Nothing here
is applied; `supabase/migrations/` is unchanged, so `npm run db:apply` still produces
exactly the schema in production today.

---

## 5a. Reminder for a lead nobody has touched

**The constraint.** Vercel's Hobby plan allows **one cron run per day** (a more
frequent expression fails the deployment — see `docs/TEST_PROJECT.md` and
`HANDOFF_alder_session.md`). Anything faster needs a scheduler outside Vercel.

### Option 1 — daily section in the self-check (no new infrastructure, no schema change)

Add an "untouched" block to `/api/selfcheck`'s message:

```
Untouched for more than 4 hours
  3 open requests, oldest 2 days old
```

Query: `leads where business_id = ? and status = 'open' and created_at < now() - 4h`,
counted per business. No new column, no new event kind, no cron change.

- **Double-reminding:** impossible by construction — it is a count in a daily digest,
  not a per-lead alert. The same lead appears again tomorrow until somebody taps
  Contacted. That is the intended behaviour for a digest, not a bug.
- **Latency:** up to 24 h. For a roofer that is probably enough; the lead is already
  in the Telegram alert the moment it arrives, so this is a nag, not a notification.
- **Cost:** one extra count per business per day. Free.
- **Touches:** `api/selfcheck.js` (one query + one message line), `lib/db.js`
  (`countUntouchedLeads`). Tests: extend `tests/health.test.mjs`.

### Option 2 — near-real-time, external scheduler (needs a schema change)

A GitHub Actions workflow on a `*/15 * * * *` schedule calling
`/api/reminders` with `Authorization: Bearer $REMINDER_SECRET`.

What GitHub documents (docs.github.com → Actions → events that trigger workflows →
`schedule`, read 2026-11-07):

- "The shortest interval you can run scheduled workflows is once every 5 minutes."
- "The `schedule` event can be delayed during periods of high loads of GitHub Actions
  workflow runs. High load times include the start of every hour. If the load is
  sufficiently high enough, some queued jobs may be dropped."
- Scheduled workflows run only on the default branch, and in a **public** repository
  they are disabled after 60 days without activity.

So: 5-minute floor, routinely late at the top of the hour, and **not guaranteed to
run at all**. Acceptable for a nag, not for anything a customer depends on. Pick an
odd minute (e.g. `7,22,37,52`) to stay away from the hour boundary.

Avoiding a second reminder needs a durable marker, which means a new event kind —
the CHECK constraint in `0004` is an allow-list:

```sql
-- 0005_lead_reminders.sql — DRAFT, NOT APPLIED.
-- Adds one event kind so a reminder can be recorded once per lead, and a partial
-- index for the "open and older than N" query.
alter table public.lead_events drop constraint lead_events_kind_check;
alter table public.lead_events add constraint lead_events_kind_check
  check (kind in (
    'created',
    'email_owner_sent', 'email_owner_failed',
    'tg_sent', 'tg_failed',
    'autoreply_sent', 'autoreply_failed',
    'status_changed', 'contacted',
    'review_requested', 'review_request_failed',
    'review_clicked', 'rating', 'photo_added',
    'reminder_sent'
  ));

create index if not exists leads_open_created
  on public.leads (created_at) where status = 'open';

-- Same posture as 0002-0004.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
grant usage on schema public, private to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema private to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on function public.hit_rate_limit(text, int, int) to service_role;
```

Reminder logic: `select` open leads older than N with no `reminder_sent` event; send;
`insert lead_events(kind='reminder_sent')`. The insert is the idempotency marker, and
two concurrent runs cannot both win if the endpoint takes a `hit_rate_limit` claim
keyed `remind:<leadId>` first (the same pattern as the retry mutex).

**Recommendation:** Option 1 now. It needs no scheduler, no schema change and no new
secret, and a roofer who has not touched a lead in four hours will not be helped by
five-minute precision. Revisit Option 2 only if a client asks for it.

---

## 5b. Daily digest to the owner

One message per business per day, at a fixed local hour:

```
Yesterday at a glance

New requests        4
Contacted           3
Completed           1
Possible repeats    1

Still untouched
  2 open requests, oldest 2 days old
```

- **Source:** `lead_events` counts for 24 h (the same `countsSince` the self-check
  uses), plus the untouched count from 5a, plus leads whose `created` event carries
  `duplicate_of`.
- **Relationship to the self-check:** opposite triggers. The self-check is silent
  unless something is **wrong**; the digest speaks **every day** whether or not it is.
  Keeping them as two endpoints (or one endpoint with `?mode=digest`) avoids the case
  where a quiet day looks like a broken check.
- **Delivery:** the same Telegram-then-email fallback as `/api/selfcheck`
  (`deliverSelfCheck` already does exactly this and can be reused).
- **Timing:** the daily cron fires at 09:00 UTC. A per-business local hour would need
  the cron to run hourly (Pro) or a stored preference read by a single daily run —
  i.e. send at 09:00 UTC for everyone, or accept up to 24 h of skew.
- **Touches:** a new `api/digest.js` (or a mode on selfcheck), `lib/db.js` counts,
  `businesses.digest_enabled` if owners can turn it off. **Schema change only for the
  opt-out column** — the digest itself needs none.

---

## 5c. Quiet hours with queued alerts

The roofer does not want a 02:40 Telegram buzz. Two designs:

### Without a new table (recommended first)

Store the window on the business (`quiet_from`, `quiet_to`, `quiet_tz`) — **that is a
schema change** (three columns on `businesses`). When an alert falls inside the window:

- still save the lead (unchanged),
- still write `tg_failed` with `meta.status = 'quiet_hours'` so the event log says why,
- send nothing,
- the next day's digest lists everything that arrived overnight.

Cost: the roofer learns about an overnight lead at breakfast. No queue, no replay, no
second delivery path. If the business has no window set, nothing changes.

### With a queue table (full fidelity)

```sql
-- DRAFT, NOT APPLIED
create table public.alert_queue (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  channel text not null check (channel in ('telegram','email')),
  due_at timestamptz not null,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index alert_queue_due on public.alert_queue (due_at) where sent_at is null;
alter table public.alert_queue enable row level security;
revoke all on public.alert_queue from anon, authenticated;
```

A cron drains due rows. Problems this introduces: the drain needs to run more often
than daily to be useful (Pro, or an external scheduler), and the message has to be
rebuilt at send time (the lead may have been contacted in the meantime) or stored as a
snapshot (which freezes stale content). Both are real costs for a feature whose only
benefit is "not at 2 a.m.".

**Recommendation:** the no-table design, and only after a client asks. It is three
columns and a branch in `sendTelegramAlert`.
