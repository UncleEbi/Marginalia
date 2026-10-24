/**
 * Safely loads and processes a document, handling both standard text 
 * and flat image scans without detaching the source buffer.
 */
async function processDocument(fileOrBlob) {
  // 1. Read file as ArrayBuffer once
  const rawBuffer = await fileOrBlob.arrayBuffer();

  // 2. Clone the buffer using .slice(0)
  // PDF.js worker will consume and detach "pdfBufferCopy",
  // leaving "rawBuffer" completely intact.
  const pdfBufferCopy = new ArrayBuffer(rawBuffer.byteLength); new Uint8Array(pdfBufferCopy).set(new Uint8Array(rawBuffer));

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBufferCopy),
    // Ensures fonts and cMaps don't fail in web workers
    cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@legacy/cmaps/',
    cMapPacked: true,
  });

  const pdf = await loadingTask.promise;
  const numPages = pdf.numPages;
  const extractedPages = [];

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    
    // Extract textual tokens
    const textItems = textContent.items.map(item => item.str).join(' ').trim();

    // 3. Detect if this page is a flat image scan (zero or near-zero text)
    if (textItems.length < 30) {
      // Flat scan detected: render page to canvas and run OCR
      const ocrText = await renderPageAndRunOCR(page);
      extractedPages.push({
        pageNumber: pageNum,
        text: ocrText || "[No readable text found on scanned page]"
      });
    } else {
      extractedPages.push({
        pageNumber: pageNum,
        text: textItems
      });
    }
  }

  // 4. Save to IndexedDB using another safe slice or the original untouched buffer
  // Create independent copy for IndexedDB so rawBuffer stays intact after PDF processing
  const rawBufferCopy = new ArrayBuffer(rawBuffer.byteLength); new Uint8Array(rawBufferCopy).set(new Uint8Array(rawBuffer)); await saveToIndexedDB(fileOrBlob.name, new Uint8Array(rawBufferCopy), extractedPages);

  return extractedPages;
}

/**
 * Renders a PDF page to an offscreen canvas and extracts text using Tesseract.js
 */
async function renderPageAndRunOCR(page) {
  // Render at 2.0x scale for clear OCR recognition
  const viewport = page.getViewport({ scale: 2.0 });
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  canvas.width = viewport.width;
  canvas.height = viewport.height;

  await page.render({
    canvasContext: context,
    viewport: viewport
  }).promise;

  // Run Tesseract OCR on the canvas element directly
  if (window.Tesseract) {
    try {
      const { data: { text } } = await Tesseract.recognize(canvas, 'eng');
      return text.trim();
    } catch (err) {
      console.error('OCR processing error:', err);
      return '';
    }
  }
  return '';
}

// Named exports for backward compatibility with index.html and app.js import pattern:
export async function extractPdfTexts(pdfjsLib, data, options = {}) {
  // Use processDocument with a Blob/FILE input
  if (typeof data === 'string' || data instanceof Blob || data instanceof ArrayBuffer) {
    const fileOrBlob = data instanceof Blob ? data : new Blob([data]);
    const result = await processDocument(fileOrBlob);
    return result;
  }
  // Fallback: if data is already a Uint8Array or similar, create a minimal Blob
  return [];
}

export async function renderPdfPagesToImages(pdfjsLib, data, options = {}) {
  // Use renderPdfPagesToImages logic - render pages to canvas for OCR/vision
  if (typeof data === 'string' || data instanceof Blob || data instanceof ArrayBuffer) {
    const fileOrBlob = data instanceof Blob ? data : new Blob([data]);
    // Render pages to images for OCR
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(data),
      cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@legacy/cmaps/',
      cMapPacked: true,
    });
    const pdf = await loadingTask.promise;
    const images = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport, background: '#ffffff' }).promise;
      images.push({ pageNumber: pageNum, dataUrl: canvas.toDataURL('image/jpeg', 0.78) });
    }
    return images;
  }
  return [];
}

// New API exports:
export async function processDocument(fileOrBlob) {
  // 1. Read file as ArrayBuffer once
  const rawBuffer = await fileOrBlob.arrayBuffer();

  // 2. Clone the buffer using new ArrayBuffer() to create independent copies
  // PDF.js worker will consume and detach its copy, leaving rawBuffer completely intact.
  const pdfBufferCopy = new ArrayBuffer(rawBuffer.byteLength); new Uint8Array(pdfBufferCopy).set(new Uint8Array(rawBuffer));

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBufferCopy),
    // Ensures fonts and cMaps don't fail in web workers
    cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@legacy/cmaps/',
    cMapPacked: true,
  });

  const pdf = await loadingTask.promise;
  const numPages = pdf.numPages;
  const extractedPages = [];

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    
    // Extract textual tokens
    const textItems = textContent.items.map(item => item.str).join(' ').trim();

    // 3. Detect if this page is a flat image scan (zero or near-zero text)
    if (textItems.length < 30) {
      // Flat scan detected: render page to canvas and run OCR
      const ocrText = await renderPageAndRunOCR(page);
      extractedPages.push({
        pageNumber: pageNum,
        text: ocrText || "[No readable text found on scanned page]"
      });
    } else {
      extractedPages.push({
        pageNumber: pageNum,
        text: textItems
      });
    }
  }

  // 4. Save to IndexedDB using another safe slice or the original untouched buffer
  // Create independent copy for IndexedDB so rawBuffer stays intact after PDF processing
  const rawBufferCopy = new ArrayBuffer(rawBuffer.byteLength); new Uint8Array(rawBufferCopy).set(new Uint8Array(rawBuffer)); await saveToIndexedDB(fileOrBlob.name, new Uint8Array(rawBufferCopy), extractedPages);

  return extractedPages;
}

export async function renderPageAndRunOCR(page) {
  // Render at 2.0x scale for clear OCR recognition
  const viewport = page.getViewport({ scale: 2.0 });
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  canvas.width = viewport.width;
  canvas.height = viewport.height;

  await page.render({
    canvasContext: context,
    viewport: viewport
  }).promise;

  // Run Tesseract OCR on the canvas element directly
  if (window.Tesseract) {
    try {
      const { data: { text } } = await Tesseract.recognize(canvas, 'eng');
      return text.trim();
    } catch (err) {
      console.error('OCR processing error:', err);
      return '';
    }
  }
  return '';
}
