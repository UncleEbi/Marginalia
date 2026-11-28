// tests/annotation-sync.test.js
//
// Highlights and margin notes are pulled from the account and merged by the same key the cloud
// table is unique on. The account's row set doubles as the retry queue: local notes the pull did
// not return are pushed again on the next sync.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractFunction } from './helpers/extract-function.mjs';

const annotationFromCloudRow = extractFunction('annotationFromCloudRow');
const annotationKey = extractFunction('annotationKey');
const selectMissingAnnotations = extractFunction('selectMissingAnnotations');
const annotationCloudRow = extractFunction('annotationCloudRow');
const pushAnnotationsToCloud = extractFunction('pushAnnotationsToCloud');
globalThis.annotationCloudRow = annotationCloudRow;
// selectMissingAnnotations resolves annotationKey from the global scope, the same way the browser
// script resolves one top-level function from another.
globalThis.annotationKey = annotationKey;

const note = (overrides = {}) => ({
  bookTitle: 'Dune',
  page: 2,
  sentenceIdx: 3,
  quoteText: 'fear is the mind-killer',
  noteText: '',
  color: 'amber',
  ...overrides
});

test('a cloud row becomes the local annotation shape', () => {
  const ann = annotationFromCloudRow({
    book_title: 'Dune',
    page: 2,
    sentence_idx: 3,
    text: 'fear is the mind-killer',
    type: 'highlight',
    color: 'mint',
    note_text: '',
    created_at: '2026-01-03T00:00:00.000Z'
  });

  assert.deepEqual(ann, {
    bookTitle: 'Dune',
    page: 2,
    sentenceIdx: 3,
    quoteText: 'fear is the mind-killer',
    noteText: '',
    color: 'mint',
    createdAt: Date.parse('2026-01-03T00:00:00.000Z')
  });
  assert.equal(annotationFromCloudRow(null), null);
  assert.equal(annotationFromCloudRow({ page: 1 }), null, 'a row without a book title is ignored');
});

test('the key matches the table: book, page, sentence and note-versus-highlight', () => {
  assert.equal(annotationKey(note()), annotationKey(note({ id: 99, color: 'mint' })));
  assert.notEqual(annotationKey(note()), annotationKey(note({ noteText: 'litany' })));
  assert.notEqual(annotationKey(note()), annotationKey(note({ page: 3 })));
  assert.equal(annotationKey(null), null);
});

test('only pulled notes this device lacks are selected, and duplicates collapse', () => {
  const local = [note()];
  const incoming = [note(), note({ page: 4 }), note({ page: 4 }), note({ page: 4, noteText: 'x' })];

  const missing = selectMissingAnnotations(local, incoming);
  assert.equal(missing.length, 2);
  assert.deepEqual(missing.map((a) => a.page), [4, 4]);
  assert.equal(missing[1].noteText, 'x');
});

test('malformed lists never throw', () => {
  assert.deepEqual(selectMissingAnnotations(null, null), []);
  assert.deepEqual(selectMissingAnnotations([], [{ page: 1 }]), []);
});

test('every missing note is pushed in one upsert, with the session user', async () => {
  const calls = [];
  globalThis.supabaseClient = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'user-1' } } } }) },
    from: (table) => ({
      upsert: async (rows, options) => {
        calls.push({ table, rows, options });
        return { error: null };
      }
    })
  };

  try {
    assert.equal(await pushAnnotationsToCloud([note(), note({ page: 9, noteText: 'litany' })]), true);
    assert.equal(calls.length, 1, 'one request for the whole batch');
    assert.equal(calls[0].table, 'user_annotations');
    assert.equal(calls[0].rows.length, 2);
    assert.deepEqual(calls[0].rows.map((row) => row.user_id), ['user-1', 'user-1']);
    assert.equal(calls[0].rows[1].type, 'note');
    assert.equal(calls[0].options.onConflict, 'user_id,book_title,page,sentence_idx,type');
  } finally {
    delete globalThis.supabaseClient;
  }
});

test('a signed-out or empty batch never reaches the network', async () => {
  let called = false;
  globalThis.supabaseClient = {
    auth: { getSession: async () => ({ data: { session: null } }) },
    from: () => ({ upsert: async () => { called = true; return { error: null }; } })
  };
  try {
    assert.equal(await pushAnnotationsToCloud([note()]), false);
    assert.equal(await pushAnnotationsToCloud([]), false);
    assert.equal(called, false);
  } finally {
    delete globalThis.supabaseClient;
  }
});

test('annotation sync runs at startup and on the background reconnect path', () => {
  const app = readFileSync(fileURLToPath(new URL('../public/app.js', import.meta.url)), 'utf8');
  const background = app.slice(app.indexOf('function scheduleBackgroundSync'), app.indexOf("window.addEventListener('online'"));
  assert.match(background, /syncAnnotationsFromCloud\(\);/, 'online/visible sync pulls annotations');
  const startup = app.slice(app.indexOf('initIndexedDB().then(() => {'));
  assert.match(startup, /syncAnnotationsFromCloud\(\);/, 'startup pulls annotations');
});
