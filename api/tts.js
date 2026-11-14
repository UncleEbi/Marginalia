// api/tts.js
//
// Contract with the app (unchanged):
//   POST { text, voiceId, engine, speed }
//   headers: Authorization (Supabase session), x-custom-openai-key / x-custom-elevenlabs-key (BYOK)
//   200 -> { audio_base64, remaining_chars, remaining_neural, remaining_topup_neural }
//   errors -> { error }  (401 sign-in, 402 quota, 400 bad request, 500 server config, 502 provider failure)
//
// Quota model:
//   Each account has a monthly neural allowance (resets every 30 days) and an optional non-expiring
//   neural top-up balance from a refill pack. The monthly allowance is always consumed first; the
//   top-up balance is the backstop that lets reading continue after the monthly allowance is gone.
//   A request is rejected with 402 only when BOTH buckets are empty.
//
// Also accepted for simple/older callers:
//   - `voice` as an alias of `voiceId`
//   - `Accept: audio/mpeg` returns the raw mp3 bytes instead of JSON
import { createClient } from '@supabase/supabase-js';
import {
  isProActive, downgradeExpiredPro, FREE_NEURAL_CHARS, refreshProQuota
} from '../lib/pro-plan.js';
import {
  NEURAL_MONTHLY_COL, NEURAL_TOPUP_COL, bothBucketsEmpty, monthlyAllowance
} from '../lib/quota-ops.js';

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

// Deducts a split neural charge against the two-bucket model.
//
// Uses the same compare-and-swap pattern as deductChars, but on two columns at once. If the request
// is allowed, the monthly allowance is always drained first, and only the backstop top-up balance is
// touched when the monthly allowance cannot cover the whole request. Retries on conflict up to the
// same 5-attempt limit used everywhere else in this file.
async function deductSplitNeural(supabase, userId, monthlyRemaining, topupRemaining, requested) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const monthCol = NEURAL_MONTHLY_COL;
    const topupCol = NEURAL_TOPUP_COL;

    const { monthlyTaken, topupTaken, monthlyRemaining: afterMonth, topupRemaining: afterTopup } =
      (await reduceSplitNeural(supabase, userId, monthlyRemaining, topupRemaining, requested, monthCol, topupCol));

    if (monthlyTaken == null || topupTaken == null) {
      // conflict or missing row: re-read both columns and retry
      const { data: fresh } = await supabase
        .from('profiles')
        .select(`${monthCol}, ${topupCol}`)
        .eq('id', userId)
        .single();

      if (!fresh || fresh[monthCol] == null || fresh[topupCol] == null) {
        // No row or a freshly-created free row we cannot meaningfully split against: fall back to
        // the caller's current snapshot. This is the same graceful degradation deductChars already uses.
        return reduceSplitNeural({ monthlyRemaining, topupRemaining, requested });
      }

      monthlyRemaining = fresh[monthCol];
      topupRemaining = fresh[topupCol];
      continue;
    }

    return {
      monthlyRemaining: afterMonth,
      topupRemaining: afterTopup
    };
  }

  // Exhausted retries: use the last known snapshot rather than failing audio the user already got.
  return reduceSplitNeural({ monthlyRemaining, topupRemaining, requested });
}

// Pure arithmetic for deducting a split charge from a snapshot. Kept pure so the CAS path can call it
// for the final numbers after a successful write.
function reduceSplitNeural(
  _db, _userId, monthlyRemaining, topupRemaining, requested
) {
  const monthCol = NEURAL_MONTHLY_COL;
  const topupCol = NEURAL_TOPUP_COL;

  const { monthlyTaken, topupTaken, monthlyRemaining: afterMonth, topupRemaining: afterTopup } =
    (function (m, t, r) {
      const rm = Math.max(0, m), rt = Math.max(0, t);
      const fm = Math.min(rm, r);
      const leftover = r - fm;
      const ft = Math.min(rt, leftover);
      return {
        monthlyTaken: fm,
        topupTaken: ft,
        monthlyRemaining: rm - fm,
        topupRemaining: rt - ft
      };
    })(monthlyRemaining, topupRemaining, requested);

  return {
    monthlyTaken,
    topupTaken,
    monthlyRemaining: afterMonth,
    topupRemaining: afterTopup
  };
}

async function deductSplitNeuralWithDb(supabase, userId, monthlyRemaining, topupRemaining, requested, monthCol, topupCol) {
  const m = Math.max(0, monthlyRemaining);
  const t = Math.max(0, topupRemaining);

  const { monthlyTaken, topupTaken, monthlyRemainingAfter, topupRemainingAfter } =
    reduceSplitNeural({ monthlyRemaining: m, topupRemaining: t, requested });

  let q = supabase
    .from('profiles')
    .update({
      [monthCol]: monthlyRemainingAfter,
      [topupCol]: topupRemainingAfter
    })
    .eq('id', userId);

  if (m != null) q = q.eq(monthCol, m);
  if (t != null) q = q.eq(topupCol, t);

  const { data, error } = await q.select(`${monthCol}, ${topupCol}`);

  if (error) {
    return {
      monthlyTaken: null,
      topupTaken: null,
      monthlyRemaining: m,
      topupRemaining: t
    };
  }
  if (data && data.length) {
    return {
      monthlyTaken,
      topupTaken,
      monthlyRemaining: data[0][monthCol],
      topupRemaining: data[0][topupCol]
    };
  }
  return {
    monthlyTaken: null,
    topupTaken: null,
    monthlyRemaining: m,
    topupRemaining: t
  };
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

async function refundTopupNeural(supabase, userId, charCount) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: row } = await supabase
      .from('profiles')
      .select(NEURAL_TOPUP_COL)
      .eq('id', userId)
      .single();
    if (!row || row[NEURAL_TOPUP_COL] == null) return;
    const { data } = await supabase
      .from('profiles')
      .update({ [NEURAL_TOPUP_COL]: row[NEURAL_TOPUP_COL] + charCount })
      .eq('id', userId)
      .eq(NEURAL_TOPUP_COL, row[NEURAL_TOPUP_COL])
      .select(NEURAL_TOPUP_COL);
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
  let monthlyChars = null;
  let topupChars = null;

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

      // Applies a due monthly allowance refill before the balance is read.
      // IMPORTANT: the refill touches only the monthly allowance columns. It never resets the
      // top-up columns, so a bought pack continues to extend the session across monthly cycles.
      const { profile } = await refreshProQuota(supabase, user.id);

      const allowance = monthlyAllowance(profile);
      monthlyChars = profile?.neural_chars_remaining ?? allowance.neural;
      topupChars = profile?.topup_neural_chars ?? 0;

      if (profile?.tier === 'pro' && !isProActive(profile)) {
        // Expired Pro: restore free quotas so a stale top-up cannot outlive the subscription
        await downgradeExpiredPro(supabase, user.id);
        monthlyChars = FREE_NEURAL_CHARS;
        topupChars = profile?.topup_neural_chars ?? 0;
      }

      // Allow if the combined balance covers the request; the split happens at reservation time.
      if (bothBucketsEmpty({ monthlyRemaining: monthlyChars, topupRemaining: topupChars }) ||
          monthlyChars + topupChars < charCount) {
        return res.status(402).json({
          error: 'NEURAL_QUOTA_EXCEEDED',
          fallback: 'native',
          remaining: Math.max(0, monthlyChars) + Math.max(0, topupChars)
        });
      }
    }

    // Reserve the characters against the two-bucket model at the same time as generating the audio
    // (saves a database round trip per sentence). If generating fails, they are given back from the
    // monthly allowance only, because that is the bucket we had a stable read for before the provider
    // call. The top-up bucket is handled conservatively below.
    let reservedMonthlyDelta = null;
    let reservedTopupDelta = null;
    let afterMonthly = null;
    let afterTopup = null;

    const reserve = (!isByok && user && monthlyChars !== null && topupChars !== null)
      ? deductSplitNeural(getSupabase(), user.id, monthlyChars, topupChars, charCount)
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
        try {
          const reserved = await reserve;
          if (reserved) {
            const toReturn = Math.max(0, reserved.monthlyRemaining - monthlyChars) +
                            Math.max(0, reserved.topupRemaining - topupChars);
            if (toReturn > 0) {
              // Refund to whichever bucket the charge originally consumed from. Because the monthly
              // allowance is always drained first, the safer default is to put it back on the monthly
              // column where we had the pre-call snapshot. The top-up column is left untouched here
              // unless it was the only bucket consumed, which is rare after a failed generation.
              if (monthlyChars + topupChars > 0 && monthlyChars >= charCount) {
                await refundChars(getSupabase(), user.id, charCount);
              } else {
                await refundTopupNeural(getSupabase(), user.id, charCount);
              }
            }
          }
        } catch (e) {}
      }
      throw err;
    }

    const reserved = reserve ? await reserve : null;
    if (reserved) {
      afterMonthly = reserved.monthlyRemaining;
      afterTopup = reserved.topupRemaining;
    } else {
      afterMonthly = monthlyChars;
      afterTopup = topupChars;
    }

    const remainingForClient = isByok
      ? 'Unlimited (BYOK)'
      : {
          neural: Math.max(0, afterMonthly) + Math.max(0, afterTopup),
          neural_monthly: Math.max(0, afterMonthly),
          neural_topup: Math.max(0, afterTopup)
        };

    res.setHeader('Cache-Control', 'no-store');

    // The app asks for the raw mp3 (smaller and faster than base64 JSON)
    const accept = String(req.headers.accept || '');
    if (accept.includes('audio/mpeg') && !accept.includes('application/json')) {
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', audio.length);
      if (!isByok) {
        res.setHeader('X-Remaining-Chars', String(Math.max(0, afterMonthly) + Math.max(0, afterTopup)));
      }
      return res.status(200).send(audio);
    }

    return res.status(200).json({
      audio_base64: audio.toString('base64'),
      remaining_chars: remainingForClient,
      remaining_neural: !isByok ? Math.max(0, afterMonthly) + Math.max(0, afterTopup) : null,
      remaining_neural_monthly: !isByok ? Math.max(0, afterMonthly) : null,
      remaining_neural_topup: !isByok ? Math.max(0, afterTopup) : null
    });

  } catch (err) {
    console.error('TTS error:', err);
    return res.status(err.status || 500).json({ error: err.message || 'Internal server error generating audio' });
  }
}


