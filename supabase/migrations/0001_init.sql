-- 0001_init.sql — Alder roofing lead platform, initial schema.
-- Apply with: supabase db push  (or paste into the Supabase SQL editor).
--
-- Two schemas:
--   public  — what the API and the roofer-facing bot may touch.
--   private — owner-only money. The API never exposes it; anon/authenticated are revoked.
--
-- Everything is deny-all by default. Only the server's service_role key bypasses RLS,
-- and that key exists only in Vercel environment variables, never in the browser.

create extension if not exists pgcrypto;
create schema if not exists private;

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{2,60}$'),
  name text not null,
  owner_email text not null,
  google_review_url text,
  timezone text not null default 'America/Chicago',
  status text not null default 'demo' check (status in ('demo','active','paused','churned')),
  created_at timestamptz not null default now()
);

create table public.business_chats (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  tg_chat_id bigint not null unique,
  label text,
  created_at timestamptz not null default now()
);

create table public.bind_codes (
  code text primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  name text not null check (char_length(name) between 2 and 80),
  phone text not null check (char_length(phone) between 7 and 32),
  email text check (email is null or char_length(email) <= 254),
  zip text not null check (zip ~ '^\d{5}$'),
  service text not null check (char_length(service) between 1 and 60),
  home text not null check (char_length(home) between 1 and 60),
  timing text not null check (char_length(timing) between 1 and 60),
  roof_age text not null check (char_length(roof_age) between 1 and 60),
  insurance_claim boolean not null default false,
  notes text check (notes is null or char_length(notes) <= 2000),
  status text not null default 'open' check (status in ('open','contacted','quoted','won','lost','done')),
  source text not null default 'form',
  idempotency_key text,
  review_token text unique,
  created_at timestamptz not null default now(),
  unique (business_id, idempotency_key)
);
create index leads_business_created on public.leads (business_id, created_at desc);
create index leads_business_status on public.leads (business_id, status);

create table public.lead_events (
  id bigint generated always as identity primary key,
  lead_id uuid not null references public.leads(id) on delete cascade,
  kind text not null check (kind in ('created','email_owner_sent','email_owner_failed','tg_sent','tg_failed',
    'autoreply_sent','status_changed','contacted','review_requested','review_clicked','rating','photo_added')),
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index lead_events_lead on public.lead_events (lead_id, created_at);

create table public.review_feedback (
  lead_id uuid primary key references public.leads(id) on delete cascade,
  rating smallint check (rating between 1 and 5),
  comment text check (comment is null or char_length(comment) <= 1000),
  google_clicked boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  count int not null default 1,
  primary key (key, window_start)
);

-- OWNER-ONLY money, in a schema the API does not expose.
create table private.lead_financials (
  lead_id uuid primary key references public.leads(id) on delete cascade,
  quoted_cents bigint check (quoted_cents >= 0),
  won_cents bigint check (won_cents >= 0),
  updated_at timestamptz not null default now()
);

create or replace function public.hit_rate_limit(p_key text, p_window_seconds int, p_max int)
returns boolean language plpgsql security definer set search_path = public as $$
declare w timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
        c int;
begin
  insert into public.rate_limits(key, window_start) values (p_key, w)
  on conflict (key, window_start) do update set count = public.rate_limits.count + 1
  returning count into c;
  delete from public.rate_limits where window_start < now() - interval '2 days';
  return c <= p_max;
end $$;
revoke all on function public.hit_rate_limit(text,int,int) from public, anon, authenticated;

-- The ONLY thing roofer-facing (bot) code may read. No money, no internal fields.
create view public.v_client_leads with (security_invoker = on) as
  select id, business_id, name, phone, email, zip, service, home, timing, roof_age,
         insurance_claim, notes, status, created_at
  from public.leads;

-- Deny-all for the public API. Only the server's service_role bypasses RLS.
alter table public.businesses enable row level security;
alter table public.business_chats enable row level security;
alter table public.bind_codes enable row level security;
alter table public.leads enable row level security;
alter table public.lead_events enable row level security;
alter table public.review_feedback enable row level security;
alter table public.rate_limits enable row level security;
alter table private.lead_financials enable row level security;
revoke all on all tables in schema public from anon, authenticated;
revoke all on all tables in schema private from anon, authenticated;
revoke usage on schema private from anon, authenticated;
