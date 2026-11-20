// api/_lib/rate-limit.js
//
// Distributed, server-side rate limiting shared by every sensitive Vercel function.
//
// Why this exists: throttling in app.js is UX only — anyone can POST to an endpoint directly.
// The counters therefore live in Upstash Redis, not in a module-level Map, because a Vercel
// serverless function runs as many independent instances and an in-memory counter would give
// every instance its own allowance.
//
// Two kinds of key are used per request, and a request must pass BOTH:
//   - an identity key (user id, normalized email, BYOK key fingerprint) so one abusive account
//     cannot hide behind a shared IP, and
//   - an ip key, so one person cannot rotate accounts to get a fresh allowance.
// Universities and mobile carriers put thousands of readers behind a single CGNAT address, which
// is why the ip ceilings are deliberately looser than the identity ceilings.
//
// Repeated violations escalate: 1-2 -> 5s, 3-4 -> 60s, 5+ -> a 15 minute lockout that also asks
// the frontend to render a CAPTCHA before the next attempt. A successful, within-limit request
// clears the violation streak, so the escalation only tracks *consecutive* abuse.
import crypto from 'crypto';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

export const TIERS = {
  // 15 narrated sentences a minute is far above normal reading (one sentence lasts several
  // seconds) but stops a script from pulling the whole book through the paid voice.
  tts: {
    user: { limit: 15, window: '1 m' },
    ip: { limit: 60, window: '1 m' },
    byok: { limit: 60, window: '1 m' }
  },
  summarize: {
    user: { limit: 5, window: '1 m' },
    ip: { limit: 20, window: '1 m' },
    byok: { limit: 20, window: '1 m' }
  },
  // Login, signup and password reset. The email ceiling is the real protection against
  // credential stuffing; the ip ceiling is loose enough for a campus NAT.
  auth_sensitive: {
    email: { limit: 5, window: '15 m' },
    ip: { limit: 15, window: '15 m' }
  },
  geo: {
    ip: { limit: 30, window: '1 m' }
  },
  // Paystack can legitimately burst after a sale; this is a flood ceiling, not a business limit.
  webhook: {
    ip: { limit: 200, window: '1 m' }
  }
};

const VIOLATION_TTL_SECONDS = 60 * 60;
const LOCKOUT_TTL_SECONDS = 15 * 60;
const LOCKOUT_THRESHOLD = 5;
const KEY_PREFIX = 'marginalia';

// Holds only stateless client/limiter configuration, never counters.
const cache = Object.create(null);

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  if (!cache.__redis) cache.__redis = new Redis({ url, token });
  return cache.__redis;
}

function limiterFor(tier, bucket) {
  const id = `${tier}:${bucket}`;
  if (cache[id]) return cache[id];
  const config = TIERS[tier][bucket];
  const ratelimit = new Ratelimit({
    redis: getRedis(),
    limiter: Ratelimit.slidingWindow(config.limit, config.window),
    prefix: `${KEY_PREFIX}:rl:${tier}:${bucket}`
  });
  cache[id] = ratelimit;
  return ratelimit;
}

/**
 * The caller's address. Vercel sets x-forwarded-for; the others are fallbacks for other proxies.
 */
export function clientIp(req) {
  const headers = (req && req.headers) || {};
  const forwarded = headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : String(forwarded || '').split(',')[0];
  const candidate = first || headers['x-real-ip'] || headers['cf-connecting-ip'] ||
    headers['x-vercel-forwarded-for'] || '';
  const ip = String(candidate).trim();
  return ip || 'unknown';
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * A stable, non-reversible fingerprint for a BYOK provider key. The raw key must never reach a
 * log, a Redis key or an error message.
 */
export function keyFingerprint(secret) {
  const raw = String(secret || '').trim();
  if (!raw) return '';
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function violationKey(key) {
  return `${KEY_PREFIX}:violations:${key}`;
}

function lockoutKey(key) {
  return `${KEY_PREFIX}:lockout:${key}`;
}

function retryAfterFor(violations) {
  if (violations >= LOCKOUT_THRESHOLD) return LOCKOUT_TTL_SECONDS;
  if (violations >= 3) return 60;
  return 5;
}

function writeRateHeaders(res, { limit, remaining, reset }) {
  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, remaining)));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(reset / 1000)));
}

function refuse(res, { retryAfter, locked, limit, reset }) {
  res.setHeader('Retry-After', String(retryAfter));
  if (limit != null) writeRateHeaders(res, { limit, remaining: 0, reset });
  return res.status(429).json({
    error: locked ? 'TEMP_LOCKOUT' : 'RATE_LIMITED',
    retryAfter,
    requireCaptcha: locked
  });
}

/**
 * Count one violation for a key and escalate it. Returns the new consecutive violation count.
 */
async function recordViolation(redis, key) {
  const vKey = violationKey(key);
  const count = await redis.incr(vKey);
  if (count === 1) await redis.expire(vKey, VIOLATION_TTL_SECONDS);
  if (count >= LOCKOUT_THRESHOLD) {
    await redis.set(lockoutKey(key), '1', { ex: LOCKOUT_TTL_SECONDS });
  }
  return count;
}

/**
 * Enforce the tier's limits for every supplied identifier.
 *
 * Callers pass the identities this request carries, e.g.
 *   [{ bucket: 'user', value: user.id }, { bucket: 'ip', value: clientIp(req) }]
 *
 * Returns { ok: true, headers } when the request may continue, or { ok: false } after having
 * written a 429 (or a 503 when failClosed and Upstash is not configured).
 *
 * @param {object} req
 * @param {object} res
 * @param {{tier: string, identifiers: Array<{bucket: string, value: string}>, failClosed?: boolean}} options
 */
export async function enforceRateLimit(req, res, { tier, identifiers = [], failClosed = false }) {
  const tierSpec = TIERS[tier];
  if (!tierSpec) throw new Error(`Unknown rate-limit tier "${tier}"`);

  const redis = getRedis();
  if (!redis) {
    console.error(
      `[rate-limit] Upstash is not configured, so the "${tier}" tier cannot be enforced. ` +
      'Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in the deployment environment.'
    );
    if (failClosed) {
      res.status(503).json({ error: 'RATE_LIMIT_UNAVAILABLE' });
      return { ok: false, retryAfter: 30 };
    }
    return { ok: true, headers: {} };
  }

  // Only keep identifiers the tier actually defines, and never rate limit on an empty value.
  const checks = identifiers
    .filter((entry) => entry && tierSpec[entry.bucket] && String(entry.value || '').trim() !== '')
    .map((entry) => ({ bucket: entry.bucket, value: String(entry.value).trim() }));

  if (checks.length === 0) checks.push({ bucket: 'ip', value: clientIp(req) });

  let tightest = null;

  for (const { bucket, value } of checks) {
    const key = `${tier}:${bucket}:${value}`;

    // An active lockout wins before any counter is touched.
    const lockedFor = await redis.ttl(lockoutKey(key));
    if (lockedFor > 0) {
      await recordViolation(redis, key);
      refuse(res, { retryAfter: lockedFor, locked: true });
      return { ok: false, retryAfter: lockedFor, locked: true };
    }

    const { success, limit, remaining, reset } = await limiterFor(tier, bucket).limit(key);

    if (!success) {
      const violations = await recordViolation(redis, key);
      const retryAfter = retryAfterFor(violations);
      const locked = violations >= LOCKOUT_THRESHOLD;
      refuse(res, { retryAfter, locked, limit, reset });
      return { ok: false, retryAfter, locked };
    }

    // Keep the most constrained identifier so the headers describe the binding limit.
    if (!tightest || remaining < tightest.remaining) {
      tightest = { limit, remaining, reset };
    }

    // A normal request breaks the abuse streak.
    await redis.del(violationKey(key));
  }

  const headers = tightest || { limit: 0, remaining: 0, reset: Date.now() };
  writeRateHeaders(res, headers);
  return { ok: true, headers };
}
