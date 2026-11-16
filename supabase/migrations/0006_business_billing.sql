-- 0006 — billing: a "paid until" date per business, what the business has
-- already been warned about, and whether its suspension was for non-payment.
--
-- Additive and idempotent: three columns, every one "if not exists", every
-- existing row valid as it is. Nothing is backfilled.
--
--   paid_until             when the paid period ends (UTC). NULL = this
--                          business is not billing-enforced: the daily job
--                          never warns or suspends it. Every existing row
--                          starts as NULL.
--   billing_warning_stage  0 none, 1 overdue warning sent, 2 final warning sent.
--   suspended_for_billing  true only while the business is suspended BY THE
--                          BILLING JOB. A manual Suspend leaves it false.
--
-- The rules that read these columns are in lib/billing.js. To switch billing
-- off for one business: update public.businesses set paid_until = null ...

alter table public.businesses
  add column if not exists paid_until timestamptz,
  add column if not exists billing_warning_stage smallint not null default 0,
  add column if not exists suspended_for_billing boolean not null default false;
