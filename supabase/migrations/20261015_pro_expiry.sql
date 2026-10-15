-- Pro subscriptions are time-limited as of the billing fix (webhook grants 30 days per charge).
-- Run this ONCE in the Supabase SQL editor (or via the Supabase CLI) BEFORE deploying the code
-- that reads/writes these columns.

alter table public.profiles
  add column if not exists pro_expires_at timestamptz,
  add column if not exists last_payment_reference text;

-- Rows already marked Pro by the old permanent-upgrade webhook get one month from now.
update public.profiles
  set pro_expires_at = now() + interval '30 days'
  where tier = 'pro' and pro_expires_at is null;
