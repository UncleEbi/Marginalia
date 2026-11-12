-- Paid allowances refill monthly rather than arriving as one lump per term. pro_quota_resets_at is
-- the boundary the quota-checking endpoints compare against: once it has passed (and the
-- subscription is still active) they reset the balances to the tier's monthly allowance and move
-- the boundary on by 30 days.
-- Run this ONCE in the Supabase SQL editor (or via the Supabase CLI) BEFORE deploying the code
-- that reads and writes this column.

alter table public.profiles
  add column if not exists pro_quota_resets_at timestamptz;

comment on column public.profiles.pro_quota_resets_at is
  'Next monthly allowance refill for paid accounts. Null for free accounts and legacy rows.';

-- Any row still paid up gets a boundary no later than its renewal date, so it cannot sit on a null
-- anchor (which the endpoints deliberately treat as "leave alone") for the rest of its term.
update public.profiles
  set pro_quota_resets_at = least(pro_expires_at, now() + interval '30 days')
  where tier = 'pro' and pro_quota_resets_at is null;
