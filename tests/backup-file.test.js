// tests/backup-file.test.js
//
// The backup file is the only copy of someone's library when their browser data goes away, so the
// format is strict in both directions: what gets written, what is refused, and how a restore merges
// with what is already on the device.

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFunction } from './helpers/extract-function.mjs';

const buildBackupPayload = extractFunction('buildBackupPayload');
const parseBackupPayload = extractFunction('parseBackupPayload');
const mergeShelfRecords = extractFunction('mergeShelfRecords');
const mergeBookmarks = extractFunction('mergeBookmarks');

const T1 = Date.UTC(2026, 0, 1, 12, 0, 0);
const T2 = Date.UTC(2026, 0, 2, 12, 0, 0);

function book(title, overrides = {}) {
  return {
    id: 3,
    title,
    pages: [['one'], ['two']],
    chapters: [{ title: 'Start', pageIndex: 0 }],
    currentPage: 1,
    currentSentenceIdx: 0,
    updatedAt: T1,
    ...overrides
  };
}

function mark(bookTitle, overrides = {}) {
  return { id: 9, bookTitle, page: 2, sentenceIdx: 3, snippet: 'hello', createdAt: T1, ...overrides };
}

test('export drops per-device ids and normalises every field it keeps', () => {
  const payload = buildBackupPayload([book('Dune')], [mark('Dune')], '2026-01-03T00:00:00.000Z');

  assert.equal(payload.format, 'marginalia-backup');
  assert.equal(payload.version, 1);
  assert.equal(payload.exportedAt, '2026-01-03T00:00:00.000Z');
  assert.deepEqual(payload.books, [{
    title: 'Dune',
    pages: [['one'], ['two']],
    chapters: [{ title: 'Start', pageIndex: 0 }],
    currentPage: 1,
    currentSentenceIdx: 0,
    updatedAt: T1
  }]);
  assert.deepEqual(payload.bookmarks, [{
    bookTitle: 'Dune',
    page: 2,
    sentenceIdx: 3,
    snippet: 'hello',
    createdAt: T1
  }]);
  assert.equal('id' in payload.books[0], false);
  assert.equal('id' in payload.bookmarks[0], false);
});

test('a written file parses back to the same books and bookmarks', () => {
  const written = buildBackupPayload([book('Dune'), book('Solaris')], [mark('Dune')], '2026-01-03T00:00:00.000Z');
  const parsed = parseBackupPayload(JSON.stringify(written));

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.payload.books, written.books);
  assert.deepEqual(parsed.payload.bookmarks, written.bookmarks);
});

test('an empty shelf still produces a valid file', () => {
  const parsed = parseBackupPayload(JSON.stringify(buildBackupPayload([], [], '2026-01-03T00:00:00.000Z')));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.payload.books, []);
});

test('malformed files are refused instead of half-merged', () => {
  const cases = [
    ['', 'empty'],
    ['   ', 'whitespace only'],
    ['not json at all', 'invalid JSON'],
    ['[]', 'array root'],
    [JSON.stringify({ format: 'other-app', version: 1, books: [], bookmarks: [] }), 'wrong format'],
    [JSON.stringify({ format: 'marginalia-backup', version: 2, books: [], bookmarks: [] }), 'future version'],
    [JSON.stringify({ format: 'marginalia-backup', version: 1, books: [] }), 'missing bookmarks array'],
    [JSON.stringify({ format: 'marginalia-backup', version: 1, bookmarks: [] }), 'missing books array']
  ];

  for (const [text, label] of cases) {
    const parsed = parseBackupPayload(text);
    assert.equal(parsed.ok, false, `${label} must be refused`);
    assert.equal(typeof parsed.error, 'string');
    assert.ok(parsed.error.length > 0, `${label} must explain itself`);
  }
});

test('restore adds new books, keeps device-only books, and never duplicates a title', () => {
  const existing = [book('Dune'), book('Solaris')];
  const incoming = [book('Ubik'), book('Dune', { currentPage: 5, updatedAt: T2 })];

  const merged = mergeShelfRecords(existing, incoming);

  assert.equal(merged.added, 1);
  assert.equal(merged.updated, 1);
  assert.equal(merged.books.length, 3);
  assert.equal(merged.books.filter((b) => b.title === 'Dune').length, 1);
  assert.equal(merged.books.find((b) => b.title === 'Dune').currentPage, 5, 'the newer position wins');
  assert.equal(merged.books.find((b) => b.title === 'Dune').id, 3, 'the local id is kept so the write updates in place');
  assert.ok(merged.books.find((b) => b.title === 'Solaris'), 'a book only on this device survives');
});

test('an older backup never rolls a device position backwards', () => {
  const existing = [book('Dune', { currentPage: 9, updatedAt: T2 })];
  const incoming = [book('Dune', { currentPage: 1, updatedAt: T1 })];

  const merged = mergeShelfRecords(existing, incoming);

  assert.equal(merged.added, 0);
  assert.equal(merged.updated, 0);
  assert.equal(merged.books[0].currentPage, 9);
});

test('restore ignores entries with no usable title', () => {
  const merged = mergeShelfRecords([], [null, { pages: [] }, { title: 42 }]);
  assert.deepEqual(merged.books, []);
});

test('bookmarks are deduplicated by content across device and file', () => {
  const existing = [mark('Dune'), mark('Solaris')];
  const incoming = [mark('Dune'), mark('Ubik')];

  const merged = mergeBookmarks(existing, incoming);

  assert.equal(merged.length, 3);
  assert.deepEqual(merged.map((m) => m.bookTitle), ['Dune', 'Solaris', 'Ubik']);
});

test('two bookmarks on the same page but different sentences are both kept', () => {
  const merged = mergeBookmarks([mark('Dune', { sentenceIdx: 1 })], [mark('Dune', { sentenceIdx: 2 })]);
  assert.equal(merged.length, 2);
});
