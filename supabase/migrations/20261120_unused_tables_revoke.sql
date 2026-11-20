-- Three tables in the public schema are reachable with the browser's anon key and are used by nothing in
-- this app: public.bookmarks, public.payment_transactions, public.user_quotas. Each carries full table
-- privileges for anon and authenticated (arwdDxtm in the audit) and a policy granted to role PUBLIC.
--
-- Those policies have since been read (pg_policies on the live project) and all three scope rows to their
-- owner with auth.uid() = user_id, so nothing is leaking today: with no signed-in user auth.uid() is null
-- and the comparison never matches. This migration still earns its place, because it removes the exposure
-- rather than depending on every policy staying correct — an unused table should not be reachable with the
-- key that ships in the browser, whatever the policy on it says.
--
-- Privileges are checked BEFORE row level security, so the revoke is what actually closes the table. It
-- revokes from PUBLIC too: the policies on these tables target role PUBLIC, so a privilege could have
-- arrived that way, and revoking from anon and authenticated alone would leave a PUBLIC grant in place.
-- No API route is affected — they connect as the owner or with service_role, neither of which is named
-- here.
--
-- public.bookmarks is not the "bookmarks" the reader uses: that one is an IndexedDB object store on the
-- device (public/app.js creates it with db.createObjectStore). No Supabase table is involved in the
-- reader's bookmarks, and neither public/ nor api/ reads any of these three. payment_transactions and
-- user_quotas appear nowhere in this repo or its history, and the deployed client
-- (marginalia-rme.vercel.app/app.js) mentions none of the three.
--
-- Run this ONCE in the Supabase SQL editor (or via the Supabase CLI). Safe to re-run.
--
-- If a browser feature ever needs one of these tables, do not restore the blanket grant: grant the one
-- verb it needs and add an own-row policy, e.g.
--   grant select, insert on public.bookmarks to authenticated;
--   create policy "bookmarks: read own rows" on public.bookmarks
--     for select to authenticated using (auth.uid() = user_id);
--
-- Written as a loop so it still applies to a project that has only some of the three tables.

do $$
declare
  target text;
begin
  foreach target in array array['bookmarks', 'payment_transactions', 'user_quotas'] loop
    if to_regclass('public.' || target) is not null then
      execute format('revoke all on table public.%I from public, anon, authenticated', target);
      raise notice 'revoked public/anon/authenticated on public.%', target;
    else
      raise notice 'skipped public.% (does not exist)', target;
    end if;
  end loop;
end $$;
