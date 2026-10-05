import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, mode = 'chapter' } = req.body;
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'Please sign in to use AI summaries.' });
  }

  if (!text || text.trim().length === 0) {
    return res.status(400).json({ error: 'No text provided for summarization.' });
  }

  // 1. Verify user session
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) {
    return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
  }

  // 2. Check subscription tier and free trial allowance
  const { data: profile, error: profErr } = await supabase
    .from('profiles')
    .select('summary_credits_remaining, tier')
    .eq('id', user.id)
    .single();

  if (profErr || !profile) {
    return res.status(404).json({ error: 'User profile not found.' });
  }

  const isPro = profile.tier === 'pro';
  const trialLeft = profile.summary_credits_remaining || 0;

  if (!isPro && trialLeft <= 0) {
    return res.status(402).json({
      error: 'Free trial summaries exhausted. Upgrade to Pro for unlimited document summaries and neural voices.',
      trialExhausted: true
    });
  }

  // 3. Craft LLM Prompt for spoken audio playback
  let systemPrompt = "You are an executive reading companion. Summarize the text clearly and naturally so it flows smoothly when read aloud via text-to-speech narration. Avoid markdown bullet symbols, asterisks, or raw symbols that sound clunky when read by audio engines.";
  let userPrompt = "";

  if (mode === 'key_takeaways') {
    userPrompt = `Extract the essential key takeaways and high-level themes of this entire document into 3 to 5 concise, narratable paragraphs:\n\n${text.slice(0, 45000)}`;
  } else {
    userPrompt = `Summarize this chapter or section into a focused, clear narrative summary in 2 to 3 paragraphs:\n\n${text.slice(0, 25000)}`;
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not configured in Vercel environment variables.');
    }

    const openAiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
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

    if (!openAiRes.ok) {
      const errText = await openAiRes.text();
      throw new Error(`OpenAI API error (${openAiRes.status}): ${errText}`);
    }

    const aiData = await openAiRes.json();
    const summary = aiData.choices?.[0]?.message?.content?.trim();

    if (!summary) throw new Error('AI engine returned an empty response.');

    // 4. Deduct 1 trial credit if on the Free tier
    let updatedTrials = trialLeft;
    if (!isPro) {
      updatedTrials = Math.max(0, trialLeft - 1);
      await supabase
        .from('profiles')
        .update({ summary_credits_remaining: updatedTrials })
        .eq('id', user.id);
    }

    return res.status(200).json({
      summary,
      mode,
      isPro,
      trialRemaining: isPro ? 'Unlimited (Pro)' : updatedTrials
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}