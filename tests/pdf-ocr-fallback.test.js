// Flat image scans — PDFs with no text layer — used to be rejected with "No readable digital text
// found." They are now rendered page-by-page to JPEGs and transcribed by /api/ocr. These tests
// cover the renderer (public/pdf-extract.js), the client fallback in public/app.js, and the
// endpoint's contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { renderPdfPagesToImages } from '../public/pdf-extract.js';
import { extractFunction, appSource } from './helpers/extract-function.mjs';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

// --- Renderer ---------------------------------------------------------------
// Node has no DOM, so the canvas and pdf.js page objects are faked. What matters is the contract
// with the real ones: how the canvas is sized, that it is painted white before rendering, and that
// each page comes back as a JPEG data URL.
function fakeCanvasFactory(created) {
  return (width, height) => {
    const rects = [];
    const ctx = { fillStyle: '', fillRect: (...args) => rects.push(args) };
    const canvas = {
      width, height, rects,
      getContext: () => ctx,
      toDataURL: (type, quality) => `data:${type};q${quality}:${width}x${height}`
    };
    created.push(canvas);
    return canvas;
  };
}

function fakePdfjs({ numPages = 2, natural = { width: 612, height: 792 } } = {}) {
  const renders = [];
  return {
    renders,
    getDocument: () => ({ promise: Promise.resolve({
      numPages,
      getPage: async (pageNumber) => ({
        getViewport: ({ scale }) => ({ width: natural.width * scale, height: natural.height * scale, scale }),
        render: (params) => { renders.push({ pageNumber, params }); return { promise: Promise.resolve() }; }
      }),
      destroyed: false,
      destroy: async function () { this.destroyed = true; }
    }) })
  };
}

test('renders every PDF page to a JPEG data URL', async () => {
  const canvases = [];
  const pdfjs = fakePdfjs({ numPages: 3 });

  const images = await renderPdfPagesToImages(pdfjs, new Uint8Array([1]), {
    createCanvas: fakeCanvasFactory(canvases)
  });

  assert.deepEqual(images.map((i) => i.pageNumber), [1, 2, 3]);
  for (const img of images) assert.match(img.dataUrl, /^data:image\/jpeg;/);
  assert.equal(pdfjs.renders.length, 3, 'one render call per page');
  // pdf.js v6 wants the canvas itself (canvasContext is the legacy alias)
  assert.equal(pdfjs.renders[0].params.canvas, canvases[0]);
  assert.equal(pdfjs.renders[0].params.viewport.scale, canvases[0].width / 612);
});

test('paints the page white before rendering so scans never come out inverted', async () => {
  const canvases = [];
  await renderPdfPagesToImages(fakePdfjs({ numPages: 1 }), new Uint8Array([1]), {
    createCanvas: fakeCanvasFactory(canvases)
  });
  assert.deepEqual(canvases[0].rects[0], [0, 0, canvases[0].width, canvases[0].height]);
});

test('scales pages to roughly maxWidth: up for narrow scans, down for oversized ones', async () => {
  const run = async (naturalWidth) => {
    const canvases = [];
    await renderPdfPagesToImages(fakePdfjs({ numPages: 1, natural: { width: naturalWidth, height: 800 } }), new Uint8Array([1]), {
      createCanvas: fakeCanvasFactory(canvases)
    });
    return canvases[0].width;
  };
  assert.equal(await run(612), 1530, 'a 612pt letter page renders at 2.5x');
  assert.equal(await run(4000), 1600, 'a huge page is shrunk to maxWidth');
  assert.equal(await run(100), 250, 'a tiny page is never blown up past 2.5x');
});

test('reports progress and releases the document', async () => {
  const pdfjs = fakePdfjs({ numPages: 2 });
  const seen = [];
  await renderPdfPagesToImages(pdfjs, new Uint8Array([1]), {
    createCanvas: fakeCanvasFactory([]),
    onPage: (done, total) => seen.push(`${done}/${total}`)
  });
  assert.deepEqual(seen, ['1/2', '2/2']);
  assert.equal(pdfjs.renders[0].params.viewport !== undefined, true);
});

test('a page render failure still destroys the document', async () => {
  const doc = await fakePdfjs({ numPages: 1 }).getDocument().promise;
  const broken = { getDocument: () => ({ promise: Promise.resolve(doc) }) };
  doc.getPage = async () => ({ getViewport: () => ({ width: 10, height: 10 }), render: () => ({ promise: Promise.reject(new Error('boom')) }) });
  await assert.rejects(() => renderPdfPagesToImages(broken, new Uint8Array([1]), { createCanvas: fakeCanvasFactory([]) }), /boom/);
  assert.equal(doc.destroyed, true);
});

// --- Client fallback --------------------------------------------------------
const ocrScannedPdf = extractFunction('ocrScannedPdf');

async function withHarness(overrides, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  try {
    return await fn();
  } finally {
    for (const [key, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete globalThis[key];
    }
  }
}

// Responses come from a queue: each entry is { status, body } for one /api/ocr call.
function harness({ images = ['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB'], responses = [], token = 'tok', byok = '' } = {}) {
  const calls = [];
  const status = { textContent: '' };
  const globals = {
    preloadStatus: status,
    getFreshAuthToken: async () => token,
    localStorage: { getItem: (k) => (k === 'marginalia_byok_openai' ? byok : null) },
    window: { renderPdfPages: async (lib, data, onPage) => {
      if (onPage) await onPage(1, images.length);
      return images.map((dataUrl, i) => ({ pageNumber: i + 1, dataUrl }));
    } },
    fetch: async (url, opts) => {
      calls.push({ url, opts });
      const next = responses[Math.min(calls.length - 1, responses.length - 1)] || { status: 200, body: { text: '' } };
      return {
        status: next.status,
        ok: next.status >= 200 && next.status < 300,
        json: async () => next.body
      };
    }
  };
  return { calls, status, globals };
}

test('OCR fallback posts each rendered page and returns readable pages', async () => {
  const h = harness({
    responses: [
      { status: 200, body: { text: 'Page one text.' } },
      { status: 200, body: { text: '   ' } },
      { status: 200, body: { text: 'Page three text.' } }
    ],
    images: ['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB', 'data:image/jpeg;base64,CCC']
  });

  await withHarness(h.globals, async () => {
    const pages = await ocrScannedPdf({}, new Uint8Array([1]));
    assert.deepEqual(pages, [
      { pageNumber: 1, text: 'Page one text.' },
      { pageNumber: 3, text: 'Page three text.' }
    ]);
    assert.equal(h.calls.length, 3);
    for (const call of h.calls) {
      assert.equal(call.url, '/api/ocr');
      assert.equal(call.opts.headers['Authorization'], 'Bearer tok');
      assert.equal(call.opts.method, 'POST');
    }
    assert.match(h.calls[0].opts.body, /imageBase64/);
    assert.match(h.status.textContent, /Reading scan 3\/3/, 'progress reaches the last page');
  });
});

test('asks the user to sign in instead of calling the API without credentials', async () => {
  const h = harness({ token: '', byok: '' });
  await withHarness(h.globals, async () => {
    await assert.rejects(() => ocrScannedPdf({}, new Uint8Array([1])), /Sign in/);
    assert.equal(h.calls.length, 0, 'no request is made');
  });
});

test('BYOK users send their own key header', async () => {
  const h = harness({
    token: '',
    byok: 'sk-test',
    images: ['data:image/jpeg;base64,AAA'],
    responses: [{ status: 200, body: { text: 'Hi.' } }]
  });
  await withHarness(h.globals, async () => {
    const pages = await ocrScannedPdf({}, new Uint8Array([1]));
    assert.equal(pages.length, 1);
    assert.equal(h.calls[0].opts.headers['x-custom-openai-key'], 'sk-test');
    assert.equal(h.calls[0].opts.headers['Authorization'], undefined);
  });
});

test('running out of credits before the first page surfaces the server message', async () => {
  const h = harness({ responses: [{ status: 402, body: { error: 'Free trial AI credits exhausted.', trialExhausted: true } }] });
  await withHarness(h.globals, async () => {
    await assert.rejects(() => ocrScannedPdf({}, new Uint8Array([1])), /Free trial AI credits exhausted/);
  });
});

test('running out mid-scan keeps the pages already read and appends a note', async () => {
  const h = harness({
    images: ['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB', 'data:image/jpeg;base64,CCC'],
    responses: [
      { status: 200, body: { text: 'Page one text.' } },
      { status: 402, body: { error: 'Free trial AI credits exhausted.' } }
    ]
  });

  await withHarness(h.globals, async () => {
    const pages = await ocrScannedPdf({}, new Uint8Array([1]));
    assert.equal(pages.length, 2, 'the read page plus the stopping note');
    assert.equal(pages[0].text, 'Page one text.');
    assert.match(pages[1].text, /Reading stopped at page 2 of 3/);
    assert.match(pages[1].text, /credits/i);
    assert.equal(h.calls.length, 2, 'stops asking for more pages');
  });
});

test('a scan with no readable text anywhere gets a clear error, not an empty book', async () => {
  const h = harness({ responses: [{ status: 200, body: { text: '' } }] });
  await withHarness(h.globals, async () => {
    await assert.rejects(() => ocrScannedPdf({}, new Uint8Array([1])), /No readable text/);
  });
});

test('server failures propagate their message', async () => {
  const h = harness({ responses: [{ status: 500, body: { error: 'OpenAI Vision error (401): bad key' } }] });
  await withHarness(h.globals, async () => {
    await assert.rejects(() => ocrScannedPdf({}, new Uint8Array([1])), /OpenAI Vision error/);
  });
});

// --- Wiring contract --------------------------------------------------------
test('the PDF branch falls back to OCR only when extraction found nothing', () => {
  const src = appSource();
  assert.match(src, /if \(pageTexts\.length === 0\) \{\s*\n\s*\/\/ Flat image scan/, 'fallback is gated on an empty extraction');
  assert.match(src, /pageTexts = await ocrScannedPdf\(lib, uint8\)/, 'the fallback result feeds the same page builder');
  assert.match(src, /window\.renderPdfPages\(lib, uint8/, 'the fallback renders pages through the module helper');
  assert.match(src, /fetch\('\/api\/ocr'/, 'it posts to the OCR endpoint');
});

test('index.html exposes renderPdfPages from the same module and pinned font data', () => {
  const html = read('../public/index.html');
  assert.match(html, /window\.renderPdfPages = \(lib, data, onPage\)/);
  assert.match(html, /renderPdfPagesToImages\(lib, data, \{/);
  assert.match(html, /standardFontDataUrl: `\$\{PDFJS_BASE\}\/standard_fonts\/`/, 'renders with the same pinned fonts as extraction');
});

test('the OCR endpoint keeps the shared credit gate and transcribes instead of summarizing', () => {
  const src = read('../api/ocr.js');
  assert.match(src, /trialExhausted: true/, 'reports exhausted free credits as 402');
  assert.match(src, /x-custom-openai-key/, 'BYOK bypasses the shared credits');
  assert.match(src, /isProActive\(profile\)/, 'Pro reads without spending credits');
  assert.match(src, /Never summarize, translate, or add commentary/, 'the prompt transcribes verbatim');
  assert.match(src, /json\(\{ text \}\)/, 'returns the page text');
  assert.match(src, /MAX_IMAGE_CHARS/, 'rejects bodies that would exceed the platform limit');
});
