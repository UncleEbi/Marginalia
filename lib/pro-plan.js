// lib/pro-plan.js
//
// Single source of truth for Marginalia's paid plans. Imported by the Paystack API handlers and the
// quota-checking endpoints so prices, plan names, durations, allowances and the meaning of "Pro is
// active" can never drift between files again.
//
// PRICING
// Two tiers, each sold monthly, 3-monthly and yearly. The monthly price is the anchor for the
// longer terms (3 x monthly, and 10 x monthly for a year, i.e. two months free), so re-pricing a
// tier only means changing its monthly amount or the env override.
//
//   Student Pass   ₦2,000 / mo   ₦6,000 / 3 months   ₦20,000 / year
//   Pro Studio     ₦5,000 / mo   ₦15,000 / 3 months  ₦50,000 / year
//
// WHAT EACH TIER GRANTS (per month of the term)
//
//   free     3 AI summaries/OCR scans     5,000 neural TTS chars
//   student  50 AI summaries/OCR scans   15,000 neural TTS chars
//   studio   50 AI summaries/OCR scans  100,000 neural TTS chars
//
// The neural-voice engines that need a paid API (OpenAI, ElevenLabs) are the only real per-use
// cost, so the studio tier is the one with a hard character cap; device voices are free and
// unlimited on every tier. Summaries and OCR share one balance (summary_credits_remaining).
//
// A purchase seeds the whole term at once (allowance x months); nothing tops up mid-term, so a
// longer plan is never worth less than paying monthly.
//
// Env overrides (all optional):
//   PAYSTACK_STUDENT_MONTHLY_KOBO   Student Pass monthly price in kobo. Default 200000 (₦2,000).
//   PAYSTACK_STUDIO_MONTHLY_KOBO    Pro Studio monthly price in kobo. Default 500000 (₦5,000).
//   PAYSTACK_PRO_CURRENCY           three-letter currency code. Default NGN.
//   PAYSTACK_PRO_USD_RATE           naira per USD for the display-only estimate. Default 1332.

export const PRO_CURRENCY = String(process.env.PAYSTACK_PRO_CURRENCY || 'NGN').toUpperCase();

const amount = (envValue, fallback) => {
  const n = Number(envValue);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// One entry per paid tier: the monthly price and the monthly allowance it buys.
export const TIERS = {
  student: {
    id: 'student',
    label: 'Student Pass',
    monthlyKobo: amount(process.env.PAYSTACK_STUDENT_MONTHLY_KOBO, 200000),
    summaryCredits: 50,
    neuralChars: 15000
  },
  studio: {
    id: 'studio',
    label: 'Pro Studio',
    monthlyKobo: amount(process.env.PAYSTACK_STUDIO_MONTHLY_KOBO, 500000),
    summaryCredits: 50,
    neuralChars: 100000
  }
};

// Both tiers are sold on the same three terms.
const DURATIONS = [
  { key: 'monthly', label: '1 month', months: 1, days: 30, multiplier: 1, note: '' },
  { key: 'quarterly', label: '3 months', months: 3, days: 90, multiplier: 3, note: '' },
  { key: 'yearly', label: '12 months', months: 12, days: 365, multiplier: 10, note: '2 months free' }
];

// Order matters: this is the order the paywall lists them in (all Student Pass terms, then the
// Pro Studio ones), so the cheapest entry point is the first row and the default plan.
export const PRO_PLANS = Object.values(TIERS).flatMap((tier) =>
  DURATIONS.map((d) => ({
    id: `${tier.id}_${d.key}`,
    tier: tier.id,
    tierLabel: tier.label,
    label: d.label,
    note: d.note,
    months: d.months,
    days: d.days,
    amountKobo: tier.monthlyKobo * d.multiplier,
    // Seeded in one lump at purchase for the whole term (see the header).
    summaryCredits: tier.summaryCredits * d.months,
    neuralChars: tier.neuralChars * d.months
  }))
);

export const DEFAULT_PLAN_ID = PRO_PLANS[0].id;

export function getPlan(planId) {
  return PRO_PLANS.find((p) => p.id === planId) || null;
}

// The monthly allowance a tier buys, for anything that needs to label a balance (a term purchase
// is a whole multiple of this).
export function tierAllowance(tierId) {
  const tier = TIERS[tierId];
  return tier
    ? { label: tier.label, summaryCredits: tier.summaryCredits, neuralChars: tier.neuralChars }
    : null;
}

// Limits on how far an expiry may stack, so a stray repeated payment cannot grant years at once
export const MAX_PRO_STACK_DAYS = 400;

// Quotas. Free defaults are what a brand-new account gets (and what an expired Pro reverts to).
// Paid accounts are seeded from the plan they bought (summaryCredits / neuralChars above).
export const FREE_SUMMARY_CREDITS = 3;
export const FREE_NEURAL_CHARS = 5000;

// Pro is active only while the account is tier 'pro' AND the expiry is in the future.
// Both paid tiers use tier 'pro'; pro_tier ('student' | 'studio') says which allowance was bought.
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
// to convert ₦ in their head. Anchored to the same rate the naira prices were derived from,
// rounded to cents below $10 and to whole dollars above it (where the extra digits would only
// suggest a precision the exchange rate does not have).
//   PAYSTACK_PRO_USD_RATE   naira per USD used for the estimate. Default 1332.
export const NGN_PER_USD = (() => {
  const n = Number(process.env.PAYSTACK_PRO_USD_RATE);
  return Number.isFinite(n) && n > 0 ? n : 1332;
})();

// "$1.50" for a plan's "Approx. ~$1.50 USD" line. Returns '' when there is no amount or no
// usable rate, so callers can hide the estimate instead of showing a bogus number.
export function proUsdEquivalentDisplay(amountKobo, rate = NGN_PER_USD) {
  if (!(Number(amountKobo) > 0) || !(Number(rate) > 0)) return '';
  const usd = (amountKobo / 100) / rate;
  // ₦2,000 is about $1.50; rounding that to "$2.00" would overstate the cheapest plan by a third.
  const digits = usd < 10 ? 2 : 0;
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: 'USD',
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    }).format(usd);
  } catch (e) {
    return `$${usd.toFixed(digits)}`;
  }
}

// "₦2,000" / "$9" for price labels. Falls back to a plain "2000 NGN" if Intl lacks the currency.
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
  // one plan can never be replayed as another — including across tiers.
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
      pro_tier: null,
      summary_credits_remaining: FREE_SUMMARY_CREDITS,
      neural_chars_remaining: FREE_NEURAL_CHARS
    })
    .eq('id', userId)
    .eq('tier', 'pro')
    .lt('pro_expires_at', new Date().toISOString());
  return !error;
}

// Guard against rate drift: ensure every plan's price and duration still match the documented
// anchors (each tier's monthly price x1 / x3 / x10, on 30 / 90 / 365 days).
export function guardAgainstRateDrift() {
  const issues = [];
  for (const tier of Object.values(TIERS)) {
    for (const d of DURATIONS) {
      const plan = getPlan(`${tier.id}_${d.key}`);
      if (!plan) {
        issues.push(`${tier.id}: missing ${d.key} plan`);
        continue;
      }
      const expected = tier.monthlyKobo * d.multiplier;
      if (plan.amountKobo !== expected) {
        issues.push(`${plan.id} amount mismatch (${plan.amountKobo} != ${expected})`);
      }
      if (plan.days !== d.days) issues.push(`${plan.id} duration mismatch`);
      if (plan.summaryCredits !== tier.summaryCredits * d.months) issues.push(`${plan.id} summary allowance mismatch`);
      if (plan.neuralChars !== tier.neuralChars * d.months) issues.push(`${plan.id} neural allowance mismatch`);
    }
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
