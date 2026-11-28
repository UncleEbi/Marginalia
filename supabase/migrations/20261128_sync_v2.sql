-- 20261128_sync_v2.sql
--
-- Two-way sync needs a clock and a way to say "deleted". Without them a pull can only add rows, so an
-- edit on the second device was ignored and a note deleted offline came back on the next launch.
--
-- 1. user_annotations gains deleted_at and a server-owned updated_at trigger (the column already
--    existed, but the browser stamped it).
-- 2. user_vocabulary is new: saved words lived only on the device.
--
-- Run this ONCE in the Supabase SQL editor (or via the Supabase CLI) AFTER 20261124_user_bookmarks.sql.

alter table public.user_annotations
  add column if not exists deleted_at timestamptz;

-- Existing rows are already at created_at/updated_at; fill any gap so a delta cursor can trust the
-- column. A BEFORE INSERT OR UPDATE trigger then makes the database the only clock, exactly like
-- user_books: a phone with a fast clock cannot win every conflict by arriving with a later stamp.
update public.user_annotations
  set updated_at = coalesce(updated_at, created_at, now())
  where updated_at is null;

alter table public.user_annotations alter column updated_at set default now();

create index if not exists user_annotations_user_updated_idx
  on public.user_annotations (user_id, updated_at);

create or replace function public.user_annotations_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists user_annotations_touch_updated_at on public.user_annotations;
create trigger user_annotations_touch_updated_at
  before insert or update on public.user_annotations
  for each row execute function public.user_annotations_touch_updated_at();

create table if not exists public.user_vocabulary (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  word text not null check (length(trim(word)) > 0),
  part_of_speech text not null default '',
  definition text not null default '',
  book_title text not null default '',
  context text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_id, word)
);

create index if not exists user_vocabulary_user_updated_idx
  on public.user_vocabulary (user_id, updated_at);

create or replace function public.user_vocabulary_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists user_vocabulary_touch_updated_at on public.user_vocabulary;
create trigger user_vocabulary_touch_updated_at
  before insert or update on public.user_vocabulary
  for each row execute function public.user_vocabulary_touch_updated_at();

alter table public.user_vocabulary enable row level security;

drop policy if exists "user_vocabulary: read own rows" on public.user_vocabulary;
create policy "user_vocabulary: read own rows"
  on public.user_vocabulary
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "user_vocabulary: insert own rows" on public.user_vocabulary;
create policy "user_vocabulary: insert own rows"
  on public.user_vocabulary
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "user_vocabulary: update own rows" on public.user_vocabulary;
create policy "user_vocabulary: update own rows"
  on public.user_vocabulary
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "user_vocabulary: delete own rows" on public.user_vocabulary;
create policy "user_vocabulary: delete own rows"
  on public.user_vocabulary
  for delete
  to authenticated
  using (auth.uid() = user_id);
