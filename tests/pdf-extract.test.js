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

import { extractPdfTexts } from '../public/pdf-extract.js';
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
