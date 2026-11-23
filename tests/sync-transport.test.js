// tests/sync-transport.test.js
//
// The cloud shape of progress sync, checked with a fake client: the exact columns read, the
// conflict target the upsert relies on, and the promise that no network or session failure can
// throw into the reader.

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFunction } from './helpers/extract-function.mjs';

const pullCloudProgress = extractFunction('pullCloudProgress');
const pushLocalProgressToCloud = extractFunction('pushLocalProgressToCloud');
const deleteCloudProgress = extractFunction('deleteCloudProgress');

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
            eq(column, value) {
              calls.deletes.push([column, value]);
              return {
                eq(column2, value2) {
                  calls.deletes.push([column2, value2]);
                  return Promise.resolve({ error });
                }
              };
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

test('pull reads only the progress columns for one account', async () => {
  const rows = [{ title: 'Dune', current_page: 3, current_sentence: 1, updated_at: '2026-01-02T00:00:00.000Z' }];
  const { client, calls } = fakeClient({ data: rows });

  assert.deepEqual(await pullCloudProgress(client, 'user-1'), rows);
  assert.deepEqual(calls.tables, ['user_books']);
  assert.deepEqual(calls.selects, [
    ['select', 'title, current_page, current_sentence, updated_at'],
    ['user_id', 'user-1']
  ]);
});

test('pull returns an empty list on a query error', async () => {
  const { client } = fakeClient({ error: { message: 'boom' } });
  assert.deepEqual(await quiet(() => pullCloudProgress(client, 'user-1')), []);
});

test('pull and push are no-ops when signed out', async () => {
  const { client, calls } = fakeClient();

  assert.deepEqual(await pullCloudProgress(null, 'user-1'), []);
  assert.equal(await pushLocalProgressToCloud(client, null, [{ title: 'Dune' }]), false);
  assert.deepEqual(calls.tables, []);
});

test('push upserts with the user id and the unique conflict target', async () => {
  const { client, calls } = fakeClient();
  const rows = [{ title: 'Dune', current_page: 4, current_sentence: 2, updated_at: '2026-01-02T00:00:00.000Z' }];

  assert.equal(await pushLocalProgressToCloud(client, 'user-1', rows), true);
  assert.deepEqual(calls.tables, ['user_books']);
  assert.deepEqual(calls.upserts, [{
    rows: [{
      title: 'Dune',
      current_page: 4,
      current_sentence: 2,
      updated_at: '2026-01-02T00:00:00.000Z',
      user_id: 'user-1'
    }],
    options: { onConflict: 'user_id,title' }
  }]);
});

test('push keeps each row\'s own updated_at instead of stamping now', async () => {
  const { client, calls } = fakeClient();
  const original = '2025-12-31T23:00:00.000Z';

  await pushLocalProgressToCloud(client, 'user-1', [
    { title: 'Dune', current_page: 0, current_sentence: 0, updated_at: original }
  ]);

  assert.equal(calls.upserts[0].rows[0].updated_at, original);
});

test('push does nothing for an empty batch and reports failure on error', async () => {
  const { client, calls } = fakeClient();
  assert.equal(await pushLocalProgressToCloud(client, 'user-1', []), false);
  assert.deepEqual(calls.tables, []);

  const failing = fakeClient({ error: { message: 'nope' } });
  assert.equal(await quiet(() => pushLocalProgressToCloud(failing.client, 'user-1', [{ title: 'Dune' }])), false);
});

test('deleting a book removes exactly that account\'s row', async () => {
  const { client, calls } = fakeClient();

  assert.equal(await deleteCloudProgress(client, 'user-1', 'Dune'), true);
  assert.deepEqual(calls.tables, ['user_books']);
  assert.deepEqual(calls.deletes, [['user_id', 'user-1'], ['title', 'Dune']]);
});

test('delete reports failure on error and without arguments', async () => {
  const failing = fakeClient({ error: { message: 'nope' } });
  assert.equal(await quiet(() => deleteCloudProgress(failing.client, 'user-1', 'Dune')), false);
  assert.equal(await deleteCloudProgress(null, 'user-1', 'Dune'), false);
  assert.equal(await deleteCloudProgress(fakeClient().client, 'user-1', ''), false);
});
