import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFunction } from './helpers/extract-function.mjs';

const rateDrillCard = extractFunction('rateDrillCard');

// rateDrillCard reads and writes the drill state that public/app.js keeps in script scope, so the
// test installs those names as globals and drives them the way the HUD does.
function installSession(cardCount) {
  const cards = Array.from({ length: cardCount }, (_, i) => ({ prompt: `p${i}`, answer: `a${i}` }));
  globalThis.drillCards = cards;
  globalThis.drillIndex = 0;
  globalThis.drillRateableCard = null;
  globalThis.drillKnownCount = 0;
  globalThis.drillReviewQueue = [];
  globalThis.drillTimer = null;
  globalThis.isAudioDrillActive = true;
  globalThis.cancelDrillSpeech = () => { };
  globalThis.showToast = () => { };
  // Stand in for runDrillCard: advancing moves the index and leaves the next card's window closed
  // until its prompt has been read out.
  globalThis.runDrillCard = (idx) => {
    globalThis.drillIndex = idx;
    globalThis.drillRateableCard = null;
    return Promise.resolve();
  };
  return cards;
}

// What runDrillCard does once a card's prompt has finished: its rating window opens.
function openRatingWindow(cards, idx) {
  globalThis.drillIndex = idx;
  globalThis.drillRateableCard = cards[idx];
}

test('the rated card cannot be rated twice by the same press', () => {
  const cards = installSession(3);
  openRatingWindow(cards, 0);

  rateDrillCard(true);
  assert.equal(globalThis.drillKnownCount, 1);
  assert.equal(globalThis.drillIndex, 1);

  // The second half of a double tap arrives while card 2 is still being read out.
  rateDrillCard(true);
  assert.equal(globalThis.drillKnownCount, 1, 'the same card is not counted twice');
  assert.equal(globalThis.drillIndex, 1, 'card 2 is not skipped past unseen');
  assert.deepEqual(globalThis.drillReviewQueue, []);
});

test('a repeated Review press queues the card once', () => {
  const cards = installSession(2);
  openRatingWindow(cards, 0);

  rateDrillCard(false);
  rateDrillCard(false);

  assert.equal(globalThis.drillReviewQueue.length, 1);
  assert.equal(globalThis.drillKnownCount, 0);
  assert.equal(globalThis.drillIndex, 1);
});

test('no card can be rated before its prompt has been read out', () => {
  installSession(2);

  rateDrillCard(true);

  assert.equal(globalThis.drillKnownCount, 0);
  assert.equal(globalThis.drillIndex, 0);
});

test('each card is rateable once its own window opens, even if it was rated before', () => {
  const cards = installSession(2);
  openRatingWindow(cards, 0);
  rateDrillCard(true);

  // A review round deals the same card object again; its new presentation is rateable again.
  openRatingWindow(cards, 0);
  rateDrillCard(true);

  openRatingWindow(cards, 1);
  rateDrillCard(true);

  assert.equal(globalThis.drillKnownCount, 3);
  assert.equal(globalThis.drillIndex, 2);
});
