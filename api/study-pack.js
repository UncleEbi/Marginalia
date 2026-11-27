// api/study-pack.js
//
// Generates and serves cryptographic shareable read-only Study Packs
// (text, margin notes, vocabulary, and summary) for viral campus sharing.
//
// Protected by IP-based rate limiting (15 req/min) and max 2MB payload cap.

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { enforceRateLimit, clientIp } from './_lib/rate-limit.js';
import { supabaseConfig } from './_lib/supabase.js';
import { appOrigin } from './_lib/app-origin.js';

const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_TITLE_CHARS = 300;
const MAX_PAGES = 5000;
// Tokens are minted below as 16 base64url characters. Anything else is not a token this service
// issued, so it is refused before it becomes a database lookup.
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limit all requests (15 req/min per IP)
  const gate = await enforceRateLimit(req, res, {
    tier: 'study_pack',
    identifiers: [{ bucket: 'ip', value: clientIp(req) }]
  });
  if (!gate.ok) return;

  if (req.method === 'POST') {
    return handleCreate(req, res);
  } else {
    return handleGet(req, res);
  }
}

async function handleCreate(req, res) {
  const body = req.body || {};
  const rawSize = JSON.stringify(body).length;
  if (rawSize > MAX_PAYLOAD_BYTES) {
    return res.status(413).json({ error: 'Study pack exceeds 2 MB size limit.' });
  }

  const { doc_title, pack_type, payload } = body;
  if (!doc_title || typeof doc_title !== 'string' || !doc_title.trim()) {
    return res.status(400).json({ error: 'Missing or invalid "doc_title".' });
  }
  if (doc_title.trim().length > MAX_TITLE_CHARS) {
    return res.status(400).json({ error: `"doc_title" is too long (limit ${MAX_TITLE_CHARS}).` });
  }
  if (!payload || typeof payload !== 'object' || !payload.pages || !Array.isArray(payload.pages)) {
    return res.status(400).json({ error: 'Invalid study pack payload: "pages" array is required.' });
  }
  if (payload.pages.length === 0 || payload.pages.length > MAX_PAGES) {
    return res.status(400).json({ error: `Invalid study pack payload: "pages" must hold 1-${MAX_PAGES} entries.` });
  }

  const { url, key } = supabaseConfig();
  if (!url || !key) {
    return res.status(503).json({ error: 'Database service is not configured.' });
  }

  const supabase = createClient(url, key);

  // Optional user identification via Bearer token
  let createdBy = null;
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    try {
      const { data } = await supabase.auth.getUser(token);
      if (data?.user?.id) createdBy = data.user.id;
    } catch {}
  }

  // Generate cryptographically secure share token (16-char base64url string)
  const shareToken = crypto.randomBytes(12).toString('base64url');

  const insertData = {
    share_token: shareToken,
    created_by: createdBy,
    doc_title: doc_title.trim(),
    // Free text from the body becomes an enum-like label the client renders: keep it a short string.
    pack_type: typeof pack_type === 'string' && pack_type.trim()
      ? pack_type.trim().slice(0, 40)
      : 'chapter',
    payload,
    views_count: 0
  };

  const { error } = await supabase
    .from('study_packs')
    .insert(insertData);

  if (error) {
    console.error('Error creating study pack:', error);
    return res.status(500).json({ error: 'Could not create study pack. Please try again.' });
  }

  // Never build a share link from the request's Origin/Host: a forged header would produce a link
  // that sends the token to someone else's domain.
  const shareUrl = `${appOrigin(req)}/?pack=${shareToken}`;

  return res.status(200).json({
    ok: true,
    shareToken,
    shareUrl
  });
}

async function handleGet(req, res) {
  const token = req.query?.token;
  if (!token || typeof token !== 'string' || !token.trim()) {
    return res.status(400).json({ error: 'Missing "token" query parameter.' });
  }
  if (!SHARE_TOKEN_PATTERN.test(token.trim())) {
    return res.status(400).json({ error: 'Invalid "token" query parameter.' });
  }

  const { url, key } = supabaseConfig();
  if (!url || !key) {
    return res.status(503).json({ error: 'Database service is not configured.' });
  }

  const supabase = createClient(url, key);

  const { data, error } = await supabase
    .from('study_packs')
    .select('share_token, doc_title, pack_type, payload, views_count, created_at')
    .eq('share_token', token.trim())
    .maybeSingle();

  if (error) {
    console.error('Error fetching study pack:', error);
    return res.status(500).json({ error: 'Could not fetch study pack.' });
  }

  if (!data) {
    return res.status(404).json({ error: 'Study pack not found or link has expired.' });
  }

  // Increment views count non-blockingly
  try {
    supabase
      .from('study_packs')
      .update({ views_count: (data.views_count || 0) + 1 })
      .eq('share_token', token.trim())
      .then(() => {})
      .catch(() => {});
  } catch {}

  return res.status(200).json({
    ok: true,
    pack: {
      doc_title: data.doc_title,
      pack_type: data.pack_type,
      payload: data.payload,
      views_count: (data.views_count || 0) + 1,
      created_at: data.created_at
    }
  });
}
