// api/_lib/app-origin.js
//
// The one public origin this deployment links back to.
//
// Anything that mints a link for a human — a Study Pack share URL, the Paystack callback after a
// payment — used to be built from the request's Origin (or, worse, its Host) header. Those headers
// are supplied by the caller: a forged Origin meant a share link pointing at a lookalike site that
// receives the token, and a payment that redirects off-site afterwards. Neither is a link this
// server should ever produce, so the origin is configuration, not input.
//
// Set APP_ORIGIN (comma-separated for extra hosts, e.g. a staging domain) in the deployment. The
// first entry is canonical. Without it, the production deployment's own origin is used.
const DEFAULT_APP_ORIGIN = 'https://marginalia-rme.vercel.app';

function normalizeOrigin(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : '';
  } catch {
    return '';
  }
}

function configuredOrigins() {
  return String(process.env.APP_ORIGIN || process.env.PUBLIC_APP_ORIGIN || '')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean);
}

/**
 * The origin this deployment owns, never one the caller chose. A request's Origin is honoured only
 * when it is one of the configured origins, so a same-site deployment (staging, a custom domain)
 * keeps its own links while anything else falls back to the canonical one.
 */
export function appOrigin(req) {
  const configured = configuredOrigins();
  const canonical = configured[0] || DEFAULT_APP_ORIGIN;
  const allowed = new Set([DEFAULT_APP_ORIGIN, ...configured]);

  const headers = (req && req.headers) || {};
  const requested = normalizeOrigin(Array.isArray(headers.origin) ? headers.origin[0] : headers.origin);
  return requested && allowed.has(requested) ? requested : canonical;
}
