// api/_lib/supabase.js
//
// Supabase connection settings for the serverless routes, from the environment ONLY. (They used to
// also be accepted from request headers, which let anyone point this server at their own Supabase
// project and sign themselves in.)
//
// The URL is resolved one way for everybody. Only the key preference differs, because it is not the
// same credential: server routes act with the service-role key when one is configured (they read and
// write quota rows for other users), while /api/auth drives the GoTrue password endpoints exactly as
// the browser's anon client used to.
function resolveUrl() {
  const rawUrl = process.env.SUPABASE_URL ||
                 process.env.SUPABASE_PROJECT_URL ||
                 process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  try {
    if (rawUrl) return new URL(rawUrl.trim()).origin; // root origin only (drops /auth/v1, /rest/v1, trailing slashes)
  } catch (e) {
    // Not a URL: hand the trimmed value back so the route reports "not configured" rather than throwing.
  }
  return rawUrl.replace(/\/+$/, '');
}

function config(key) {
  return {
    url: resolveUrl(),
    key,
    hasServiceKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)
  };
}

// Server routes: the service-role key when it exists, otherwise the anon key (RLS then applies).
export function supabaseConfig() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  return config(serviceKey || process.env.SUPABASE_ANON_KEY || '');
}

// /api/auth: the anon key first, so sign-in cannot silently escalate to the service role.
export function supabaseAnonConfig() {
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  return config(anonKey || process.env.SUPABASE_SERVICE_ROLE_KEY || '');
}
