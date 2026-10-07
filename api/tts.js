import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, voiceId, engine = 'openai', speed = 1.0 } = req.body || {};
  const customOpenAiKey = req.headers['x-custom-openai-key'];
  const customElevenKey = req.headers['x-custom-elevenlabs-key'];
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'No text provided for narration.' });
  }

  const charCount = text.length;
  const isByok = (engine === 'openai' && customOpenAiKey) || (engine === 'elevenlabs' && customElevenKey);
  let user = null;
  let remainingChars = null;

  // Check Supabase quota only if using host-funded APIs
  if (!isByok) {
    if (!token) {
      return res.status(401).json({ error: 'Please sign in or enter your custom API key in Options.' });
    }

    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) {
      return res.status(401).json({ error: 'Invalid or expired user session.' });
    }
    user = authData.user;

    const { data: profile } = await supabase
      .from('profiles')
      .select('neural_chars_remaining')
      .eq('id', user.id)
      .single();

    remainingChars = profile?.neural_chars_remaining ?? 5000;
    if (remainingChars < charCount) {
      return res.status(402).json({
        error: `Insufficient neural character quota (${remainingChars.toLocaleString()} left). Add your API key in Options or upgrade.`,
        charsExhausted: true
      });
    }
  }

  try {
    let audioBase64 = null;

    // 1. OPENAI AUDIO ENGINE
    if (engine === 'openai') {
      const apiKey = customOpenAiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error('OpenAI API key not configured.');

      const response = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'tts-1',
          input: text,
          voice: voiceId || 'alloy',
          speed: Math.max(0.25, Math.min(4.0, speed))
        })
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`OpenAI TTS error (${response.status}): ${err}`);
      }

      const buffer = await response.arrayBuffer();
      audioBase64 = Buffer.from(buffer).toString('base64');
    }

    // 2. ELEVENLABS AUDIO ENGINE
    else if (engine === 'elevenlabs') {
      const apiKey = customElevenKey || process.env.ELEVENLABS_API_KEY;
      if (!apiKey) throw new Error('ElevenLabs API key not configured.');

      const vId = voiceId || '21m00Tcm4TlvDq8ikWAM'; // Rachel default
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_monolingual_v1',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 }
        })
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`ElevenLabs error (${response.status}): ${err}`);
      }

      const buffer = await response.arrayBuffer();
      audioBase64 = Buffer.from(buffer).toString('base64');
    }

    // 3. GOOGLE CLOUD TTS
    else if (engine === 'google') {
      const apiKey = process.env.GOOGLE_TTS_API_KEY;
      if (!apiKey) throw new Error('Google Cloud TTS API key not configured.');

      const response = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: 'en-US', name: voiceId || 'en-US-Journey-F' },
          audioConfig: { audioEncoding: 'MP3', speakingRate: speed }
        })
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Google TTS error (${response.status}): ${err}`);
      }

      const data = await response.json();
      audioBase64 = data.audioContent;
    }

    // 4. AZURE SPEECH ENGINE
    else if (engine === 'azure') {
      const key = process.env.AZURE_SPEECH_KEY;
      const region = process.env.AZURE_SPEECH_REGION || 'eastus';
      if (!key) throw new Error('Azure Speech API key not configured.');

      const ssml = `<speak version='1.0' xml:lang='en-US'><voice name='${voiceId || 'en-US-JennyNeural'}'><prosody rate='${speed}'>${text}</prosody></voice></speak>`;
      const response = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': key,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3'
        },
        body: ssml
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Azure Speech error (${response.status}): ${err}`);
      }

      const buffer = await response.arrayBuffer();
      audioBase64 = Buffer.from(buffer).toString('base64');
    }

    else {
      return res.status(400).json({ error: `Unsupported engine: ${engine}` });
    }

    // Deduct characters from ledger if running on host balance
    let updatedRemaining = remainingChars;
    if (!isByok && user && remainingChars !== null) {
      updatedRemaining = Math.max(0, remainingChars - charCount);
      await supabase
        .from('profiles')
        .update({ neural_chars_remaining: updatedRemaining })
        .eq('id', user.id);
    }

    return res.status(200).json({
      audio_base64: audioBase64,
      remaining_chars: isByok ? 'Unlimited (BYOK)' : updatedRemaining
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}