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
const mergeAnnotations = extractFunction('mergeAnnotations');
const mergeVocabulary = extractFunction('mergeVocabulary');

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
  assert.equal(payload.version, 2);
  assert.deepEqual(payload.annotations, []);
  assert.deepEqual(payload.vocabulary, []);
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

test('notes and vocabulary travel in the same file', () => {
  const note = {
    id: 7, bookTitle: 'Dune', page: 2, sentenceIdx: 3, quoteText: 'fear is the mind-killer',
    noteText: 'litany', color: 'mint', createdAt: T1, updatedAt: T2
  };
  const word = {
    id: 8, word: 'Kwisatz', partOfSpeech: 'noun', definition: 'shortening of the way',
    bookTitle: 'Dune', context: 'Kwisatz Haderach', createdAt: T1, updatedAt: T2
  };

  const payload = buildBackupPayload([book('Dune')], [mark('Dune')], '2026-01-03T00:00:00.000Z', {
    annotations: [note],
    vocabulary: [word]
  });

  assert.equal(payload.version, 2);
  assert.equal(payload.annotations.length, 1);
  assert.equal(payload.annotations[0].noteText, 'litany');
  assert.equal('id' in payload.annotations[0], false, 'per-device ids are not written');
  assert.equal(payload.vocabulary[0].word, 'Kwisatz');
  assert.equal('id' in payload.vocabulary[0], false, 'per-device ids are not written');
});

test('a v1 backup still restores, with no notes or vocabulary', () => {
  const v1 = {
    format: 'marginalia-backup', version: 1, exportedAt: '2026-01-03T00:00:00.000Z',
    books: [book('Dune')], bookmarks: [mark('Dune')]
  };
  const parsed = parseBackupPayload(JSON.stringify(v1));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.payload.annotations, []);
  assert.deepEqual(parsed.payload.vocabulary, []);
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
    [JSON.stringify({ format: 'marginalia-backup', version: 3, books: [], bookmarks: [] }), 'future version'],
    [JSON.stringify({ format: 'marginalia-backup', version: 2, books: [], bookmarks: [] }), 'missing notes and vocabulary lists'],
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

function note(overrides = {}) {
  return {
    id: 4, bookTitle: 'Dune', page: 1, sentenceIdx: 2, quoteText: 'fear', noteText: '',
    color: 'amber', createdAt: T1, updatedAt: T1, ...overrides
  };
}

test('notes from the file replace a stale local copy but keep its id', () => {
  const merged = mergeAnnotations(
    [note({ noteText: 'old', updatedAt: T1 })],
    [note({ id: 99, noteText: 'litany', updatedAt: T2 })]
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 4, 'the local id is kept so the write updates in place');
  assert.equal(merged[0].noteText, 'litany');
});

test('a highlight and a note on the same sentence are two entries', () => {
  const merged = mergeAnnotations([note()], [note({ noteText: 'litany' })]);
  assert.equal(merged.length, 2);
});

test('an older note never overwrites the local one', () => {
  const merged = mergeAnnotations([note({ noteText: 'keep', updatedAt: T2 })], [note({ noteText: 'old', updatedAt: T1 })]);
  assert.equal(merged[0].noteText, 'keep');
});

test('vocabulary merges by word, case-insensitively, newest edit wins', () => {
  const merged = mergeVocabulary(
    [{ id: 5, word: 'Kwisatz', definition: 'old', updatedAt: T1 }],
    [{ id: 6, word: 'kwisatz', definition: 'new', updatedAt: T2 }, { word: 'Shai-Hulud', definition: 'worm' }]
  );
  assert.equal(merged.length, 2);
  assert.equal(merged.find((c) => c.word.toLowerCase() === 'kwisatz').definition, 'new');
  assert.equal(merged.find((c) => c.word.toLowerCase() === 'kwisatz').id, 5);
});
