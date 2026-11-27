// The vision routes (/api/ocr, /api/describe-image) forward whatever image they are handed straight
// to OpenAI, and Vercel only refuses bodies over ~4.5 MB, so a 3 MB scan would still reach a paid
// call. Cap the image instead: 2 MB of base64 is roughly 1.5 MB of image bytes, and anything larger
// is refused before an AI op is spent.
export const MAX_IMAGE_BASE64_CHARS = 2 * 1024 * 1024;

// The mime type is caller-supplied and is pasted straight into a data: URL, so it is an allowlist
// entry rather than free text ("image/png;base64,…" or a non-image type would otherwise ride along).
const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export function normalizeImageMime(value) {
  const mime = String(value || '').trim().toLowerCase();
  return ALLOWED_IMAGE_MIME.has(mime) ? mime : 'image/jpeg';
}

/** True when the payload is raw base64 or a data: URL that really holds an image. */
export function isImagePayload(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (!raw.toLowerCase().startsWith('data:')) return true; // bare base64
  return /^data:image\/(jpeg|png|webp|gif);base64,/i.test(raw);
}
