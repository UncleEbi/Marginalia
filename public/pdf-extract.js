// public/pdf-extract.js  Self-contained: imports pdf.js directly, never depends on app.js passing window.pdfjsLib
import * as pdfjsDist from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs';

// Configure the worker immediately
if (!pdfjsDist.GlobalWorkerOptions.workerSrc) {
  pdfjsDist.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';
}

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

/**
 * Helper to get an active pdfjsLib instance whether passed as an argument or from the direct import.
 */
function resolveLib(passedLib) {
  if (passedLib && typeof passedLib.getDocument === 'function') {
    return passedLib;
  }
  if (window.pdfjsLib && typeof window.pdfjsLib.getDocument === 'function') {
    return window.pdfjsLib;
  }
  return pdfjsDist;
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
