// api/summarize.js
//
// Contract with the app:
//   POST { text, mode }            mode: 'chapter' | 'key_takeaways'
//   headers: Authorization (Supabase session) or x-custom-openai-key (user's own key)
//   200 -> { summary, summaries_remaining, summaries_monthly, summaries_topup, unlimited, byok }
//   401 sign-in needed | 402 AI quota used up ({ error: "AI_SUMMARY_QUOTA_EXCEEDED" }) | 500/502 server or provider problem
//
// Quota model:
//   Each account has a monthly AI-ops allowance (resets every 30 days) and an optional non-expiring
//   AI-ops top-up balance from a refill pack. The monthly allowance is always consumed first; the
//   top-up balance is the backstop that lets AI features continue after the monthly allowance is gone.
//   A request is rejected with 402 only when BOTH buckets are empty.
import { createClient } from '@supabase/supabase-js';
import {
  isProActive, downgradeExpiredPro, FREE_SUMMARY_CREDITS, refreshProQuota
} from '../lib/pro-plan.js';
import {
  AI_OPS_MONTHLY_COL, AI_OPS_TOPUP_COL, OPS_PER_SUMMARY, bothBucketsEmpty, deductAiOp, monthlyAllowance
} from '../lib/quota-ops.js';
import { enforceRateLimit, clientIp, keyFingerprint } from './_lib/rate-limit.js';
import { supabaseConfig } from './_lib/supabase.js';

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Input ceiling, checked before any rate-limit, auth or OpenAI work.
const MAX_SUMMARY_TEXT_CHARS = 25000;

/**
 * Give an AI op back. Attempted only for a summary the user never received, so this is best-effort
 * and intentionally simple: the op is returned to whichever bucket we had a stable pre-call snapshot
 * for. The monthly bucket is preferred because that is where the handler read before the provider
 * call; the top-up bucket is used only when monthly was already null/unknown.
 */
async function refundAiOp(supabase, userId, monthlyRemaining, topupRemaining) {
  const monthCol = typeof monthlyRemaining === 'number' ? AI_OPS_MONTHLY_COL : null;
  const topupCol = monthCol == null && typeof topupRemaining === 'number' ? AI_OPS_TOPUP_COL : null;

  if (!monthCol && !topupCol) return;

  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: row, error: readErr } = await supabase
      .from('profiles')
      .select(`${AI_OPS_MONTHLY_COL}, ${AI_OPS_TOPUP_COL}`)
      .eq('id', userId)
      .single();

    if (readErr || !row) return;

    const currentMonth = row[AI_OPS_MONTHLY_COL] ?? null;
    const currentTopup = row[AI_OPS_TOPUP_COL] ?? null;

    const update = {};
    let expected = {};

    if (monthCol && currentMonth != null) {
      update[monthCol] = currentMonth + OPS_PER_SUMMARY;
      expected[monthCol] = currentMonth;
    } else if (topupCol && currentTopup != null) {
      update[topupCol] = currentTopup + OPS_PER_SUMMARY;
      expected[topupCol] = currentTopup;
    } else {
      return;
    }

    let q = supabase
      .from('profiles')
      .update(update)
      .eq('id', userId);

    for (const [col, val] of Object.entries(expected)) {
      q = q.eq(col, val);
    }

    const { data, error } = await q.select(`${AI_OPS_MONTHLY_COL}, ${AI_OPS_TOPUP_COL}`);
    if (error) return;
    if (data && data.length) return;
  }
}

// ----------------------------------------------------------------
// Handler
// ----------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};

  // Strict payload validation first: nothing below this point may run for a request that is
  // already known to be malformed or oversized.
  if (typeof body.text !== 'string') {
    return res.status(400).json({ error: 'text must be a string.' });
  }
  const text = body.text;
  if (text.trim().length === 0) {
    return res.status(400).json({ error: 'No text provided for summarization.' });
  }
  if (text.length > MAX_SUMMARY_TEXT_CHARS) {
    return res.status(400).json({
      error: `Text is too long (${text.length} characters, limit ${MAX_SUMMARY_TEXT_CHARS}).`
    });
  }

  const mode = body.mode === 'key_takeaways' ? 'key_takeaways' : 'chapter';
  const customOpenAiKey = req.headers['x-custom-openai-key'];
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');

  const isByok = Boolean(customOpenAiKey);
  let db = null;
  let userId = null;
  let isPro = false;
  let reservedOp = null;
  let summariesRemaining = null;
  let summariesMonthly = null;
  let summariesTopup = null;

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

      // Rate limit immediately after the JWT is verified and before the quota read, so a burst of
      // summary requests costs nothing more than a counter check.
      const gate = await enforceRateLimit(req, res, {
        tier: 'summarize',
        identifiers: [
          { bucket: 'user', value: userId },
          { bucket: 'ip', value: clientIp(req) }
        ]
      });
      if (!gate.ok) return;

      // Admin client if a service key exists, otherwise a client acting as the signed-in user
      db = hasServiceKey
        ? createClient(url, key)
        : createClient(url, key, { global: { headers: { Authorization: `Bearer ${token}` } } });

      // Reads the profile and applies a due monthly allowance refill in the same step.
      // The refill touches only the monthly AI-ops allowance; it never resets the top-up balance.
      const { profile, error: profileErr } = await refreshProQuota(db, userId);
      // A failed read must never be treated as "no profile": writing a fresh row could reset a Pro user to free
      if (profileErr) {
        const missingColumn = /pro_expires_at/i.test(profileErr.message || '');
        throw new HttpError(500, 'Could not read your account. Please try again.' + (missingColumn
          ? ' (profiles is missing pro_expires_at, pro_tier or pro_quota_resets_at — run the SQL migrations in supabase/migrations/ first.)'
          : ''));
      }

      if (!profile) {
        // First visit: create the row. ignoreDuplicates means an existing row is never overwritten.
        const { error: insertErr } = await db.from('profiles').upsert({
          id: userId,
          email: user.email,
          summary_credits_remaining: FREE_SUMMARY_CREDITS,
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

      // Unverified free sign-ups are the classic way to farm host-funded AI credits, so they are
      // refused until the address is confirmed (or they pay, which Paystack verifies for us).
      if (!isPro && !user.email_confirmed_at) {
        throw new HttpError(403, 'EMAIL_VERIFICATION_REQUIRED');
      }

      const allowance = monthlyAllowance(profile);
      const monthlyOps = profile?.summary_credits_remaining ?? allowance.ops;
      const topupOps = profile?.topup_ai_ops ?? 0;

      // Allow only when the combined balance covers the operation.
      if (bothBucketsEmpty({ monthlyRemaining: monthlyOps, topupRemaining: topupOps }) ||
          monthlyOps + topupOps < OPS_PER_SUMMARY) {
        throw new HttpError(402,
          isPro
            ? "Your plan's AI summaries are used up. Renew your plan, buy a refill pack, or add an OpenAI key in Options."
            : 'Free trial summaries exhausted. Add an OpenAI key in Options, buy a refill pack, or upgrade to Pro.',
          {
            error: 'AI_SUMMARY_QUOTA_EXCEEDED',
            summaries_remaining: 0,
            summaries_monthly: 0,
            summaries_topup: 0
          });
      }

      // 2. Spend one AI op BEFORE generating it (given back below if generation fails).
      summariesMonthly = monthlyOps;
      summariesTopup = topupOps;
      const deducted = await deductAiOp(db, userId, monthlyOps, topupOps);
      summariesMonthly = deducted.monthlyRemaining;
      summariesTopup = deducted.topupRemaining;
      reservedOp = true;
      summariesRemaining = summariesMonthly + summariesTopup;
    } else {
      // BYOK summaries spend the reader's own OpenAI credits: limit the key fingerprint and the IP.
      const gate = await enforceRateLimit(req, res, {
        tier: 'summarize',
        identifiers: [
          { bucket: 'byok', value: keyFingerprint(customOpenAiKey) },
          { bucket: 'ip', value: clientIp(req) }
        ]
      });
      if (!gate.ok) return;
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
      summaries_remaining: isByok ? null : summariesRemaining,
      summaries_monthly: isByok ? null : Math.max(0, summariesMonthly),
      summaries_topup: isByok ? null : Math.max(0, summariesTopup),
      unlimited: isByok,
      byok: isByok
    });

  } catch (err) {
    // A summary the user never received must not cost them a credit (awaited: a serverless function can be frozen after it responds)
    if (reservedOp && !(err instanceof HttpError && err.status === 402)) {
      try {
        await refundAiOp(db, userId, summariesMonthly, summariesTopup);
      } catch (e) {}
    }
    const status = err instanceof HttpError ? err.status : 500;
    if (!(err instanceof HttpError)) console.error('Summarize error:', err);
    return res.status(status).json({
      error: err instanceof HttpError ? err.message : (err.message || 'Internal server error while summarizing.'),
      ...(err instanceof HttpError ? err.extra : {})
    });
  }
}
