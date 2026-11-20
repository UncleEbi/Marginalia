-- public.user_books is written straight from the browser with the anon key (public/app.js saves the
-- reader's place with an upsert on user_id,title), so with RLS off one account can read and overwrite
-- every other account's library. Turn RLS on and scope every row to its owner.
--
-- Run this ONCE in the Supabase SQL editor (or via the Supabase CLI) AFTER 20261120_profiles_rls.sql.
-- The table is not created here: it already exists, and its unique (user_id, title) index — the one the
-- client's upsert conflicts on — stays exactly as it is.

alter table public.user_books enable row level security;

drop policy if exists "user_books: read own rows" on public.user_books;
create policy "user_books: read own rows"
  on public.user_books
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "user_books: insert own rows" on public.user_books;
create policy "user_books: insert own rows"
  on public.user_books
  for insert
  to authenticated
  with check (auth.uid() = user_id);

-- The client's upsert (onConflict: 'user_id,title') lands here. USING decides which row the update may
-- touch; WITH CHECK stops a row from being re-pointed at another account.
drop policy if exists "user_books: update own rows" on public.user_books;
create policy "user_books: update own rows"
  on public.user_books
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Nothing deletes a server-side row yet (removing a book is local-only today); this keeps the shelf
-- self-service without letting one account clear another's.
drop policy if exists "user_books: delete own rows" on public.user_books;
create policy "user_books: delete own rows"
  on public.user_books
  for delete
  to authenticated
  using (auth.uid() = user_id);
