# Proposals — not implemented

Each section says what it touches and whether it needs a schema change. Nothing here
is applied; `supabase/migrations/` is unchanged, so `npm run db:apply` still produces
exactly the schema in production today.

---

## 5a. Reminder for a lead nobody has touched

**The constraint.** Vercel Hobby allows each cron job to run no more than once
per day; it does not limit a project to one cron job total. A more frequent
schedule needs a plan that supports it or an external scheduler. See Vercel's
current [cron limits](https://vercel.com/docs/schedules/cron-jobs/usage-and-pricing).

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

---

## 5d. Owner-controlled summary schedule

**Status:** proposal only. No code, no migration applied, nothing in `supabase/migrations/`.

Today the summary is one daily cron at a fixed UTC hour for everyone. An owner in
America/Chicago gets it at 07:00 local; an owner in Europe/Paris gets it at 14:00. The
only control is the global `DIGEST_ENABLED` switch, which is the operator's, not theirs.

The smallest useful version is four choices, set from the bot, stored on the business,
and honoured by one hourly cron on a Pro plan.

### UX

`/summary` is authorised the same way every other command is: the business comes from
`getChatBinding(chatId)` through `business_chats`, never from the message text and never
from callback data. An unbound chat gets the existing not-connected copy and nothing is
written.

```
📋 Lead summary

You get your summary every morning at 8:00 (America/Chicago).
Anyone connected to this business can change this.

Choose when it arrives:
```

Buttons, one per row so the labels stay readable on a phone:

| Button | callback_data |
| --- | --- |
| Every morning (8:00) | `s:m` |
| Every evening (18:00) | `s:e` |
| Morning and evening | `s:b` |
| Off | `s:o` |

The callback carries the choice and nothing else. The business is re-derived from the
chat id on every tap, so a forged callback from another chat changes that chat's own
business or nothing at all — it can never address someone else's row.

Confirmation, as an edit of the same message:

```
✅ Done. Your summary will arrive every morning at 8:00 (America/Chicago).
```

```
✅ Done. Your summary will arrive every morning at 8:00 and every evening at 18:00 (America/Chicago).
```

```
✅ Done. Your summary is off. Send /summary any time to turn it back on.
```

A tap that changes nothing (the setting already had that value) still confirms, because
"nothing happened" is indistinguishable from a broken button.

**Every connected phone can change it.** That is deliberate: the alternative is a
"primary phone" concept nobody asked for, and a second phone that cannot silence a
7 a.m. message is worse than one that can. It is stated in the message so it is not a
surprise.

### Schema

One text column with a check constraint. No new table, no per-slot rows.

```sql
-- DRAFT, NOT APPLIED. Do not paste this into supabase/migrations/ until it is approved.
alter table public.businesses add column summary_schedule text;

-- Existing rows get 'off': the feature is opt-in, and a deploy must not start
-- sending a new daily message to clients who never asked for one.
update public.businesses set summary_schedule = 'off' where summary_schedule is null;

alter table public.businesses alter column summary_schedule set default 'morning';
alter table public.businesses alter column summary_schedule set not null;
alter table public.businesses add constraint businesses_summary_schedule_check
  check (summary_schedule in ('off', 'morning', 'evening', 'both'));
```

Order matters: the column is added nullable, backfilled, and only then made `not null`
with the new-business default. A single `add column ... default 'morning' not null`
would give every existing business a morning summary on the next deploy.

`v_client_leads` is untouched: this is business configuration, not lead data.

### Scheduling

Each Vercel Hobby cron job runs **at most once a day**, with up to an hour of imprecision, and
rejects a more frequent schedule at deploy time. So on Hobby "evening" and "twice a day"
cannot work, and `vercel.json` must keep exactly one daily digest entry:

```json
{ "path": "/api/digest", "schedule": "0 13 * * *" }
```

Do **not** put `0 * * * *` in `vercel.json` before the plan is Pro: the deploy fails, and
a failed deploy is a worse outage than a late summary.

On Pro, one hourly cron calls the same endpoint:

```json
{ "path": "/api/digest", "schedule": "0 * * * *" }
```

The endpoint decides per business whether a slot is due, in the business's own timezone:

- local hour from `Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false })`
- local date from the same formatter with `year/month/day` (the claim key's date part)
- `morning` is due at 08:00 or 09:00 local; `evening` at 18:00 or 19:00; `both` at
  either pair; `off` never

The two-hour window is the missed-hour answer. A run skipped by a deploy or a cold start
still fires an hour later, and the claim makes the second hour a no-op.

One claim per business per slot, reusing the existing primitive and no new table:

```
digest:<business_id>:<local-date>:<morning|evening>   window 86400 s, max 1
```

`hit_rate_limit` buckets on `floor(epoch / window)`, so a 24 h window is a UTC day
bucket — the key already contains the local date and the slot, so a retry inside the
same local day finds the claim taken and sends nothing. The claim is released (exact key
delete) only when neither channel reached the business, exactly as today.

DST:

- Spring forward: 08:00 exists, the formatter reports 08, one send.
- Fall back: 08:00 happens twice; both runs compute the same local date and slot, so the
  second finds the claim taken. One send, not two.
- A timezone that `Intl` rejects is skipped and logged as `digest_bad_timezone` (code
  only), never allowed to throw the whole run.

`DIGEST_ENABLED` stays the global kill switch, checked before any query. A deployment
with it unset does no work even if every business has a schedule.

**On Hobby, until the plan is upgraded:** the setting is stored and displayed, and every
non-`off` business is served by the single daily run at 13:00 UTC. The message says the
time in the business's timezone, so before Pro that promise is not kept — which is why
this ships only together with the upgrade, or with the copy saying "once a day" until
then.

### Visible change for existing businesses

With `DIGEST_ENABLED=1` and the `'off'` backfill, every existing business stops
receiving the summary until someone taps a schedule. That is the intended reading of
"nobody is surprised", but it is a real change and it should be announced before the
migration runs.

If the operator prefers to keep today's behaviour for everyone, the backfill becomes
`update public.businesses set summary_schedule = 'morning'` — one word, and every
existing client keeps getting a daily summary. The two options should be chosen
explicitly, not defaulted into.

### Test plan

Every case below gets a mutation check: break the line, the test must fail.

| # | Test | Mutation that must fail it |
| --- | --- | --- |
| T1 | `/summary` shows the current setting for each of the four values | always render "off" |
| T2 | a tap writes only the caller's business | take the business id from callback data |
| T3 | morning is due at 08:00 local, not 08:00 UTC | compare the UTC hour |
| T4 | two calls in one slot produce one message | drop the claim |
| T5 | fall-back day sends once, spring-forward day sends once | use a fixed UTC offset |
| T6 | a 09:00 run after a missed 08:00 sends once; 10:00 sends nothing | widen the window to 3 hours |
| T7 | an invalid timezone is skipped, the run still succeeds | let `Intl` throw |
| T8 | `DIGEST_ENABLED` unset does no queries | move the check after the first read |
| T9 | `/summary` from an unbound chat writes nothing | fall back to "the only business" |
| T10 | a second connected phone changes the same row | restrict to the oldest chat |

### Why not free-form intervals or "every few hours"

- Hobby cannot run them at all; Pro would send a message every N hours about the same
  two open leads, which is noise, not a summary.
- Every extra option multiplies the timezone/DST/claim matrix and the test surface, for
  a choice no owner has asked for.
- Free text ("8:30", "every 90 minutes") needs parsing, validation and a correction UI.
  A bot command is not a form, and a typo that silently means "never" is the worst
  failure mode this feature has.
- Four choices map exactly onto two daily slots. Anything more is a schedule editor, and
  a schedule editor belongs on a settings page, not in a chat.
