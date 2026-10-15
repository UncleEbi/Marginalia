// api/paystack-init.js
//
// Pro checkout. The SERVER owns the price and plan: the request body can never choose an amount.
// (The old version ignored the client's amount anyway — which is how the app ended up charging
// ₦10,000 while the UI advertised other prices.)
//
//   GET  -> 200 { currency, amount_kobo, amount_display, interval, plan }   no auth, for price labels
//   POST -> 200 { authorization_url }   headers: Authorization (Supabase session, required)
//            email and user_id are taken from the verified session token, never from the body.
import { createClient } from '@supabase/supabase-js';
import {
  PRO_PLAN, PRO_CURRENCY, PRO_AMOUNT_KOBO, PRO_INTERVAL, proPriceDisplay
} from '../lib/pro-plan.js';

function supabaseConfig() {
  const rawUrl = process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || '';
  let url = '';
  try {
    if (rawUrl) url = new URL(rawUrl.trim()).origin; // root origin only
  } catch (e) {
    url = rawUrl.replace(/\/+$/, '');
  }
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const key = serviceKey || process.env.SUPABASE_ANON_KEY || '';
  return { url, key };
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    // Price display for the UI. Works without Paystack configured so the buttons can show a
    // price even when checkout itself is misconfigured.
    return res.status(200).json({
      currency: PRO_CURRENCY,
      amount_kobo: PRO_AMOUNT_KOBO,
      amount_display: proPriceDisplay(),
      interval: PRO_INTERVAL,
      plan: PRO_PLAN
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    return res.status(500).json({ error: 'PAYSTACK_SECRET_KEY is not configured in Vercel.' });
  }

  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) {
    return res.status(401).json({ error: 'Please sign in before upgrading to Pro.' });
  }

  const { url, key } = supabaseConfig();
  if (!url || !key) {
    return res.status(500).json({ error: 'Backend error: Supabase URL or Key is not configured.' });
  }

  try {
    // Identity for the charge comes from the verified token — email/user_id in the body are ignored
    const authClient = createClient(url, key);
    const { data: authData, error: authErr } = await authClient.auth.getUser(token);
    if (authErr || !authData?.user) {
      return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
    }
    const user = authData.user;

    const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: user.email,
        amount: PRO_AMOUNT_KOBO, // server-owned; from lib/pro-plan.js (env-overridable)
        currency: PRO_CURRENCY,
        ...(req.headers.origin ? { callback_url: `${req.headers.origin}/` } : {}),
        metadata: {
          user_id: user.id,
          plan: PRO_PLAN
        }
      })
    });

    const data = await paystackRes.json().catch(() => null);
    if (!paystackRes.ok || !data?.status) {
      throw new Error(data?.message || `Paystack error ${paystackRes.status}`);
    }

    return res.status(200).json({
      authorization_url: data.data.authorization_url,
      amount_kobo: PRO_AMOUNT_KOBO,
      currency: PRO_CURRENCY
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unable to start checkout.' });
  }
}
