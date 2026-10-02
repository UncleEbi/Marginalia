import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // Server-side admin key
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, voiceId, engine } = req.body;
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) return res.status(401).json({ error: 'Authentication required' });
  if (!text || text.length === 0) return res.status(400).json({ error: 'No text provided' });

  // 1. Verify user session via Supabase JWT
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid user session' });

  // 2. Fetch current balance
  const { data: profile } = await supabase
    .from('profiles')
    .select('neural_chars_remaining, tier')
    .eq('id', user.id)
    .single();

  const charCost = text.length;

  if (!profile || profile.neural_chars_remaining < charCost) {
    return res.status(402).json({ 
      error: 'Character balance depleted. Upgrade to continue listening with neural voice.' 
    });
  }

  // 3. Call Upstream TTS (ElevenLabs with timestamps)
  try {
    const upstreamRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': process.env.ELEVENLABS_API_KEY
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2'
      })
    });

    if (!upstreamRes.ok) throw new Error(`Upstream TTS failed: ${upstreamRes.status}`);
    const result = await upstreamRes.json();

    // 4. Deduct consumed characters from Supabase ledger
    await supabase
      .from('profiles')
      .update({ neural_chars_remaining: profile.neural_chars_remaining - charCost })
      .eq('id', user.id);

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}