// api/paystack-init.js
//
// Checkout. The SERVER owns every price and the currency: a request may only name a plan — an
// amount or a currency in the body is ignored, so nobody can select the cheaper market by hand.
// The currency comes from the visitor's country (Vercel's geo header), which means a Nigerian is
// offered the naira table and everyone else the dollar table, never both at once.
//
//   GET  -> 200 { currency, country, default_plan, usd_rate, plans: [{ id, tier, tier_label, label,
//           note, days, amount, amount_display, amount_usd_display, summary_credits, neural_chars }] }
//           No auth: the paywall uses it to show prices.
//   POST -> 200 { authorization_url, plan, amount, currency, days }
//           headers: Authorization (Supabase session, required)
//           body:    { plan?: string } — an unknown plan name is rejected; omitted uses the default
//           email and user_id come from the verified session token, never from the body.
import { createClient } from '@supabase/supabase-js';
import {
  PRO_PLANS, DEFAULT_PLAN_ID, getPlan, planAmount, planTierLabel, proPriceDisplay,
  proUsdEquivalentDisplay, NGN_PER_USD, currencyForCountry
} from '../lib/pro-plan.js';

// Vercel sets x-vercel-ip-country on every request; Cloudflare's cf-ipcountry is the fallback in
// case this ever runs behind it. No header means no usable country, and lib/pro-plan.js then
// falls back to the home market.
function countryFromRequest(req) {
  const headers = req.headers || {};
  return String(headers['x-vercel-ip-country'] || headers['cf-ipcountry'] || '').trim().toUpperCase();
}

function planList(currency) {
  return PRO_PLANS.map((p) => {
    const amount = planAmount(p, currency);
    return {
      id: p.id,
      // Which tier this row buys and what it grants for the whole term, so the paywall can say
      // what the money gets without duplicating the allowances in the client.
      tier: p.tier,
      // Named for this market: "Student Pass" in Nigeria, "Reader" on the dollar table.
      tier_label: planTierLabel(p, currency),
      label: p.label,
      note: p.note,
      days: p.days,
      summary_credits: p.summaryCredits,
      neural_chars: p.neuralChars,
      amount,
      amount_display: proPriceDisplay(amount, currency),
      // Only a naira price needs the dollars-beside-it estimate; a dollar price is already dollars.
      amount_usd_display: currency === 'USD' ? null : (proUsdEquivalentDisplay(amount) || null)
    };
  });
}

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
  // The same detection on GET and POST, so the price shown is the price charged.
  const country = countryFromRequest(req);
  const currency = currencyForCountry(country);
  if (!country) {
    // Local dev has no geo headers (expected). In production this means the deployment is behind a
    // proxy or the header was stripped — and then everyone is quietly charged the home-market
    // price, so say it out loud instead of letting it pass as normal.
    console.warn('paystack-init: no geo country header, falling back to ' + currency + '.');
  }

  if (req.method === 'GET') {
    // Price display for the UI. Works without Paystack configured so the paywall can still be read.
    return res.status(200).json({
      currency,
      country: country || null,
      default_plan: DEFAULT_PLAN_ID,
      usd_rate: NGN_PER_USD, // the rate the amount_usd_display estimates use
      plans: planList(currency)
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

  const requestedPlan = req.body?.plan;
  if (requestedPlan != null && !getPlan(requestedPlan)) {
    return res.status(400).json({ error: `Unknown plan: ${String(requestedPlan).slice(0, 40)}` });
  }
  const plan = getPlan(requestedPlan) || getPlan(DEFAULT_PLAN_ID);

  const amount = planAmount(plan, currency);
  if (amount == null) {
    return res.status(500).json({ error: `${plan.id} has no ${currency} price.` });
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
        amount, // server-owned: the plan's price in this market, from lib/pro-plan.js
        currency,
        ...(req.headers.origin ? { callback_url: `${req.headers.origin}/` } : {}),
        metadata: {
          user_id: user.id,
          plan: plan.id
        }
      })
    });

    const data = await paystackRes.json().catch(() => null);
    if (!paystackRes.ok || !data?.status) {
      throw new Error(data?.message || `Paystack error ${paystackRes.status}`);
    }

    return res.status(200).json({
      authorization_url: data.data.authorization_url,
      plan: plan.id,
      days: plan.days,
      amount,
      currency
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unable to start checkout.' });
  }
}
