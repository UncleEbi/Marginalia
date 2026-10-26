// Tests for the karaoke timing helpers in public/app.js: how a native boundary offset becomes a
// word index, how each boundary re-anchors the estimate to the voice's real pace, and the word
// timeline the highlight walks. The functions are pulled straight out of the shipped file.

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractFunction } from './helpers/extract-function.mjs';

// computeWordTimeline reads the two cadence globals; the harness has to provide them
globalThis.learnedCadenceMultiplier = 1.0;
globalThis.userManualCalibration = 1.0;

const wordIndexAtChar = extractFunction('wordIndexAtChar');
const nextAnchorRatio = extractFunction('nextAnchorRatio');
const computeWordTimeline = extractFunction('computeWordTimeline');

test('a boundary at the start of a word points at that word', () => {
  const text = 'The quick brown fox jumps';
  assert.equal(wordIndexAtChar(text, 0), 0, 'the very first word');
  assert.equal(wordIndexAtChar(text, 4), 1, '"quick" starts at index 4');
  assert.equal(wordIndexAtChar(text, 10), 2, '"brown" starts at index 10');
});

test('a mid-word boundary still points at the word being spoken', () => {
  const text = "It's a two-word test.";
  assert.equal(wordIndexAtChar(text, 1), 0, 'inside "It\'s"');
  assert.equal(wordIndexAtChar(text, 8), 2, 'inside "two-word"');
});

test('offsets beyond the text clamp to the last word', () => {
  assert.equal(wordIndexAtChar('one two three', 999), 2);
  assert.equal(wordIndexAtChar('', 3), 0);
  assert.equal(wordIndexAtChar(null, 3), 0);
});

test('each boundary pulls the estimate toward the voice', () => {
  // A voice that reaches a word twice as late as estimated
  let ratio = nextAnchorRatio(1, 0.4, 0.2);
  assert.ok(ratio > 1 && ratio < 2, 'moves toward the sample without jumping to it');
  const afterOne = ratio;
  ratio = nextAnchorRatio(ratio, 0.4, 0.2);
  assert.ok(ratio > afterOne, 'repeated samples keep pulling the same way');
});

test('a nonsensical sample leaves the estimate alone', () => {
  assert.equal(nextAnchorRatio(1.3, 0, 0.5), 1.3, 'no elapsed time yet');
  assert.equal(nextAnchorRatio(1.3, 0.4, 0), 1.3, 'word has no estimated start');
  assert.equal(nextAnchorRatio(1.3, 0.4, 0.03), 1.3, 'start too small to divide by');
  assert.equal(nextAnchorRatio(1.3, 5.0, 0.1), 1.3, 'a 50x sample is not believed');
  assert.equal(nextAnchorRatio(1.3, 0.01, 0.5), 1.3, 'a 0.02x sample is not believed either');
});

test('the timeline walks forward in time and lands on a known clip duration', () => {
  const words = ['One', 'two.', 'Three', 'four.'];
  const estimate = computeWordTimeline(words, 1.0);

  assert.equal(estimate.timeline.length, words.length);
  for (let i = 1; i < estimate.timeline.length; i++) {
    assert.ok(estimate.timeline[i].start >= estimate.timeline[i - 1].start, 'starts never go backwards');
  }
  assert.ok(estimate.timeline[estimate.timeline.length - 1].end > 0);

  // With the clip's real duration the timeline is rescaled onto it: what keeps the neural
  // player's karaoke inside the audio it is highlighting
  const exact = computeWordTimeline(words, 1.0, 12.5);
  assert.equal(exact.totalEstMs, 12500);
  assert.ok(Math.abs(exact.timeline[exact.timeline.length - 1].end - 12.5) < 0.001);
});

test('faster playback shortens every word', () => {
  const words = ['One', 'two.'];
  const at1x = computeWordTimeline(words, 1.0);
  const at2x = computeWordTimeline(words, 2.0);
  assert.ok(at2x.totalEstMs < at1x.totalEstMs * 0.75, '2x is well under the 1x estimate');
});

test('a sentence with trailing spaces still has one slot per word', () => {
  // Splitting the sentence for the timeline must match how the DOM builder wrapped the words
  const words = '  spaced   out  words  '.trim().split(/\s+/).filter(w => w.length > 0);
  assert.deepEqual(words, ['spaced', 'out', 'words']);
  assert.equal(computeWordTimeline(words, 1.0).timeline.length, 3);
  assert.equal(wordIndexAtChar('  spaced   out  words  ', 10), 1, '"out" is the second word');
});
