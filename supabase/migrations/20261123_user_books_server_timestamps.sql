-- public.user_books.updated_at is the only clock two devices ever compare: the reader's phone and
-- the account decide "newer position wins" by it. Until now the browser stamped that column itself,
-- so a phone whose clock runs fast won every conflict it entered and could silently roll another
-- device back.
--
-- Make the database the authority instead. A BEFORE INSERT OR UPDATE trigger overwrites whatever
-- the client sent with now(), so every row carries server time no matter which device wrote it.
--
-- The client keeps sending updated_at on purpose: without this migration installed the column falls
-- back to exactly today's behaviour (and an UPDATE would otherwise leave it frozen, because a
-- column default only applies on INSERT). Installing the trigger is therefore safe to do in any
-- order, and rolling it back only restores client-stamped timestamps.
--
-- Run this ONCE in the Supabase SQL editor (or via the Supabase CLI) AFTER 20261120_user_books_rls.sql.
-- The table and its unique (user_id, title) index are not touched.

create or replace function public.user_books_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists user_books_touch_updated_at on public.user_books;
create trigger user_books_touch_updated_at
  before insert or update on public.user_books
  for each row execute function public.user_books_touch_updated_at();

-- New rows get a server timestamp even if a client ever stops sending one.
alter table public.user_books alter column updated_at set default now();
