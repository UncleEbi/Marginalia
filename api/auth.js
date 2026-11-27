// api/auth.js
//
// Server-side gate for the three Supabase Auth actions the app performs: sign in, sign up and
// password reset.
//
// Supabase Auth is called straight from the browser by supabase-js, which means a login form that
// only disables its button in app.js is not protected at all — the auth endpoint can be driven
// directly with unlimited attempts. Sign-in therefore goes through this function, which applies the
// auth_sensitive rate limit (5 per email AND 15 per IP per 15 minutes), verifies a Cloudflare
// Turnstile token when one is configured, and only then reaches Supabase.
//
//   POST { action: 'signin', email, password, captchaToken }
//   POST { action: 'signup', email, password, captchaToken }
//   POST { action: 'reset',  email, captchaToken }
//   POST { action: 'update-password', accessToken, password }
//
//   200 { session: { access_token, refresh_token, expires_in, user } }  (signin/signup)
//   200 { ok: true }                                                    (reset/update-password)
//   400 { error, requireCaptcha? } | 401 { error } | 429 (rate limited) | 500 | 502 | 503
import { enforceRateLimit, clientIp, normalizeEmail } from './_lib/rate-limit.js';
import { supabaseAnonConfig } from './_lib/supabase.js';

const ACTIONS = new Set(['signin', 'signup', 'reset', 'update-password']);

async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  // No secret configured (local development, or Turnstile not set up yet): nothing to verify.
  if (!secret) return { ok: true, skipped: true };

  const missing = !token || typeof token !== 'string' || !token.trim();
  if (missing) return { ok: false, reason: 'missing' };

  try {
    const body = new URLSearchParams({ secret, response: token.trim() });
    if (ip && ip !== 'unknown') body.set('remoteip', ip);
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const data = await response.json().catch(() => null);
    return { ok: Boolean(data && data.success), reason: data && data.success ? null : 'failed' };
  } catch (err) {
    // Cloudflare unreachable: fail closed for auth rather than letting the attempt through.
    console.error('Turnstile verification failed:', err.message);
    return { ok: false, reason: 'unavailable' };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const action = String(body.action || '').trim();
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  const captchaToken = body.captchaToken || body['cf-turnstile-response'] || '';
  // A recovery link already carries the session Supabase emailed to the account, so this action is
  // authenticated by that token rather than by an email and password pair.
  const accessToken = typeof body.accessToken === 'string' ? body.accessToken.trim() : '';
  const isPasswordUpdate = action === 'update-password';

  if (!ACTIONS.has(action)) {
    return res.status(400).json({ error: 'Unsupported auth action.' });
  }
  // Length ceilings on everything that becomes a rate-limit key, a hash input or a bearer token.
  // An unbounded string is a free way to make the hasher and the counter store do work on the
  // server's behalf, and a 254-character maximum is how long an address that can receive mail is.
  if (!isPasswordUpdate && (!email || !email.includes('@') || email.length > 254)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (action !== 'reset' && !password) {
    return res.status(400).json({ error: 'Enter your password.' });
  }
  if (password.length > 200) {
    return res.status(400).json({ error: 'That password is too long (200 characters maximum).' });
  }
  if (isPasswordUpdate && (!accessToken || accessToken.length > 4096)) {
    return res.status(400).json({ error: 'This reset link is missing its session. Request a new one.' });
  }

  const ip = clientIp(req);

  // Rate limits first: a brute-force attempt must not cost a Turnstile round trip or a Supabase call.
  // failClosed: if the counters cannot be read, the endpoint refuses (503) instead of accepting
  // unlimited password guesses. The counters now live in the same Postgres project as everything
  // else, so this is a genuine outage rather than a missing third-party add-on.
  const gate = await enforceRateLimit(req, res, {
    tier: 'auth_sensitive',
    // The update carries no email: nobody can guess an address here, and the recovery token is
    // already scoped to one account. The ip window still applies.
    identifiers: isPasswordUpdate
      ? [{ bucket: 'ip', value: ip }]
      : [{ bucket: 'email', value: email }, { bucket: 'ip', value: ip }],
    failClosed: true
  });
  if (!gate.ok) return;

  // No Turnstile on the update: the caller already holds the recovery session emailed to the
  // account, which is stronger proof of ownership than a challenge, and the reset screen does not
  // render the widget.
  const captcha = isPasswordUpdate ? { ok: true } : await verifyTurnstile(captchaToken, ip);
  if (!captcha.ok) {
    return res.status(400).json({
      error: captcha.reason === 'missing'
        ? 'Please complete the verification challenge.'
        : 'Verification failed. Please try again.',
      requireCaptcha: true
    });
  }

  const { url, key } = supabaseAnonConfig();
  if (!url || !key) {
    return res.status(500).json({ error: 'Backend error: Supabase URL or key is not configured.' });
  }

  const endpoints = {
    signin: { path: '/auth/v1/token?grant_type=password', payload: { email, password } },
    signup: { path: '/auth/v1/signup', payload: { email, password } },
    reset: { path: '/auth/v1/recover', payload: { email } },
    // GoTrue only lets a session change its own password, so this one is the only endpoint that
    // sends the reader's recovery token as the bearer instead of the anon key.
    'update-password': { path: '/auth/v1/user', method: 'PUT', bearer: accessToken, payload: { password } }
  };
  const { path, payload, method = 'POST', bearer = key } = endpoints[action];

  try {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${bearer}`
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = data.msg || data.error_description || data.error || 'Authentication failed.';
      // Invalid credentials are expected noise, not a server error.
      const status = response.status === 400 || response.status === 401 ? 401 : response.status;
      return res.status(status).json({ error: message });
    }

    res.setHeader('Cache-Control', 'no-store');

    if (action === 'reset' || isPasswordUpdate) return res.status(200).json({ ok: true });

    const session = data.session || data;
    if (!session || !session.access_token) {
      // Signup with email confirmation on: no session yet, which the UI explains.
      return res.status(200).json({ needsEmailConfirmation: true });
    }

    return res.status(200).json({
      session: {
        access_token: session.access_token,
        refresh_token: session.refresh_token || null,
        expires_in: session.expires_in || null,
        user: session.user || null
      }
    });
  } catch (err) {
    console.error('Auth proxy error:', err.message);
    return res.status(502).json({ error: 'Could not reach the sign-in service. Please try again.' });
  }
}
