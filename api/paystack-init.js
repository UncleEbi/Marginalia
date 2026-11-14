// api/paystack-init.js
//
// Checkout for both subscriptions and one-time refill packs. The SERVER owns every price and the
// currency: the body may only name either a plan or a refill pack — an amount or a currency in the
// body is ignored, so nobody can select the cheaper market by hand. The currency comes from the
// visitor's country (Vercel's geo header), which means a Nigerian is offered the naira table and
// everyone else the dollar table, never both at once.
//
//   GET  -> 200 { currency, country, default_plan, usd_rate,
//                 plans: [...subscription plans...],
//                 refill_packs: [...packs for this currency...] }
//           No auth: the paywall uses it to show prices.
//   POST -> 200 { authorization_url, type, plan|pack_id, amount, currency, days|neural_chars|ai_ops }
//           headers: Authorization (Supabase session, required)
//           body:    { plan?: string, pack_id?: string }
//             - plan: a subscription plan id; omits pack_id
//             - pack_id: a refill pack id; omits plan
//             - if both are missing, defaults to the default subscription plan
//             - an unknown plan/pack is rejected
//           email and user_id come from the verified session token, never from the body.
import { createClient } from '@supabase/supabase-js';
import {
  PRO_PLANS, DEFAULT_PLAN_ID, getPlan, planAmount, planTierLabel, proPriceDisplay,
  proUsdEquivalentDisplay, NGN_PER_USD, currencyForCountry
} from '../lib/pro-plan.js';
import {
  REFILL_PACKS, refillAmountDisplay, refillPacksFor
} from '../lib/refill-plans.js';

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

function refillList(currency) {
  return refillPacksFor(currency).map((pack) => ({
    id: pack.id,
    type: 'refill',
    amount: pack.currency === 'USD' ? pack.amount_cents : pack.amount_kobo,
    currency: pack.currency,
    amount_display: refillAmountDisplay(pack),
    neural_chars: pack.neural_chars,
    ai_ops: pack.ai_ops
  }));
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
      plans: planList(currency),
      refill_packs: refillList(currency)
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
  const requestedPack = req.body?.pack_id;

  // A request can ask for either a subscription or a refill pack, not both.
  if (requestedPlan != null && requestedPack != null) {
    return res.status(400).json({ error: 'Request must name either a plan or a refill pack, not both.' });
  }

  if (requestedPack != null) {
    const pack = REFILL_PACKS[requestedPack];
    if (!pack) {
      return res.status(400).json({ error: `Unknown refill pack: ${String(requestedPack).slice(0, 40)}` });
    }
    if (pack.currency !== currency) {
      return res.status(400).json({ error: `${pack.id} is not sold in ${currency}.` });
    }

    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) {
      return res.status(401).json({ error: 'Please sign in before buying a refill pack.' });
    }

    const packAmount = pack.currency === 'USD' ? pack.amount_cents : pack.amount_kobo;

    const { url, key } = supabaseConfig();
    if (!url || !key) {
      return res.status(500).json({ error: 'Backend error: Supabase URL or Key is not configured.' });
    }

    try {
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
          amount: packAmount,
          currency,
          ...(req.headers.origin ? { callback_url: `${req.headers.origin}/` } : {}),
          metadata: {
            user_id: user.id,
            type: 'refill',
            pack_id: pack.id
          }
        })
      });

      const data = await paystackRes.json().catch(() => null);
      if (!paystackRes.ok || !data?.status) {
        throw new Error(data?.message || `Paystack error ${paystackRes.status}`);
      }

      return res.status(200).json({
        authorization_url: data.data.authorization_url,
        type: 'refill',
        pack_id: pack.id,
        amount: packAmount,
        currency,
        neural_chars: pack.neural_chars,
        ai_ops: pack.ai_ops
      });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Unable to start checkout.' });
    }
  }

  // Subscription path follows.
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
