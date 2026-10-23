// public/pdf-extract.js
//
// PDF text extraction lives in its own ES module for two reasons:
//   1. pdf.js v4 and newer ship ES modules only — the old `pdf.min.js` global (UMD) build no longer
//      exists, so the library has to be imported from a module script anyway;
//   2. it can be unit-tested in Node against the same pdfjs-dist version the browser loads.
//
// `pdfjsLib` is injected rather than imported: the browser passes the CDN import from the module
// script in index.html, while the tests pass pdfjs-dist.
//
// Returns [{ pageNumber, text }] for the pages that contain extractable text. Pages with no text
// (scans, full-page images) are skipped; an empty array means the PDF has no digital text at all.

// `options` is passed through to pdf.js getDocument() — the browser uses it for standardFontDataUrl.
export async function extractPdfTexts(pdfjsLib, data, options = {}) {
  if (!pdfjsLib || typeof pdfjsLib.getDocument !== 'function') {
    throw new Error('A PDF.js library instance is required to read PDFs.');
  }

  const doc = await pdfjsLib.getDocument({ data, ...options }).promise;
  const pages = [];

  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => (typeof item.str === 'string' ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) pages.push({ pageNumber, text });
    }
  } finally {
    // Release the worker/transport as soon as the text is out — the app no longer needs the document
    if (typeof doc.destroy === 'function') {
      try { await doc.destroy(); } catch (e) { /* nothing useful to do if teardown fails */ }
    }
  }

  return pages;
}

// Renders every page to a JPEG data URL so a flat image scan (no text layer) can be transcribed by
// vision OCR instead of being rejected as unreadable.
//
// `createCanvas` and `onPage` are injectable: Node tests pass a fake canvas (there is no DOM there)
// and the reader passes a progress callback. Everything else is passed through to getDocument().
export async function renderPdfPagesToImages(pdfjsLib, data, options = {}) {
  if (!pdfjsLib || typeof pdfjsLib.getDocument !== 'function') {
    throw new Error('A PDF.js library instance is required to render PDF pages.');
  }

  const {
    createCanvas,
    onPage,
    maxWidth = 1600,
    quality = 0.78,
    ...getDocumentOptions
  } = options;

  const makeCanvas = createCanvas || ((width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  });

  const doc = await pdfjsLib.getDocument({ data, ...getDocumentOptions }).promise;

  try {
    const images = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const natural = page.getViewport({ scale: 1 });
      // Render at roughly `maxWidth` CSS pixels: wide enough for vision OCR to read small print,
      // small enough that the JPEG stays well under Vercel's request-body limit.
      const scale = Math.max(0.4, Math.min(2.5, maxWidth / natural.width));
      const viewport = page.getViewport({ scale });
      const canvas = makeCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('This browser could not create a canvas to render the PDF page.');

      // Scans often sit on a transparent page box; paint it white so the JPEG never has black text
      // on a black/transparent background.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvas, canvasContext: ctx, viewport, background: '#ffffff' }).promise;
      images.push({ pageNumber, dataUrl: canvas.toDataURL('image/jpeg', quality) });
      if (onPage) await onPage(pageNumber, doc.numPages);
    }
    return images;
  } finally {
    if (typeof doc.destroy === 'function') {
      try { await doc.destroy(); } catch (e) { /* nothing useful to do if teardown fails */ }
    }
  }
}
