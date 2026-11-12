-- Two paid tiers (Student Pass / Pro Studio) share tier = 'pro'; pro_tier records which allowance
-- the account bought, so the Account window can label its balance and a downgrade can clear it.
-- Run this ONCE in the Supabase SQL editor (or via the Supabase CLI) BEFORE deploying the code
-- that writes this column.

alter table public.profiles
  add column if not exists pro_tier text;

comment on column public.profiles.pro_tier is
  'Paid tier bought: student | studio. Null for free accounts. Quotas come from lib/pro-plan.js.';
