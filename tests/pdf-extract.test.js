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

import { extractPdfTexts, processPageItems } from '../public/pdf-extract.js';
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
