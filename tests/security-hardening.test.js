// tests/security-hardening.test.js
//
// Regression tests for the hardening pass over the attack surfaces a stranger can actually reach:
// forged proxy headers, forged Origin/Host on links, SSRF via redirects, unbounded auth inputs,
// non-image payloads on the vision routes, inherited-property lookups, and Study Pack RLS.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

import { clientIp, normalizeEmail, TIERS } from '../api/_lib/rate-limit.js';
import { appOrigin } from '../api/_lib/app-origin.js';
import { isImagePayload, normalizeImageMime } from '../api/_lib/image-payload.js';
import { validatePublicUrl } from '../api/_lib/ssrf.js';
import { REFILL_PACKS } from '../lib/refill-plans.js';
import studyPackHandler from '../api/study-pack.js';
import extractUrlHandler from '../api/extract-url.js';
import webhookHandler from '../api/paystack-webhook.js';

const DEFAULT_ORIGIN = 'https://marginalia-rme.vercel.app';

function mockRes() {
  const res = {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return res; },
    json(body) { this.body = body; return res; },
    send(body) { this.body = body; return res; }
  };
  return res;
}

test('clientIp uses the end of x-forwarded-for that the last trusted proxy wrote', () => {
  // A caller prepends its own value; the edge appends the address it actually saw.
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' } }), '203.0.113.9');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '203.0.113.9:443' } }), '203.0.113.9');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': ['198.51.100.1, 198.51.100.2'] } }), '198.51.100.2');
  // Platform-written headers win over anything the request carried.
  assert.equal(
    clientIp({ headers: { 'x-vercel-forwarded-for': '198.51.100.7', 'x-forwarded-for': '1.2.3.4' } }),
    '198.51.100.7'
  );
  // A value that is not an address never becomes an identity: no fresh allowance per request.
  assert.equal(clientIp({ headers: { 'x-forwarded-for': 'not-an-ip' } }), 'unknown');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '' } }), 'unknown');
  assert.equal(clientIp({}), 'unknown');
});

test('clientIp reads the client end of a platform-written header list', () => {
  // The edge writes trusted headers as "client, proxy": the client is FIRST. Reading the rightmost
  // entry returned the proxy, which made the Paystack webhook allowlist reject real callbacks.
  assert.equal(
    clientIp({ headers: { 'x-vercel-forwarded-for': '203.0.113.9, 198.51.100.2' } }),
    '203.0.113.9'
  );
  assert.equal(
    clientIp({ headers: { 'cf-connecting-ip': '203.0.113.9, 198.51.100.2' } }),
    '203.0.113.9'
  );
  assert.equal(
    clientIp({ headers: { 'x-real-ip': '203.0.113.9, 198.51.100.2' } }),
    '203.0.113.9'
  );
  assert.equal(
    clientIp({ headers: { 'x-vercel-forwarded-for': ['203.0.113.9, 198.51.100.2'] } }),
    '203.0.113.9'
  );
  // The generic, caller-influencable header keeps the rightmost rule even when a platform header
  // is present but unusable.
  assert.equal(
    clientIp({ headers: { 'x-vercel-forwarded-for': 'unknown', 'x-forwarded-for': '1.2.3.4, 203.0.113.9' } }),
    '203.0.113.9'
  );
});

test('long emails are clamped before they become a rate-limit key', () => {
  const long = `${'a'.repeat(400)}@example.com`;
  assert.equal(normalizeEmail(long).length, 254);
  assert.equal(normalizeEmail(' Reader@Example.COM '), 'reader@example.com');
});

test('a share link never adopts a caller-supplied Origin or Host', () => {
  const saved = process.env.APP_ORIGIN;
  delete process.env.APP_ORIGIN;
  try {
    assert.equal(appOrigin({ headers: { origin: 'https://evil.example' } }), DEFAULT_ORIGIN);
    assert.equal(appOrigin({ headers: { host: 'evil.example' } }), DEFAULT_ORIGIN);
    assert.equal(appOrigin({ headers: { origin: 'https://marginalia-rme.vercel.app' } }), DEFAULT_ORIGIN);
    assert.equal(appOrigin({}), DEFAULT_ORIGIN);

    // A configured deployment keeps its own origin, but still not a forged one.
    process.env.APP_ORIGIN = 'https://reader.example';
    assert.equal(appOrigin({ headers: { origin: 'https://evil.example' } }), 'https://reader.example');
    assert.equal(appOrigin({ headers: { origin: 'https://reader.example' } }), 'https://reader.example');
  } finally {
    if (saved === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = saved;
  }
});

test('the vision routes accept image payloads only', () => {
  assert.equal(isImagePayload('data:text/html;base64,PHNjcmlwdD4='), false);
  assert.equal(isImagePayload('data:image/png;base64,iVBORw0KGgo='), true);
  assert.equal(isImagePayload('/9j/4AAQSkZJRg=='), true);
  assert.equal(isImagePayload(''), false);
  assert.equal(normalizeImageMime('image/webp'), 'image/webp');
  assert.equal(normalizeImageMime('text/html'), 'image/jpeg');
  assert.equal(normalizeImageMime('image/png;base64,x'), 'image/jpeg');
});

test('validatePublicUrl refuses URLs that carry credentials', async () => {
  await assert.rejects(validatePublicUrl('http://user:pass@example.com/article'), /credentials/i);
  await assert.rejects(validatePublicUrl('file:///etc/passwd'), /protocol/i);
});

test('extract-url never fetches a redirect target that points into a private network', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(null, {
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' }
    });
  };

  try {
    const res = mockRes();
    await extractUrlHandler({
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.30' },
      body: { url: 'http://93.184.216.34/article' }
    }, res);

    assert.equal(calls.length, 1, 'the private redirect target must never be requested');
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /private|reserved/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('study-pack refuses malformed tokens and oversized titles before touching the database', async () => {
  let res = mockRes();
  await studyPackHandler({
    method: 'GET',
    headers: { 'x-forwarded-for': '203.0.113.41' },
    query: { token: '../../etc/passwd' }
  }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /token/i);

  res = mockRes();
  await studyPackHandler({
    method: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.42' },
    body: { doc_title: 'x'.repeat(400), payload: { pages: [['Hello']] } }
  }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /doc_title/);

  res = mockRes();
  await studyPackHandler({
    method: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.43' },
    body: { doc_title: 'Empty', payload: { pages: [] } }
  }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /pages/);
});

test('plan and pack lookups use own properties, not inherited ones', async () => {
  // Object.prototype is reachable through a plain object literal; a body value like "__proto__"
  // must not resolve to it and be treated as a real pack.
  assert.equal(Object.hasOwn(REFILL_PACKS, '__proto__'), false);
  const paystackInit = fs.readFileSync('api/paystack-init.js', 'utf8');
  const webhook = fs.readFileSync('api/paystack-webhook.js', 'utf8');
  assert.match(paystackInit, /Object\.hasOwn\(REFILL_PACKS, requestedPack\)/);
  assert.match(webhook, /Object\.hasOwn\(REFILL_PACKS, packId\)/);
});

test('Study Pack RLS lockdown revokes the browser key and drops the blanket policies', () => {
  const sql = fs.readFileSync('supabase/migrations/20261127_study_packs_lockdown.sql', 'utf8');
  assert.match(sql, /drop policy if exists "Allow public read of study packs by share token"/i);
  assert.match(sql, /drop policy if exists "Allow insert of study packs"/i);
  assert.match(sql, /revoke all on table public\.study_packs from public, anon, authenticated/i);
});

test('the webhook source allowlist accepts a real delivery and still refuses a stranger', async () => {
  // The allowlist sits behind the HMAC, so a genuine delivery it refuses is a paid account that never
  // gets credited. These are the shapes a correct delivery and config actually take: the edge writes
  // its trusted header as "client, proxy", and an operator writes the configured entries with padding
  // or in whatever IPv6 form they copied.
  const savedSecret = process.env.PAYSTACK_SECRET_KEY;
  const savedAllowed = process.env.PAYSTACK_WEBHOOK_ALLOWED_IPS;
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_webhook';

  const payload = JSON.stringify({
    event: 'charge.success',
    data: {
      status: 'success',
      amount: 5000, // wrong for the plan it claims, so an accepted delivery stops at a 200 "Ignored"
      currency: 'NGN',
      reference: 'ref_allowlist_test',
      paid_at: '2026-11-27T10:00:00Z',
      metadata: { user_id: 'user-1', plan: 'studio_yearly' }
    }
  });
  const signature = crypto.createHmac('sha512', 'sk_test_webhook').update(payload).digest('hex');

  const deliver = async (headers) => {
    const res = mockRes();
    await webhookHandler(
      { method: 'POST', headers: { 'x-paystack-signature': signature, ...headers }, body: payload },
      res
    );
    return res;
  };
  // Reaching the event evaluation (a 200 about the deliberately wrong amount) means the delivery
  // passed the allowlist; a 403 means it was refused as an unknown source.
  const accepted = (res, label) => {
    assert.equal(res.statusCode, 200, `${label} must not be refused as an unknown source`);
    assert.match(res.body, /Ignored: amount/, label);
  };
  const refused = (res, label) => assert.equal(res.statusCode, 403, label);

  try {
    accepted(await deliver({ 'x-vercel-forwarded-for': '52.31.139.75, 10.0.0.7' }), 'platform header list');
    accepted(await deliver({ 'x-forwarded-for': '1.2.3.4, 52.31.139.75' }), 'x-forwarded-for list');

    // A dual-stack listener can report an IPv4 client as an IPv4-mapped IPv6 address, in either
    // spelling (dotted, or the same bytes as two hex groups). It is the same Paystack address.
    accepted(await deliver({ 'cf-connecting-ip': '::ffff:52.31.139.75' }), 'IPv4-mapped IPv6 source');
    accepted(await deliver({ 'cf-connecting-ip': '::ffff:341f:8b4b' }), 'hex IPv4-mapped IPv6 source');
    refused(await deliver({ 'cf-connecting-ip': '::ffff:203.0.113.5' }), 'a mapped non-Paystack address');

    process.env.PAYSTACK_WEBHOOK_ALLOWED_IPS = '  198.51.100.9 , 2001:0DB8::0001  ';
    accepted(await deliver({ 'cf-connecting-ip': '198.51.100.9, 10.0.0.7' }), 'padded IPv4 entry');
    accepted(await deliver({ 'cf-connecting-ip': '2001:db8::1, 10.0.0.7' }), 'equivalent IPv6 form');

    // Neighbouring addresses on the same list are still strangers.
    refused(await deliver({ 'cf-connecting-ip': '10.0.0.7' }), 'the proxy hop');
    refused(await deliver({ 'cf-connecting-ip': '2001:db8::3' }), 'an unconfigured IPv6 address');
    refused(await deliver({ 'cf-connecting-ip': '198.51.100.90' }), 'an unconfigured IPv4 address');

    process.env.PAYSTACK_WEBHOOK_ALLOWED_IPS = '[2001:db8::2]:443';
    accepted(await deliver({ 'x-real-ip': '2001:db8::2' }), 'bracketed IPv6 entry');
    refused(await deliver({ 'x-forwarded-for': 'not-an-ip' }), 'an unparseable source address');
  } finally {
    if (savedSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = savedSecret;
    if (savedAllowed === undefined) delete process.env.PAYSTACK_WEBHOOK_ALLOWED_IPS;
    else process.env.PAYSTACK_WEBHOOK_ALLOWED_IPS = savedAllowed;
  }
});

test('the vision tier exists so page scans are throttled', () => {
  assert.ok(TIERS.vision);
  assert.equal(TIERS.vision.user.limit, 20);
  assert.equal(TIERS.vision.ip.limit, 40);
});
