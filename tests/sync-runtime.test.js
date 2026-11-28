// tests/sync-runtime.test.js
//
// The pure merge tests cover the decision table; this one runs public/app.js against a small fake
// IndexedDB and a Supabase-shaped client so the wiring around it is exercised too: ids are reused on
// an edit, tombstones travel, another account's rows stay put, and the modal has a visible status.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
const appJs = readFileSync(fileURLToPath(new URL('../public/app.js', import.meta.url)), 'utf8');
const openDoms = [];
after(() => { for (const dom of openDoms) dom.window.close(); });

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

function setupDom() {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://marginalia-rme.vercel.app/' });
  openDoms.push(dom);
  dom.window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  dom.window.speechSynthesis = { getVoices: () => [], speak: () => {}, cancel: () => {}, pause: () => {}, resume: () => {}, addEventListener: () => {} };
  dom.window.SpeechSynthesisUtterance = function (text) { this.text = text; };
  dom.window.Audio = function () { return { play: async () => {}, pause: () => {}, addEventListener: () => {} }; };
  dom.window.navigator.serviceWorker = { register: async () => ({ update: async () => {} }), addEventListener: () => {} };
  dom.window.JSZip = { loadAsync: async () => ({ files: {} }) };
  dom.window.mammoth = { convertToHtml: async () => ({ value: '' }), images: { imgElement: () => {} } };
  return dom;
}

function fakeDb(seed = {}) {
  const maps = {
    books: new Map(),
    bookmarks: new Map(),
    annotations: new Map(),
    vocabulary: new Map(),
    audio_cache: new Map(),
    pdf_binaries: new Map()
  };
  let nextId = 1;
  const puts = [];
  for (const [name, rows] of Object.entries(seed)) {
    for (const row of rows) {
      const id = row.id == null ? nextId++ : row.id;
      maps[name].set(id, { ...row, id });
      if (id >= nextId) nextId = id + 1;
    }
  }

  const storeFor = (name) => ({
    getAll() {
      const req = {};
      setTimeout(() => {
        req.result = Array.from(maps[name].values()).map((row) => ({ ...row }));
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    },
    get(id) {
      const req = {};
      setTimeout(() => {
        req.result = maps[name].has(id) ? { ...maps[name].get(id) } : undefined;
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    },
    put(record) {
      const req = {};
      const id = record.id == null ? nextId++ : record.id;
      puts.push({ store: name, ...record });
      maps[name].set(id, { ...record, id });
      setTimeout(() => {
        req.result = id;
        if (req.onsuccess) req.onsuccess({ target: req });
      }, 0);
      return req;
    },
    add(record) {
      const req = {};
      const id = nextId++;
      puts.push({ store: name, ...record });
      maps[name].set(id, { ...record, id });
      setTimeout(() => {
        req.result = id;
        if (req.onsuccess) req.onsuccess({ target: req });
      }, 0);
      return req;
    },
    delete(id) {
      const req = {};
      maps[name].delete(id);
      setTimeout(() => {
        req.result = undefined;
        if (req.onsuccess) req.onsuccess({ target: req });
      }, 0);
      return req;
    }
  });

  return {
    maps,
    puts,
    open() {
      const req = {};
      setTimeout(() => {
        req.result = {
          objectStoreNames: { contains: (name) => name in maps },
          transaction: () => {
            const tx = { objectStore: (name) => storeFor(name) };
            setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 10);
            return tx;
          }
        };
        if (req.onsuccess) req.onsuccess({ target: req });
      }, 0);
      return req;
    }
  };
}

function fakeSupabase({ annotations = [], vocabulary = [], userId = 'user-1' } = {}) {
  const upserts = [];
  const tables = {
    user_annotations: annotations.map((row) => ({ ...row })),
    user_vocabulary: vocabulary.map((row) => ({ ...row })),
    user_bookmarks: [],
    user_books: []
  };
  let serverClock = Date.now() + DAY;

  const builderFor = (table) => {
    const query = {
      select: () => query,
      eq: () => query,
      gte: () => query,
      order: () => query,
      range: async (from, to) => ({ data: tables[table].slice(from, to + 1), error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve, reject) => Promise.resolve({ data: tables[table], error: null }).then(resolve, reject),
      upsert: (rows) => {
        const list = Array.isArray(rows) ? rows : [rows];
        upserts.push({ table, rows: list });
        for (const row of list) {
          const stamp = new Date(++serverClock).toISOString();
          const key = table === 'user_vocabulary'
            ? (r) => r.word
            : table === 'user_annotations'
              ? (r) => [r.book_title, r.page, r.sentence_idx, r.type].join('|')
              : () => '';
          const existing = tables[table].find((r) => key(r) === key(row));
          const stored = { ...row, updated_at: stamp };
          if (existing) Object.assign(existing, stored);
          else tables[table].push(stored);
        }
        return { select: async () => ({ data: list, error: null }), then: (resolve) => Promise.resolve({ error: null }).then(resolve) };
      },
      delete: () => query
    };
    return query;
  };

  const client = {
    auth: {
      getSession: async () => ({ data: { session: userId ? { access_token: 'token', user: { id: userId } } : null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } })
    },
    from: (table) => builderFor(table)
  };
  return { client, upserts, tables };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

test('the app edits, deletes and scopes notes and words across accounts', async () => {
  const now = Date.now();
  const db = fakeDb({
    annotations: [
      { id: 1, bookTitle: 'Dune', page: 1, sentenceIdx: 0, quoteText: 'local old', noteText: '', color: 'amber', ownerId: 'user-1', updatedAt: now - 2 * DAY + 60 * 60 * 1000, lastSyncedAt: now - 2 * DAY },
      { id: 3, bookTitle: 'Dune', page: 3, sentenceIdx: 0, quoteText: 'local only', noteText: '', color: 'amber', ownerId: 'user-1', updatedAt: now - DAY, lastSyncedAt: 0 },
      { id: 4, bookTitle: 'Dune', page: 4, sentenceIdx: 0, quoteText: 'other account', noteText: '', color: 'amber', ownerId: 'user-2', updatedAt: now - DAY, lastSyncedAt: 0 },
      { id: 5, bookTitle: 'Dune', page: 5, sentenceIdx: 0, quoteText: 'deleted locally', noteText: '', color: 'amber', ownerId: 'user-1', updatedAt: now, deletedAt: now, lastSyncedAt: 0 },
      { id: 6, bookTitle: 'Dune', page: 6, sentenceIdx: 0, quoteText: 'deleted remotely', noteText: '', color: 'amber', ownerId: 'user-1', updatedAt: now - 2 * DAY, lastSyncedAt: now - 2 * DAY }
    ],
    vocabulary: [
      { id: 1, word: 'litany', partOfSpeech: 'noun', definition: 'local', bookTitle: 'Dune', context: '', ownerId: 'user-1', updatedAt: now - DAY, lastSyncedAt: 0 }
    ]
  });
  const { client, upserts, tables } = fakeSupabase({
    annotations: [
      { user_id: 'user-1', book_title: 'Dune', page: 1, sentence_idx: 0, text: 'remote new', type: 'highlight', color: 'amber', note_text: '', created_at: iso(now - 3 * DAY), updated_at: iso(now - DAY), deleted_at: null },
      { user_id: 'user-1', book_title: 'Dune', page: 2, sentence_idx: 0, text: 'remote only', type: 'highlight', color: 'mint', note_text: '', created_at: iso(now - DAY), updated_at: iso(now - DAY), deleted_at: null },
      { user_id: 'user-1', book_title: 'Dune', page: 6, sentence_idx: 0, text: 'deleted remotely', type: 'highlight', color: 'amber', note_text: '', created_at: iso(now - 2 * DAY), updated_at: iso(now), deleted_at: iso(now) }
    ],
    vocabulary: [
      { user_id: 'user-1', word: 'sandworm', part_of_speech: 'noun', definition: 'remote', book_title: 'Dune', context: '', created_at: iso(now - DAY), updated_at: iso(now - DAY), deleted_at: null }
    ]
  });

  const dom = setupDom();
  dom.window.indexedDB = { open: () => db.open() };
  dom.window.supabase = { createClient: () => client };
  dom.window.confirm = () => true;
  dom.window.eval(appJs);
  await settle();

  const visible = await dom.window.getAnnotationsFromDB('Dune');
  const quotes = Array.from(visible, (a) => a.quoteText).sort();
  assert.deepEqual(quotes, ['local old', 'local only', 'remote new', 'remote only'], 'the losing edit is kept beside the winner');
  assert.equal(db.maps.annotations.get(1).quoteText, 'remote new', 'the edit reused the local row');
  assert.equal(db.maps.annotations.size, 6, 'remote tombstone removed its row; local tombstone and conflict copy remain');
  const conflictCopy = visible.find((a) => a.conflictOf);
  assert.equal(conflictCopy.quoteText, 'local old', 'both devices edited since the last sync, so the local text was kept');
  assert.equal(conflictCopy.page, 1);
  assert.equal(conflictCopy.lastSyncedAt >= conflictCopy.updatedAt, true, 'the copy is not queued for the cloud');
  assert.equal(db.maps.annotations.has(6), false, 'remote-deleted note is gone');
  assert.ok(db.maps.annotations.get(5).deletedAt, 'local delete stayed as a tombstone for the push');
  assert.equal(db.maps.annotations.get(4).quoteText, 'other account', 'another account row was not touched');

  const annotationUpsert = upserts.filter((u) => u.table === 'user_annotations').pop();
  assert.ok(annotationUpsert, 'the local-only note and tombstone were pushed');
  assert.deepEqual(Array.from(annotationUpsert.rows, (r) => r.page).sort(), [3, 5]);
  assert.ok(annotationUpsert.rows.find((r) => r.page === 5).deleted_at);
  assert.equal(annotationUpsert.rows.some((r) => r.page === 4), false, 'another account row was never pushed');
  assert.equal(annotationUpsert.rows.some((r) => r.page === 1), false, 'the conflict copy stays on this device');

  assert.equal(tables.user_annotations.find((r) => r.page === 3).text, 'local only');
  const vocab = await dom.window.getVocabFromDB();
  assert.deepEqual(Array.from(vocab, (v) => v.word).sort(), ['litany', 'sandworm'], 'words sync both ways');
  assert.equal(dom.window.document.getElementById('syncHealthNote').textContent.includes('Synced'), true, 'the status is visible');

  dom.window.setSyncOwner('user-2');
  const other = await dom.window.getAnnotationsFromDB('Dune');
  assert.deepEqual(Array.from(other, (a) => a.quoteText), ['other account'], 'switching accounts hides the first account notes');
  dom.window.setSyncOwner('user-1');
  const back = await dom.window.getAnnotationsFromDB('Dune');
  assert.equal(back.length, 4, 'switching back restores the first account view');
});

test('a declined claim is remembered for that account and leaves the unowned rows untouched', async () => {
  const now = Date.now();
  const db = fakeDb({
    annotations: [
      {
        id: 1,
        bookTitle: 'Dune',
        page: 0,
        sentenceIdx: 0,
        quoteText: 'written before sign-in',
        noteText: '',
        color: 'amber',
        ownerId: '',
        updatedAt: now - DAY,
        lastSyncedAt: 0
      }
    ]
  });

  const first = setupDom();
  const firstSupabase = fakeSupabase({ annotations: [] });
  first.window.indexedDB = { open: () => db.open() };
  first.window.supabase = { createClient: () => firstSupabase.client };
  first.window.confirm = () => false;
  first.window.eval(appJs);
  await settle();

  assert.equal(first.window.localStorage.getItem('marginalia_claim_declined_v1_user-1'), '1', 'the no is stored for this account');
  assert.equal(db.maps.annotations.get(1).ownerId, '', 'declining does not adopt the record');

  // The next launch starts from the same storage and the same unowned row. If the prompt still ran,
  // this confirm would accept it and the row would change owner.
  const second = setupDom();
  const secondSupabase = fakeSupabase({ annotations: [] });
  let prompts = 0;
  second.window.localStorage.setItem('marginalia_claim_declined_v1_user-1', '1');
  second.window.indexedDB = { open: () => db.open() };
  second.window.supabase = { createClient: () => secondSupabase.client };
  second.window.confirm = () => { prompts += 1; return true; };
  second.window.eval(appJs);
  await settle();

  assert.equal(prompts, 0, 'a remembered decline is not asked again on the next launch');
  assert.equal(db.maps.annotations.get(1).ownerId, '', 'and the unowned record is still untouched');

  // Another account has its own answer: the same device still offers the records to it.
  const other = setupDom();
  const otherSupabase = fakeSupabase({ annotations: [], userId: 'user-2' });
  let otherPrompts = 0;
  other.window.localStorage.setItem('marginalia_claim_declined_v1_user-1', '1');
  other.window.indexedDB = { open: () => db.open() };
  other.window.supabase = { createClient: () => otherSupabase.client };
  other.window.confirm = () => { otherPrompts += 1; return false; };
  other.window.eval(appJs);
  await settle();

  assert.equal(otherPrompts, 1, 'the decline is scoped to the account that gave it');
  assert.equal(db.maps.annotations.get(1).ownerId, '', 'and that account declining also leaves it untouched');
});

test('a kept conflict copy is visible in the notes list and never reaches the account', async () => {
  const now = Date.now();
  const db = fakeDb({
    annotations: [
      {
        id: 1,
        bookTitle: 'Marginalia Quickstart',
        page: 0,
        sentenceIdx: 0,
        quoteText: 'the sentence',
        noteText: 'the version that lost',
        color: 'amber',
        ownerId: 'user-1',
        createdAt: now - 2 * DAY,
        updatedAt: now,
        lastSyncedAt: now,
        conflictOf: ['Marginalia Quickstart', 0, 0, 'note'].join('\u0000'),
        conflictFrom: 'device',
        conflictAt: now
      }
    ]
  });
  const { client, upserts } = fakeSupabase();

  const dom = setupDom();
  dom.window.indexedDB = { open: () => db.open() };
  dom.window.supabase = { createClient: () => client };
  dom.window.confirm = () => true;
  dom.window.eval(appJs);
  await settle();

  await dom.window.showAnnotationsModal();
  const list = dom.window.document.getElementById('annotationsModalList');
  assert.match(list.textContent, /Conflict copy/, 'the copy is labelled in the reader');
  assert.match(list.textContent, /the version that lost/);
  assert.match(
    dom.window.document.getElementById('annotationsCountSummary').textContent,
    /1 conflict copy/,
    'the count warns the reader instead of hiding the extra row'
  );
  assert.equal(
    upserts.filter((u) => u.table === 'user_annotations').length,
    0,
    'a conflict copy is never pushed'
  );
});

test('a tombstone both devices agree on is dropped instead of waiting forever', async () => {
  const now = Date.now();
  const db = fakeDb({
    annotations: [
      {
        id: 2,
        bookTitle: 'Dune',
        page: 7,
        sentenceIdx: 0,
        quoteText: 'deleted here and there',
        noteText: '',
        color: 'amber',
        ownerId: 'user-1',
        updatedAt: now,
        deletedAt: now,
        lastSyncedAt: now - DAY
      }
    ]
  });
  const { client, upserts } = fakeSupabase({
    annotations: [
      {
        user_id: 'user-1',
        book_title: 'Dune',
        page: 7,
        sentence_idx: 0,
        text: 'deleted here and there',
        type: 'highlight',
        color: 'amber',
        note_text: '',
        created_at: iso(now - 2 * DAY),
        updated_at: iso(now),
        deleted_at: iso(now)
      }
    ]
  });

  const dom = setupDom();
  dom.window.indexedDB = { open: () => db.open() };
  dom.window.supabase = { createClient: () => client };
  dom.window.confirm = () => true;
  dom.window.eval(appJs);
  await settle();

  assert.equal(db.maps.annotations.has(2), false, 'the agreed tombstone is cleared from the device');
  assert.equal(
    upserts.filter((u) => u.table === 'user_annotations').length,
    0,
    'nothing is pushed: both sides already agree'
  );
  assert.match(
    dom.window.document.getElementById('syncHealthNote').textContent,
    /Synced/,
    'the stale tombstone no longer holds the status on "waiting"'
  );
});

test('an account switch during the pull aborts the write instead of re-filing the rows', async () => {
  const now = Date.now();
  const db = fakeDb();
  const base = fakeSupabase();
  let hijack = false;
  const client = {
    auth: base.client.auth,
    from(table) {
      const query = base.client.from(table);
      if (table === 'user_annotations') {
        const range = query.range;
        query.range = async (...args) => {
          if (hijack) dom.window.setSyncOwner('user-2');
          return range(...args);
        };
      }
      return query;
    }
  };

  const dom = setupDom();
  dom.window.indexedDB = { open: () => db.open() };
  dom.window.supabase = { createClient: () => client };
  dom.window.confirm = () => true;
  dom.window.eval(appJs);
  await settle();

  base.tables.user_annotations.push({
    user_id: 'user-1',
    book_title: 'Dune',
    page: 11,
    sentence_idx: 0,
    text: 'belongs to the first account',
    type: 'highlight',
    color: 'amber',
    note_text: '',
    created_at: iso(now - DAY),
    updated_at: iso(now),
    deleted_at: null
  });

  hijack = true;
  await dom.window.syncAnnotationsFromCloud();
  assert.equal(db.maps.annotations.size, 0, 'the in-flight pull wrote nothing after the switch');

  // The next sync belongs to whichever account is active, so it applies the row normally.
  hijack = false;
  await dom.window.syncAnnotationsFromCloud();
  const applied = Array.from(db.maps.annotations.values());
  assert.equal(applied.length, 1, 'the aborted sync did not poison the next one');
  assert.equal(applied[0].ownerId, 'user-1');
});
