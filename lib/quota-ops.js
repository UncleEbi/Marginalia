// lib/quota-ops.js
//
// Two-bucket quota arithmetic shared by the quota-checking endpoints.
//
// Each account has two independent neural buckets and two independent AI-ops buckets:
//   - monthly allowance     (resets every 30 days)
//   - one-time refill top-up (never expires, never reset by the monthly cycle)
//
// TTS consumes from the neural pair; summaries, OCR, and Describe-Image consume from the
// AI-ops pair. The monthly balance is what the plan bought; the top-up balance is what a
// refill pack added. A request is allowed only when the COMBINED balance is enough, and the
// charge is split between the two buckets with the monthly allowance always coming off first.

import { FREE_NEURAL_CHARS, FREE_SUMMARY_CREDITS, tierAllowance } from './pro-plan.js';

export const NEURAL_TOPUP_COL = 'topup_neural_chars';
export const AI_OPS_TOPUP_COL = 'topup_ai_ops';
export const NEURAL_MONTHLY_COL = 'neural_chars_remaining';
export const AI_OPS_MONTHLY_COL = 'summary_credits_remaining';

/**
 * Resolve the monthly allowance for a profile.
 *
 * Paid accounts get the allowance their tier bought; everyone else gets the free defaults.
 * Returns { neural, ops } so callers do not have to remember which column maps to which
 * allowance for free vs paid rows.
 */
export function monthlyAllowance(profile) {
  const paid = tierAllowance(profile?.pro_tier);
  return {
    neural: (profile?.tier === 'pro' && paid) ? paid.neuralChars : FREE_NEURAL_CHARS,
    ops: (profile?.tier === 'pro' && paid) ? paid.summaryCredits : FREE_SUMMARY_CREDITS
  };
}

/**
 * How much of a combined balance is available when the monthly allowance is used first.
 */
export function availableAfterMonthly(monthlyRemaining, topupRemaining) {
  return Math.max(0, monthlyRemaining) + Math.max(0, topupRemaining);
}

/**
 * Split a requested charge against the two buckets.
 *
 * Returns { monthlyTaken, topupTaken, monthlyRemaining, topupRemaining } for the requested
 * amount, assuming the monthly bucket is drained first. The caller is responsible for deciding
 * whether the request is allowed; this is only the accounting.
 */
export function splitCharge({ monthlyRemaining, topupRemaining, requested }) {
  const m = Math.max(0, monthlyRemaining);
  const t = Math.max(0, topupRemaining);
  const requestedCopy = requested;

  const fromMonthly = Math.min(m, requestedCopy);
  const afterMonthly = requestedCopy - fromMonthly;
  const fromTopup = Math.min(t, afterMonthly);

  return {
    monthlyTaken: fromMonthly,
    topupTaken: fromTopup,
    monthlyRemaining: m - fromMonthly,
    topupRemaining: t - fromTopup
  };
}

/**
 * True when both buckets for a given resource are empty.
 */
export function bothBucketsEmpty({ monthlyRemaining, topupRemaining }) {
  return Math.max(0, monthlyRemaining) === 0 && Math.max(0, topupRemaining) === 0;
}
