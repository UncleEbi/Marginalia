-- Bookmarks lived only on the device while reading positions already synced, so signing in on a
-- second phone brought the positions and nothing to jump to. This table carries them, keyed by the
-- coordinates that identify a bookmark rather than by its snippet: re-parsing a book or trimming a
-- quote must not fork a row or collide with the unique index.
--
-- The quoted sentence (snippet) is stored too. That is deliberate and is the first book text the
-- account receives: the bookmarks modal says so in as many words, and the books themselves still
-- never leave the device.
--
-- Run this ONCE in the Supabase SQL editor (or via the Supabase CLI) AFTER 20261120_user_books_rls.sql.

create table if not exists public.user_bookmarks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  book_title text not null,
  page integer not null default 0,
  sentence_idx integer not null default 0,
  snippet text not null default '',
  created_at timestamptz not null default now(),
  unique (user_id, book_title, page, sentence_idx)
);

create index if not exists user_bookmarks_user_id_idx on public.user_bookmarks (user_id);

alter table public.user_bookmarks enable row level security;

drop policy if exists "user_bookmarks: read own rows" on public.user_bookmarks;
create policy "user_bookmarks: read own rows"
  on public.user_bookmarks
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "user_bookmarks: insert own rows" on public.user_bookmarks;
create policy "user_bookmarks: insert own rows"
  on public.user_bookmarks
  for insert
  to authenticated
  with check (auth.uid() = user_id);

-- The client's upsert (onConflict: 'user_id,book_title,page,sentence_idx') lands here. USING decides
-- which row the update may touch; WITH CHECK stops a row from being re-pointed at another account.
drop policy if exists "user_bookmarks: update own rows" on public.user_bookmarks;
create policy "user_bookmarks: update own rows"
  on public.user_bookmarks
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Deleting a bookmark is a local action that propagates: the deleting device removes exactly that
-- account's row.
drop policy if exists "user_bookmarks: delete own rows" on public.user_bookmarks;
create policy "user_bookmarks: delete own rows"
  on public.user_bookmarks
  for delete
  to authenticated
  using (auth.uid() = user_id);
