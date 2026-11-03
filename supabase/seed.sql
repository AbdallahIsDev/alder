-- seed.sql — two fake demo businesses. Safe to re-run.
-- No real people, no real addresses. owner_email is a placeholder on example.com.

insert into public.businesses (slug, name, owner_email, google_review_url, timezone, status)
values
  ('alder-demo',  'Alder Roofing (demo)',  'owner@alder-demo.example.com',  'https://g.page/r/alder-demo',  'America/Chicago', 'demo'),
  ('second-demo', 'Second Demo Roofing',   'owner@second-demo.example.com', 'https://g.page/r/second-demo', 'America/Chicago', 'demo')
on conflict (slug) do nothing;
