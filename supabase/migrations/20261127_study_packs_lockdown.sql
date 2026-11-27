-- 20261127_study_packs_lockdown.sql
--
-- public.study_packs shipped with two policies that the browser's anon key (which is public, it has
-- to be) can use directly:
--
--   * "Allow public read of study packs by share token" was `for select using (true)`. That policy
--     does not filter by token at all, so `select * from study_packs` with the anon key returned
--     EVERY shared pack ever created — other readers' book text and margin notes included. The
--     "by share token" name described the client's intent, not the policy.
--   * "Allow insert of study packs" let anyone with the anon key insert rows directly, skipping the
--     /api/study-pack route: its 2 MB payload cap, its 15 requests/minute IP limit, its table of
--     allowed shapes and even created_by (an anonymous insert always passed the check).
--
-- Neither policy is needed. Share packs are created and read only by api/study-pack.js, which
-- connects with SUPABASE_SERVICE_ROLE_KEY, and the service role bypasses RLS by design. The browser
-- never touches this table (grep public/ for "study_packs": nothing). Privileges are checked before
-- RLS, so the revoke is what actually closes the table — it removes the exposure instead of relying
-- on a policy continuing to be right.
--
-- Run this ONCE in the Supabase SQL editor (or via the Supabase CLI). Safe to re-run.
--
-- This assumes the deployment sets SUPABASE_SERVICE_ROLE_KEY, which it already must: profiles has
-- RLS on with no anon write path (20261120_profiles_rls.sql), so the API routes need the service
-- role for quota writes regardless. Without it, share links would fail closed instead of leaking.

alter table public.study_packs enable row level security;

drop policy if exists "Allow public read of study packs by share token" on public.study_packs;
drop policy if exists "Allow insert of study packs" on public.study_packs;

revoke all on table public.study_packs from public, anon, authenticated;
