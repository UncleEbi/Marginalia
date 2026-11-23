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

function groupIntoLines(items, tolerance = 3.5) {
  if (!items || items.length === 0) return [];
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const lines = [];
  for (const item of sorted) {
    let line = lines.find((l) => Math.abs(l.y - item.y) <= tolerance);
    if (!line) {
      line = { y: item.y, items: [] };
      lines.push(line);
    }
    line.items.push(item);
  }
  lines.sort((a, b) => b.y - a.y);
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
  }
  return lines;
}

function renderLines(lines) {
  if (!lines || lines.length === 0) return '';
  const lineTexts = [];
  for (const line of lines) {
    let lineStr = '';
    for (let i = 0; i < line.items.length; i++) {
      const item = line.items[i];
      if (i === 0) {
        lineStr += item.str;
      } else {
        const prev = line.items[i - 1];
        if (lineStr.endsWith(' ') || item.str.startsWith(' ')) {
          lineStr += item.str;
        } else {
          const gap = item.x - prev.right;
          if (gap > 1.5 || prev.width === 0) {
            lineStr += ' ' + item.str;
          } else {
            lineStr += item.str;
          }
        }
      }
    }
    lineStr = lineStr.trim();
    if (lineStr) lineTexts.push(lineStr);
  }

  let fullText = '';
  for (let i = 0; i < lineTexts.length; i++) {
    const cur = lineTexts[i];
    if (i === 0) {
      fullText = cur;
    } else {
      const prev = lineTexts[i - 1];
      if (/(\b[a-zA-Z]+)-$/.test(prev) && /^[a-z]/.test(cur)) {
        fullText = fullText.slice(0, -1) + cur;
      } else {
        fullText += ' ' + cur;
      }
    }
  }
  return fullText.replace(/\s+/g, ' ').trim();
}

export function processPageItems(rawItems, viewport, options = {}) {
  const { layoutAware = true, removeHeaders = true } = options;
  if (!rawItems || rawItems.length === 0) return '';

  if (!layoutAware) {
    return rawItems
      .map((item) => (typeof item?.str === 'string' ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const pageWidth = viewport && viewport.width ? viewport.width : 612;
  const pageHeight = viewport && viewport.height ? viewport.height : 792;
  const yTopCutoff = pageHeight * 0.94;
  const yBottomCutoff = pageHeight * 0.06;

  const validItems = [];
  for (const item of rawItems) {
    if (!item || typeof item.str !== 'string') continue;
    const str = item.str;
    if (!str.trim()) continue;
    const tx = Array.isArray(item.transform) ? item.transform[4] : 0;
    const ty = Array.isArray(item.transform) ? item.transform[5] : 0;
    const width = Number(item.width) || (str.length * 6);
    const height = Number(item.height) || (Array.isArray(item.transform) ? Math.abs(item.transform[3]) : 10);
    validItems.push({
      str,
      x: tx,
      y: ty,
      width,
      height,
      right: tx + width
    });
  }

  if (validItems.length === 0) return '';

  // Header and footer pruning
  let bodyItems = validItems;
  if (removeHeaders) {
    bodyItems = validItems.filter((item) => {
      if (item.y >= yTopCutoff) {
        if (/^\s*(page\s+)?(\d+|[ivxlcdm]+)(\s+of\s+\d+)?\s*$/i.test(item.str)) return false;
        if (item.str.length < 120 && item.y > pageHeight * 0.955) return false;
      }
      if (item.y <= yBottomCutoff) {
        if (/^\s*(page\s+)?(-?\s*\d+\s*-?|[ivxlcdm]+)(\s+of\s+\d+)?\s*$/i.test(item.str)) return false;
        if (/(©|\(c\)|copyright|doi:|issn|rights reserved)/i.test(item.str)) return false;
        if (item.str.length < 100 && item.y < pageHeight * 0.045) return false;
      }
      return true;
    });
    if (bodyItems.length === 0) bodyItems = validItems;
  }

  if (bodyItems.length < 6) {
    return renderLines(groupIntoLines(bodyItems));
  }

  const minX = Math.min(...bodyItems.map((it) => it.x));
  const maxX = Math.max(...bodyItems.map((it) => it.right));
  const contentWidth = maxX - minX;
  const midX = minX + contentWidth / 2;

  const leftCol = [];
  const rightCol = [];
  const spanning = [];

  for (const item of bodyItems) {
    if (item.width > contentWidth * 0.65 || (item.x < midX - 25 && item.right > midX + 25)) {
      spanning.push(item);
    } else if ((item.x + item.right) / 2 < midX) {
      leftCol.push(item);
    } else {
      rightCol.push(item);
    }
  }

  const isTwoColumn = leftCol.length >= 3 && rightCol.length >= 3 && (leftCol.length + rightCol.length) > spanning.length;

  if (!isTwoColumn) {
    return renderLines(groupIntoLines(bodyItems));
  }

  const colTopY = Math.max(
    Math.max(...leftCol.map((i) => i.y)),
    Math.max(...rightCol.map((i) => i.y))
  );
  const colBottomY = Math.min(
    Math.min(...leftCol.map((i) => i.y)),
    Math.min(...rightCol.map((i) => i.y))
  );

  const topSpanning = spanning.filter((i) => i.y >= colTopY - 10);
  const bottomSpanning = spanning.filter((i) => i.y <= colBottomY + 10);
  const midSpanning = spanning.filter((i) => i.y < colTopY - 10 && i.y > colBottomY + 10);

  const sections = [];
  if (topSpanning.length) sections.push(renderLines(groupIntoLines(topSpanning)));

  if (midSpanning.length === 0) {
    sections.push(renderLines(groupIntoLines(leftCol)));
    sections.push(renderLines(groupIntoLines(rightCol)));
  } else {
    const midY = midSpanning[0].y;
    const leftAbove = leftCol.filter((i) => i.y >= midY);
    const rightAbove = rightCol.filter((i) => i.y >= midY);
    const leftBelow = leftCol.filter((i) => i.y < midY);
    const rightBelow = rightCol.filter((i) => i.y < midY);

    if (leftAbove.length) sections.push(renderLines(groupIntoLines(leftAbove)));
    if (rightAbove.length) sections.push(renderLines(groupIntoLines(rightAbove)));
    sections.push(renderLines(groupIntoLines(midSpanning)));
    if (leftBelow.length) sections.push(renderLines(groupIntoLines(leftBelow)));
    if (rightBelow.length) sections.push(renderLines(groupIntoLines(rightBelow)));
  }

  if (bottomSpanning.length) sections.push(renderLines(groupIntoLines(bottomSpanning)));

  return sections.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
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

  const {
    layoutAware = true,
    removeHeaders = true,
    ...getDocumentOptions
  } = options;

  const safeData = clonePdfData(data);
  const doc = await lib.getDocument({ data: safeData, ...getDocumentOptions }).promise;
  const pages = [];

  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport ? page.getViewport({ scale: 1 }) : { width: 612, height: 792 };
      const content = await page.getTextContent();
      const text = processPageItems(content.items, viewport, { layoutAware, removeHeaders });
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
    onlyPage,         // optional 1-based page: render just that one (the scan shrink retry)
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
      if (onlyPage && pageNumber !== onlyPage) continue;
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
