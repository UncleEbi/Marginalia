import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, voiceId, engine, speed = 1.0 } = req.body;
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'Authentication required. Please sign in to use neural voices.' });
  }
  if (!text || text.length === 0) {
    return res.status(400).json({ error: 'No text provided' });
  }

  // 1. Verify user session via Supabase JWT
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) {
    return res.status(401).json({ error: `Invalid user session: ${authErr?.message || 'User not found'}` });
  }

  // 2. Fetch current character balance
  const { data: profile, error: profErr } = await supabase
    .from('profiles')
    .select('neural_chars_remaining, tier')
    .eq('id', user.id)
    .single();

  if (profErr || !profile) {
    return res.status(404).json({ error: 'Profile record not found in Supabase database.' });
  }

  const charCost = text.length;
  if (profile.neural_chars_remaining < charCost) {
    return res.status(402).json({ 
      error: 'Character balance depleted. Upgrade to continue listening with neural voices.' 
    });
  }

  try {
    let resultPayload = {};

    // --- ELEVENLABS ---
    if (engine === 'elevenlabs') {
      if (!process.env.ELEVENLABS_API_KEY) {
        throw new Error('ELEVENLABS_API_KEY is not configured in Vercel environment variables.');
      }

      const elevenRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`, {
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

      if (!elevenRes.ok) {
        const errDetail = await elevenRes.text();
        throw new Error(`ElevenLabs error (${elevenRes.status}): ${errDetail}`);
      }

      resultPayload = await elevenRes.json();
    }

    // --- OPENAI AUDIO ---
    else if (engine === 'openai') {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY is not configured in Vercel environment variables.');
      }

      const openAiRes = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'tts-1',
          input: text,
          voice: voiceId || 'alloy',
          speed: parseFloat(speed)
        })
      });

      if (!openAiRes.ok) {
        const errDetail = await openAiRes.text();
        throw new Error(`OpenAI error (${openAiRes.status}): ${errDetail}`);
      }

      const arrayBuffer = await openAiRes.arrayBuffer();
      resultPayload = { audio_base64: Buffer.from(arrayBuffer).toString('base64') };
    }

    // --- GOOGLE CLOUD TTS ---
    else if (engine === 'google') {
      if (!process.env.GOOGLE_TTS_API_KEY) {
        throw new Error('GOOGLE_TTS_API_KEY is not configured in Vercel environment variables.');
      }

      const lang = voiceId ? voiceId.split('-').slice(0, 2).join('-') : 'en-US';
      const googleRes = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_TTS_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: lang, name: voiceId || 'en-US-Journey-F' },
          audioConfig: { audioEncoding: 'MP3', speakingRate: parseFloat(speed) }
        })
      });

      if (!googleRes.ok) {
        const errDetail = await googleRes.text();
        throw new Error(`Google Cloud TTS error (${googleRes.status}): ${errDetail}`);
      }

      const data = await googleRes.json();
      resultPayload = { audio_base64: data.audioContent };
    }

    // --- AZURE SPEECH ---
    else if (engine === 'azure') {
      if (!process.env.AZURE_SPEECH_KEY) {
        throw new Error('AZURE_SPEECH_KEY is not configured in Vercel environment variables.');
      }

      const region = process.env.AZURE_SPEECH_REGION || 'eastus';
      const voice = voiceId || 'en-US-JennyNeural';
      const ssml = `<speak version='1.0' xml:lang='en-US'><voice name='${voice}'>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</voice></speak>`;

      const azureRes = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': process.env.AZURE_SPEECH_KEY,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3'
        },
        body: ssml
      });

      if (!azureRes.ok) {
        const errDetail = await azureRes.text();
        throw new Error(`Azure Speech error (${azureRes.status}): ${errDetail}`);
      }

      const arrayBuffer = await azureRes.arrayBuffer();
      resultPayload = { audio_base64: Buffer.from(arrayBuffer).toString('base64') };
    }

    else {
      return res.status(400).json({ error: `Unsupported engine: ${engine}` });
    }

    // 3. Deduct character cost and calculate remaining balance
    const updatedRemaining = profile.neural_chars_remaining - charCost;
    await supabase
      .from('profiles')
      .update({ neural_chars_remaining: updatedRemaining })
      .eq('id', user.id);

    resultPayload.remaining_chars = updatedRemaining;
    return res.status(200).json(resultPayload);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}