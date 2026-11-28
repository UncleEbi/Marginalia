// tests/annotation-sync.test.js
//
// Notes sync in both directions through the shared sync engine: the account's updated_at is the
// clock, a deletion is a tombstone, the newer side of each key wins, and a lost edit is kept as a
// conflict copy. The browser-only IndexedDB wiring is covered in sync-runtime.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractFunction } from './helpers/extract-function.mjs';

const rowRemoteTime = extractFunction('rowRemoteTime');
const recordTime = extractFunction('recordTime');
const sameSyncFields = extractFunction('sameSyncFields');
const annotationFromCloudRow = extractFunction('annotationFromCloudRow');
const annotationKey = extractFunction('annotationKey');
const annotationCloudRow = extractFunction('annotationCloudRow');
const annotationConflictCopy = extractFunction('annotationConflictCopy');
const syncableRows = extractFunction('syncableRows');
const planSync = extractFunction('planSync');
const hasSameConflictCopy = extractFunction('hasSameConflictCopy');
const pushSyncRows = extractFunction('pushSyncRows');
const pullAllRows = extractFunction('pullAllRows');

Object.assign(globalThis, {
  rowRemoteTime,
  recordTime,
  sameSyncFields,
  annotationFromCloudRow,
  annotationKey,
  annotationCloudRow,
  annotationConflictCopy,
  syncableRows,
  planSync,
  hasSameConflictCopy,
  pushSyncRows,
  pullAllRows,
  SYNC_BATCH_SIZE: 400,
  SYNC_PAGE_SIZE: 500
});

// The same declaration the page uses, minus the IndexedDB side effects.
const entity = {
  table: 'user_annotations',
  conflictTarget: 'user_id,book_title,page,sentence_idx,type',
  stampedColumns: 'book_title,page,sentence_idx,type,updated_at',
  fields: [['quoteText', ''], ['noteText', ''], ['color', 'amber']],
  key: annotationKey,
  fromRow: annotationFromCloudRow,
  toRow: annotationCloudRow
};

const note = (overrides = {}) => ({
  bookTitle: 'Dune',
  page: 2,
  sentenceIdx: 3,
  quoteText: 'fear is the mind-killer',
  noteText: '',
  color: 'amber',
  updatedAt: Date.parse('2026-01-03T00:00:00.000Z'),
  lastSyncedAt: 0,
  ...overrides
});

const cloudRow = (overrides = {}) => ({
  book_title: 'Dune',
  page: 2,
  sentence_idx: 3,
  text: 'fear is the mind-killer',
  type: 'highlight',
  color: 'amber',
  note_text: '',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-03T00:00:00.000Z',
  deleted_at: null,
  ...overrides
});

test('a cloud row becomes the local annotation shape with its timestamps', () => {
  const ann = annotationFromCloudRow(cloudRow({ color: 'mint' }));

  assert.deepEqual(ann, {
    bookTitle: 'Dune',
    page: 2,
    sentenceIdx: 3,
    quoteText: 'fear is the mind-killer',
    noteText: '',
    color: 'mint',
    createdAt: Date.parse('2026-01-01T00:00:00.000Z'),
    updatedAt: Date.parse('2026-01-03T00:00:00.000Z'),
    deletedAt: 0,
    lastSyncedAt: Date.parse('2026-01-03T00:00:00.000Z')
  });
  assert.equal(annotationFromCloudRow(null), null);
  assert.equal(annotationFromCloudRow({ page: 1 }), null, 'a row without a book title is ignored');
});

test('the key matches the table: book, page, sentence and note-versus-highlight', () => {
  assert.equal(annotationKey(note()), annotationKey(note({ id: 99, color: 'mint' })));
  assert.notEqual(annotationKey(note()), annotationKey(note({ noteText: 'litany' })));
  assert.notEqual(annotationKey(note()), annotationKey(note({ page: 3 })));
  assert.equal(annotationKey(null), '');
});

test('a remote note this device lacks is pulled', () => {
  const plan = planSync(entity, [], [cloudRow()]);
  assert.equal(plan.toLocal.length, 1);
  assert.equal(plan.toLocal[0].remote.quoteText, 'fear is the mind-killer');
  assert.equal(plan.toRemote.length, 0);
});

test('a local note the account lacks is pushed, including its tombstone', () => {
  const live = planSync(entity, [note()], []);
  assert.equal(live.toRemote.length, 1);

  const deletedAt = Date.parse('2026-01-04T00:00:00.000Z');
  const deleted = planSync(entity, [note({ deletedAt, updatedAt: deletedAt })], []);
  assert.equal(deleted.toRemote.length, 1);
  assert.equal(deleted.toRemote[0].deletedAt, deletedAt);
});

test('the newer remote edit replaces an older local copy', () => {
  const local = note({ noteText: 'old', lastSyncedAt: Date.parse('2026-01-02T00:00:00.000Z') });
  const plan = planSync(entity, [local], [cloudRow({
    note_text: 'new',
    updated_at: '2026-01-04T00:00:00.000Z'
  })]);
  assert.equal(plan.toLocal.length, 1);
  assert.equal(plan.toLocal[0].remote.noteText, 'new');
  assert.equal(plan.toRemote.length, 0);
});

test('the newer local edit is pushed over an older remote copy', () => {
  const local = note({ quoteText: 'local edit', updatedAt: Date.parse('2026-01-05T00:00:00.000Z') });
  const plan = planSync(entity, [local], [cloudRow()]);
  assert.equal(plan.toRemote.length, 1);
  assert.equal(plan.toRemote[0].quoteText, 'local edit');
});

test('a remote tombstone removes the local row instead of resurrecting it', () => {
  const local = note({ id: 4, lastSyncedAt: Date.parse('2026-01-02T00:00:00.000Z') });
  const plan = planSync(entity, [local], [cloudRow({
    deleted_at: '2026-01-04T00:00:00.000Z',
    updated_at: '2026-01-04T00:00:00.000Z'
  })]);
  assert.deepEqual(plan.toLocal, [{ removeId: 4 }]);
  assert.equal(plan.toRemote.length, 0);
});

test('identical rows settle with the timestamp needed to stop counting them as pending', () => {
  const at = Date.parse('2026-01-03T00:00:00.000Z');
  const plan = planSync(entity, [note({ id: 7, lastSyncedAt: at })], [cloudRow()]);
  assert.equal(plan.toLocal.length, 0);
  assert.equal(plan.toRemote.length, 0);
  assert.deepEqual(plan.settled, [{ id: 7, at, deleted: false }]);
});

test('identical tombstones settle as deletions the account already agrees with', () => {
  const deletedAt = Date.parse('2026-01-04T00:00:00.000Z');
  const plan = planSync(
    entity,
    [note({ id: 8, deletedAt, updatedAt: deletedAt })],
    [cloudRow({ deleted_at: '2026-01-04T00:00:00.000Z', updated_at: '2026-01-04T00:00:00.000Z' })]
  );
  assert.deepEqual(plan.settled, [{ id: 8, at: deletedAt, deleted: true }]);
});

test('both sides edited since the last sync keeps the losing version as a local copy', () => {
  const local = note({ quoteText: 'device edit', lastSyncedAt: Date.parse('2026-01-02T00:00:00.000Z') });
  const plan = planSync(entity, [local], [cloudRow({ text: 'account edit', updated_at: '2026-01-04T00:00:00.000Z' })]);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.toLocal[0].remote.quoteText, 'account edit', 'the newer side still wins');

  const copy = annotationConflictCopy(plan.conflicts[0].local, plan.conflicts[0].remote);
  assert.equal(copy.quoteText, 'device edit', 'the local edit that lost is preserved');
  assert.equal(copy.noteText, '');
  assert.equal(copy.page, 2);
  assert.equal(copy.conflictFrom, 'device');
  assert.equal(copy.conflictOf, annotationKey(local));
  assert.equal(copy.id, undefined, 'the copy becomes its own local row');
  assert.ok(copy.lastSyncedAt >= copy.updatedAt, 'the copy is not queued for the account');
});

test('the copy keeps whichever side lost, not always the device side', () => {
  const local = note({ quoteText: 'device edit', updatedAt: Date.parse('2026-01-05T00:00:00.000Z') });
  const plan = planSync(entity, [local], [cloudRow({ text: 'account edit', updated_at: '2026-01-04T00:00:00.000Z' })]);
  assert.equal(plan.conflicts.length, 1);
  const copy = annotationConflictCopy(plan.conflicts[0].local, plan.conflicts[0].remote);
  assert.equal(copy.quoteText, 'account edit');
  assert.equal(copy.conflictFrom, 'account');
});

test('an edit that loses to a deletion survives, while a deletion that loses leaves no copy', () => {
  const local = note({ quoteText: 'noteworthy', lastSyncedAt: Date.parse('2026-01-02T00:00:00.000Z') });
  const deletedElsewhere = planSync(entity, [local], [cloudRow({
    deleted_at: '2026-01-04T00:00:00.000Z',
    updated_at: '2026-01-04T00:00:00.000Z'
  })]);
  assert.equal(deletedElsewhere.conflicts.length, 1);
  assert.equal(
    annotationConflictCopy(deletedElsewhere.conflicts[0].local, deletedElsewhere.conflicts[0].remote).quoteText,
    'noteworthy',
    'the note deleted on another device is still readable here'
  );

  const localDelete = note({
    deletedAt: Date.parse('2026-01-02T00:00:00.000Z'),
    updatedAt: Date.parse('2026-01-02T00:00:00.000Z'),
    lastSyncedAt: Date.parse('2026-01-01T00:00:00.000Z')
  });
  const editedElsewhere = planSync(entity, [localDelete], [cloudRow({
    text: 'account edit',
    updated_at: '2026-01-04T00:00:00.000Z'
  })]);
  assert.equal(editedElsewhere.conflicts.length, 1);
  assert.equal(
    annotationConflictCopy(editedElsewhere.conflicts[0].local, editedElsewhere.conflicts[0].remote),
    null,
    'a deletion has no text worth keeping'
  );
});

test('a retried sync does not add the same conflict copy twice', () => {
  const local = note({ quoteText: 'device edit', updatedAt: Date.parse('2026-01-05T00:00:00.000Z') });
  const plan = planSync(entity, [local], [cloudRow({ text: 'account edit', updated_at: '2026-01-04T00:00:00.000Z' })]);
  const copy = annotationConflictCopy(plan.conflicts[0].local, plan.conflicts[0].remote);

  assert.equal(hasSameConflictCopy([copy], copy, entity.fields), true, 'the kept copy already holds this version');
  assert.equal(hasSameConflictCopy([{ ...copy, noteText: 'different' }], copy, entity.fields), false);
  assert.equal(hasSameConflictCopy([], copy, entity.fields), false);
});

test('every missing note is pushed in capped upserts with the session user', async () => {
  const calls = [];
  globalThis.supabaseClient = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'user-1' } } } }) },
    from: (table) => ({
      upsert: (rows, options) => {
        calls.push({ table, rows, options });
        return {
          select: async () => ({ data: rows.map((row) => ({ ...row })), error: null })
        };
      }
    })
  };

  try {
    const result = await pushSyncRows(entity, [note(), note({ page: 9, noteText: 'litany' })]);
    assert.equal(result.ok, true);
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

test('caps a very large notebook at the batch size', async () => {
  const batches = [];
  globalThis.supabaseClient = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'user-1' } } } }) },
    from: () => ({
      upsert: (rows) => {
        batches.push(rows.length);
        return { select: async () => ({ data: rows, error: null }) };
      }
    })
  };
  try {
    const many = Array.from({ length: 801 }, (_, i) => note({ page: i }));
    const result = await pushSyncRows(entity, many);
    assert.equal(result.ok, true);
    assert.deepEqual(batches, [400, 400, 1]);
  } finally {
    delete globalThis.supabaseClient;
  }
});

test('a signed-out, empty or conflict-copy batch never reaches the network', async () => {
  let called = false;
  globalThis.supabaseClient = {
    auth: { getSession: async () => ({ data: { session: null } }) },
    from: () => ({ upsert: () => { called = true; return { select: async () => ({ error: null }) }; } })
  };
  try {
    assert.equal((await pushSyncRows(entity, [note()])).ok, false);
    assert.equal((await pushSyncRows(entity, [])).ok, true);
    assert.equal(
      (await pushSyncRows(entity, [note({ conflictOf: annotationKey(note()), conflictFrom: 'device' })])).ok,
      true,
      'the account already holds the version that won'
    );
    assert.equal(called, false);
  } finally {
    delete globalThis.supabaseClient;
  }
});

test('a full pull walks every page and never sends a cursor filter', async () => {
  const rows = Array.from({ length: 502 }, (_, i) => cloudRow({
    page: i,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: new Date(Date.parse('2026-01-02T00:00:00.000Z') + i).toISOString()
  }));
  const ranges = [];
  let cursorFree = true;
  globalThis.supabaseClient = {
    from: () => ({
      select: () => {
        const query = {
          eq: () => query,
          order: () => query,
          range: async (from, to) => {
            ranges.push([from, to]);
            return { data: rows.slice(from, to + 1), error: null };
          }
        };
        // No gte: reading a delta would need one, and a stored cursor is what this test guards
        // against. Touching it would throw and fail the test.
        return query;
      }
    })
  };
  try {
    const pulled = await pullAllRows('user_annotations', '*', 'user-1');
    assert.equal(pulled.length, 502);
    assert.deepEqual(ranges, [[0, 499], [500, 999]], 'paging is transport only');
    assert.equal(cursorFree, true);
  } finally {
    delete globalThis.supabaseClient;
  }
});

test('a full pull failure is surfaced instead of returning a partial notebook', async () => {
  globalThis.supabaseClient = {
    from: () => ({
      select: () => {
        const query = {
          eq: () => query,
          order: () => query,
          range: async () => ({ data: null, error: { message: 'offline' } })
        };
        return query;
      }
    })
  };
  try {
    await assert.rejects(() => pullAllRows('user_annotations', '*', 'user-1'), /offline/);
  } finally {
    delete globalThis.supabaseClient;
  }
});

test('both stores run through one engine wired to the real table and key', () => {
  const app = readFileSync(fileURLToPath(new URL('../public/app.js', import.meta.url)), 'utf8');
  const config = app.slice(app.indexOf('const SYNC_ENTITIES = {'), app.indexOf('async function keepConflictCopies'));

  assert.match(config, /table: 'user_annotations'/);
  assert.match(config, /conflictTarget: 'user_id,book_title,page,sentence_idx,type'/);
  assert.match(config, /stampedColumns: 'book_title,page,sentence_idx,type,updated_at'/);
  assert.match(config, /buildConflictCopy: annotationConflictCopy/, 'notes keep the losing edit');
  assert.match(config, /  vocabulary: \{/, 'both stores are declared in the same table');
  assert.match(
    app,
    /function syncAnnotationsFromCloud\(\) \{\s*return syncEntity\('annotations'\);/,
    'notes are not a separate sync implementation'
  );
  assert.ok(!app.includes('planAnnotationsSync'), 'the old per-store planner names are gone');
  assert.ok(!app.includes('sync_cursor'), 'no cursor state is persisted');
});

test('annotation sync runs at startup and on the background reconnect path', () => {
  const app = readFileSync(fileURLToPath(new URL('../public/app.js', import.meta.url)), 'utf8');
  const background = app.slice(app.indexOf('function scheduleBackgroundSync'), app.indexOf("window.addEventListener('online'"));
  assert.match(background, /syncAllCloudData\(\);/, 'online/visible sync pulls notes and words');

  const startup = app.slice(app.indexOf('initIndexedDB().then(() => {'));
  assert.match(startup, /syncAllCloudData\(\);/, 'startup pulls notes and words');
});
