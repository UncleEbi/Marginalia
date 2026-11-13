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
import { getPlan, evaluateChargeEvent, nextProExpiry, PRO_PERIOD_DAYS } from '../lib/pro-plan.js';

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

// Paystack hands Vercel an already-parsed body, so the signature above is computed over
// JSON.stringify(req.body). That usually round-trips byte-for-byte, but escapes (a name with an
// accent) or reordered keys would change the digest for a perfectly genuine delivery. Instead of
// dropping a real payment, ask Paystack about the reference: their answer is authoritative, and a
// forged request cannot make an invented reference verify.
async function verifyTransaction(secret, reference) {
  const url = `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } });
  const body = await response.json().catch(() => null);
  if (response.status === 404 || response.status === 400) return null; // no such transaction
  if (!response.ok || !body || !body.status || !body.data) {
    throw new Error(`Paystack verify failed (${response.status})`);
  }
  return { event: 'charge.success', data: body.data };
}

// Constant-time hex comparison; unequal lengths are rejected up front (timingSafeEqual throws).
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Applies a verified charge: extends Pro by the purchased plan's duration (first purchase,
// renewal, or an identical retry), seeds the tier's allowance, and records the reference so the
// same payment is never applied twice. Creates the profile row when the payer does not have one
// yet — profile rows are otherwise created lazily by the first summary/TTS call, and a payment
// must never be acknowledged and then dropped because the account was too new.
export async function applyProUpgrade(db, { userId, reference, paidAt, durationDays, planId, customerEmail }) {
  const plan = getPlan(planId);
  if (!plan) throw new Error(`Unknown plan ${planId} in a verified charge.`);

  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: row, error: readErr } = await db
      .from('profiles')
      .select('tier, pro_expires_at, last_payment_reference')
      .eq('id', userId)
      .maybeSingle();

    if (readErr) {
      const missingColumn = /pro_expires_at|pro_tier|pro_quota_resets_at/i.test(readErr.message || '');
      throw new Error(missingColumn
        ? 'profiles is missing pro_expires_at, pro_tier or pro_quota_resets_at — run the SQL migrations in supabase/migrations/ first.'
        : `Could not read the profile: ${readErr.message}`);
    }

    // One monthly allowance, refilled by the endpoints every PRO_PERIOD_DAYS while Pro lasts.
    const allowance = {
      summary_credits_remaining: plan.summaryCredits,
      neural_chars_remaining: plan.neuralChars,
      pro_quota_resets_at: new Date(paidAt + PRO_PERIOD_DAYS * 86400000).toISOString()
    };

    if (!row) {
      // First row for this account: the payment is the thing that creates it. The insert carries
      // the whole purchase, so a concurrent delivery that wins the race simply leaves this one to
      // retry against the row it created (duplicate id) instead of crediting twice.
      const firstExpiry = nextProExpiry(null, paidAt, durationDays);
      const { error: insertErr } = await db.from('profiles').insert({
        id: userId,
        ...(customerEmail ? { email: customerEmail } : {}),
        tier: 'pro',
        pro_tier: plan.tier,
        pro_expires_at: firstExpiry.toISOString(),
        last_payment_reference: reference,
        ...allowance
      });
      if (insertErr) {
        if (/duplicate|unique|already exists/i.test(insertErr.message || '')) continue;
        throw new Error(`Could not create the paid profile: ${insertErr.message}`);
      }
      return { applied: true, expiresAt: firstExpiry.toISOString() };
    }

    if (row.last_payment_reference === reference) {
      return { applied: true, alreadyProcessed: true, expiresAt: row.pro_expires_at };
    }

    const newExpiry = nextProExpiry(row.pro_expires_at, paidAt, durationDays);

    // Compare-and-swap on the fields we read: if another delivery changed them first, retry.
    let q = db
      .from('profiles')
      .update({
        tier: 'pro',
        pro_tier: plan.tier,
        pro_expires_at: newExpiry.toISOString(),
        last_payment_reference: reference,
        // A 12-month charge seeds one allowance, not twelve: the endpoints refill it per period.
        ...allowance
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

  // The body may arrive already parsed (normal on Vercel) or as raw JSON bytes, so normalise.
  let event = req.body;
  if (typeof event === 'string' || Buffer.isBuffer(event)) {
    try {
      event = JSON.parse(event.toString('utf8'));
    } catch (e) {
      return res.status(400).send('Invalid JSON payload');
    }
  }

  const signature = req.headers['x-paystack-signature'];
  const digest = crypto
    .createHmac('sha512', secret)
    .update(getRawBody(req))
    .digest('hex');

  if (!safeEqual(digest, signature)) {
    const reference = event?.data?.reference || (event?.data?.id != null ? String(event.data.id) : '');
    let verified = null;
    try {
      if (reference) verified = await verifyTransaction(secret, reference);
    } catch (err) {
      // Paystack itself is unreachable: make Paystack retry rather than reject a real payment.
      console.error('Paystack webhook could not verify the transaction:', err.message);
      return res.status(502).send('Could not verify the transaction; retry.');
    }
    if (!verified) {
      return res.status(401).send('Invalid webhook signature');
    }
    console.warn(`Paystack webhook signature mismatch, accepted via transaction verify (${reference}).`);
    event = verified;
  }

  // Authenticated (by signature or by Paystack's own record); decide whether this grants anything.
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
    const result = await applyProUpgrade(db, {
      ...decision,
      customerEmail: event?.data?.customer?.email || null
    });

    if (result.applied && !result.alreadyProcessed) {
      console.log(`Paystack: ${decision.planId} / ${plan.tier} (${decision.durationDays}d) granted to ${decision.userId} until ${result.expiresAt} (ref ${decision.reference}).`);
    }
    return res.status(200).send(result.alreadyProcessed ? 'Already processed' : 'Webhook processed');
  } catch (err) {
    console.error('Paystack webhook error:', err);
    return res.status(500).send(`Webhook failed: ${err.message}`);
  }
}
