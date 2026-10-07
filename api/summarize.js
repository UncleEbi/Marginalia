import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, mode = 'chapter' } = req.body || {};
  const customOpenAiKey = req.headers['x-custom-openai-key'];
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'No text provided for summarization.' });
  }

  let isPro = false;
  let user = null;
  let trialLeft = 0;

  // If user did not provide a custom key, enforce Supabase account quotas
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
    trialLeft = profile?.summary_credits_remaining ?? 0;

    if (!isPro && trialLeft <= 0) {
      return res.status(402).json({
        error: 'Free trial summaries exhausted. Add an OpenAI key in Options or upgrade to Pro.',
        trialExhausted: true
      });
    }
  }

  const apiKey = customOpenAiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'No OpenAI API key found.' });
  }

  const systemPrompt = "You are an executive reading companion. Summarize the text clearly and naturally so it flows smoothly when read aloud via text-to-speech narration. Avoid markdown bullet symbols, asterisks, or raw symbols that sound clunky when read by audio engines.";
  const userPrompt = mode === 'key_takeaways'
    ? `Extract the essential key takeaways and high-level themes of this document into 3 to 5 concise, narratable paragraphs:\n\n${text.slice(0, 45000)}`
    : `Summarize this section into a focused, natural narrative summary in 2 to 3 paragraphs:\n\n${text.slice(0, 25000)}`;

  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.4
      })
    });

    if (!aiRes.ok) {
      const err = await aiRes.text();
      throw new Error(`OpenAI API error (${aiRes.status}): ${err}`);
    }

    const aiData = await aiRes.json();
    const summary = aiData.choices?.[0]?.message?.content?.trim();
    if (!summary) throw new Error('AI returned an empty response.');

    // Deduct credit only for free-tier users utilizing host keys
    if (!customOpenAiKey && !isPro && user) {
      await supabase
        .from('profiles')
        .update({ summary_credits_remaining: Math.max(0, trialLeft - 1) })
        .eq('id', user.id);
    }

    return res.status(200).json({ summary });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}