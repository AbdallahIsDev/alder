-- 0005 — nullable canonical public host for Architecture A tenant resolution.
-- One host belongs to at most one business. Existing rows remain valid until
-- onboarding assigns their host; unresolved hosts fail closed.

alter table public.businesses
  add column if not exists site_host text;

create unique index if not exists businesses_site_host_key
  on public.businesses (site_host);
