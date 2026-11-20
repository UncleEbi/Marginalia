// api/geo.js
//
// Where the visitor is, so the app can price in the right currency without shipping a geo
// database to the browser. Price selection itself still happens server-side in
// api/paystack-init.js — this endpoint only tells the client which market it is in.
//
// Public and unauthenticated, so it is rate limited per IP. Anything tighter than 30/min would
// break normal use (the app asks once per session), and anything looser invites enumeration of
// the edge's geo header.
import { enforceRateLimit, clientIp } from './_lib/rate-limit.js';
import { currencyForCountry } from '../lib/pro-plan.js';

function countryFromRequest(req) {
  const headers = req.headers || {};
  return String(headers['x-vercel-ip-country'] || headers['cf-ipcountry'] || '').trim().toUpperCase();
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const gate = await enforceRateLimit(req, res, {
    tier: 'geo',
    identifiers: [{ bucket: 'ip', value: clientIp(req) }]
  });
  if (!gate.ok) return;

  const country = countryFromRequest(req);

  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json({
    country: country || null,
    currency: currencyForCountry(country)
  });
}
