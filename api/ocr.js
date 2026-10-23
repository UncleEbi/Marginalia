import { createClient } from '@supabase/supabase-js';
import { isProActive, downgradeExpiredPro, FREE_SUMMARY_CREDITS } from '../lib/pro-plan.js';

// Supabase settings come from the server's environment ONLY (same rule as describe-image.js).
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

// Flat image scans have no text layer, so the reader renders each PDF page to an image and posts it
// here to get the text back. The credit gate matches /api/describe-image: BYOK users pay their own
// key, signed-in users spend one summary credit per page, and Pro reads without a credit cost.
const OCR_SYSTEM_PROMPT =
  'You are an OCR engine. Transcribe every word of visible text from this scanned page image, ' +
  'in natural reading order. Keep paragraph breaks as blank lines and keep lists as separate lines. ' +
  'Fix only obvious scanning artifacts (for example "rn" read as "m") when the context is clear. ' +
  'Never summarize, translate, or add commentary, headers, or markdown. ' +
  'If the page contains no readable text, reply with exactly: (no readable text)';

// Vercel rejects request bodies over ~4.5 MB, and a page that large is oversized for OCR anyway.
const MAX_IMAGE_CHARS = 3_500_000;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64, mimeType = 'image/jpeg' } = req.body || {};
  const customOpenAiKey = req.headers['x-custom-openai-key'];
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return res.status(400).json({ error: 'No image data provided.' });
  }
  if (imageBase64.length > MAX_IMAGE_CHARS) {
    return res.status(413).json({ error: 'Scanned page image is too large to read.' });
  }

  let isPro = false;
  let user = null;
  let trialsLeft = 0;

  if (!customOpenAiKey) {
    if (!token) {
      return res.status(401).json({ error: 'Please sign in or enter your custom OpenAI key in Options.' });
    }

    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) {
      return res.status(401).json({ error: 'Invalid or expired user session.' });
    }
    user = authData.user;

    const { data: profile } = await supabase
      .from('profiles')
      .select('summary_credits_remaining, tier, pro_expires_at')
      .eq('id', user.id)
      .single();

    isPro = isProActive(profile);
    if (profile?.tier === 'pro' && !isPro) {
      await downgradeExpiredPro(supabase, user.id);
      trialsLeft = FREE_SUMMARY_CREDITS;
    } else {
      trialsLeft = profile?.summary_credits_remaining ?? 0;
    }

    if (!isPro && trialsLeft <= 0) {
      return res.status(402).json({
        error: 'Free trial AI credits exhausted. Add an OpenAI key in Options or upgrade to Pro.',
        trialExhausted: true
      });
    }
  }

  const apiKey = customOpenAiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'No OpenAI API key found.' });
  }

  try {
    const dataUrl = imageBase64.startsWith('data:')
      ? imageBase64
      : `data:${mimeType};base64,${imageBase64}`;

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

    if (!customOpenAiKey && !isPro && user) {
      await supabase
        .from('profiles')
        .update({ summary_credits_remaining: Math.max(0, trialsLeft - 1) })
        .eq('id', user.id);
    }

    return res.status(200).json({ text });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
