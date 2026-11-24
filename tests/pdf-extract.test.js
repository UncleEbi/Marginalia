// Tests for public/pdf-extract.js — the PDF text-extraction path used by the reader.
//
// These run against the same pinned pdfjs-dist version the browser loads from the CDN, so an API
// change in a future pdf.js upgrade fails here instead of in the user's browser.
// Node uses pdfjs-dist's legacy build (pdf.js prints "Please use the legacy build in Node.js
// environments"); it exposes the same getDocument/getPage/getTextContent API as the browser build.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

import { extractPdfTexts, processPageItems, cleanInlineNoise } from '../public/pdf-extract.js';
import { makePdf } from './helpers/make-pdf.mjs';

test('extracts text from a single-page PDF', async () => {
  const pages = await extractPdfTexts(pdfjsLib, makePdf(['Hello from Marginalia.']));

  assert.equal(pages.length, 1);
  assert.equal(pages[0].pageNumber, 1);
  assert.match(pages[0].text, /Hello from Marginalia\./);
});

test('extracts every page in order', async () => {
  const pages = await extractPdfTexts(pdfjsLib, makePdf([
    'Page one text.',
    'Page two text.',
    'Page three text.'
  ]));

  assert.deepEqual(pages.map((p) => p.pageNumber), [1, 2, 3]);
  assert.match(pages[0].text, /Page one text\./);
  assert.match(pages[1].text, /Page two text\./);
  assert.match(pages[2].text, /Page three text\./);
});

test('keeps sentence punctuation and word order intact', async () => {
  const [page] = await extractPdfTexts(pdfjsLib, makePdf(['First sentence. Second sentence!']));

  assert.match(page.text, /First sentence\.\s+Second sentence!/);
});

test('collapses runs of whitespace', async () => {
  const [page] = await extractPdfTexts(pdfjsLib, makePdf(['Alpha    Beta   Gamma.']));

  assert.equal(page.text, 'Alpha Beta Gamma.');
});

test('skips pages that contain no text', async () => {
  const pages = await extractPdfTexts(pdfjsLib, makePdf(['', 'Only this page has text.']));

  assert.equal(pages.length, 1);
  assert.equal(pages[0].pageNumber, 2);
  assert.match(pages[0].text, /Only this page has text\./);
});

test('returns an empty list when the PDF has no digital text (a scan)', async () => {
  const pages = await extractPdfTexts(pdfjsLib, makePdf(['']));

  assert.deepEqual(pages, []);
});

test('rejects data that is not a PDF', async () => {
  await assert.rejects(
    () => extractPdfTexts(pdfjsLib, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
    (err) => err instanceof Error
  );
});

test('passes options through to pdf.js (standardFontDataUrl, as the browser does)', async () => {
  const standardFontDataUrl = path.join(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts/');
  const pages = await extractPdfTexts(pdfjsLib, makePdf(['Alpha Beta Gamma Delta.']), {
    standardFontDataUrl
  });

  assert.equal(pages.length, 1);
  assert.equal(pages[0].text, 'Alpha Beta Gamma Delta.');
});

test('rejects when no PDF.js library is supplied', async () => {
  await assert.rejects(
    () => extractPdfTexts(null, makePdf(['x'])),
    /A PDF\.js library instance is required/
  );
});

test('rejects when the supplied library has no getDocument', async () => {
  await assert.rejects(
    () => extractPdfTexts({}, makePdf(['x'])),
    /A PDF\.js library instance is required/
  );
});

test('extracts two-column academic paper in correct reading order (column 1 then column 2)', async () => {
  // Construct a PDF where column 1 and column 2 text items are interleaved in the stream
  const rawOps = [
    'BT /F1 12 Tf 50 680 Td (Column One Line 1.) Tj ET',
    'BT /F1 12 Tf 350 680 Td (Column Two Line 1.) Tj ET',
    'BT /F1 12 Tf 50 650 Td (Column One Line 2.) Tj ET',
    'BT /F1 12 Tf 350 650 Td (Column Two Line 2.) Tj ET',
    'BT /F1 12 Tf 50 620 Td (Column One Line 3.) Tj ET',
    'BT /F1 12 Tf 350 620 Td (Column Two Line 3.) Tj ET'
  ].join('\n');

  const pdfData = makePdf([{ rawOps }]);
  const [page] = await extractPdfTexts(pdfjsLib, pdfData);

  // Column 1 should precede Column 2 in reading order
  const expected = 'Column One Line 1. Column One Line 2. Column One Line 3. Column Two Line 1. Column Two Line 2. Column Two Line 3.';
  assert.equal(page.text, expected);
});

test('prunes running headers and footers from academic papers', async () => {
  const rawOps = [
    'BT /F1 10 Tf 50 765 Td (IEEE Transactions on Neural Networks - Vol 34) Tj ET', // Header
    'BT /F1 12 Tf 72 700 Td (Body paragraph of the academic paper.) Tj ET',
    'BT /F1 12 Tf 72 670 Td (Second line of main body text.) Tj ET',
    'BT /F1 10 Tf 300 20 Td (42) Tj ET' // Footer page number
  ].join('\n');

  const pdfData = makePdf([{ rawOps }]);

  // Default: removeHeaders = true
  const [cleaned] = await extractPdfTexts(pdfjsLib, pdfData);
  assert.ok(!cleaned.text.includes('IEEE Transactions'));
  assert.ok(!cleaned.text.includes('42'));
  assert.ok(cleaned.text.includes('Body paragraph of the academic paper. Second line of main body text.'));

  // With removeHeaders = false: headers and footers are kept
  const [uncleaned] = await extractPdfTexts(pdfjsLib, pdfData, { removeHeaders: false });
  assert.ok(uncleaned.text.includes('IEEE Transactions'));
  assert.ok(uncleaned.text.includes('42'));
});

test('processPageItems handles spanning title, two columns, and line de-hyphenation', () => {
  const items = [
    // Spanning title at top
    { str: 'Deep Learning Architectures', transform: [1, 0, 0, 1, 100, 720], width: 400, height: 16 },
    // Left column with hyphenation
    { str: 'Recent breakthroughs in deep represen-', transform: [1, 0, 0, 1, 50, 670], width: 200, height: 12 },
    { str: 'tation learning have yielded impressive', transform: [1, 0, 0, 1, 50, 650], width: 200, height: 12 },
    { str: 'results across multimodal tasks.', transform: [1, 0, 0, 1, 50, 630], width: 200, height: 12 },
    // Right column
    { str: 'Our experiments demonstrate that', transform: [1, 0, 0, 1, 350, 670], width: 200, height: 12 },
    { str: 'on-device inference achieves parity', transform: [1, 0, 0, 1, 350, 650], width: 200, height: 12 },
    { str: 'with cloud endpoints.', transform: [1, 0, 0, 1, 350, 630], width: 200, height: 12 }
  ];

  const text = processPageItems(items, { width: 612, height: 792 });
  // Verify title is first
  assert.ok(text.startsWith('Deep Learning Architectures'));
  // Verify de-hyphenation "represen-" + "tation" -> "representation"
  assert.ok(text.includes('deep representation learning'));
  // Verify left column completes before right column
  const leftIdx = text.indexOf('multimodal tasks.');
  const rightIdx = text.indexOf('Our experiments demonstrate');
  assert.ok(leftIdx < rightIdx, 'Left column should be ordered before right column');
});

test('cleanInlineNoise strips raw URLs, numeric citation brackets, and joins hyphenated words', () => {
  const dirty = 'Recent advances in elec- trical engineering [1] and neural computing [12, 14] as described at https://arxiv.org/abs/2301.0001.';
  const cleaned = cleanInlineNoise(dirty);
  assert.equal(cleaned, 'Recent advances in electrical engineering and neural computing as described at');

  const dirtyWithCitationPunct = 'Engineering [1] . Next topic [2], more details.';
  assert.equal(cleanInlineNoise(dirtyWithCitationPunct), 'Engineering. Next topic, more details.');
});

test('processPageItems prunes standalone page numbers (- 12 -, Page 12 of 40, [ 12 ]) in margin bands', () => {
  const items = [
    { str: '- 12 -', transform: [1, 0, 0, 1, 280, 750], width: 40, height: 10 }, // Top 8%
    { str: 'Valid paragraph text here.', transform: [1, 0, 0, 1, 72, 500], width: 200, height: 12 },
    { str: 'Page 12 of 40', transform: [1, 0, 0, 1, 280, 30], width: 60, height: 10 } // Bottom 8%
  ];

  const text = processPageItems(items, { width: 612, height: 792 });
  assert.equal(text, 'Valid paragraph text here.');
});

test('extractPdfTexts removes template headers repeating across more than 50% of pages', async () => {
  // 3-page document where header repeats on all 3 pages with changing page number
  const pagesData = [
    {
      rawOps: [
        'BT /F1 10 Tf 50 750 Td (Journal of Machine Learning - Page 1) Tj ET',
        'BT /F1 12 Tf 72 500 Td (Content on first page.) Tj ET'
      ].join('\n')
    },
    {
      rawOps: [
        'BT /F1 10 Tf 50 750 Td (Journal of Machine Learning - Page 2) Tj ET',
        'BT /F1 12 Tf 72 500 Td (Content on second page.) Tj ET'
      ].join('\n')
    },
    {
      rawOps: [
        'BT /F1 10 Tf 50 750 Td (Journal of Machine Learning - Page 3) Tj ET',
        'BT /F1 12 Tf 72 500 Td (Content on third page.) Tj ET'
      ].join('\n')
    }
  ];

  const pdfData = makePdf(pagesData);
  const pages = await extractPdfTexts(pdfjsLib, pdfData);

  assert.equal(pages.length, 3);
  for (const page of pages) {
    assert.ok(!page.text.includes('Journal of Machine Learning'), 'Repeating template header must be stripped');
    assert.ok(page.text.includes('Content on'), 'Body content must be preserved');
  }
});

test('non-destructive fallback keeps all text when layout has irregular geometry', () => {
  // Staggered items that do not cluster cleanly into two columns
  const items = [
    { str: 'Line A at left', transform: [1, 0, 0, 1, 50, 700], width: 100, height: 12 },
    { str: 'Line B in middle', transform: [1, 0, 0, 1, 200, 680], width: 100, height: 12 },
    { str: 'Line C at right', transform: [1, 0, 0, 1, 400, 660], width: 100, height: 12 },
    { str: 'Line D overlapping', transform: [1, 0, 0, 1, 150, 640], width: 300, height: 12 }
  ];

  const text = processPageItems(items, { width: 612, height: 792 });
  assert.ok(text.includes('Line A at left'));
  assert.ok(text.includes('Line B in middle'));
  assert.ok(text.includes('Line C at right'));
  assert.ok(text.includes('Line D overlapping'));
});

test('smartPdfCleanupSelect exists in index.html and app.js initializes it', async () => {
  const fs = await import('node:fs');
  const url = await import('node:url');
  const html = fs.readFileSync(url.fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
  const appJs = fs.readFileSync(url.fileURLToPath(new URL('../public/app.js', import.meta.url)), 'utf8');

  assert.ok(html.includes('id="smartPdfCleanupSelect"'), 'smartPdfCleanupSelect must exist in index.html');
  assert.ok(html.includes('Smart PDF Cleanup'), 'Smart PDF Cleanup label must exist');
  assert.ok(appJs.includes('smartPdfCleanupSelect'), 'app.js must reference smartPdfCleanupSelect');
  assert.ok(appJs.includes('marginalia_smart_pdf_cleanup'), 'app.js must persist smart PDF cleanup option');
});
