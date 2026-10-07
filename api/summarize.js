import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;

const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

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
  let trialLeft = 3;

  // Enforce Supabase account quotas if user is not using their own key
  if (!customOpenAiKey) {
    if (!token) {
      return res.status(401).json({ error: 'No active session. Please sign in or enter your OpenAI key in Options.' });
    }

    if (!supabase) {
      return res.status(500).json({ 
        error: 'Backend error: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing in Vercel environment variables.' 
      });
    }

    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) {
      return res.status(401).json({ 
        error: authErr?.message ? `Auth error: ${authErr.message}. Please sign in again.` : 'Invalid or expired user session. Please sign in again.' 
      });
    }
    user = authData.user;

    const { data: profile } = await supabase
      .from('profiles')
      .select('summary_credits_remaining, tier')
      .eq('id', user.id)
      .single();

    if (profile) {
      isPro = profile.tier === 'pro';
      trialLeft = profile.summary_credits_remaining ?? 3;
    } else {
      // Auto-provision a default free-tier profile row if one does not exist
      await supabase.from('profiles').upsert({
        id: user.id,
        email: user.email,
        summary_credits_remaining: 3,
        neural_chars_remaining: 5000,
        tier: 'free'
      }).catch(() => {});
    }

    if (!isPro && trialLeft <= 0) {
      return res.status(402).json({
        error: 'Free trial summaries exhausted. Add an OpenAI key in Options or upgrade to Pro.',
        trialExhausted: true
      });
    }
  }

  const apiKey = customOpenAiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'No OpenAI API key found. Add OPENAI_API_KEY in Vercel or enter your key in Options.' });
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