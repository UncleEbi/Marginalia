-- public.profiles is read straight from the browser with the public anon key (the Account window, the
-- credit badge, the post-payment poll), so with RLS off that key can read every account's row. Turn
-- RLS on and let a signed-in user read only their own row.
--
-- Run this ONCE in the Supabase SQL editor (or via the Supabase CLI) AFTER 20261113_pro_quota_reset.sql.
-- The API routes keep working unchanged: they connect with SUPABASE_SERVICE_ROLE_KEY, which bypasses
-- RLS by design, and every statement they run is already scoped to a single user id. That variable is
-- now REQUIRED in the deployment: with RLS on, the anon-key fallback in api/_lib/supabase.js could read
-- a profile but its quota/plan writes would affect zero rows — free AI, and plans that never expire.

alter table public.profiles enable row level security;

-- The only thing the browser does with this table is read the signed-in account's own row.
drop policy if exists "profiles: read own row" on public.profiles;
create policy "profiles: read own row"
  on public.profiles
  for select
  to authenticated
  using (auth.uid() = id);

-- Nothing else gets a policy, because nothing else happens from the browser:
--   * no INSERT/DELETE: rows are created and removed by api/*.js with the service role.
--   * no UPDATE: the browser never writes profiles. An update policy would not be enough anyway — it
--     gates rows, not columns, so it would let a signed-in reader PATCH their own
--     summary_credits_remaining, topup_ai_ops or pro_expires_at, which is the paid gate itself.
-- The revoke below is what guarantees that: even if a permissive update policy is added later by
-- mistake, the browser still has no UPDATE privilege to use it.
-- If the Account window ever gains a field a reader may edit, grant just that column, not the table:
--   grant update (display_name) on public.profiles to authenticated;
-- (the policy would still be needed; without one, RLS denies every update — the safe default).
revoke update on public.profiles from anon, authenticated;
