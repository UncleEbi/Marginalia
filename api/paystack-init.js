// api/paystack-init.js
//
// Pro checkout. The SERVER owns every price: the request may only name a plan, never an amount.
//
//   GET  -> 200 { currency, default_plan, plans: [{ id, label, note, days, amount_kobo, amount_display }] }
//           No auth: the paywall uses it to show prices.
//   POST -> 200 { authorization_url, plan, amount_kobo, currency, days }
//           headers: Authorization (Supabase session, required)
//           body:    { plan?: string } — an unknown plan name is rejected; omitted uses the default
//           email and user_id come from the verified session token, never from the body.
import { createClient } from '@supabase/supabase-js';
import { PRO_CURRENCY, PRO_PLANS, DEFAULT_PLAN_ID, getPlan, proPriceDisplay } from '../lib/pro-plan.js';

function planList() {
  return PRO_PLANS.map((p) => ({
    id: p.id,
    label: p.label,
    note: p.note,
    days: p.days,
    amount_kobo: p.amountKobo,
    amount_display: proPriceDisplay(p.amountKobo)
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
  if (req.method === 'GET') {
    // Price display for the UI. Works without Paystack configured so the paywall can still be read.
    return res.status(200).json({
      currency: PRO_CURRENCY,
      default_plan: DEFAULT_PLAN_ID,
      plans: planList()
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
        amount: plan.amountKobo, // server-owned; from lib/pro-plan.js (env-overridable)
        currency: PRO_CURRENCY,
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
      amount_kobo: plan.amountKobo,
      currency: PRO_CURRENCY
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unable to start checkout.' });
  }
}
