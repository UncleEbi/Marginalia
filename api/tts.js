import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, voiceId, engine, speed = 1.0 } = req.body;
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) return res.status(401).json({ error: 'Authentication required' });
  if (!text || text.length === 0) return res.status(400).json({ error: 'No text provided' });

  // 1. Verify user session via Supabase JWT
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid user session' });

  // 2. Fetch current user character balance
  const { data: profile } = await supabase
    .from('profiles')
    .select('neural_chars_remaining, tier')
    .eq('id', user.id)
    .single();

  const charCost = text.length;

  if (!profile || profile.neural_chars_remaining < charCost) {
    return res.status(402).json({ 
      error: 'Character balance depleted. Upgrade to continue listening with neural voices.' 
    });
  }

  try {
    let resultPayload = {};

    // --- ENGINE 1: ELEVENLABS ---
    if (engine === 'elevenlabs') {
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': process.env.ELEVENLABS_API_KEY
        },
        body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' })
      });
      if (!response.ok) throw new Error(`ElevenLabs error: ${response.status}`);
      resultPayload = await response.json();
    }

    // --- ENGINE 2: GOOGLE CLOUD TTS ---
    else if (engine === 'google') {
      const lang = voiceId ? voiceId.split('-').slice(0, 2).join('-') : 'en-US';
      const response = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_TTS_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: lang, name: voiceId || 'en-US-Journey-F' },
          audioConfig: { audioEncoding: 'MP3', speakingRate: parseFloat(speed) },
          enableTimePointing: ['TIMEPOINT_TYPE_UNSPECIFIED']
        })
      });
      if (!response.ok) throw new Error(`Google TTS error: ${response.status}`);
      const data = await response.json();
      resultPayload = {
        audio_base64: data.audioContent,
        timepoints: data.timepoints || []
      };
    }

    // --- ENGINE 3: AZURE SPEECH ---
    else if (engine === 'azure') {
      const region = process.env.AZURE_SPEECH_REGION || 'eastus';
      const voice = voiceId || 'en-US-JennyNeural';
      const ssml = `<speak version='1.0' xml:lang='en-US'><voice name='${voice}'>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</voice></speak>`;

      const response = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': process.env.AZURE_SPEECH_KEY,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3'
        },
        body: ssml
      });
      if (!response.ok) throw new Error(`Azure TTS error: ${response.status}`);
      const arrayBuffer = await response.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString('base64');
      resultPayload = { audio_base64: base64 };
    }

    // --- ENGINE 4: OPENAI TTS ---
    else if (engine === 'openai') {
      const response = await fetch('https://api.openai.com/v1/audio/speech', {
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
      if (!response.ok) throw new Error(`OpenAI TTS error: ${response.status}`);
      const arrayBuffer = await response.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString('base64');
      resultPayload = { audio_base64: base64 };
    }

    else {
      return res.status(400).json({ error: `Unsupported engine: ${engine}` });
    }

    // 3. Deduct character cost from Supabase profile
    await supabase
      .from('profiles')
      .update({ neural_chars_remaining: profile.neural_chars_remaining - charCost })
      .eq('id', user.id);

    return res.status(200).json(resultPayload);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}