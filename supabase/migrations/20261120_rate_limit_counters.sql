-- Rate-limit counters, in Postgres instead of a second vendor.
--
-- api/_lib/rate-limit.js used to keep its sliding windows in Upstash Redis. A Vercel function runs as
-- many independent instances, so an in-process Map cannot hold the counters, and the app has no other
-- shared store than the Supabase project it already talks to. These three functions are that store:
-- a single table of counters with an absolute expiry, bumped atomically through a function the browser
-- key can never call.
--
-- The table is not readable by the browser key at all:
--   * row level security is enabled with NO policies, so every row is invisible to any non-owner role;
--   * and, because privileges are checked before RLS, all privileges are revoked from public, anon and
--     authenticated, so PostgREST will not even expose it under /rest/v1. Only postgres and service_role
--     can touch it, and the API routes connect with the service-role key.
--
-- The functions carry the same treatment: EXECUTE arrives granted to PUBLIC on a new function, so it is
-- revoked from public/anon/authenticated and granted back to service_role only. Without that, an anon
-- caller holding the key from public/app.js could read the counters (via rate_limit_ttl) or forge them.
--
-- Window semantics: a window starts at the first hit and expires whole (now() + window_seconds), so a
-- client gets at most `limit` hits per window measured from its first one. Upstash's slidingWindow allowed
-- at most `limit` per rolling window; this flavour can let a client spend one window's allowance at its
-- end and the next one immediately after, so the effective worst case is 2x `limit` across a boundary.
-- Every ceiling here is a flood ceiling, not a billing one, and the per-email auth limit is backed by
-- Supabase Auth's own limits, so the boundary case is acceptable in exchange for one atomic upsert.
--
-- Run this ONCE in the Supabase SQL editor (or via the Supabase CLI). Safe to re-run.

create table if not exists public.rate_limit_counters (
  counter_key text primary key,
  hit_count integer not null default 0,
  expires_at timestamptz not null
);

comment on table public.rate_limit_counters is
  'Rate-limit windows and abuse streaks for api/_lib/rate-limit.js. Written only through the functions below; unreachable with the anon key.';

-- For the expired-row sweep that rate_limit_hit() runs on every call.
create index if not exists rate_limit_counters_expires_at_idx
  on public.rate_limit_counters (expires_at);

alter table public.rate_limit_counters enable row level security;

revoke all on table public.rate_limit_counters from public, anon, authenticated;

-- Bump one or more counters, atomically, and hand back their new state.
--
--   p_bumps      [{ "key": "marginalia:rl:tts:ip:1.2.3.4", "window_seconds": 60 }, ...]
--   p_reset_keys counters to delete in the same statement — used to clear an abuse streak after a
--                request that stayed within its limits, so escalation only tracks consecutive abuse.
--
-- A key that already expired restarts at 1 rather than continuing the old count, which is what makes the
-- window a window. The insert ... on conflict do update is a single statement, so two instances hitting
-- the same key at once still produce two distinct counts (2, 3, ...) instead of a lost update.
--
-- ON CONFLICT DO UPDATE cannot touch the same row twice in one command, so duplicate keys in p_bumps are
-- collapsed before the insert.
create or replace function public.rate_limit_hit(
  p_bumps jsonb,
  p_reset_keys text[] default '{}'
)
returns table (counter_key text, hit_count integer, seconds_left integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
-- The OUT columns below are named after the table's columns, so a bare reference inside this body would
-- be ambiguous. Resolve every ambiguous name to the column; the only parameters referenced here are
-- p_bumps and p_reset_keys, which no column shadows.
#variable_conflict use_column
begin
  -- Clearing a streak and sweeping expired rows are both tiny deletes against the primary key or the
  -- expires_at index; doing them here keeps the table self-cleaning without pg_cron.
  delete from public.rate_limit_counters c
   where c.counter_key = any(coalesce(p_reset_keys, '{}'::text[]))
      or c.expires_at <= now();

  return query
  insert into public.rate_limit_counters as c (counter_key, hit_count, expires_at)
  select b.key, 1, now() + make_interval(secs => b.window_seconds)
    from (
      select distinct on (rec.key) rec.key, rec.window_seconds
        from jsonb_to_recordset(coalesce(p_bumps, '[]'::jsonb)) as rec(key text, window_seconds integer)
       where rec.key is not null
         and rec.window_seconds > 0
       order by rec.key
    ) b
  on conflict (counter_key) do update
     set hit_count = case when c.expires_at <= now() then 1 else c.hit_count + 1 end,
         expires_at = case when c.expires_at <= now() then excluded.expires_at else c.expires_at end
  returning c.counter_key,
            c.hit_count,
            ceil(extract(epoch from (c.expires_at - now())))::integer;
end;
$$;

-- Seconds left on each key that has not expired. Expired or missing keys are simply absent, so the caller
-- reads "0 seconds" and treats the key as free. This is how an active lockout is detected before any
-- counter is touched, and how the caller knows whether a stale abuse streak is worth clearing.
create or replace function public.rate_limit_ttl(p_keys text[])
returns table (counter_key text, seconds_left integer)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select c.counter_key,
         ceil(extract(epoch from (c.expires_at - now())))::integer as seconds_left
    from public.rate_limit_counters c
   where c.counter_key = any(coalesce(p_keys, '{}'::text[]))
     and c.expires_at > now();
$$;

-- Drop counters outright. Used once per allowed request, and only for streaks that actually exist.
create or replace function public.rate_limit_clear(p_keys text[])
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from public.rate_limit_counters c
   where c.counter_key = any(coalesce(p_keys, '{}'::text[]));
$$;

revoke all on function public.rate_limit_hit(jsonb, text[]) from public, anon, authenticated;
revoke all on function public.rate_limit_ttl(text[]) from public, anon, authenticated;
revoke all on function public.rate_limit_clear(text[]) from public, anon, authenticated;

grant execute on function public.rate_limit_hit(jsonb, text[]) to service_role;
grant execute on function public.rate_limit_ttl(text[]) to service_role;
grant execute on function public.rate_limit_clear(text[]) to service_role;
