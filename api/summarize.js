// api/summarize.js
//
// Contract with the app:
//   POST { text, mode }            mode: 'chapter' | 'key_takeaways'
//   headers: Authorization (Supabase session) or x-custom-openai-key (user's own key)
//   200 -> { summary, summaries_remaining, unlimited, byok }
//   401 sign-in needed | 402 free trial used up ({ trialExhausted: true }) | 500/502 server or provider problem
import { createClient } from '@supabase/supabase-js';
import { isProActive, downgradeExpiredPro } from '../lib/pro-plan.js';

const FREE_TRIAL_SUMMARIES = 3;

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Supabase settings come from the server's environment ONLY. (They used to also be accepted from request
// headers, which would let anyone point this server at their own Supabase project and sign themselves in.)
function supabaseConfig() {
  const rawUrl = process.env.SUPABASE_URL ||
                 process.env.SUPABASE_PROJECT_URL ||
                 process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  let url = '';
  try {
    if (rawUrl) url = new URL(rawUrl.trim()).origin; // root origin only (drops /auth/v1, /rest/v1, trailing slashes)
  } catch (e) {
    url = rawUrl.replace(/\/+$/, '');
  }
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const key = serviceKey || process.env.SUPABASE_ANON_KEY || '';
  return { url, key, hasServiceKey: Boolean(serviceKey) };
}

// Changes a free user's remaining AI summaries by `delta` (-1 to use one, +1 to give one back).
// It only writes if the number is still what we read, and retries otherwise, so two summaries
// requested at once can't both use the last credit (or overwrite each other's count).
// Returns the new balance, or null when delta is negative and nothing is left.
async function changeCredits(db, userId, delta) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: row, error: readErr } = await db
      .from('profiles')
      .select('summary_credits_remaining')
      .eq('id', userId)
      .maybeSingle();
    if (readErr || !row) throw new HttpError(500, 'Could not read your account. Please try again.');

    const current = row.summary_credits_remaining ?? FREE_TRIAL_SUMMARIES;
    if (delta < 0 && current <= 0) return null;
    const next = Math.max(0, current + delta);

    let q = db.from('profiles').update({ summary_credits_remaining: next }).eq('id', userId);
    q = row.summary_credits_remaining == null
      ? q.is('summary_credits_remaining', null)
      : q.eq('summary_credits_remaining', current);
    const { data, error } = await q.select('summary_credits_remaining');
    if (error) throw new HttpError(500, 'Could not update your summary balance. Please try again.');
    if (data && data.length) return next;
    // someone else changed the balance first: read again and retry
  }
  throw new HttpError(500, 'Summary balance is busy. Please try again.');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const text = typeof body.text === 'string' ? body.text : '';
  const mode = body.mode === 'key_takeaways' ? 'key_takeaways' : 'chapter';
  const customOpenAiKey = req.headers['x-custom-openai-key'];
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');

  if (!text.trim()) {
    return res.status(400).json({ error: 'No text provided for summarization.' });
  }

  const isByok = Boolean(customOpenAiKey);
  let db = null;
  let userId = null;
  let isPro = false;
  let reservedCredit = false;
  let summariesRemaining = null;

  try {
    // 1. Sign-in and quota, unless the user brings their own OpenAI key
    if (!isByok) {
      if (!token) {
        throw new HttpError(401, 'No active session token. Please sign in.');
      }

      const { url, key, hasServiceKey } = supabaseConfig();
      if (!url || !key) {
        throw new HttpError(500, 'Backend error: Supabase URL or Key is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel.');
      }

      const authClient = createClient(url, key);
      const { data: authData, error: authErr } = await authClient.auth.getUser(token);
      if (authErr || !authData?.user) {
        throw new HttpError(401, authErr?.message
          ? `Authentication error: ${authErr.message}. Please sign in again.`
          : 'Invalid or expired user session. Please sign in again.');
      }
      const user = authData.user;
      userId = user.id;

      // Admin client if a service key exists, otherwise a client acting as the signed-in user
      db = hasServiceKey
        ? createClient(url, key)
        : createClient(url, key, { global: { headers: { Authorization: `Bearer ${token}` } } });

      const { data: profile, error: profileErr } = await db
        .from('profiles')
        .select('tier, pro_expires_at')
        .eq('id', userId)
        .maybeSingle();
      // A failed read must never be treated as "no profile": writing a fresh row could reset a Pro user to free
      if (profileErr) {
        const missingColumn = /pro_expires_at/i.test(profileErr.message || '');
        throw new HttpError(500, 'Could not read your account. Please try again.' + (missingColumn
          ? ' (profiles is missing pro_expires_at — run the SQL migration in supabase/migrations/ first.)'
          : ''));
      }

      if (!profile) {
        // First visit: create the row. ignoreDuplicates means an existing row is never overwritten.
        const { error: insertErr } = await db.from('profiles').upsert({
          id: userId,
          email: user.email,
          summary_credits_remaining: FREE_TRIAL_SUMMARIES,
          neural_chars_remaining: 5000,
          tier: 'free'
        }, { onConflict: 'id', ignoreDuplicates: true });
        if (insertErr) throw new HttpError(500, 'Could not set up your account. Please try again.');
      }

      isPro = isProActive(profile);
      if (profile?.tier === 'pro' && !isPro) {
        // Pro has expired: flip the row back to free and restore the free quotas (best effort)
        await downgradeExpiredPro(db, userId);
      }

      // 2. Use up one free summary BEFORE generating it (given back below if generation fails)
      if (!isPro) {
        summariesRemaining = await changeCredits(db, userId, -1);
        if (summariesRemaining === null) {
          throw new HttpError(402,
            'Free trial summaries exhausted. Add an OpenAI key in Options or upgrade to Pro.',
            { trialExhausted: true, summaries_remaining: 0 });
        }
        reservedCredit = true;
      }
    }

    // 3. Generate the summary
    const apiKey = customOpenAiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new HttpError(500, 'No OpenAI API key found. Add OPENAI_API_KEY in Vercel or enter your key in Options.');
    }

    const model = (process.env.OPENAI_SUMMARY_MODEL || 'gpt-4o-mini').trim();
    const systemPrompt = "You are an executive reading companion. Summarize the text clearly and naturally so it flows smoothly when read aloud via text-to-speech narration. Avoid markdown bullet symbols, asterisks, or raw symbols that sound clunky when read by audio engines.";
    const userPrompt = mode === 'key_takeaways'
      ? `Extract the essential key takeaways and high-level themes of this document into 3 to 5 concise, narratable paragraphs:\n\n${text.slice(0, 45000)}`
      : `Summarize this section into a focused, natural narrative summary in 2 to 3 paragraphs:\n\n${text.slice(0, 25000)}`;

    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        ...(model.startsWith('gpt-4') ? { temperature: 0.4 } : {})
      })
    });

    if (!aiRes.ok) {
      const err = await aiRes.text();
      throw new HttpError(502, `OpenAI API error (${aiRes.status}): ${err.slice(0, 500)}`);
    }

    const aiData = await aiRes.json();
    const summary = aiData.choices?.[0]?.message?.content?.trim();
    if (!summary) throw new HttpError(502, 'AI returned an empty response.');

    return res.status(200).json({
      summary,
      summaries_remaining: isPro || isByok ? null : summariesRemaining,
      unlimited: isPro || isByok,
      byok: isByok
    });

  } catch (err) {
    // A summary the user never received must not cost them a credit (awaited: a serverless function can be frozen after it responds)
    if (reservedCredit && !(err instanceof HttpError && err.status === 402)) {
      try { await changeCredits(db, userId, +1); } catch (e) {}
    }
    const status = err instanceof HttpError ? err.status : 500;
    if (!(err instanceof HttpError)) console.error('Summarize error:', err);
    return res.status(status).json({
      error: err instanceof HttpError ? err.message : (err.message || 'Internal server error while summarizing.'),
      ...(err instanceof HttpError ? err.extra : {})
    });
  }
}
