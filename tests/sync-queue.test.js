// tests/sync-queue.test.js
//
// The two pure decisions behind the offline write queue: which positions this device still owes the
// cloud, and which of them a confirmed push may mark as settled. Both come from the shipped
// public/app.js, so these assertions cover the real code rather than a copy.

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFunction } from './helpers/extract-function.mjs';

const selectPendingProgress = extractFunction('selectPendingProgress');
const settlePendingRows = extractFunction('settlePendingRows');

const T1 = Date.UTC(2026, 0, 1, 12, 0, 0);
const T2 = Date.UTC(2026, 0, 2, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

function book(title, overrides = {}) {
  return {
    id: 1,
    title,
    pages: [['one', 'two']],
    currentPage: 3,
    currentSentenceIdx: 4,
    updatedAt: T1,
    pendingSync: true,
    ...overrides
  };
}

function row(title, overrides = {}) {
  return { title, current_page: 3, current_sentence: 4, updated_at: iso(T1), ...overrides };
}

test('only rows still owed to the cloud are selected', () => {
  const rows = selectPendingProgress([
    book('Dune'),
    book('Ubik', { pendingSync: false }),
    book('Solaris', { pendingSync: undefined }),
    null,
    { title: 42, pendingSync: true }
  ]);

  assert.deepEqual(rows, [{
    title: 'Dune',
    current_page: 3,
    current_sentence: 4,
    updated_at: iso(T1)
  }]);
});

test('the queue is empty for an empty or malformed shelf', () => {
  assert.deepEqual(selectPendingProgress([]), []);
  assert.deepEqual(selectPendingProgress(null), []);
  assert.deepEqual(selectPendingProgress(undefined), []);
});

test('negative and non-numeric positions are clamped before they reach the cloud', () => {
  const [row] = selectPendingProgress([
    book('Dune', { currentPage: -4, currentSentenceIdx: 'nope' })
  ]);

  assert.equal(row.current_page, 0);
  assert.equal(row.current_sentence, 0);
});

test('a confirmed push settles the row it sent', () => {
  assert.deepEqual(settlePendingRows([row('Dune')], [book('Dune')]), ['Dune']);
});

test('a save that landed while the push was in flight keeps its flag', () => {
  const newer = book('Dune', { updatedAt: T2 });

  assert.deepEqual(settlePendingRows([row('Dune', { updated_at: iso(T1) })], [newer]), []);
});

test('rows already settled or missing locally are not settled twice', () => {
  assert.deepEqual(settlePendingRows([row('Dune')], [book('Dune', { pendingSync: false })]), []);
  assert.deepEqual(settlePendingRows([row('Dune')], []), []);
});

test('an unreadable pushed timestamp never settles a row', () => {
  assert.deepEqual(settlePendingRows([row('Dune', { updated_at: 'not-a-date' })], [book('Dune')]), []);
  assert.deepEqual(settlePendingRows([row('Dune', { updated_at: null })], [book('Dune')]), []);
});

test('settling ignores malformed input instead of throwing', () => {
  assert.deepEqual(settlePendingRows(null, null), []);
  assert.deepEqual(settlePendingRows([null, { title: 7 }], [book('Dune')]), []);
});
