import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFunction } from './helpers/extract-function.mjs';

// shelfReadingMomentum reads these two names from the app's global scope at call time, so the test
// supplies the same implementations public/app.js ships.
globalThis.MS_PER_WORD = 400;
globalThis.countWordsInItem = extractFunction('countWordsInItem');
const shelfReadingMomentum = extractFunction('shelfReadingMomentum');

function bookAt(currentPage, currentSentenceIdx) {
  return {
    pages: [
      ['one two three four five six seven eight nine ten'],
      ['eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty']
    ],
    currentPage,
    currentSentenceIdx
  };
}

test('shelf momentum measures words read, not pages opened', () => {
  const unopened = shelfReadingMomentum(bookAt(0, 0));
  assert.equal(unopened.percent, 0);
  assert.equal(unopened.label, '0% read · ~1 min left');

  // One of two pages done is half the book, whatever page numbering says.
  const halfway = shelfReadingMomentum(bookAt(1, 0));
  assert.equal(halfway.percent, 50);
  assert.equal(halfway.label, '50% read · ~1 min left');
});

test('a finished book says so instead of counting down', () => {
  assert.equal(shelfReadingMomentum(bookAt(1, 1)).label, 'Finished');
  assert.equal(shelfReadingMomentum({ pages: [] }).label, 'Not started');
});
