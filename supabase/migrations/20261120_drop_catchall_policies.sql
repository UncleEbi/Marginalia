-- Neither public.profiles nor public.user_books should carry a policy that grants access to *any* row
-- instead of the caller's own. Both tables hold policies that no file in this repo creates, and their
-- definitions are not available, so this migration cannot name them: it finds them at run time and drops
-- exactly those, leaving every policy that scopes rows to the caller alone.
--
-- What counts as catch-all, on these two tables only:
--
--   * cmd = 'ALL' — one predicate governing select, insert, update and delete at once. This repo never
--     creates an ALL policy on either table: 20261120_profiles_rls.sql and 20261120_user_books_rls.sql
--     create one policy per verb, so an ALL policy here came from somewhere else.
--
--   * a predicate that never mentions the row's owner column. The owner is id on public.profiles and
--     user_id on public.user_books, so a predicate mentioning neither cannot be comparing anything to the
--     caller. That catches using (true), using ((select true)), with check (true), and the shape a
--     dashboard template produces, using (auth.uid() is not null) — each of which lets any signed-in
--     reader reach every row in the table. The two predicates are inspected separately, so a scoped USING
--     paired with a with check (true) is caught as well; that combination is how a reader could re-point
--     their own row at another account.
--
-- Nothing is matched by name. This repo's own policies survive because they compare to the owner column
-- (auth.uid() = id, auth.uid() = user_id), not because they appear on any list, so a policy that was
-- later renamed still stays and a catch-all that borrowed their name still goes.
--
-- A scoped policy granted to PUBLIC, such as the live "Users can view own profile.", also survives: it is
-- own-row, and this migration is about removing unrestricted access, not about which role may use a
-- policy that is already safe. Narrowing that grant is a separate change.
--
-- Safety: everything is decided before anything is dropped. The block first collects the policies that
-- match, then checks that the ones which would survive still cover what the browser actually does — select
-- on profiles; select, insert, update and delete on user_books, as authenticated, scoped through
-- auth.uid(). If any of those would be left uncovered it raises an exception and drops nothing, so a wrong
-- guess can never take away access the app needs. Run this in the Supabase SQL editor as one batch (or via
-- the Supabase CLI): it applies as a single transaction, so either every catch-all policy goes or none
-- does. Safe to re-run — a second run finds nothing to do.

do $$
declare
  doomed_tables text[] := '{}';
  doomed_names  text[] := '{}';
  missing       text[];
  i             int;
begin
  select coalesce(array_agg(q.tablename order by q.tablename, q.policyname), '{}'),
         coalesce(array_agg(q.policyname order by q.tablename, q.policyname), '{}')
    into doomed_tables, doomed_names
    from (
      select tablename, policyname
        from pg_policies
       where schemaname = 'public'
         and tablename in ('profiles', 'user_books')
         and (cmd = 'ALL'
              or (qual       is not null and qual       !~* '\y(user_id|id)\y')
              or (with_check is not null and with_check !~* '\y(user_id|id)\y'))
    ) q;

  -- What the browser needs after the drop, per table and verb.
  with needed (tablename, verb) as (
    values ('profiles', 'SELECT'),
           ('user_books', 'SELECT'),
           ('user_books', 'INSERT'),
           ('user_books', 'UPDATE'),
           ('user_books', 'DELETE')
  )
  select array_agg(format('%s %s', need.tablename, need.verb))
    into missing
    from needed need
   where not exists (
     select 1
       from pg_policies s
      where s.schemaname = 'public'
        and s.tablename = need.tablename
        and s.cmd = need.verb
        and ('authenticated' = any (s.roles) or 'public' = any (s.roles))
        and (coalesce(s.qual, '') || ' ' || coalesce(s.with_check, '')) ~* 'uid\(\)'
        and not exists (
          select 1
            from unnest(doomed_tables, doomed_names) as d(tbl, pol)
           where d.tbl = s.tablename
             and d.pol = s.policyname
        )
   );

  if missing is not null then
    raise exception 'refusing to drop: % would be left without an own-row policy for the browser; no policy was changed',
      array_to_string(missing, ', ');
  end if;

  if coalesce(array_length(doomed_names, 1), 0) = 0 then
    raise notice 'no catch-all policy on public.profiles or public.user_books; nothing to drop';
    return;
  end if;

  for i in 1 .. array_length(doomed_names, 1) loop
    execute format('drop policy if exists %I on public.%I', doomed_names[i], doomed_tables[i]);
    raise notice 'dropped policy % on public.%', doomed_names[i], doomed_tables[i];
  end loop;
end $$;
