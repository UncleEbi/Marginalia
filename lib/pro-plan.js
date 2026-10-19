// lib/pro-plan.js
//
// Single source of truth for Marginalia's Pro plans. Imported by the Paystack API handlers and the
// quota-checking endpoints so prices, plan names, durations and the meaning of "Pro is active" can
// never drift between files again.
//
// PRICING
// The monthly price is the anchor: $9 at the CBN official rate of about ₦1,332/$ (October 2026),
// rounded to ₦12,000. The other plans are expressed as multiples of it, so re-pricing the whole
// table only means changing MONTHLY_KOBO (or the env override).
//
//   monthly    ₦12,000   (1 x monthly)   ~$9
//   3 months   ₦36,000   (3 x monthly)   no discount
//   12 months  ₦120,000  (10 x monthly)  2 months free
//
// Env overrides (all optional):
//   PAYSTACK_PRO_CURRENCY               three-letter currency code. Default NGN.
//   PAYSTACK_PRO_AMOUNT_MONTHLY_KOBO    monthly price in minor units (kobo). Default 1200000.
//   PAYSTACK_PRO_AMOUNT_QUARTERLY_KOBO  overrides the 3-month price.
//   PAYSTACK_PRO_AMOUNT_YEARLY_KOBO     overrides the 12-month price.
//   PAYSTACK_PRO_USD_RATE                naira per USD for the display-only estimate. Default 1332.

export const PRO_CURRENCY = String(process.env.PAYSTACK_PRO_CURRENCY || 'NGN').toUpperCase();

const MONTHLY_KOBO = Number(process.env.PAYSTACK_PRO_AMOUNT_MONTHLY_KOBO || 1200000);

const amount = (envValue, fallback) => {
  const n = Number(envValue);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// Order matters: this is the order the paywall lists them in.
export const PRO_PLANS = [
  {
    id: 'pro_monthly',
    label: '1 month',
    note: '',
    months: 1,
    days: 30,
    amountKobo: amount(process.env.PAYSTACK_PRO_AMOUNT_MONTHLY_KOBO, MONTHLY_KOBO)
  },
  {
    id: 'pro_quarterly',
    label: '3 months',
    note: '',
    months: 3,
    days: 90,
    amountKobo: amount(process.env.PAYSTACK_PRO_AMOUNT_QUARTERLY_KOBO, MONTHLY_KOBO * 3)
  },
  {
    id: 'pro_yearly',
    label: '12 months',
    note: '2 months free',
    months: 12,
    days: 365,
    amountKobo: amount(process.env.PAYSTACK_PRO_AMOUNT_YEARLY_KOBO, MONTHLY_KOBO * 10)
  }
];

export const DEFAULT_PLAN_ID = PRO_PLANS[0].id;

export function getPlan(planId) {
  return PRO_PLANS.find((p) => p.id === planId) || null;
}

// Limits on how far an expiry may stack, so a stray repeated payment cannot grant years at once
export const MAX_PRO_STACK_DAYS = 400;

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
//   - first purchase:            paid_at + plan duration
//   - renewal while still pro:   current expiry + plan duration (no free days lost)
//   - delayed/retried webhook:   paid_at + duration again (same input, same output -> idempotent)
export function nextProExpiry(existingExpiresAt, paidAt, durationDays, now = Date.now()) {
  // Accepts both ISO strings (straight from the database) and epoch-ms numbers (from the webhook)
  const toMs = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : (v ? Date.parse(v) : NaN);
  const existing = toMs(existingExpiresAt);
  const paid = toMs(paidAt);
  const base = Math.max(Number.isFinite(existing) ? existing : 0,
                        Number.isFinite(paid) ? paid : now);
  const days = Number.isFinite(durationDays) && durationDays > 0 ? durationDays : PRO_PLANS[0].days;
  return new Date(base + Math.min(days, MAX_PRO_STACK_DAYS) * 86400000);
}

// Display-only USD estimate. Charges are always in NGN; this exists so global visitors don't have
// to convert ₦ in their head. Anchored to the same rate the monthly price was derived from
// (₦12,000 ≈ $9 at ≈₦1,332/$), rounded to whole dollars because it is an approximation.
//   PAYSTACK_PRO_USD_RATE   naira per USD used for the estimate. Default 1332.
export const NGN_PER_USD = (() => {
  const n = Number(process.env.PAYSTACK_PRO_USD_RATE);
  return Number.isFinite(n) && n > 0 ? n : 1332;
})();

// "$9.00" for a plan's "Approx. ~$9.00 USD" line. Returns '' when there is no amount or no
// usable rate, so callers can hide the estimate instead of showing a bogus number.
export function proUsdEquivalentDisplay(amountKobo, rate = NGN_PER_USD) {
  if (!(Number(amountKobo) > 0) || !(Number(rate) > 0)) return '';
  const usd = Math.round((amountKobo / 100) / rate);
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: 'USD',
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(usd);
  } catch (e) {
    return `$${usd}`;
  }
}

// "₦12,000" / "$9" for price labels. Falls back to a plain "12000 NGN" if Intl lacks the currency.
export function proPriceDisplay(amountKobo, currency = PRO_CURRENCY) {
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
//   { ok: false, reason }   -> nothing is granted
//   { ok: true, userId, reference, paidAt, planId, durationDays } -> a verified successful charge
// Every check is explicit so nothing is granted on a partial or mismatched payload.
export function evaluateChargeEvent(event, cfg = {}) {
  const currency = String(cfg.currency ?? PRO_CURRENCY).toUpperCase();
  const ignore = (reason) => ({ ok: false, reason });

  if (!event || typeof event !== 'object') return ignore('payload is not an object');
  if (event.event !== 'charge.success') return ignore(`event type "${event.event || 'unknown'}"`);

  const data = event.data || {};
  if (data.status && data.status !== 'success') return ignore(`payment status "${data.status}"`);

  const meta = data.metadata || {};
  // The amount is checked against the price of the plan in the (signed) metadata, so a charge for
  // one plan can never be replayed as another.
  const plan = getPlan(meta.plan);
  if (!plan) return ignore(`unknown plan "${meta.plan || 'missing'}"`);

  if (Number(data.amount) !== plan.amountKobo) {
    return ignore(`amount ${data.amount} does not match the ${plan.id} price ${plan.amountKobo}`);
  }
  if (String(data.currency || '').toUpperCase() !== currency) {
    return ignore(`currency "${data.currency}" does not match ${currency}`);
  }

  const userId = meta.user_id;
  if (!userId || typeof userId !== 'string') return ignore('metadata.user_id missing');

  const reference = data.reference || (data.id != null ? String(data.id) : '');
  if (!reference) return ignore('payment reference missing');

  const paidAt = data.paid_at ? Date.parse(data.paid_at) : Date.now();
  if (!Number.isFinite(paidAt)) return ignore('paid_at unparseable');

  return { ok: true, userId, reference, paidAt, planId: plan.id, durationDays: plan.days };
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

// Guard against rate drift: ensure the plan pricing multipliers stay consistent
// with the documented anchor (monthly = 1x, quarterly = 3x, yearly = 10x)
export function guardAgainstRateDrift(monthlyKobo = MONTHLY_KOBO) {
  const monthly = getPlan('pro_monthly');
  const quarterly = getPlan('pro_quarterly');
  const yearly = getPlan('pro_yearly');
  const issues = [];
  if (!monthly || !quarterly || !yearly) {
    issues.push('missing plans');
  } else {
    if (monthly.amountKobo !== monthlyKobo) issues.push(`monthly amount mismatch (${monthly.amountKobo} != ${monthlyKobo})`);
    if (quarterly.amountKobo !== monthlyKobo * 3) issues.push(`quarterly amount mismatch (${quarterly.amountKobo} != ${monthlyKobo * 3})`);
    if (yearly.amountKobo !== monthlyKobo * 10) issues.push(`yearly amount mismatch (${yearly.amountKobo} != ${monthlyKobo * 10})`);
    if (quarterly.days !== 90 || monthly.days !== 30 || yearly.days !== 365) issues.push('duration mismatch');
  }
  if (issues.length > 0) {
    const msg = `Rate drift detected: ${issues.join(', ')}`;
    if (typeof console !== 'undefined' && console.warn) console.warn(msg);
    return false;
  }
  return true;
}

try {
  guardAgainstRateDrift();
} catch (e) {
  if (typeof console !== 'undefined' && console.warn) console.warn('Rate drift guard failed:', e);
}

