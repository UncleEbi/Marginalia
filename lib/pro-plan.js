// lib/pro-plan.js
//
// Single source of truth for Marginalia's paid plans. Imported by the Paystack API handlers and the
// quota-checking endpoints so prices, plan names, durations, allowances and the meaning of "Pro is
// active" can never drift between files again.
//
// PRICING
// Two tiers, each sold monthly, 3-monthly and yearly, and priced separately per market: naira in
// Nigeria, dollars everywhere else. A visitor is only ever shown their own market's table — the
// server picks it from the geo header (currencyForCountry) — so the two never appear side by side.
// Within each market the monthly price anchors the longer terms (3 x monthly, and 10 x monthly for
// a year, i.e. two months free).
//
//                       Nigeria (NGN)                     International (USD)
//   Student Pass   ₦2,000 / mo   ₦20,000 / yr         $7.99 / mo   $79.90 / yr
//   Pro Studio     ₦5,000 / mo   ₦50,000 / yr        $19.99 / mo  $199.90 / yr
//
// The dollar table is not the naira price converted: it is its own price for a market whose cards
// carry FX costs and a higher willingness to pay, which is why $7.99 is several times ₦2,000.
//
// The entry tier is also named per market. "Student Pass" marks a genuinely student price in
// Nigeria; the same allowance sold abroad is called "Reader", because $7.99 is a market price and
// asking a foreign buyer to self-identify as a student would only make them hesitate.
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
// Allowances refresh monthly rather than arriving as one lump per term: a purchase seeds one
// month, and the balance is filled back up every PRO_PERIOD_DAYS for as long as the paid period
// lasts (pro_quota_resets_at). A yearly buyer therefore gets twelve monthly allowances instead of
// spending one twelve-month allowance over a whole year. Refills are lazy — applied by the
// endpoints that check Pro — so no scheduled job has to exist for this to work.
//
// Env overrides (all optional):
//   PAYSTACK_STUDENT_MONTHLY_KOBO       Student Pass monthly price in kobo. Default 200000 (₦2,000).
//   PAYSTACK_STUDIO_MONTHLY_KOBO        Pro Studio monthly price in kobo. Default 500000 (₦5,000).
//   PAYSTACK_STUDENT_MONTHLY_USD_CENTS  Entry tier monthly price in cents — sold as "Reader"
//                                      outside Nigeria. Default 799 ($7.99).
//   PAYSTACK_STUDIO_MONTHLY_USD_CENTS   Pro Studio monthly price in cents. Default 1999 ($19.99).
//   PAYSTACK_PRO_USD_RATE               naira per USD for the display-only estimate. Default 1332.

// The currencies a plan can be sold in. Amounts are always minor units: kobo for NGN, cents for USD.
export const SUPPORTED_CURRENCIES = ['NGN', 'USD'];

// Where there is no usable country (local dev, a privacy proxy, a non-Vercel host) the home market
// wins: showing a Nigerian student dollars costs a sale, showing an international visitor naira
// only costs them the cheaper price.
export const DEFAULT_CURRENCY = 'NGN';

const minor = (envValue, fallback) => {
  const n = Number(envValue);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// Naira prices are for Nigeria only; every other country is charged in dollars.
export function currencyForCountry(countryCode) {
  const code = String(countryCode || '').trim().toUpperCase();
  if (!code) return DEFAULT_CURRENCY;
  return code === 'NG' ? 'NGN' : 'USD';
}

// What a tier is called in one market ("Student Pass" vs "Reader"). Falls back to the home-market
// name so a label is never blank.
export function tierLabel(tierId, currency = DEFAULT_CURRENCY) {
  const tier = TIERS[tierId];
  if (!tier || !tier.labels) return '';
  return tier.labels[String(currency || '').trim().toUpperCase()] || tier.labels[DEFAULT_CURRENCY];
}

// One entry per paid tier: the monthly price in each market and the monthly allowance it buys.
export const TIERS = {
  student: {
    id: 'student',
    // Same allowance, two names: a student price at home, a general entry plan abroad.
    labels: { NGN: 'Student Pass', USD: 'Reader' },
    monthly: {
      NGN: minor(process.env.PAYSTACK_STUDENT_MONTHLY_KOBO, 200000),
      USD: minor(process.env.PAYSTACK_STUDENT_MONTHLY_USD_CENTS, 799)
    },
    summaryCredits: 50,
    neuralChars: 15000
  },
  studio: {
    id: 'studio',
    labels: { NGN: 'Pro Studio', USD: 'Pro Studio' },
    monthly: {
      NGN: minor(process.env.PAYSTACK_STUDIO_MONTHLY_KOBO, 500000),
      USD: minor(process.env.PAYSTACK_STUDIO_MONTHLY_USD_CENTS, 1999)
    },
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
    tierLabels: tier.labels,
    label: d.label,
    note: d.note,
    months: d.months,
    days: d.days,
    // Price per market, in that currency's minor unit. Every plan is sold in every market: the id
    // carries no currency, and a charge is checked against the currency it actually arrived in.
    amounts: Object.fromEntries(SUPPORTED_CURRENCIES.map((c) => [c, tier.monthly[c] * d.multiplier])),
    // The allowance one period buys; the balance is refilled with this at every reset (see the header).
    summaryCredits: tier.summaryCredits,
    neuralChars: tier.neuralChars
  }))
);

export const DEFAULT_PLAN_ID = PRO_PLANS[0].id;

export function getPlan(planId) {
  return PRO_PLANS.find((p) => p.id === planId) || null;
}

// What a plan costs in one market, in that currency's minor unit. Null when the plan is not sold
// in that currency, so callers can refuse rather than guess a price.
export function planAmount(plan, currency = DEFAULT_CURRENCY) {
  if (!plan || !plan.amounts) return null;
  const amount = plan.amounts[String(currency || '').trim().toUpperCase()];
  return Number.isFinite(amount) ? amount : null;
}

// The tier name to show for a plan in one market ("Reader" on the dollar table, "Student Pass" on
// the naira one), so the paywall and the receipt agree with what the buyer was sold.
export function planTierLabel(plan, currency = DEFAULT_CURRENCY) {
  if (!plan || !plan.tierLabels) return '';
  return tierLabel(plan.tier, currency);
}

// The monthly allowance a tier buys, for anything that needs to label a balance (a term purchase
// is a whole multiple of this).
export function tierAllowance(tierId, currency = DEFAULT_CURRENCY) {
  const tier = TIERS[tierId];
  return tier
    ? { label: tierLabel(tierId, currency), summaryCredits: tier.summaryCredits, neuralChars: tier.neuralChars }
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

// "$1.50" for a naira plan's "Approx. ~$1.50 USD" line (only naira prices need the estimate; a
// dollar price already is dollars). Returns '' when there is no amount or no usable rate, so
// callers can hide the estimate instead of showing a bogus number.
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

// "₦2,000" / "$7.99" for price labels. Falls back to a plain "799 USD" if Intl lacks the currency.
// Whole amounts drop their decimals (naira prices are always whole); a price with cents keeps them,
// because "$8" for $7.99 would round the headline price up.
export function proPriceDisplay(amountMinor, currency = DEFAULT_CURRENCY) {
  const major = (Number(amountMinor) || 0) / 100;
  const digits = Number.isInteger(major) ? 0 : 2;
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    }).format(major);
  } catch (e) {
    return `${major.toFixed(digits)} ${currency}`;
  }
}

// Pure decision function for an incoming Paystack webhook payload (the HMAC signature is
// verified separately by the caller). Returns either:
//   { ok: false, reason }   -> nothing is granted
//   { ok: true, userId, reference, paidAt, planId, durationDays } -> a verified successful charge
// Every check is explicit so nothing is granted on a partial or mismatched payload.
export function evaluateChargeEvent(event) {
  const ignore = (reason) => ({ ok: false, reason });

  if (!event || typeof event !== 'object') return ignore('payload is not an object');
  if (event.event !== 'charge.success') return ignore(`event type "${event.event || 'unknown'}"`);

  const data = event.data || {};
  if (data.status && data.status !== 'success') return ignore(`payment status "${data.status}"`);

  const meta = data.metadata || {};
  // The amount is checked against the price of the plan in the (signed) metadata, in the currency
  // the charge actually arrived in, so a charge for one plan can never be replayed as another —
  // including across tiers, and including a dollar charge posing as the cheaper naira plan.
  const plan = getPlan(meta.plan);
  if (!plan) return ignore(`unknown plan "${meta.plan || 'missing'}"`);

  const currency = String(data.currency || '').trim().toUpperCase();
  const expected = planAmount(plan, currency);
  if (expected == null) {
    return ignore(`${plan.id} is not sold in ${currency || 'an unknown currency'}`);
  }
  if (Number(data.amount) !== expected) {
    return ignore(`amount ${data.amount} does not match the ${plan.id} price ${expected} ${currency}`);
  }

  const userId = meta.user_id;
  if (!userId || typeof userId !== 'string') return ignore('metadata.user_id missing');

  const reference = data.reference || (data.id != null ? String(data.id) : '');
  if (!reference) return ignore('payment reference missing');

  const paidAt = data.paid_at ? Date.parse(data.paid_at) : Date.now();
  if (!Number.isFinite(paidAt)) return ignore('paid_at unparseable');

  return { ok: true, userId, reference, paidAt, planId: plan.id, durationDays: plan.days, currency };
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
      neural_chars_remaining: FREE_NEURAL_CHARS,
      pro_quota_resets_at: null
    })
    .eq('id', userId)
    .eq('tier', 'pro')
    .lt('pro_expires_at', new Date().toISOString());
  return !error;
}

// How often a paid allowance refills. Matches the 30 days a monthly plan grants, so a 3-month plan
// refills three times and a yearly plan twelve.
export const PRO_PERIOD_DAYS = 30;
const PERIOD_MS = PRO_PERIOD_DAYS * 86400000;

// Where the next period boundary is, given the current anchor. Steps a whole number of periods, so
// someone who comes back after three months gets exactly one refill rather than three stacked ones
// (balances do not accumulate).
export function nextQuotaReset(anchorAt, now = Date.now()) {
  const anchor = typeof anchorAt === 'number' && Number.isFinite(anchorAt)
    ? anchorAt
    : (anchorAt ? Date.parse(anchorAt) : NaN);
  const base = Number.isFinite(anchor) ? anchor : now;
  if (base > now) return new Date(base);
  const periods = Math.floor((now - base) / PERIOD_MS) + 1;
  return new Date(base + periods * PERIOD_MS);
}

// True when a paid profile's allowance is due for its monthly refill. Rows with no anchor are left
// completely alone (that is a legacy row, not a reason to hand out a free refill).
export function isQuotaResetDue(profile, now = Date.now()) {
  if (!isProActive(profile, now)) return false;
  const due = profile.pro_quota_resets_at ? Date.parse(profile.pro_quota_resets_at) : NaN;
  return Number.isFinite(due) && due <= now;
}

// Applies one refill: reset the balances to the tier's monthly allowance and move the anchor on.
// Returns the updated row, or null when nothing was written. The update is conditional on the
// anchor we read, so two requests racing each other cannot both refill (and neither can clobber
// usage recorded by the other afterwards).
export async function renewProQuota(db, userId, profile, now = Date.now()) {
  const allowance = tierAllowance(profile.pro_tier);
  if (!allowance) return null;
  const { data, error } = await db
    .from('profiles')
    .update({
      summary_credits_remaining: allowance.summaryCredits,
      neural_chars_remaining: allowance.neuralChars,
      pro_quota_resets_at: nextQuotaReset(profile.pro_quota_resets_at, now).toISOString()
    })
    .eq('id', userId)
    .eq('pro_quota_resets_at', profile.pro_quota_resets_at)
    .select('summary_credits_remaining, neural_chars_remaining, pro_quota_resets_at');
  if (error) return null;
  return data && data.length ? data[0] : null;
}

// What every quota-checking endpoint needs in one call: the profile, with any due refill already
// applied. Returns { profile, error } so callers keep their own "no row yet" handling (the first
// visit still creates a free row).
export async function refreshProQuota(db, userId, now = Date.now()) {
  const { data: profile, error } = await db
    .from('profiles')
    .select('id, tier, pro_tier, pro_expires_at, pro_quota_resets_at, summary_credits_remaining, neural_chars_remaining')
    .eq('id', userId)
    .maybeSingle();
  if (error || !profile) return { profile: profile || null, error };

  if (isQuotaResetDue(profile, now)) {
    const renewed = await renewProQuota(db, userId, profile, now);
    if (renewed) {
      profile.summary_credits_remaining = renewed.summary_credits_remaining;
      profile.neural_chars_remaining = renewed.neural_chars_remaining;
      profile.pro_quota_resets_at = renewed.pro_quota_resets_at;
    }
  }
  return { profile, error: null };
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
      for (const currency of SUPPORTED_CURRENCIES) {
        const expected = tier.monthly[currency] * d.multiplier;
        if (planAmount(plan, currency) !== expected) {
          issues.push(`${plan.id} ${currency} amount mismatch (${planAmount(plan, currency)} != ${expected})`);
        }
      }
      if (plan.days !== d.days) issues.push(`${plan.id} duration mismatch`);
      if (plan.summaryCredits !== tier.summaryCredits) issues.push(`${plan.id} summary allowance mismatch`);
      if (plan.neuralChars !== tier.neuralChars) issues.push(`${plan.id} neural allowance mismatch`);
      if (plan.months !== d.months) issues.push(`${plan.id} term length mismatch`);
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
