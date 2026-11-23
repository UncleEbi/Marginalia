-- 20261123_cloud_sync.sql
--
-- Migration for Bi-directional Supabase cloud sync:
-- 1. Ensures user_books supports full metadata sync
-- 2. Creates user_bookmarks with owner RLS
-- 3. Creates user_annotations (highlights & margin notes) with owner RLS

-- 1. user_books metadata additions
alter table public.user_books
  add column if not exists total_pages integer default 1,
  add column if not exists total_words integer default 0;

-- 2. user_bookmarks
create table if not exists public.user_bookmarks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  book_title text not null,
  page integer not null,
  sentence_idx integer not null,
  snippet text default '',
  created_at timestamptz default now(),
  constraint user_bookmarks_uniq unique (user_id, book_title, page, sentence_idx)
);

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

drop policy if exists "user_bookmarks: update own rows" on public.user_bookmarks;
create policy "user_bookmarks: update own rows"
  on public.user_bookmarks
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "user_bookmarks: delete own rows" on public.user_bookmarks;
create policy "user_bookmarks: delete own rows"
  on public.user_bookmarks
  for delete
  to authenticated
  using (auth.uid() = user_id);

-- 3. user_annotations (highlights and notes)
create table if not exists public.user_annotations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  book_title text not null,
  page integer not null,
  sentence_idx integer not null,
  text text not null,
  type text not null check (type in ('highlight', 'note')),
  color text default 'amber',
  note_text text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint user_annotations_uniq unique (user_id, book_title, page, sentence_idx, type)
);

alter table public.user_annotations enable row level security;

drop policy if exists "user_annotations: read own rows" on public.user_annotations;
create policy "user_annotations: read own rows"
  on public.user_annotations
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "user_annotations: insert own rows" on public.user_annotations;
create policy "user_annotations: insert own rows"
  on public.user_annotations
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "user_annotations: update own rows" on public.user_annotations;
create policy "user_annotations: update own rows"
  on public.user_annotations
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "user_annotations: delete own rows" on public.user_annotations;
create policy "user_annotations: delete own rows"
  on public.user_annotations
  for delete
  to authenticated
  using (auth.uid() = user_id);
