import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const secret = process.env.PAYSTACK_SECRET_KEY;
  const hash = crypto
    .createHmac('sha512', secret)
    .update(JSON.stringify(req.body))
    .digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    return res.status(401).send('Invalid webhook signature');
  }

  const event = req.body;

  if (event.event === 'charge.success') {
    const userId = event.data.metadata?.user_id;

    if (userId) {
      const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
      );

      // Upgrade tier and top up quota balance
      await supabase
        .from('profiles')
        .update({
          tier: 'pro',
          summary_credits_remaining: 9999,
          neural_chars_remaining: 1000000
        })
        .eq('id', userId);
    }
  }

  return res.status(200).send('Webhook processed');
}