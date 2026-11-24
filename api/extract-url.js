// api/extract-url.js
//
// Extracts readable web article content using @mozilla/readability and linkedom.
// Protected by IP-based rate limiting (15 req/min) and strict SSRF defenses.

import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import { enforceRateLimit, clientIp } from './_lib/rate-limit.js';
import { validatePublicUrl } from './_lib/ssrf.js';

const MAX_BODY_BYTES = 3 * 1024 * 1024; // 3 MB max body size
const FETCH_TIMEOUT_MS = 5000; // 5 seconds

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1. IP Rate Limiting (15 req/min)
  const gate = await enforceRateLimit(req, res, {
    tier: 'extract_url',
    identifiers: [{ bucket: 'ip', value: clientIp(req) }]
  });
  if (!gate.ok) return;

  const { url } = req.body || {};
  if (!url || typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'Missing or invalid "url" parameter.' });
  }

  // 2. Strict URL Validation & SSRF Prevention
  let parsedUrl;
  try {
    parsedUrl = await validatePublicUrl(url.trim());
  } catch (validationErr) {
    return res.status(400).json({ error: validationErr.message });
  }

  // 3. Fetch HTML with 5s timeout & 3MB max body limit
  let htmlText = '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(parsedUrl.toString(), {
      signal: controller.signal,
      headers: {
        'User-Agent': 'MarginaliaReader/1.0 (Mozilla/5.0 compatible; WebArticleExtractor)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    if (!response.ok) {
      return res.status(502).json({
        error: `Target server responded with HTTP ${response.status} (${response.statusText}).`
      });
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml') && !contentType.includes('text/plain')) {
      return res.status(415).json({
        error: `Unsupported content-type: "${contentType}". Only HTML articles can be imported.`
      });
    }

    const cl = response.headers.get('content-length');
    if (cl && parseInt(cl, 10) > MAX_BODY_BYTES) {
      return res.status(413).json({
        error: `Web page is too large (${Math.round(parseInt(cl, 10) / 1024)} KB, limit 3 MB).`
      });
    }

    // Stream body to enforce 3MB limit even if Content-Length was absent or wrong
    if (response.body) {
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_BODY_BYTES) {
          reader.cancel();
          return res.status(413).json({ error: 'Web page exceeded 3 MB maximum size limit.' });
        }
        chunks.push(value);
      }
      const combined = Buffer.concat(chunks);
      htmlText = new TextDecoder('utf-8').decode(combined);
    } else {
      htmlText = await response.text();
    }
  } catch (fetchErr) {
    if (fetchErr.name === 'AbortError') {
      return res.status(504).json({ error: 'Web page request timed out after 5 seconds.' });
    }
    return res.status(502).json({ error: `Failed to fetch web page: ${fetchErr.message}` });
  } finally {
    clearTimeout(timer);
  }

  // 4. Parse Main Article with @mozilla/readability + linkedom
  try {
    const { document } = parseHTML(htmlText);
    const reader = new Readability(document);
    const article = reader.parse();

    const title = (article?.title || document.title || 'Web Article').trim();
    const author = (article?.byline || '').trim() || null;
    const contentText = (article?.textContent || document.body?.textContent || '').replace(/\s+/g, ' ').trim();

    if (!contentText) {
      return res.status(422).json({ error: 'No readable article text could be found on this page.' });
    }

    return res.status(200).json({
      title,
      author,
      contentText
    });
  } catch (parseErr) {
    return res.status(500).json({ error: `Article parsing error: ${parseErr.message}` });
  }
}
