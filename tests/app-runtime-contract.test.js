// tests/app-runtime-contract.test.js
//
// Verifies that public/app.js evaluates without runtime errors when loaded in the browser DOM,
// that all referenced element IDs exist in public/index.html, and that document upload
// works cleanly for unauthenticated freemium visitors without throwing missing-function errors.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const htmlPath = fileURLToPath(new URL('../public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../public/app.js', import.meta.url));
const html = readFileSync(htmlPath, 'utf8');
const appJs = readFileSync(appPath, 'utf8');

// app.js starts a 1s progress interval at load. jsdom runs timers on Node's event loop, so every
// window created here has to be closed or `node --test` never exits after the assertions pass.
const openDoms = [];
after(() => {
  for (const dom of openDoms) dom.window.close();
});

function setupTestDom() {
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'https://marginalia-rme.vercel.app/'
  });
  openDoms.push(dom);

  dom.window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  dom.window.speechSynthesis = {
    getVoices: () => [],
    speak: () => {},
    cancel: () => {},
    pause: () => {},
    resume: () => {},
    addEventListener: () => {}
  };
  dom.window.SpeechSynthesisUtterance = function (text) { this.text = text; };
  dom.window.Audio = function () {
    return {
      play: async () => {},
      pause: () => {},
      addEventListener: () => {}
    };
  };
  dom.window.indexedDB = {
    open: () => ({
      onupgradeneeded: null,
      onsuccess: null,
      onerror: null
    })
  };
  dom.window.navigator.serviceWorker = {
    register: async () => ({ update: async () => {} }),
    addEventListener: () => {}
  };
  dom.window.supabase = {
    createClient: () => ({
      auth: {
        getSession: async () => ({ data: { session: null } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } })
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null })
          })
        })
      })
    })
  };
  dom.window.JSZip = {
    loadAsync: async () => ({ files: {} })
  };
  dom.window.mammoth = {
    convertToHtml: async () => ({ value: '' }),
    images: { imgElement: () => {} }
  };
  return dom;
}

test('app.js initializes and executes on index.html DOM without errors', () => {
  const dom = setupTestDom();
  assert.doesNotThrow(() => {
    dom.window.eval(appJs);
  }, 'app.js evaluates without ReferenceError or TypeError');
});

test('unauthenticated file upload executes freemium processing without error or alert', async () => {
  const dom = setupTestDom();
  let alertMessage = null;
  dom.window.alert = (msg) => { alertMessage = msg; };

  dom.window.eval(appJs);

  const fileInput = dom.window.document.getElementById('fileInput');
  assert.ok(fileInput, 'fileInput exists in DOM');

  const fakeFile = {
    name: 'chapter1.txt',
    arrayBuffer: async () => new TextEncoder().encode('Call me Ishmael. Some years ago never mind how long precisely.').buffer
  };
  Object.defineProperty(fileInput, 'files', {
    value: [fakeFile],
    configurable: true
  });

  fileInput.dispatchEvent(new dom.window.Event('change'));
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(alertMessage, null, `no alert triggered during upload, got: ${alertMessage}`);
  assert.equal(dom.window.document.getElementById('docTitle').textContent, 'chapter1.txt');
});

test('the shelf renders local data before it reconciles with the cloud', () => {
  assert.doesNotMatch(appJs, /await restoreProgressFromCloud\(\)/, 'nothing may await the cloud pull');

  const start = appJs.indexOf('async function showShelfModal');
  const end = appJs.indexOf('navRecentList.addEventListener');
  assert.ok(start > -1 && end > start, 'showShelfModal is discoverable in app.js');
  const shelfBody = appJs.slice(start, end);

  assert.ok(
    shelfBody.indexOf("shelfModal.style.display = 'flex'") < shelfBody.indexOf('restoreProgressFromCloud()'),
    'the cloud pull starts only after the shelf is visible'
  );
  assert.ok(shelfBody.includes('skipCloudSync'), 'the re-render after a sync cannot start another pull');
});

test('the shelf backup controls and storage note exist in index.html', () => {
  const dom = setupTestDom();
  for (const id of ['exportLibraryBtn', 'importLibraryBtn', 'importLibraryInput', 'shelfStorageNote']) {
    assert.ok(dom.window.document.getElementById(id), `${id} exists in the shelf modal`);
  }
});

test('app.js evaluates when the browser refuses persistent storage', () => {
  const dom = setupTestDom();
  Object.defineProperty(dom.window.navigator, 'storage', {
    configurable: true,
    value: {
      persist: async () => false,
      estimate: async () => ({ usage: 5 * 1024 * 1024 })
    }
  });

  assert.doesNotThrow(() => { dom.window.eval(appJs); });
});

test('profileRefillBalance and profileRefillBalanceTopup exist in index.html', () => {
  assert.ok(html.includes('id="profileRefillBalance"'), 'profileRefillBalance element exists in HTML');
  assert.ok(html.includes('id="profileRefillBalanceTopup"'), 'profileRefillBalanceTopup element exists in HTML');
});

test('openProfileModal falls back gracefully when topup columns are missing', async () => {
  const dom = setupTestDom();
  let queryCount = 0;
  dom.window.supabase = {
    createClient: () => ({
      auth: {
        getSession: async () => ({
          data: {
            session: {
              user: { id: 'test-user-id', email: 'test@example.com' }
            }
          }
        }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } })
      },
      from: () => ({
        select: (cols) => ({
          eq: () => ({
            maybeSingle: async () => {
              queryCount++;
              if (cols.includes('topup_neural_chars')) {
                return {
                  data: null,
                  error: { message: "column 'topup_neural_chars' does not exist", code: '42703' }
                };
              }
              return {
                data: {
                  neural_chars_remaining: 3500,
                  summary_credits_remaining: 2,
                  tier: 'free'
                },
                error: null
              };
            }
          })
        })
      })
    })
  };

  dom.window.eval(appJs);
  const navProfileItem = dom.window.document.getElementById('navProfileItem');
  navProfileItem.dispatchEvent(new dom.window.Event('click'));
  await new Promise((r) => setTimeout(r, 200));

  assert.ok(queryCount >= 2, 'second fallback query was executed after column error');
  assert.equal(dom.window.document.getElementById('profileModalTier').textContent, '⚡ Free Trial Account');
  assert.equal(dom.window.document.getElementById('profileNeuralCount').textContent, '3,500 / 5,000 Chars');
});

// --- OFFLINE WRITE QUEUE ---
// A shelf that is real enough for the queue: open() succeeds on a later tick, getAll hands back
// copies, and put() records what was written so a test can see the flag move.
function fakeBookDB(initialBooks = [], initialBookmarks = []) {
  const books = new Map(initialBooks.map((book) => [book.title, { ...book }]));
  const bookmarks = new Map(initialBookmarks.map((mark, index) => [mark.id ?? index + 1, { ...mark }]));
  const puts = [];
  let nextBookmarkId = bookmarks.size + 1;

  const storeFor = (name) => {
    if (name === 'books') {
      return {
        getAll() {
          const req = {};
          setTimeout(() => {
            req.result = Array.from(books.values()).map((book) => ({ ...book }));
            if (req.onsuccess) req.onsuccess();
          }, 0);
          return req;
        },
        put(record) {
          puts.push({ ...record });
          books.set(record.title, { ...record });
        },
        delete() {}
      };
    }
    return {
      getAll() {
        const req = {};
        setTimeout(() => {
          req.result = Array.from(bookmarks.values()).map((mark) => ({ ...mark }));
          if (req.onsuccess) req.onsuccess();
        }, 0);
        return req;
      },
      put(record) {
        puts.push({ ...record });
        const id = record.id == null ? nextBookmarkId++ : record.id;
        bookmarks.set(id, { ...record, id });
      },
      add(record) {
        puts.push({ ...record });
        const id = nextBookmarkId++;
        bookmarks.set(id, { ...record, id });
      },
      delete(id) {
        bookmarks.delete(id);
      }
    };
  };

  return {
    books,
    bookmarks,
    puts,
    open() {
      const req = {};
      setTimeout(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          transaction: () => {
            const tx = { objectStore: (name) => storeFor(name) };
            // Callers resolve on tx.oncomplete (writeRecords, deleteBookmarkFromDB), so fire it a
            // tick after the operations they queue synchronously in this transaction.
            setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 5);
            return tx;
          }
        };
        if (req.onsuccess) req.onsuccess({ target: req });
      }, 0);
      return req;
    }
  };
}

// A signed-in client whose upserts can be switched between failing (offline) and succeeding.
function queueSupabase({ userId = 'user-1', failing = () => true, stamped = [], cloudRows = [] } = {}) {
  const upserts = [];
  const client = {
    auth: {
      getSession: async () => ({
        data: { session: userId ? { access_token: 'token-1', user: { id: userId } } : null }
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } })
    },
    from(table) {
      return {
        select: () => ({
          // Awaiting the .eq() result is how the pull reads rows; .maybeSingle() is how the profile
          // query reads one, so the same object has to serve both.
          eq: () => Object.assign(Promise.resolve({ data: cloudRows, error: null }), {
            maybeSingle: async () => ({ data: null, error: null })
          })
        }),
        upsert: (rows, options) => {
          upserts.push({ table, rows, options });
          return {
            select: async () => (failing()
              ? { data: null, error: { message: 'offline' } }
              : { data: stamped, error: null })
          };
        }
      };
    }
  };
  return { client, upserts };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

function pendingDune() {
  return {
    id: 1,
    title: 'Dune',
    pages: [['a page of text']],
    chapters: [],
    currentPage: 2,
    currentSentenceIdx: 1,
    updatedAt: Date.now() - 60000,
    pendingSync: true
  };
}

test('a position written offline is pushed and settled when the device reconnects', async () => {
  const dom = setupTestDom();
  const writtenAt = Date.now() - 60000;
  const db = fakeBookDB([{ ...pendingDune(), updatedAt: writtenAt }]);
  dom.window.indexedDB = { open: () => db.open() };

  let offline = true;
  const { client, upserts } = queueSupabase({ failing: () => offline });
  dom.window.supabase = { createClient: () => client };

  dom.window.eval(appJs);
  await settle();

  assert.equal(db.books.get('Dune').pendingSync, true, 'a failed startup push leaves the debt in place');
  assert.ok(upserts.length >= 1, 'startup tried to push the owed row');

  offline = false;
  const attemptsBefore = upserts.length;
  dom.window.dispatchEvent(new dom.window.Event('online'));
  await settle();

  assert.ok(upserts.length > attemptsBefore, 'the reconnect retried the push');
  // The rows were built inside the jsdom realm, so compare their plain JSON shape, not prototypes.
  assert.deepEqual(JSON.parse(JSON.stringify(upserts[upserts.length - 1].rows)), [{
    title: 'Dune',
    current_page: 2,
    current_sentence: 1,
    updated_at: new Date(writtenAt).toISOString(),
    user_id: 'user-1'
  }]);
  assert.equal(upserts[upserts.length - 1].options.onConflict, 'user_id,title');
  assert.equal(db.books.get('Dune').pendingSync, false, 'a confirmed push settles the row');
});

test('a push that fails again leaves the position owed for the next attempt', async () => {
  const dom = setupTestDom();
  const db = fakeBookDB([pendingDune()]);
  dom.window.indexedDB = { open: () => db.open() };

  const { client, upserts } = queueSupabase({ failing: () => true });
  dom.window.supabase = { createClient: () => client };

  dom.window.eval(appJs);
  await settle();
  const attemptsBefore = upserts.length;
  dom.window.dispatchEvent(new dom.window.Event('online'));
  await settle();

  assert.ok(upserts.length > attemptsBefore, 'the retry was attempted');
  assert.equal(db.books.get('Dune').pendingSync, true, 'nothing was settled by a failed push');
  assert.equal(db.puts.length, 0, 'no write was made to the shelf');
});

test('a confirmed push stores the timestamp the database returned', async () => {
  const dom = setupTestDom();
  const writtenAt = Date.now() - 60000;
  const serverAt = new Date(writtenAt + 5000).toISOString();
  const db = fakeBookDB([{ ...pendingDune(), updatedAt: writtenAt }]);
  dom.window.indexedDB = { open: () => db.open() };

  const { client } = queueSupabase({ failing: () => false, stamped: [{ title: 'Dune', updated_at: serverAt }] });
  dom.window.supabase = { createClient: () => client };

  dom.window.eval(appJs);
  await settle();

  assert.equal(db.books.get('Dune').updatedAt, Date.parse(serverAt), 'the server clock replaces the device clock');
  assert.equal(db.books.get('Dune').pendingSync, false);
});

test('a page turn made on a slow clock is not rolled back by its own older cloud row', async () => {
  const dom = setupTestDom();
  const cloudStamp = new Date(Date.now() - 60000).toISOString();
  const db = fakeBookDB([{
    ...pendingDune(),
    currentPage: 7,
    updatedAt: Date.now() - 120000, // behind the row this device synced a minute ago
    pendingSync: true,
    lastCloudStamp: Date.parse(cloudStamp)
  }]);
  dom.window.indexedDB = { open: () => db.open() };

  const { client, upserts } = queueSupabase({
    failing: () => false,
    cloudRows: [{ title: 'Dune', current_page: 2, current_sentence: 0, updated_at: cloudStamp }],
    stamped: [{ title: 'Dune', updated_at: new Date().toISOString() }]
  });
  dom.window.supabase = { createClient: () => client };

  dom.window.eval(appJs);
  await settle();

  assert.equal(db.books.get('Dune').currentPage, 7, 'the fresh page turn survives the pull');
  assert.ok(upserts.length >= 1, 'and it is the position that was pushed');
  assert.equal(JSON.parse(JSON.stringify(upserts[upserts.length - 1].rows))[0].current_page, 7);
});

test('the queue stays dormant when nobody is signed in', async () => {
  const dom = setupTestDom();
  const db = fakeBookDB([pendingDune()]);
  dom.window.indexedDB = { open: () => db.open() };

  const { client, upserts } = queueSupabase({ userId: null });
  dom.window.supabase = { createClient: () => client };

  dom.window.eval(appJs);
  await settle();
  dom.window.dispatchEvent(new dom.window.Event('online'));
  await settle();

  assert.equal(upserts.length, 0, 'signed out, nothing is pushed');
  assert.equal(db.books.get('Dune').pendingSync, true, 'the debt waits for the next sign-in');
});

test('local saves mark the row owed, adopted cloud rows settle it, and only a confirmed push clears it', () => {
  const save = appJs.slice(
    appJs.indexOf('async function updateBookProgressInDB'),
    appJs.indexOf('async function saveBookmarkToDB')
  );
  assert.ok(save.includes('pendingSync = true'), 'a local save marks the book as owed');

  const adopt = appJs.slice(
    appJs.indexOf('async function applyCloudProgressToDB'),
    appJs.indexOf('async function restoreProgressFromCloud')
  );
  assert.ok(adopt.includes('pendingSync = false'), 'an adopted position supersedes the debt');

  const flush = appJs.slice(
    appJs.indexOf('async function flushPendingProgress'),
    appJs.indexOf('// DURABLE STORAGE + BACKUP')
  );
  assert.ok(flush.includes('if (!push.ok) return 0;'), 'a failed push leaves the debt in place');
  assert.ok(flush.includes('clearPendingProgress(rows, push.stamped)'), 'a confirmed push settles and stamps');
});

test('the queue retries on reconnect, when the page is shown, and at startup', () => {
  assert.ok(appJs.includes("window.addEventListener('online', () => scheduleBackgroundSync())"), 'online retry');
  assert.ok(appJs.includes("document.addEventListener('visibilitychange', () => {"), 'visibility retry');
  assert.ok(appJs.includes('if (!document.hidden) scheduleBackgroundSync(5000);'), 'shown-again retry is debounced');
  assert.ok(appJs.includes('syncBookmarksFromCloud();'), 'bookmarks catch up on the same triggers');
  assert.ok(
    appJs.includes('restoreProgressFromCloud().then(() => { flushPendingProgress(); })'),
    'startup flushes whatever the pull did not cover'
  );
});

// --- BOOKMARK SYNC ---
// A client for the bookmark paths: pull returns the given rows, upserts and deletes are recorded.
// `deleteHangs` makes the cloud delete never resolve, which is how the test proves the local delete
// does not wait on the network.
function bookmarkSupabase({ userId = 'user-1', cloudRows = [], failPush = false, deleteHangs = false } = {}) {
  const state = { upserts: [], deletes: [] };
  const client = {
    auth: {
      getSession: async () => ({
        data: { session: userId ? { access_token: 'token-1', user: { id: userId } } : null }
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } })
    },
    from(table) {
      return {
        select: () => {
          const rows = table === 'user_bookmarks' ? cloudRows : [];
          return {
            eq: () => Object.assign(Promise.resolve({ data: rows, error: null }), {
              maybeSingle: async () => ({ data: null, error: null })
            })
          };
        },
        upsert: (rows, options) => {
          state.upserts.push({ table, rows, options });
          return Promise.resolve({ error: failPush ? { message: 'offline' } : null });
        },
        delete: () => ({
          match: async (filters) => {
            state.deletes.push(filters);
            if (deleteHangs) await new Promise(() => {});
            return { error: null };
          }
        })
      };
    }
  };
  return { client, state };
}

function openBookmarks(dom) {
  const nav = dom.window.document.getElementById('navBookmarks');
  assert.ok(nav, 'the drawer has a bookmarks entry');
  nav.dispatchEvent(new dom.window.Event('click'));
}

test('the bookmarks modal shows local rows and adopts the account\'s', async () => {
  const dom = setupTestDom();
  const db = fakeBookDB([], [{
    id: 1, bookTitle: 'Dune', page: 2, sentenceIdx: 0, snippet: 'local quote', createdAt: Date.now()
  }]);
  dom.window.indexedDB = { open: () => db.open() };

  const { client } = bookmarkSupabase({
    cloudRows: [{
      book_title: 'Ubik', page: 4, sentence_idx: 1, snippet: 'cloud quote', created_at: new Date().toISOString()
    }]
  });
  dom.window.supabase = { createClient: () => client };

  dom.window.eval(appJs);
  await settle();
  openBookmarks(dom);
  await settle();

  assert.equal(db.bookmarks.size, 2, 'the cloud row was written locally');
  const text = dom.window.document.getElementById('bookmarksModalList').textContent;
  assert.ok(text.includes('Dune'), 'the local bookmark renders');
  assert.ok(text.includes('Ubik'), 'the adopted bookmark renders');
  assert.ok(text.includes('cloud quote'), 'the quoted sentence came along, as the modal says it does');
});

test('the modal renders local rows before it asks the account for more', () => {
  const start = appJs.indexOf('async function showBookmarksModal');
  const end = appJs.indexOf("navBookmarks.addEventListener");
  assert.ok(start > -1 && end > start, 'showBookmarksModal is discoverable');
  const body = appJs.slice(start, end);

  assert.ok(
    body.indexOf("bookmarksModal.style.display = 'flex'") < body.indexOf('syncBookmarksFromCloud()'),
    'the pull starts only after the list is on screen'
  );
  assert.ok(body.includes('skipCloudSync'), 'the re-render after a sync cannot start another pull');
});

test('deleting a bookmark removes its cloud row without waiting for the network', async () => {
  const dom = setupTestDom();
  const db = fakeBookDB([], [{
    id: 1, bookTitle: 'Dune', page: 2, sentenceIdx: 0, snippet: 'local quote', createdAt: Date.now()
  }]);
  dom.window.indexedDB = { open: () => db.open() };
  dom.window.confirm = () => true;

  const { client, state } = bookmarkSupabase({ deleteHangs: true });
  dom.window.supabase = { createClient: () => client };

  dom.window.eval(appJs);
  await settle();
  openBookmarks(dom);
  await settle();

  const del = dom.window.document.querySelector('#bookmarksModalList .shelf-delete-btn');
  assert.ok(del, 'the bookmark row has a delete control');
  del.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await settle();

  assert.equal(db.bookmarks.size, 0, 'the local delete did not wait on the hanging cloud delete');
  assert.deepEqual(JSON.parse(JSON.stringify(state.deletes)), [{
    user_id: 'user-1',
    book_title: 'Dune',
    page: 2,
    sentence_idx: 0
  }]);
});

test('bookmark sync stays quiet when signed out', async () => {
  const dom = setupTestDom();
  const db = fakeBookDB([], [{
    id: 1, bookTitle: 'Dune', page: 2, sentenceIdx: 0, snippet: 'local quote', createdAt: Date.now()
  }]);
  dom.window.indexedDB = { open: () => db.open() };

  const { client, state } = bookmarkSupabase({ userId: null });
  dom.window.supabase = { createClient: () => client };

  dom.window.eval(appJs);
  await settle();
  openBookmarks(dom);
  await settle();

  assert.equal(state.upserts.length, 0, 'nothing is pushed without an account');
  assert.equal(db.bookmarks.size, 1, 'and the local bookmark is untouched');
});

test('the bookmarks modal states that the quoted sentence syncs', () => {
  assert.ok(
    html.includes('Bookmarks sync with your account, including the quoted sentence.'),
    'the copy that makes the snippet leaving the device explicit'
  );
});

