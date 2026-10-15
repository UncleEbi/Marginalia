// lib/pro-plan.js
//
// Single source of truth for Marginalia's Pro plan. Imported by the Paystack API handlers and
// the quota-checking endpoints so the price, plan name, duration and the meaning of
// "Pro is active" can never drift between files again.
//
// Env overrides (all optional):
//   PAYSTACK_PRO_AMOUNT_KOBO    price in the currency's minor unit (kobo for NGN). Default 1000000 = ₦10,000.
//   PAYSTACK_PRO_CURRENCY       three-letter currency code. Default NGN.
//   PAYSTACK_PRO_PLAN           plan identifier carried in checkout metadata. Default pro_monthly.
//   PAYSTACK_PRO_DURATION_DAYS  days of Pro granted per successful charge. Default 30.

export const PRO_PLAN = process.env.PAYSTACK_PRO_PLAN || 'pro_monthly';
export const PRO_CURRENCY = String(process.env.PAYSTACK_PRO_CURRENCY || 'NGN').toUpperCase();
export const PRO_AMOUNT_KOBO = Number(process.env.PAYSTACK_PRO_AMOUNT_KOBO || 1000000);
export const PRO_INTERVAL = 'month';
export const PRO_DURATION_DAYS = Number(process.env.PAYSTACK_PRO_DURATION_DAYS || 30);

// Quotas. Free defaults are what a brand-new account gets (and what an expired Pro reverts to).
export const FREE_SUMMARY_CREDITS = 3;
export const FREE_NEURAL_CHARS = 5000;
// What a successful Pro payment tops the account up to.
export const PRO_SUMMARY_CREDITS = 9999;
export const PRO_NEURAL_CHARS = 1000000;

// Pro is active only while the account is tier 'pro' AND the expiry is in the future.
// A null or unparseable expiry is deliberately NOT active: with the migration applied every Pro
// row has an expiry, so null can only mean a row the webhook never legitimately set.
export function isProActive(profile, now = Date.now()) {
  if (!profile || profile.tier !== 'pro') return false;
  const exp = profile.pro_expires_at ? Date.parse(profile.pro_expires_at) : NaN;
  return Number.isFinite(exp) && exp > now;
}

// Where a new charge's expiry lands:
//   - first purchase:            paid_at + duration
//   - renewal while still pro:   current expiry + duration (no free days lost)
//   - delayed/retried webhook:   paid_at + duration again (same input, same output -> idempotent)
export function nextProExpiry(existingExpiresAt, paidAt, durationDays = PRO_DURATION_DAYS, now = Date.now()) {
  // Accepts both ISO strings (straight from the database) and epoch-ms numbers (from the webhook)
  const toMs = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : (v ? Date.parse(v) : NaN);
  const existing = toMs(existingExpiresAt);
  const paid = toMs(paidAt);
  const base = Math.max(Number.isFinite(existing) ? existing : 0,
                        Number.isFinite(paid) ? paid : now);
  return new Date(base + durationDays * 86400000);
}

// "₦10,000" / "$9" for price labels. Falls back to a plain "10000 NGN" if Intl lacks the currency.
export function proPriceDisplay(amountKobo = PRO_AMOUNT_KOBO, currency = PRO_CURRENCY) {
  const major = (Number(amountKobo) || 0) / 100;
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      maximumFractionDigits: 0
    }).format(major);
  } catch (e) {
    return `${major} ${currency}`;
  }
}

// Pure decision function for an incoming Paystack webhook payload (the HMAC signature is
// verified separately by the caller). Returns either:
//   { ok: false, reason }              -> the event is not something we grant access for
//   { ok: true, userId, reference, paidAt } -> a verified successful charge for the Pro plan
// Every check is explicit so nothing is granted on a partial or mismatched payload.
export function evaluateChargeEvent(event, cfg = {}) {
  const expectedPlan = cfg.plan ?? PRO_PLAN;
  const expectedAmount = Number(cfg.amountKobo ?? PRO_AMOUNT_KOBO);
  const expectedCurrency = String(cfg.currency ?? PRO_CURRENCY).toUpperCase();
  const ignore = (reason) => ({ ok: false, reason });

  if (!event || typeof event !== 'object') return ignore('payload is not an object');
  if (event.event !== 'charge.success') return ignore(`event type "${event.event || 'unknown'}"`);

  const data = event.data || {};
  if (data.status && data.status !== 'success') return ignore(`payment status "${data.status}"`);
  if (Number(data.amount) !== expectedAmount) {
    return ignore(`amount ${data.amount} does not match plan price ${expectedAmount}`);
  }
  if (String(data.currency || '').toUpperCase() !== expectedCurrency) {
    return ignore(`currency "${data.currency}" does not match ${expectedCurrency}`);
  }

  const meta = data.metadata || {};
  if (meta.plan !== expectedPlan) return ignore(`plan "${meta.plan || 'missing'}" does not match ${expectedPlan}`);

  const userId = meta.user_id;
  if (!userId || typeof userId !== 'string') return ignore('metadata.user_id missing');

  const reference = data.reference || (data.id != null ? String(data.id) : '');
  if (!reference) return ignore('payment reference missing');

  const paidAt = data.paid_at ? Date.parse(data.paid_at) : Date.now();
  if (!Number.isFinite(paidAt)) return ignore('paid_at unparseable');

  return { ok: true, userId, reference, paidAt };
}

// Best-effort lazy downgrade used by the endpoints that check Pro status: once a Pro account has
// expired, flip it back to free and restore the free quotas. Conditional on tier='pro' so a
// concurrent renewal is never clobbered; callers treat failure as "row already handled".
export async function downgradeExpiredPro(db, userId) {
  const { error } = await db
    .from('profiles')
    .update({
      tier: 'free',
      summary_credits_remaining: FREE_SUMMARY_CREDITS,
      neural_chars_remaining: FREE_NEURAL_CHARS
    })
    .eq('id', userId)
    .eq('tier', 'pro')
    .lt('pro_expires_at', new Date().toISOString());
  return !error;
}
