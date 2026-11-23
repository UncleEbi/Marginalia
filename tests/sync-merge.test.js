// tests/sync-merge.test.js
//
// The decision that makes two-way sync safe: per book title, does the device or the account hold
// the newer reading position? mergeCloudProgress is pure and pulled out of the shipped app.js, so
// these assertions cover the real code, not a copy.

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFunction } from './helpers/extract-function.mjs';

const mergeCloudProgress = extractFunction('mergeCloudProgress');

const T1 = Date.UTC(2026, 0, 1, 12, 0, 0);
const T2 = Date.UTC(2026, 0, 2, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

function localBook(title, overrides = {}) {
  return {
    id: 7,
    title,
    pages: [['one', 'two']],
    chapters: [],
    currentPage: 1,
    currentSentenceIdx: 2,
    updatedAt: T1,
    ...overrides
  };
}

function cloudRow(title, overrides = {}) {
  return {
    title,
    current_page: 1,
    current_sentence: 2,
    updated_at: iso(T1),
    ...overrides
  };
}

test('a strictly newer cloud position is adopted', () => {
  const { adopt, upload } = mergeCloudProgress(
    [localBook('Dune')],
    [cloudRow('Dune', { current_page: 4, current_sentence: 7, updated_at: iso(T2) })]
  );

  assert.equal(upload.length, 0, 'nothing to push when the cloud is newer');
  assert.deepEqual(adopt, [{
    title: 'Dune',
    currentPage: 4,
    currentSentenceIdx: 7,
    updatedAt: T2
  }]);
});

test('an older cloud position never overwrites the device', () => {
  const { adopt, upload } = mergeCloudProgress(
    [localBook('Dune')],
    [cloudRow('Dune', { current_page: 9, current_sentence: 9, updated_at: iso(T1 - 60000) })]
  );

  assert.equal(adopt.length, 0);
  assert.equal(upload.length, 1);
  assert.equal(upload[0].current_page, 1, 'the local page is what gets pushed');
  assert.equal(upload[0].current_sentence, 2);
});

test('a book only on this device is uploaded with its own timestamp', () => {
  const { adopt, upload } = mergeCloudProgress([localBook('Solaris')], []);

  assert.equal(adopt.length, 0);
  assert.deepEqual(upload, [{
    title: 'Solaris',
    current_page: 1,
    current_sentence: 2,
    updated_at: iso(T1)
  }]);
});

test('a book only in the cloud is not materialised locally', () => {
  const { adopt, upload } = mergeCloudProgress([], [cloudRow('Ubik', { updated_at: iso(T2) })]);

  assert.deepEqual(adopt, [], 'without pages there is nothing to open');
  assert.deepEqual(upload, []);
});

test('a page turn the account has not seen yet is not rolled back by its own older row', () => {
  // The device clock runs behind the server, so the fresh save looks older than the row this device
  // synced earlier. The stamp the cloud holds proves that row predates the save.
  const { adopt, upload } = mergeCloudProgress(
    [localBook('Dune', {
      currentPage: 5,
      updatedAt: T1 - 5 * 60000,
      pendingSync: true,
      lastCloudStamp: T1
    })],
    [cloudRow('Dune', { current_page: 2, updated_at: iso(T1) })]
  );

  assert.deepEqual(adopt, [], 'the slow clock must not hand the page back');
  assert.equal(upload.length, 1);
  assert.equal(upload[0].current_page, 5, 'the fresh position is what gets pushed');
});

test('a cloud row written after our last contact still wins over an unpushed save', () => {
  const { adopt, upload } = mergeCloudProgress(
    [localBook('Dune', { pendingSync: true, updatedAt: T1, lastCloudStamp: T1 - 60000 })],
    [cloudRow('Dune', { current_page: 9, updated_at: iso(T2) })]
  );

  assert.equal(upload.length, 0, 'another device genuinely read further');
  assert.equal(adopt[0].currentPage, 9);
});

test('an unpushed save with no prior contact falls back to timestamps', () => {
  const { adopt } = mergeCloudProgress(
    [localBook('Dune', { pendingSync: true, updatedAt: T1 })],
    [cloudRow('Dune', { updated_at: iso(T2) })]
  );

  assert.equal(adopt.length, 1, 'nothing proves the cloud row is stale, so it still wins');
});

test('a cloud row with an unreadable timestamp loses to the device', () => {
  const { adopt, upload } = mergeCloudProgress(
    [localBook('Dune')],
    [cloudRow('Dune', { updated_at: 'not-a-date' })]
  );

  assert.equal(adopt.length, 0);
  assert.equal(upload.length, 1);
});

test('a tie keeps the device position', () => {
  const { adopt, upload } = mergeCloudProgress([localBook('Dune')], [cloudRow('Dune')]);

  assert.equal(adopt.length, 0);
  assert.equal(upload.length, 1);
});

test('a device book with no timestamp uses the supplied now', () => {
  const now = Date.UTC(2026, 5, 1, 9, 30, 0);
  const { upload } = mergeCloudProgress(
    [localBook('Dune', { updatedAt: 0 })],
    [],
    now
  );

  assert.equal(upload[0].updated_at, iso(now));
});

test('negative and non-numeric positions are clamped to zero', () => {
  const { adopt } = mergeCloudProgress(
    [localBook('Dune')],
    [cloudRow('Dune', { current_page: -4, current_sentence: 'nope', updated_at: iso(T2) })]
  );

  assert.equal(adopt[0].currentPage, 0);
  assert.equal(adopt[0].currentSentenceIdx, 0);
});

test('malformed input returns empty lists instead of throwing', () => {
  assert.deepEqual(mergeCloudProgress(null, undefined), { adopt: [], upload: [] });
  assert.deepEqual(mergeCloudProgress([{ title: null }], [{ title: 42 }]), { adopt: [], upload: [] });
});
