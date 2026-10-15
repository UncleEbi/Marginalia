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
