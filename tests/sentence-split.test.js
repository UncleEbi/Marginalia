// Tests for splitIntoSentences in public/app.js — the step that turns extracted PDF page text into
// the sentences the reader narrates. The function is pulled straight out of the shipped file
// (public/app.js is a classic DOM script and cannot be imported directly).

import test from 'node:test';
import assert from 'node:assert/strict';

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

import { extractFunction, appSource } from './helpers/extract-function.mjs';
import { extractPdfTexts } from '../public/pdf-extract.js';
import { makePdf } from './helpers/make-pdf.mjs';

// splitIntoSentences repairs cp1252-mislabeled UTF-8 through these two helpers
for (const name of ['cleanMojibake', 'repairMojibake']) {
  globalThis[name] = extractFunction(name);
}

const splitIntoSentences = extractFunction('splitIntoSentences');

test('splits a paragraph into sentences', () => {
  assert.deepEqual(
    splitIntoSentences('One thing. Two things! Three things?'),
    ['One thing.', 'Two things!', 'Three things?']
  );
});

test('treats a line break as a sentence boundary (why PDF text is whitespace-collapsed first)', () => {
  assert.deepEqual(
    splitIntoSentences('Line one\nLine two continues here.'),
    ['Line one', 'Line two continues here.']
  );
});

test('decodes HTML entities before splitting (EPUB/DOCX text)', () => {
  const [first] = splitIntoSentences('Fish &amp; chips &quot;tonight&quot;. Next one.');
  assert.equal(first, 'Fish & chips "tonight".');
});

test('returns an empty list for empty or whitespace-only input', () => {
  assert.deepEqual(splitIntoSentences(''), []);
  assert.deepEqual(splitIntoSentences('   \n\t '), []);
});

test('keeps trailing quotes attached to their sentence', () => {
  assert.deepEqual(
    splitIntoSentences('He said "go home." She left.'),
    ['He said "go home."', 'She left.']
  );
});

test('app.js still wires the PDF branch through the extracted helper', () => {
  const src = appSource();
  assert.match(src, /window\.extractPdfTexts\(lib, uint8\)/, 'PDF branch calls the module helper');
  assert.doesNotMatch(src, /pdfjsLib\.getDocument/, 'no direct pdf.js global usage left in app.js');
});

// End-to-end for the PDF path: real pdf.js extraction -> the reader's sentence splitter.
test('a real PDF page becomes readable sentences', async () => {
  const pages = await extractPdfTexts(pdfjsLib, makePdf([
    'Line one wrapping\nLine two of the same paragraph. A second sentence follows!'
  ]));

  const sentences = pages.flatMap((p) => splitIntoSentences(p.text));

  // Extraction collapses the source line breaks, so the wrapped paragraph stays one sentence
  assert.deepEqual(sentences, [
    'Line one wrapping Line two of the same paragraph.',
    'A second sentence follows!'
  ]);
});
