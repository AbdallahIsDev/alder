-- 0007_lifecycle.sql — held leads and the owner-notice log.
--
-- Additive and safe to run twice: every statement is guarded (IF NOT EXISTS,
-- CREATE OR REPLACE) or is a REVOKE / GRANT, which repeats without effect.
-- Nothing is dropped, renamed or rewritten, and no existing row changes.
--
-- The code runs without this migration: a lead that arrives while a business
-- is suspended is then stored without the held mark, and notice attempts are
-- not logged (see lib/db.js: isMissingColumn / isMissingRelation).
--
-- (a) leads.held_at: when a lead was stored while its business was suspended.
--     NULL for every lead that was announced normally.
alter table public.leads
  add column if not exists held_at timestamptz;

create index if not exists leads_business_held
  on public.leads (business_id, held_at)
  where held_at is not null;

-- The roofer-facing read path is this view, never the table. The one new
-- column is appended; the existing columns keep their order, so CREATE OR
-- REPLACE is allowed and the view's grants are kept.
create or replace view public.v_client_leads with (security_invoker = on) as
  select id, business_id, name, phone, email, zip, service, home, timing, roof_age,
         insurance_claim, notes, status, created_at, held_at
  from public.leads;

-- (b) business_events: one row per owner-facing notice attempt (Telegram and
--     email) for billing, suspension, termination, reactivation and held
--     leads. No personal data and no secret: a type, a channel, an outcome, a
--     fixed error class and the mail provider's message id.
--       status 'expected'  a notice round started (written before any send)
--              'sent'      the service accepted the message
--              'failed'    it did not; error_class says how
--              'skipped'   there was nobody to send to
create table if not exists public.business_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  type text not null check (type ~ '^[a-z_]{1,40}$'),
  channel text not null check (channel in ('telegram', 'email', 'none')),
  status text not null check (status in ('expected', 'sent', 'failed', 'skipped')),
  error_class text check (error_class is null or error_class ~ '^[a-z0-9_]{1,40}$'),
  provider_id text check (provider_id is null or char_length(provider_id) <= 80),
  created_at timestamptz not null default now()
);

create index if not exists business_events_business_created
  on public.business_events (business_id, created_at desc);
create index if not exists business_events_created
  on public.business_events (created_at desc);

-- Deny-all for the public API, as on every other table; only the server's
-- service_role reads and writes it.
alter table public.business_events enable row level security;
revoke all on public.business_events from anon, authenticated;
grant select, insert, update, delete on public.business_events to service_role;
