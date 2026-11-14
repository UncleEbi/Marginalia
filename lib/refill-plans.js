// lib/refill-plans.js
//
// Refill pack catalog and currency-aware pack selection.
//
// Refill packs are non-subscription one-time top-ups. Each pack adds a fixed number of neural TTS
// characters and AI summary/OCR operations that are stored as a non-expiring rollover balance on the
// user's profile. A bought pack lets reading continue after the monthly allowance is exhausted, and it
// is never reset by the monthly refill.
//
// Every pack here owns its own currency. The refill checkout and webhook both resolve the currency
// from the active market, so a Nigerian sees the NGN packs and everyone else sees the USD packs.
// The app only ever lists the packs for the currency the server decided for that request.

export const REFILL_PACKS = {
  // Nigeria — paid in kobo.
  pack_ng_1000: {
    id: 'pack_ng_1000',
    currency: 'NGN',
    amount_kobo: 100000,
    neural_chars: 15000,
    ai_ops: 15
  },
  pack_ng_2000: {
    id: 'pack_ng_2000',
    currency: 'NGN',
    amount_kobo: 200000,
    neural_chars: 35000,
    ai_ops: 30
  },

  // International — paid in cents.
  pack_usd_299: {
    id: 'pack_usd_299',
    currency: 'USD',
    amount_cents: 299,
    neural_chars: 35000,
    ai_ops: 15
  },
  pack_usd_499: {
    id: 'pack_usd_499',
    currency: 'USD',
    amount_cents: 499,
    neural_chars: 75000,
    ai_ops: 30
  }
};

const NGINumberFormat = new Intl.NumberFormat('en', {
  style: 'currency',
  currency: 'NGN',
  currencyDisplay: 'narrowSymbol',
  maximumFractionDigits: 0
});

const USDNumberFormat = new Intl.NumberFormat('en', {
  style: 'currency',
  currency: 'USD',
  currencyDisplay: 'narrowSymbol',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

export function refillAmountDisplay(pack) {
  if (!pack) return '';
  if (pack.currency === 'USD' && Number.isFinite(pack.amount_cents)) {
    return USDNumberFormat.format(pack.amount_cents / 100);
  }
  if (pack.currency === 'NGN' && Number.isFinite(pack.amount_kobo)) {
    return NGINumberFormat.format(pack.amount_kobo / 100);
  }
  return '';
}

/**
 * Returns the packs for a currency. Unknown currencies yield an empty list.
 */
export function refillPacksFor(currency = 'NGN') {
  const key = String(currency || '').trim().toUpperCase();
  return Object.values(REFILL_PACKS).filter((p) => p.currency.toUpperCase() === key);
}
