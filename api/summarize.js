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
  AI_OPS_MONTHLY_COL, AI_OPS_TOPUP_COL, bothBucketsEmpty, monthlyAllowance
} from '../lib/quota-ops.js';

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

// ----------------------------------------------------------------
// Two-bucket AI-ops deduction (monthly allowance first, then top-up)
// ----------------------------------------------------------------

// A single AI operation consumes exactly 1 op. This is the pay-per-use unit for summaries and OCR.
const OPS_PER_SUMMARY = 1;

/**
 * Read both AI-ops columns for a user.
 */
async function readAiOps(supabase, userId) {
  const { data: row, error } = await supabase
    .from('profiles')
    .select(`${AI_OPS_MONTHLY_COL}, ${AI_OPS_TOPUP_COL}`)
    .eq('id', userId)
    .single();
  if (error || !row) return null;
  return {
    monthly: row[AI_OPS_MONTHLY_COL] ?? null,
    topup: row[AI_OPS_TOPUP_COL] ?? null
  };
}

/**
 * Drain 1 AI op against the two-bucket model, retrying on conflict.
 */
async function deductAiOp(supabase, userId, monthlyRemaining, topupRemaining) {
  const monthCol = AI_OPS_MONTHLY_COL;
  const topupCol = AI_OPS_TOPUP_COL;

  for (let attempt = 0; attempt < 5; attempt++) {
    const m = typeof monthlyRemaining === 'number' ? monthlyRemaining : null;
    const t = typeof topupRemaining === 'number' ? topupRemaining : null;

    const {
      monthlyTaken,
      topupTaken,
      monthlyRemaining: afterMonth,
      topupRemaining: afterTopup
    } = reduceAiOp({ monthlyRemaining: m, topupRemaining: t, requested: OPS_PER_SUMMARY });

    if (monthlyTaken == null || topupTaken == null) {
      // This branch is reached when the CAS update did not land. Re-read and retry.
      const fresh = await readAiOps(supabase, userId);
      if (!fresh) {
        // No row or a freshly-created free row: fall back to the caller's snapshot.
        return reduceAiOp({ monthlyRemaining, topupRemaining, requested: OPS_PER_SUMMARY });
      }
      monthlyRemaining = fresh.monthly;
      topupRemaining = fresh.topup;
      continue;
    }

    let q = supabase
      .from('profiles')
      .update({
        [monthCol]: afterMonth,
        [topupCol]: afterTopup
      })
      .eq('id', userId);

    if (monthlyRemaining != null) q = q.eq(monthCol, monthlyRemaining);
    if (topupRemaining != null) q = q.eq(topupCol, topupRemaining);

    const { data, error } = await q.select(`${monthCol}, ${topupCol}`);
    if (error) return reduceAiOp({ monthlyRemaining, topupRemaining, requested: OPS_PER_SUMMARY });
    if (data && data.length) {
      return {
        monthlyRemaining: data[0][monthCol],
        topupRemaining: data[0][topupCol]
      };
    }
    // conflict again: re-read and retry
    const fresh = await readAiOps(supabase, userId);
    if (!fresh) return reduceAiOp({ monthlyRemaining, topupRemaining, requested: OPS_PER_SUMMARY });
    monthlyRemaining = fresh.monthly;
    topupRemaining = fresh.topup;
  }

  // Exhausted retries: use the snapshot rather than failing a summary the user already requested.
  return reduceAiOp({ monthlyRemaining, topupRemaining, requested: OPS_PER_SUMMARY });
}

/**
 * Pure arithmetic: deduct one AI op, monthly bucket first, then top-up.
 */
function reduceAiOp({ monthlyRemaining, topupRemaining, requested }) {
  const rm = typeof monthlyRemaining === 'number' ? Math.max(0, monthlyRemaining) : 0;
  const rt = typeof topupRemaining === 'number' ? Math.max(0, topupRemaining) : 0;

  // monthly first
  const fromMonth = Math.min(rm, requested);
  const afterMonth = rm - fromMonth;
  const leftover = requested - fromMonth;

  // then top-up
  const fromTopup = Math.min(rt, leftover);
  const afterTopup = rt - fromTopup;

  return {
    monthlyTaken: fromMonth,
    topupTaken: fromTopup,
    monthlyRemaining: afterMonth,
    topupRemaining: afterTopup
  };
}

/**
 * Give an AI op back. Attempted only for a summary the user never received, so this is best-effort
 * and intentionally simple: it returns the op to whichever bucket is nonempty, preferring the monthly
 * bucket because that is where the pre-call snapshot is most reliable for a failed generation.
 */
async function refundAiOp(supabase, userId, monthlyRemaining, topupRemaining) {
  // Decide where the refund lands. If the monthly bucket already has room for the refund, put it there;
  // otherwise put it on the top-up bucket. This preserves the "monthly first" ordering without having
  // to replay the full split logic backwards.
  const rm = typeof monthlyRemaining === 'number' ? Math.max(0, monthlyRemaining) : 0;
  const rt = typeof topupRemaining === 'number' ? Math.max(0, topupRemaining) : 0;

  const targetMonthCol = rm < Number.MAX_SAFE_INTEGER / 2 ? AI_OPS_MONTHLY_COL : null;
  const targetTopupCol = (targetMonthCol ? false : true) ? AI_OPS_TOPUP_COL : null;

  // If both are finite, prefer the monthly bucket for the refund.
  const refundToMonth = targetMonthCol != null;
  const monthCol = refundToMonth ? AI_OPS_MONTHLY_COL : null;
  const topupCol = (refundToMonth ? false : true) ? AI_OPS_TOPUP_COL : null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: row, error: readErr } = await supabase
      .from('profiles')
      .select(`${AI_OPS_MONTHLY_COL}, ${AI_OPS_TOPUP_COL}`)
      .eq('id', userId)
      .single();

    if (readErr || !row) return;

    const currentMonth = row[AI_OPS_MONTHLY_COL] ?? null;
    const currentTopup = row[AI_OPS_TOPUP_COL] ?? null;

    let nextMonth = currentMonth;
    let nextTopup = currentTopup;
    let ok = false;

    if (monthCol && currentMonth != null && currentMonth >= 0) {
      nextMonth = currentMonth + OPS_PER_SUMMARY;
      ok = true;
    } else if (topupCol && currentTopup != null && currentTopup >= 0) {
      nextTopup = currentTopup + OPS_PER_SUMMARY;
      ok = true;
    }

    if (!ok) return;

    let q = supabase
      .from('profiles')
      .update({
        ...(monthCol ? { [monthCol]: nextMonth } : {}),
        ...(topupCol ? { [topupCol]: nextTopup } : {})
      })
      .eq('id', userId);

    if (monthCol && currentMonth != null) q = q.eq(monthCol, currentMonth);
    if (topupCol && currentTopup != null) q = q.eq(topupCol, currentTopup);

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
            summaries_remaining: 0
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
