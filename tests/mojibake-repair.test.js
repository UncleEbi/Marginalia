// Tests for cleanMojibake/repairMojibake and the UTF-8 decoding path in public/app.js.
// A UTF-8 EPUB whose smart quotes, dashes or accents were misread as windows-1252 used to reach the
// reader as "Itâ€™s" and "cafÃ©". These helpers undo that at ingestion. The functions are pulled
// straight out of the shipped file, like the other suites do.

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractFunction } from './helpers/extract-function.mjs';

for (const name of ['cleanMojibake', 'repairMojibake', 'decodeTextRobustly']) {
  globalThis[name] = extractFunction(name);
}

const splitIntoSentences = extractFunction('splitIntoSentences');

test('repairs smart quotes and dashes from a windows-1252 misdecode', () => {
  assert.deepEqual(splitIntoSentences('Itâ€™s a â€œtestâ€\u009D sentence.'), ['It’s a “test” sentence.']);
  // En and em dashes must survive the bare "â€" rule that repairs right quotes
  assert.deepEqual(splitIntoSentences('Chapters 1â€“3. Then 4â€”9.'), ['Chapters 1–3.', 'Then 4—9.']);
});

test('repairs accented letters through a byte round-trip', () => {
  assert.deepEqual(
    splitIntoSentences('cafÃ© and naÃ¯ve garÃ§on.'),
    ['café and naïve garçon.']
  );
});

test('leaves legitimate Â and Ã untouched', () => {
  // "Ângela" and "Ãlvaro" are real names, not mojibake: nothing may be stripped from them
  assert.deepEqual(splitIntoSentences('Ângela met Ãlvaro.'), ['Ângela met Ãlvaro.']);
});

test('clean text passes through unchanged and repairing twice is safe', () => {
  const clean = 'He said “stop” — and left.';
  assert.equal(cleanMojibake(clean), clean);
  assert.equal(repairMojibake(repairMojibake('Itâ€™s fine.')), 'It’s fine.');
});

test('decodeTextRobustly reads UTF-8 explicitly and falls back to latin1 only for real latin1 bytes', () => {
  assert.equal(decodeTextRobustly(new TextEncoder().encode('It’s the café — “fine”.')), 'It’s the café — “fine”.');
  assert.equal(decodeTextRobustly(Uint8Array.from([0x63, 0x61, 0x66, 0xE9])), 'café');
});
