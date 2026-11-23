// tests/bookmark-sync.test.js
//
// Bookmark sync is additive: pull the account's rows, adopt the ones this device is missing, then
// push the whole local set. These tests pin the pure decisions and the exact cloud shape with a
// fake client, so the real public/app.js code is exercised rather than a copy.

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFunction } from './helpers/extract-function.mjs';

const bookmarkFromCloudRow = extractFunction('bookmarkFromCloudRow');
const selectMissingBookmarks = extractFunction('selectMissingBookmarks');
const selectBookmarksToPush = extractFunction('selectBookmarksToPush');
const pullCloudBookmarks = extractFunction('pullCloudBookmarks');
const pushBookmarksToCloud = extractFunction('pushBookmarksToCloud');
const deleteCloudBookmark = extractFunction('deleteCloudBookmark');

const ISO = '2026-01-02T03:04:05.000Z';
const AT = Date.parse(ISO);

function localMark(overrides = {}) {
  return {
    id: 4,
    bookTitle: 'Dune',
    page: 3,
    sentenceIdx: 1,
    snippet: 'A beginning is a very delicate time.',
    createdAt: AT,
    ...overrides
  };
}

function cloudRow(overrides = {}) {
  return {
    book_title: 'Dune',
    page: 3,
    sentence_idx: 1,
    snippet: 'A beginning is a very delicate time.',
    created_at: ISO,
    ...overrides
  };
}

function fakeClient({ data = [], error = null } = {}) {
  const calls = { tables: [], selects: [], upserts: [], deletes: [] };
  const client = {
    from(table) {
      calls.tables.push(table);
      return {
        select(columns) {
          calls.selects.push(['select', columns]);
          return {
            eq(column, value) {
              calls.selects.push([column, value]);
              return Promise.resolve({ data, error });
            }
          };
        },
        upsert(rows, options) {
          calls.upserts.push({ rows, options });
          return Promise.resolve({ error });
        },
        delete() {
          return {
            match(filters) {
              calls.deletes.push(filters);
              return Promise.resolve({ error });
            }
          };
        }
      };
    }
  };
  return { client, calls };
}

async function quiet(fn) {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = originalWarn;
  }
}

test('a cloud row becomes a local bookmark, clamped and with a parsed date', () => {
  assert.deepEqual(bookmarkFromCloudRow(cloudRow()), {
    bookTitle: 'Dune',
    page: 3,
    sentenceIdx: 1,
    snippet: 'A beginning is a very delicate time.',
    createdAt: AT
  });

  const clamped = bookmarkFromCloudRow(cloudRow({ page: -2, sentence_idx: 'nope', snippet: null, created_at: 'not-a-date' }));
  assert.equal(clamped.page, 0);
  assert.equal(clamped.sentenceIdx, 0);
  assert.equal(clamped.snippet, '');
  assert.ok(Number.isFinite(clamped.createdAt), 'a bad date falls back to now instead of NaN');
});

test('unreadable cloud rows are dropped', () => {
  assert.equal(bookmarkFromCloudRow(null), null);
  assert.equal(bookmarkFromCloudRow({ book_title: 42 }), null);
});

test('only bookmarks this device is missing are adopted', () => {
  const missing = selectMissingBookmarks(
    [localMark()],
    [
      localMark(),
      localMark({ page: 9, snippet: 'Somewhere else entirely.' }),
      localMark({ bookTitle: 'Ubik', page: 1, sentenceIdx: 0 })
    ]
  );

  assert.deepEqual(
    missing.map((m) => ({ title: m.bookTitle, page: m.page, sentence: m.sentenceIdx })),
    [
      { title: 'Dune', page: 9, sentence: 1 },
      { title: 'Ubik', page: 1, sentence: 0 }
    ]
  );
});

test('a differing snippet does not duplicate a bookmark at the same coordinates', () => {
  const missing = selectMissingBookmarks(
    [localMark({ snippet: 'trimmed locally…' })],
    [localMark({ snippet: 'A beginning is a very delicate time.' })]
  );

  assert.deepEqual(missing, [], 'the coordinates are the identity, not the quote');
});

test('adopting ignores malformed input', () => {
  assert.deepEqual(selectMissingBookmarks(null, null), []);
  assert.deepEqual(selectMissingBookmarks([{ page: 1 }], [null, { bookTitle: 7 }]), []);
});

test('the push sends the whole local set as cloud rows', () => {
  const rows = selectBookmarksToPush([
    localMark(),
    { bookTitle: 'Ubik', page: -1, sentenceIdx: 'x', snippet: null }
  ]);

  assert.deepEqual(rows[0], {
    book_title: 'Dune',
    page: 3,
    sentence_idx: 1,
    snippet: 'A beginning is a very delicate time.',
    created_at: ISO
  });
  assert.equal(rows[1].book_title, 'Ubik');
  assert.equal(rows[1].page, 0, 'a corrupt page cannot be pushed as negative');
  assert.equal(rows[1].sentence_idx, 0);
  assert.equal(rows[1].snippet, '');
  assert.ok(Number.isFinite(Date.parse(rows[1].created_at)), 'a missing date becomes now');
});

test('the pull reads only bookmark columns for one account', async () => {
  const rows = [cloudRow()];
  const { client, calls } = fakeClient({ data: rows });

  assert.deepEqual(await pullCloudBookmarks(client, 'user-1'), rows);
  assert.deepEqual(calls.tables, ['user_bookmarks']);
  assert.deepEqual(calls.selects, [
    ['select', 'book_title, page, sentence_idx, snippet, created_at'],
    ['user_id', 'user-1']
  ]);
});

test('the pull and push are no-ops when signed out or empty', async () => {
  const { client, calls } = fakeClient();

  assert.deepEqual(await pullCloudBookmarks(null, 'user-1'), []);
  assert.equal(await pushBookmarksToCloud(client, null, [localMark()]), false);
  assert.equal(await pushBookmarksToCloud(client, 'user-1', []), false);
  assert.deepEqual(calls.tables, []);
});

test('the pull swallows a query error', async () => {
  const { client } = fakeClient({ error: { message: 'boom' } });
  assert.deepEqual(await quiet(() => pullCloudBookmarks(client, 'user-1')), []);
});

test('the push upserts on the coordinates and stamps the owner', async () => {
  const { client, calls } = fakeClient();
  const rows = [{ book_title: 'Dune', page: 3, sentence_idx: 1, snippet: 'quote', created_at: ISO }];

  assert.equal(await pushBookmarksToCloud(client, 'user-1', rows), true);
  assert.deepEqual(calls.upserts, [{
    rows: [{ ...rows[0], user_id: 'user-1' }],
    options: { onConflict: 'user_id,book_title,page,sentence_idx' }
  }]);
});

test('a failed push reports failure instead of throwing', async () => {
  const { client } = fakeClient({ error: { message: 'nope' } });
  assert.equal(await quiet(() => pushBookmarksToCloud(client, 'user-1', [localMark()])), false);
});

test('deleting a bookmark targets exactly its coordinates and owner', async () => {
  const { client, calls } = fakeClient();

  assert.equal(await deleteCloudBookmark(client, 'user-1', localMark({ page: 7, sentenceIdx: 2 })), true);
  assert.deepEqual(calls.tables, ['user_bookmarks']);
  assert.deepEqual(calls.deletes, [{
    user_id: 'user-1',
    book_title: 'Dune',
    page: 7,
    sentence_idx: 2
  }]);
});

test('delete refuses without an account or a bookmark', async () => {
  const { client, calls } = fakeClient();

  assert.equal(await deleteCloudBookmark(null, 'user-1', localMark()), false);
  assert.equal(await deleteCloudBookmark(client, null, localMark()), false);
  assert.equal(await deleteCloudBookmark(client, 'user-1', null), false);
  assert.deepEqual(calls.tables, []);
});
