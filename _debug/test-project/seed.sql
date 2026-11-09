-- alder-test seed: the two demo businesses the suites assume. No chats, no leads.
-- Idempotent: safe to run twice.
insert into public.businesses (slug, name, owner_email, google_review_url, timezone, status)
values
  ('alder-demo', 'Alder Roofing', 'owner@alder-demo.example', 'https://g.page/r/alder-demo', 'America/Chicago', 'demo'),
  ('second-demo', 'Second Demo Roofing', 'owner@second-demo.example', 'https://g.page/r/second-demo', 'America/Chicago', 'demo')
on conflict (slug) do nothing;
