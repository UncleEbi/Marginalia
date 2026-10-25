// public/pdf-extract.js  Self-contained: this module imports nothing, so it loads anywhere.
// pdf.js itself comes from the caller: index.html imports the one pinned version (PDFJS_VERSION)
// and passes it in, and the tests pass pdfjs-dist from node_modules the same way. A second, static
// CDN import here would (a) pin a second version that can drift from the pinned one, and (b) make
// this file impossible to import in Node, which is exactly what the PDF test suites do.

/**
 * Safely creates an independent copy of an ArrayBuffer or TypedArray
 * so PDF.js workers cannot detach or zero out the caller's memory.
 */
function clonePdfData(data) {
  if (data instanceof ArrayBuffer) {
    return data.slice(0);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  return data;
}

const LIB_REQUIRED = 'A PDF.js library instance is required to read this PDF.';

/**
 * True when the first argument was meant to be the library but cannot read PDFs (no getDocument),
 * as opposed to being the document data of the one-argument form.
 */
function isInvalidLibArg(arg) {
  if (!arg || typeof arg !== 'object' || typeof arg.getDocument === 'function') return false;
  return !(arg instanceof ArrayBuffer) && !ArrayBuffer.isView(arg);
}

/**
 * The library always comes from the caller: the pinned instance index.html loaded, otherwise
 * window.pdfjsLib for the one-argument form. There is no hidden copy behind this file.
 */
function resolveLib() {
  if (typeof window !== 'undefined' && window.pdfjsLib && typeof window.pdfjsLib.getDocument === 'function') {
    return window.pdfjsLib;
  }
  throw new Error(LIB_REQUIRED);
}

export async function extractPdfTexts(libOrData, dataOrOptions, maybeOptions) {
  let lib, data, options;

  // Handle both signatures:
  // Signature A: extractPdfTexts(pdfjsLib, data, options)
  // Signature B: extractPdfTexts(data, options)
  if (libOrData && typeof libOrData.getDocument === 'function') {
    lib = libOrData;
    data = dataOrOptions;
    options = maybeOptions || {};
  } else {
    if (isInvalidLibArg(libOrData)) throw new Error(LIB_REQUIRED);
    lib = resolveLib();
    data = libOrData;
    options = dataOrOptions || {};
  }

  const safeData = clonePdfData(data);
  const doc = await lib.getDocument({ data: safeData, ...options }).promise;
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
    if (typeof doc.destroy === 'function') {
      try { await doc.destroy(); } catch (e) {}
    }
  }

  return pages;
}

export async function renderPdfPagesToImages(libOrData, dataOrOptions, maybeOptions) {
  let lib, data, options;

  if (libOrData && typeof libOrData.getDocument === 'function') {
    lib = libOrData;
    data = dataOrOptions;
    options = maybeOptions || {};
  } else {
    if (isInvalidLibArg(libOrData)) throw new Error(LIB_REQUIRED);
    lib = resolveLib();
    data = libOrData;
    options = dataOrOptions || {};
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

  const safeData = clonePdfData(data);
  const doc = await lib.getDocument({ data: safeData, ...getDocumentOptions }).promise;

  try {
    const images = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const natural = page.getViewport({ scale: 1 });
      const scale = Math.max(0.4, Math.min(2.5, maxWidth / natural.width));
      const viewport = page.getViewport({ scale });
      const canvas = makeCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Could not create canvas to render the PDF page.');

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvas, canvasContext: ctx, viewport, background: '#ffffff' }).promise;
      images.push({ pageNumber, dataUrl: canvas.toDataURL('image/jpeg', quality) });
      if (onPage) await onPage(pageNumber, doc.numPages);
    }
    return images;
  } finally {
    if (typeof doc.destroy === 'function') {
      try { await doc.destroy(); } catch (e) {}
    }
  }
}

// Aliases for casing compatibility
export { extractPdfTexts as extractpdftexts };
export { renderPdfPagesToImages as renderpdfpagestoimages };
