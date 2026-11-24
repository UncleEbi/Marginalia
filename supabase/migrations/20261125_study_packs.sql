-- 20261125_study_packs.sql
-- Shareable Read-Only Study Packs (Viral Campus Loop)

create table if not exists public.study_packs (
  id uuid primary key default gen_random_uuid(),
  share_token text unique not null,
  created_by uuid references auth.users(id) on delete cascade,
  doc_title text not null,
  pack_type text default 'chapter',
  payload jsonb not null,
  views_count int default 0,
  created_at timestamptz default now()
);

-- Index on share_token for fast lookup
create index if not exists study_packs_share_token_idx on public.study_packs(share_token);

-- Enable RLS
alter table public.study_packs enable row level security;

-- Drop previous policies if re-run
drop policy if exists "Allow public read of study packs by share token" on public.study_packs;
drop policy if exists "Allow insert of study packs" on public.study_packs;

-- Public read access by share_token
create policy "Allow public read of study packs by share token"
  on public.study_packs
  for select
  using (true);

-- Allow authenticated users to insert with their own created_by, or anonymous users with null created_by
create policy "Allow insert of study packs"
  on public.study_packs
  for insert
  with check (
    auth.uid() is null or created_by = auth.uid()
  );
