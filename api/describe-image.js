import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64, mimeType = 'image/jpeg' } = req.body;
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'Please sign in to analyze diagrams.' });
  }
  if (!imageBase64) {
    return res.status(400).json({ error: 'No image data provided.' });
  }

  // 1. Verify User Session
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) {
    return res.status(401).json({ error: 'Invalid or expired user session.' });
  }

  // 2. Verify Credit Allowance (Uses existing trial ledger or Pro tier)
  const { data: profile } = await supabase
    .from('profiles')
    .select('summary_credits_remaining, tier')
    .eq('id', user.id)
    .single();

  const isPro = profile?.tier === 'pro';
  const trialsLeft = profile?.summary_credits_remaining ?? 0;

  if (!isPro && trialsLeft <= 0) {
    return res.status(402).json({
      error: 'Free trial AI credits exhausted. Upgrade to Pro for unlimited diagram explanations.',
      trialExhausted: true
    });
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not configured in Vercel environment variables.');
    }

    // Format clean base64 data URI
    const dataUrl = imageBase64.startsWith('data:') 
      ? imageBase64 
      : `data:${mimeType};base64,${imageBase64}`;

    // 3. Call OpenAI Vision API
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are an expert technical narrator. Explain what this chart, diagram, or illustration represents in 2 to 3 concise, natural paragraphs optimized for text-to-speech audio narration. Speak directly and avoid markdown asterisks or bullet symbols.'
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe and interpret this figure for an audio reader.' },
              { type: 'image_url', image_url: { url: dataUrl } }
            ]
          }
        ],
        max_tokens: 450,
        temperature: 0.3
      })
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      throw new Error(`OpenAI Vision error (${aiRes.status}): ${errText}`);
    }

    const aiData = await aiRes.json();
    const explanation = aiData.choices?.[0]?.message?.content?.trim();

    // Deduct 1 credit if on free tier
    if (!isPro) {
      await supabase
        .from('profiles')
        .update({ summary_credits_remaining: Math.max(0, trialsLeft - 1) })
        .eq('id', user.id);
    }

    return res.status(200).json({ explanation });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}