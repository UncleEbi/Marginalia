-- Refill pack top-ups live on the profile row as two non-expiring rollover balances.
--
--   topup_neural_chars  -> additional neural TTS characters that never expire and never reset.
--   topup_ai_ops        -> additional AI summary/OCR operations that never expire and never reset.
--
-- The monthly quota checkers consume the tier allowance first and only touch these columns as a
-- backstop, so a bought pack extends the reading session instead of being reset by the 30-day refill.
-- The webhook credits these columns, so they must exist before deploying that handler.

alter table public.profiles
  add column if not exists topup_neural_chars integer not null default 0,
  add column if not exists topup_ai_ops integer not null default 0;

comment on column public.profiles.topup_neural_chars is
  'One-time neural TTS top-up balance purchased via a refill pack. Never expires; untouched by the monthly refill.';

comment on column public.profiles.topup_ai_ops is
  'One-time AI summary / OCR top-up balance purchased via a refill pack. Never expires; untouched by the monthly refill.';

update public.profiles
  set topup_neural_chars = coalesce(topup_neural_chars, 0),
      topup_ai_ops = coalesce(topup_ai_ops, 0)
  where topup_neural_chars is null or topup_ai_ops is null;
