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
  globalThis.drillRatingOpen = false;
  globalThis.drillKnownCount = 0;
  globalThis.drillReviewQueue = [];
  globalThis.drillTimer = null;
  globalThis.drillStageCard = -1;
  globalThis.drillStageLeftMs = 0;
  globalThis.releaseDrillCardWaits = () => { };
  globalThis.isAudioDrillActive = true;
  globalThis.isAudioDrillPaused = false;
  globalThis.cancelDrillSpeech = () => { };
  globalThis.chimeCount = 0;
  globalThis.toastCount = 0;
  globalThis.playBookmarkChime = () => { globalThis.chimeCount += 1; };
  globalThis.showToast = () => { globalThis.toastCount += 1; };
  // Stand in for runDrillCard: advancing moves the index and leaves the next card's rating closed
  // until its prompt has been read out.
  globalThis.runDrillCard = (idx) => {
    globalThis.drillIndex = idx;
    globalThis.drillRatingOpen = false;
    return Promise.resolve();
  };
  return cards;
}

// What runDrillCard does once a card's prompt has finished: the card accepts one rating.
function openRating() {
  globalThis.drillRatingOpen = true;
}

test('the rated card cannot be rated twice by the same press', () => {
  installSession(3);
  openRating();

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
  installSession(2);
  openRating();

  rateDrillCard(false);
  rateDrillCard(false);

  assert.equal(globalThis.drillReviewQueue.length, 1);
  assert.equal(globalThis.drillKnownCount, 0);
  assert.equal(globalThis.drillIndex, 1);
});

test('a paused drill ignores ratings from the headset', () => {
  installSession(3);
  openRating();
  globalThis.isAudioDrillPaused = true;

  rateDrillCard(true);

  assert.equal(globalThis.drillKnownCount, 0);
  assert.equal(globalThis.drillIndex, 0);
  assert.equal(globalThis.drillRatingOpen, true, 'the card stays rateable for after the resume');
});

test('a press before the question has been read out is acknowledged, not rated', () => {
  installSession(2);

  rateDrillCard(true);

  assert.equal(globalThis.drillKnownCount, 0);
  assert.equal(globalThis.drillIndex, 0);
  assert.equal(globalThis.drillRatingOpen, false, 'the press is not queued for the card either');
  assert.equal(globalThis.chimeCount, 1, 'a hands-free press hears that it landed');
  assert.equal(globalThis.toastCount, 1, 'and a visible reader sees the same');
});

test('each presentation accepts one rating, even of a card rated before', () => {
  installSession(2);
  openRating();
  rateDrillCard(true);

  // A review round deals the same card object again at the front of the deck; its new presentation
  // is rateable again.
  globalThis.drillIndex = 0;
  openRating();
  rateDrillCard(true);
  assert.equal(globalThis.drillKnownCount, 2);

  openRating();
  rateDrillCard(true);

  assert.equal(globalThis.drillKnownCount, 3);
  assert.equal(globalThis.drillIndex, 2);
});
