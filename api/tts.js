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
import { isProActive, downgradeExpiredPro, FREE_NEURAL_CHARS } from '../lib/pro-plan.js';

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

// A signed-in user is checked with Supabase once per minute per warm server, not once per sentence.
const USER_CACHE_TTL_MS = 60 * 1000;
const userCache = new Map(); // token -> { user, expires }

async function verifyUser(supabase, token) {
  const hit = userCache.get(token);
  if (hit && hit.expires > Date.now()) return hit.user;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;

  if (userCache.size > 500) userCache.clear(); // keep memory bounded
  userCache.set(token, { user: data.user, expires: Date.now() + USER_CACHE_TTL_MS });
  return data.user;
}

function clampSpeed(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1.0;
  return Math.max(0.25, Math.min(4.0, n));
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

  // Which OpenAI model to use. Set OPENAI_TTS_MODEL in Vercel to switch without editing code.
  const model = (process.env.OPENAI_TTS_MODEL || 'tts-1').trim();

  // A voice id left over from another engine (e.g. an ElevenLabs id) would make OpenAI reject the call
  const voice = /^[a-z]{3,12}$/.test(voiceId || '') ? voiceId : 'alloy';

  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      input: text,
      voice,
      // only the tts-1 family takes a speed setting (the app applies speed on the phone anyway)
      ...(model.startsWith('tts-1') ? { speed } : {}),
      response_format: 'mp3'
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new HttpError(502, `OpenAI TTS error (${response.status}): ${shorten(err)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function synthElevenLabs({ text, voiceId, customKey }) {
  // Bring-your-own-key only: hosted ElevenLabs costs several times more than OpenAI per character
  const apiKey = customKey;
  if (!apiKey) throw new HttpError(400, 'ElevenLabs voices need your own ElevenLabs API key. Add it in Options.');

  const vId = voiceId || '21m00Tcm4TlvDq8ikWAM'; // Rachel default
  // Flash is ElevenLabs' lowest-latency model (about 75 ms) and the 64 kbps mp3 is half the size of the
  // default 128 kbps, so each sentence is generated and downloaded faster. Both can be overridden.
  const preferredModel = (process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5').trim();
  const preferredFormat = (process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_64').trim();

  const call = (model, format) => fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(vId)}` +
      (format ? `?output_format=${encodeURIComponent(format)}` : ''),
    {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      })
    }
  );

  let response = await call(preferredModel, preferredFormat);

  // If ElevenLabs rejects the model or format name (400/422), retry once with the long-standing defaults
  if (!response.ok && (response.status === 400 || response.status === 422)) {
    response = await call('eleven_multilingual_v2', null);
  }

  if (!response.ok) {
    const err = await response.text();
    throw new HttpError(502, `ElevenLabs error (${response.status}): ${shorten(err)}`);
  }
  return Buffer.from(await response.arrayBuffer());
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
  return Buffer.from(data.audioContent || '', 'base64');
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

// Gives characters back (used when the voice provider failed after we had already reserved them)
async function refundChars(supabase, userId, charCount) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: row } = await supabase
      .from('profiles')
      .select('neural_chars_remaining')
      .eq('id', userId)
      .single();
    if (!row || row.neural_chars_remaining == null) return;
    const { data } = await supabase
      .from('profiles')
      .update({ neural_chars_remaining: row.neural_chars_remaining + charCount })
      .eq('id', userId)
      .eq('neural_chars_remaining', row.neural_chars_remaining)
      .select('neural_chars_remaining');
    if (data && data.length) return;
  }
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

  if (engine === 'openai' && text.length > OPENAI_MAX_CHARS) {
    return res.status(400).json({ error: `Text is too long for OpenAI voices (${text.length} characters, limit ${OPENAI_MAX_CHARS}).` });
  }

  if (!['openai', 'elevenlabs', 'google'].includes(engine)) {
    return res.status(400).json({ error: `Unsupported engine: ${engine}` });
  }

  // ElevenLabs is bring-your-own-key only: say so before any sign-in or quota checks
  if (engine === 'elevenlabs' && !customElevenKey) {
    return res.status(400).json({ error: 'ElevenLabs voices need your own ElevenLabs API key. Add it in Options.' });
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
      user = await verifyUser(supabase, token);
      if (!user) {
        return res.status(401).json({ error: 'Invalid or expired user session.' });
      }

      const { data: profile } = await supabase
        .from('profiles')
        .select('neural_chars_remaining, tier, pro_expires_at')
        .eq('id', user.id)
        .single();

      remainingChars = profile?.neural_chars_remaining ?? FREE_NEURAL_CHARS;
      if (profile?.tier === 'pro' && !isProActive(profile)) {
        // Expired Pro: restore free quotas so a stale top-up cannot outlive the subscription
        await downgradeExpiredPro(supabase, user.id);
        remainingChars = FREE_NEURAL_CHARS;
      }
      if (remainingChars < charCount) {
        return res.status(402).json({
          error: `Insufficient neural character quota (${remainingChars.toLocaleString()} left). Add your API key in Options or upgrade.`,
          charsExhausted: true
        });
      }
    }

    // Reserve the characters at the same time as generating the audio (saves a database round trip
    // per sentence). If generating fails, they are given back.
    const reserve = (!isByok && user && remainingChars !== null)
      ? deductChars(getSupabase(), user.id, remainingChars, charCount)
      : null;

    let audio = null;
    try {
      if (engine === 'openai') {
        audio = await synthOpenAI({ text, voiceId, speed, customKey: customOpenAiKey });
      } else if (engine === 'elevenlabs') {
        audio = await synthElevenLabs({ text, voiceId, customKey: customElevenKey });
      } else if (engine === 'google') {
        audio = await synthGoogle({ text, voiceId, speed });
      } else {
        throw new HttpError(400, `Unsupported engine: ${engine}`);
      }
      if (!audio || !audio.length) throw new HttpError(502, 'The voice provider returned no audio.');
    } catch (err) {
      if (reserve) {
        // awaited (not fire-and-forget): a serverless function can be frozen right after it responds
        try { await reserve; await refundChars(getSupabase(), user.id, charCount); } catch (e) {}
      }
      throw err;
    }

    const updatedRemaining = reserve ? await reserve : remainingChars;
    const remainingForClient = isByok ? 'Unlimited (BYOK)' : updatedRemaining;

    res.setHeader('Cache-Control', 'no-store');

    // The app asks for the raw mp3 (smaller and faster than base64 JSON)
    const accept = String(req.headers.accept || '');
    if (accept.includes('audio/mpeg') && !accept.includes('application/json')) {
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', audio.length);
      res.setHeader('X-Remaining-Chars', String(remainingForClient));
      return res.status(200).send(audio);
    }

    return res.status(200).json({
      audio_base64: audio.toString('base64'),
      remaining_chars: remainingForClient
    });

  } catch (err) {
    console.error('TTS error:', err);
    return res.status(err.status || 500).json({ error: err.message || 'Internal server error generating audio' });
  }
}
