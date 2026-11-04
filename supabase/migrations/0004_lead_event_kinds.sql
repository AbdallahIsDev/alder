-- 0004 — extend the lead_events kind allow-list with the two failure events the
-- notification and review loops need. No new tables, no new columns, no money.
--
-- The old constraint listed twelve kinds and had no autoreply_failed or
-- review_request_failed, so a failed auto-reply or review email could not be recorded.

alter table public.lead_events drop constraint lead_events_kind_check;
alter table public.lead_events add constraint lead_events_kind_check
  check (kind in (
    'created',
    'email_owner_sent', 'email_owner_failed',
    'tg_sent', 'tg_failed',
    'autoreply_sent', 'autoreply_failed',
    'status_changed', 'contacted',
    'review_requested', 'review_request_failed',
    'review_clicked', 'rating', 'photo_added'
  ));

-- Same posture as 0002 and 0003: re-assert that new objects do not widen the wall,
-- and that service_role keeps the access it needs. Safe to re-run.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

grant usage on schema public, private to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema private to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on function public.hit_rate_limit(text, int, int) to service_role;
