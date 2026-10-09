import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, mode = 'chapter' } = req.body || {};
  const customOpenAiKey = req.headers['x-custom-openai-key'];
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'No text provided for summarization.' });
  }

  // 1. Resolve Supabase project URL and Key (Environment Variables or Client Fallback)
  const supabaseUrl = process.env.SUPABASE_URL || 
                      process.env.SUPABASE_PROJECT_URL || 
                      req.headers['x-supabase-url'];

  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 
                      process.env.SUPABASE_ANON_KEY || 
                      req.headers['x-supabase-key'];

  let isPro = false;
  let user = null;
  let trialLeft = 3;
  
  const rawUrl = process.env.SUPABASE_URL || 
                 process.env.SUPABASE_PROJECT_URL || 
                 process.env.NEXT_PUBLIC_SUPABASE_URL ||
                 req.headers['x-supabase-url'] || '';

  // Sanitize to the root origin only
  let supabaseUrl = '';
  try {
    if (rawUrl) {
      const parsed = new URL(rawUrl.trim());
      supabaseUrl = parsed.origin; // strips trailing slashes, /auth/v1, /rest/v1, etc.
    }
  } catch (e) {
    supabaseUrl = rawUrl.replace(/\/+$/, '');
  }

  // 2. Enforce Supabase account quotas if user is not using their own key
  if (!customOpenAiKey) {
    if (!token) {
      return res.status(401).json({ error: 'No active session token. Please sign in.' });
    }

    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({ 
        error: 'Backend error: Supabase URL or Key is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel.' 
      });
    }

    // Verify token against Supabase Auth
    const authClient = createClient(supabaseUrl, supabaseKey);
    const { data: authData, error: authErr } = await authClient.auth.getUser(token);

    if (authErr || !authData?.user) {
      return res.status(401).json({ 
        error: authErr?.message 
          ? `Authentication error: ${authErr.message}. Please sign in again.` 
          : 'Invalid or expired user session. Please sign in again.' 
      });
    }
    user = authData.user;

    // Use admin client if service role key is present, otherwise use user-scoped client
    const dbClient = process.env.SUPABASE_SERVICE_ROLE_KEY
      ? createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY)
      : createClient(supabaseUrl, supabaseKey, {
          global: { headers: { Authorization: `Bearer ${token}` } }
        });

    const { data: profile } = await dbClient
      .from('profiles')
      .select('summary_credits_remaining, tier')
      .eq('id', user.id)
      .single();

    if (profile) {
      isPro = profile.tier === 'pro';
      trialLeft = profile.summary_credits_remaining ?? 3;
    } else {
      await dbClient.from('profiles').upsert({
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
    if (!customOpenAiKey && !isPro && user && supabaseUrl && supabaseKey) {
      const dbClient = process.env.SUPABASE_SERVICE_ROLE_KEY
        ? createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY)
        : createClient(supabaseUrl, supabaseKey, {
            global: { headers: { Authorization: `Bearer ${token}` } }
          });

      await dbClient
        .from('profiles')
        .update({ summary_credits_remaining: Math.max(0, trialLeft - 1) })
        .eq('id', user.id)
        .catch(() => {});
    }

    return res.status(200).json({ summary });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
