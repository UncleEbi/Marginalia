// api/paystack-webhook.js
//
// Verifies Paystack webhooks and grants time-limited Pro.
//
//   - HMAC-SHA512 signature over the raw body, compared timing-safe
//   - event must be charge.success with status success
//   - amount, currency and plan must match the server-owned plan (lib/pro-plan.js)
//   - Pro expires (paid_at/current expiry + 30 days), it is no longer permanent
//   - retries are idempotent: a re-sent event has the same reference and paid_at, so it cannot
//     double-extend the expiry; a compare-and-swap update serialises concurrent deliveries
//   - deliberately-ignored events (wrong event type, mismatched amount, ...) are acknowledged
//     with 200 so Paystack does not retry them forever; transient failures return 500 so it does
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import {
  PRO_PLAN, PRO_CURRENCY, PRO_AMOUNT_KOBO, PRO_DURATION_DAYS,
  PRO_SUMMARY_CREDITS, PRO_NEURAL_CHARS,
  evaluateChargeEvent, nextProExpiry
} from '../lib/pro-plan.js';

// Prefer whatever raw bytes the platform preserved; otherwise re-serialise the parsed body
// (V8 keeps key order and compact formatting, which round-trips Paystack's JSON byte-for-byte
// for normal payloads).
function getRawBody(req) {
  if (typeof req.rawBody === 'string') return req.rawBody;
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body;
  return JSON.stringify(req.body ?? '');
}

// Constant-time hex comparison; unequal lengths are rejected up front (timingSafeEqual throws).
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Applies a verified charge: extends Pro (first purchase, renewal, or an identical retry),
// records the reference so the same payment is never applied twice.
async function applyProUpgrade(db, { userId, reference, paidAt }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: row, error: readErr } = await db
      .from('profiles')
      .select('tier, pro_expires_at, last_payment_reference')
      .eq('id', userId)
      .maybeSingle();

    if (readErr) {
      const missingColumn = /pro_expires_at/i.test(readErr.message || '');
      throw new Error(missingColumn
        ? 'profiles is missing the pro_expires_at column — run the SQL migration in supabase/migrations/ first.'
        : `Could not read the profile: ${readErr.message}`);
    }
    if (!row) return { applied: false, reason: 'no profile row for the paid user_id' };

    if (row.last_payment_reference === reference) {
      return { applied: true, alreadyProcessed: true, expiresAt: row.pro_expires_at };
    }

    const newExpiry = nextProExpiry(row.pro_expires_at, paidAt, PRO_DURATION_DAYS);

    // Compare-and-swap on the fields we read: if another delivery changed them first, retry.
    let q = db
      .from('profiles')
      .update({
        tier: 'pro',
        pro_expires_at: newExpiry.toISOString(),
        last_payment_reference: reference,
        summary_credits_remaining: PRO_SUMMARY_CREDITS,
        neural_chars_remaining: PRO_NEURAL_CHARS
      })
      .eq('id', userId)
      .eq('tier', row.tier);
    q = row.pro_expires_at == null
      ? q.is('pro_expires_at', null)
      : q.eq('pro_expires_at', row.pro_expires_at);
    const { data: updated, error: updateErr } = await q.select('pro_expires_at');

    if (updateErr) throw new Error(`Could not update the profile: ${updateErr.message}`);
    if (updated && updated.length) {
      return { applied: true, expiresAt: updated[0].pro_expires_at };
    }
    // someone else changed the row first: read again and retry
  }
  throw new Error('Profile update kept conflicting; left for the next webhook retry.');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method not allowed');
  }

  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    // Misconfiguration: tell Paystack to retry once it is fixed
    return res.status(500).send('PAYSTACK_SECRET_KEY is not configured.');
  }

  const signature = req.headers['x-paystack-signature'];
  const digest = crypto
    .createHmac('sha512', secret)
    .update(getRawBody(req))
    .digest('hex');

  if (!safeEqual(digest, signature)) {
    return res.status(401).send('Invalid webhook signature');
  }

  // Signature is authentic from here on; decide whether this event grants anything.
  // The body may arrive already parsed (normal on Vercel) or as raw JSON bytes, so normalise.
  let event = req.body;
  if (typeof event === 'string' || Buffer.isBuffer(event)) {
    try {
      event = JSON.parse(event.toString('utf8'));
    } catch (e) {
      return res.status(400).send('Invalid JSON payload');
    }
  }
  const decision = evaluateChargeEvent(event);
  if (!decision.ok) {
    console.warn(`Paystack webhook ignored (${decision.reason}).`);
    return res.status(200).send(`Ignored: ${decision.reason}`);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).send('Supabase is not configured; webhook will be retried.');
  }

  try {
    const db = createClient(supabaseUrl, supabaseKey);
    const result = await applyProUpgrade(db, decision);

    if (result.applied && !result.alreadyProcessed) {
      console.log(`Paystack: Pro granted to ${decision.userId} until ${result.expiresAt} (ref ${decision.reference}).`);
    }
    return res.status(200).send(result.alreadyProcessed ? 'Already processed' : 'Webhook processed');
  } catch (err) {
    console.error('Paystack webhook error:', err);
    return res.status(500).send(`Webhook failed: ${err.message}`);
  }
}
