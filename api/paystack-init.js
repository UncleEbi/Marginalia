export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, userId, plan = 'pro_monthly' } = req.body || {};
  const secretKey = process.env.PAYSTACK_SECRET_KEY;

  if (!secretKey) {
    return res.status(500).json({ error: 'PAYSTACK_SECRET_KEY is not configured in Vercel.' });
  }

  try {
    const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email,
        amount: 1000000, // ₦10,000.00 in kobo (or equivalent in USD cents)
        callback_url: `${req.headers.origin}/`,
        metadata: {
          user_id: userId,
          plan: plan
        }
      })
    });

    const data = await paystackRes.json();
    if (!data.status) throw new Error(data.message || 'Payment initiation failed.');

    return res.status(200).json({ authorization_url: data.data.authorization_url });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}