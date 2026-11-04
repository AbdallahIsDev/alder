-- Exists because "Automatically expose new tables" was disabled at project creation,
-- so service_role (our server key) gets no automatic privileges.
grant usage on schema public, private to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema private to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on function public.hit_rate_limit(text, int, int) to service_role;
