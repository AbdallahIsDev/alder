-- 0005 — nullable canonical public host for Architecture A tenant resolution.
-- One host belongs to at most one business. Existing rows remain valid until
-- onboarding assigns their host; unresolved hosts fail closed.

alter table public.businesses
  add column site_host text unique;
