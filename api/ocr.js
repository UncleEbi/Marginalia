import { createClient } from '@supabase/supabase-js';
import { isProActive, downgradeExpiredPro, FREE_SUMMARY_CREDITS, refreshProQuota } from '../lib/pro-plan.js';
import { AI_OPS_MONTHLY_COL, AI_OPS_TOPUP_COL, bothBucketsEmpty, monthlyAllowance, deductAiOp } from '../lib/quota-ops.js';
import { MAX_IMAGE_BASE64_CHARS, normalizeImageMime, isImagePayload } from './_lib/image-payload.js';
import { supabaseConfig } from './_lib/supabase.js';
import { enforceRateLimit, clientIp, keyFingerprint } from './_lib/rate-limit.js';

// Flat image scans have no text layer, so the reader renders each PDF page to an image and posts it
// here to get the text back. The credit gate is now the same two-bucket model used by /api/summarize
// and /api/describe-image: BYOK users pay their own key, and every signed-in account spends one AI
// op per page, first against the monthly allowance, then against any bought refill top-up.
const OCR_SYSTEM_PROMPT =
  'You are an OCR engine. Transcribe every word of visible text from this scanned page image, ' +
  'in natural reading order. Keep paragraph breaks as blank lines and keep lists as separate lines. ' +
  'Fix only obvious scanning artifacts (for example "rn" read as "m") when the context is clear. ' +
  'Never summarize, translate, or add commentary, headers, or markdown. ' +
  'If the page contains no readable text, reply with exactly: (no readable text)';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64, mimeType = 'image/jpeg' } = req.body || {};
  const mime = normalizeImageMime(mimeType);
  const customOpenAiKey = req.headers['x-custom-openai-key'];
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return res.status(400).json({ error: 'No image data provided.' });
  }
  if (!isImagePayload(imageBase64)) {
    return res.status(400).json({ error: 'Only image data can be read.' });
  }
  if (imageBase64.length > MAX_IMAGE_BASE64_CHARS) {
    return res.status(413).json({ error: 'Scanned page image is too large to read.' });
  }

  const isByok = Boolean(customOpenAiKey);
  let db = null;
  let userId = null;
  let isPro = false;
  let trialsLeft = 0;
  let trialsMonthly = null;
  let trialsTopup = null;

  if (!isByok) {
    if (!token) {
      return res.status(401).json({ error: 'Please sign in or enter your custom OpenAI key in Options.' });
    }

    const { url, key, hasServiceKey } = supabaseConfig();
    if (!url || !key) {
      return res.status(500).json({ error: 'Backend error: Supabase URL or Key is not configured.' });
    }

    const authClient = createClient(url, key);
    const { data: authData, error: authErr } = await authClient.auth.getUser(token);
    if (authErr || !authData?.user) {
      return res.status(401).json({ error: 'Invalid or expired user session.' });
    }
    const user = authData.user;
    userId = user.id;
    db = hasServiceKey
      ? createClient(url, key)
      : createClient(url, key, { global: { headers: { Authorization: `Bearer ${token}` } } });

    // One page scan is one paid vision call, so a verified account and its address are throttled
    // before the quota read, exactly as /api/tts does for narration.
    const gate = await enforceRateLimit(req, res, {
      tier: 'vision',
      identifiers: [
        { bucket: 'user', value: userId },
        { bucket: 'ip', value: clientIp(req) }
      ]
    });
    if (!gate.ok) return;

    const { profile, error: profileErr } = await refreshProQuota(db, userId);
    if (profileErr) {
      const missingColumn = /pro_expires_at/i.test(profileErr.message || '');
      return res.status(500).json({ error: 'Could not read your account. Please try again.' + (missingColumn
        ? ' (profiles is missing pro_expires_at, pro_tier or pro_quota_resets_at — run the SQL migrations in supabase/migrations/ first.)'
        : '') });
    }

    if (!profile) {
      const { error: insertErr } = await db.from('profiles').upsert({
        id: userId,
        email: user.email,
        summary_credits_remaining: FREE_SUMMARY_CREDITS,
        neural_chars_remaining: 5000,
        tier: 'free'
      }, { onConflict: 'id', ignoreDuplicates: true });
      if (insertErr) return res.status(500).json({ error: 'Could not set up your account. Please try again.' });
    }

    isPro = isProActive(profile);
    if (profile?.tier === 'pro' && !isPro) {
      await downgradeExpiredPro(db, userId);
    }

    // Unconfirmed sign-ups are disposable inboxes; they must not spend host-paid vision calls.
    if (!isPro && !user.email_confirmed_at) {
      return res.status(403).json({ error: 'EMAIL_VERIFICATION_REQUIRED' });
    }

    const allowance = monthlyAllowance(profile);
    const monthlyOps = profile?.summary_credits_remaining ?? allowance.ops;
    const topupOps = profile?.topup_ai_ops ?? 0;

    if (bothBucketsEmpty({ monthlyRemaining: monthlyOps, topupRemaining: topupOps }) ||
        monthlyOps + topupOps < 1) {
      return res.status(402).json({
        error: 'AI_SUMMARY_QUOTA_EXCEEDED',
        summaries_remaining: 0,
        summaries_monthly: 0,
        summaries_topup: 0
      });
    }

    trialsMonthly = monthlyOps;
    trialsTopup = topupOps;
    trialsLeft = monthlyOps + topupOps;
  } else {
    // BYOK spends the reader's own key: throttle the key fingerprint and the client address.
    const gate = await enforceRateLimit(req, res, {
      tier: 'vision',
      identifiers: [
        { bucket: 'byok', value: keyFingerprint(customOpenAiKey) },
        { bucket: 'ip', value: clientIp(req) }
      ]
    });
    if (!gate.ok) return;
  }

  const apiKey = customOpenAiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'No OpenAI API key found.' });
  }

  try {
    const dataUrl = imageBase64.startsWith('data:')
      ? imageBase64
      : `data:${mime};base64,${imageBase64}`;

    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: OCR_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Transcribe this page.' },
              { type: 'image_url', image_url: { url: dataUrl } }
            ]
          }
        ],
        max_tokens: 3000,
        temperature: 0
      })
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      throw new Error(`OpenAI Vision error (${aiRes.status}): ${errText}`);
    }

    const aiData = await aiRes.json();
    const raw = aiData.choices?.[0]?.message?.content?.trim() || '';
    const text = raw === '(no readable text)' ? '' : raw;

    if (!isByok && userId && trialsMonthly != null && trialsTopup != null) {
      await deductAiOp(db, userId, trialsMonthly, trialsTopup);
    }

    return res.status(200).json({ text });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
