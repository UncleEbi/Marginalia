// Tests for the paid plan table and the Paystack handlers that depend on it.
//
// The prices are the contract: the paywall shows them, checkout charges them, and the webhook
// refuses anything that does not match them. These tests pin the table (two tiers x three terms,
// each with its own allowance) and the verification rules so a pricing change cannot silently
// desync the three.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import initHandler from '../api/paystack-init.js';
import webhookHandler, { applyProUpgrade } from '../api/paystack-webhook.js';
import {
  PRO_PLANS, DEFAULT_PLAN_ID, DEFAULT_CURRENCY, MAX_PRO_STACK_DAYS, NGN_PER_USD, TIERS, PRO_PERIOD_DAYS,
  getPlan, tierAllowance, isProActive, nextProExpiry, nextQuotaReset, isQuotaResetDue, renewProQuota,
  refreshProQuota, planAmount, currencyForCountry, proPriceDisplay, proUsdEquivalentDisplay,
  evaluateChargeEvent
} from '../lib/pro-plan.js';

const DAY = 86400000;
const NOW = Date.parse('2026-10-15T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

const studentMonthly = getPlan('student_monthly');
const studentQuarterly = getPlan('student_quarterly');
const studentYearly = getPlan('student_yearly');
const studioMonthly = getPlan('studio_monthly');
const studioQuarterly = getPlan('studio_quarterly');
const studioYearly = getPlan('studio_yearly');

// ---------------------------------------------------------------- plan table

test('lists Student Pass then Pro Studio, each monthly -> 3 months -> 12 months', () => {
  assert.deepEqual(PRO_PLANS.map((p) => p.id), [
    'student_monthly', 'student_quarterly', 'student_yearly',
    'studio_monthly', 'studio_quarterly', 'studio_yearly'
  ]);
  assert.equal(DEFAULT_PLAN_ID, 'student_monthly', 'the cheapest entry price is the default');
  assert.deepEqual(PRO_PLANS.map((p) => p.days), [30, 90, 365, 30, 90, 365]);
});

test('the naira market keeps the proposed prices', () => {
  assert.equal(planAmount(studentMonthly, 'NGN'), 200000, 'Student Pass is ₦2,000 / month');
  assert.equal(planAmount(studioMonthly, 'NGN'), 500000, 'Pro Studio is ₦5,000 / month');
  assert.equal(proPriceDisplay(planAmount(studentMonthly, 'NGN'), 'NGN'), '₦2,000');
  assert.equal(proPriceDisplay(planAmount(studioMonthly, 'NGN'), 'NGN'), '₦5,000');
});

test('the international market pays dollars, far above the naira price', () => {
  assert.equal(planAmount(studentMonthly, 'USD'), 799, 'Student Pass is $7.99 / month');
  assert.equal(planAmount(studioMonthly, 'USD'), 1999, 'Pro Studio is $19.99 / month');
  assert.equal(proPriceDisplay(planAmount(studentMonthly, 'USD'), 'USD'), '$7.99');
  assert.equal(proPriceDisplay(planAmount(studioMonthly, 'USD'), 'USD'), '$19.99');
  // The dollar table is its own price, not ₦2,000 converted (~$1.50)
  assert.ok(planAmount(studentMonthly, 'USD') / 100 > (200000 / 100) / NGN_PER_USD * 4);
});

test('the market is chosen from the country, and only one market is ever offered', () => {
  assert.equal(currencyForCountry('NG'), 'NGN');
  assert.equal(currencyForCountry('ng'), 'NGN');
  assert.equal(currencyForCountry('US'), 'USD');
  assert.equal(currencyForCountry('GB'), 'USD');
  assert.equal(currencyForCountry(''), DEFAULT_CURRENCY, 'no country → home market');
  assert.equal(currencyForCountry(undefined), DEFAULT_CURRENCY);
  assert.equal(currencyForCountry(null), DEFAULT_CURRENCY);
});

test('longer terms are priced off each tier’s own monthly anchor, in both markets', () => {
  for (const currency of ['NGN', 'USD']) {
    assert.equal(planAmount(studentQuarterly, currency), planAmount(studentMonthly, currency) * 3);
    assert.equal(planAmount(studentYearly, currency), planAmount(studentMonthly, currency) * 10, 'a year is 10 months (2 free)');
    assert.equal(planAmount(studioQuarterly, currency), planAmount(studioMonthly, currency) * 3);
    assert.equal(planAmount(studioYearly, currency), planAmount(studioMonthly, currency) * 10);
  }
  assert.deepEqual(
    PRO_PLANS.map((p) => proPriceDisplay(planAmount(p, 'NGN'), 'NGN')),
    ['₦2,000', '₦6,000', '₦20,000', '₦5,000', '₦15,000', '₦50,000']
  );
  assert.deepEqual(
    PRO_PLANS.map((p) => proPriceDisplay(planAmount(p, 'USD'), 'USD')),
    ['$7.99', '$23.97', '$79.90', '$19.99', '$59.97', '$199.90']
  );
  assert.match(studentYearly.note, /2 months free/);
});

test('every term grants the tier’s monthly allowance, refilled each period', () => {
  // The term buys time, not a bigger lump: a yearly plan refills monthly for twelve months
  for (const plan of PRO_PLANS) {
    const tier = TIERS[plan.tier];
    assert.equal(plan.summaryCredits, tier.summaryCredits, `${plan.id} grants the monthly summaries`);
    assert.equal(plan.neuralChars, tier.neuralChars, `${plan.id} grants the monthly chars`);
  }
  assert.deepEqual(PRO_PLANS.map((p) => p.months), [1, 3, 12, 1, 3, 12]);
  assert.equal(studioMonthly.neuralChars, 100000, 'the studio cap is per month, not per term');
});

test('tiers carry their own label and monthly allowance', () => {
  assert.equal(TIERS.student.label, 'Student Pass');
  assert.equal(TIERS.studio.label, 'Pro Studio');
  assert.deepEqual(tierAllowance('studio'), { label: 'Pro Studio', summaryCredits: 50, neuralChars: 100000 });
  assert.equal(tierAllowance('free'), null, 'free is not a purchasable tier');
  assert.equal(studentMonthly.tierLabel, 'Student Pass');
  assert.equal(studioYearly.tier, 'studio');
});

test('unknown plan ids resolve to nothing', () => {
  assert.equal(getPlan('pro_lifetime'), null);
  assert.equal(getPlan('pro_monthly'), null, 'the single-tier ids are gone');
  assert.equal(getPlan(''), null);
  assert.equal(getPlan(undefined), null);
});

test('each plan shows a USD estimate that does not overstate the cheap plan', () => {
  assert.equal(NGN_PER_USD, 1332, 'the estimate uses the rate the naira prices were derived from');
  // Cents below $10 (₦2,000 is ~$1.50, and "$2.00" would be a third more), whole dollars above it
  assert.equal(proUsdEquivalentDisplay(planAmount(studentMonthly, 'NGN')), '$1.50');
  assert.equal(proUsdEquivalentDisplay(planAmount(studentQuarterly, 'NGN')), '$4.50');
  assert.equal(proUsdEquivalentDisplay(planAmount(studentYearly, 'NGN')), '$15');
  assert.equal(proUsdEquivalentDisplay(planAmount(studioMonthly, 'NGN')), '$3.75');
  assert.equal(proUsdEquivalentDisplay(planAmount(studioQuarterly, 'NGN')), '$11');
  assert.equal(proUsdEquivalentDisplay(planAmount(studioYearly, 'NGN')), '$38');
});

test('the USD estimate is hidden, not invented, when it cannot be computed', () => {
  assert.equal(proUsdEquivalentDisplay(0), '');
  assert.equal(proUsdEquivalentDisplay('abc'), '');
  assert.equal(proUsdEquivalentDisplay(planAmount(studentMonthly, 'NGN'), 0), '', 'no rate → no estimate');
  assert.equal(proUsdEquivalentDisplay(planAmount(studentMonthly, 'NGN'), -5), '', 'negative rate → no estimate');
});

// ------------------------------------------------------- expiry per plan

test('each plan grants its own duration', () => {
  for (const plan of PRO_PLANS) {
    const expiry = nextProExpiry(null, NOW, plan.days, NOW);
    assert.equal(expiry.getTime(), NOW + plan.days * DAY, `${plan.id} grants ${plan.days} days`);
  }
});

test('renewing while active stacks from the current expiry', () => {
  const existing = NOW + 10 * DAY;
  assert.equal(nextProExpiry(iso(existing), NOW, studioYearly.days, NOW).getTime(), existing + 365 * DAY);
});

test('a stacked expiry cannot run past the cap', () => {
  const already = NOW + 300 * DAY;
  const capped = nextProExpiry(iso(already), NOW, 3650, NOW);
  assert.equal(capped.getTime(), already + MAX_PRO_STACK_DAYS * DAY);
});

test('pro is active only while the expiry is in the future', () => {
  assert.equal(isProActive({ tier: 'pro', pro_expires_at: iso(NOW + DAY) }, NOW), true);
  assert.equal(isProActive({ tier: 'pro', pro_expires_at: iso(NOW - DAY) }, NOW), false);
  assert.equal(isProActive({ tier: 'pro', pro_expires_at: null }, NOW), false);
  assert.equal(isProActive({ tier: 'free', pro_expires_at: iso(NOW + DAY) }, NOW), false);
});

// ------------------------------------------------ monthly allowance refills

test('the next refill lands a whole period ahead, never in the past', () => {
  assert.equal(PRO_PERIOD_DAYS, 30);
  assert.equal(nextQuotaReset(NOW, NOW).getTime(), NOW + 30 * DAY, 'fresh anchor lands one period out');
  assert.equal(nextQuotaReset(iso(NOW + 5 * DAY), NOW).getTime(), NOW + 5 * DAY, 'inside the period: unchanged');
  // A refill that runs a day late still steps from the purchase date, so the next one is 29 days
  // out rather than 30: the monthly anniversary does not drift forward every time someone is slow.
  assert.equal(nextQuotaReset(iso(NOW - DAY), NOW).getTime(), NOW + 29 * DAY);

  // Three months away still gets one refill, not three stacked ones
  const stale = NOW - 75 * DAY;
  const moved = nextQuotaReset(iso(stale), NOW).getTime();
  assert.ok(moved > NOW, 'the anchor always lands in the future');
  assert.equal(moved, stale + 90 * DAY);
});

test('a refill is due only for an active subscription with an anchor in the past', () => {
  const active = { tier: 'pro', pro_tier: 'student', pro_expires_at: iso(NOW + 200 * DAY) };
  assert.equal(isQuotaResetDue({ ...active, pro_quota_resets_at: iso(NOW - DAY) }, NOW), true);
  assert.equal(isQuotaResetDue({ ...active, pro_quota_resets_at: iso(NOW + DAY) }, NOW), false);
  assert.equal(isQuotaResetDue({ ...active, pro_quota_resets_at: null }, NOW), false, 'no anchor: left alone');
  assert.equal(isQuotaResetDue({ ...active, pro_quota_resets_at: iso(NOW - DAY), pro_expires_at: iso(NOW - DAY) }, NOW), false, 'expired');
  assert.equal(isQuotaResetDue({ tier: 'free', pro_quota_resets_at: iso(NOW - DAY) }, NOW), false, 'free');
});

// Minimal stand-in for the Supabase row builder: one profile row, written only while the anchor
// the caller read still matches (the compare-and-swap renewProQuota relies on).
function fakeDb(row) {
  const state = { row: { ...row }, updates: 0 };
  const api = {
    from() {
      const q = {
        filters: [], patch: null,
        update(patch) { q.patch = patch; return q; },
        select() { return q; },
        eq(k, v) { q.filters.push([k, v]); return q; },
        maybeSingle() {
          const matches = q.filters.every(([k, v]) => state.row[k] === v);
          return Promise.resolve({ data: matches ? state.row : null, error: null });
        },
        then(resolve) {
          const matches = q.filters.every(([k, v]) => state.row[k] === v);
          if (matches && q.patch) { Object.assign(state.row, q.patch); state.updates++; }
          return Promise.resolve({ data: matches ? [state.row] : [], error: null }).then(resolve);
        }
      };
      return q;
    }
  };
  return { api, state };
}

test('a due refill restores the monthly allowance and moves the anchor', async () => {
  const { api, state } = fakeDb({
    id: 'user-1', tier: 'pro', pro_tier: 'studio',
    pro_expires_at: iso(NOW + 300 * DAY), pro_quota_resets_at: iso(NOW),
    summary_credits_remaining: 0, neural_chars_remaining: 12
  });

  const renewed = await renewProQuota(api, 'user-1', state.row, NOW);
  assert.equal(renewed.summary_credits_remaining, 50, 'studio summaries per month');
  assert.equal(renewed.neural_chars_remaining, 100000, 'studio chars per month');
  assert.equal(Date.parse(renewed.pro_quota_resets_at), NOW + 30 * DAY);
  assert.equal(state.updates, 1);
});

test('two refills racing on the same snapshot only apply once', async () => {
  const { api, state } = fakeDb({
    id: 'user-1', tier: 'pro', pro_tier: 'student',
    pro_expires_at: iso(NOW + 300 * DAY), pro_quota_resets_at: iso(NOW - DAY),
    summary_credits_remaining: 2, neural_chars_remaining: 0
  });
  const snapshot = { ...state.row };

  assert.ok(await renewProQuota(api, 'user-1', snapshot, NOW), 'first refill lands');
  assert.equal(await renewProQuota(api, 'user-1', snapshot, NOW), null, 'second finds the anchor moved');
  assert.equal(state.updates, 1, 'the balance was reset exactly once');
});

test('refreshProQuota refills a due account and leaves a current one alone', async () => {
  const due = fakeDb({
    id: 'user-1', tier: 'pro', pro_tier: 'student',
    pro_expires_at: iso(NOW + 200 * DAY), pro_quota_resets_at: iso(NOW - DAY),
    summary_credits_remaining: 1, neural_chars_remaining: 40
  });
  const refreshed = await refreshProQuota(due.api, 'user-1', NOW);
  assert.equal(refreshed.error, null);
  assert.equal(refreshed.profile.summary_credits_remaining, 50, 'refilled to the monthly allowance');
  assert.equal(refreshed.profile.neural_chars_remaining, 15000);
  assert.equal(due.state.updates, 1);

  // Mid-period: the balance is whatever the account has left, untouched
  const current = fakeDb({
    id: 'user-1', tier: 'pro', pro_tier: 'studio',
    pro_expires_at: iso(NOW + 200 * DAY), pro_quota_resets_at: iso(NOW + 5 * DAY),
    summary_credits_remaining: 7, neural_chars_remaining: 999
  });
  const untouched = await refreshProQuota(current.api, 'user-1', NOW);
  assert.equal(untouched.profile.summary_credits_remaining, 7);
  assert.equal(current.state.updates, 0);
});

// ------------------------------------------------ webhook event evaluation

const event = (over = {}, metaOver = {}, planId = 'student_monthly', currency = 'NGN') => ({
  event: 'charge.success',
  data: {
    status: 'success',
    amount: planAmount(getPlan(planId), currency),
    currency,
    reference: 'ref_abc123',
    paid_at: '2026-10-15T11:55:00Z',
    metadata: { user_id: 'user-1', plan: planId, ...metaOver },
    ...over
  }
});

test('accepts a correctly priced charge for each plan in either currency', () => {
  for (const plan of PRO_PLANS) {
    for (const currency of ['NGN', 'USD']) {
      const decision = evaluateChargeEvent(event({}, {}, plan.id, currency));
      assert.equal(decision.ok, true, `${plan.id} in ${currency} accepted`);
      assert.equal(decision.planId, plan.id);
      assert.equal(decision.durationDays, plan.days);
      assert.equal(decision.currency, currency);
    }
  }
});

test('rejects a charge whose amount does not match the plan it claims', () => {
  // Paying the Student Pass price but claiming Pro Studio must not grant the studio quota
  const decision = evaluateChargeEvent(event({ amount: planAmount(studentMonthly, 'NGN') }, {}, 'studio_monthly', 'NGN'));
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /does not match/);
});

test('rejects a dollar amount arriving as a naira charge', () => {
  // $7.99 has to be a $7.99 charge; arriving as NGN it is not ₦2,000 and buys nothing
  const decision = evaluateChargeEvent(event({ amount: 799 }, {}, 'student_monthly', 'NGN'));
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /does not match/);
});

test('rejects a currency the plans are not sold in', () => {
  const decision = evaluateChargeEvent(event({ currency: 'EUR' }, {}, 'student_monthly', 'EUR'));
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /not sold in EUR/);
});

test('rejects an unknown plan in the metadata', () => {
  const decision = evaluateChargeEvent(event({}, { plan: 'pro_lifetime' }));
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /unknown plan/);
});

test('rejects missing plan, missing user, wrong currency and failed status', () => {
  assert.equal(evaluateChargeEvent(event({}, { plan: '' })).ok, false, 'missing plan');
  assert.equal(evaluateChargeEvent(event({}, { user_id: undefined })).ok, false, 'missing user_id');
  assert.equal(evaluateChargeEvent(event({ status: 'failed' })).ok, false, 'failed status');
  assert.equal(evaluateChargeEvent({ event: 'invoice.created', data: {} }).ok, false, 'other event type');
  assert.equal(evaluateChargeEvent(null).ok, false, 'null payload');
});

test('falls back to the transaction id when no reference is present', () => {
  const decision = evaluateChargeEvent(event({ reference: undefined, id: 4242 }));
  assert.equal(decision.ok, true);
  assert.equal(decision.reference, '4242');
});

// ------------------------------------------------------- handler behaviour

const res = () => ({
  statusCode: null, body: undefined, headers: {},
  setHeader(k, v) { this.headers[k] = v; },
  status(c) { this.statusCode = c; return this; },
  json(o) { this.body = o; return this; },
  send(s) { this.body = s; return this; }
});
const sign = (payload, secret) => crypto.createHmac('sha512', secret).update(payload).digest('hex');

test('GET /api/paystack-init lists every plan with its price, tier and allowance', async () => {
  const r = res();
  await initHandler({ method: 'GET', headers: {} }, r);

  assert.equal(r.statusCode, 200);
  assert.equal(r.body.currency, 'NGN', 'no geo header → home market');
  assert.equal(r.body.country, null);
  assert.equal(r.body.default_plan, 'student_monthly');
  assert.deepEqual(r.body.plans.map((p) => p.id), [
    'student_monthly', 'student_quarterly', 'student_yearly',
    'studio_monthly', 'studio_quarterly', 'studio_yearly'
  ]);
  assert.deepEqual(r.body.plans.map((p) => p.tier_label),
    ['Student Pass', 'Student Pass', 'Student Pass', 'Pro Studio', 'Pro Studio', 'Pro Studio']);
  assert.deepEqual(r.body.plans.map((p) => p.amount_display),
    ['₦2,000', '₦6,000', '₦20,000', '₦5,000', '₦15,000', '₦50,000']);
  assert.deepEqual(r.body.plans.map((p) => p.amount_usd_display),
    ['$1.50', '$4.50', '$15', '$3.75', '$11', '$38']);
  assert.deepEqual(r.body.plans.map((p) => p.days), [30, 90, 365, 30, 90, 365]);
  assert.deepEqual(r.body.plans.map((p) => [p.summary_credits, p.neural_chars]), [
    [50, 15000], [50, 15000], [50, 15000],
    [50, 100000], [50, 100000], [50, 100000]
  ]);
  assert.equal(r.body.usd_rate, NGN_PER_USD);
});

test('a visitor outside Nigeria sees only dollar prices', async () => {
  const r = res();
  await initHandler({ method: 'GET', headers: { 'x-vercel-ip-country': 'US' } }, r);

  assert.equal(r.statusCode, 200);
  assert.equal(r.body.currency, 'USD');
  assert.equal(r.body.country, 'US');
  assert.deepEqual(r.body.plans.map((p) => p.amount), [799, 2397, 7990, 1999, 5997, 19990]);
  assert.deepEqual(r.body.plans.map((p) => p.amount_display),
    ['$7.99', '$23.97', '$79.90', '$19.99', '$59.97', '$199.90']);
  assert.deepEqual(r.body.plans.map((p) => p.amount_usd_display), [null, null, null, null, null, null],
    'a dollar price needs no dollar estimate beside it');
});

test('a Nigerian visitor is offered naira even behind another proxy', async () => {
  const r = res();
  await initHandler({ method: 'GET', headers: { 'cf-ipcountry': 'NG' } }, r);
  assert.equal(r.body.currency, 'NGN');
  assert.equal(r.body.plans[0].amount_display, '₦2,000');
});

test('POST rejects an unknown plan before touching Paystack', async () => {
  process.env.PAYSTACK_SECRET_KEY = 'test_secret';
  const r = res();
  await initHandler({ method: 'POST', headers: {}, body: { plan: 'pro_lifetime' } }, r);
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /Unknown plan/);
});

test('POST without a session is 401, and other methods are 405', async () => {
  process.env.PAYSTACK_SECRET_KEY = 'test_secret';
  const unauth = res();
  await initHandler({ method: 'POST', headers: {}, body: { plan: 'studio_yearly' } }, unauth);
  assert.equal(unauth.statusCode, 401);

  const bad = res();
  await initHandler({ method: 'DELETE', headers: {} }, bad);
  assert.equal(bad.statusCode, 405);
  assert.equal(bad.headers.Allow, 'GET, POST');
});

test('webhook verifies the signature before anything else', async () => {
  process.env.PAYSTACK_SECRET_KEY = 'whsec_test';
  const payload = JSON.stringify(event());
  // An unexplained signature is checked against Paystack, and there is no such transaction
  const restore = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ status: false }) });
  try {
    const bad = res();
    await webhookHandler({ method: 'POST', headers: { 'x-paystack-signature': sign(payload, 'wrong') }, body: payload }, bad);
    assert.equal(bad.statusCode, 401, 'wrong signature');

    const missing = res();
    await webhookHandler({ method: 'POST', headers: {}, body: payload }, missing);
    assert.equal(missing.statusCode, 401, 'missing signature');
  } finally {
    globalThis.fetch = restore;
  }
});

test('a genuine delivery Vercel re-serialised is accepted via transaction verify', async () => {
  process.env.PAYSTACK_SECRET_KEY = 'whsec_test';
  process.env.SUPABASE_URL = 'http://127.0.0.1:1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';
  const good = event();
  let asked = null;

  const restore = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const target = String(url);
    if (!target.includes('/transaction/verify/')) {
      // Supabase shares global fetch; make its read fail so the test stops before applying anything
      return { ok: false, status: 500, json: async () => ({ message: 'stub' }), text: async () => 'stub' };
    }
    asked = { url: target, auth: opts?.headers?.Authorization };
    return { ok: true, status: 200, json: async () => ({ status: true, data: good.data }) };
  };
  try {
    const r = res();
    // The body arrives as an object (Vercel's parsed form) but the signature was made from other
    // bytes, which is exactly the re-serialisation case this fallback exists for.
    await webhookHandler({ method: 'POST', headers: { 'x-paystack-signature': sign(JSON.stringify(good), 'different') }, body: good }, r);
    assert.equal(r.statusCode, 500, 'authenticated via verify, then reached the (unreachable) database');
  } finally {
    globalThis.fetch = restore;
  }
  assert.match(asked.url, /\/transaction\/verify\/ref_abc123$/);
  assert.equal(asked.auth, 'Bearer whsec_test');
});

test('a webhook that cannot reach Paystack to verify returns 502 so it is retried', async () => {
  process.env.PAYSTACK_SECRET_KEY = 'whsec_test';
  const payload = JSON.stringify(event());
  const restore = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const r = res();
    await webhookHandler({ method: 'POST', headers: { 'x-paystack-signature': 'nope' }, body: payload }, r);
    assert.equal(r.statusCode, 502);
  } finally {
    globalThis.fetch = restore;
  }
});

test('webhook ignores a mismatched amount with 200 and never upgrades', async () => {
  process.env.PAYSTACK_SECRET_KEY = 'whsec_test';
  const payload = JSON.stringify(event({ amount: 5000 }, {}, 'studio_yearly'));
  const r = res();
  await webhookHandler({ method: 'POST', headers: { 'x-paystack-signature': sign(payload, 'whsec_test') }, body: payload }, r);
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /Ignored: amount/);
});

test('webhook acks unknown plan events without granting anything', async () => {
  process.env.PAYSTACK_SECRET_KEY = 'whsec_test';
  const payload = JSON.stringify(event({}, { plan: 'pro_lifetime' }));
  const r = res();
  await webhookHandler({ method: 'POST', headers: { 'x-paystack-signature': sign(payload, 'whsec_test') }, body: payload }, r);
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /Ignored: unknown plan/);
});

test('webhook reports 500 when it cannot reach the database, so Paystack retries', async () => {
  process.env.PAYSTACK_SECRET_KEY = 'whsec_test';
  process.env.SUPABASE_URL = 'http://127.0.0.1:1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';
  const payload = JSON.stringify(event({}, {}, 'student_quarterly'));
  const r = res();
  await webhookHandler({ method: 'POST', headers: { 'x-paystack-signature': sign(payload, 'whsec_test') }, body: payload }, r);
  assert.equal(r.statusCode, 500);
});

// ------------------------------------------------ granting a verified charge

// Minimal Supabase stand-in for the sequence applyProUpgrade runs: read the row, then either
// insert it (no row yet) or update it with a compare-and-swap on the expiry we read.
function profileDb(initialRow = null) {
  const state = { row: initialRow ? { ...initialRow } : null };
  const table = {
    select() {
      const q = {
        eq() { return q; },
        is() { return q; },
        maybeSingle: async () => ({ data: state.row ? { ...state.row } : null, error: null })
      };
      return q;
    },
    insert(row) {
      if (state.row) {
        return Promise.resolve({ error: { message: 'duplicate key value violates unique constraint "profiles_pkey"' } });
      }
      state.row = { ...row };
      return Promise.resolve({ error: null });
    },
    update(patch) {
      const q = {
        eq() { return q; },
        is() { return q; },
        select: async () => {
          if (!state.row) return { data: [], error: null };
          state.row = { ...state.row, ...patch };
          return { data: [{ pro_expires_at: state.row.pro_expires_at }], error: null };
        }
      };
      return q;
    }
  };
  return { state, from: () => table };
}

const PAID_AT = Date.parse('2026-11-13T10:00:00.000Z');

test('a paid charge creates the profile row a brand-new account does not have yet', async () => {
  const db = profileDb(null);
  const result = await applyProUpgrade(db, {
    userId: 'u_new',
    reference: 'ref_new',
    paidAt: PAID_AT,
    durationDays: 30,
    planId: 'student_monthly',
    customerEmail: 'buyer@example.com'
  });

  assert.equal(result.applied, true);
  assert.equal(db.state.row.id, 'u_new');
  assert.equal(db.state.row.email, 'buyer@example.com');
  assert.equal(db.state.row.tier, 'pro');
  assert.equal(db.state.row.pro_tier, 'student');
  assert.equal(db.state.row.last_payment_reference, 'ref_new');
  assert.equal(db.state.row.summary_credits_remaining, 50, 'the tier allowance is seeded, not added');
  assert.equal(db.state.row.neural_chars_remaining, 15000);
  assert.equal(db.state.row.pro_expires_at, '2026-12-13T10:00:00.000Z');
  assert.equal(db.state.row.pro_quota_resets_at, '2026-12-13T10:00:00.000Z', 'one month, then refills');
});

test('a purchase upgrades an existing free profile', async () => {
  const db = profileDb({ tier: 'free', pro_expires_at: null, last_payment_reference: null });
  const result = await applyProUpgrade(db, {
    userId: 'u_free',
    reference: 'ref_a',
    paidAt: PAID_AT,
    durationDays: 365,
    planId: 'studio_yearly'
  });

  assert.equal(result.applied, true);
  assert.equal(db.state.row.tier, 'pro');
  assert.equal(db.state.row.pro_tier, 'studio');
  assert.equal(db.state.row.neural_chars_remaining, 100000);
  assert.equal(db.state.row.pro_expires_at, '2027-11-13T10:00:00.000Z');
});

test('a re-sent webhook does not credit the same payment twice', async () => {
  const db = profileDb({
    tier: 'pro',
    pro_tier: 'student',
    pro_expires_at: '2026-12-13T10:00:00.000Z',
    last_payment_reference: 'ref_same',
    summary_credits_remaining: 12,
    neural_chars_remaining: 900
  });

  const result = await applyProUpgrade(db, {
    userId: 'u1',
    reference: 'ref_same',
    paidAt: PAID_AT,
    durationDays: 30,
    planId: 'student_monthly'
  });

  assert.equal(result.applied, true);
  assert.equal(result.alreadyProcessed, true);
  assert.equal(db.state.row.pro_expires_at, '2026-12-13T10:00:00.000Z', 'expiry untouched');
  assert.equal(db.state.row.summary_credits_remaining, 12, 'spent allowance is not topped back up');
});
