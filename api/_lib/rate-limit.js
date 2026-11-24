// api/_lib/rate-limit.js
//
// Distributed, server-side rate limiting shared by every sensitive Vercel function.
//
// Why this exists: throttling in app.js is UX only — anyone can POST to an endpoint directly.
// The counters therefore live in Postgres (the Supabase project this app already uses), not in a
// module-level Map, because a Vercel function runs as many independent instances and an in-memory
// counter would give every instance its own allowance. There is no second vendor: the table and the
// three functions it calls are in supabase/migrations/20261120_rate_limit_counters.sql, which also
// revokes them from anon/authenticated so the browser's key cannot read or forge a counter.
//
// Two kinds of key are used per request, and a request must pass BOTH:
//   - an identity key (user id, normalized email, BYOK key fingerprint) so one abusive account
//     cannot hide behind a shared IP, and
//   - an ip key, so one person cannot rotate accounts to get a fresh allowance.
// Universities and mobile carriers put thousands of readers behind a single CGNAT address, which
// is why the ip ceilings are deliberately looser than the identity ceilings.
//
// Repeated violations escalate: 1-2 -> 5s, 3-4 -> 60s, 5+ -> a 15 minute lockout that also asks
// the frontend to render a CAPTCHA before the next attempt, and keeps moving while the abuse
// continues. A successful, within-limit request clears the violation streak, so the escalation
// only tracks *consecutive* abuse.
//
// A counter store that cannot be reached is a policy decision per tier:
//   - content tiers (tts, summarize, webhook) fail open and log, because a reader losing a
//     narration is worse than an unthrottled minute, and the work is billed per call anyway;
//   - auth_sensitive fails closed with 503 RATE_LIMIT_UNAVAILABLE, because sign-in is the one
//     endpoint where "no limit" means "unlimited password guesses". Sign-in staying down while the
//     store is broken is the safe direction for that trade.
import crypto from 'crypto';
import { supabaseConfig } from './supabase.js';

export const TIERS = {
  // 15 narrated sentences a minute is far above normal reading (one sentence lasts several
  // seconds) but stops a script from pulling the whole book through the paid voice.
  tts: {
    user: { limit: 15, windowSeconds: 60 },
    ip: { limit: 60, windowSeconds: 60 },
    byok: { limit: 60, windowSeconds: 60 }
  },
  summarize: {
    user: { limit: 5, windowSeconds: 60 },
    ip: { limit: 20, windowSeconds: 60 },
    byok: { limit: 20, windowSeconds: 60 }
  },
  // Login, signup and password reset. The email ceiling is the real protection against
  // credential stuffing; the ip ceiling is loose enough for a campus NAT.
  auth_sensitive: {
    email: { limit: 5, windowSeconds: 15 * 60 },
    ip: { limit: 15, windowSeconds: 15 * 60 }
  },
  // Paystack can legitimately burst after a sale; this is a flood ceiling, not a business limit.
  webhook: {
    ip: { limit: 200, windowSeconds: 60 }
  },
  // Web article URL extraction: 15 requests per minute per IP
  extract_url: {
    ip: { limit: 15, windowSeconds: 60 }
  },
  // Shareable read-only Study Packs: 15 requests per minute per IP
  study_pack: {
    ip: { limit: 15, windowSeconds: 60 }
  }
};

const VIOLATION_TTL_SECONDS = 60 * 60;
const LOCKOUT_TTL_SECONDS = 15 * 60;
const LOCKOUT_THRESHOLD = 5;
const KEY_PREFIX = 'marginalia';

// A hung counter store must not hold a request open: the function gives up and applies the tier's
// fail-open/fail-closed policy instead of waiting for the platform timeout.
const STORE_TIMEOUT_MS = 2500;

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
 * log, a counter key or an error message.
 */
export function keyFingerprint(secret) {
  const raw = String(secret || '').trim();
  if (!raw) return '';
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

// The browser's key must never be able to write a counter, so the limiter needs the service-role
// key. supabaseConfig() resolves the project URL the same way every other route does.
function storeConfig() {
  const { url, key, hasServiceKey } = supabaseConfig();
  if (!url || !key || !hasServiceKey) return null;
  return { url, key };
}

async function callStore(store, fn, args) {
  const response = await fetch(`${store.url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: store.key,
      Authorization: `Bearer ${store.key}`
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(STORE_TIMEOUT_MS)
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`${fn} returned ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function windowKey(tier, bucket, value) {
  return `${KEY_PREFIX}:rl:${tier}:${bucket}:${value}`;
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
 * Bump counters; returns a Map from key to { hit_count, seconds_left }.
 *
 * Each bump is `{ key, window_seconds }` — snake_case because rate_limit_hit() reads these names
 * out of the JSON with jsonb_to_recordset, and a misspelt field would silently count nothing.
 */
async function bump(store, bumps) {
  const rows = await callStore(store, 'rate_limit_hit', { p_bumps: bumps });
  return new Map((rows || []).map((row) => [row.counter_key, row]));
}

/** Seconds left for each key that has not expired; keys absent from the Map are free. */
async function expiriesFor(store, keys) {
  if (!keys.length) return new Map();
  const rows = await callStore(store, 'rate_limit_ttl', { p_keys: keys });
  return new Map((rows || []).map((row) => [row.counter_key, Number(row.seconds_left) || 0]));
}

async function clearKeys(store, keys) {
  if (!keys.length) return;
  await callStore(store, 'rate_limit_clear', { p_keys: keys });
}

/**
 * The store is missing, unreachable or erroring. Content tiers continue without a window; the auth
 * tier refuses rather than accept unlimited password guesses.
 */
function storeUnavailable(res, { tier, failClosed, reason }) {
  console.error(
    `[rate-limit] The "${tier}" tier could not use its counter store: ${reason}. ` +
    (failClosed ? 'Refusing the request (fail-closed).' : 'Allowing it (fail-open).')
  );
  if (!failClosed) return { ok: true, headers: {} };
  res.status(503).json({ error: 'RATE_LIMIT_UNAVAILABLE' });
  return { ok: false, retryAfter: 30 };
}

/**
 * Enforce the tier's limits for every supplied identifier.
 *
 * Callers pass the identities this request carries, e.g.
 *   [{ bucket: 'user', value: user.id }, { bucket: 'ip', value: clientIp(req) }]
 *
 * Returns { ok: true, headers } when the request may continue, or { ok: false } after having
 * written a 429 — or a 503 when failClosed and the counter store is unavailable.
 *
 * @param {object} req
 * @param {object} res
 * @param {{tier: string, identifiers: Array<{bucket: string, value: string}>, failClosed?: boolean}} options
 */
export async function enforceRateLimit(req, res, { tier, identifiers = [], failClosed = false }) {
  const tierSpec = TIERS[tier];
  if (!tierSpec) throw new Error(`Unknown rate-limit tier "${tier}"`);

  const store = storeConfig();
  if (!store) {
    return storeUnavailable(res, {
      tier,
      failClosed,
      reason: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set in this deployment'
    });
  }

  // Only keep identifiers the tier actually defines, and never rate limit on an empty value.
  const checks = identifiers
    .filter((entry) => entry && tierSpec[entry.bucket] && String(entry.value || '').trim() !== '')
    .map((entry) => ({ bucket: entry.bucket, value: String(entry.value).trim() }));

  if (checks.length === 0) checks.push({ bucket: 'ip', value: clientIp(req) });

  const entries = checks.map(({ bucket, value }) => ({
    key: windowKey(tier, bucket, value),
    limit: tierSpec[bucket].limit,
    windowSeconds: tierSpec[bucket].windowSeconds
  }));

  try {
    // One round trip covers both lockout state and whether an abuse streak exists to clear later.
    const expiries = await expiriesFor(store, [
      ...entries.map((entry) => lockoutKey(entry.key)),
      ...entries.map((entry) => violationKey(entry.key))
    ]);

    // An active lockout wins before any window counter is touched, and continued attempts keep
    // pushing it forward so a client that ignores Retry-After does not walk out of it.
    for (const entry of entries) {
      const lockedFor = expiries.get(lockoutKey(entry.key)) || 0;
      if (lockedFor <= 0) continue;

      const streakKey = violationKey(entry.key);
      const streak = await bump(store, [{ key: streakKey, window_seconds: VIOLATION_TTL_SECONDS }]);
      if ((Number(streak.get(streakKey)?.hit_count) || 0) >= LOCKOUT_THRESHOLD) {
        await bump(store, [{ key: lockoutKey(entry.key), window_seconds: LOCKOUT_TTL_SECONDS }]);
      }

      refuse(res, { retryAfter: lockedFor, locked: true });
      return { ok: false, retryAfter: lockedFor, locked: true };
    }

    // Every identifier is counted for this request, including a request that turns out to be over
    // the line: a refused attempt still spends its IP allowance, which is what the ip ceiling is for.
    const counts = await bump(
      store,
      entries.map((entry) => ({ key: entry.key, window_seconds: entry.windowSeconds }))
    );

    let tightest = null;
    let blocked = null;

    for (const entry of entries) {
      const row = counts.get(entry.key);
      const count = Number(row && row.hit_count);
      if (!row || !Number.isFinite(count)) continue; // unexpected empty result: treat as not limiting

      const secondsLeft = Number(row.seconds_left) || entry.windowSeconds;

      if (count > entry.limit) {
        blocked = { entry, secondsLeft };
        break;
      }

      // Keep the most constrained identifier so the headers describe the binding limit.
      const remaining = entry.limit - count;
      if (!tightest || remaining < tightest.remaining) {
        tightest = { limit: entry.limit, remaining, reset: Date.now() + secondsLeft * 1000 };
      }
    }

    if (blocked) {
      const streakKey = violationKey(blocked.entry.key);
      const streak = await bump(store, [{ key: streakKey, window_seconds: VIOLATION_TTL_SECONDS }]);
      const violations = Number(streak.get(streakKey)?.hit_count) || 1;
      const locked = violations >= LOCKOUT_THRESHOLD;

      if (locked) {
        await bump(store, [{ key: lockoutKey(blocked.entry.key), window_seconds: LOCKOUT_TTL_SECONDS }]);
      }

      const retryAfter = locked ? LOCKOUT_TTL_SECONDS : retryAfterFor(violations);
      refuse(res, {
        retryAfter,
        locked,
        limit: blocked.entry.limit,
        reset: Date.now() + blocked.secondsLeft * 1000
      });
      return { ok: false, retryAfter, locked };
    }

    // A normal request breaks the abuse streak, so the escalation only tracks consecutive abuse.
    const staleStreaks = entries
      .map((entry) => violationKey(entry.key))
      .filter((key) => (expiries.get(key) || 0) > 0);
    await clearKeys(store, staleStreaks);

    const headers = tightest || { limit: 0, remaining: 0, reset: Date.now() };
    writeRateHeaders(res, headers);
    return { ok: true, headers };
  } catch (err) {
    return storeUnavailable(res, { tier, failClosed, reason: err.message });
  }
}
