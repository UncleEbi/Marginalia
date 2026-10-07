import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64, mimeType = 'image/jpeg' } = req.body || {};
  const customOpenAiKey = req.headers['x-custom-openai-key'];
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!imageBase64) {
    return res.status(400).json({ error: 'No image data provided.' });
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
      .select('summary_credits_remaining, tier')
      .eq('id', user.id)
      .single();

    isPro = profile?.tier === 'pro';
    trialsLeft = profile?.summary_credits_remaining ?? 0;

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
          {
            role: 'system',
            content: 'You are an expert technical narrator. Explain what this chart, diagram, or illustration represents in 2 to 3 concise, natural paragraphs optimized for text-to-speech audio narration. Speak directly, and avoid markdown asterisks or bullet symbols.'
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe and explain this diagram for an audio reader.' },
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

    if (!customOpenAiKey && !isPro && user) {
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