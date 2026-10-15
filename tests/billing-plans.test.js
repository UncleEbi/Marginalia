// Tests for the Pro plan table and the Paystack handlers that depend on it.
//
// The prices are the contract: the paywall shows them, checkout charges them, and the webhook
// refuses anything that does not match them. These tests pin the table and the verification rules
// so a pricing change cannot silently desync the three.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import initHandler from '../api/paystack-init.js';
import webhookHandler from '../api/paystack-webhook.js';
import {
  PRO_PLANS, DEFAULT_PLAN_ID, PRO_CURRENCY, MAX_PRO_STACK_DAYS,
  getPlan, isProActive, nextProExpiry, proPriceDisplay, evaluateChargeEvent
} from '../lib/pro-plan.js';

const DAY = 86400000;
const NOW = Date.parse('2026-10-15T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const monthly = getPlan('pro_monthly');
const quarterly = getPlan('pro_quarterly');
const yearly = getPlan('pro_yearly');

// ---------------------------------------------------------------- plan table

test('offers monthly, 3-month and 12-month plans in that order', () => {
  assert.deepEqual(PRO_PLANS.map((p) => p.id), ['pro_monthly', 'pro_quarterly', 'pro_yearly']);
  assert.equal(DEFAULT_PLAN_ID, 'pro_monthly');
});

test('monthly price is the ₦12,000 equivalent of $9 (CBN ≈ ₦1,332/$)', () => {
  assert.equal(monthly.amountKobo, 1200000);
  assert.equal(monthly.days, 30);
  // Sanity-check the intent, not just the number: ₦12,000 ≈ $9 at the rate used
  assert.ok(Math.abs(monthly.amountKobo / 100 / 1332 - 9) < 0.2, 'monthly is within a few percent of $9');
});

test('longer plans are priced off the monthly anchor', () => {
  assert.equal(quarterly.amountKobo, monthly.amountKobo * 3, '3 months costs 3x monthly');
  assert.equal(quarterly.days, 90);
  assert.equal(yearly.amountKobo, monthly.amountKobo * 10, '12 months costs 10x monthly (2 months free)');
  assert.equal(yearly.days, 365);
  assert.match(yearly.note, /2 months free/);
});

test('unknown plan ids resolve to nothing', () => {
  assert.equal(getPlan('pro_lifetime'), null);
  assert.equal(getPlan(''), null);
  assert.equal(getPlan(undefined), null);
});

test('prices display in the charged currency', () => {
  assert.equal(proPriceDisplay(monthly.amountKobo), '₦12,000');
  assert.equal(proPriceDisplay(quarterly.amountKobo), '₦36,000');
  assert.equal(proPriceDisplay(yearly.amountKobo), '₦120,000');
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
  assert.equal(nextProExpiry(iso(existing), NOW, yearly.days, NOW).getTime(), existing + 365 * DAY);
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

// ------------------------------------------------ webhook event evaluation

const event = (over = {}, metaOver = {}, planId = 'pro_monthly') => ({
  event: 'charge.success',
  data: {
    status: 'success',
    amount: getPlan(planId).amountKobo,
    currency: PRO_CURRENCY,
    reference: 'ref_abc123',
    paid_at: '2026-10-15T11:55:00Z',
    metadata: { user_id: 'user-1', plan: planId, ...metaOver },
    ...over
  }
});

test('accepts a correctly priced charge for each plan', () => {
  for (const plan of PRO_PLANS) {
    const decision = evaluateChargeEvent(event({}, {}, plan.id));
    assert.equal(decision.ok, true, `${plan.id} accepted`);
    assert.equal(decision.planId, plan.id);
    assert.equal(decision.durationDays, plan.days);
  }
});

test('rejects a charge whose amount does not match the plan it claims', () => {
  // Paying the monthly price but claiming the yearly plan must not grant a year
  const decision = evaluateChargeEvent(event({ amount: monthly.amountKobo }, {}, 'pro_yearly'));
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /does not match/);
});

test('rejects an unknown plan in the metadata', () => {
  const decision = evaluateChargeEvent(event({}, { plan: 'pro_lifetime' }));
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /unknown plan/);
});

test('rejects missing plan, missing user, wrong currency and failed status', () => {
  assert.equal(evaluateChargeEvent(event({}, { plan: '' })).ok, false, 'missing plan');
  assert.equal(evaluateChargeEvent(event({}, { user_id: undefined })).ok, false, 'missing user_id');
  assert.equal(evaluateChargeEvent(event({ currency: 'USD' })).ok, false, 'wrong currency');
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

test('GET /api/paystack-init lists every plan with its display price', async () => {
  const r = res();
  await initHandler({ method: 'GET', headers: {} }, r);

  assert.equal(r.statusCode, 200);
  assert.equal(r.body.currency, PRO_CURRENCY);
  assert.equal(r.body.default_plan, 'pro_monthly');
  assert.deepEqual(r.body.plans.map((p) => p.id), ['pro_monthly', 'pro_quarterly', 'pro_yearly']);
  assert.deepEqual(r.body.plans.map((p) => p.amount_display), ['₦12,000', '₦36,000', '₦120,000']);
  assert.deepEqual(r.body.plans.map((p) => p.days), [30, 90, 365]);
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
  await initHandler({ method: 'POST', headers: {}, body: { plan: 'pro_yearly' } }, unauth);
  assert.equal(unauth.statusCode, 401);

  const bad = res();
  await initHandler({ method: 'DELETE', headers: {} }, bad);
  assert.equal(bad.statusCode, 405);
  assert.equal(bad.headers.Allow, 'GET, POST');
});

test('webhook verifies the signature before anything else', async () => {
  process.env.PAYSTACK_SECRET_KEY = 'whsec_test';
  const payload = JSON.stringify(event());
  const bad = res();
  await webhookHandler({ method: 'POST', headers: { 'x-paystack-signature': sign(payload, 'wrong') }, body: payload }, bad);
  assert.equal(bad.statusCode, 401, 'wrong signature');

  const missing = res();
  await webhookHandler({ method: 'POST', headers: {}, body: payload }, missing);
  assert.equal(missing.statusCode, 401, 'missing signature');
});

test('webhook ignores a mismatched amount with 200 and never upgrades', async () => {
  process.env.PAYSTACK_SECRET_KEY = 'whsec_test';
  const payload = JSON.stringify(event({ amount: 5000 }, {}, 'pro_yearly'));
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
  const payload = JSON.stringify(event({}, {}, 'pro_quarterly'));
  const r = res();
  await webhookHandler({ method: 'POST', headers: { 'x-paystack-signature': sign(payload, 'whsec_test') }, body: payload }, r);
  assert.equal(r.statusCode, 500);
});
