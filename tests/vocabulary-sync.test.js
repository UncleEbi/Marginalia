// tests/vocabulary-sync.test.js
//
// Words sync through the same engine as notes: the account's updated_at is the clock, a deletion is a
// tombstone and the newer side of each word wins. Unlike a note, a word keeps no conflict copy: the
// list holds one card per word, so a copy would duplicate the card and the next pull would overwrite
// it anyway. The IndexedDB wiring is covered in sync-runtime.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractFunction } from './helpers/extract-function.mjs';

const rowRemoteTime = extractFunction('rowRemoteTime');
const recordTime = extractFunction('recordTime');
const sameSyncFields = extractFunction('sameSyncFields');
const vocabularyFromCloudRow = extractFunction('vocabularyFromCloudRow');
const vocabularyKey = extractFunction('vocabularyKey');
const vocabularyCloudRow = extractFunction('vocabularyCloudRow');
const syncableRows = extractFunction('syncableRows');
const planSync = extractFunction('planSync');
const pushSyncRows = extractFunction('pushSyncRows');

Object.assign(globalThis, {
  rowRemoteTime,
  recordTime,
  sameSyncFields,
  vocabularyFromCloudRow,
  vocabularyKey,
  vocabularyCloudRow,
  syncableRows,
  planSync,
  pushSyncRows,
  SYNC_BATCH_SIZE: 400
});

const entity = {
  table: 'user_vocabulary',
  conflictTarget: 'user_id,word',
  stampedColumns: 'word,updated_at',
  fields: [['partOfSpeech', ''], ['definition', ''], ['bookTitle', ''], ['context', '']],
  key: vocabularyKey,
  fromRow: vocabularyFromCloudRow,
  toRow: vocabularyCloudRow
};

const entry = (overrides = {}) => ({
  word: 'prescience',
  partOfSpeech: 'noun',
  definition: 'knowledge of events before they occur',
  bookTitle: 'Dune',
  context: 'the spice grants prescience',
  updatedAt: Date.parse('2026-01-03T00:00:00.000Z'),
  lastSyncedAt: 0,
  ...overrides
});

const cloudRow = (overrides = {}) => ({
  word: 'prescience',
  part_of_speech: 'noun',
  definition: 'knowledge of events before they occur',
  book_title: 'Dune',
  context: 'the spice grants prescience',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-03T00:00:00.000Z',
  deleted_at: null,
  ...overrides
});

test('a cloud row becomes the local word shape and is lowercased', () => {
  const word = vocabularyFromCloudRow(cloudRow({ word: '  Prescience  ' }));

  assert.deepEqual(word, {
    word: 'prescience',
    partOfSpeech: 'noun',
    definition: 'knowledge of events before they occur',
    bookTitle: 'Dune',
    context: 'the spice grants prescience',
    createdAt: Date.parse('2026-01-01T00:00:00.000Z'),
    updatedAt: Date.parse('2026-01-03T00:00:00.000Z'),
    deletedAt: 0,
    lastSyncedAt: Date.parse('2026-01-03T00:00:00.000Z')
  });
  assert.equal(vocabularyFromCloudRow(null), null);
  assert.equal(vocabularyFromCloudRow({ word: '   ' }), null, 'a row without a word is ignored');
});

test('the key is the trimmed lowercase word, matching the table key', () => {
  assert.equal(vocabularyKey(entry({ word: '  Prescience ' })), 'prescience');
  assert.equal(vocabularyKey(entry({ word: 'Prescience' })), vocabularyKey(entry()));
  assert.equal(vocabularyKey(null), '');
});

test('a remote word this device lacks is pulled', () => {
  const plan = planSync(entity, [], [cloudRow()]);
  assert.equal(plan.toLocal.length, 1);
  assert.equal(plan.toLocal[0].remote.definition, 'knowledge of events before they occur');
  assert.equal(plan.toRemote.length, 0);
});

test('a local word the account lacks is pushed, including its tombstone', () => {
  assert.equal(planSync(entity, [entry()], []).toRemote.length, 1);

  const deletedAt = Date.parse('2026-01-04T00:00:00.000Z');
  const plan = planSync(entity, [entry({ deletedAt, updatedAt: deletedAt })], []);
  assert.equal(plan.toRemote.length, 1);
  assert.equal(plan.toRemote[0].deletedAt, deletedAt);
});

test('the newer remote edit replaces an older local copy', () => {
  const local = entry({ definition: 'old', lastSyncedAt: Date.parse('2026-01-02T00:00:00.000Z') });
  const plan = planSync(entity, [local], [cloudRow({
    definition: 'new',
    updated_at: '2026-01-04T00:00:00.000Z'
  })]);
  assert.equal(plan.toLocal.length, 1);
  assert.equal(plan.toLocal[0].remote.definition, 'new');
  assert.equal(plan.toRemote.length, 0);
});

test('the newer local edit is pushed over an older remote copy', () => {
  const local = entry({ definition: 'local edit', updatedAt: Date.parse('2026-01-05T00:00:00.000Z') });
  const plan = planSync(entity, [local], [cloudRow()]);
  assert.equal(plan.toRemote.length, 1);
  assert.equal(plan.toRemote[0].definition, 'local edit');
  assert.equal(plan.toRemote[0].word, 'prescience');
});

test('a remote tombstone removes the local word instead of resurrecting it', () => {
  const local = entry({ id: 12, lastSyncedAt: Date.parse('2026-01-02T00:00:00.000Z') });
  const plan = planSync(entity, [local], [cloudRow({
    deleted_at: '2026-01-04T00:00:00.000Z',
    updated_at: '2026-01-04T00:00:00.000Z'
  })]);
  assert.deepEqual(plan.toLocal, [{ removeId: 12 }]);
  assert.equal(plan.toRemote.length, 0);
});

test('identical words settle instead of being rewritten', () => {
  const at = Date.parse('2026-01-03T00:00:00.000Z');
  const plan = planSync(entity, [entry({ id: 21, lastSyncedAt: at })], [cloudRow()]);
  assert.equal(plan.toLocal.length, 0);
  assert.equal(plan.toRemote.length, 0);
  assert.deepEqual(plan.settled, [{ id: 21, at, deleted: false }]);
});

test('both sides edited: the newer word wins and no conflict copy is planned', () => {
  const plan = planSync(
    entity,
    [entry({ definition: 'device', lastSyncedAt: Date.parse('2026-01-02T00:00:00.000Z') })],
    [cloudRow({ definition: 'account', updated_at: '2026-01-04T00:00:00.000Z' })]
  );
  assert.equal(plan.conflicts.length, 1, 'the engine can report the clash');
  assert.equal(plan.toLocal[0].remote.definition, 'account');
  assert.equal(
    entity.buildConflictCopy,
    undefined,
    'this store has no copy builder, so the clash does not spawn a duplicate card'
  );
});

test('pushes a word with its account, key, tombstone and conflict target', async () => {
  const calls = [];
  globalThis.supabaseClient = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'user-1' } } } }) },
    from: (table) => ({
      upsert: (rows, options) => {
        calls.push({ table, rows, options });
        return { select: async () => ({ data: rows, error: null }) };
      }
    })
  };
  try {
    const deletedAt = Date.parse('2026-01-04T00:00:00.000Z');
    const result = await pushSyncRows(entity, [
      entry({ word: '  Prescience ' }),
      entry({ word: 'spice', deletedAt, updatedAt: deletedAt })
    ]);
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].table, 'user_vocabulary');
    assert.equal(calls[0].options.onConflict, 'user_id,word');
    assert.deepEqual(calls[0].rows.map((row) => row.user_id), ['user-1', 'user-1']);
    assert.equal(calls[0].rows[0].word, 'prescience');
    assert.equal(calls[0].rows[1].deleted_at, new Date(deletedAt).toISOString());
  } finally {
    delete globalThis.supabaseClient;
  }
});

test('words and notes share one engine and one table definition', () => {
  const app = readFileSync(fileURLToPath(new URL('../public/app.js', import.meta.url)), 'utf8');
  const all = app.slice(app.indexOf('const SYNC_ENTITIES = {'), app.indexOf('async function keepConflictCopies'));
  const config = all.slice(all.indexOf('  vocabulary: {'));

  assert.match(config, /table: 'user_vocabulary'/);
  assert.match(config, /conflictTarget: 'user_id,word'/);
  assert.match(config, /stampedColumns: 'word,updated_at'/);
  assert.match(config, /buildConflictCopy: null/, 'a word keeps no duplicate card');
  assert.match(
    app,
    /function syncVocabularyFromCloud\(\) \{\s*return syncEntity\('vocabulary'\);/,
    'words are not a separate sync implementation'
  );
  assert.ok(!app.includes('planVocabularySync'), 'the duplicate word planner is gone');
});
