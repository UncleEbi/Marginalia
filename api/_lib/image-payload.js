// The vision routes (/api/ocr, /api/describe-image) forward whatever image they are handed straight
// to OpenAI, and Vercel only refuses bodies over ~4.5 MB, so a 3 MB scan would still reach a paid
// call. Cap the image instead: 2 MB of base64 is roughly 1.5 MB of image bytes, and anything larger
// is refused before an AI op is spent.
export const MAX_IMAGE_BASE64_CHARS = 2 * 1024 * 1024;
