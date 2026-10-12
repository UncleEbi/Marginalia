// api/tts.js
//
// Contract with the app (unchanged):
//   POST { text, voiceId, engine, speed }
//   headers: Authorization (Supabase session), x-custom-openai-key / x-custom-elevenlabs-key (BYOK)
//   200 -> { audio_base64, remaining_chars }
//   errors -> { error }  (401 sign-in, 402 quota, 400 bad request, 500 server config, 502 provider failure)
//
// Also accepted for simple/older callers:
//   - `voice` as an alias of `voiceId`
//   - `Accept: audio/mpeg` returns the raw mp3 bytes instead of JSON
import { createClient } from '@supabase/supabase-js';

const OPENAI_MAX_CHARS = 4096; // hard limit of the OpenAI speech endpoint

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Created on first use, so a missing Supabase config can't crash requests that don't need it
// (for example people using their own API key).
let supabaseClient = null;
function getSupabase() {
  if (supabaseClient) return supabaseClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new HttpError(500, 'Server is missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
  supabaseClient = createClient(url, key);
  return supabaseClient;
}

function clampSpeed(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1.0;
  return Math.max(0.25, Math.min(4.0, n));
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function shorten(str, max = 500) {
  const s = String(str || '');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// --- Providers: each returns the mp3 as a base64 string ---

async function synthOpenAI({ text, voiceId, speed, customKey }) {
  const apiKey = customKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new HttpError(
      500,
      'OpenAI API key not configured. Set OPENAI_API_KEY in the Vercel environment variables (then redeploy), or add your own key in Options.'
    );
  }
  if (text.length > OPENAI_MAX_CHARS) {
    throw new HttpError(400, `Text is too long for OpenAI voices (${text.length} characters, limit ${OPENAI_MAX_CHARS}).`);
  }

  // A voice id left over from another engine (ElevenLabs/Azure ids) would make OpenAI reject the call
  const voice = /^[a-z]{3,12}$/.test(voiceId || '') ? voiceId : 'alloy';

  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'tts-1', // fast, low-latency TTS model
      input: text,
      voice,
      speed,
      response_format: 'mp3'
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new HttpError(502, `OpenAI TTS error (${response.status}): ${shorten(err)}`);
  }
  return Buffer.from(await response.arrayBuffer()).toString('base64');
}

async function synthElevenLabs({ text, voiceId, customKey }) {
  const apiKey = customKey || process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new HttpError(500, 'ElevenLabs API key not configured.');

  const vId = voiceId || '21m00Tcm4TlvDq8ikWAM'; // Rachel default
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(vId)}`, {
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
    throw new HttpError(502, `ElevenLabs error (${response.status}): ${shorten(err)}`);
  }
  return Buffer.from(await response.arrayBuffer()).toString('base64');
}

async function synthGoogle({ text, voiceId, speed }) {
  const apiKey = process.env.GOOGLE_TTS_API_KEY;
  if (!apiKey) throw new HttpError(500, 'Google Cloud TTS API key not configured.');

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
    throw new HttpError(502, `Google TTS error (${response.status}): ${shorten(err)}`);
  }
  const data = await response.json();
  return data.audioContent;
}

async function synthAzure({ text, voiceId, speed }) {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION || 'eastus';
  if (!key) throw new HttpError(500, 'Azure Speech API key not configured.');

  // Book text often contains & < > which would break the SSML, so it must be escaped
  const ssml =
    `<speak version='1.0' xml:lang='en-US'>` +
    `<voice name='${escapeXml(voiceId || 'en-US-JennyNeural')}'>` +
    `<prosody rate='${speed}'>${escapeXml(text)}</prosody>` +
    `</voice></speak>`;

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
    throw new HttpError(502, `Azure Speech error (${response.status}): ${shorten(err)}`);
  }
  return Buffer.from(await response.arrayBuffer()).toString('base64');
}

// Deducts characters without losing updates. The app now preloads the next sentences, so several
// requests for the same user can run at once; a plain read-then-write would let them overwrite each
// other's balance. This only writes if the balance is still what we read, and retries otherwise.
async function deductChars(supabase, userId, startingBalance, charCount) {
  let current = startingBalance;
  for (let attempt = 0; attempt < 5; attempt++) {
    const next = Math.max(0, current - charCount);
    const { data, error } = await supabase
      .from('profiles')
      .update({ neural_chars_remaining: next })
      .eq('id', userId)
      .eq('neural_chars_remaining', current)
      .select('neural_chars_remaining');

    if (error) return next;                  // could not save; never fail audio the user already got
    if (data && data.length) return next;    // saved

    // No row matched: no profile row, or another request changed the balance first. Re-read and retry.
    const { data: fresh } = await supabase
      .from('profiles')
      .select('neural_chars_remaining')
      .eq('id', userId)
      .single();
    if (!fresh || fresh.neural_chars_remaining == null) return next;
    current = fresh.neural_chars_remaining;
  }
  return Math.max(0, current - charCount);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const text = typeof body.text === 'string' ? body.text : '';
  const engine = body.engine || 'openai';
  const voiceId = body.voiceId || body.voice || '';
  const speed = clampSpeed(body.speed);

  const customOpenAiKey = req.headers['x-custom-openai-key'];
  const customElevenKey = req.headers['x-custom-elevenlabs-key'];
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!text.trim()) {
    return res.status(400).json({ error: 'No text provided for narration.' });
  }

  const charCount = text.length;
  const isByok = Boolean((engine === 'openai' && customOpenAiKey) || (engine === 'elevenlabs' && customElevenKey));
  let user = null;
  let remainingChars = null;

  try {
    // Check Supabase quota only if using host-funded APIs
    if (!isByok) {
      if (!token) {
        return res.status(401).json({ error: 'Please sign in or enter your custom API key in Options.' });
      }

      const supabase = getSupabase();
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

    let audioBase64 = null;

    if (engine === 'openai') {
      audioBase64 = await synthOpenAI({ text, voiceId, speed, customKey: customOpenAiKey });
    } else if (engine === 'elevenlabs') {
      audioBase64 = await synthElevenLabs({ text, voiceId, customKey: customElevenKey });
    } else if (engine === 'google') {
      audioBase64 = await synthGoogle({ text, voiceId, speed });
    } else if (engine === 'azure') {
      audioBase64 = await synthAzure({ text, voiceId, speed });
    } else {
      return res.status(400).json({ error: `Unsupported engine: ${engine}` });
    }

    if (!audioBase64) {
      throw new HttpError(502, 'The voice provider returned no audio.');
    }

    // Deduct characters from the ledger if running on the host balance
    let updatedRemaining = remainingChars;
    if (!isByok && user && remainingChars !== null) {
      updatedRemaining = await deductChars(getSupabase(), user.id, remainingChars, charCount);
    }
    const remainingForClient = isByok ? 'Unlimited (BYOK)' : updatedRemaining;

    // Simple callers can ask for the raw mp3 instead of JSON
    const accept = String(req.headers.accept || '');
    if (accept.includes('audio/mpeg') && !accept.includes('application/json')) {
      const audio = Buffer.from(audioBase64, 'base64');
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', audio.length);
      res.setHeader('X-Remaining-Chars', String(remainingForClient));
      return res.status(200).send(audio);
    }

    return res.status(200).json({
      audio_base64: audioBase64,
      remaining_chars: remainingForClient
    });

  } catch (err) {
    console.error('TTS error:', err);
    return res.status(err.status || 500).json({ error: err.message || 'Internal server error generating audio' });
  }
}
