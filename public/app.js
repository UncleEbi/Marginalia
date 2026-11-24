// --- iPHONE NOTCH / HOME-SCREEN APP ---
// env(safe-area-inset-*) only reports real values when the viewport opts in with viewport-fit=cover.
// Make sure it does, so the header can sit below the notch/status bar when installed to the Home Screen.
(function ensureViewportFitCover() {
  let meta = document.querySelector('meta[name="viewport"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'viewport';
    meta.content = 'width=device-width, initial-scale=1';
    document.head.appendChild(meta);
  }
  if (!/viewport-fit\s*=\s*cover/i.test(meta.content)) {
    meta.content = meta.content.replace(/\s*,?\s*$/, '') + ', viewport-fit=cover';
  }
})();

// --- SUPABASE CONFIGURATION ---
const SUPABASE_PROJECT_URL = "https://nnxphilhkhvwnitxvzdi.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5ueHBoaWxoa2h2d25pdHh2emRpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA5NzQzMDYsImV4cCI6MjEwNjU1MDMwNn0.LQetUHa6Os7UJl2NxvAph58vrvWNWbF_kcL9R2l-o3Y";

let supabaseClient = null;
if (SUPABASE_PROJECT_URL && !SUPABASE_PROJECT_URL.includes("your-project")) {
  try {
    supabaseClient = supabase.createClient(SUPABASE_PROJECT_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: window.localStorage
      }
    });
  } catch (err) {
    console.warn("Supabase init error:", err);
  }
}

// --- VISION IMAGE CAP ---
// Mirrors MAX_IMAGE_BASE64_CHARS in api/_lib/image-payload.js. Checked here first so a rendered page
// or figure that is too big is caught where its page number is known, instead of coming back as a 413
// in the middle of a scan.
const MAX_IMAGE_BASE64_CHARS = 2 * 1024 * 1024;
const FIGURE_TOO_LARGE_MSG = "That figure is too large to analyse. The page you were reading is still open.";

// --- PWA SERVICE WORKER ---
// (The Install App drawer item is set up further down, in setupInstallDrawerItem.)
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloadedForUpdate = false;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then((reg) => { reg.update().catch(() => { }); }) // look for a new version on every launch
      .catch((err) => console.warn('SW registration failed:', err));
  });

  // When a new version takes over, reload once so the phone stops showing stale files
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloadedForUpdate) return;
    reloadedForUpdate = true;
    location.reload();
  });
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// --- MODAL CONTROLLER ---
function closeModalById(id) {
  const modal = document.getElementById(id);
  if (modal) modal.style.display = 'none';
}

document.querySelectorAll('[data-close]').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeModalById(btn.getAttribute('data-close'));
  });
});

document.querySelectorAll('.modal-overlay').forEach(modal => {
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.style.display = 'none';
  });
});

// --- VOICE PILL (opens Settings) ---
const controlsToggleBar = document.getElementById('controlsToggleBar');
const activeVoiceBadge = document.getElementById('activeVoiceBadge');

// The old top configuration drawer is gone: the pill is a compact indicator whose tap
// opens the Settings modal, where the engine tabs, voice picker and auto-page now live.
controlsToggleBar.addEventListener('click', () => openOptionsModal());

// --- INDEXEDDB STORAGE ---
const DB_NAME = "MarginaliaBookDB";
const DB_VERSION = 3;
let dbInstance = null;

function initIndexedDB() {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("books")) {
          db.createObjectStore("books", { keyPath: "id", autoIncrement: true });
        }
        if (!db.objectStoreNames.contains("bookmarks")) {
          db.createObjectStore("bookmarks", { keyPath: "id", autoIncrement: true });
        }
        if (!db.objectStoreNames.contains("annotations")) {
          db.createObjectStore("annotations", { keyPath: "id", autoIncrement: true });
        }
        if (!db.objectStoreNames.contains("vocabulary")) {
          db.createObjectStore("vocabulary", { keyPath: "id", autoIncrement: true });
        }
        if (!db.objectStoreNames.contains("audio_cache")) {
          const audioStore = db.createObjectStore("audio_cache", { keyPath: "cacheKey" });
          audioStore.createIndex("lastAccessedAt", "lastAccessedAt", { unique: false });
        }
      };
      req.onsuccess = (e) => {
        dbInstance = e.target.result;
        resolve(dbInstance);
      };
      req.onerror = () => resolve(null);
    } catch (err) {
      resolve(null);
    }
  });
}

// --- INDEXEDDB AUDIO CACHE (100 MB LRU CAP) ---
const AUDIO_CACHE_MAX_BYTES = 100 * 1024 * 1024; // 100 MB
const AUDIO_CACHE_TARGET_BYTES = 85 * 1024 * 1024; // 85 MB

async function computeAudioCacheKey(engine, voice, speed, text) {
  const normalized = (text || '').trim().replace(/\s+/g, ' ');
  const str = `${engine}:${voice}:${speed}:${normalized}`;
  if (typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function') {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return `fallback_${Math.abs(h).toString(16)}`;
}

async function getAudioFromIdbCache(cacheKey) {
  if (!dbInstance) await initIndexedDB();
  if (!dbInstance || !dbInstance.objectStoreNames.contains('audio_cache')) return null;

  return new Promise((resolve) => {
    try {
      const tx = dbInstance.transaction(['audio_cache'], 'readwrite');
      const store = tx.objectStore('audio_cache');
      const req = store.get(cacheKey);

      req.onsuccess = () => {
        const item = req.result;
        if (!item || !item.blob) return resolve(null);
        item.lastAccessedAt = Date.now();
        store.put(item);
        resolve(item.blob);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function saveAudioToIdbCache(cacheKey, blob) {
  if (!blob || !blob.size) return false;
  if (!dbInstance) await initIndexedDB();
  if (!dbInstance || !dbInstance.objectStoreNames.contains('audio_cache')) return false;

  const sizeBytes = blob.size;
  return new Promise((resolve) => {
    try {
      const tx = dbInstance.transaction(['audio_cache'], 'readwrite');
      const store = tx.objectStore('audio_cache');
      const index = store.index('lastAccessedAt');

      let totalSize = sizeBytes;
      const entries = [];
      const cursorReq = index.openCursor();

      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          totalSize += cursor.value.sizeBytes || 0;
          entries.push({ key: cursor.primaryKey, size: cursor.value.sizeBytes || 0 });
          cursor.continue();
        } else {
          if (totalSize > AUDIO_CACHE_MAX_BYTES) {
            for (const entry of entries) {
              if (totalSize <= AUDIO_CACHE_TARGET_BYTES) break;
              store.delete(entry.key);
              totalSize -= entry.size;
            }
          }
          store.put({
            cacheKey,
            blob,
            sizeBytes,
            lastAccessedAt: Date.now()
          });
          resolve(true);
        }
      };
      cursorReq.onerror = () => {
        try {
          store.put({ cacheKey, blob, sizeBytes, lastAccessedAt: Date.now() });
          resolve(true);
        } catch {
          resolve(false);
        }
      };
    } catch {
      resolve(false);
    }
  });
}

async function saveBookToShelf(title, pages, chapters = []) {
  try {
    if (!dbInstance) await initIndexedDB();
    if (!dbInstance) return;
    const tx = dbInstance.transaction(["books"], "readwrite");
    const store = tx.objectStore("books");
    const req = store.getAll();
    req.onsuccess = () => {
      const existing = (req.result || []).find(b => b.title === title);
      if (existing) {
        existing.pages = pages;
        existing.chapters = chapters;
        existing.updatedAt = Date.now();
        store.put(existing);
      } else {
        store.add({
          title,
          pages,
          chapters,
          currentPage: 0,
          currentSentenceIdx: 0,
          updatedAt: Date.now()
        });
      }
    };
  } catch (err) {
    console.warn("Storage warning:", err);
  }
}

// Freemium teaser: save only page 1 data to shelf
async function saveBookToShelfFreemium(title, pages, chapters = []) {
  await saveBookToShelf(title, pages, chapters);
}

// Show teaser access notice (for unauthenticated users)
function showTeaserAccessNotice() {
  const existing = document.getElementById('freemiumTeaserNotice');
  if (existing) existing.remove();

  const notice = document.createElement('div');
  notice.id = 'freemiumTeaserNotice';
  notice.style.cssText = `
    position: fixed;
    top: 4.5rem;
    left: 50%;
    transform: translateX(-50%);
    background: var(--panel-bg);
    border: 1px solid var(--accent);
    padding: 0.65rem 1.1rem;
    border-radius: 8px;
    z-index: 1000;
    max-width: 90vw;
    font-size: 0.85rem;
    color: var(--text-main);
    text-align: center;
    box-shadow: 0 4px 14px rgba(0,0,0,0.35);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  `;
  notice.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: center; gap: 0.4rem;">
      <span>📖</span>
      <span>You're reading page 1 for free! Sign in to unlock chapters 2+</span>
    </div>
    <button id="teaserSignInBtn" type="button" style="padding: 0.4rem 0.8rem; background: var(--accent); color: #fff; border: none; border-radius: 6px; font-size: 0.8rem; font-weight: 600; cursor: pointer;">Sign In</button>
  `;
  notice.querySelector('#teaserSignInBtn').addEventListener('click', () => {
    notice.remove();
    openSignInDialog();
  });
  document.body.appendChild(notice);

  // Auto-remove after 6 seconds
  setTimeout(() => { if (notice.parentNode) notice.remove(); }, 6000);
}

// Show full access notice (for authenticated users)
function showFullAccessNotice() {
  showToast('✅ Full document access — all chapters available');
}

// --- BI-DIRECTIONAL SUPABASE CLOUD SYNC ---
async function syncBookmarkToCloud(bookTitle, page, sentenceIdx, snippet) {
  if (!supabaseClient) return;
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session?.user) return;
    await supabaseClient.from('user_bookmarks').upsert({
      user_id: session.user.id,
      book_title: bookTitle,
      page,
      sentence_idx: sentenceIdx,
      snippet: snippet || '',
      created_at: new Date().toISOString()
    }, { onConflict: 'user_id,book_title,page,sentence_idx' });
  } catch (e) {}
}

async function syncAnnotationToCloud(ann) {
  if (!supabaseClient || !ann) return;
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session?.user) return;
    await supabaseClient.from('user_annotations').upsert({
      user_id: session.user.id,
      book_title: ann.bookTitle,
      page: ann.page,
      sentence_idx: ann.sentenceIdx,
      text: ann.quoteText || ann.text || '',
      type: ann.noteText ? 'note' : 'highlight',
      color: ann.color || 'amber',
      note_text: ann.noteText || '',
      created_at: typeof ann.createdAt === 'number' ? new Date(ann.createdAt).toISOString() : (ann.createdAt || new Date().toISOString()),
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,book_title,page,sentence_idx,type' });
  } catch (e) {}
}

async function deleteCloudAnnotation(bookTitle, page, sentenceIdx, type) {
  if (!supabaseClient) return;
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session?.user) return;
    let q = supabaseClient.from('user_annotations')
      .delete()
      .eq('user_id', session.user.id)
      .eq('book_title', bookTitle)
      .eq('page', page)
      .eq('sentence_idx', sentenceIdx);
    if (type) q = q.eq('type', type);
    await q;
  } catch (e) {}
}

/**
 * Bi-directional reconciliation:
 * Pulls remote user_books, user_bookmarks, and user_annotations;
 * Merges missing entries into local IndexedDB; pushes newer local entries to remote.
 */
async function syncAllWithCloud() {
  if (!supabaseClient) return { success: false, reason: 'no_client' };
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session?.user) return { success: false, reason: 'not_authenticated' };
    const userId = session.user.id;

    // 1. Sync Books & Reading Progress
    const { data: remoteBooks } = await supabaseClient
      .from('user_books')
      .select('title, current_page, current_sentence, total_pages, updated_at')
      .eq('user_id', userId);

    const localBooks = await getAllBooksFromShelf();
    const localBooksMap = new Map(localBooks.map(b => [b.title, b]));

    if (Array.isArray(remoteBooks)) {
      for (const rb of remoteBooks) {
        const lb = localBooksMap.get(rb.title);
        if (lb) {
          const remoteTime = new Date(rb.updated_at || 0).getTime();
          const localTime = Number(lb.updatedAt || 0);
          if (remoteTime > localTime) {
            await updateBookProgressInDB(rb.title, rb.current_page, rb.current_sentence);
            if (currentDocName === rb.title && !isPlaying) {
              currentPage = rb.current_page;
              currentSentenceIdx = rb.current_sentence;
              renderPage(currentPage);
            }
          } else if (localTime > remoteTime) {
            await supabaseClient.from('user_books').upsert({
              user_id: userId,
              title: lb.title,
              current_page: lb.currentPage || 0,
              current_sentence: lb.currentSentenceIdx || 0,
              total_pages: lb.pages?.length || 1,
              updated_at: new Date(localTime).toISOString()
            }, { onConflict: 'user_id,title' });
          }
        }
      }
    }

    // 2. Sync Bookmarks
    const { data: remoteBookmarks } = await supabaseClient
      .from('user_bookmarks')
      .select('book_title, page, sentence_idx, snippet, created_at')
      .eq('user_id', userId);

    const localBookmarks = await getBookmarksFromDB();
    const localBmSet = new Set(localBookmarks.map(b => `${b.bookTitle}:::${b.page}:::${b.sentenceIdx}`));

    if (Array.isArray(remoteBookmarks)) {
      for (const rb of remoteBookmarks) {
        const key = `${rb.book_title}:::${rb.page}:::${rb.sentence_idx}`;
        if (!localBmSet.has(key)) {
          await saveBookmarkToDB(rb.book_title, rb.page, rb.sentence_idx, rb.snippet);
          localBmSet.add(key);
        }
      }
    }
    for (const lb of localBookmarks) {
      await syncBookmarkToCloud(lb.bookTitle, lb.page, lb.sentenceIdx, lb.snippet);
    }

    // 3. Sync Annotations
    const { data: remoteAnn } = await supabaseClient
      .from('user_annotations')
      .select('book_title, page, sentence_idx, text, type, color, note_text, created_at')
      .eq('user_id', userId);

    const localAnn = await getAnnotationsFromDB(currentDocName);
    const localAnnSet = new Set(localAnn.map(a => `${a.bookTitle}:::${a.page}:::${a.sentenceIdx}:::${a.noteText ? 'note' : 'highlight'}`));

    if (Array.isArray(remoteAnn)) {
      for (const ra of remoteAnn) {
        const key = `${ra.book_title}:::${ra.page}:::${ra.sentence_idx}:::${ra.type}`;
        if (!localAnnSet.has(key)) {
          await saveAnnotationToDB({
            bookTitle: ra.book_title,
            page: ra.page,
            sentenceIdx: ra.sentence_idx,
            quoteText: ra.text,
            noteText: ra.note_text,
            color: ra.color,
            createdAt: ra.created_at
          });
          localAnnSet.add(key);
        }
      }
      if (currentDocName) {
        await refreshCurrentDocAnnotations();
        renderPage(currentPage);
      }
    }
    for (const la of localAnn) {
      await syncAnnotationToCloud(la);
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err?.message || 'Sync failed' };
  }
}

async function getAllBooksFromShelf() {
  if (!dbInstance) await initIndexedDB();
  if (!dbInstance) return [];
  return new Promise((resolve) => {
    const tx = dbInstance.transaction(["books"], "readonly");
    const store = tx.objectStore("books");
    const req = store.getAll();
    req.onsuccess = () => {
      const list = req.result || [];
      list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      resolve(list);
    };
    req.onerror = () => resolve([]);
  });
}

async function deleteBookFromShelf(bookId) {
  if (!dbInstance) await initIndexedDB();
  if (!dbInstance) return;
  return new Promise((resolve) => {
    const tx = dbInstance.transaction(["books"], "readwrite");
    const store = tx.objectStore("books");
    store.delete(bookId);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}

// ==============================
// TWO-WAY PROGRESS SYNC
// ==============================
// user_books keeps the reader's place only: user_id, title, current_page, current_sentence and
// updated_at. Syncing therefore reunites your position in a book on every device that already has
// the file; the book text itself never leaves the device. Every cloud failure here is silent by
// design: reading has to keep working when the network or the session does not.

// Pure: per book title, decides whether this device or the account holds the newer position.
// `adopt` is what to write locally, `upload` is what to push. A title that exists only in the cloud
// is ignored on purpose: without its pages it cannot be opened, and the shelf reads pages.length.
function mergeCloudProgress(localBooks, cloudRows, now = Date.now()) {
  const local = Array.isArray(localBooks) ? localBooks : [];
  const cloud = Array.isArray(cloudRows) ? cloudRows : [];
  const cloudByTitle = new Map();
  for (const row of cloud) {
    if (row && typeof row.title === 'string') cloudByTitle.set(row.title, row);
  }

  const adopt = [];
  const upload = [];
  for (const book of local) {
    if (!book || typeof book.title !== 'string') continue;
    const row = cloudByTitle.get(book.title);
    const localUpdatedAt = Number(book.updatedAt) || 0;
    const cloudUpdatedAt = row ? Date.parse(row.updated_at) : NaN;

    // A page turn this device has not pushed yet is the reader's most recent action here, and its
    // timestamp came from a clock that cannot be compared with the server's. When the cloud still
    // holds the stamp this device last saw for the book, that row predates the save, so the save
    // wins without consulting clocks — otherwise a phone running slow would roll it back. A cloud
    // row written after that stamp is genuinely newer, and the timestamp comparison below decides.
    const unpushedSave = Boolean(book.pendingSync);
    const lastCloudStamp = Number(book.lastCloudStamp) || 0;
    const cloudPredatesOurSave = lastCloudStamp > 0 && Number.isFinite(cloudUpdatedAt) && cloudUpdatedAt <= lastCloudStamp;

    if (row && Number.isFinite(cloudUpdatedAt) && cloudUpdatedAt > localUpdatedAt && !(unpushedSave && cloudPredatesOurSave)) {
      adopt.push({
        title: book.title,
        currentPage: Math.max(0, Math.floor(Number(row.current_page) || 0)),
        currentSentenceIdx: Math.max(0, Math.floor(Number(row.current_sentence) || 0)),
        updatedAt: cloudUpdatedAt
      });
      continue;
    }

    // No cloud row, an unreadable timestamp, or a tie: this device is authoritative. Its own
    // updatedAt travels with the row, so a push never claims to be newer than it really is.
    upload.push({
      title: book.title,
      current_page: Math.max(0, Math.floor(Number(book.currentPage) || 0)),
      current_sentence: Math.max(0, Math.floor(Number(book.currentSentenceIdx) || 0)),
      updated_at: new Date(localUpdatedAt || now).toISOString()
    });
  }
  return { adopt, upload };
}

async function pullCloudProgress(client, userId) {
  if (!client || !userId) return [];
  try {
    const { data, error } = await client
      .from('user_books')
      .select('title, current_page, current_sentence, updated_at')
      .eq('user_id', userId);
    if (error) {
      console.warn('Progress pull failed:', error.message || error);
      return [];
    }
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn('Progress pull failed:', err);
    return [];
  }
}

// Pushes rows and hands back the server's view of them. `stamped` is what the database stored in
// updated_at — which the user_books trigger sets from the server clock, so two devices compare one
// authority instead of their own clocks. Without that migration installed the returned value is
// just the timestamp this client sent, and nothing changes.
async function pushLocalProgressToCloud(client, userId, rows) {
  if (!client || !userId || !Array.isArray(rows) || rows.length === 0) return { ok: false, stamped: [] };
  try {
    const { data, error } = await client
      .from('user_books')
      .upsert(rows.map((row) => ({ ...row, user_id: userId })), { onConflict: 'user_id,title' })
      .select('title, updated_at');
    if (error) {
      console.warn('Progress push failed:', error.message || error);
      return { ok: false, stamped: [] };
    }
    return { ok: true, stamped: Array.isArray(data) ? data : [] };
  } catch (err) {
    console.warn('Progress push failed:', err);
    return { ok: false, stamped: [] };
  }
}

// Removing a book is a local action, but its cloud row has to follow it: otherwise the row outlives
// the file and the next pull treats the deleted book as "read on another device".
async function deleteCloudProgress(client, userId, title) {
  if (!client || !userId || !title) return false;
  try {
    const { error } = await client
      .from('user_books')
      .delete()
      .eq('user_id', userId)
      .eq('title', title);
    if (error) {
      console.warn('Progress delete failed:', error.message || error);
      return false;
    }
    return true;
  } catch (err) {
    return false;
  }
}

// Looks up who is signed in before deleting, so callers never have to await auth themselves.
async function removeCloudProgressForBook(title) {
  if (!supabaseClient || !title) return false;
  try {
    const user = await getSignedInUser();
    if (!user || !user.id) return false;
    return await deleteCloudProgress(supabaseClient, user.id, title);
  } catch (err) {
    return false;
  }
}

// Applies every adopted position in one transaction and resolves how many books moved.
async function applyCloudProgressToDB(records) {
  if (!Array.isArray(records) || records.length === 0) return 0;
  if (!dbInstance) await initIndexedDB();
  if (!dbInstance) return 0;
  const byTitle = new Map();
  for (const record of records) {
    if (record && typeof record.title === 'string') byTitle.set(record.title, record);
  }
  return new Promise((resolve) => {
    try {
      const tx = dbInstance.transaction(["books"], "readwrite");
      const store = tx.objectStore("books");
      const req = store.getAll();
      req.onsuccess = () => {
        let applied = 0;
        for (const book of req.result || []) {
          const record = byTitle.get(book.title);
          if (!record) continue;
          book.currentPage = record.currentPage;
          book.currentSentenceIdx = record.currentSentenceIdx;
          // Keep the cloud timestamp. Stamping "now" would make this device look newer on every
          // launch and overwrite the other device's real progress.
          book.updatedAt = record.updatedAt;
          // Remember what the cloud holds, so a later local save can prove it is newer.
          book.lastCloudStamp = record.updatedAt;
          // The account's position supersedes whatever this device still owed for the book.
          book.pendingSync = false;
          store.put(book);
          applied += 1;
        }
        resolve(applied);
      };
      req.onerror = () => resolve(0);
    } catch (err) {
      resolve(0);
    }
  });
}

async function restoreProgressFromCloud() {
  if (!supabaseClient) return { adopted: 0, uploaded: 0 };
  try {
    const user = await getSignedInUser();
    if (!user || !user.id) return { adopted: 0, uploaded: 0 };
    const localBooks = await getAllBooksFromShelf();
    if (!localBooks.length) return { adopted: 0, uploaded: 0 };

    const rows = await pullCloudProgress(supabaseClient, user.id);
    const { adopt, upload } = mergeCloudProgress(localBooks, rows);

    const adopted = await applyCloudProgressToDB(adopt);
    const push = upload.length > 0
      ? await pushLocalProgressToCloud(supabaseClient, user.id, upload)
      : { ok: false, stamped: [] };
    // Uploads made here are confirmed too, so anything they covered stops being owed.
    if (push.ok) await clearPendingProgress(upload, push.stamped);
    return { adopted, uploaded: push.ok ? upload.length : 0 };
  } catch (err) {
    console.warn('Progress sync skipped:', err);
    return { adopted: 0, uploaded: 0 };
  }
}

// ==============================
// OFFLINE WRITE QUEUE
// ==============================
// Reading happens offline: on a plane, in the underground, or while the browser has not refreshed
// a session yet. A position written then is owed to the cloud rather than lost. Every local save
// marks the book pendingSync; only a confirmed upsert clears it, so a failure is retried later
// instead of silently dropping the reader's place.

// Pure: the cloud rows this device still owes, with the same clamping the merge applies so a
// corrupt local position can never be pushed as a negative page.
function selectPendingProgress(books) {
  const rows = [];
  for (const book of Array.isArray(books) ? books : []) {
    if (!book || typeof book.title !== 'string' || !book.pendingSync) continue;
    rows.push({
      title: book.title,
      current_page: Math.max(0, Math.floor(Number(book.currentPage) || 0)),
      current_sentence: Math.max(0, Math.floor(Number(book.currentSentenceIdx) || 0)),
      updated_at: new Date(Number(book.updatedAt) || Date.now()).toISOString()
    });
  }
  return rows;
}

// Pure: which pushed rows may have their flag cleared. A save that landed while the push was in
// flight carries a newer updatedAt than the row that was sent, so it still owes the cloud.
function settlePendingRows(pushed, books) {
  const byTitle = new Map();
  for (const book of Array.isArray(books) ? books : []) {
    if (book && typeof book.title === 'string') byTitle.set(book.title, book);
  }
  const settled = [];
  for (const row of Array.isArray(pushed) ? pushed : []) {
    if (!row || typeof row.title !== 'string') continue;
    const book = byTitle.get(row.title);
    if (!book || !book.pendingSync) continue;
    const pushedAt = Date.parse(row.updated_at);
    if (!Number.isFinite(pushedAt)) continue;
    if ((Number(book.updatedAt) || 0) > pushedAt) continue;
    settled.push(row.title);
  }
  return settled;
}

// Clears the flag only for rows the server confirmed and only where no newer save has landed, and
// stores the timestamp the server returned for them. One read and one transaction on purpose: this
// runs on page turns that reach the cloud, so it cannot afford more than the write that precedes it.
async function clearPendingProgress(rows, stamped = []) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  if (!dbInstance) await initIndexedDB();
  if (!dbInstance) return 0;
  const serverTimes = new Map();
  for (const row of Array.isArray(stamped) ? stamped : []) {
    if (!row || typeof row.title !== 'string') continue;
    const at = Date.parse(row.updated_at);
    if (Number.isFinite(at)) serverTimes.set(row.title, at);
  }
  return new Promise((resolve) => {
    try {
      const tx = dbInstance.transaction(["books"], "readwrite");
      const store = tx.objectStore("books");
      const req = store.getAll();
      req.onsuccess = () => {
        const books = req.result || [];
        const titles = new Set(settlePendingRows(rows, books));
        let changed = 0;
        for (const book of books) {
          let touched = false;
          // Record the stamp the cloud now holds for this book even when the push settled nothing:
          // that value is what later proves a cloud row predates a newer local save.
          if (serverTimes.has(book.title)) {
            const at = serverTimes.get(book.title);
            if (at !== book.lastCloudStamp) {
              book.lastCloudStamp = at;
              touched = true;
            }
          }
          if (titles.has(book.title) && book.pendingSync) {
            book.pendingSync = false;
            // Only a settled row takes the server's clock. A save that landed while this push was
            // in flight keeps its own newer timestamp until its own push is confirmed.
            if (serverTimes.has(book.title)) book.updatedAt = serverTimes.get(book.title);
            touched = true;
          }
          if (!touched) continue;
          store.put(book);
          changed += 1;
        }
        resolve(changed);
      };
      req.onerror = () => resolve(0);
    } catch (err) {
      resolve(0);
    }
  });
}

// Retries everything this device still owes. Safe to call at any time: signed out or offline it
// leaves the flags alone for the next attempt and never throws into the reader.
async function flushPendingProgress() {
  if (!supabaseClient) return 0;
  try {
    const user = await getSignedInUser();
    if (!user || !user.id) return 0;
    const rows = selectPendingProgress(await getAllBooksFromShelf());
    if (!rows.length) return 0;
    const push = await pushLocalProgressToCloud(supabaseClient, user.id, rows);
    if (!push.ok) return 0;
    await clearPendingProgress(rows, push.stamped);
    return rows.length;
  } catch (err) {
    return 0;
  }
}

// ==============================
// BOOKMARK SYNC
// ==============================
// Bookmarks used to be device-only, so signing in on a second phone brought reading positions and
// nothing to jump to. Unlike progress there is no queue here: the pull comes first, and the rows it
// returns are the account's own record of the last confirmed push, so only the local bookmarks the
// account does not already hold are sent. That keeps a trigger with nothing new off the network
// without a second queue, and survives a reload or a fresh device that has no local bookkeeping.
// Deletion propagates from the device that deletes; a bookmark deleted elsewhere can come back from
// another device's copy. The snippet — the quoted sentence — is sent too, which the bookmarks modal
// states outright.

// Pure: one user_bookmarks row as the shape the local store uses. Null for anything unreadable.
function bookmarkFromCloudRow(row) {
  if (!row || typeof row.book_title !== 'string') return null;
  const createdAt = Date.parse(row.created_at);
  return {
    bookTitle: row.book_title,
    page: Math.max(0, Math.floor(Number(row.page) || 0)),
    sentenceIdx: Math.max(0, Math.floor(Number(row.sentence_idx) || 0)),
    snippet: String(row.snippet == null ? '' : row.snippet),
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now()
  };
}

function bookmarksFromCloudRows(rows) {
  const marks = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const mark = bookmarkFromCloudRow(row);
    if (mark) marks.push(mark);
  }
  return marks;
}

// Pure: which pulled bookmarks this device does not have. Identity is the coordinates, the same key
// the table is unique on, so a snippet that differs from the local copy cannot create a duplicate.
function selectMissingBookmarks(local, incoming) {
  const seen = new Set();
  for (const mark of Array.isArray(local) ? local : []) {
    if (mark && typeof mark.bookTitle === 'string') {
      seen.add([mark.bookTitle, Number(mark.page) || 0, Number(mark.sentenceIdx) || 0].join('\u0000'));
    }
  }
  const missing = [];
  for (const mark of Array.isArray(incoming) ? incoming : []) {
    if (!mark || typeof mark.bookTitle !== 'string') continue;
    const key = [mark.bookTitle, Number(mark.page) || 0, Number(mark.sentenceIdx) || 0].join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    missing.push(mark);
  }
  return missing;
}

// Pure: the local bookmarks the account does not hold yet, as cloud rows. `cloudRows` are the marks
// the pull just returned, so this is the diff against the last confirmed push. Identity is the
// coordinates — the same key the table is unique on — so a cloud copy with a different quote is not
// pushed again, and repeated duplicates from a merge collapse to one row.
function selectBookmarksToPush(local, cloudRows) {
  const known = new Set();
  for (const mark of Array.isArray(cloudRows) ? cloudRows : []) {
    if (!mark || typeof mark.bookTitle !== 'string') continue;
    known.add([mark.bookTitle, Number(mark.page) || 0, Number(mark.sentenceIdx) || 0].join('\u0000'));
  }
  const rows = [];
  const queued = new Set();
  for (const mark of Array.isArray(local) ? local : []) {
    if (!mark || typeof mark.bookTitle !== 'string') continue;
    const page = Math.max(0, Math.floor(Number(mark.page) || 0));
    const sentenceIdx = Math.max(0, Math.floor(Number(mark.sentenceIdx) || 0));
    const key = [mark.bookTitle, page, sentenceIdx].join('\u0000');
    if (known.has(key) || queued.has(key)) continue;
    queued.add(key);
    rows.push({
      book_title: mark.bookTitle,
      page,
      sentence_idx: sentenceIdx,
      snippet: String(mark.snippet == null ? '' : mark.snippet),
      created_at: new Date(Number(mark.createdAt) || Date.now()).toISOString()
    });
  }
  return rows;
}

async function pullCloudBookmarks(client, userId) {
  if (!client || !userId) return [];
  try {
    const { data, error } = await client
      .from('user_bookmarks')
      .select('book_title, page, sentence_idx, snippet, created_at')
      .eq('user_id', userId);
    if (error) {
      console.warn('Bookmark pull failed:', error.message || error);
      return [];
    }
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn('Bookmark pull failed:', err);
    return [];
  }
}

async function pushBookmarksToCloud(client, userId, rows) {
  if (!client || !userId || !Array.isArray(rows) || rows.length === 0) return false;
  try {
    const { error } = await client
      .from('user_bookmarks')
      .upsert(rows.map((row) => ({ ...row, user_id: userId })), {
        onConflict: 'user_id,book_title,page,sentence_idx'
      });
    if (error) {
      console.warn('Bookmark push failed:', error.message || error);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Bookmark push failed:', err);
    return false;
  }
}

async function deleteCloudBookmark(client, userId, mark) {
  if (!client || !userId || !mark || typeof mark.bookTitle !== 'string') return false;
  try {
    const { error } = await client.from('user_bookmarks').delete().match({
      user_id: userId,
      book_title: mark.bookTitle,
      page: Math.max(0, Math.floor(Number(mark.page) || 0)),
      sentence_idx: Math.max(0, Math.floor(Number(mark.sentenceIdx) || 0))
    });
    if (error) {
      console.warn('Bookmark delete failed:', error.message || error);
      return false;
    }
    return true;
  } catch (err) {
    return false;
  }
}

// Looks up who is signed in before deleting, so the modal never has to await auth itself.
async function removeCloudBookmarkForLocal(mark) {
  if (!supabaseClient || !mark) return false;
  try {
    const user = await getSignedInUser();
    if (!user || !user.id) return false;
    return await deleteCloudBookmark(supabaseClient, user.id, mark);
  } catch (err) {
    return false;
  }
}

// Pull first, adopt anything this device is missing, then push what the account still lacks. Never
// throws: a missing table, a dead network or a signed-out session all mean "try again later".
async function syncBookmarksFromCloud() {
  if (!supabaseClient) return { added: 0, pushed: 0 };
  try {
    const user = await getSignedInUser();
    if (!user || !user.id) return { added: 0, pushed: 0 };

    const incoming = bookmarksFromCloudRows(await pullCloudBookmarks(supabaseClient, user.id));
    const local = await getBookmarksFromDB();
    const missing = selectMissingBookmarks(local, incoming);
    if (missing.length) await writeRecords("bookmarks", missing);

    // Push only what this device has and the account does not, so one device's new bookmarks reach
    // the account on the same pass that brought the other device's in, and a trigger that follows a
    // confirmed push sends nothing. A failed pull leaves the set empty and repeats the upsert, which
    // the unique index makes safe.
    const rows = selectBookmarksToPush(local, incoming);
    const pushed = rows.length > 0 && await pushBookmarksToCloud(supabaseClient, user.id, rows);
    return { added: missing.length, pushed: pushed ? rows.length : 0 };
  } catch (err) {
    console.warn('Bookmark sync skipped:', err);
    return { added: 0, pushed: 0 };
  }
}

// ==============================
// DURABLE STORAGE + BACKUP
// ==============================
// The shelf is the only copy of the reader's library: IndexedDB can be evicted under disk pressure,
// and clearing site data wipes it. Ask for persistent storage, and let people take a real backup.

// Chromium grants this silently for an installed app; Safari may not implement it at all. Either
// way it is best-effort: a refusal only means the browser is still free to evict. Asked once per
// page load, because the browser remembers its own answer.
let storagePersistSettled = false;

async function requestPersistentStorage() {
  if (storagePersistSettled) return false;
  try {
    if (!navigator.storage || typeof navigator.storage.persist !== 'function') return false;
    const granted = await navigator.storage.persist();
    storagePersistSettled = true;
    return Boolean(granted);
  } catch (err) {
    return false;
  }
}

async function reportStorageUsage() {
  const note = document.getElementById('shelfStorageNote');
  if (!note) return;
  try {
    if (!navigator.storage || typeof navigator.storage.estimate !== 'function') {
      note.textContent = '';
      return;
    }
    const { usage } = await navigator.storage.estimate();
    const bytes = Number(usage);
    if (!Number.isFinite(bytes) || bytes <= 0) {
      note.textContent = '';
      return;
    }
    const mb = bytes / (1024 * 1024);
    note.textContent = 'Using ' + (mb >= 10 ? Math.round(mb) : mb.toFixed(1)) + ' MB of device storage.';
  } catch (err) {
    note.textContent = '';
  }
}

// Pure: the exact file contents. IndexedDB ids are dropped because they are per-device counters;
// books are matched by title and bookmarks by content when the file is restored.
function buildBackupPayload(books, bookmarks, exportedAt) {
  const cleanBooks = (Array.isArray(books) ? books : []).map((book) => ({
    title: String(book && book.title != null ? book.title : ''),
    pages: Array.isArray(book && book.pages) ? book.pages : [],
    chapters: Array.isArray(book && book.chapters) ? book.chapters : [],
    currentPage: Math.max(0, Math.floor(Number(book && book.currentPage) || 0)),
    currentSentenceIdx: Math.max(0, Math.floor(Number(book && book.currentSentenceIdx) || 0)),
    updatedAt: Number(book && book.updatedAt) || 0
  }));
  const cleanBookmarks = (Array.isArray(bookmarks) ? bookmarks : []).map((mark) => ({
    bookTitle: String(mark && mark.bookTitle != null ? mark.bookTitle : ''),
    page: Math.max(0, Math.floor(Number(mark && mark.page) || 0)),
    sentenceIdx: Math.max(0, Math.floor(Number(mark && mark.sentenceIdx) || 0)),
    snippet: String(mark && mark.snippet != null ? mark.snippet : ''),
    createdAt: Number(mark && mark.createdAt) || 0
  }));
  return {
    format: 'marginalia-backup',
    version: 1,
    exportedAt: typeof exportedAt === 'string' ? exportedAt : '',
    books: cleanBooks,
    bookmarks: cleanBookmarks
  };
}

// Pure: strict on purpose. A bad file must be refused outright, never half-merged.
function parseBackupPayload(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, error: 'That file is empty.' };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: 'That file is not a Marginalia backup.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'That file is not a Marginalia backup.' };
  }
  if (parsed.format !== 'marginalia-backup') {
    return { ok: false, error: 'That file is not a Marginalia backup.' };
  }
  if (parsed.version !== 1) {
    return { ok: false, error: 'That backup came from a different version of Marginalia.' };
  }
  if (!Array.isArray(parsed.books) || !Array.isArray(parsed.bookmarks)) {
    return { ok: false, error: 'That backup is missing its book list.' };
  }
  return { ok: true, payload: parsed };
}

// Pure: newest position wins per title, a book only on this device is kept, and a replaced book
// keeps its local id so the write updates that record instead of adding a second copy.
function mergeShelfRecords(existing, incoming) {
  const byTitle = new Map();
  for (const book of Array.isArray(existing) ? existing : []) {
    if (book && typeof book.title === 'string') byTitle.set(book.title, book);
  }
  let added = 0;
  let updated = 0;
  for (const book of Array.isArray(incoming) ? incoming : []) {
    if (!book || typeof book.title !== 'string') continue;
    const current = byTitle.get(book.title);
    if (!current) {
      byTitle.set(book.title, book);
      added += 1;
      continue;
    }
    if ((Number(book.updatedAt) || 0) > (Number(current.updatedAt) || 0)) {
      byTitle.set(book.title, { ...book, id: current.id });
      updated += 1;
    }
  }
  return { books: Array.from(byTitle.values()), added, updated };
}

// Pure: same bookmark in the file and on the device is kept once.
function mergeBookmarks(existing, incoming) {
  const seen = new Set();
  const merged = [];
  const add = (mark) => {
    if (!mark) return;
    const key = [mark.bookTitle, mark.page, mark.sentenceIdx, mark.snippet].join('\u0000');
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(mark);
  };
  for (const mark of Array.isArray(existing) ? existing : []) add(mark);
  for (const mark of Array.isArray(incoming) ? incoming : []) add(mark);
  return merged;
}

async function writeRecords(storeName, records) {
  if (!dbInstance) await initIndexedDB();
  if (!dbInstance) return false;
  return new Promise((resolve) => {
    try {
      const tx = dbInstance.transaction([storeName], "readwrite");
      const store = tx.objectStore(storeName);
      for (const record of records || []) {
        const copy = { ...record };
        if (copy.id == null) delete copy.id;
        store.put(copy);
      }
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch (err) {
      resolve(false);
    }
  });
}

async function exportLibraryBackup() {
  try {
    const books = await getAllBooksFromShelf();
    const bookmarks = await getBookmarksFromDB();
    if (!books.length && !bookmarks.length) {
      showToast('There is nothing on your shelf to back up yet.');
      return;
    }
    const payload = buildBackupPayload(books, bookmarks, new Date().toISOString());
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'marginalia-backup-' + payload.exportedAt.slice(0, 10) + '.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    showToast('Backup downloaded: ' + books.length + ' book(s), ' + bookmarks.length + ' bookmark(s).');
  } catch (err) {
    console.error('Backup export failed:', err);
    showToast('Could not create the backup file. Please try again.');
  }
}

async function importLibraryBackup(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = parseBackupPayload(text);
    if (!parsed.ok) {
      showToast(parsed.error);
      return;
    }

    if (!parsed.payload.books.length && !parsed.payload.bookmarks.length) {
      showToast('That backup has no books or bookmarks in it.');
      return;
    }

    const merged = mergeShelfRecords(await getAllBooksFromShelf(), parsed.payload.books);
    const existingMarks = await getBookmarksFromDB();
    const mergedMarks = mergeBookmarks(existingMarks, parsed.payload.bookmarks);
    const newMarks = mergedMarks.length - existingMarks.length;

    const proceed = confirm(
      'Restore ' + merged.added + ' new book(s) and ' + newMarks + ' bookmark(s)?\n\n' +
      'Books already on this device keep whichever reading position is newer.'
    );
    if (!proceed) return;

    const booksOk = await writeRecords("books", merged.books);
    await writeRecords("bookmarks", mergedMarks);
    if (!booksOk) {
      showToast('Could not write the backup to this device.');
      return;
    }
    showToast('Restored ' + merged.added + ' new book(s), updated ' + merged.updated + '.');
    await showShelfModal('shelf');
  } catch (err) {
    console.error('Backup import failed:', err);
    showToast('Could not read that backup file.');
  }
}

// ==============================
// PAYSTACK CHECKOUT HELPER
// ==============================
async function startPaystackCheckout(planId = null) {
  try {
    const token = await getFreshAuthToken();
    if (!token) {
      alert('Please sign in first so your Pro upgrade can be linked to your account.');
      return;
    }
    // Only a plan id is sent: the server owns every price, so the UI can never disagree with
    // what Paystack actually charges.
    const res = await fetch('/api/paystack-init', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(planId ? { plan: planId } : {})
    });

    const data = await res.json();
    if (data.authorization_url) {
      window.location.href = data.authorization_url; // Redirects to Paystack checkout
    } else {
      alert(data.error || 'Unable to initiate payment.');
    }
  } catch (err) {
    console.error('Checkout error:', err);
    alert('Payment error. Please check your connection and try again.');
  }
}

// Handler triggered by the upgrade buttons (requires a signed-in account so the payment can be linked)
async function initiateProUpgrade(planId = null) {
  try {
    if (!supabaseClient) { authModal.style.display = 'flex'; return; }
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session?.user) {
      closeModalById('paywallModal');
      showAuthAlert("Please sign in first so your Pro upgrade can be linked to your account.", "info");
      authModal.style.display = 'flex';
      return;
    }
    await startPaystackCheckout(planId);
  } catch (err) {
    console.error('Upgrade initiation error:', err);
    alert('Failed to launch checkout.');
  }
}

// Starts a one-time refill pack checkout. Same shape as the subscription checkout, but the
// server sets metadata.type = 'refill' and metadata.pack_id so Paystack treats it as a one-time
// payment rather than a subscription.
async function startRefillCheckout(packId) {
  try {
    const token = await getFreshAuthToken();
    if (!token) {
      alert('Please sign in first so your refill pack can be linked to your account.');
      return;
    }
    const res = await fetch('/api/paystack-init', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ pack_id: packId })
    });

    const data = await res.json();
    if (data.authorization_url) {
      window.location.href = data.authorization_url;
    } else {
      alert(data.error || 'Unable to start refill checkout.');
    }
  } catch (err) {
    console.error('Refill checkout error:', err);
    alert('Payment error. Please check your connection and try again.');
  }
}

// When price data cannot be loaded, keep one plain upgrade option and, if refill packs exist for
// this currency, one plain refill option so the user can still top up.
async function renderPaywallFallback(list) {
  const data = await fetchProPlans();
  const packs = (data && data.refill_packs) || [];

  if (!data) {
    const btn = document.createElement('button');
    btn.className = 'pro-plan-option';
    btn.innerHTML = '<span class="pro-plan-label">Upgrade to Pro</span><span class="pro-plan-price">Continue →</span>';
    btn.addEventListener('click', () => initiateProUpgrade(null));
    list.appendChild(btn);
  }

  if (packs.length) {
    const section = document.createElement('div');
    section.className = 'pro-refill-section';
    const sectionTitle = document.createElement('div');
    sectionTitle.className = 'pro-refill-title';
    sectionTitle.textContent = '⚡ Refill Credits (one-time)';
    section.appendChild(sectionTitle);

    packs.forEach((pack) => {
      const btn = document.createElement('button');
      btn.className = 'pro-plan-option';
      btn.type = 'button';
      btn.innerHTML = `
        <span class="pro-plan-label">
          Refill · +${pack.neural_chars.toLocaleString()} neural chars${pack.ai_ops ? ` +${pack.ai_ops} AI summaries` : ''}
        </span>
        <span class="pro-plan-price-col">
          <span class="pro-plan-price">${escapeHtml(pack.amount_display)}</span>
        </span>
      `;
      btn.addEventListener('click', () => startRefillCheckout(pack.id));
      section.appendChild(btn);
    });

    list.appendChild(section);
  }
}


// Pro is active while the account is tier 'pro' AND the expiry is in the future
// (mirrors isProActive in lib/pro-plan.js so the UI agrees with the server)
function isProActiveClient(profile) {
  if (!profile || profile.tier !== 'pro') return false;
  const exp = profile.pro_expires_at ? Date.parse(profile.pro_expires_at) : NaN;
  return Number.isFinite(exp) && exp > Date.now();
}

// Monthly allowances of the paid tiers (mirrors TIERS in lib/pro-plan.js). The server seeds the
// balances at purchase; these only label their denominators, so a paid account is never shown
// against the 5,000-character free allowance.
const PLAN_ALLOWANCES = {
  student: { name: 'Student Pass', neuralChars: 15000, summaries: 50 },
  studio: { name: 'Pro Studio', neuralChars: 100000, summaries: 50 }
};

// What the account bought, named for this market: "Student Pass" in Nigeria, "Reader" elsewhere.
// The server sends both names with the price list, so the map above is only a fallback for the
// moment before that call returns.
function planTierName(tierId, fallback) {
  const plan = proPlansCache?.plans?.find((p) => p.tier === tierId);
  return plan?.tier_label || fallback;
}

// The allowance an account actually bought, or null for free and expired accounts.
function planAllowance(profile) {
  if (!isProActiveClient(profile)) return null;
  return PLAN_ALLOWANCES[profile.pro_tier] || null;
}

// --- PRO PLANS (every price comes from the server; the UI never invents one) ---
let proPlansCache = null;

async function fetchProPlans() {
  if (proPlansCache) return proPlansCache;
  try {
    const res = await fetch('/api/paystack-init');
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !Array.isArray(data.plans) || data.plans.length === 0) return null;
    proPlansCache = data;
    return data;
  } catch (e) {
    return null; // offline or non-Vercel host: callers fall back to a generic label
  }
}

function planById(data, planId) {
  if (!data || !data.plans) return null;
  return data.plans.find((p) => p.id === planId)
    || data.plans.find((p) => p.id === data.default_plan)
    || data.plans[0];
}

// Shows the monthly price on the profile button; the paywall lists every plan.
async function refreshProPriceLabels() {
  const data = await fetchProPlans();
  const monthly = planById(data, data && data.default_plan);
  if (monthly && profileUpgradeBtn) {
    // The default plan is the cheapest tier's monthly term, so this is the "from" price
    profileUpgradeBtn.textContent = `🌟 Upgrade — from ${monthly.amount_display}/mo`;
  }
}

// Renders the plan choices. Each option starts a checkout for that exact plan id.
async function openPaywall() {
  paywallModal.style.display = 'flex';
  const list = document.getElementById('proPlanList');
  const headline = document.getElementById('proPriceHeadline');
  if (!list) return;
  const data = await fetchProPlans();

  list.innerHTML = '';
  if (headline) headline.style.display = 'none';
  if (!data) {
    // Price list unavailable: keep one plain option so checkout still works
    const btn = document.createElement('button');
    btn.className = 'pro-plan-option';
    btn.innerHTML = '<span class="pro-plan-label">Upgrade to Pro</span><span class="pro-plan-price">Continue →</span>';
    btn.addEventListener('click', () => initiateProUpgrade(null));
    list.appendChild(btn);
    return;
  }

  // "Student Pass — ₦2,000 / month (Approx. ~$1.50 USD · Billed in NGN)" so global visitors
  // aren't confused by the naira numbers. Every figure still comes from the server, and the
  // headline names the cheapest tier because that is the entry price.
  const monthly = planById(data, data.default_plan);
  if (headline && monthly) {
    const usd = monthly.amount_usd_display;
    headline.innerHTML = `
      <span class="pro-price-main">${escapeHtml(monthly.tier_label || 'Marginalia Pro')} — ${escapeHtml(monthly.amount_display)} / month</span>
      <span class="pro-price-detail">${usd ? `Approx. ~${escapeHtml(usd)} USD · ` : ''}Billed in ${escapeHtml(String(data.currency || 'NGN'))}</span>
    `;
    headline.style.display = '';
  }

  data.plans.forEach((plan) => {
    const btn = document.createElement('button');
    btn.className = 'pro-plan-option' + (plan.id === data.default_plan ? ' featured' : '');
    // Six rows share three duration labels, so each one has to name its tier
    const planTitle = plan.tier_label ? `${plan.tier_label} · ${plan.label}` : plan.label;
    btn.innerHTML = `
      <span class="pro-plan-label">
        ${escapeHtml(planTitle)}${plan.note ? ` <em>· ${escapeHtml(plan.note)}</em>` : ''}
      </span>
      <span class="pro-plan-price-col">
        <span class="pro-plan-price">${escapeHtml(plan.amount_display)}</span>
        ${plan.amount_usd_display ? `<span class="pro-plan-price-usd">~${escapeHtml(plan.amount_usd_display)} USD</span>` : ''}
      </span>
    `;
    btn.addEventListener('click', () => initiateProUpgrade(plan.id));
    list.appendChild(btn);
  });

  // --- REFILL PACKS (one-time credits, non-expiring) ---
  const refillPacks = data?.refill_packs || [];
  if (refillPacks.length) {
    const section = document.createElement('div');
    section.className = 'pro-refill-section';
    const sectionTitle = document.createElement('div');
    sectionTitle.className = 'pro-refill-title';
    sectionTitle.innerHTML = '⚡ Refill Credits <span style="font-weight:400; color:var(--text-muted);">one-time · non-expiring</span>';
    section.appendChild(sectionTitle);

    refillPacks.forEach((pack) => {
      const btn = document.createElement('button');
      btn.className = 'pro-plan-option';
      btn.type = 'button';
      btn.innerHTML = `
        <span class="pro-plan-label">
          Refill · +${pack.neural_chars.toLocaleString()} neural chars
          ${pack.ai_ops ? ` +${pack.ai_ops} AI summaries` : ''}
        </span>
        <span class="pro-plan-price-col">
          <span class="pro-plan-price">${escapeHtml(pack.amount_display)}</span>
        </span>
      `;
      btn.addEventListener('click', () => startRefillCheckout(pack.id));
      section.appendChild(btn);
    });

    list.appendChild(section);
  }
}

async function updateBookProgressInDB(title, page, sentenceIdx) {
  if (!dbInstance) return;
  try {
    const tx = dbInstance.transaction(["books"], "readwrite");
    const store = tx.objectStore("books");
    const req = store.getAll();
    req.onsuccess = () => {
      const book = (req.result || []).find(b => b.title === title);
      if (book) {
        book.currentPage = page;
        book.currentSentenceIdx = sentenceIdx;
        book.updatedAt = Date.now();
        // Owed to the cloud until an upsert is confirmed. See the offline write queue below.
        book.pendingSync = true;
        store.put(book);
      }
    };
  } catch (e) { }
}

async function saveBookmarkToDB(title, page, sentenceIdx, snippet) {
  if (!dbInstance) await initIndexedDB();
  if (!dbInstance) return;
  const tx = dbInstance.transaction(["bookmarks"], "readwrite");
  const store = tx.objectStore("bookmarks");
  store.add({ bookTitle: title, page, sentenceIdx, snippet, createdAt: Date.now() });
}

async function getBookmarksFromDB() {
  if (!dbInstance) await initIndexedDB();
  if (!dbInstance) return [];
  return new Promise((resolve) => {
    const tx = dbInstance.transaction(["bookmarks"], "readonly");
    const store = tx.objectStore("bookmarks");
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}

async function deleteBookmarkFromDB(id) {
  if (!dbInstance) await initIndexedDB();
  if (!dbInstance) return false;
  return new Promise((resolve) => {
    const tx = dbInstance.transaction(["bookmarks"], "readwrite");
    tx.objectStore("bookmarks").delete(id);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

async function saveAnnotationToDB({ id, bookTitle, page, sentenceIdx, quoteText, noteText, color }) {
  if (!dbInstance) await initIndexedDB();
  if (!dbInstance) return null;
  return new Promise((resolve) => {
    try {
      const tx = dbInstance.transaction(["annotations"], "readwrite");
      const store = tx.objectStore("annotations");
      const item = {
        bookTitle: bookTitle || '',
        page: Number.isFinite(page) ? page : 0,
        sentenceIdx: Number.isFinite(sentenceIdx) ? sentenceIdx : 0,
        quoteText: quoteText || '',
        noteText: noteText || '',
        color: color || 'amber',
        updatedAt: Date.now()
      };
      if (id != null) {
        item.id = id;
        const req = store.put(item);
        req.onsuccess = () => {
          syncAnnotationToCloud(item).catch(() => { });
          resolve(item);
        };
        req.onerror = () => resolve(null);
      } else {
        item.createdAt = Date.now();
        const req = store.add(item);
        req.onsuccess = (e) => {
          const res = { id: e.target.result, ...item };
          syncAnnotationToCloud(res).catch(() => { });
          resolve(res);
        };
        req.onerror = () => resolve(null);
      }
    } catch (e) {
      resolve(null);
    }
  });
}

async function getAnnotationsFromDB(bookTitle = null) {
  if (!dbInstance) await initIndexedDB();
  if (!dbInstance) return [];
  return new Promise((resolve) => {
    try {
      const tx = dbInstance.transaction(["annotations"], "readonly");
      const store = tx.objectStore("annotations");
      const req = store.getAll();
      req.onsuccess = () => {
        let list = req.result || [];
        if (bookTitle) list = list.filter(a => a.bookTitle === bookTitle);
        list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        resolve(list);
      };
      req.onerror = () => resolve([]);
    } catch (e) {
      resolve([]);
    }
  });
}

async function deleteAnnotationFromDB(id) {
  if (!dbInstance) await initIndexedDB();
  if (!dbInstance) return false;
  return new Promise((resolve) => {
    try {
      const tx = dbInstance.transaction(["annotations"], "readwrite");
      const store = tx.objectStore("annotations");
      const req = store.delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    } catch (e) {
      resolve(false);
    }
  });
}

async function saveVocabToDB({ word, partOfSpeech, definition, bookTitle, context }) {
  if (!dbInstance) await initIndexedDB();
  if (!dbInstance) return null;
  return new Promise((resolve) => {
    try {
      const tx = dbInstance.transaction(["vocabulary"], "readwrite");
      const store = tx.objectStore("vocabulary");
      const req = store.getAll();
      req.onsuccess = () => {
        const existing = (req.result || []).find(v => v.word.toLowerCase() === (word || '').toLowerCase());
        if (existing) {
          existing.partOfSpeech = partOfSpeech || existing.partOfSpeech;
          existing.definition = definition || existing.definition;
          existing.context = context || existing.context;
          existing.updatedAt = Date.now();
          store.put(existing);
          resolve(existing);
        } else {
          const item = {
            word: (word || '').toLowerCase(),
            partOfSpeech: partOfSpeech || '',
            definition: definition || '',
            bookTitle: bookTitle || '',
            context: context || '',
            createdAt: Date.now(),
            updatedAt: Date.now()
          };
          const addReq = store.add(item);
          addReq.onsuccess = (e) => resolve({ id: e.target.result, ...item });
          addReq.onerror = () => resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    } catch (e) {
      resolve(null);
    }
  });
}

async function getVocabFromDB(bookTitle = null) {
  if (!dbInstance) await initIndexedDB();
  if (!dbInstance) return [];
  return new Promise((resolve) => {
    try {
      const tx = dbInstance.transaction(["vocabulary"], "readonly");
      const store = tx.objectStore("vocabulary");
      const req = store.getAll();
      req.onsuccess = () => {
        let list = req.result || [];
        if (bookTitle) list = list.filter(v => !v.bookTitle || v.bookTitle === bookTitle);
        list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        resolve(list);
      };
      req.onerror = () => resolve([]);
    } catch (e) {
      resolve([]);
    }
  });
}

let currentDocAnnotations = [];

async function refreshCurrentDocAnnotations() {
  try {
    currentDocAnnotations = await getAnnotationsFromDB(currentDocName);
  } catch (e) {
    currentDocAnnotations = [];
  }
}

// --- STATE MANAGEMENT ---
let currentDocName = "Marginalia Quickstart";
let bookPages = [
  [
    "Welcome to Marginalia Mobile Reader.",
    "Tap the Open button above to import any EPUB, PDF, Word, or text file.",
    "Select any phrase in the book to immediately define, speak, or copy it.",
    "Lock your phone screen while reading and enjoy uninterrupted background voice narration."
  ]
];
let bookChapters = [
  { title: "Introduction", pageIndex: 0 }
];

let originalBookPages = null;
let originalDocName = null;
let originalPage = 0;

let currentPage = 0;
let currentSentenceIdx = 0;
let isPlaying = false;
let activeEngine = 'browser';
let playbackSpeed = 1.0;
const speedSteps = [0.8, 1.0, 1.2, 1.5, 1.8, 2.0];

let highlightMode = localStorage.getItem('marginalia_highlight_mode') || 'word';
let learnedCadenceMultiplier = 1.0;
let userManualCalibration = 1.0;
let sentenceSpeechStartTime = 0;
let estimatedSentenceDurationMs = 0;
let wordAnimFrameId = null;
let lastHighlightedWord = -1;

const browserSpeech = window.speechSynthesis;
let currentUtterance = null;
const audioElement = document.getElementById('neuralAudio');
const audioPreloadCache = new Map();

// Bottom-dock volume (0..1): applies to both the browser voice and the neural <audio>
let playbackVolume = (() => {
  const v = parseFloat(localStorage.getItem('marginalia_volume'));
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
})();

// Selection elements
const selectionPopover = document.getElementById('selectionPopover');
const btnSelectionSpeak = document.getElementById('btnSelectionSpeak');
const btnSelectionDefine = document.getElementById('btnSelectionDefine');
const btnSelectionHighlight = document.getElementById('btnSelectionHighlight');
const btnSelectionNote = document.getElementById('btnSelectionNote');
const btnSelectionCopy = document.getElementById('btnSelectionCopy');
let currentSelectedText = "";
let currentSelectedSentenceIdx = 0;

// DOM Elements
const contentPane = document.getElementById('contentPane');
const mainPlayToggle = document.getElementById('mainPlayToggle');
const prevPageBtn = document.getElementById('prevPageBtn');
const nextPageBtn = document.getElementById('nextPageBtn');
const pageIndicatorText = document.getElementById('pageIndicatorText');
const chapterIndicatorText = document.getElementById('chapterIndicatorText');
const openJumpModalBtn = document.getElementById('openJumpModalBtn');
const speedCycleBtn = document.getElementById('speedCycleBtn');
const autoFlipCheck = document.getElementById('autoFlipCheck');
const voicePicker = document.getElementById('voicePicker');
const fileInput = document.getElementById('fileInput');
const docTitle = document.getElementById('docTitle');
const preloadStatus = document.getElementById('preloadStatus');
const creditBadge = document.getElementById('creditBadge');
const creditDisplay = document.getElementById('creditDisplay');
const summarizeBtn = document.getElementById('summarizeBtn');
const summaryReturnSpan = document.getElementById('summaryReturnSpan');
const exitSummaryBtn = document.getElementById('exitSummaryBtn');
const addBookmarkBtn = document.getElementById('addBookmarkBtn');

// Drawer Elements
const openDrawerBtn = document.getElementById('openDrawerBtn');
const closeDrawerBtn = document.getElementById('btnDrawerClose');
const sideDrawer = document.getElementById('sideDrawer');
const drawerOverlay = document.getElementById('drawerOverlay');
const navRecentList = document.getElementById('navRecentList');
const navMyShelf = document.getElementById('navMyShelf');
const navBookmarks = document.getElementById('navBookmarks');
const navAnnotations = document.getElementById('navAnnotations');
const navStudyKit = document.getElementById('navStudyKit');
const navUploadFile = document.getElementById('navUploadFile');
const navProfileItem = document.getElementById('navProfileItem');
const drawerHeaderProfileClick = document.getElementById('drawerHeaderProfileClick');
const drawerUserTitle = document.getElementById('drawerUserTitle');
const drawerUserSubtitle = document.getElementById('drawerUserSubtitle');
const btnDrawerNightToggle = document.getElementById('btnDrawerNightToggle');
const btnDrawerOptions = document.getElementById('btnDrawerOptions');
const btnDrawerAbout = document.getElementById('btnDrawerAbout');

// Modals
const jumpModal = document.getElementById('jumpModal');
const tabChaptersBtn = document.getElementById('tabChaptersBtn');
const tabPagesBtn = document.getElementById('tabPagesBtn');
const chapterListView = document.getElementById('chapterListView');
const pageJumpView = document.getElementById('pageJumpView');
const pageJumpSlider = document.getElementById('pageJumpSlider');
const sliderValueDisplay = document.getElementById('sliderValueDisplay');
const pageDirectInput = document.getElementById('pageDirectInput');
const btnExecuteDirectJump = document.getElementById('btnExecuteDirectJump');

const shelfModal = document.getElementById('shelfModal');
const shelfModalTitle = document.getElementById('shelfModalTitle');
const shelfModalList = document.getElementById('shelfModalList');
const bookmarksModal = document.getElementById('bookmarksModal');
const bookmarksModalList = document.getElementById('bookmarksModalList');

// Note Modal Elements
const noteModal = document.getElementById('noteModal');
const noteModalQuote = document.getElementById('noteModalQuote');
const noteModalText = document.getElementById('noteModalText');
const saveNoteBtn = document.getElementById('saveNoteBtn');
const noteColorPicker = document.getElementById('noteColorPicker');
let activeNoteEditingId = null;
let selectedNoteColor = 'amber';

// Annotations Modal Elements
const annotationsModal = document.getElementById('annotationsModal');
const annotationsModalList = document.getElementById('annotationsModalList');
const annotationsCountSummary = document.getElementById('annotationsCountSummary');

// Study Kit Modal Elements
const studyKitModal = document.getElementById('studyKitModal');
const tabStudyKitMarkdown = document.getElementById('tabStudyKitMarkdown');
const tabStudyKitAnki = document.getElementById('tabStudyKitAnki');
const studyKitPreview = document.getElementById('studyKitPreview');
const studyKitCountSummary = document.getElementById('studyKitCountSummary');
const btnStudyKitCopy = document.getElementById('btnStudyKitCopy');
const btnStudyKitDownload = document.getElementById('btnStudyKitDownload');
let currentStudyKitTab = 'markdown';

// Cognitive Modes
const bionicModeSelect = document.getElementById('bionicModeSelect');
const pacingRulerSelect = document.getElementById('pacingRulerSelect');
const smartPdfCleanupSelect = document.getElementById('smartPdfCleanupSelect');
let bionicMode = localStorage.getItem('marginalia_bionic_mode') || 'off';
let pacingRulerMode = localStorage.getItem('marginalia_pacing_ruler') || 'off';
let smartPdfCleanup = localStorage.getItem('marginalia_smart_pdf_cleanup') !== 'off';
const optionsModal = document.getElementById('optionsModal');
const aboutModal = document.getElementById('aboutModal');
const summaryModal = document.getElementById('summaryModal');
const paywallModal = document.getElementById('paywallModal');
const summaryTrialNotice = document.getElementById('summaryTrialNotice');
const sumChapterBtn = document.getElementById('sumChapterBtn');
const sumKeyTakeawaysBtn = document.getElementById('sumKeyTakeawaysBtn');

// Profile Elements
const profileModal = document.getElementById('profileModal');
const profileModalAvatar = document.getElementById('profileModalAvatar');
const profileModalEmail = document.getElementById('profileModalEmail');
const profileModalTier = document.getElementById('profileModalTier');
const profileNeuralCount = document.getElementById('profileNeuralCount');
const profileNeuralProgress = document.getElementById('profileNeuralProgress');
const profileSummaryCount = document.getElementById('profileSummaryCount');
const profileRefillNote = document.getElementById('profileRefillNote');
const profileRefillBalance = document.getElementById('profileRefillBalance');
const profileRefillBalanceTopup = document.getElementById('profileRefillBalanceTopup');
const profileByokStatus = document.getElementById('profileByokStatus');
const profileOpenOptionsBtn = document.getElementById('profileOpenOptionsBtn');
const profileUpgradeBtn = document.getElementById('profileUpgradeBtn');
const profileSignOutBtn = document.getElementById('profileSignOutBtn');

// Auth Elements
const authModal = document.getElementById('authModal');
const authEmail = document.getElementById('authEmail');
const authPass = document.getElementById('authPass');
const authSignInBtn = document.getElementById('authSignInBtn');
const authSignUpBtn = document.getElementById('authSignUpBtn');
const authStatusAlert = document.getElementById('authStatusAlert');
const turnstileWrap = document.getElementById('turnstileWrap');
const turnstileWidgetEl = document.getElementById('turnstileWidget');
const authLockoutNote = document.getElementById('authLockoutNote');
const authResetBtn = document.getElementById('authResetBtn');

const fontSelect = document.getElementById('fontSelect');
const fontSizeSelect = document.getElementById('fontSizeSelect');
const optionThemeSelect = document.getElementById('optionThemeSelect');
const highlightModeSelect = document.getElementById('highlightModeSelect');
const customOpenAiKeyInput = document.getElementById('customOpenAiKeyInput');
const customElevenKeyInput = document.getElementById('customElevenKeyInput');
const karaokeCalibrationSlider = document.getElementById('karaokeCalibrationSlider');
const syncCalibrationDisplay = document.getElementById('syncCalibrationDisplay');
const karaokeCalibrationContainer = document.getElementById('karaokeCalibrationContainer');
const saveOptionsBtn = document.getElementById('saveOptionsBtn');

// --- iOS AUDIO UNLOCK ---
// iOS only allows <audio>.play() from inside a tap. The neural engines fetch audio over the
// network first, so by the time play() runs the tap has expired. Fix: during the tap, play a
// silent clip on the SAME element; once unlocked, later play() calls on it are allowed.
let audioUnlocked = false;
let silentUnlockUrl = null;

function unlockAudioForIOS() {
  if (audioUnlocked) return;
  try {
    if (!silentUnlockUrl) silentUnlockUrl = makeSilentWavUrl();
    audioElement.src = silentUnlockUrl;
    const p = audioElement.play();
    if (p && typeof p.then === 'function') {
      p.then(() => {
        audioUnlocked = true;
        if (audioElement.src === silentUnlockUrl) audioElement.pause();
      }).catch(() => { });
    }
  } catch (e) { }
}

// Bumped on every stop/skip so late network responses and stale speech callbacks are ignored
let speakToken = 0;

function cancelAllSpeech() {
  speakToken++;
  wasmScheduledToken = speakToken;
  currentUtterance = null;
  audioElement.onended = null;
  audioElement.ontimeupdate = null;
  audioElement.onloadedmetadata = null;
  browserSpeech.cancel();
  try { audioElement.pause(); } catch (e) { }
  if (typeof wasmActiveSourceNode !== 'undefined' && wasmActiveSourceNode) {
    try { wasmActiveSourceNode.stop(); wasmActiveSourceNode.disconnect(); } catch (e) {}
    wasmActiveSourceNode = null;
  }
  if (typeof wasmScheduledEndTime !== 'undefined') wasmScheduledEndTime = 0;
  if (typeof wasmScheduledSentenceIdx !== 'undefined') wasmScheduledSentenceIdx = -1;
  cancelWordAnimation();
}

function applyChosenVoice(utter) {
  const voices = browserSpeech.getVoices();
  if (voices.length > 0 && voicePicker.value && voicePicker.value !== "default") {
    const v = voices.find(vx => (vx.voiceURI === voicePicker.value) || (`${vx.name}:::${vx.lang}` === voicePicker.value));
    if (v) { utter.voice = v; utter.lang = v.lang; }
  }
}

// --- MEDIA SESSION CONTROLLER (Lock Screen Audio) ---
var keepAliveAudio = null;

function makeSilentWavUrl() {
  const sampleRate = 8000, n = sampleRate;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate, true);
  v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

function updateMediaMetadata() {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
  try {
    const ch = getCurrentChapter();
    navigator.mediaSession.metadata = new MediaMetadata({
      title: (ch && ch.title) || currentDocName,
      artist: currentDocName,
      album: 'Marginalia',
      artwork: [
        { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }
      ]
    });
  } catch (e) { console.warn('Media metadata failed:', e); }
}

function syncMediaSessionState(playing) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    // NOTE: no silent "keep-alive" <audio> alongside the system voice. On iPhone, starting an
    // audio element while speechSynthesis is speaking switches the audio session and cuts the
    // speech off after the first word. (It couldn't keep speech alive on lock anyway.)
    if (keepAliveAudio) keepAliveAudio.pause();
  } catch (e) { }
}

function skipSentence(delta) {
  const wasPlaying = isPlaying;
  isPlaying = false;
  cancelAllSpeech();

  let idx = currentSentenceIdx + delta;
  const len = () => (bookPages[currentPage] || []).length;
  if (idx < 0) {
    if (currentPage > 0) { currentPage--; renderPage(currentPage); idx = Math.max(0, len() - 1); }
    else idx = 0;
  } else if (idx >= len()) {
    if (currentPage < bookPages.length - 1) { currentPage++; renderPage(currentPage); idx = 0; }
    else idx = Math.max(0, len() - 1);
  }
  currentSentenceIdx = idx;
  highlightActiveSentence();
  if (wasPlaying) { isPlaying = true; playCurrentSentence(); }
}

function playBookmarkChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    const now = ctx.currentTime;
    // Rising chime: D5 (587.33Hz) -> A5 (880.00Hz)
    osc.frequency.setValueAtTime(587.33, now);
    osc.frequency.exponentialRampToValueAtTime(880.00, now + 0.18);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.2, now + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.3);
    setTimeout(() => { try { ctx.close(); } catch (e) { } }, 500);
  } catch (e) {
    console.warn('Chime audio context error:', e);
  }
}

async function triggerHandsfreeBookmark() {
  const activeItem = bookPages[currentPage]?.[currentSentenceIdx];
  const snippet = typeof activeItem === 'string' ? activeItem : (activeItem?.caption || "Diagram");
  await saveBookmarkToDB(currentDocName, currentPage, currentSentenceIdx, snippet);
  syncBookmarksFromCloud();
  playBookmarkChime();
  showToast(`🔖 Bookmark saved: Page ${currentPage + 1}`);
}

let lastNextTrackTime = 0;
let prevBookmarkPage = 0;
let prevBookmarkSentence = 0;

function handleHandsfreeNextTrack() {
  const now = Date.now();
  if (now - lastNextTrackTime < 650) {
    // Rapid double-tap detected!
    lastNextTrackTime = 0;
    currentPage = prevBookmarkPage;
    currentSentenceIdx = prevBookmarkSentence;
    renderPage(currentPage);
    highlightActiveSentence();
    triggerHandsfreeBookmark();
    if (isPlaying) {
      cancelAllSpeech();
      playCurrentSentence();
    }
    return;
  }
  lastNextTrackTime = now;
  prevBookmarkPage = currentPage;
  prevBookmarkSentence = currentSentenceIdx;
  skipSentence(1);
}

(function registerMediaSessionHandlers() {
  if (!('mediaSession' in navigator)) return;
  const set = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch (e) { } };
  set('play', () => { if (!isPlaying) { if (activeEngine !== 'browser') unlockAudioForIOS(); isPlaying = true; playCurrentSentence(); } });
  set('pause', () => stopAudio());
  set('stop', () => stopAudio());
  set('previoustrack', () => skipSentence(-1));
  set('nexttrack', handleHandsfreeNextTrack);
  set('skipad', () => triggerHandsfreeBookmark());
  set('seekbackward', () => prevPageBtn.click());
  set('seekforward', () => nextPageBtn.click());
})();

// --- TEXT SELECTION QUICK ACTIONS ---
function handleTextSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) {
    selectionPopover.style.display = 'none';
    return;
  }

  const text = sel.toString().trim();
  if (!text || text.length < 2) {
    selectionPopover.style.display = 'none';
    return;
  }

  currentSelectedText = text;

  let anchorElem = sel.anchorNode;
  while (anchorElem && (!anchorElem.classList || !anchorElem.classList.contains('sentence')) && anchorElem !== contentPane) {
    anchorElem = anchorElem.parentElement;
  }
  if (anchorElem && anchorElem.id && anchorElem.id.startsWith('sent-')) {
    const sId = parseInt(anchorElem.id.replace('sent-', ''), 10);
    currentSelectedSentenceIdx = isNaN(sId) ? currentSentenceIdx : sId;
  } else {
    currentSelectedSentenceIdx = currentSentenceIdx;
  }

  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  const cardRect = contentPane.getBoundingClientRect();

  selectionPopover.style.left = `${rect.left + rect.width / 2 - cardRect.left}px`;
  selectionPopover.style.top = `${rect.top - cardRect.top - 8}px`;
  selectionPopover.style.display = 'flex';
}

contentPane.addEventListener('mouseup', handleTextSelection);
contentPane.addEventListener('touchend', () => setTimeout(handleTextSelection, 100));

document.addEventListener('selectionchange', () => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) {
    selectionPopover.style.display = 'none';
  }
});

// iOS silences/kills the system (browser) voice when the screen locks or the app is backgrounded,
// and can't be prevented from a web page. Neural voices play through an <audio> element, which
// iOS keeps alive on the lock screen. So: for the system voice, recover cleanly on return.
let hiddenAt = 0;
let lockHintShown = false;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenAt = (isPlaying && activeEngine === 'browser') ? Date.now() : 0;
    return;
  }
  if (isPlaying && activeEngine === 'browser') {
    syncMediaSessionState(true);
    if (hiddenAt && Date.now() - hiddenAt > 1000) {
      // speech was likely cut off while hidden: restart the current sentence
      cancelAllSpeech();
      playCurrentSentence();
      if (!lockHintShown) {
        lockHintShown = true;
        showToast("The system voice pauses when the screen locks. Pick a neural voice for lock-screen listening.");
      }
    }
  }
  hiddenAt = 0;
});

btnSelectionSpeak.addEventListener('click', (e) => {
  e.stopPropagation();
  selectionPopover.style.display = 'none';
  if (!currentSelectedText) return;

  const wasBusy = browserSpeech.speaking || browserSpeech.pending;
  stopAudio();

  if (activeEngine === 'browser') {
    const utter = new SpeechSynthesisUtterance(currentSelectedText);
    utter.rate = playbackSpeed;
    utter.volume = playbackVolume;
    applyChosenVoice(utter);
    // iOS drops a speak() issued right after cancel(); give it a beat
    if (wasBusy) setTimeout(() => browserSpeech.speak(utter), 80);
    else browserSpeech.speak(utter);
  } else {
    unlockAudioForIOS();
    speakServerless(currentSelectedText, { standalone: true });
  }
});

btnSelectionDefine.addEventListener('click', async (e) => {
  e.stopPropagation();
  selectionPopover.style.display = 'none';
  const cleanWord = currentSelectedText.split(/\s+/)[0].replace(/[^a-zA-Z]/g, '').toLowerCase();
  if (!cleanWord) return;

  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${cleanWord}`);
    if (!res.ok) throw new Error("No definition found.");
    const data = await res.json();
    const def = data[0]?.meanings[0]?.definitions[0]?.definition || "Definition not found.";
    const part = data[0]?.meanings[0]?.partOfSpeech || "";
    await saveVocabToDB({
      word: cleanWord,
      partOfSpeech: part,
      definition: def,
      bookTitle: currentDocName,
      context: currentSelectedText
    });
    alert(`📖 "${cleanWord}" (${part}):\n\n${def}\n\n✓ Saved to Study Kit vocabulary!`);
  } catch (err) {
    alert(`Could not find a dictionary entry for "${cleanWord}".`);
  }
});

if (btnSelectionHighlight) {
  btnSelectionHighlight.addEventListener('click', async (e) => {
    e.stopPropagation();
    selectionPopover.style.display = 'none';
    if (!currentSelectedText) return;

    await saveAnnotationToDB({
      bookTitle: currentDocName,
      page: currentPage,
      sentenceIdx: currentSelectedSentenceIdx,
      quoteText: currentSelectedText,
      noteText: '',
      color: 'amber'
    });
    await refreshCurrentDocAnnotations();
    renderPage(currentPage);
    showToast('Highlighted in Amber 🎨');
  });
}

function updateColorDotSelection(color) {
  if (!noteColorPicker) return;
  noteColorPicker.querySelectorAll('.color-dot-btn').forEach(btn => {
    const isMatch = btn.getAttribute('data-color') === color;
    btn.classList.toggle('active', isMatch);
    btn.style.border = isMatch ? '2px solid var(--text-main)' : '2px solid transparent';
  });
}

function openNoteModalForEdit(noteObj) {
  if (!noteObj || !noteModal) return;
  activeNoteEditingId = noteObj.id;
  selectedNoteColor = noteObj.color || 'amber';
  if (noteModalQuote) noteModalQuote.textContent = `"${noteObj.quoteText}"`;
  if (noteModalText) noteModalText.value = noteObj.noteText || '';
  updateColorDotSelection(selectedNoteColor);
  noteModal.style.display = 'flex';
  if (noteModalText) noteModalText.focus();
}

if (btnSelectionNote) {
  btnSelectionNote.addEventListener('click', (e) => {
    e.stopPropagation();
    selectionPopover.style.display = 'none';
    if (!currentSelectedText || !noteModal) return;

    activeNoteEditingId = null;
    selectedNoteColor = 'amber';
    if (noteModalQuote) noteModalQuote.textContent = `"${currentSelectedText}"`;
    if (noteModalText) noteModalText.value = '';
    updateColorDotSelection('amber');
    noteModal.style.display = 'flex';
    if (noteModalText) noteModalText.focus();
  });
}

if (noteColorPicker) {
  noteColorPicker.querySelectorAll('.color-dot-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedNoteColor = btn.getAttribute('data-color') || 'amber';
      updateColorDotSelection(selectedNoteColor);
    });
  });
}

if (saveNoteBtn) {
  saveNoteBtn.addEventListener('click', async () => {
    const noteText = noteModalText ? noteModalText.value.trim() : '';
    if (!noteText) {
      showToast('Please type a note before saving.');
      return;
    }

    const fallbackQuote = (bookPages[currentPage] && typeof bookPages[currentPage][currentSelectedSentenceIdx] === 'string')
      ? bookPages[currentPage][currentSelectedSentenceIdx]
      : '';

    await saveAnnotationToDB({
      id: activeNoteEditingId,
      bookTitle: currentDocName,
      page: currentPage,
      sentenceIdx: currentSelectedSentenceIdx,
      quoteText: currentSelectedText || fallbackQuote,
      noteText,
      color: selectedNoteColor
    });

    closeModalById('noteModal');
    await refreshCurrentDocAnnotations();
    renderPage(currentPage);
    showToast(activeNoteEditingId ? 'Note updated 📝' : 'Note saved in margin 📝');
    activeNoteEditingId = null;
  });
}

btnSelectionCopy.addEventListener('click', (e) => {
  e.stopPropagation();
  selectionPopover.style.display = 'none';
  navigator.clipboard.writeText(currentSelectedText);
  alert("Text copied to clipboard!");
});

// --- IN-SITU AI READING COMPANION DRAWER (RIGHT) ---
const companionDrawer = document.getElementById('companionDrawer');
const companionOverlay = document.getElementById('companionOverlay');
const openCompanionBtn = document.getElementById('openCompanionBtn');
const closeCompanionBtn = document.getElementById('closeCompanionBtn');
const companionHeaderSub = document.getElementById('companionHeaderSub');
const companionContextText = document.getElementById('companionContextText');
const companionResponses = document.getElementById('companionResponses');
const companionInput = document.getElementById('companionInput');
const companionSendBtn = document.getElementById('companionSendBtn');
const btnSelectionCompanion = document.getElementById('btnSelectionCompanion');

if (btnSelectionCompanion) {
  btnSelectionCompanion.addEventListener('click', (e) => {
    e.stopPropagation();
    if (selectionPopover) selectionPopover.style.display = 'none';
    openCompanionDrawer(currentSelectedText);
  });
}

function isCompanionOpen() {
  return companionDrawer && companionDrawer.classList.contains('open');
}

function openCompanionDrawer(customText = null) {
  if (isDrawerOpen()) closeDrawer();
  const rawItem = customText || bookPages[currentPage]?.[currentSentenceIdx];
  const text = typeof rawItem === 'string' ? rawItem : (rawItem?.caption || "Current Section");

  if (companionContextText) {
    companionContextText.textContent = text ? `"${text}"` : 'No active passage selected.';
  }
  if (companionHeaderSub) {
    companionHeaderSub.textContent = `Page ${currentPage + 1} · In-situ reading context`;
  }
  if (companionDrawer) companionDrawer.classList.add('open');
  if (companionOverlay) companionOverlay.classList.add('active');
  if (companionInput) companionInput.focus();
}

function closeCompanionDrawer() {
  if (companionDrawer) companionDrawer.classList.remove('open');
  if (companionOverlay) companionOverlay.classList.remove('active');
}

async function askCompanion(mode = 'simplify', customQuestion = '') {
  const passage = companionContextText?.textContent?.replace(/^"|"$/g, '').trim() || '';
  if (!passage || passage === 'No active passage selected.') {
    showToast('Please open a document or select text to ask the reading companion.');
    return;
  }

  let userQuery = customQuestion;
  if (!userQuery) {
    if (mode === 'simplify') userQuery = 'Explain this passage in simple terms';
    else if (mode === 'socratic') userQuery = 'Give me Socratic questions to test comprehension';
    else if (mode === 'explain_terms') userQuery = 'Explain the key terms and concepts';
  }

  if (companionResponses) {
    const userBubble = document.createElement('div');
    userBubble.className = 'companion-bubble companion-bubble-user';
    userBubble.textContent = userQuery;
    companionResponses.appendChild(userBubble);

    const aiBubble = document.createElement('div');
    aiBubble.className = 'companion-bubble companion-bubble-ai';
    aiBubble.innerHTML = '<span style="color:var(--text-muted); font-style:italic;">Thinking…</span>';
    companionResponses.appendChild(aiBubble);
    companionResponses.scrollTop = companionResponses.scrollHeight;

    try {
      const customOpenAi = localStorage.getItem('marginalia_byok_openai') || '';
      const token = await getFreshAuthToken();

      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      if (customOpenAi) headers['x-custom-openai-key'] = customOpenAi;
      if (SUPABASE_PROJECT_URL && !SUPABASE_PROJECT_URL.includes("your-project")) {
        headers['x-supabase-url'] = SUPABASE_PROJECT_URL;
        headers['x-supabase-key'] = SUPABASE_ANON_KEY;
      }

      const res = await fetch('/api/summarize', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          text: passage,
          mode,
          question: customQuestion
        })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        aiBubble.innerHTML = `<span style="color:#ef4444;">⚠️ ${escapeHtml(data.error || 'Could not complete request.')}</span>`;
        return;
      }

      const reply = data.summary || 'No response generated.';
      const paragraphs = reply.split('\n\n').filter(Boolean);
      aiBubble.innerHTML = paragraphs.map(p => `<p style="margin:0 0 0.5rem 0;">${escapeHtml(p)}</p>`).join('');

      if (data.summaries_remaining !== null && data.summaries_remaining !== undefined) {
        if (creditDisplay) creditDisplay.textContent = `${data.summaries_remaining} AI credits`;
      }
    } catch (err) {
      aiBubble.innerHTML = `<span style="color:#ef4444;">⚠️ ${escapeHtml(err.message || 'Network error.')}</span>`;
    } finally {
      companionResponses.scrollTop = companionResponses.scrollHeight;
    }
  }
}

if (openCompanionBtn) openCompanionBtn.addEventListener('click', () => openCompanionDrawer());
if (closeCompanionBtn) closeCompanionBtn.addEventListener('click', closeCompanionDrawer);
if (companionOverlay) companionOverlay.addEventListener('click', closeCompanionDrawer);

document.querySelectorAll('.companion-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const action = chip.dataset.action;
    askCompanion(action);
  });
});

if (companionSendBtn && companionInput) {
  const send = () => {
    const q = companionInput.value.trim();
    if (!q) return;
    companionInput.value = '';
    askCompanion('ask', q);
  };
  companionSendBtn.addEventListener('click', send);
  companionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      send();
    }
  });
}

// --- DRAWER CONTROLLER ---
function isDrawerOpen() {
  return sideDrawer.classList.contains('open');
}

function setDrawerOpen(open) {
  if (open) {
    if ('inert' in sideDrawer) sideDrawer.inert = false;
    sideDrawer.setAttribute('aria-hidden', 'false');
    sideDrawer.classList.add('open');
    drawerOverlay.classList.add('active');
  } else {
    sideDrawer.classList.remove('open');
    drawerOverlay.classList.remove('active');
    sideDrawer.setAttribute('aria-hidden', 'true');
    // a closed drawer can't be tapped or focused, even while it slides away
    if ('inert' in sideDrawer) sideDrawer.inert = true;
  }
}
function openDrawer() { setDrawerOpen(true); }
function closeDrawer() { setDrawerOpen(false); }
setDrawerOpen(false); // start closed

openDrawerBtn.addEventListener('click', openDrawer);
closeDrawerBtn.addEventListener('click', closeDrawer);
drawerOverlay.addEventListener('click', closeDrawer); // tap outside the drawer

// Safety net: choosing ANY item in the drawer closes it, so a menu entry can never leave the user behind an
// open drawer (even one added later or whose own handler fails). Only the theme toggle stays open on purpose.
sideDrawer.addEventListener('click', (e) => {
  const item = e.target.closest('.drawer-nav-item, .drawer-quick-btn, .drawer-header');
  if (!item || item.id === 'btnDrawerNightToggle') return;
  closeDrawer();
});

// Swipe left on the drawer or on the dimmed area to close it
(function setupDrawerSwipe() {
  let start = null;
  const begin = (e) => { const t = e.touches[0]; start = { x: t.clientX, y: t.clientY }; };
  const end = (e) => {
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x, dy = t.clientY - start.y;
    start = null;
    if (dx < -60 && Math.abs(dx) > Math.abs(dy) * 1.5) closeDrawer();
  };
  [sideDrawer, drawerOverlay].forEach((el) => {
    el.addEventListener('touchstart', begin, { passive: true });
    el.addEventListener('touchend', end, { passive: true });
    el.addEventListener('touchcancel', () => { start = null; }, { passive: true });
  });
})();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isDrawerOpen()) closeDrawer();
});
window.addEventListener('orientationchange', () => { if (isDrawerOpen()) closeDrawer(); });

// --- INSTALL AS APP (drawer item) ---
let deferredInstallPrompt = null;
const isStandaloneApp = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIOSDevice = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// Android / desktop Chrome hand us a prompt we can trigger from our own button
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
});

function showInstallHelp(title, steps) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; z-index:10000; background:rgba(0,0,0,0.6); display:flex; align-items:center; justify-content:center; padding:calc(1rem + var(--safe-top)) 1rem calc(1rem + var(--safe-bottom));';
  const card = document.createElement('div');
  card.style.cssText = 'background:var(--panel-bg); color:var(--text-main); border:1px solid var(--border); border-radius:14px; padding:1.1rem 1.2rem; max-width:340px; width:100%; box-shadow:0 10px 30px rgba(0,0,0,0.45);';
  const h = document.createElement('div');
  h.textContent = title;
  h.style.cssText = 'font-weight:700; font-size:1.05rem; margin-bottom:0.7rem;';
  const ol = document.createElement('ol');
  ol.style.cssText = 'margin:0 0 1rem 1.2rem; padding:0; font-size:0.92rem; line-height:1.6;';
  steps.forEach(t => { const li = document.createElement('li'); li.textContent = t; ol.appendChild(li); });
  const ok = document.createElement('button');
  ok.textContent = 'Got it';
  ok.style.cssText = 'width:100%; padding:0.7rem; border:none; border-radius:10px; background:var(--accent, #38bdf8); color:#fff; font-weight:600; font-size:0.95rem; cursor:pointer;';
  const close = () => overlay.remove();
  ok.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  card.append(h, ol, ok);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

(function setupInstallDrawerItem() {
  // The page already has an (initially hidden) #navInstallPwa drawer item: use it, don't add a second one
  const existing = document.getElementById('navInstallPwa');
  if (isStandaloneApp()) { if (existing) existing.style.display = 'none'; return; } // already installed

  let item = existing;
  if (!item) {
    const body = sideDrawer && sideDrawer.querySelector('.drawer-body');
    if (!body) return;
    item = document.createElement('div');
    item.className = 'drawer-nav-item';
    item.id = 'navInstallPwa';
    item.innerHTML = '<span aria-hidden="true">📲</span><span>Install App</span>';
    body.appendChild(item);
  }
  item.style.display = 'flex'; // always visible (iPhone never fires the install event)

  item.addEventListener('click', async () => {
    closeDrawer();
    if (deferredInstallPrompt) {
      const promptEvent = deferredInstallPrompt;
      deferredInstallPrompt = null; // a prompt can only be used once
      try {
        promptEvent.prompt();
        await promptEvent.userChoice;
      } catch (e) { }
      return;
    }
    if (isIOSDevice()) {
      showInstallHelp('Install Marginalia', [
        'Tap the Share button (the square with an arrow) in your browser.',
        'Scroll down and tap "Add to Home Screen".',
        'Tap "Add". Marginalia will open like a normal app.'
      ]);
    } else {
      showInstallHelp('Install Marginalia', [
        'Open your browser menu (the ⋮ or ⋯ button).',
        'Tap "Install app" or "Add to Home screen".',
        'Confirm. Marginalia will open like a normal app.'
      ]);
    }
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    item.remove();
    showToast('Marginalia installed 🎉');
  });
})();

// --- SHELF & RECENT MODALS ---
async function showShelfModal(mode = "shelf", options = {}) {
  closeDrawer();
  // Render from local data first. The shelf has to open instantly even with no network or a stalled
  // auth refresh; the cloud pull runs after the list is on screen (end of this function).
  const books = await getAllBooksFromShelf();
  shelfModalTitle.textContent = mode === "recent" ? "🕒 Recent list" : "📚 My Shelf";
  shelfModalList.innerHTML = '';

  if (books.length === 0) {
    shelfModalList.innerHTML = '<div style="text-align:center; padding:2rem; color:var(--text-muted); font-size:0.85rem;">No books saved yet. Tap "Open" to load a file.</div>';
  } else {
    const displayBooks = mode === "recent" ? books.slice(0, 5) : books;
    displayBooks.forEach(b => {
      const card = document.createElement('div');
      card.className = 'shelf-card';
      card.innerHTML = `
        <div class="shelf-card-info">
          <span class="shelf-card-title">${escapeHtml(b.title)}</span>
          <span class="shelf-card-sub">Page ${(b.currentPage || 0) + 1} of ${b.pages.length}</span>
        </div>
        <div class="shelf-action-group">
          <button class="shelf-delete-btn" title="Delete document">🗑️</button>
          <span style="font-size:0.8rem; color:var(--accent); font-weight:600; padding:0.2rem 0.4rem;">Open →</span>
        </div>
      `;

      const delBtn = card.querySelector('.shelf-delete-btn');
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`Remove "${b.title}" from My Shelf?`)) {
          await deleteBookFromShelf(b.id);
          // The local delete is already done: the cloud row follows in the background so the shelf
          // refresh never waits on auth or the network.
          removeCloudProgressForBook(b.title);
          showShelfModal(mode);
        }
      });

      card.addEventListener('click', () => {
        stopAudio();
        bookPages = repairSavedPages(b.pages);
        bookChapters = (b.chapters || [{ title: "Beginning", pageIndex: 0 }])
          .map(ch => ({ ...ch, title: repairMojibake(ch.title) }));
        if (sleepTimerMode === 'chapter') clearSleepTimer(); // saved chapter boundary belongs to the old document
        currentDocName = b.title;
        currentPage = b.currentPage || 0;
        currentSentenceIdx = b.currentSentenceIdx || 0;
        docTitle.textContent = currentDocName;
        shelfModal.style.display = 'none';
        refreshCurrentDocAnnotations().then(() => renderPage(currentPage));
      });

      shelfModalList.appendChild(card);
    });
  }
  shelfModal.style.display = 'flex';
  reportStorageUsage();

  if (!options.skipCloudSync) {
    // Background reconcile. A pull that stalls (dead network, hanging token refresh) can only leave
    // this view's positions stale; it can never hold the shelf shut. Re-render only when a cloud
    // position actually won, and only while the shelf is still the visible modal.
    restoreProgressFromCloud()
      .then((result) => {
        if (result.adopted > 0 && shelfModal.style.display !== 'none') {
          showShelfModal(mode, { skipCloudSync: true });
        }
      })
      .catch(() => { });
  }
}

navRecentList.addEventListener('click', () => showShelfModal("recent"));
navMyShelf.addEventListener('click', () => showShelfModal("shelf"));

const importModal = document.getElementById('importModal');
const importChooseFileBtn = document.getElementById('importChooseFileBtn');
const importArticleUrlInput = document.getElementById('importArticleUrlInput');
const importArticleBtn = document.getElementById('importArticleBtn');
const importArticleStatus = document.getElementById('importArticleStatus');

function openImportModal() {
  if (importModal) {
    if (importArticleUrlInput) importArticleUrlInput.value = '';
    if (importArticleStatus) {
      importArticleStatus.style.display = 'none';
      importArticleStatus.textContent = '';
    }
    importModal.style.display = 'flex';
  }
}

navUploadFile.addEventListener('click', () => {
  closeDrawer();
  openImportModal();
});

if (importChooseFileBtn) {
  importChooseFileBtn.addEventListener('click', () => {
    closeModalById('importModal');
    fileInput.value = '';
    fileInput.click();
  });
}

if (importArticleBtn && importArticleUrlInput) {
  importArticleBtn.addEventListener('click', () => {
    const url = importArticleUrlInput.value.trim();
    if (!url) {
      if (importArticleStatus) {
        importArticleStatus.style.display = 'block';
        importArticleStatus.style.color = '#ef4444';
        importArticleStatus.textContent = 'Please enter a web article URL.';
      }
      return;
    }
    closeModalById('importModal');
    importWebArticle(url);
  });

  importArticleUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      importArticleBtn.click();
    }
  });
}

// --- BACKUP / RESTORE BUTTONS ---
const exportLibraryBtn = document.getElementById('exportLibraryBtn');
const importLibraryBtn = document.getElementById('importLibraryBtn');
const importLibraryInput = document.getElementById('importLibraryInput');

if (exportLibraryBtn) {
  exportLibraryBtn.addEventListener('click', () => { exportLibraryBackup(); });
}
if (importLibraryBtn && importLibraryInput) {
  importLibraryBtn.addEventListener('click', () => {
    importLibraryInput.value = '';
    importLibraryInput.click();
  });
  importLibraryInput.addEventListener('change', () => {
    const file = importLibraryInput.files && importLibraryInput.files[0];
    if (file) importLibraryBackup(file);
  });
}

// --- BOOKMARKS ---
addBookmarkBtn.addEventListener('click', async () => {
  const activeItem = bookPages[currentPage]?.[currentSentenceIdx];
  const snippet = typeof activeItem === 'string' ? activeItem : (activeItem?.caption || "Diagram");
  await saveBookmarkToDB(currentDocName, currentPage, currentSentenceIdx, snippet);
  // Fire-and-forget: the bookmark is already saved locally, and the account catches up when it can.
  if (typeof syncBookmarksFromCloud === 'function') syncBookmarksFromCloud();
  alert(`Bookmark saved: Page ${currentPage + 1}`);
});

async function showBookmarksModal(options = {}) {
  const marks = await getBookmarksFromDB();
  bookmarksModalList.innerHTML = '';

  if (marks.length === 0) {
    bookmarksModalList.innerHTML = '<div style="text-align:center; padding:2rem; color:var(--text-muted); font-size:0.85rem;">No bookmarks saved yet.</div>';
  } else {
    marks.reverse().forEach(m => {
      const card = document.createElement('div');
      card.className = 'shelf-card';
      card.innerHTML = `
        <div class="shelf-card-info">
          <span class="shelf-card-title">${escapeHtml(m.bookTitle)} — Page ${m.page + 1}</span>
          <span class="shelf-card-sub" style="font-style:italic;">"${escapeHtml((m.snippet || '').slice(0, 42))}..."</span>
        </div>
        <div class="shelf-action-group">
          <button class="shelf-delete-btn" title="Delete bookmark">🗑️</button>
          <span style="font-size:0.8rem; color:var(--accent); font-weight:600; padding:0.2rem 0.4rem;">Jump →</span>
        </div>
      `;

      const delBtn = card.querySelector('.shelf-delete-btn');
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation(); // don't also "jump" to the bookmark
        if (confirm(`Delete this bookmark?\n${m.bookTitle} — Page ${m.page + 1}`)) {
          const done = await deleteBookmarkFromDB(m.id);
          // The local delete is already done: the cloud row follows in the background so the list
          // refresh never waits on auth or the network.
          if (done) removeCloudBookmarkForLocal(m);
          if (!done) showToast('Could not delete the bookmark. Please try again.');
          showBookmarksModal({ skipCloudSync: true }); // refresh the list
        }
      });

      card.addEventListener('click', () => {
        if (currentDocName === m.bookTitle) {
          stopAudio();
          currentPage = m.page;
          currentSentenceIdx = m.sentenceIdx;
          bookmarksModal.style.display = 'none';
          renderPage(currentPage);
        } else {
          alert(`Bookmark is in "${m.bookTitle}". Open it first from My Shelf.`);
        }
      });
      bookmarksModalList.appendChild(card);
    });
  }
  bookmarksModal.style.display = 'flex';

  if (!options.skipCloudSync) {
    // Same shape as the shelf: render local rows instantly, then reconcile in the background and
    // re-render only when the account actually added something.
    syncBookmarksFromCloud().then((result) => {
      if (result.added > 0 && bookmarksModal.style.display !== 'none') {
        showBookmarksModal({ skipCloudSync: true });
      }
    });
  }
}

navBookmarks.addEventListener('click', () => {
  closeDrawer();
  showBookmarksModal();
});

// --- MARGIN NOTES & ANNOTATIONS MODAL ---
async function showAnnotationsModal() {
  closeDrawer();
  const notes = await getAnnotationsFromDB(currentDocName);
  if (!annotationsModalList) return;
  annotationsModalList.innerHTML = '';
  if (annotationsCountSummary) {
    annotationsCountSummary.textContent = `${notes.length} note${notes.length === 1 ? '' : 's'} / highlight${notes.length === 1 ? '' : 's'} in ${currentDocName}`;
  }

  if (notes.length === 0) {
    annotationsModalList.innerHTML = '<div style="text-align:center; padding:2rem; color:var(--text-muted); font-size:0.85rem;">No notes or highlights in this document yet.<br>Select any text to highlight or add a margin note.</div>';
  } else {
    notes.forEach(n => {
      const card = document.createElement('div');
      card.className = 'shelf-card';
      const colorBadge = n.color === 'mint' ? '🟢 Mint' : n.color === 'rose' ? '🔴 Rose' : '🟡 Amber';
      card.innerHTML = `
        <div class="shelf-card-info">
          <div style="display:flex; align-items:center; gap:0.4rem; margin-bottom:0.2rem;">
            <span style="font-size:0.72rem; padding:1px 6px; border-radius:10px; background:var(--border);">${colorBadge}</span>
            <span class="shelf-card-sub">Page ${n.page + 1}</span>
          </div>
          <span class="shelf-card-title" style="font-style:italic;">"${escapeHtml(n.quoteText)}"</span>
          ${n.noteText ? `<span style="font-size:0.82rem; color:var(--text-main); margin-top:0.25rem;">📝 ${escapeHtml(n.noteText)}</span>` : ''}
        </div>
        <div class="shelf-action-group">
          <button class="shelf-delete-btn" title="Delete note">🗑️</button>
          <span style="font-size:0.8rem; color:var(--accent); font-weight:600; padding:0.2rem 0.4rem;">Jump →</span>
        </div>
      `;

      const delBtn = card.querySelector('.shelf-delete-btn');
      if (delBtn) {
        delBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (confirm('Delete this annotation?')) {
            await deleteAnnotationFromDB(n.id);
            deleteCloudAnnotation(n.bookTitle, n.page, n.sentenceIdx, n.type);
            await refreshCurrentDocAnnotations();
            showAnnotationsModal();
            renderPage(currentPage);
          }
        });
      }

      card.addEventListener('click', () => {
        stopAudio();
        currentPage = n.page;
        currentSentenceIdx = n.sentenceIdx || 0;
        if (annotationsModal) annotationsModal.style.display = 'none';
        renderPage(currentPage);
      });

      annotationsModalList.appendChild(card);
    });
  }

  if (annotationsModal) annotationsModal.style.display = 'flex';
}

if (navAnnotations) {
  navAnnotations.addEventListener('click', () => {
    closeDrawer();
    showAnnotationsModal();
  });
}

// --- STUDY KIT EXPORT MODAL ---
async function showStudyKitModal() {
  closeDrawer();
  const [notes, vocab] = await Promise.all([
    getAnnotationsFromDB(currentDocName),
    getVocabFromDB(currentDocName)
  ]);

  if (studyKitCountSummary) {
    studyKitCountSummary.textContent = `${notes.length} note${notes.length === 1 ? '' : 's'} · ${vocab.length} vocabulary term${vocab.length === 1 ? '' : 's'}`;
  }

  function renderStudyKitContent() {
    if (!studyKitPreview) return;
    if (currentStudyKitTab === 'markdown') {
      let md = `# Study Kit: ${currentDocName}\n*Generated by Marginalia on ${new Date().toLocaleDateString()}*\n\n---\n\n`;
      md += `## 📝 Margin Notes & Highlights (${notes.length})\n\n`;
      if (notes.length === 0) {
        md += `*No highlights or notes recorded yet.*\n\n`;
      } else {
        notes.forEach((n, idx) => {
          md += `### ${idx + 1}. Page ${n.page + 1} (${n.color || 'highlight'})\n`;
          md += `> "${n.quoteText}"\n\n`;
          if (n.noteText) {
            md += `💡 **Note:** ${n.noteText}\n\n`;
          }
        });
      }

      md += `---\n\n## 📖 Vocabulary & Definitions (${vocab.length})\n\n`;
      if (vocab.length === 0) {
        md += `*No vocabulary saved yet. Select any word and tap Define to save to your kit.*\n\n`;
      } else {
        vocab.forEach(v => {
          md += `- **${v.word}** *(${v.partOfSpeech || 'term'})*: ${v.definition}\n`;
          if (v.context) md += `  > Context: "${v.context}"\n`;
        });
      }

      studyKitPreview.value = md;
    } else {
      // Anki Flashcards format
      let anki = `#separator:tab\n#html:true\n#tags column:3\n`;
      let count = 0;
      vocab.forEach(v => {
        count++;
        const front = escapeHtml(v.word);
        const back = `<i>(${escapeHtml(v.partOfSpeech || 'term')})</i> <b>${escapeHtml(v.definition)}</b><br><br><small>Context: &quot;${escapeHtml(v.context || '')}&quot;</small>`;
        const tag = `Marginalia::${currentDocName.replace(/[\s\t\n:]+/g, '_')}`;
        anki += `${front}\t${back}\t${tag}\n`;
      });

      notes.filter(n => n.noteText).forEach(n => {
        count++;
        const front = `Quote: &quot;${escapeHtml(n.quoteText)}&quot;<br><br><small>(Page ${n.page + 1})</small>`;
        const back = `<b>Margin Note:</b><br>${escapeHtml(n.noteText)}`;
        const tag = `Marginalia::${currentDocName.replace(/[\s\t\n:]+/g, '_')}::Notes`;
        anki += `${front}\t${back}\t${tag}\n`;
      });

      if (count === 0) {
        anki += `Marginalia Quickstart\tDefine words or add margin notes to export Anki flashcards!\tMarginalia\n`;
      }
      studyKitPreview.value = anki;
    }
  }

  if (tabStudyKitMarkdown) {
    tabStudyKitMarkdown.onclick = () => {
      currentStudyKitTab = 'markdown';
      tabStudyKitMarkdown.classList.add('active');
      if (tabStudyKitAnki) tabStudyKitAnki.classList.remove('active');
      renderStudyKitContent();
    };
  }

  if (tabStudyKitAnki) {
    tabStudyKitAnki.onclick = () => {
      currentStudyKitTab = 'anki';
      tabStudyKitAnki.classList.add('active');
      if (tabStudyKitMarkdown) tabStudyKitMarkdown.classList.remove('active');
      renderStudyKitContent();
    };
  }

  if (btnStudyKitCopy) {
    btnStudyKitCopy.onclick = () => {
      if (!studyKitPreview) return;
      navigator.clipboard.writeText(studyKitPreview.value);
      showToast('Study Kit copied to clipboard 📋');
    };
  }

  if (btnStudyKitDownload) {
    btnStudyKitDownload.onclick = () => {
      if (!studyKitPreview) return;
      const ext = currentStudyKitTab === 'markdown' ? 'md' : 'txt';
      const cleanName = currentDocName.replace(/[^a-zA-Z0-9_\-]/g, '_');
      const filename = `${cleanName}_StudyKit.${ext}`;
      const blob = new Blob([studyKitPreview.value], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast(`Downloaded ${filename} ⬇️`);
    };
  }

  renderStudyKitContent();
  if (studyKitModal) studyKitModal.style.display = 'flex';
}

if (navStudyKit) {
  navStudyKit.addEventListener('click', () => {
    closeDrawer();
    showStudyKitModal();
  });
}

// --- CHAPTER & PAGE JUMP MODAL HANDLERS ---
function getCurrentChapter() {
  if (!bookChapters || bookChapters.length === 0) return { title: "Chapter 1", pageIndex: 0 };
  let active = bookChapters[0];
  for (const ch of bookChapters) {
    if (currentPage >= ch.pageIndex) active = ch;
    else break;
  }
  return active;
}

openJumpModalBtn.addEventListener('click', () => {
  pageJumpSlider.max = bookPages.length;
  pageJumpSlider.value = currentPage + 1;
  pageDirectInput.max = bookPages.length;
  pageDirectInput.value = currentPage + 1;
  sliderValueDisplay.textContent = `Page ${currentPage + 1} of ${bookPages.length}`;

  chapterListView.innerHTML = '';
  if (!bookChapters || bookChapters.length === 0) {
    chapterListView.innerHTML = '<div style="text-align:center; padding:1.5rem; color:var(--text-muted);">No separate chapters found.</div>';
  } else {
    const currentCh = getCurrentChapter();
    bookChapters.forEach((ch) => {
      const item = document.createElement('div');
      item.className = `chapter-item ${ch.pageIndex === currentCh.pageIndex ? 'active' : ''}`;
      item.innerHTML = `
        <span>${escapeHtml(ch.title)}</span>
        <span style="font-size:0.75rem; color:var(--text-muted);">Pg ${ch.pageIndex + 1}</span>
      `;
      item.addEventListener('click', () => {
        stopAudio();
        currentPage = ch.pageIndex;
        currentSentenceIdx = 0;
        jumpModal.style.display = 'none';
        renderPage(currentPage);
      });
      chapterListView.appendChild(item);
    });
  }

  jumpModal.style.display = 'flex';
});

tabChaptersBtn.addEventListener('click', () => {
  tabChaptersBtn.classList.add('active');
  tabPagesBtn.classList.remove('active');
  chapterListView.style.display = 'flex';
  pageJumpView.style.display = 'none';
});

tabPagesBtn.addEventListener('click', () => {
  tabPagesBtn.classList.add('active');
  tabChaptersBtn.classList.remove('active');
  chapterListView.style.display = 'none';
  pageJumpView.style.display = 'flex';
});

pageJumpSlider.addEventListener('input', (e) => {
  const val = parseInt(e.target.value, 10);
  sliderValueDisplay.textContent = `Page ${val} of ${bookPages.length}`;
  pageDirectInput.value = val;
});

btnExecuteDirectJump.addEventListener('click', () => {
  let target = parseInt(pageDirectInput.value, 10);
  if (isNaN(target) || target < 1) target = 1;
  if (target > bookPages.length) target = bookPages.length;
  stopAudio();
  currentPage = target - 1;
  currentSentenceIdx = 0;
  jumpModal.style.display = 'none';
  renderPage(currentPage);
});

// --- DRAWER ACTIONS ---
function openOptionsModal() {
  optionThemeSelect.value = document.documentElement.getAttribute('data-theme') || 'dark';
  fontSelect.value = localStorage.getItem('marginalia_font_face') || 'serif';
  fontSizeSelect.value = localStorage.getItem('marginalia_font_size') || '1.15rem';
  highlightModeSelect.value = highlightMode;
  if (bionicModeSelect) bionicModeSelect.value = bionicMode;
  if (pacingRulerSelect) pacingRulerSelect.value = pacingRulerMode;
  if (smartPdfCleanupSelect) smartPdfCleanupSelect.value = smartPdfCleanup ? 'on' : 'off';
  karaokeCalibrationContainer.style.display = highlightMode === 'word' ? 'block' : 'none';
  customOpenAiKeyInput.value = localStorage.getItem('marginalia_byok_openai') || '';
  customElevenKeyInput.value = localStorage.getItem('marginalia_byok_eleven') || '';
  karaokeCalibrationSlider.value = userManualCalibration;
  updateSyncCalibrationLabel(userManualCalibration);
  optionsModal.style.display = 'flex';
}

btnDrawerNightToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  const nextTheme = current === 'dark' ? 'oled'
    : current === 'oled' ? 'sepia'
      : current === 'sepia' ? 'light'
        : current === 'light' ? 'parchment'
          : 'dark';
  document.documentElement.setAttribute('data-theme', nextTheme);
  localStorage.setItem('marginalia_theme', nextTheme);
  optionThemeSelect.value = nextTheme;
});

btnDrawerOptions.addEventListener('click', () => {
  closeDrawer();
  openOptionsModal();
});

btnDrawerAbout.addEventListener('click', () => {
  closeDrawer();
  aboutModal.style.display = 'flex';
});

const FONT_FACES = {
  serif: 'var(--font-reader)',
  book: 'var(--font-book)',
  readable: 'var(--font-readable)',
  monospace: 'monospace',
  'sans-serif': 'var(--font-ui)'
};

function applyFontFace(val) {
  contentPane.style.fontFamily = FONT_FACES[val] || FONT_FACES.serif;
}

fontSelect.addEventListener('change', (e) => {
  applyFontFace(e.target.value);
  localStorage.setItem('marginalia_font_face', e.target.value);
});

fontSizeSelect.addEventListener('change', (e) => {
  document.documentElement.style.setProperty('--reader-font-size', e.target.value);
  localStorage.setItem('marginalia_font_size', e.target.value);
  document.querySelectorAll('.book-content, .text-content').forEach((el) => {
    el.style.lineHeight = '1.75';
  });
});

optionThemeSelect.addEventListener('change', (e) => {
  document.documentElement.setAttribute('data-theme', e.target.value);
  localStorage.setItem('marginalia_theme', e.target.value);
});

highlightModeSelect.addEventListener('change', (e) => {
  karaokeCalibrationContainer.style.display = e.target.value === 'word' ? 'block' : 'none';
});

function updateSyncCalibrationLabel(val) {
  if (val === 1.0) syncCalibrationDisplay.textContent = "Normal (Auto-Sync)";
  else if (val < 1.0) syncCalibrationDisplay.textContent = `${Math.round((1 - val) * 100)}% Slower`;
  else syncCalibrationDisplay.textContent = `${Math.round((val - 1) * 100)}% Faster`;
}

karaokeCalibrationSlider.addEventListener('input', (e) => {
  const val = parseFloat(e.target.value);
  userManualCalibration = val;
  updateSyncCalibrationLabel(val);
  localStorage.setItem('marginalia_sync_calibration', val.toString());
});

saveOptionsBtn.addEventListener('click', () => {
  const selectedFont = fontSelect.value;
  const selectedSize = fontSizeSelect.value;
  const selectedTheme = optionThemeSelect.value;
  const selectedHighlight = highlightModeSelect.value;
  const openAiKey = customOpenAiKeyInput.value.trim();
  const elevenKey = customElevenKeyInput.value.trim();
  const calib = karaokeCalibrationSlider.value;

  localStorage.setItem('marginalia_font_face', selectedFont);
  localStorage.setItem('marginalia_font_size', selectedSize);
  localStorage.setItem('marginalia_theme', selectedTheme);
  localStorage.setItem('marginalia_highlight_mode', selectedHighlight);
  localStorage.setItem('marginalia_byok_openai', openAiKey);
  localStorage.setItem('marginalia_byok_eleven', elevenKey);
  localStorage.setItem('marginalia_sync_calibration', calib);

  if (bionicModeSelect) {
    bionicMode = bionicModeSelect.value;
    localStorage.setItem('marginalia_bionic_mode', bionicMode);
  }
  if (pacingRulerSelect) {
    pacingRulerMode = pacingRulerSelect.value;
    localStorage.setItem('marginalia_pacing_ruler', pacingRulerMode);
    document.body.classList.toggle('pacing-ruler-active', pacingRulerMode === 'active');
  }
  if (smartPdfCleanupSelect) {
    smartPdfCleanup = smartPdfCleanupSelect.value !== 'off';
    localStorage.setItem('marginalia_smart_pdf_cleanup', smartPdfCleanup ? 'on' : 'off');
  }

  applyFontFace(selectedFont);
  document.documentElement.style.setProperty('--reader-font-size', selectedSize);
  document.documentElement.setAttribute('data-theme', selectedTheme);
  highlightMode = selectedHighlight;
  userManualCalibration = parseFloat(calib) || 1.0;

  renderPage(currentPage);
  highlightActiveSentence();
  updateAuthBadge();

  saveOptionsBtn.textContent = '✓ Saved!';
  setTimeout(() => {
    saveOptionsBtn.textContent = 'Save & Done';
    closeModalById('optionsModal');
  }, 350);
});

// --- PROFILE & AUTHENTICATION CONTROLLER ---

// The Account window's HTML ships with demo values (U / user@example.com / Free Tier / 5,000 / 5,000).
// Wipe them so nobody ever sees a pretend account: on page load, on sign-out, and whenever nobody is signed in.
function resetProfileModalPlaceholders() {
  profileModalAvatar.textContent = '';
  profileModalEmail.textContent = '';
  profileModalTier.textContent = '';
  profileNeuralCount.textContent = '—';
  profileNeuralProgress.style.width = '0%';
  profileSummaryCount.textContent = '—';
  if (profileRefillNote) profileRefillNote.style.display = 'none';
  profileByokStatus.textContent = '—';
  profileByokStatus.style.color = 'var(--text-muted)';
  if (profileRefillBalance) {
    profileRefillBalance.textContent = '';
    profileRefillBalance.style.display = 'none';
  }
  if (profileRefillBalanceTopup) {
    profileRefillBalanceTopup.textContent = '';
    profileRefillBalanceTopup.style.display = 'none';
  }
}
resetProfileModalPlaceholders();

// Single place that decides "is someone really signed in?", used by the header button and the Account window
async function getSignedInUser() {
  if (!supabaseClient) return null;
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    return session && session.user ? session.user : null;
  } catch (e) {
    return null;
  }
}

// Check if user is signed in (freemium teaser pattern)
async function isUserSignedIn() {
  if (!supabaseClient) return false;
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    return session && session.user ? true : false;
  } catch (e) {
    return false;
  }
}

function openSignInDialog() {
  resetProfileModalPlaceholders();
  closeModalById('profileModal');
  authStatusAlert.style.display = 'none';
  authModal.style.display = 'flex';
}

async function openProfileModal() {
  const user = await getSignedInUser();
  if (!user) {
    openSignInDialog(); // not signed in: show the sign-in dialog, never the Account window
    return;
  }

  const email = user.email || 'Reader';
  const initial = email.charAt(0).toUpperCase();

  profileModalAvatar.textContent = initial;
  profileModalEmail.textContent = email;

  let { data: profile, error: profileError } = await supabaseClient
    .from('profiles')
    .select('neural_chars_remaining, summary_credits_remaining, tier, pro_tier, pro_expires_at, pro_quota_resets_at, topup_neural_chars, topup_ai_ops')
    .eq('id', user.id)
    .maybeSingle();

  // If column error or schema cache issue, retry with base columns
  if (profileError && /topup_neural_chars|topup_ai_ops|column/i.test(profileError.message || '')) {
    console.warn('Retrying profile fetch without topup columns:', profileError.message);
    const fallback = await supabaseClient
      .from('profiles')
      .select('neural_chars_remaining, summary_credits_remaining, tier, pro_tier, pro_expires_at, pro_quota_resets_at')
      .eq('id', user.id)
      .maybeSingle();
    profile = fallback.data;
    profileError = fallback.error;
  }

  // A failed lookup must not be shown as real numbers (it used to fall back to a full 5,000 / 3)
  if (profileError) {
    console.error('Failed to load profile details:', profileError);
    profileModalTier.textContent = "Couldn't load your account details";
    profileNeuralCount.textContent = '—';
    profileNeuralProgress.style.width = '0%';
    profileSummaryCount.textContent = '—';
    profileRefillNote.style.display = 'none';
    const keys = Boolean(localStorage.getItem('marginalia_byok_openai') || localStorage.getItem('marginalia_byok_eleven'));
    profileByokStatus.textContent = keys ? 'Active (Keys Configured)' : 'None Added';
    profileModal.style.display = 'flex';
    return;
  }

  const tier = profile?.tier || 'free';
  const allowance = planAllowance(profile);
  if (tier === 'pro') {
    profileModalTier.textContent = allowance
      ? `🌟 ${planTierName(profile.pro_tier, allowance.name)} · until ${new Date(profile.pro_expires_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
      : isProActiveClient(profile)
        ? '🌟 Pro'
        : '⚡ Free Trial Account (Pro expired)';
  } else {
    profileModalTier.textContent = '⚡ Free Trial Account';
  }

  // The denominator is the allowance this account actually bought; free accounts get 5,000
  const charAllowance = allowance ? allowance.neuralChars : 5000;
  const chars = profile?.neural_chars_remaining ?? charAllowance;
  profileNeuralCount.textContent = `${chars.toLocaleString()} / ${charAllowance.toLocaleString()} Chars`;
  const fillPct = Math.max(0, Math.min(100, (chars / charAllowance) * 100));
  profileNeuralProgress.style.width = `${fillPct}%`;

  const summaries = profile?.summary_credits_remaining ?? (allowance ? allowance.summaries : 3);
  profileSummaryCount.textContent = `${summaries} Remaining`;

  // Paid allowances refill every period; say when, so a spent balance does not read as a dead end.
  // Free accounts never refill, so the line stays hidden for them.
  const refillAt = profile?.pro_quota_resets_at ? Date.parse(profile.pro_quota_resets_at) : NaN;
  if (allowance && Number.isFinite(refillAt)) {
    profileRefillNote.textContent = `\u{1F504} Refreshes ${new Date(refillAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    profileRefillNote.style.display = '';
  } else {
    profileRefillNote.style.display = 'none';
  }

  // Non-expiring refill top-ups, if any, are shown separately from the monthly allowance so the
  // Account window names the real rollover balance the user already bought.
  const refillNeural = typeof profile?.topup_neural_chars === 'number' ? profile.topup_neural_chars : 0;
  const refillOps = typeof profile?.topup_ai_ops === 'number' ? profile.topup_ai_ops : 0;
  if (profileRefillBalance) {
    if (refillNeural > 0) {
      profileRefillBalance.textContent = `+${refillNeural.toLocaleString()} bonus neural chars`;
      profileRefillBalance.style.display = '';
    } else {
      profileRefillBalance.style.display = 'none';
    }
  }
  if (profileRefillBalanceTopup) {
    if (refillOps > 0) {
      profileRefillBalanceTopup.textContent = `+${refillOps.toLocaleString()} bonus AI summaries`;
      profileRefillBalanceTopup.style.display = '';
    } else {
      profileRefillBalanceTopup.style.display = 'none';
    }
  }

  const hasByok = Boolean(localStorage.getItem('marginalia_byok_openai') || localStorage.getItem('marginalia_byok_eleven'));
  if (hasByok) {
    profileByokStatus.textContent = "Active (Keys Configured)";
    profileByokStatus.style.color = "var(--accent)";
  } else {
    profileByokStatus.textContent = "None Added";
    profileByokStatus.style.color = "var(--text-muted)";
  }

  profileModal.style.display = 'flex';
}

creditBadge.addEventListener('click', async () => {
  const user = await getSignedInUser();
  if (user) openProfileModal();
  else openSignInDialog(); // the header says "Sign In", so it opens the sign-in dialog
});

navProfileItem.addEventListener('click', () => {
  closeDrawer();
  openProfileModal();
});

drawerHeaderProfileClick.addEventListener('click', () => {
  closeDrawer();
  openProfileModal();
});

profileOpenOptionsBtn.addEventListener('click', () => {
  closeModalById('profileModal');
  openOptionsModal();
});

profileUpgradeBtn.addEventListener('click', () => {
  closeModalById('profileModal');
  openPaywall(); // lists every plan with the server's prices
});

profileSignOutBtn.addEventListener('click', async () => {
  if (confirm("Are you sure you want to sign out of your account?")) {
    if (supabaseClient) {
      await supabaseClient.auth.signOut().catch(() => { });
    }
    localStorage.removeItem('marginalia_auth_token');
    localStorage.removeItem('marginalia_auth_user');
    resetProfileModalPlaceholders();
    closeModalById('profileModal');
    updateAuthBadge();
    alert("Signed out successfully.");
  }
});

function showAuthAlert(msg, type = "error") {
  authStatusAlert.style.display = 'block';
  authStatusAlert.textContent = msg;
  if (type === "error") {
    authStatusAlert.style.background = 'rgba(239, 68, 68, 0.15)';
    authStatusAlert.style.color = '#ef4444';
    authStatusAlert.style.border = '1px solid rgba(239, 68, 68, 0.3)';
  } else if (type === "success") {
    authStatusAlert.style.background = 'rgba(16, 185, 129, 0.15)';
    authStatusAlert.style.color = '#10b981';
    authStatusAlert.style.border = '1px solid rgba(16, 185, 129, 0.3)';
  } else {
    authStatusAlert.style.background = 'rgba(56, 189, 248, 0.15)';
    authStatusAlert.style.color = 'var(--accent)';
    authStatusAlert.style.border = '1px solid rgba(56, 189, 248, 0.3)';
  }
}

async function getFreshAuthToken() {
  const cachedToken = localStorage.getItem('marginalia_auth_token');
  if (supabaseClient) {
    try {
      let { data: { session } } = await supabaseClient.auth.getSession();
      if (session?.access_token) {
        localStorage.setItem('marginalia_auth_token', session.access_token);
        return session.access_token;
      }
    } catch (e) { }
  }
  return cachedToken || null;
}

// The badge is an icon plus a label. Narrow phones hide the label in CSS and keep the icon, so the
// account control still fits in the header next to Open / Search / Summary.
function setCreditBadge(icon, label) {
  creditDisplay.innerHTML =
    `<span class="user-avatar-mini">${escapeHtml(icon)}</span>` +
    `<span class="credit-label">${escapeHtml(label)}</span>`;
}

async function updateAuthBadge(explicitRemaining = null) {
  const hasByok = Boolean(localStorage.getItem('marginalia_byok_openai') || localStorage.getItem('marginalia_byok_eleven'));

  if (!supabaseClient) {
    if (hasByok) setCreditBadge('🔑', 'BYOK Active');
    else setCreditBadge('⚡', 'Free Tier');
    drawerUserTitle.textContent = "Marginalia Library";
    drawerUserSubtitle.textContent = "Tap to sign in";
    return;
  }

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session && session.user) {
    const email = session.user.email || 'Reader';
    const initial = email.charAt(0).toUpperCase();

    drawerUserTitle.textContent = email;
    drawerUserSubtitle.textContent = "Signed In • Tap for Profile";

    if (hasByok) {
      setCreditBadge(initial, 'BYOK Active');
      return;
    }

    if (explicitRemaining !== null) {
      setCreditBadge(initial, String(explicitRemaining.toLocaleString()));
      return;
    }

    const { data: profile } = await supabaseClient
      .from('profiles')
      .select('neural_chars_remaining')
      .eq('id', session.user.id)
      .maybeSingle();

    const remaining = profile ? profile.neural_chars_remaining : 5000;
    setCreditBadge(initial, String(remaining.toLocaleString()));
  } else {
    if (hasByok) setCreditBadge('🔑', 'BYOK Active');
    else setCreditBadge('👤', 'Sign In');
    drawerUserTitle.textContent = "Marginalia Library";
    drawerUserSubtitle.textContent = "Tap to sign in";
    resetProfileModalPlaceholders();
  }
}

// --- AUTH: SERVER-SIDE RATE LIMITING + TURNSTILE ---------------------------------------------
// Sign-in no longer calls Supabase Auth from the browser, because then the only throttle would be
// a disabled button. /api/auth verifies the Turnstile challenge, applies the per-email and per-IP
// limits on the server and only then reaches Supabase. A 429 tells us exactly how long to wait, and
// whether the next attempt needs a CAPTCHA.
const TURNSTILE_SITE_KEY = (
  document.querySelector('meta[name="turnstile-site-key"]')?.content || ''
).trim();

let turnstileWidgetId = null;
let captchaToken = '';
let captchaRequired = false;
let authFailures = 0;
let authCooldownTimer = null;

function turnstileReady() {
  return Boolean(TURNSTILE_SITE_KEY && window.turnstile && turnstileWidgetEl);
}

// The Turnstile script is async, so it may still be loading when a 429 asks for a challenge.
// Poll briefly instead of depending on a load callback that could fire before app.js runs.
let turnstileWaitTimer = null;

function renderTurnstileWidget() {
  if (!turnstileReady() || turnstileWidgetId !== null) return false;
  turnstileWidgetId = window.turnstile.render(turnstileWidgetEl, {
    sitekey: TURNSTILE_SITE_KEY,
    callback: (token) => { captchaToken = token || ''; },
    'expired-callback': () => { captchaToken = ''; },
    'error-callback': () => { captchaToken = ''; }
  });
  return true;
}

// Renders the widget once and keeps it on screen for every following attempt.
function showCaptchaChallenge() {
  if (!TURNSTILE_SITE_KEY || !turnstileWrap || !turnstileWidgetEl) return;
  captchaRequired = true;
  turnstileWrap.style.display = '';

  if (renderTurnstileWidget() || turnstileWaitTimer) return;

  let attempts = 0;
  turnstileWaitTimer = setInterval(() => {
    attempts += 1;
    if (renderTurnstileWidget() || attempts >= 40) {
      clearInterval(turnstileWaitTimer);
      turnstileWaitTimer = null;
    }
  }, 300);
}

// A used or expired token cannot be reused, so every attempt after the first needs a reset.
function resetCaptchaChallenge() {
  captchaToken = '';
  if (window.turnstile && turnstileWidgetId !== null) {
    try { window.turnstile.reset(turnstileWidgetId); } catch (e) { }
  }
}

function setAuthBusy(busy, label) {
  authSignInBtn.disabled = busy;
  authSignUpBtn.disabled = busy;
  if (authResetBtn) authResetBtn.disabled = busy;
  if (label) authSignInBtn.textContent = label;
  else authSignInBtn.textContent = 'Sign In';
}

function clearAuthCooldown() {
  if (authCooldownTimer) { clearInterval(authCooldownTimer); authCooldownTimer = null; }
  if (authLockoutNote) { authLockoutNote.style.display = 'none'; authLockoutNote.textContent = ''; }
  setAuthBusy(false);
}

// The countdown is driven by the server's Retry-After, not a guess, so the button never re-enables
// early and the reader is never left staring at a dead form.
function startAuthCooldown(seconds, reason) {
  const until = Date.now() + Math.max(1, Number(seconds) || 30) * 1000;
  if (authCooldownTimer) clearInterval(authCooldownTimer);

  const tick = () => {
    const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    if (authLockoutNote) {
      authLockoutNote.style.display = 'block';
      authLockoutNote.textContent = left > 0
        ? `${reason} Try again in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.`
        : '';
    }
    if (left <= 0) clearAuthCooldown();
  };

  setAuthBusy(true, 'Please wait…');
  tick();
  authCooldownTimer = setInterval(tick, 1000);
}

// --- AI ROUTE GATES: RATE LIMITS AND EMAIL VERIFICATION ---
// /api/tts and /api/summarize answer 429 with a Retry-After, and 403 with EMAIL_VERIFICATION_REQUIRED
// for a signed-in account that has not confirmed its address. Both used to reach the reader as raw
// server codes in an alert; these mirror the auth flow, which counts the wait down and says what to
// do next instead of re-enabling a dead button.
let readerNoticeTimer = null;
let readerNoticeEl = null;
let readerLockedUntil = 0;

function clearReaderNotice() {
  if (readerNoticeTimer) { clearInterval(readerNoticeTimer); readerNoticeTimer = null; }
  if (readerNoticeEl) { readerNoticeEl.remove(); readerNoticeEl = null; }
  readerLockedUntil = 0;
}

function retryAfterSeconds(res, data) {
  return Number(data && data.retryAfter) ||
    Number(res && res.headers && res.headers.get('Retry-After')) || 30;
}

// One notice that counts down from the server's Retry-After (never a guess), so the reader can see how
// long the pause is and what to do when it ends.
function showReaderCountdown(seconds, reason, onReady) {
  clearReaderNotice();
  const until = Date.now() + Math.max(1, Number(seconds) || 30) * 1000;
  readerLockedUntil = until;

  const el = document.createElement('div');
  el.style.cssText = 'position:fixed; left:50%; bottom:calc(var(--safe-bottom) + 90px); transform:translateX(-50%); max-width:90vw; background:var(--panel-bg); color:var(--text-main); border:1px solid var(--border); padding:0.55rem 0.9rem; border-radius:8px; font-size:0.8rem; text-align:center; z-index:9999; box-shadow:0 4px 14px rgba(0,0,0,0.35);';
  document.body.appendChild(el);
  readerNoticeEl = el;

  const tick = () => {
    const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    if (left <= 0) {
      clearReaderNotice();
      if (typeof onReady === 'function') onReady();
      return;
    }
    el.textContent = `${reason} Try again in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.`;
  };
  tick();
  readerNoticeTimer = setInterval(tick, 1000);
}

// Returns true when the response was one of these two gates, so the caller can stop and explain rather
// than surfacing the server code.
function explainAiRefusal(status, code, retryAfter, onReady) {
  if (status === 429) {
    showReaderCountdown(retryAfter, code === 'TEMP_LOCKOUT'
      ? 'Too many requests — AI reading is paused for your protection.'
      : 'Too many AI requests.', onReady);
    return true;
  }
  if (status === 403 && code === 'EMAIL_VERIFICATION_REQUIRED') {
    updateAuthBadge();
    authModal.style.display = 'flex';
    showAuthAlert('Confirm your email address to use AI reading. Open the link we emailed you, then sign in again.', 'error');
    return true;
  }
  return false;
}

async function submitAuth(action) {
  authStatusAlert.style.display = 'none';
  if (!supabaseClient) {
    showAuthAlert('Supabase credentials not configured in app.js.', 'error');
    return;
  }

  const email = authEmail.value.trim();
  const password = authPass.value;
  if (!email) {
    showAuthAlert('Please enter your email address.', 'error');
    return;
  }
  if (action !== 'reset' && !password) {
    showAuthAlert('Please enter both email and password.', 'error');
    return;
  }
  if (TURNSTILE_SITE_KEY && captchaRequired && !captchaToken) {
    showAuthAlert('Please complete the verification challenge below.', 'error');
    showCaptchaChallenge();
    return;
  }

  setAuthBusy(true, action === 'reset' ? 'Sending…' : 'Signing in...');

  try {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, email, password, captchaToken })
    });
    const data = await res.json().catch(() => ({}));

    if (res.status === 429) {
      const retryAfter = Number(data.retryAfter) || Number(res.headers.get('Retry-After')) || 30;
      if (data.requireCaptcha) showCaptchaChallenge();
      else resetCaptchaChallenge();
      const reason = data.error === 'TEMP_LOCKOUT'
        ? 'Too many attempts — sign-in is paused for your protection.'
        : 'Too many attempts.';
      showAuthAlert(reason, 'error');
      startAuthCooldown(retryAfter, reason);
      return;
    }

    if (!res.ok) {
      authFailures += 1;
      if (authFailures >= 3) showCaptchaChallenge();
      else resetCaptchaChallenge();
      showAuthAlert(data.error || 'Authentication failed. Please try again.', 'error');
      return;
    }

    authFailures = 0;

    if (action === 'reset') {
      showAuthAlert('If that email has an account, a password reset link is on its way.', 'success');
      resetCaptchaChallenge();
      return;
    }

    if (data.needsEmailConfirmation) {
      showAuthAlert("Account created! Check your email inbox to confirm your address before signing in.", 'info');
      resetCaptchaChallenge();
      return;
    }

    const session = data.session;
    if (!session?.access_token) {
      showAuthAlert('The sign-in service returned no session. Please try again.', 'error');
      resetCaptchaChallenge();
      return;
    }

    // Hand the session to supabase-js so every later request carries the same JWT it manages.
    await supabaseClient.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token || ''
    });
    localStorage.setItem('marginalia_auth_token', session.access_token);
    if (session.user) localStorage.setItem('marginalia_auth_user', JSON.stringify(session.user));

    // Signing in is the moment another device's reading positions and bookmarks become relevant.
    restoreProgressFromCloud();
    syncBookmarksFromCloud();

    showAuthAlert(action === 'signup' ? 'Account created & signed in!' : 'Success! Signed in.', 'success');
    resetCaptchaChallenge();
    setTimeout(() => {
      authModal.style.display = 'none';
      updateAuthBadge();
    }, 500);
  } catch (err) {
    showAuthAlert(err.message || 'Could not reach the sign-in service. Please try again.', 'error');
  } finally {
    if (!authCooldownTimer) setAuthBusy(false);
  }
}

authSignInBtn.addEventListener('click', () => submitAuth('signin'));

authSignUpBtn.addEventListener('click', () => submitAuth('signup'));

if (authResetBtn) {
  authResetBtn.addEventListener('click', () => submitAuth('reset'));
}

// --- PASSWORD RECOVERY: THE LANDING HALF ---
// The recovery email links to site_url with the session in the URL hash, e.g.
//   #access_token=…&refresh_token=…&type=recovery
// supabase-js consumes that hash on load, so the token is read here first and the hash is cleared
// before anything else can see it. The password change goes through /api/auth like every other
// auth action, so this flow inherits the same ip rate limit and the same Supabase error messages
// instead of calling GoTrue from the browser.
const recoveryModal = document.getElementById('recoveryModal');
const recoveryPass = document.getElementById('recoveryPass');
const recoverySubmitBtn = document.getElementById('recoverySubmitBtn');
const recoveryStatusAlert = document.getElementById('recoveryStatusAlert');
const recoveryHash = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
const recoveryAccessToken = recoveryHash.get('type') === 'recovery'
  ? (recoveryHash.get('access_token') || '')
  : '';

function showRecoveryAlert(msg, type = 'error') {
  recoveryStatusAlert.style.display = 'block';
  recoveryStatusAlert.textContent = msg;
  if (type === 'success') {
    recoveryStatusAlert.style.background = 'rgba(16, 185, 129, 0.15)';
    recoveryStatusAlert.style.color = '#10b981';
    recoveryStatusAlert.style.border = '1px solid rgba(16, 185, 129, 0.3)';
  } else {
    recoveryStatusAlert.style.background = 'rgba(239, 68, 68, 0.15)';
    recoveryStatusAlert.style.color = '#ef4444';
    recoveryStatusAlert.style.border = '1px solid rgba(239, 68, 68, 0.3)';
  }
}

async function submitNewPassword() {
  const password = recoveryPass.value;
  if (password.length < 6) {
    showRecoveryAlert('Passwords need at least 6 characters.', 'error');
    return;
  }

  recoverySubmitBtn.disabled = true;
  recoverySubmitBtn.textContent = 'Updating…';

  try {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update-password', accessToken: recoveryAccessToken, password })
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      showRecoveryAlert(
        data.error || 'Could not update your password. Please request a new reset link.',
        'error'
      );
      return;
    }

    // Hand the reader to the sign-in form rather than leaving the recovery session dangling.
    recoveryModal.style.display = 'none';
    authModal.style.display = 'flex';
    showAuthAlert('Password updated. Sign in with your new password.', 'success');
  } catch (err) {
    showRecoveryAlert('Could not reach the sign-in service. Please try again.', 'error');
  } finally {
    recoverySubmitBtn.disabled = false;
    recoverySubmitBtn.textContent = 'Update Password';
  }
}

if (recoveryAccessToken) {
  // Drop the token from the address bar so it is not left in history, a screenshot or a shared link.
  history.replaceState(null, '', window.location.pathname + window.location.search);
  recoveryModal.style.display = 'flex';
  recoverySubmitBtn.addEventListener('click', submitNewPassword);
  recoveryPass.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitNewPassword();
  });
  setTimeout(() => recoveryPass.focus(), 50);
} else if (recoveryHash.get('error')) {
  // Supabase sends an expired or already-used link back with error / error_description instead of a
  // token. Say so on the sign-in form, where "Forgot password?" is one tap away.
  authModal.style.display = 'flex';
  showAuthAlert('That reset link has expired or was already used. Request a new one.', 'error');
}

// --- AI SUMMARIZER (3-TIER RESILIENT PIPELINE) ---
const SUMMARY_STOPWORDS = new Set(("a about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its just me more most my no nor not of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your").split(' '));

function showToast(msg) {
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed; left:50%; bottom:calc(var(--safe-bottom) + 90px); transform:translateX(-50%); max-width:90vw; background:var(--panel-bg); color:var(--text-main); border:1px solid var(--border); padding:0.55rem 0.9rem; border-radius:8px; font-size:0.8rem; z-index:9999; box-shadow:0 4px 14px rgba(0,0,0,0.35);';
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4500);
}

function extractiveSummary(text, mode) {
  const sents = splitIntoSentences(text).map(s => s.trim()).filter(s => s.split(/\s+/).length >= 5);
  if (sents.length <= 4) return sents.join(' ');

  const tokenize = s => (s.toLowerCase().match(/[a-z][a-z'-]+/g) || []).filter(w => w.length > 2 && !SUMMARY_STOPWORDS.has(w));
  const freq = new Map();
  sents.forEach(s => tokenize(s).forEach(w => freq.set(w, (freq.get(w) || 0) + 1)));
  let maxF = 1;
  freq.forEach(v => { if (v > maxF) maxF = v; });

  const scored = sents.map((s, i) => {
    const toks = tokenize(s);
    if (!toks.length) return { s, i, score: 0 };
    let sum = 0;
    toks.forEach(w => { sum += freq.get(w) / maxF; });
    let score = sum / Math.sqrt(toks.length);
    if (s.split(/\s+/).length > 60) score *= 0.6;
    return { s, i, score };
  });

  let picked;
  if (mode === 'chapter') {
    const target = Math.min(10, Math.max(4, Math.round(sents.length * 0.2)));
    picked = scored.slice(0, 3).map(x => ({ ...x, score: x.score * 1.15 }))
      .concat(scored.slice(3))
      .sort((a, b) => b.score - a.score).slice(0, target);
  } else {
    const target = Math.min(14, Math.max(6, Math.round(sents.length / 40)));
    const bucketSize = Math.ceil(scored.length / target);
    picked = [];
    for (let b = 0; b < scored.length; b += bucketSize) {
      const bucket = scored.slice(b, b + bucketSize);
      picked.push(bucket.reduce((best, x) => (x.score > best.score ? x : best), bucket[0]));
    }
  }
  return picked.sort((a, b) => a.i - b.i).map(p => p.s).join(' ');
}

async function summarizeWithOpenAI(text, mode, apiKey) {
  const system = mode === 'chapter'
    ? "Summarize the given text faithfully in 1-3 short paragraphs of plain prose. No markdown, no bullet points, no headings."
    : "Write the key takeaways of the given text as 6-10 complete sentences of plain prose. No markdown, no bullet points, no headings.";
  const call = async (user) => {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `OpenAI error ${res.status}`);
    return (data.choices?.[0]?.message?.content || '').trim();
  };

  const CHUNK = 24000, MAX_CHUNKS = 8;
  const chunks = [];
  for (let i = 0; i < text.length && chunks.length < MAX_CHUNKS; i += CHUNK) chunks.push(text.slice(i, i + CHUNK));
  const parts = [];
  for (const c of chunks) parts.push(await call(c));
  let out = parts.length === 1 ? parts[0] : await call("Combine these partial summaries into one coherent summary:\n\n" + parts.join('\n\n'));
  return out.replace(/^[\s>*#•\-]+/gm, '').trim();
}

function getActiveChapterText() {
  const flatten = (items) => items.map(it => typeof it === 'string' ? it : (it?.caption || '')).join(' ');
  if (!originalBookPages && bookChapters && bookChapters.length > 1) {
    const ch = getCurrentChapter();
    const idx = bookChapters.indexOf(ch);
    const start = ch.pageIndex;
    const end = idx >= 0 && idx < bookChapters.length - 1 ? bookChapters[idx + 1].pageIndex : bookPages.length;
    return flatten(bookPages.slice(start, end).flat());
  }
  return flatten(bookPages[currentPage] || []);
}

summarizeBtn.addEventListener('click', async () => {
  if (originalBookPages) { showToast("Return to the book first (← Book) to summarize it again."); return; }
  const customOpenAi = localStorage.getItem('marginalia_byok_openai') || '';
  let notice = "Free offline summary: no key or account needed";
  if (customOpenAi) {
    notice = "Using your OpenAI key (AI summary)";
  } else {
    const token = await getFreshAuthToken();
    if (token && supabaseClient) {
      try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (session) {
          const { data: profile } = await supabaseClient.from('profiles').select('summary_credits_remaining, tier, pro_tier, pro_expires_at').eq('id', session.user.id).maybeSingle();
          if (profile) {
            const allowance = planAllowance(profile);
            if (allowance) {
              notice = `Plan: ${planTierName(profile.pro_tier, allowance.name)} (${profile.summary_credits_remaining ?? 0} AI summaries left)`;
            } else {
              const trials = profile.summary_credits_remaining ?? 3;
              notice = trials > 0 ? `Free trial: ${trials} AI summaries left` : "AI trial used up: offline summary active";
            }
          }
        }
      } catch (e) { }
    }
  }
  summaryTrialNotice.textContent = notice;
  summaryModal.style.display = 'flex';
});

async function triggerSummarize(mode) {
  summaryModal.style.display = 'none';
  stopAudio();

  const customOpenAi = localStorage.getItem('marginalia_byok_openai') || '';
  const flatten = (items) => items.map(it => typeof it === 'string' ? it : (it?.caption || '')).join(' ');
  const text = mode === 'chapter' ? getActiveChapterText() : flatten(bookPages.flat());
  if (!text.trim()) { alert("No text to summarize."); return; }

  contentPane.innerHTML = `<div style="text-align:center; padding:3rem; color:var(--text-muted); font-style:italic;">Generating summary...</div>`;

  let summary = '';
  let label = 'Summary';

  try {
    if (customOpenAi) {
      try {
        summary = await summarizeWithOpenAI(text, mode, customOpenAi);
        label = 'AI Summary';
      } catch (e) {
        console.warn('OpenAI summary fallback:', e);
        showToast(`OpenAI key error (${e.message}). Using offline summary.`);
      }
    } else {
      const token = await getFreshAuthToken();
      if (token) {
        try {
          const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
          const res = await fetch('/api/summarize', { method: 'POST', headers, body: JSON.stringify({ text, mode }) });
          const data = await res.json().catch(() => null);
          if (data && res.status === 401) {
            updateAuthBadge();
            authModal.style.display = 'flex';
            showAuthAlert(data.error || "Authentication error. Please sign in again.", "error");
            renderPage(currentPage);
            return;
          }
          if (data && (res.status === 402 || data.trialExhausted)) {
            profileSummaryCount.textContent = '0 Remaining';
            showToast("AI summaries used up. Using offline summary.");
          } else if (explainAiRefusal(res.status, data && data.error, retryAfterSeconds(res, data))) {
            // Verification gate or rate limit: already explained; the offline summary below still reads.
          } else if (res.ok && data && data.summary) {
            summary = data.summary;
            label = 'AI Summary';
            // the server tells us exactly how many are left after this one
            if (data.unlimited) {
              profileSummaryCount.textContent = 'Unlimited';
            } else if (typeof data.summaries_remaining === 'number') {
              profileSummaryCount.textContent = `${data.summaries_remaining} Remaining`;
              showToast(data.summaries_remaining === 0
                ? "That was your last AI summary."
                : `AI summaries left: ${data.summaries_remaining}`);
            }
          } else {
            const why = (data && data.error) ? data.error : `server error ${res.status}`;
            showToast(`AI summary unavailable (${String(why).slice(0, 80)}). Using offline summary.`);
          }
        } catch (e) {
          console.warn('Backend summary network fallback:', e);
        }
      }
    }

    if (!summary) {
      summary = extractiveSummary(text, mode);
      label = 'Offline Summary';
    }
    if (!summary.trim()) throw new Error("Couldn't find enough text to summarize.");

    if (!originalBookPages) {
      originalBookPages = bookPages;
      originalDocName = currentDocName;
      originalPage = currentPage;
    }

    const sents = splitIntoSentences(summary);
    bookPages = [];
    for (let i = 0; i < sents.length; i += 4) bookPages.push(sents.slice(i, i + 4));

    currentDocName = `${label}:${originalDocName}`;
    docTitle.textContent = currentDocName;
    summaryReturnSpan.style.display = 'inline-block';

    currentPage = 0;
    currentSentenceIdx = 0;
    renderPage(0);

    isPlaying = true;
    playCurrentSentence();
  } catch (e) {
    alert(e.message);
    renderPage(currentPage);
  }
}

sumChapterBtn.addEventListener('click', () => triggerSummarize('chapter'));
sumKeyTakeawaysBtn.addEventListener('click', () => triggerSummarize('key_takeaways'));

exitSummaryBtn.addEventListener('click', () => {
  if (originalBookPages) {
    stopAudio();
    bookPages = originalBookPages;
    currentDocName = originalDocName;
    currentPage = originalPage;
    originalBookPages = null;
    docTitle.textContent = currentDocName;
    summaryReturnSpan.style.display = 'none';
    refreshCurrentDocAnnotations().then(() => renderPage(currentPage));
  }
});

// --- CADENCE TIMELINE ENGINE ---
function computeWordTimeline(words, speed, totalDuration = null) {
  const effectiveCadenceFactor = learnedCadenceMultiplier * userManualCalibration;
  const timeline = [];
  let totalEst = 0;

  const basePerUnit = (88 * effectiveCadenceFactor) / speed;

  words.forEach((word) => {
    const clean = word.trim().toLowerCase();
    const stripped = clean.replace(/[^a-z0-9]/g, '');
    const vowelClusters = (stripped.match(/[aeiouy]+/g) || []).length;
    const syllables = Math.max(1, vowelClusters);

    const weight = Math.max(1.2, (stripped.length * 0.45) + (syllables * 0.75));
    let duration = Math.max(200 / speed, weight * basePerUnit);

    if (/[,;:\-]/.test(clean)) duration += (320 * effectiveCadenceFactor) / speed;
    else if (/[.!?]/.test(clean)) duration += (480 * effectiveCadenceFactor) / speed;

    timeline.push({ duration });
    totalEst += duration;
  });

  if (totalDuration && totalDuration > 0) {
    const ratio = (totalDuration * 1000) / totalEst;
    timeline.forEach(item => { item.duration *= ratio; });
    totalEst = totalDuration * 1000;
  }

  let accum = 0;
  return {
    timeline: timeline.map(item => {
      const start = accum;
      accum += item.duration;
      return { start: start / 1000, end: accum / 1000 };
    }),
    totalEstMs: totalEst
  };
}

// Native boundary events report a character offset into the sentence. Engines disagree on whether
// that offset is the start of the word being spoken or a position inside it (hyphenated words,
// quotes and numbers vary by platform), so the word index is resolved from the word run that
// contains the offset. Counting the words before the offset instead lands one word ahead whenever
// an engine reports a mid-word position.
function wordIndexAtChar(text, charIndex) {
  if (!text) return 0;
  const limit = Math.max(0, Math.min(charIndex || 0, text.length));
  const wordsBefore = text.slice(0, limit).split(/\s+/).filter(Boolean).length;
  const atWordStart = limit === 0 || /\s/.test(text[limit - 1]);
  return atWordStart ? wordsBefore : Math.max(0, wordsBefore - 1);
}

// Every native boundary is ground truth: the voice really did reach word N after this many seconds.
// Dividing that by the estimate's start for the same word measures how wrong the estimate is for
// this voice. The ratio is smoothed so the karaoke tracks the real pace - including how long the
// engine takes to actually start talking - instead of the generic syllable-weighted guess, and it
// keeps correcting within the sentence rather than only at the end of the next one.
function nextAnchorRatio(prevRatio, actualSec, expectedSec) {
  if (!(expectedSec > 0.05) || !(actualSec > 0)) return prevRatio;
  const sample = actualSec / expectedSec;
  if (sample < 0.4 || sample > 3) return prevRatio; // one bogus sample must not yank the timeline
  return prevRatio * 0.65 + sample * 0.35;
}

// Cadence is a property of the voice, so it is remembered per voice: a slow voice's learned
// multiplier would otherwise be handed to the next voice the reader picks.
const cadenceByVoice = new Map();
function voiceCadenceKey() {
  return `${activeEngine}|${voicePicker.value}`;
}

function cancelWordAnimation() {
  if (wordAnimFrameId) {
    cancelAnimationFrame(wordAnimFrameId);
    wordAnimFrameId = null;
  }
}

// --- DOM BUILDERS ---
function formatBionicWord(word) {
  if (!word) return '';
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const match = word.match(/^([^a-zA-Z0-9]*)([a-zA-Z0-9]+)([^a-zA-Z0-9]*)$/);
  if (!match) return esc(word);
  const [, prefix, core, suffix] = match;
  const fixLen = core.length <= 3 ? 1 : Math.ceil(core.length * 0.45);
  const fix = core.slice(0, fixLen);
  const rest = core.slice(fixLen);
  return `${esc(prefix)}<strong class="bionic-fix">${esc(fix)}</strong>${esc(rest)}${esc(suffix)}`;
}

function buildSentenceDOM(sentenceText, sIdx) {
  const span = document.createElement('span');
  span.className = 'sentence';
  span.id = `sent-${sIdx}`;

  // Apply user highlight if present for this sentence on current page
  const noteObj = currentDocAnnotations.find(a => a.page === currentPage && a.sentenceIdx === sIdx);
  if (noteObj) {
    span.classList.add(`highlight-${noteObj.color || 'amber'}`);
  }

  const words = sentenceText.split(/(\s+)/);
  let wordCount = 0;

  words.forEach(chunk => {
    if (chunk.trim().length > 0) {
      const wSpan = document.createElement('span');
      wSpan.className = 'word';
      wSpan.id = `w-${sIdx}-${wordCount}`;
      if (bionicMode === 'on') {
        wSpan.innerHTML = formatBionicWord(chunk);
      } else {
        wSpan.textContent = chunk;
      }
      span.appendChild(wSpan);
      wordCount++;
    } else {
      span.appendChild(document.createTextNode(chunk));
    }
  });

  if (noteObj && noteObj.noteText) {
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'margin-note-badge';
    badge.title = `Margin Note: ${noteObj.noteText}`;
    badge.innerHTML = `📝 <span style="font-weight:400;">${escapeHtml(noteObj.noteText.slice(0, 14))}${noteObj.noteText.length > 14 ? '…' : ''}</span>`;
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      openNoteModalForEdit(noteObj);
    });
    span.appendChild(badge);
  }

  span.addEventListener('click', () => {
    currentSentenceIdx = sIdx;
    if (isPlaying) {
      stopAudio();
      isPlaying = true;
      playCurrentSentence();
    } else {
      highlightActiveSentence();
    }
  });

  return span;
}

function buildDiagramDOM(imgObj, sIdx) {
  const fig = document.createElement('figure');
  fig.className = 'reader-diagram';
  fig.id = `sent-${sIdx}`;

  const img = document.createElement('img');
  img.src = imgObj.src;
  img.alt = imgObj.caption || "Diagram";
  img.loading = "lazy";

  const bar = document.createElement('div');
  bar.className = 'diagram-toolbar';

  const cap = document.createElement('span');
  cap.className = 'diagram-caption';
  cap.textContent = imgObj.caption || "Figure / Diagram";

  const expBtn = document.createElement('button');
  expBtn.className = 'btn-explain-diagram';
  expBtn.textContent = '✨ Explain';
  expBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    explainDiagram(imgObj.src, imgObj.caption);
  });

  bar.appendChild(cap);
  bar.appendChild(expBtn);
  fig.appendChild(img);
  fig.appendChild(bar);

  fig.addEventListener('click', () => {
    currentSentenceIdx = sIdx;
    highlightActiveSentence();
  });

  return fig;
}

function renderPage(idx) {
  contentPane.innerHTML = '';
  document.body.classList.toggle('pacing-ruler-active', pacingRulerMode === 'active');
  const items = bookPages[idx] || [];

  items.forEach((item, sIdx) => {
    if (typeof item === 'object' && item.type === 'image') {
      contentPane.appendChild(buildDiagramDOM(item, sIdx));
    } else {
      contentPane.appendChild(buildSentenceDOM(item, sIdx));
    }
  });

  pageIndicatorText.textContent = `Page ${idx + 1} of ${bookPages.length}`;
  const currentCh = getCurrentChapter();
  chapterIndicatorText.textContent = currentCh.title;

  prevPageBtn.disabled = idx === 0;
  nextPageBtn.disabled = idx >= bookPages.length - 1;
  highlightActiveSentence();
  updateBookProgressInDB(currentDocName, currentPage, currentSentenceIdx);
  updateMediaMetadata();
  updateDockProgress();
}

function highlightActiveSentence() {
  lastHighlightedWord = -1; // the sentence DOM is about to be (re)built
  document.querySelectorAll('.sentence').forEach(el => el.classList.remove('active-sentence'));
  document.querySelectorAll('.reader-diagram').forEach(el => el.classList.remove('active-diagram'));
  document.querySelectorAll('.word').forEach(el => el.classList.remove('active-word'));

  const target = document.getElementById(`sent-${currentSentenceIdx}`);
  if (!target) return;

  if (highlightMode !== 'none') {
    if (target.classList.contains('reader-diagram')) {
      target.classList.add('active-diagram');
    } else {
      target.classList.add('active-sentence');
    }
  }

  // Keep the sentence being read in view (even with highlighting off). Scroll only the reading
  // area, and centre within the part that is actually visible: below the header, above the player bar.
  const scroller = document.querySelector('main');
  if (!scroller) return;
  const tr = target.getBoundingClientRect();
  const mr = scroller.getBoundingClientRect();
  const bar = document.querySelector('.mobile-player-bar');
  const visibleTop = mr.top;
  const visibleBottom = bar ? Math.min(mr.bottom, bar.getBoundingClientRect().top) : mr.bottom;
  const visibleCenter = visibleTop + (visibleBottom - visibleTop) / 2;
  const delta = (tr.top + tr.height / 2) - visibleCenter;
  if (Math.abs(delta) > 4) {
    scroller.scrollTo({ top: scroller.scrollTop + delta, behavior: 'smooth' });
  }
}

function highlightActiveWord(wIdx) {
  if (highlightMode !== 'word') {
    document.querySelectorAll('.word.active-word').forEach(el => el.classList.remove('active-word'));
    lastHighlightedWord = -1;
    return;
  }
  // The frame loop runs ~60x a second, and the sentence can be hundreds of words long
  if (wIdx === lastHighlightedWord) return;
  lastHighlightedWord = wIdx;
  document.querySelectorAll(`#sent-${currentSentenceIdx} .word`).forEach((el, index) => {
    if (index === wIdx) el.classList.add('active-word');
    else el.classList.remove('active-word');
  });
}

// --- PLAYBACK ENGINE ---
async function playCurrentSentence() {
  // Sleep timer: stop exactly at a sentence boundary (stays accurate even when a
  // background tab throttles the countdown interval)
  if (sleepTimerMode !== 'off' &&
    (sleepTimerExpired() || (sleepTimerMode === 'chapter' && currentPage >= sleepTimerChapterEnd))) {
    fireSleepTimerEnd();
    return;
  }

  const pageItems = bookPages[currentPage];
  if (!pageItems || pageItems.length === 0) return;

  if (currentSentenceIdx >= pageItems.length) {
    if (autoFlipCheck.checked && currentPage < bookPages.length - 1) {
      currentPage++;
      currentSentenceIdx = 0;
      renderPage(currentPage);
      playCurrentSentence();
    } else {
      stopAudio();
    }
    return;
  }

  highlightActiveSentence();
  mainPlayToggle.textContent = '⏸';
  syncMediaSessionState(true);

  const currentItem = pageItems[currentSentenceIdx];

  if (typeof currentItem === 'object' && currentItem.type === 'image') {
    if (currentItem.caption && currentItem.caption.trim().length > 3) {
      const captionText = `Figure: ${currentItem.caption}`;
      if (activeEngine === 'browser') speakBrowser(captionText);
      else await speakServerless(captionText);
    } else {
      currentSentenceIdx++;
      playCurrentSentence();
    }
    return;
  }

  if (activeEngine === 'browser') {
    speakBrowser(currentItem);
  } else {
    await speakServerless(currentItem);
  }
}

function speakBrowser(text) {
  const wasBusy = browserSpeech.speaking || browserSpeech.pending;
  browserSpeech.cancel();
  cancelWordAnimation();

  const utter = new SpeechSynthesisUtterance(text);
  currentUtterance = utter;
  utter.rate = playbackSpeed;
  utter.volume = playbackVolume;
  applyChosenVoice(utter);

  // The cadence belongs to the voice: restore what this voice has already taught us about its pace
  learnedCadenceMultiplier = cadenceByVoice.get(voiceCadenceKey()) || learnedCadenceMultiplier;
  const wordsArr = text.trim().split(/\s+/).filter(w => w.length > 0);
  const computed = computeWordTimeline(wordsArr, playbackSpeed);
  const timeline = computed.timeline;
  estimatedSentenceDurationMs = computed.totalEstMs;

  // Divisor for elapsed time: 1 until native boundaries prove the estimate is off, then the
  // smoothed actual/estimated ratio for this voice (see nextAnchorRatio)
  let anchorRatio = 1;
  let utterStartedAt = 0;

  utter.onboundary = (e) => {
    if (currentUtterance !== utter || !e || e.name !== 'word' || !utterStartedAt) return;
    const idx = wordIndexAtChar(text, e.charIndex);
    if (timeline[idx]) {
      anchorRatio = nextAnchorRatio(anchorRatio,
        (performance.now() - utterStartedAt) / 1000,
        timeline[idx].start);
    }
    if (highlightMode === 'word') highlightActiveWord(idx);
  };

  utter.onstart = () => {
    if (currentUtterance !== utter) return;
    utterStartedAt = sentenceSpeechStartTime = performance.now();
    anchorRatio = 1;
    if (highlightMode !== 'word') return;
    highlightActiveWord(0);

    // The loop is never handed over to the boundary events: platforms that stop emitting them
    // mid-sentence (Android does, on several voices) would freeze the highlight where they stopped.
    // When boundaries do arrive they steer it instead, via anchorRatio.
    function renderFrame() {
      if (!isPlaying || highlightMode !== 'word' || currentUtterance !== utter) return;
      const wallMs = performance.now() - utterStartedAt;
      const elapsedSec = wallMs / 1000 / anchorRatio;

      let activeIdx = 0;
      for (let i = 0; i < timeline.length; i++) {
        if (elapsedSec >= timeline[i].start) {
          activeIdx = i;
        } else {
          break;
        }
      }
      highlightActiveWord(activeIdx);

      // Keep animating for as long as this (possibly slower) voice is still expected to be speaking
      if (wallMs < estimatedSentenceDurationMs * Math.max(1, anchorRatio) + 1500) {
        wordAnimFrameId = requestAnimationFrame(renderFrame);
      }
    }

    wordAnimFrameId = requestAnimationFrame(renderFrame);
  };

  utter.onend = () => {
    // Ignore callbacks from an utterance that was cancelled/replaced (Safari fires these late)
    if (currentUtterance !== utter) return;
    cancelWordAnimation();

    if (utterStartedAt && estimatedSentenceDurationMs > 400) {
      const actualElapsedMs = performance.now() - utterStartedAt;
      const observedRatio = actualElapsedMs / estimatedSentenceDurationMs;
      if (observedRatio >= 0.65 && observedRatio <= 1.6) {
        learnedCadenceMultiplier = (learnedCadenceMultiplier * 0.6) + (observedRatio * 0.4);
        cadenceByVoice.set(voiceCadenceKey(), learnedCadenceMultiplier);
      }
    }

    if (!isPlaying) return;
    currentSentenceIdx++;
    playCurrentSentence();
  };

  utter.onerror = (e) => {
    if (currentUtterance !== utter) return;
    // cancel() reports 'interrupted'/'canceled' on iOS; that is not a real failure
    if (e && (e.error === 'interrupted' || e.error === 'canceled')) return;
    stopAudio();
  };

  // iOS drops a speak() issued immediately after cancel(); wait a beat only when we interrupted something
  const go = () => { if (currentUtterance === utter) browserSpeech.speak(utter); };
  if (wasBusy) setTimeout(go, 80);
  else go();
}

// --- NEURAL AUDIO FETCH + PRELOAD ---
// The next sentences are fetched while the current one plays, so playback is gapless and the
// chain keeps running on the lock screen without waiting on the network between sentences.
const audioInflight = new Map();
const PRELOAD_AHEAD = 3;
const AUDIO_CACHE_MAX = 12;

function neuralCacheKey(text) {
  // speed is applied on the phone (playbackRate), so cached audio is reusable at any speed
  return `${activeEngine}_${voicePicker.value}_${text}`;
}

function releaseAudioSrc(src) {
  if (src && src.startsWith('blob:')) { try { URL.revokeObjectURL(src); } catch (e) { } }
  if (src && typeof synthPcmCache !== 'undefined') { try { synthPcmCache.delete(src); } catch (e) { } }
}

function cacheAudio(key, src) {
  audioPreloadCache.set(key, { src });
  while (audioPreloadCache.size > AUDIO_CACHE_MAX) {
    const oldestKey = audioPreloadCache.keys().next().value;
    releaseAudioSrc(audioPreloadCache.get(oldestKey)?.src);
    audioPreloadCache.delete(oldestKey);
  }
}

function clearAudioCache() {
  audioPreloadCache.forEach(v => releaseAudioSrc(v.src));
  audioPreloadCache.clear();
}

// Fallback for a server that still answers with base64 JSON
function base64ToBlobUrl(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
}

// --- STUDIO (ON-DEVICE) WEBASSEMBLY TTS PIPELINE ----------------------------
const modelSampleRate = 22050; // Exact native WASM model sample rate (Piper/VITS standard)
const synthPcmCache = new Map();
let wasmAudioCtx = null;
let wasmGainNode = null;
let wasmScheduledEndTime = 0;
let wasmActiveSourceNode = null;
let wasmScheduledSentenceIdx = -1;
let wasmScheduledToken = 0;
let wasmChunkStartTime = 0;

function getWasmAudioCtx() {
  if (typeof window === 'undefined') return null;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!wasmAudioCtx) {
    wasmAudioCtx = new AudioCtx();
    wasmGainNode = wasmAudioCtx.createGain();
    wasmGainNode.gain.value = playbackVolume;
    wasmGainNode.connect(wasmAudioCtx.destination);
  }
  if (wasmAudioCtx.state === 'suspended') {
    wasmAudioCtx.resume().catch(() => {});
  }
  return wasmAudioCtx;
}

function createWasmAudioBuffer(audioCtx, pcmData, rate = modelSampleRate) {
  if (!audioCtx || !pcmData) return null;
  // Match Native Model Sample Rate: ensure AudioContext.createBuffer uses modelSampleRate rather than audioCtx.sampleRate
  const audioBuffer = audioCtx.createBuffer(1, pcmData.length, rate);
  audioBuffer.getChannelData(0).set(pcmData);
  return audioBuffer;
}

/**
 * Synthesizes speech locally in-browser to a PCM 16-bit WAV Blob URL.
 * Enables zero-cost, offline, lockscreen-compatible audio via Web Audio API and <audio id="neuralAudio">.
 * Lightweight parametric formant synthesizer with letter-group acoustic modeling.
 */
async function synthOnDeviceSpeech(text, voiceId = 'heart') {
  const modelSampleRate = 22050; // Native model output sample rate
  const sampleRate = modelSampleRate;

  // Voice acoustic profiles: fundamental pitch F0, vocal tract formant scaling, intonation, and timing
  const profiles = {
    heart:   { baseFreq: 215, formantScale: 1.15, vibratoRate: 5.2, vibratoDepth: 1.8, durScale: 1.00, gain: 0.38 },
    michael: { baseFreq: 118, formantScale: 0.95, vibratoRate: 4.5, vibratoDepth: 1.2, durScale: 1.08, gain: 0.42 },
    emma:    { baseFreq: 195, formantScale: 1.10, vibratoRate: 5.0, vibratoDepth: 1.5, durScale: 0.95, gain: 0.38 }
  };
  const prof = profiles[voiceId] || profiles.heart;

  function charToAcoustic(ch, nextCh = '') {
    const pair = ch + nextCh;
    if (/^(th|sh|ch|ph)/.test(pair)) return { type: 'fricative', freq: 3200, dur: 0.08, skip: 2 };
    if (/^(ee|ea)/.test(pair)) return { type: 'vowel', f1: 280, f2: 2250, dur: 0.12, skip: 2 };
    if (/^(oo|ou)/.test(pair)) return { type: 'vowel', f1: 320, f2: 900,  dur: 0.12, skip: 2 };
    if (/^(ai|ay)/.test(pair)) return { type: 'vowel', f1: 480, f2: 1950, dur: 0.12, skip: 2 };
    if (/^(ar|er|or|ur|ir)/.test(pair)) return { type: 'vowel', f1: 490, f2: 1350, dur: 0.12, skip: 2 };

    switch (ch) {
      case 'a': return { type: 'vowel', f1: 700, f2: 1400, dur: 0.11, skip: 1 };
      case 'e': return { type: 'vowel', f1: 530, f2: 1800, dur: 0.09, skip: 1 };
      case 'i': return { type: 'vowel', f1: 350, f2: 2100, dur: 0.09, skip: 1 };
      case 'o': return { type: 'vowel', f1: 480, f2: 950,  dur: 0.11, skip: 1 };
      case 'u': return { type: 'vowel', f1: 350, f2: 900,  dur: 0.09, skip: 1 };
      case 'y': return { type: 'vowel', f1: 320, f2: 2000, dur: 0.09, skip: 1 };
      case 's': case 'z': case 'x': return { type: 'fricative', freq: 5500, dur: 0.07, skip: 1 };
      case 'f': case 'v': return { type: 'fricative', freq: 3000, dur: 0.06, skip: 1 };
      case 'h': return { type: 'fricative', freq: 1800, dur: 0.05, skip: 1 };
      case 'p': case 'b': return { type: 'plosive', freq: 1000, gap: 0.02, dur: 0.015, skip: 1 };
      case 't': case 'd': return { type: 'plosive', freq: 4500, gap: 0.02, dur: 0.015, skip: 1 };
      case 'k': case 'g': case 'q': return { type: 'plosive', freq: 2200, gap: 0.02, dur: 0.018, skip: 1 };
      case 'm': case 'n': return { type: 'nasal', f1: 260, f2: 1200, dur: 0.07, skip: 1 };
      case 'l': case 'r': case 'w': return { type: 'liquid', f1: 380, f2: 1200, dur: 0.07, skip: 1 };
      default: return { type: 'vowel', f1: 500, f2: 1500, dur: 0.07, skip: 1 };
    }
  }

  // Preserve natural punctuation (. , ? !) for prosody; trim excessive whitespace without stripping punctuation
  const trimmedText = String(text || '').trim().replace(/\s+/g, ' ');
  const tokens = trimmedText.match(/\S+/g) || ['...'];
  const segments = [];

  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t];
    const isQuestion = token.includes('?');
    const isPeriod = /[.!?]/.test(token);
    const isComma = /[,;:]/.test(token);
    const clean = token.toLowerCase().replace(/[^a-z]/g, '');

    const units = [];
    for (let i = 0; i < clean.length;) {
      const u = charToAcoustic(clean[i], clean[i + 1] || '');
      units.push(u);
      i += u.skip || 1;
    }
    if (units.length === 0) units.push({ type: 'vowel', f1: 500, f2: 1500, dur: 0.09 });

    segments.push({ type: 'word', units, isQuestion, isPeriod });
    if (isPeriod) segments.push({ type: 'pause', dur: 0.28 });
    else if (isComma) segments.push({ type: 'pause', dur: 0.14 });
    else if (t < tokens.length - 1) segments.push({ type: 'pause', dur: 0.05 });
  }

  function filterRes(f, bw, x, state) {
    const r = Math.exp(-Math.PI * bw / sampleRate);
    const theta = 2 * Math.PI * f / sampleRate;
    const a1 = 2 * r * Math.cos(theta);
    const a2 = -r * r;
    const b0 = 1 - r;
    const out = b0 * x + a1 * state[0] + a2 * state[1];
    state[1] = state[0];
    state[0] = out;
    return out;
  }

  let nX1 = 0, nX2 = 0, nY1 = 0, nY2 = 0;
  function filterNoise(f, x) {
    const w0 = 2 * Math.PI * f / sampleRate;
    const alpha = Math.sin(w0) / 4;
    const a0 = 1 + alpha;
    const out = (alpha * (x - nX2) + 2 * Math.cos(w0) * nY1 - (1 - alpha) * nY2) / a0;
    nX2 = nX1; nX1 = x; nY2 = nY1; nY1 = out;
    return out;
  }

  const rawSamples = [];

  // Add 40-60ms (50ms) of zero-padded silence at start so first phoneme does not clip
  const padSamples = Math.round(sampleRate * 0.05);
  for (let i = 0; i < padSamples; i++) rawSamples.push(0);

  let glottalPhase = 0;
  let tGlobal = 0;
  const res1 = [0, 0];
  const res2 = [0, 0];

  for (const seg of segments) {
    if (seg.type === 'pause') {
      const pauseCount = Math.floor(seg.dur * sampleRate);
      for (let i = 0; i < pauseCount; i++) rawSamples.push(0);
      continue;
    }

    for (const u of seg.units) {
      if (u.gap) {
        const gapCount = Math.floor(u.gap * prof.durScale * sampleRate);
        for (let i = 0; i < gapCount; i++) rawSamples.push(0);
      }

      // Normal 1.0x synthesis: playback speed is applied in ONE place only (via playbackRate)
      const pCount = Math.floor(u.dur * prof.durScale * sampleRate);
      const curF1 = (u.f1 || 500) * prof.formantScale;
      const curF2 = (u.f2 || 1500) * prof.formantScale;

      for (let i = 0; i < pCount; i++) {
        const prog = i / pCount;

        // Pitch with prosody intonation and vibrato
        let pitch = prof.baseFreq;
        if (seg.isQuestion) pitch *= 1.0 + 0.18 * prog;
        else if (seg.isPeriod) pitch *= 1.0 - 0.14 * prog;
        pitch += Math.sin(2 * Math.PI * prof.vibratoRate * tGlobal) * prof.vibratoDepth;

        // Glottal excitation
        glottalPhase += pitch / sampleRate;
        if (glottalPhase >= 1) glottalPhase -= 1;
        const glottalPulse = glottalPhase < 0.4 ? Math.sin(Math.PI * glottalPhase / 0.4) : 0;

        let sampleVal = 0;
        if (u.type === 'vowel' || u.type === 'liquid') {
          const v1 = filterRes(curF1, 80, glottalPulse, res1);
          const v2 = filterRes(curF2, 110, glottalPulse, res2);
          sampleVal = v1 * 1.0 + v2 * 0.5;
        } else if (u.type === 'nasal') {
          const v1 = filterRes(curF1, 60, glottalPulse, res1);
          const v2 = filterRes(curF2, 150, glottalPulse, res2);
          sampleVal = v1 * 1.2 + v2 * 0.15;
        } else {
          const rawNoise = Math.random() * 2 - 1;
          const filtered = filterNoise(u.freq || 3500, rawNoise);
          sampleVal = filtered * 0.45;
        }

        let env = 1.0;
        if (prog < 0.12) env = prog / 0.12;
        else if (prog > 0.85) env = (1.0 - prog) / 0.15;

        rawSamples.push(sampleVal * env * prof.gain);
        tGlobal += 1 / sampleRate;
      }
    }
  }

  // Add 40-60ms (50ms) of zero-padded silence at end so last phoneme does not clip
  for (let i = 0; i < padSamples; i++) rawSamples.push(0);

  // Normalize and clamp Float32Array samples to [-1.0, 1.0] to prevent digital clipping
  const totalSamples = rawSamples.length;
  const pcmData = new Float32Array(totalSamples);
  let maxAmp = 0;
  for (let i = 0; i < totalSamples; i++) {
    const a = Math.abs(rawSamples[i]);
    if (a > maxAmp) maxAmp = a;
  }
  const normFactor = maxAmp > 1.0 ? 0.98 / maxAmp : 1.0;
  for (let i = 0; i < totalSamples; i++) {
    pcmData[i] = Math.max(-1.0, Math.min(1.0, rawSamples[i] * normFactor));
  }

  const buffer = new ArrayBuffer(44 + totalSamples * 2);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + totalSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, modelSampleRate, true);
  view.setUint32(28, modelSampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, totalSamples * 2, true);

  for (let i = 0; i < totalSamples; i++) {
    const s = pcmData[i];
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }

  let srcUrl = '';
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const blob = new Blob([buffer], { type: 'audio/wav' });
    srcUrl = URL.createObjectURL(blob);
  } else if (typeof Buffer !== 'undefined') {
    srcUrl = 'data:audio/wav;base64,' + Buffer.from(buffer).toString('base64');
  }

  // Stash pcmData for instant synchronous Web Audio buffer creation
  if (srcUrl && typeof srcUrl === 'string') {
    try { synthPcmCache.set(srcUrl, pcmData); } catch (e) {}
  }

  return srcUrl;
}

async function getNeuralAudioSrc(text) {
  const key = neuralCacheKey(text);
  const hit = audioPreloadCache.get(key);
  if (hit && hit.src) return hit.src;
  if (audioInflight.has(key)) return audioInflight.get(key);

  const engine = activeEngine;
  const voiceId = (engine === 'wasm' && (!voicePicker.value || !['heart', 'michael', 'emma'].includes(voicePicker.value)))
    ? 'heart'
    : voicePicker.value;
  const speed = 1;

  // 1. Check persistent IndexedDB audio cache FIRST (cache-first playback)
  const cacheKey = await computeAudioCacheKey(engine, voiceId, speed, text);
  try {
    const cachedBlob = await getAudioFromIdbCache(cacheKey);
    if (cachedBlob && cachedBlob.size > 0) {
      const src = URL.createObjectURL(cachedBlob);
      cacheAudio(key, src);
      return src;
    }
  } catch (err) {
    console.warn('IDB audio cache lookup error:', err);
  }

  // A 429 countdown is running: do not ask again until it ends, or the server's lockout just gets
  // longer. This mirrors the auth form, which disables its buttons for the same reason.
  // On-device synthesis (wasm) runs locally with zero API calls and is never rate-limited.
  if (activeEngine !== 'wasm' && readerLockedUntil > Date.now()) {
    const left = Math.ceil((readerLockedUntil - Date.now()) / 1000);
    const err = new Error(`AI reading is paused — try again in ${left}s.`);
    err.status = 429;
    err.code = 'RATE_LIMITED';
    err.retryAfter = left;
    throw err;
  }

  if (engine === 'wasm') {
    const job = (async () => {
      const src = await synthOnDeviceSpeech(text, voiceId);
      try {
        if (src.startsWith('blob:') || src.startsWith('data:')) {
          const resp = await fetch(src);
          const b = await resp.blob();
          saveAudioToIdbCache(cacheKey, b).catch(() => {});
        }
      } catch {}
      cacheAudio(key, src);
      return src;
    })();
    audioInflight.set(key, job);
    try {
      return await job;
    } finally {
      audioInflight.delete(key);
    }
  }

  const job = (async () => {
    const customOpenAi = localStorage.getItem('marginalia_byok_openai') || '';
    const customEleven = localStorage.getItem('marginalia_byok_eleven') || '';
    const token = await getFreshAuthToken();

    // Ask for the raw mp3: about a third smaller than base64 JSON and no decoding step
    const headers = { 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (customOpenAi) headers['x-custom-openai-key'] = customOpenAi;
    if (customEleven) headers['x-custom-elevenlabs-key'] = customEleven;
    if (SUPABASE_PROJECT_URL && !SUPABASE_PROJECT_URL.includes("your-project")) {
      headers['x-supabase-url'] = SUPABASE_PROJECT_URL;
      headers['x-supabase-key'] = SUPABASE_ANON_KEY;
    }

    const res = await fetch('/api/tts', {
      method: 'POST',
      headers,
      body: JSON.stringify({ text, voiceId, engine, speed })
    });
    let src = '';
    let remaining = res.headers.get('X-Remaining-Chars');

    if (res.ok && (res.headers.get('Content-Type') || '').includes('audio/')) {
      const blob = await res.blob();
      if (!blob.size) throw new Error("The voice server returned no audio.");
      saveAudioToIdbCache(cacheKey, blob).catch(() => {});
      src = URL.createObjectURL(blob);
    } else {
      // errors (and older servers) answer with JSON
      const data = await res.json().catch(() => ({}));

      if (res.status === 401) {
        const err = new Error(data.error || "Session expired. Please sign in again.");
        err.status = 401;
        throw err;
      }
      if (!res.ok) {
        // Carry the status and the server's wait so the play path can answer 403/429 properly.
        const err = new Error(data.error || `Error ${res.status}`);
        err.status = res.status;
        err.code = data.error || '';
        err.retryAfter = retryAfterSeconds(res, data);
        throw err;
      }

      if (data.audio_base64) {
        const bin = atob(data.audio_base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const b = new Blob([bytes], { type: 'audio/mpeg' });
        saveAudioToIdbCache(cacheKey, b).catch(() => {});
        src = URL.createObjectURL(b);
      } else {
        src = data.audioUrl || '';
      }
      if (!src) throw new Error("The voice server returned no audio.");
      remaining = data.remaining_chars;
    }

    if (remaining !== null && remaining !== undefined && remaining !== '') {
      updateAuthBadge(Number.isNaN(Number(remaining)) ? remaining : Number(remaining));
    }
    cacheAudio(key, src);
    return src;
  })();

  audioInflight.set(key, job);
  try { return await job; } finally { audioInflight.delete(key); }
}

// --- CHAPTER & SUMMARY AUDIO EXPORT (.mp3) ---
async function canExportAudio() {
  const customOpenAi = localStorage.getItem('marginalia_byok_openai') || '';
  const customEleven = localStorage.getItem('marginalia_byok_eleven') || '';
  if (customOpenAi || customEleven) return true;

  if (typeof supabaseClient === 'undefined' || !supabaseClient) return false;
  const session = await getSessionSafe();
  if (!session || !session.user) return false;

  const { data: profile } = await supabaseClient
    .from('profiles')
    .select('tier, pro_tier, pro_expires_at')
    .eq('id', session.user.id)
    .maybeSingle();

  if (profile && isProActiveClient(profile)) {
    const tier = profile.pro_tier;
    if (tier === 'pro_ng' || tier === 'pro_intl' || tier === 'student' || tier === 'studio' || profile.tier === 'pro') {
      return true;
    }
  }
  return false;
}

function getActiveChapterSentences() {
  if (!bookPages || bookPages.length === 0) return [];
  const currentCh = getCurrentChapter();
  const currentIdx = bookChapters.findIndex((c) => c.pageIndex === currentCh.pageIndex);
  const startPage = currentCh.pageIndex;
  const endPage = (currentIdx >= 0 && currentIdx + 1 < bookChapters.length)
    ? bookChapters[currentIdx + 1].pageIndex
    : bookPages.length;

  const pages = bookPages.slice(startPage, endPage);
  return pages.flatMap((p) => (Array.isArray(p) ? p : [p]))
    .map((b) => (typeof b === 'string' ? b : (b.text || b.caption || '')))
    .filter((s) => s && s.trim());
}

async function exportAudioForSentences(sentences, titlePrefix) {
  if (!sentences || sentences.length === 0) {
    alert("No sentences found to export.");
    return;
  }

  const allowed = await canExportAudio();
  if (!allowed) {
    openPaywall();
    return;
  }

  const exportModal = document.getElementById('audioExportModal');
  const statusText = document.getElementById('audioExportStatusText');
  const progressBar = document.getElementById('audioExportProgressBar');
  const cancelBtn = document.getElementById('audioExportCancelBtn');

  if (exportModal) exportModal.style.display = 'flex';
  if (progressBar) progressBar.style.width = '0%';

  let cancelled = false;
  const onCancel = () => { cancelled = true; };
  if (cancelBtn) cancelBtn.onclick = onCancel;

  const engine = activeEngine;
  const voiceId = (engine === 'wasm' && (!voicePicker.value || !['heart', 'michael', 'emma'].includes(voicePicker.value)))
    ? 'heart'
    : voicePicker.value;
  const speed = 1;

  const chunks = [];
  const total = sentences.length;

  try {
    for (let i = 0; i < total; i++) {
      if (cancelled) break;
      const s = sentences[i];
      if (statusText) statusText.textContent = `Processing sentence ${i + 1} of ${total}...`;
      if (progressBar) progressBar.style.width = `${Math.round(((i) / total) * 100)}%`;

      const cacheKey = await computeAudioCacheKey(engine, voiceId, speed, s);
      let blob = await getAudioFromIdbCache(cacheKey);

      if (!blob) {
        const src = await getNeuralAudioSrc(s);
        if (src.startsWith('blob:') || src.startsWith('data:')) {
          const resp = await fetch(src);
          blob = await resp.blob();
        }
      }

      if (blob) chunks.push(blob);
    }

    if (cancelled) {
      if (statusText) statusText.textContent = "Export cancelled.";
      setTimeout(() => { if (exportModal) exportModal.style.display = 'none'; }, 800);
      return;
    }

    if (chunks.length === 0) {
      throw new Error("Could not synthesize audio chunks.");
    }

    if (statusText) statusText.textContent = "Stitching audio file...";
    if (progressBar) progressBar.style.width = '100%';

    const mime = chunks[0]?.type || 'audio/mpeg';
    const finalBlob = new Blob(chunks, { type: mime });

    const downloadUrl = URL.createObjectURL(finalBlob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    const safeTitle = (titlePrefix || 'export').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const ext = mime.includes('wav') ? '.wav' : '.mp3';
    a.download = `${safeTitle}${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 5000);

    if (statusText) statusText.textContent = "Export complete!";
    setTimeout(() => {
      if (exportModal) exportModal.style.display = 'none';
    }, 800);
  } catch (err) {
    if (statusText) statusText.textContent = `Error: ${err.message}`;
    alert(`Export failed: ${err.message}`);
  } finally {
    if (cancelBtn) cancelBtn.onclick = null;
  }
}

const exportChapterMp3Btn = document.getElementById('exportChapterMp3Btn');
if (exportChapterMp3Btn) {
  exportChapterMp3Btn.addEventListener('click', async () => {
    const sents = getActiveChapterSentences();
    const currentCh = getCurrentChapter();
    const chIdx = bookChapters.findIndex((c) => c.pageIndex === currentCh.pageIndex);
    const chNum = chIdx >= 0 ? chIdx + 1 : 1;
    const prefix = `${currentDocName || 'book'}-chapter-${chNum}`;
    await exportAudioForSentences(sents, prefix);
  });
}

const exportSummaryMp3Btn = document.getElementById('exportSummaryMp3Btn');
if (exportSummaryMp3Btn) {
  exportSummaryMp3Btn.addEventListener('click', async () => {
    let sents = [];
    if (originalBookPages && bookPages && bookPages.length > 0) {
      sents = bookPages.flatMap((p) => (Array.isArray(p) ? p : [p]))
        .map((b) => (typeof b === 'string' ? b : (b.text || b.caption || '')))
        .filter((s) => s && s.trim());
    } else {
      const activeCh = getCurrentChapter();
      const pages = bookPages.slice(activeCh.pageIndex, Math.min(bookPages.length, activeCh.pageIndex + 5));
      sents = pages.flatMap((p) => (Array.isArray(p) ? p : [p]))
        .map((b) => (typeof b === 'string' ? b : (b.text || b.caption || '')))
        .filter((s) => s && s.trim());
    }
    const prefix = `${currentDocName || 'summary'}-audio`;
    await exportAudioForSentences(sents, prefix);
  });
}

// The next few things that will be read aloud (follows auto page-flip like playback does)
function upcomingNeuralTexts(limit) {
  const out = [];
  let page = currentPage;
  let idx = currentSentenceIdx + 1;
  while (out.length < limit) {
    const items = bookPages[page];
    if (!items) break;
    if (idx >= items.length) {
      if (autoFlipCheck.checked && page < bookPages.length - 1) { page++; idx = 0; continue; }
      break;
    }
    const it = items[idx++];
    if (typeof it === 'string') out.push(it);
    else if (it && it.type === 'image' && it.caption && it.caption.trim().length > 3) out.push(`Figure: ${it.caption}`);
  }
  return out;
}

function preloadUpcoming(myToken) {
  if (activeEngine === 'browser') return;
  upcomingNeuralTexts(PRELOAD_AHEAD).forEach(t => {
    if (myToken !== speakToken) return; // user paused/skipped
    if (audioPreloadCache.has(neuralCacheKey(t))) return;
    getNeuralAudioSrc(t).catch(() => { }); // best effort; the real play path reports errors
  });
}

async function speakServerless(text, opts = {}) {
  const standalone = Boolean(opts.standalone);
  const myToken = ++speakToken;
  const stale = () => myToken !== speakToken || (!standalone && !isPlaying);

  try {
    // Preloaded sentence: play immediately, no auth/network round-trip (important when locked)
    let audioSrc = audioPreloadCache.get(neuralCacheKey(text))?.src;

    if (!audioSrc) {
      // Cloud TTS requires authentication or BYOK credentials; on-device wasm speech runs completely offline
      if (activeEngine !== 'wasm') {
        const customOpenAi = localStorage.getItem('marginalia_byok_openai') || '';
        const customEleven = localStorage.getItem('marginalia_byok_eleven') || '';
        const token = await getFreshAuthToken();

        if (!token && !customOpenAi && !customEleven) {
          stopAudio();
          showAuthAlert("Please sign in or enter your custom API key in Options.", "error");
          authModal.style.display = 'flex';
          return;
        }
      }

      preloadStatus.textContent = activeEngine === 'wasm' ? "Synthesizing..." : "Connecting...";
      try {
        const pending = getNeuralAudioSrc(text);    // start this sentence first...
        if (!standalone) preloadUpcoming(myToken);  // ...and right away start the next ones too
        audioSrc = await pending;
      } catch (e) {
        if (e && e.status === 401) {
          updateAuthBadge();
          authModal.style.display = 'flex';
          showAuthAlert(e.message, "error");
          stopAudio();
          return;
        }
        throw e;
      }
    }

    preloadStatus.textContent = "Ready";

    // User hit pause / skipped / switched voice while the audio was downloading
    if (stale()) return;

    // --- Studio (On-Device) WASM AudioContext Buffer Scheduling Path ---
    const audioCtx = (activeEngine === 'wasm') ? getWasmAudioCtx() : null;
    const pcmData = (activeEngine === 'wasm' && audioSrc) ? synthPcmCache.get(audioSrc) : null;

    if (activeEngine === 'wasm' && audioCtx && pcmData) {
      // 1. Match Native Model Sample Rate: AudioContext.createBuffer(1, pcmData.length, modelSampleRate)
      const audioBuffer = createWasmAudioBuffer(audioCtx, pcmData, modelSampleRate);

      const wordsArr = text.trim().split(/\s+/).filter(w => w.length > 0);
      const computed = computeWordTimeline(wordsArr, playbackSpeed, audioBuffer.duration);
      const timeline = computed.timeline;

      // 4. Smooth Buffer Scheduling: check if this sentence was already pre-scheduled back-to-back
      const alreadyScheduled = (wasmScheduledSentenceIdx === currentSentenceIdx && wasmScheduledToken === myToken);
      let startTime = 0;

      if (!alreadyScheduled) {
        // 2. Prevent Double Speed Distortion: speed is applied in ONE place only (AudioBufferSourceNode.playbackRate)
        const sourceNode = audioCtx.createBufferSource();
        sourceNode.buffer = audioBuffer;
        sourceNode.playbackRate.value = playbackSpeed;
        sourceNode.connect(wasmGainNode || audioCtx.destination);

        const now = audioCtx.currentTime;
        startTime = Math.max(now + 0.02, wasmScheduledEndTime);
        sourceNode.start(startTime);

        const chunkDur = audioBuffer.duration / playbackSpeed;
        wasmScheduledEndTime = startTime + chunkDur;
        wasmActiveSourceNode = sourceNode;
        wasmScheduledSentenceIdx = currentSentenceIdx;
        wasmScheduledToken = myToken;
        wasmChunkStartTime = startTime;

        sourceNode.onended = () => {
          cancelWordAnimation();
          if (myToken !== speakToken || standalone || !isPlaying) return;
          currentSentenceIdx++;
          playCurrentSentence();
        };
      } else {
        startTime = wasmChunkStartTime;
      }

      function renderWasmFrame() {
        if (myToken !== speakToken || !isPlaying) return;
        const cur = Math.max(0, (audioCtx.currentTime - startTime) * playbackSpeed);
        if (highlightMode === 'word') {
          let activeIdx = 0;
          for (let i = 0; i < timeline.length; i++) {
            if (cur >= timeline[i].start) activeIdx = i;
            else break;
          }
          highlightActiveWord(activeIdx);
        }
        if (isPlaying && (audioCtx.currentTime - startTime) * playbackSpeed <= audioBuffer.duration + 0.5) {
          wordAnimFrameId = requestAnimationFrame(renderWasmFrame);
        }
      }

      if (highlightMode === 'word') {
        cancelWordAnimation();
        wordAnimFrameId = requestAnimationFrame(renderWasmFrame);
      }

      // 4. Smooth Buffer Scheduling: Pre-synthesize the NEXT sentence chunk while the current chunk is playing
      // and schedule buffers back-to-back on AudioContext.currentTime
      if (!standalone) {
        scheduleNextWasmChunkBackToBack(audioCtx, myToken);
      }

      return;
    }

    const wordsArr = text.trim().split(/\s+/).filter(w => w.length > 0);
    let timeline = null;

    // The timeline is shaped by the clip's real duration, so it is built as soon as the metadata
    // lands. The highlight itself is driven from requestAnimationFrame: currentTime is sampled
    // ~60 times a second, where ontimeupdate fires about four times a second and left the karaoke
    // visibly trailing the voice at 1.5x and above.
    const buildTimeline = () => {
      if (!timeline && audioElement.duration && Number.isFinite(audioElement.duration)) {
        timeline = computeWordTimeline(wordsArr, playbackSpeed, audioElement.duration).timeline;
      }
      return timeline;
    };

    function renderFrame() {
      if (myToken !== speakToken) return;
      const tl = buildTimeline();
      if (tl && highlightMode === 'word') {
        const cur = audioElement.currentTime;
        let activeIdx = 0;
        for (let i = 0; i < tl.length; i++) {
          if (cur >= tl[i].start) {
            activeIdx = i;
          } else {
            break;
          }
        }
        highlightActiveWord(activeIdx);
      }
      if (!audioElement.paused && !audioElement.ended) {
        wordAnimFrameId = requestAnimationFrame(renderFrame);
      }
    }

    audioElement.onloadedmetadata = () => { buildTimeline(); };

    audioElement.onended = () => {
      cancelWordAnimation();
      if (myToken !== speakToken || standalone || !isPlaying) return;
      currentSentenceIdx++;
      playCurrentSentence();
    };

    audioElement.preload = 'auto';
    audioElement.src = audioSrc;
    audioElement.playbackRate = playbackSpeed;
    audioElement.volume = playbackVolume;
    await audioElement.play();

    buildTimeline(); // preloaded clips already know their duration
    if (highlightMode === 'word') {
      cancelWordAnimation();
      wordAnimFrameId = requestAnimationFrame(renderFrame);
    }

    if (!standalone) preloadUpcoming(myToken);

  } catch (err) {
    if (myToken !== speakToken) return; // we were cancelled on purpose
    stopAudio();
    if (err && err.name === 'NotAllowedError') {
      showToast("Your phone blocked audio. Tap play again to allow it.");
    } else if (err && err.name === 'AbortError') {
      // a newer load replaced this one; nothing to report
    } else if (err && explainAiRefusal(err.status, err.code, err.retryAfter,
      () => showToast('AI reading is available again — press play to continue.'))) {
      // stopAudio() above already paused playback; the notice carries the countdown and next step.
    } else {
      alert(err.message);
    }
  }
}

async function scheduleNextWasmChunkBackToBack(audioCtx, myToken) {
  if (myToken !== speakToken || !isPlaying || activeEngine !== 'wasm') return;
  const nextTexts = upcomingNeuralTexts(1);
  if (!nextTexts || nextTexts.length === 0) return;
  const nextText = nextTexts[0];
  const nextSentenceTargetIdx = currentSentenceIdx + 1;

  if (wasmScheduledSentenceIdx >= nextSentenceTargetIdx && wasmScheduledToken === myToken) {
    return;
  }

  // Pre-synthesize the next chunk in background while current chunk is playing
  const key = neuralCacheKey(nextText);
  let nextSrc = audioPreloadCache.get(key)?.src;
  if (!nextSrc) {
    nextSrc = await getNeuralAudioSrc(nextText).catch(() => null);
  }
  if (!nextSrc || myToken !== speakToken || !isPlaying) return;

  const nextPcm = synthPcmCache.get(nextSrc);
  if (!nextPcm) return;

  if (wasmScheduledSentenceIdx >= nextSentenceTargetIdx && wasmScheduledToken === myToken) {
    return;
  }

  // 1. Match Native Model Sample Rate: AudioContext.createBuffer(1, pcmData.length, modelSampleRate)
  const nextBuffer = createWasmAudioBuffer(audioCtx, nextPcm, modelSampleRate);

  // 2. Prevent Double Speed Distortion: speed is applied in ONE place only (AudioBufferSourceNode.playbackRate)
  const nextSource = audioCtx.createBufferSource();
  nextSource.buffer = nextBuffer;
  nextSource.playbackRate.value = playbackSpeed;
  nextSource.connect(wasmGainNode || audioCtx.destination);

  // 4. Smooth Buffer Scheduling: schedule back-to-back on AudioContext.currentTime at exact sample boundary
  const schedStart = Math.max(audioCtx.currentTime + 0.01, wasmScheduledEndTime);
  nextSource.start(schedStart);

  const dur = nextBuffer.duration / playbackSpeed;
  wasmScheduledEndTime = schedStart + dur;
  wasmScheduledSentenceIdx = nextSentenceTargetIdx;
  wasmScheduledToken = myToken;
  wasmChunkStartTime = schedStart;
  wasmActiveSourceNode = nextSource;

  nextSource.onended = () => {
    cancelWordAnimation();
    if (myToken !== speakToken || !isPlaying) return;
    currentSentenceIdx++;
    playCurrentSentence();
  };
}

function stopAudio() {
  isPlaying = false;
  mainPlayToggle.textContent = '▶';
  syncMediaSessionState(false);
  cancelAllSpeech();
  document.querySelectorAll('.word').forEach(el => el.classList.remove('active-word'));
  lastHighlightedWord = -1;
}

// --- CONTROLS HOOKS ---
mainPlayToggle.addEventListener('click', () => {
  if (isPlaying) stopAudio();
  else {
    if (activeEngine !== 'browser') unlockAudioForIOS();
    isPlaying = true;
    playCurrentSentence();
  }
});

prevPageBtn.addEventListener('click', () => {
  if (currentPage > 0) {
    currentPage--;
    currentSentenceIdx = 0;
    const wasPlaying = isPlaying;
    stopAudio();
    renderPage(currentPage);
    if (wasPlaying) { isPlaying = true; playCurrentSentence(); }
  }
});

nextPageBtn.addEventListener('click', () => {
  if (currentPage < bookPages.length - 1) {
    currentPage++;
    currentSentenceIdx = 0;
    const wasPlaying = isPlaying;
    stopAudio();
    renderPage(currentPage);
    if (wasPlaying) { isPlaying = true; playCurrentSentence(); }
  }
});

speedCycleBtn.addEventListener('click', () => {
  let nextIdx = (speedSteps.indexOf(playbackSpeed) + 1) % speedSteps.length;
  playbackSpeed = speedSteps[nextIdx];
  speedCycleBtn.textContent = `${playbackSpeed.toFixed(1)}x`;
  if (isPlaying) {
    if (activeEngine === 'browser') {
      cancelAllSpeech();
      playCurrentSentence();
    } else {
      if (activeEngine === 'wasm' && wasmActiveSourceNode && wasmActiveSourceNode.playbackRate) {
        wasmActiveSourceNode.playbackRate.value = playbackSpeed;
      }
      audioElement.playbackRate = playbackSpeed;
    }
  }
  updateDockProgress(); // total & elapsed are expressed at the current speed
});

// --- FLOATING DOCK: TIME, SCRUBBER, SKIP & VOLUME ---
// Marginalia narrates chunked text pages rather than a single audio file, so the dock
// derives its clock from the document itself: ~400 ms per spoken word at 1.0x
// (≈150 words/min, adjusted by the chosen playback speed).
const MS_PER_WORD = 400;
const progressScrubber = document.getElementById('progressScrubber');
const volumeToggleBtn = document.getElementById('volumeToggleBtn');
const volumePop = document.getElementById('volumePop');
const volumeSlider = document.getElementById('volumeSlider');
const skipBackBtn = document.getElementById('skipBackBtn');
const skipFwdBtn = document.getElementById('skipFwdBtn');

let isScrubbing = false;
let docWordStats = null; // { pages, totalWords, wordsBeforePage[] } — recomputed when bookPages changes

function countWordsInItem(item) {
  if (!item) return 0;
  if (typeof item === 'string') {
    const t = item.trim();
    return t ? t.split(/\s+/).length : 0;
  }
  if (item.type === 'image' && item.caption) {
    const c = item.caption.trim();
    return c ? c.split(/\s+/).length : 0;
  }
  return 0;
}

function getDocWordStats() {
  if (docWordStats && docWordStats.pages === bookPages) return docWordStats;
  const wordsBeforePage = [];
  let totalWords = 0;
  (bookPages || []).forEach((items, pageIdx) => {
    wordsBeforePage[pageIdx] = totalWords;
    (items || []).forEach((item) => { totalWords += countWordsInItem(item); });
  });
  docWordStats = { pages: bookPages, wordsBeforePage, totalWords };
  return docWordStats;
}

// Words spoken before the given sentence on the given page.
function wordsAtPosition(page, sIdx) {
  const items = (bookPages && bookPages[page]) || [];
  let words = getDocWordStats().wordsBeforePage[page] || 0;
  for (let i = 0; i < sIdx && i < items.length; i++) words += countWordsInItem(items[i]);
  return words;
}

function formatDockTime(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${s < 10 ? '0' : ''}${s}`;
}

function getDocElapsedMs() {
  let ms = wordsAtPosition(currentPage, currentSentenceIdx) * MS_PER_WORD / playbackSpeed;
  // While a sentence is being read, interpolate its progress for a smooth clock.
  if (isPlaying && sentenceSpeechStartTime && estimatedSentenceDurationMs > 0) {
    const frac = Math.min(1, (performance.now() - sentenceSpeechStartTime) / estimatedSentenceDurationMs);
    const currentWords = countWordsInItem((bookPages[currentPage] || [])[currentSentenceIdx]);
    ms += frac * currentWords * MS_PER_WORD / playbackSpeed;
  }
  return ms;
}

function getDocTotalMs() {
  return getDocWordStats().totalWords * MS_PER_WORD / playbackSpeed;
}

// Refreshes the dock: elapsed (left, tappable to jump), total (right) and the scrubber.
// Looks elements up at call time so renderPage can safely call this at any point.
function updateDockProgress() {
  const elapsedEl = document.getElementById('openJumpModalBtn'); // the dock's elapsed-time button
  const totalEl = document.getElementById('totalTimeText');
  const scrubber = document.getElementById('progressScrubber');
  const total = getDocTotalMs();
  const elapsed = getDocElapsedMs();
  if (elapsedEl) elapsedEl.textContent = formatDockTime(elapsed);
  if (totalEl) totalEl.textContent = formatDockTime(total);
  if (scrubber && !isScrubbing) {
    scrubber.value = total > 0 ? Math.round(Math.min(1, elapsed / total) * 1000) : 0;
  }
}

// Jump narration to a fraction of the document (used by the scrubber).
function seekToFraction(frac) {
  if (!bookPages || bookPages.length === 0) return;
  const clamped = Math.min(1, Math.max(0, frac));
  const targetWords = clamped * getDocWordStats().totalWords;
  const before = getDocWordStats().wordsBeforePage;

  let page = 0;
  while (page < bookPages.length - 1 && before[page + 1] != null && before[page + 1] <= targetWords) page++;

  const items = bookPages[page] || [];
  let acc = before[page] || 0;
  let sIdx = 0;
  while (sIdx < items.length) {
    const w = countWordsInItem(items[sIdx]);
    if (acc + w > targetWords) break;
    acc += w;
    sIdx++;
  }
  if (sIdx >= items.length) sIdx = Math.max(0, items.length - 1);

  const wasPlaying = isPlaying;
  stopAudio();
  currentPage = page;
  currentSentenceIdx = sIdx;
  renderPage(currentPage);
  if (wasPlaying) { isPlaying = true; playCurrentSentence(); }
}

// Skip ±N seconds of narration at the current speed (≈N seconds of speech).
function skipBySeconds(seconds) {
  if (!bookPages || bookPages.length === 0) return;
  let wordsToMove = Math.abs(seconds) * 1000 * playbackSpeed / MS_PER_WORD;
  let page = currentPage;
  let sIdx = currentSentenceIdx;
  let guard = 0;

  if (seconds > 0) {
    while (wordsToMove > 0 && guard++ < 100000) {
      const items = bookPages[page] || [];
      if (sIdx < items.length) {
        wordsToMove -= countWordsInItem(items[sIdx]);
        sIdx++;
        if (wordsToMove <= 0) {
          if (sIdx >= items.length) {
            if (page < bookPages.length - 1) { page++; sIdx = 0; }
            else sIdx = Math.max(0, items.length - 1);
          }
          break;
        }
      } else if (page < bookPages.length - 1) {
        page++;
        sIdx = 0;
      } else {
        break;
      }
    }
  } else {
    while (wordsToMove > 0 && guard++ < 100000 && (page > 0 || sIdx > 0)) {
      if (sIdx > 0) {
        sIdx--;
      } else {
        page--;
        sIdx = Math.max(0, (bookPages[page] || []).length - 1);
      }
      wordsToMove -= countWordsInItem((bookPages[page] || [])[sIdx]);
    }
  }

  // Never land past the last sentence of the page (forward skips can run off the
  // end of the document while words remain to be consumed).
  const pageItems = bookPages[page] || [];
  if (sIdx >= pageItems.length) sIdx = Math.max(0, pageItems.length - 1);

  const wasPlaying = isPlaying;
  stopAudio();
  currentPage = page;
  currentSentenceIdx = sIdx;
  renderPage(currentPage);
  if (wasPlaying) { isPlaying = true; playCurrentSentence(); }
}

// Scrubber: preview the time while dragging, seek on release.
progressScrubber.addEventListener('input', () => {
  isScrubbing = true;
  const frac = Number(progressScrubber.value) / 1000;
  const elapsedEl = document.getElementById('openJumpModalBtn');
  if (elapsedEl) elapsedEl.textContent = formatDockTime(frac * getDocTotalMs());
});

progressScrubber.addEventListener('change', () => {
  const frac = Number(progressScrubber.value) / 1000;
  isScrubbing = false;
  seekToFraction(frac);
});

skipBackBtn.addEventListener('click', () => skipBySeconds(-15));
skipFwdBtn.addEventListener('click', () => skipBySeconds(15));

// Volume popup above the dock.
volumeToggleBtn.addEventListener('click', () => {
  volumePop.style.display = volumePop.style.display === 'block' ? 'none' : 'block';
});

volumeSlider.addEventListener('input', () => {
  playbackVolume = Math.min(1, Math.max(0, Number(volumeSlider.value) / 100));
  localStorage.setItem('marginalia_volume', String(playbackVolume));
  audioElement.volume = playbackVolume;
  if (typeof wasmGainNode !== 'undefined' && wasmGainNode && wasmGainNode.gain) {
    wasmGainNode.gain.value = playbackVolume;
  }
  volumeToggleBtn.textContent = playbackVolume === 0 ? '🔇' : '🔊';
});

// The clock advances during playback; background tabs throttle timers, so 1s is plenty.
setInterval(() => {
  if (isPlaying && !isScrubbing) updateDockProgress();
}, 1000);

// --- SLEEP TIMER ---
// Stops narration after a set number of minutes or at the end of the current chapter.
// Minute timers are also checked at every sentence boundary, because background tabs can
// throttle timers to once a minute and a sleep timer must still fire on time.
const sleepTimerBtn = document.getElementById('sleepTimerBtn');
const sleepTimerModal = document.getElementById('sleepTimerModal');
const sleepTimerStatus = document.getElementById('sleepTimerStatus');

let sleepTimerMode = 'off';            // 'off' | 'minutes' | 'chapter'
let sleepTimerEndsAt = 0;              // epoch ms when a minute timer expires
let sleepTimerMinutesActive = null;    // chosen minutes, for the modal's active state
let sleepTimerChapterEnd = Infinity;   // pageIndex at which a chapter timer stops playback
let sleepTimerIntervalId = null;

function formatClock(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updateSleepTimerUI() {
  if (sleepTimerMode === 'minutes') {
    const left = formatClock(sleepTimerEndsAt - Date.now());
    sleepTimerBtn.textContent = `🌙 ${left}`;
    sleepTimerBtn.classList.add('active');
    sleepTimerStatus.textContent = `Timer running — playback stops in ${left}.`;
  } else if (sleepTimerMode === 'chapter') {
    sleepTimerBtn.textContent = '🌙 Ch.';
    sleepTimerBtn.classList.add('active');
    sleepTimerStatus.textContent = 'Timer running — playback stops at the end of the current chapter.';
  } else {
    sleepTimerBtn.textContent = '🌙';
    sleepTimerBtn.classList.remove('active');
    sleepTimerStatus.textContent = 'No sleep timer set.';
  }

  document.querySelectorAll('.sleep-option').forEach(btn => {
    const active =
      (sleepTimerMode === 'minutes' && btn.dataset.minutes && Number(btn.dataset.minutes) === sleepTimerMinutesActive) ||
      (sleepTimerMode === 'chapter' && btn.dataset.mode === 'chapter') ||
      (sleepTimerMode === 'off' && btn.dataset.mode === 'off');
    btn.classList.toggle('active', Boolean(active));
  });
}

function clearSleepTimer() {
  if (sleepTimerIntervalId) { clearInterval(sleepTimerIntervalId); sleepTimerIntervalId = null; }
  sleepTimerMode = 'off';
  sleepTimerEndsAt = 0;
  sleepTimerMinutesActive = null;
  sleepTimerChapterEnd = Infinity;
  updateSleepTimerUI();
}

function sleepTimerExpired() {
  return sleepTimerMode === 'minutes' && Date.now() >= sleepTimerEndsAt;
}

function fireSleepTimerEnd() {
  const wasChapter = sleepTimerMode === 'chapter';
  clearSleepTimer();
  stopAudio();
  showToast(wasChapter
    ? '🌙 End of chapter reached — playback stopped.'
    : '🌙 Sleep timer finished — playback stopped.');
}

function startMinuteSleepTimer(minutes) {
  clearSleepTimer();
  sleepTimerMode = 'minutes';
  sleepTimerMinutesActive = minutes;
  sleepTimerEndsAt = Date.now() + minutes * 60 * 1000;
  sleepTimerIntervalId = setInterval(() => {
    if (sleepTimerExpired()) fireSleepTimerEnd();   // clears its own interval
    else updateSleepTimerUI();
  }, 1000);
  updateSleepTimerUI();
  showToast(`🌙 Sleep timer set for ${minutes} minutes.`);
}

function startChapterSleepTimer() {
  clearSleepTimer();
  sleepTimerMode = 'chapter';
  // The chapter ends where the next chapter begins (or at the end of the book)
  const ch = getCurrentChapter();
  const idx = bookChapters.indexOf(ch);
  sleepTimerChapterEnd = (idx >= 0 && idx < bookChapters.length - 1)
    ? bookChapters[idx + 1].pageIndex
    : Infinity;
  updateSleepTimerUI();
  showToast('🌙 Sleep timer set: playback stops at the end of this chapter.');
}

sleepTimerBtn.addEventListener('click', () => {
  updateSleepTimerUI();
  sleepTimerModal.style.display = 'flex';
});

document.querySelectorAll('.sleep-option').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.mode === 'off') {
      clearSleepTimer();
      showToast('Sleep timer cancelled.');
    } else if (btn.dataset.mode === 'chapter') {
      startChapterSleepTimer();
    } else {
      const minutes = Number(btn.dataset.minutes);
      if (Number.isFinite(minutes) && minutes > 0) startMinuteSleepTimer(minutes);
    }
  });
});

// --- IN-BOOK SEARCH ---
const searchModal = document.getElementById('searchModal');
const openSearchBtn = document.getElementById('openSearchBtn');
const searchInput = document.getElementById('searchInput');
const searchStatus = document.getElementById('searchStatus');
const searchResultsList = document.getElementById('searchResultsList');

const SEARCH_MAX_RESULTS = 100;
let searchDebounceTimer = null;
let searchFlashTimer = null;

// Pure function (no DOM access) so it can be tested on its own: case-insensitive matches of
// `query` across the book's pages. One result per sentence; image blocks are searched by caption.
function findSearchMatches(pages, query, maxResults = SEARCH_MAX_RESULTS) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const matches = [];
  for (let p = 0; p < pages.length && matches.length < maxResults; p++) {
    const items = pages[p] || [];
    for (let s = 0; s < items.length && matches.length < maxResults; s++) {
      const item = items[s];
      const text = typeof item === 'string' ? item : (item && item.type === 'image' ? item.caption : '');
      if (!text) continue;
      const at = text.toLowerCase().indexOf(q);
      if (at === -1) continue;
      const start = Math.max(0, at - 32);
      const end = Math.min(text.length, at + q.length + 48);
      matches.push({
        page: p,
        sentence: s,
        before: (start > 0 ? '…' : '') + text.slice(start, at),
        match: text.slice(at, at + q.length),
        after: text.slice(at + q.length, end) + (end < text.length ? '…' : '')
      });
    }
  }
  return matches;
}

function getChapterTitleForPage(pageIdx) {
  if (!bookChapters || bookChapters.length === 0) return '';
  let active = bookChapters[0];
  for (const ch of bookChapters) {
    if (pageIdx >= ch.pageIndex) active = ch;
    else break;
  }
  return active.title || '';
}

function flashSearchHit(sentenceIdx) {
  const el = document.getElementById(`sent-${sentenceIdx}`);
  if (!el) return;
  el.classList.add('search-hit');
  if (searchFlashTimer) clearTimeout(searchFlashTimer);
  searchFlashTimer = setTimeout(() => el.classList.remove('search-hit'), 2800);
}

function jumpToSearchMatch(m) {
  const items = bookPages[m.page];
  if (!items) return;
  stopAudio();
  currentPage = m.page;
  currentSentenceIdx = Math.min(m.sentence, Math.max(0, items.length - 1));
  closeModalById('searchModal');
  renderPage(currentPage);   // re-centres and highlights the matched sentence
  flashSearchHit(currentSentenceIdx);
}

function renderSearchResults(query) {
  const q = String(query || '').trim();
  searchResultsList.innerHTML = '';

  if (!q) {
    searchStatus.textContent = `Type to search "${currentDocName}".`;
    return;
  }

  const matches = findSearchMatches(bookPages, q);
  if (matches.length === 0) {
    searchStatus.textContent = `No matches for "${q}".`;
    return;
  }

  searchStatus.textContent = `${matches.length}${matches.length >= SEARCH_MAX_RESULTS ? '+' : ''} match${matches.length === 1 ? '' : 'es'} — tap to jump.`;

  matches.forEach(m => {
    const card = document.createElement('div');
    card.className = 'shelf-card';
    const chapterTitle = getChapterTitleForPage(m.page);
    card.innerHTML = `
      <div class="shelf-card-info">
        <span class="shelf-card-title">Page ${m.page + 1}${chapterTitle ? ` · ${escapeHtml(chapterTitle)}` : ''}</span>
        <span class="shelf-card-sub search-result-snippet">${escapeHtml(m.before)}<mark>${escapeHtml(m.match)}</mark>${escapeHtml(m.after)}</span>
      </div>
      <div class="shelf-action-group">
        <span style="font-size:0.8rem; color:var(--accent); font-weight:600;">Jump →</span>
      </div>
    `;
    card.addEventListener('click', () => jumpToSearchMatch(m));
    searchResultsList.appendChild(card);
  });
}

function openSearchModal() {
  searchModal.style.display = 'flex';
  searchInput.value = '';
  renderSearchResults('');
  setTimeout(() => searchInput.focus(), 60);
}

openSearchBtn.addEventListener('click', openSearchModal);

searchInput.addEventListener('input', () => {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => renderSearchResults(searchInput.value), 180);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = searchResultsList.querySelector('.shelf-card');
    if (first) first.click();
  }
});

// Esc closes the new modals; "/" opens search (like a desktop reader) when not typing
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (searchModal.style.display === 'flex') closeModalById('searchModal');
    else if (sleepTimerModal.style.display === 'flex') closeModalById('sleepTimerModal');
    return;
  }
  if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey &&
    !/^(input|textarea|select)$/i.test(e.target?.tagName || '')) {
    e.preventDefault();
    openSearchModal();
  }
});

// --- VOICES & ENGINES ---
const voicePresets = {
  browser: [],
  wasm: [
    { id: 'heart', name: 'Heart (Expressive Female · On-Device)' },
    { id: 'michael', name: 'Michael (Narrator Male · On-Device)' },
    { id: 'emma', name: 'Emma (British Academic · On-Device)' }
  ],
  elevenlabs: [
    { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel (Calm & Natural)' },
    { id: 'AZnzlk1XvdvUeBnXmlld', name: 'Domi (Empathetic)' },
    { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella (Expressive)' },
    { id: 'ErXwobaYiN019PkySvjV', name: 'Antoni (Well-rounded)' },
    { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam (Deep Baritone)' }
  ],
  openai: [
    { id: 'alloy', name: 'Alloy (Balanced)' },
    { id: 'echo', name: 'Echo (Warm)' },
    { id: 'fable', name: 'Fable (British Accent)' },
    { id: 'onyx', name: 'Onyx (Deep Authoritative)' },
    { id: 'nova', name: 'Nova (Energetic)' },
    { id: 'shimmer', name: 'Shimmer (Clear)' }
  ]
};

// Azure voices were removed: take its tab out of the page if the HTML still has one
document.querySelectorAll('.engine-tab[data-engine="azure"]').forEach(t => t.remove());

// Restore the engine tab from last visit (each engine remembers its own saved neural voice,
// so returning to the tab also returns to the reader's chosen voice)
const savedEngine = localStorage.getItem('marginalia_active_engine') || '';
if (savedEngine && voicePresets[savedEngine] && savedEngine !== activeEngine) {
  activeEngine = savedEngine;
  document.querySelectorAll('.engine-tab').forEach(t => t.classList.toggle('active', t.dataset.engine === savedEngine));
}

function populateVoices() {
  const prevChoice = voicePicker.value;
  voicePicker.innerHTML = '';

  if (activeEngine === 'browser') {
    const voices = browserSpeech.getVoices();
    if (!voices || voices.length === 0) {
      const opt = document.createElement('option');
      opt.value = "default";
      opt.textContent = "System Default Voice";
      voicePicker.appendChild(opt);
      activeVoiceBadge.textContent = "🎙️ System Default";
      return;
    }

    const userLang = (navigator.language || 'en').toLowerCase().split('-')[0];

    // Apple ships novelty + legacy robotic voices alongside the good ones. Hide them.
    const NOVELTY = new Set(['albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos', 'deranged',
      'good news', 'hysterical', 'jester', 'organ', 'pipe organ', 'superstar', 'trinoids', 'whisper', 'wobble',
      'zarvox', 'fred', 'junior', 'kathy', 'ralph', 'agnes', 'bruce', 'vicki', 'victoria', 'princess']);
    const baseName = v => v.name.replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase();
    const quality = v => {
      const n = v.name.toLowerCase();
      if (/premium|siri/.test(n)) return 3;
      if (/enhanced|neural|natural/.test(n)) return 2;
      return 1;
    };

    let pool = voices.filter(v => !NOVELTY.has(baseName(v)));
    if (pool.length === 0) pool = voices.slice(); // never leave the list empty

    const indexed = pool.slice();
    indexed.sort((a, b) => {
      const aL = a.lang.toLowerCase();
      const bL = b.lang.toLowerCase();
      const aU = aL.startsWith(userLang);
      const bU = bL.startsWith(userLang);
      const aE = aL.startsWith('en');
      const bE = bL.startsWith('en');
      if (aU && !bU) return -1;
      if (!aU && bU) return 1;
      if (aE && !bE) return -1;
      if (!aE && bE) return 1;
      const qd = quality(b) - quality(a); // best-sounding first
      if (qd) return qd;
      return a.name.localeCompare(b.name);
    });

    const savedKey = localStorage.getItem('marginalia_browser_voice') || '';
    const keyOf = v => v.voiceURI || `${v.name}:::${v.lang}`;
    const wanted = [prevChoice, savedKey].find(k => k && k !== 'default' && indexed.some(v => keyOf(v) === k));
    const defVoice = wanted ? indexed.find(v => keyOf(v) === wanted) : indexed[0];

    indexed.forEach(v => {
      const opt = document.createElement('option');
      const vKey = keyOf(v);
      opt.value = vKey;
      opt.textContent = `${quality(v) >= 2 ? '★ ' : ''}${v.name} (${v.lang})`;
      if (defVoice && vKey === keyOf(defVoice)) opt.selected = true;
      voicePicker.appendChild(opt);
    });

    const selectedOption = voicePicker.options[voicePicker.selectedIndex];
    activeVoiceBadge.textContent = `🎙️ ${selectedOption ? selectedOption.text.split('(')[0].trim() : 'Native Voice'}`;
  } else {
    const list = voicePresets[activeEngine] || [];
    // Restore this reader's saved neural voice for the engine; falls back to the in-session
    // choice, then the first preset, so the list is never empty.
    const savedChoice = localStorage.getItem(`marginalia_neural_voice_${activeEngine}`) || '';
    const wanted = [prevChoice, savedChoice].find(k => k && list.some(item => item.id === k)) || (list[0] ? list[0].id : '');
    list.forEach(item => {
      const opt = document.createElement('option');
      opt.value = item.id;
      opt.textContent = item.name;
      if (item.id === wanted) opt.selected = true;
      voicePicker.appendChild(opt);
    });
    if (!voicePicker.value && list.length > 0) {
      voicePicker.selectedIndex = 0;
    }
    const selectedOption = voicePicker.options[voicePicker.selectedIndex];
    if (activeEngine === 'wasm') {
      activeVoiceBadge.textContent = `🎙️ ${selectedOption ? selectedOption.text.split('(')[0].trim() : 'Studio Voice'}`;
    } else {
      activeVoiceBadge.textContent = `⚡ ${selectedOption ? selectedOption.text : activeEngine}`;
    }
  }
}

if (typeof speechSynthesis !== 'undefined') {
  speechSynthesis.onvoiceschanged = populateVoices;
}
['touchstart', 'click'].forEach(evt => {
  document.body.addEventListener(evt, () => {
    if (voicePicker.children.length <= 1) populateVoices();
  }, { once: true });
});

voicePicker.addEventListener('change', () => {
  if (activeEngine === 'browser') {
    localStorage.setItem('marginalia_browser_voice', voicePicker.value);
  } else {
    // Neural voices are fixed presets, so the chosen one can be remembered exactly (per engine)
    localStorage.setItem(`marginalia_neural_voice_${activeEngine}`, voicePicker.value);
  }
  clearAudioCache();
  learnedCadenceMultiplier = cadenceByVoice.get(voiceCadenceKey()) || 1.0;
  const selectedOption = voicePicker.options[voicePicker.selectedIndex];
  const badgeIcon = (activeEngine === 'browser' || activeEngine === 'wasm') ? '🎙️' : '⚡';
  activeVoiceBadge.textContent = `${badgeIcon} ${selectedOption ? selectedOption.text.split('(')[0].trim() : 'Voice'}`;

  if (isPlaying) {
    stopAudio();
    if (activeEngine !== 'browser') unlockAudioForIOS();
    isPlaying = true;
    setTimeout(() => { playCurrentSentence(); }, 60);
  }
});

document.querySelectorAll('.engine-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.engine-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    activeEngine = tab.dataset.engine;
    localStorage.setItem('marginalia_active_engine', activeEngine); // return to this engine next visit
    clearAudioCache();
    learnedCadenceMultiplier = cadenceByVoice.get(voiceCadenceKey()) || 1.0;
    populateVoices();
    if (isPlaying) {
      stopAudio();
      if (activeEngine !== 'browser') unlockAudioForIOS();
      isPlaying = true;
      playCurrentSentence();
    }
  });
});

// --- AI VISION: EXPLAIN DIAGRAM ---
async function explainDiagram(imgSrc, captionText = "") {
  stopAudio();
  const customOpenAi = localStorage.getItem('marginalia_byok_openai') || '';
  const token = await getFreshAuthToken();

  if (!token && !customOpenAi) {
    showAuthAlert("Please sign in or enter your OpenAI key in Options to analyze diagrams.", "error");
    authModal.style.display = 'flex';
    return;
  }

  if (imgSrc.length > MAX_IMAGE_BASE64_CHARS) {
    showToast(FIGURE_TOO_LARGE_MSG);
    return;
  }

  preloadStatus.textContent = "Analyzing figure...";
  contentPane.innerHTML = `<div style="text-align:center; padding:3rem; color:var(--text-muted); font-style:italic;">Analyzing diagram with Vision AI...</div>`;

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (customOpenAi) headers['x-custom-openai-key'] = customOpenAi;

    if (SUPABASE_PROJECT_URL && !SUPABASE_PROJECT_URL.includes("your-project")) {
      headers['x-supabase-url'] = SUPABASE_PROJECT_URL;
      headers['x-supabase-key'] = SUPABASE_ANON_KEY;
    }

    const res = await fetch('/api/describe-image', {
      method: 'POST',
      headers,
      body: JSON.stringify({ imageBase64: imgSrc })
    });

    const data = await res.json().catch(() => ({}));

    if (res.status === 401) {
      updateAuthBadge();
      authModal.style.display = 'flex';
      showAuthAlert(data.error || "Session authentication expired. Please sign in again.", "error");
      renderPage(currentPage);
      return;
    }

    if (res.status === 402 || data.trialExhausted) {
      if (data.error === 'AI_SUMMARY_QUOTA_EXCEEDED') {
        // Vision AI is on the same two-bucket AI-ops model as /api/summarize.
        paywallModal.style.display = 'flex';
        renderPage(currentPage);
        return;
      }

      paywallModal.style.display = 'flex';
      renderPage(currentPage);
      return;
    }

    if (res.status === 413) {
      // The figure is past the endpoint's 2 MB image cap. Put the reader back on the page they came
      // from and say why, instead of failing with the server's raw message.
      renderPage(currentPage);
      showToast(FIGURE_TOO_LARGE_MSG);
      return;
    }

    if (!res.ok) throw new Error(data.error || "Failed to analyze diagram.");

    if (!originalBookPages) {
      originalBookPages = bookPages;
      originalDocName = currentDocName;
      originalPage = currentPage;
    }

    const descSentences = splitIntoSentences(data.explanation);
    bookPages = [];
    for (let i = 0; i < descSentences.length; i += 3) {
      bookPages.push(descSentences.slice(i, i + 3));
    }

    currentDocName = `Figure Explanation: ${captionText || 'Diagram'}`;
    docTitle.textContent = currentDocName;
    summaryReturnSpan.style.display = 'inline-block';

    currentPage = 0;
    currentSentenceIdx = 0;
    renderPage(0);

    isPlaying = true;
    playCurrentSentence();

  } catch (err) {
    alert(err.message);
    renderPage(currentPage);
  } finally {
    preloadStatus.textContent = "Ready";
  }
}

// --- MULTIMODAL UTILITIES ---
function normalizeZipPath(basePath, relativePath) {
  const combined = basePath ? `${basePath}/${relativePath}` : relativePath;
  const parts = combined.replace(/\\/g, '/').split('/');
  const stack = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') { if (stack.length > 0) stack.pop(); }
    else { stack.push(part); }
  }
  return stack.join('/');
}

function parseHtmlToBlocks(htmlString) {
  const doc = new DOMParser().parseFromString(htmlString, 'text/html');
  doc.querySelectorAll('script, style, head, nav, [role="doc-toc"]').forEach(el => el.remove());

  const blocks = [];
  if (!doc.body || doc.body.children.length === 0) {
    const rawText = (doc.body ? doc.body.textContent : doc.documentElement.textContent) || '';
    return splitIntoSentences(rawText);
  }

  const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'main', 'aside', 'header', 'footer', 'ul', 'ol', 'li', 'table', 'tbody', 'thead', 'tr', 'td', 'th', 'blockquote', 'figure', 'pre', 'dl', 'dt', 'dd', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr']);

  const pushText = (raw) => {
    const t = (raw || '').replace(/\s+/g, ' ').trim();
    if (t) splitIntoSentences(t).forEach(s => blocks.push(s));
  };

  const pushImage = (imgEl) => {
    const src = imgEl.getAttribute('src');
    if (!src || !src.startsWith('data:')) return;
    const fig = imgEl.closest ? imgEl.closest('figure') : null;
    const caption = imgEl.getAttribute('alt') || fig?.querySelector('figcaption')?.textContent || '';
    blocks.push({ type: 'image', src, caption: caption.trim() });
  };

  // Reads one inline-level element in document order: text becomes sentences, images become image blocks
  const readInline = (el) => {
    let buf = '';
    const flush = () => { pushText(buf); buf = ''; };
    const visit = (n) => {
      if (n.nodeType === 3) { buf += n.textContent; return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName.toLowerCase();
      if (tag === 'img' || tag === 'image') { flush(); pushImage(n); return; }
      if (tag === 'figcaption') return; // used as the image caption instead of being read twice
      if (tag === 'br') { buf += ' '; return; }
      n.childNodes.forEach(visit);
    };
    visit(el);
    flush();
  };

  // Wrapper elements (divs/sections around the real paragraphs) are walked into, not flattened
  const walk = (parent) => {
    Array.from(parent.children).forEach(el => {
      const tag = el.tagName.toLowerCase();
      const hasBlockChild = Array.from(el.children).some(c => BLOCK_TAGS.has(c.tagName.toLowerCase()));
      if (tag !== 'figure' && hasBlockChild) walk(el);
      else readInline(el);
    });
  };
  walk(doc.body);

  return blocks.length > 0 ? blocks : splitIntoSentences(doc.body.textContent || '');
}

// --- EPUB EXTRACTOR WITH TABLE OF CONTENTS ---
// Real-world EPUBs bend the packaging rules in ways that silently empty the reading order:
// hrefs that climb out of the OPF folder (../Text/...), namespace-prefixed manifest tags
// (<opf:item>), percent-encoded entry names, backslash-separated zip paths, and documents
// that are not UTF-8. So every path is resolved through a normalized index of the archive,
// every package document is tried before falling back to a filename scan, and each file is
// decoded with the charset it declares.

const EPUB_CONTENT_EXT = /\.(xhtml|html|htm|xht|xml|zhtml)$/i;

function safeDecodeURIComponent(value) {
  try { return decodeURIComponent(value); } catch (e) { return value; }
}

// Lower-cased, slash-normalized view of the archive so lookups survive case differences,
// backslash zip paths, and leading "./" segments.
function buildZipKeyIndex(allKeys) {
  const index = new Map();
  for (const key of allKeys) {
    const normalized = normalizeZipPath('', key.replace(/\\/g, '/')).toLowerCase();
    if (normalized && !index.has(normalized)) index.set(normalized, key);
  }
  return index;
}

function findZipKey(keyIndex, relativePath) {
  if (!relativePath) return null;
  return keyIndex.get(normalizeZipPath('', relativePath.replace(/\\/g, '/')).toLowerCase()) || null;
}

// Decodes a document using its UTF-16 BOM or declared charset, falling back to the
// UTF-8/latin1 heuristic used for plain text files.
function decodeEpubText(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes);

  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 400));
  const declared = head.match(/encoding=["']([\w-]+)["']/i) || head.match(/charset=["']?([\w-]+)/i);
  if (declared && !/^utf-?8$/i.test(declared[1])) {
    try {
      const replacementCount = (s) => (s.match(/\uFFFD/g) || []).length;
      const asDeclared = new TextDecoder(declared[1]).decode(bytes);
      if (replacementCount(asDeclared) < replacementCount(new TextDecoder('utf-8').decode(bytes))) return repairMojibake(asDeclared);
    } catch (e) { /* unknown label — keep the UTF-8 reading */ }
  }
  return decodeTextRobustly(bytes);
}

// DRM-scraped chapters decode to binary noise: C0 control characters and replacement marks that
// never appear in real XHTML (CJK text included). A chapter whose decoded text is mostly this is
// encrypted, not empty - counting it as unreadable keeps DRM files from rendering walls of mojibake.
function garbageTextRatio(text) {
  if (!text) return 1;
  const bad = text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/g) || [];
  return bad.length / text.length;
}

async function parseEpubArchive(zip) {
  const allKeys = Object.keys(zip.files);
  const keyIndex = buildZipKeyIndex(allKeys);

  // Readium LCP files keep the container readable but AES-encrypt every chapter
  const hasLcpLicense = allKeys.some(k => /(^|\/)license\.lcpl$/i.test(k.replace(/\\/g, '/')));

  // 1. Find the package document(s): container.xml first, then anything ending in .opf
  const opfCandidates = [];
  const containerKey = allKeys.find(k => /(^|\/)container\.xml$/i.test(k.replace(/\\/g, '/')));
  if (containerKey) {
    const containerXml = decodeEpubText(await zip.files[containerKey].async('uint8array'));
    const m = containerXml.match(/full-path=["']([^"']+)["']/i);
    if (m) {
      const key = findZipKey(keyIndex, m[1].trim());
      if (key) opfCandidates.push(key);
    }
  }
  allKeys.forEach(k => { if (/\.opf$/i.test(k) && !opfCandidates.includes(k)) opfCandidates.push(k); });

  // 2. Reading order from the spine of the first package document that has a usable one
  const spineFiles = [];
  for (const opfKey of opfCandidates) {
    const opfXml = decodeEpubText(await zip.files[opfKey].async('uint8array'));
    const opfDir = opfKey.includes('/') ? opfKey.substring(0, opfKey.lastIndexOf('/')) : '';
    const manifest = {};

    const itemRegex = /<(?:[\w-]+:)?item\b[^>]*>/gi;
    let match;
    while ((match = itemRegex.exec(opfXml)) !== null) {
      const tag = match[0];
      const idMatch = tag.match(/\bid=["']([^"']+)["']/i);
      const hrefMatch = tag.match(/\bhref=["']([^"']+)["']/i);
      if (!idMatch || !hrefMatch) continue;
      // Resolves ../ climbs, ./ prefixes, and percent-encoding against the archive index
      const href = safeDecodeURIComponent(hrefMatch[1].split('#')[0]);
      manifest[idMatch[1]] = findZipKey(keyIndex, normalizeZipPath(opfDir, href));
    }

    const spineRegex = /<(?:[\w-]+:)?itemref\b[^>]*\bidref=["']([^"']+)["']/gi;
    while ((match = spineRegex.exec(opfXml)) !== null) {
      const key = manifest[match[1]];
      if (key && zip.files[key] && !zip.files[key].dir) spineFiles.push(key);
    }
    if (spineFiles.length > 0) break;
  }

  // 3. Candidate passes, in order: the spine, a filename scan that skips navigation pages,
  //    then a scan that keeps them. A pass only matters if it yields readable pages.
  const isNavigationDoc = (key) => {
    const base = key.replace(/\\/g, '/').split('/').pop();
    return /(^|[\/.\-_])(toc|nav|navdoc|navigation|contents)([\/.\-_]|$)/i.test(base);
  };
  const filenameScan = (includeNavigation) => allKeys
    .filter(key => EPUB_CONTENT_EXT.test(key) && (includeNavigation || !isNavigationDoc(key)))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

  const passes = [spineFiles, filenameScan(false), filenameScan(true)];

  // 4. Turn a candidate list into pages, inlining each chapter's images as data URIs
  let sawImages = false;
  let sawEncryptedChapter = false;

  const buildPages = async (fileKeys) => {
    const chaptersList = [];
    const extractedPages = [];
    const perPage = 5;

    for (let fIdx = 0; fIdx < fileKeys.length; fIdx++) {
      const chapterKey = fileKeys[fIdx];
      if (!zip.files[chapterKey] || zip.files[chapterKey].dir) continue;

      const rawHtml = decodeEpubText(await zip.files[chapterKey].async('uint8array'));
      // Skip package bookkeeping (OPF/NCX/container) that the scan may have picked up
      if (/<(package|container|ncx)\b[^>]*(version=|unique-identifier|urn:oasis)/i.test(rawHtml.slice(0, 1500))) continue;
      // DRM-encrypted content decodes to noise; record it and move on
      if (garbageTextRatio(rawHtml) > 0.05) { sawEncryptedChapter = true; continue; }

      const chapterDir = chapterKey.includes('/') ? chapterKey.substring(0, chapterKey.lastIndexOf('/') + 1) : '';

      let chapTitle = "";
      const titleMatch = rawHtml.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i) || rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (titleMatch) {
        chapTitle = repairMojibake(titleMatch[1].replace(/<[^>]+>/g, '').trim());
      }
      if (!chapTitle || chapTitle.length < 2) {
        chapTitle = `Section ${fIdx + 1}`;
      }

      const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
      const images = Array.from(doc.querySelectorAll('img, image'));

      for (const img of images) {
        const srcAttr = img.getAttribute('src') || img.getAttribute('xlink:href');
        if (!srcAttr || srcAttr.startsWith('data:') || srcAttr.startsWith('http')) continue;

        const resolved = findZipKey(keyIndex, normalizeZipPath(chapterDir, safeDecodeURIComponent(srcAttr.split('#')[0])));
        if (resolved && zip.files[resolved] && !zip.files[resolved].dir) {
          const ext = resolved.split('.').pop().toLowerCase();
          const mime = ext === 'png' ? 'image/png' : ext === 'svg' ? 'image/svg+xml' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
          const base64Data = await zip.files[resolved].async('base64');
          img.setAttribute('src', `data:${mime};base64,${base64Data}`);
        }
      }
      if (images.length > 0) sawImages = true;

      const chapterBlocks = parseHtmlToBlocks(doc.body ? doc.body.innerHTML : rawHtml);
      if (chapterBlocks.length === 0) continue;

      chaptersList.push({ title: chapTitle, pageIndex: extractedPages.length });
      for (let i = 0; i < chapterBlocks.length; i += perPage) {
        extractedPages.push(chapterBlocks.slice(i, i + perPage));
      }
    }

    return { pages: extractedPages, chapters: chaptersList, sawImages };
  };

  for (const candidates of passes) {
    if (!candidates || candidates.length === 0) continue;
    const built = await buildPages(candidates);
    if (built.pages.length > 0) return { pages: built.pages, chapters: built.chapters };
  }

  if (hasLcpLicense || sawEncryptedChapter) {
    throw new Error("This EPUB is DRM-protected, so its chapters can't be read here. Use an unlocked copy - for example, a file that is not an LCP or Adobe DRM download.");
  }
  if (sawImages) {
    throw new Error("This EPUB contains only images (likely a scanned book) with no readable text.");
  }

  throw new Error("No readable text found in EPUB. The book may be a scanned image-only file, DRM-protected, or missing its content files.");
}

// --- PDF ENGINE (ES module, loaded by index.html) ---
// pdf.js v4+ is distributed as an ES module, so index.html imports it in a module script and
// exposes it as window.pdfjsLib. Classic scripts run before that deferred module finishes, so wait
// for it instead of failing on a slow library load.
async function getPdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  if (window.__pdfjsReady) {
    const lib = await window.__pdfjsReady;
    if (lib) return lib;
  }
  return null;
}

// --- OCR FALLBACK FOR FLAT IMAGE SCANS ---
// A scanned PDF has no text layer, so extractPdfTexts comes back empty. Instead of refusing the
// file, render each page to an image and transcribe it with /api/ocr. Returns the same
// [{ pageNumber, text }] shape the normal branch builds its chapters from.
async function ocrScannedPdf(lib, uint8) {
  if (typeof window.renderPdfPages !== 'function') {
    throw new Error("This PDF has no digital text (it looks like a flat image scan) and the page renderer did not load. Check your connection and try again.");
  }

  const customOpenAi = localStorage.getItem('marginalia_byok_openai') || '';
  const token = await getFreshAuthToken();
  if (!token && !customOpenAi) {
    throw new Error("This PDF is a flat image scan, so AI is needed to read it. Sign in, or add your OpenAI key in Options, then try again.");
  }

  const images = await window.renderPdfPages(lib, uint8, (done, total) => {
    preloadStatus.textContent = `Preparing scan ${done}/${total}...`;
  });

  const pages = [];
  const skippedPageNote = (pageNumber) =>
    `Page ${pageNumber} could not be read because its scanned image is too large. The document continues below.`;

  // A dense page can render past the endpoint's 2 MB image cap at the default 1600px / 0.78. Re-render
  // just that page once at 1100px / 0.6, which measured at a quarter to a half of the bytes for a page
  // that is still legible: OpenAI's vision step rescales the short side to 768px anyway, so anything
  // wider is detail the model never sees. Returns '' when the retry cannot get under the cap.
  const fitScanPage = async ({ pageNumber, dataUrl }) => {
    if (dataUrl.length <= MAX_IMAGE_BASE64_CHARS) return dataUrl;
    preloadStatus.textContent = `Re-reading scan ${pageNumber}/${images.length}...`;
    try {
      const [small] = await window.renderPdfPages(lib, uint8, null, { maxWidth: 1100, quality: 0.6, onlyPage: pageNumber });
      const fits = small && small.dataUrl && small.dataUrl.length <= MAX_IMAGE_BASE64_CHARS;
      return fits ? small.dataUrl : '';
    } catch (e) {
      return '';
    }
  };

  for (let i = 0; i < images.length; i++) {
    preloadStatus.textContent = `Reading scan ${i + 1}/${images.length}...`;

    const dataUrl = await fitScanPage(images[i]);
    if (!dataUrl) {
      // Still too large after the retry: name the page and keep the rest of the scan.
      pages.push({ pageNumber: images[i].pageNumber, text: skippedPageNote(images[i].pageNumber) });
      continue;
    }

    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (customOpenAi) headers['x-custom-openai-key'] = customOpenAi;

    const res = await fetch('/api/ocr', {
      method: 'POST',
      headers,
      body: JSON.stringify({ imageBase64: dataUrl })
    });
    const data = await res.json().catch(() => ({}));

    if (res.status === 413) {
      // Backstop: the server cap and the one above should agree, but if they ever drift the scan still
      // keeps the pages it has and names the one that was refused.
      pages.push({ pageNumber: images[i].pageNumber, text: skippedPageNote(images[i].pageNumber) });
      continue;
    }
    if (res.status === 402) {
      // Out of free credits: keep the pages already read and say where it stopped.
      const reason = data.error || 'AI credits ran out.';
      if (pages.length === 0) throw new Error(reason);
      pages.push({
        pageNumber: images.length + 1,
        text: `Reading stopped at page ${i + 1} of ${images.length}: ${reason}`
      });
      break;
    }
    if (!res.ok) throw new Error(data.error || `Could not read this scan (error ${res.status}).`);

    const text = (data.text || '').trim();
    if (text) pages.push({ pageNumber: images[i].pageNumber, text });
  }

  if (pages.length === 0) {
    throw new Error("No readable text was found on this scan. The pages may be blank, too blurry, or too faint to read.");
  }
  return pages;
}

// --- SECURE MULTI-FORMAT DOCUMENT DISPATCHER ---
async function processUploadedDocument(file) {
  const buffer = await file.arrayBuffer();
  const uint8 = new Uint8Array(buffer);

  const isZip = uint8.length > 4 && uint8[0] === 0x50 && uint8[1] === 0x4B && (uint8[2] === 0x03 || uint8[2] === 0x05);
  const isPdf = uint8.length > 4 && uint8[0] === 0x25 && uint8[1] === 0x50 && uint8[2] === 0x44 && uint8[3] === 0x46;
  const lowerName = (file.name || "").toLowerCase();

  if (isZip || lowerName.endsWith('.epub') || lowerName.endsWith('.docx')) {
    const zip = await JSZip.loadAsync(buffer);

    if (zip.files['word/document.xml']) {
      if (typeof mammoth === 'undefined') throw new Error("Word reader engine is still loading. Please try again.");
      const res = await mammoth.convertToHtml(
        { arrayBuffer: buffer },
        {
          convertImage: mammoth.images.imgElement(async (img) => {
            const b64 = await img.read("base64");
            return { src: `data:${img.contentType};base64,${b64}` };
          })
        }
      );
      const blocks = parseHtmlToBlocks(res.value || "");
      const pages = [];
      for (let i = 0; i < blocks.length; i += 5) pages.push(blocks.slice(i, i + 5));
      return { pages, chapters: [{ title: "Start of Document", pageIndex: 0 }] };
    }

    return await parseEpubArchive(zip);
  }

  if (isPdf || lowerName.endsWith('.pdf')) {
    const lib = await getPdfJs();
    if (!lib || typeof window.extractPdfTexts !== 'function') {
      throw new Error("The PDF engine could not be loaded. Check your connection and try again.");
    }

    let pageTexts = await window.extractPdfTexts(lib, uint8);
    if (pageTexts.length === 0) {
      // Flat image scan: no text layer at all, so read the pages as images instead.
      pageTexts = await ocrScannedPdf(lib, uint8);
    }
    const pages = [];
    const chapters = [];

    pageTexts.forEach(({ pageNumber, text }) => {
      const sents = splitIntoSentences(text);
      if (sents.length === 0) return;
      chapters.push({ title: `PDF Page ${pageNumber}`, pageIndex: pages.length });
      for (let s = 0; s < sents.length; s += 5) {
        pages.push(sents.slice(s, s + 5));
      }
    });

    if (pages.length === 0) throw new Error("No readable digital text found. This PDF may be a flat image scan.");
    return { pages, chapters };
  }

  if (lowerName.endsWith('.html') || lowerName.endsWith('.htm')) {
    const raw = decodeTextRobustly(uint8);
    const blocks = parseHtmlToBlocks(raw);
    const pages = [];
    for (let i = 0; i < blocks.length; i += 5) pages.push(blocks.slice(i, i + 5));
    return { pages, chapters: [{ title: "HTML Document", pageIndex: 0 }] };
  }

  let nonPrintable = 0;
  const sampleLen = Math.min(uint8.length, 1000);
  for (let i = 0; i < sampleLen; i++) {
    if (uint8[i] === 0 || (uint8[i] < 32 && uint8[i] !== 9 && uint8[i] !== 10 && uint8[i] !== 13)) {
      nonPrintable++;
    }
  }
  if (nonPrintable > 15) {
    throw new Error("Unable to read file: The file contains binary or DRM-protected data. Please ensure it is an unlocked EPUB, PDF, Word, or TXT file.");
  }

  const raw = decodeTextRobustly(uint8);
  const sents = splitIntoSentences(raw);
  if (sents.length === 0) throw new Error("Document is empty.");
  const pages = [];
  for (let i = 0; i < sents.length; i += 5) pages.push(sents.slice(i, i + 5));
  return { pages, chapters: [{ title: "Beginning", pageIndex: 0 }] };
}

// Freemium teaser: extract only page 1 for unauthenticated users
async function processUploadedDocumentFreemium(file) {
  const result = await processUploadedDocument(file);
  const firstPage = result.pages.length > 0 ? [result.pages[0]] : [];
  const firstChapter = result.chapters && result.chapters.length > 0
    ? [{ ...result.chapters[0], pageIndex: 0 }]
    : [{ title: "Beginning", pageIndex: 0 }];
  return { pages: firstPage, chapters: firstChapter };
}

function splitIntoSentences(text) {
  if (!text || !text.trim()) return [];

  // Undo UTF-8 text that was decoded as windows-1252/latin1 before it is stored per sentence
  text = repairMojibake(text);

  // --- Clean raw HTML/XML entities here before splitting ---
  text = text
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    try {
      const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
      const segments = Array.from(segmenter.segment(text));
      return segments.map(s => s.segment.replace(/\s+/g, ' ').trim()).filter(s => s.length > 0);
    } catch (e) { }
  }
  const matches = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [text];
  return matches.map(s => s.replace(/\s+/g, ' ').trim()).filter(s => s.length > 0);
}

// Decodes bytes explicitly as UTF-8, which is what EPUB, DOCX, HTML and text files are supposed to
// be. Only bytes that are not valid UTF-8 fall back to latin1, and text that still looks like a
// UTF-8 file mislabeled as windows-1252 is repaired here before the reader ever sees it.
function decodeTextRobustly(uint8) {
  let raw = new TextDecoder('utf-8').decode(uint8);
  if (raw.includes('\uFFFD')) {
    try {
      const asLatin1 = new TextDecoder('latin1').decode(uint8);
      // C1 control characters mean the bytes were binary noise, not latin1 text
      if (!/[\u0080-\u009F]/.test(asLatin1)) raw = asLatin1;
    } catch (e) { }
  }
  return repairMojibake(raw);
}

// --- MOJIBAKE REPAIR ---
// A UTF-8 file that declares (or is guessed to be) windows-1252 shows every smart quote, dash and
// accent as noise: "donâ€™t" instead of "don’t", "Ã©" instead of "é". Repairing it happens in two
// layers: re-reading the bytes as UTF-8 when they round-trip cleanly, and otherwise a fixed table.

// Replacement table for damage a byte round-trip cannot undo. Three-character sequences must come
// first: a bare "â€" would otherwise swallow the prefix of "â€“" (en dash) and "â€”" (em dash).
// Right quotes lose their third byte because 0x9D is undefined in cp1252, hence the bare "â€".
function cleanMojibake(text) {
  if (!text || !/Ã|Â|â€/.test(text)) return text;
  return text
    .replace(/â€™/g, '’')
    .replace(/â€˜/g, '‘')
    .replace(/â€œ/g, '“')
    .replace(/â€\u009D/g, '”')
    .replace(/â€“/g, '–')
    .replace(/â€”/g, '—')
    .replace(/â€¦/g, '…')
    .replace(/â€¢/g, '•')
    .replace(/â€‹/g, '')
    .replace(/â€/g, '”')
    .replace(/\u00C2\u00A0/g, ' ')           // "Â" plus no-break space was one no-break space
    .replace(/\u00C2(?=[\s.,;:!?)\]])/g, '') // stray "Â" in front of spacing or punctuation
    .replace(/[\u0080-\u009F]/g, '');       // undefined cp1252 bytes, e.g. the lost 0x9D
}

// Rebuilds the bytes behind a wrong decode and reads them back as UTF-8, which repairs what a fixed
// table cannot cover ("Ã©" -> "é", "Â£" -> "£"). Falls back to the table when the text mixes
// encodings, so a genuine "Ã" or "Â" in the original is never destroyed.
function repairMojibake(text) {
  if (!text || !/Ã|Â|â€/.test(text)) return text;

  const CP1252_TO_BYTE = {
    '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87,
    'ˆ': 0x88, '‰': 0x89, 'Š': 0x8A, '‹': 0x8B, 'Œ': 0x8C, 'Ž': 0x8E, '‘': 0x91,
    '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98,
    '™': 0x99, 'š': 0x9A, '›': 0x9B, 'œ': 0x9C, 'ž': 0x9E, 'Ÿ': 0x9F
  };

  const bytes = new Uint8Array(text.length);
  let length = 0;
  for (const ch of text) {
    const byte = CP1252_TO_BYTE[ch] !== undefined ? CP1252_TO_BYTE[ch] : ch.codePointAt(0);
    if (byte > 0xFF) { length = -1; break; }
    bytes[length++] = byte;
  }

  if (length > 0) {
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
      if (!decoded.includes('\uFFFD') && !/Ã|Â|â€/.test(decoded)) return decoded;
    } catch (e) { /* mixed encodings: use the replacement table instead */ }
  }
  return cleanMojibake(text);
}

// Documents imported before this fix were saved with mojibake already in their sentences, so the
// library repairs them again when one is reopened instead of asking the reader to re-import.
function repairSavedPages(pages) {
  if (!Array.isArray(pages)) return pages;
  return pages.map(page => (Array.isArray(page) ? page.map(block => {
    if (typeof block === 'string') return repairMojibake(block);
    if (block && typeof block === 'object') {
      if (typeof block.text === 'string') return { ...block, text: repairMojibake(block.text) };
      if (typeof block.caption === 'string') return { ...block, caption: repairMojibake(block.caption) };
    }
    return block;
  }) : page));
}

// PRIMARY FILE IMPORT AND DOCUMENT LOADER
async function loadDocumentFile(file) {
  if (!file) return;

  stopAudio();
  currentDocName = file.name;
  docTitle.textContent = currentDocName;
  preloadStatus.textContent = "Opening...";
  contentPane.innerHTML = `<div style="text-align:center; padding:3rem; color:var(--text-muted); font-style:italic;">Processing "${escapeHtml(file.name)}"...</div>`;

  try {
    const signedIn = await isUserSignedIn();
    let result;

    if (signedIn) {
      // Authenticated: full document access
      result = await processUploadedDocument(file);
    } else {
      // Unauthenticated: freemium teaser - only page 1
      result = await processUploadedDocumentFreemium(file);
    }

    bookPages = result.pages;
    bookChapters = result.chapters || [{ title: "Beginning", pageIndex: 0 }];
    if (sleepTimerMode === 'chapter') clearSleepTimer(); // saved chapter boundary belongs to the old document

    currentPage = 0;
    currentSentenceIdx = 0;
    learnedCadenceMultiplier = cadenceByVoice.get(voiceCadenceKey()) || 1.0;
    preloadStatus.textContent = "Ready";
    await refreshCurrentDocAnnotations();
    renderPage(0);

    if (signedIn) {
      requestPersistentStorage();
      saveBookToShelf(currentDocName, bookPages, bookChapters);
      showFullAccessNotice();
    } else {
      requestPersistentStorage();
      saveBookToShelfFreemium(currentDocName, bookPages, bookChapters);
      showTeaserAccessNotice();
    }
  } catch (err) {
    preloadStatus.textContent = "Error";
    alert(err.message);
    renderPage(currentPage);
  } finally {
    fileInput.value = '';
  }
}

async function importWebArticle(url) {
  if (!url || typeof url !== 'string') return;
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) {
    alert('Please enter a valid HTTP or HTTPS article URL.');
    return;
  }

  stopAudio();
  preloadStatus.textContent = 'Fetching article...';
  contentPane.innerHTML = `<div style="text-align:center; padding:3rem; color:var(--text-muted); font-style:italic;">Extracting article from ${escapeHtml(url)}...</div>`;

  try {
    const res = await fetch('/api/extract-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Failed to extract article from URL.');
    }

    const title = data.title || 'Web Article';
    const contentText = data.contentText || '';
    if (!contentText.trim()) {
      throw new Error('No readable article text found at this URL.');
    }

    currentDocName = title;
    docTitle.textContent = currentDocName;

    const sents = splitIntoSentences(contentText);
    if (sents.length === 0) throw new Error('Document is empty.');

    const pages = [];
    for (let i = 0; i < sents.length; i += 5) {
      pages.push(sents.slice(i, i + 5));
    }
    bookPages = pages;
    bookChapters = [{ title: title, pageIndex: 0 }];
    if (sleepTimerMode === 'chapter') clearSleepTimer();

    currentPage = 0;
    currentSentenceIdx = 0;
    learnedCadenceMultiplier = cadenceByVoice.get(voiceCadenceKey()) || 1.0;
    preloadStatus.textContent = 'Ready';
    await refreshCurrentDocAnnotations();
    renderPage(0);

    const signedIn = await isUserSignedIn();
    requestPersistentStorage();
    if (signedIn) {
      saveBookToShelf(currentDocName, bookPages, bookChapters);
      showFullAccessNotice();
    } else {
      saveBookToShelfFreemium(currentDocName, bookPages, bookChapters);
      showTeaserAccessNotice();
    }
  } catch (err) {
    preloadStatus.textContent = 'Error';
    alert(err.message);
    renderPage(currentPage);
  }
}

fileInput.addEventListener('change', async (event) => {
  const file = event.target.files && event.target.files[0];
  if (file) await loadDocumentFile(file);
});

// PWA SHARE TARGET HANDOFF
function readAndClearShareHandoff() {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    try {
      const openReq = indexedDB.open('MarginaliaShareHandoff', 1);
      openReq.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('handoff')) {
          db.createObjectStore('handoff');
        }
      };
      openReq.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('handoff', 'readwrite');
        const store = tx.objectStore('handoff');
        const getReq = store.get('latest');
        getReq.onsuccess = () => {
          const result = getReq.result;
          store.delete('latest');
          tx.oncomplete = () => { db.close(); resolve(result); };
        };
        getReq.onerror = () => { db.close(); resolve(null); };
      };
      openReq.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function checkShareHandoff() {
  try {
    if (typeof window === 'undefined' || !window.location) return;
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('shared') !== '1') return;

    if (window.history && window.history.replaceState) {
      const cleanSearch = window.location.search
        .replace(/([?&])shared=1(&|$)/, '$1')
        .replace(/[?&]$/, '');
      const newUrl = window.location.pathname + (cleanSearch ? (cleanSearch.startsWith('?') ? cleanSearch : '?' + cleanSearch) : '');
      window.history.replaceState({}, '', newUrl || '/');
    }

    const handoff = await readAndClearShareHandoff();
    if (!handoff) return;

    if (handoff.file && handoff.file.buffer) {
      const file = new File([handoff.file.buffer], handoff.file.name || 'Shared Document', {
        type: handoff.file.type || 'application/octet-stream'
      });
      await loadDocumentFile(file);
    } else if (handoff.url) {
      await importWebArticle(handoff.url);
    } else if (handoff.text) {
      const rawUrlMatch = handoff.text.match(/https?:\/\/[^\s]+/i);
      if (rawUrlMatch) {
        await importWebArticle(rawUrlMatch[0]);
      } else {
        const blob = new Blob([handoff.text], { type: 'text/plain' });
        const file = new File([blob], (handoff.title || 'Shared Note') + '.txt', { type: 'text/plain' });
        await loadDocumentFile(file);
      }
    }
  } catch (err) {
    console.error('Failed to process shared handoff:', err);
  }
}

// STARTUP PREFERENCES RESTORATION
const savedTheme = localStorage.getItem('marginalia_theme') || 'parchment';
document.documentElement.setAttribute('data-theme', savedTheme);
optionThemeSelect.value = savedTheme;

const savedFont = localStorage.getItem('marginalia_font_face') || 'serif';
fontSelect.value = savedFont;
applyFontFace(savedFont);

const savedFontSize = localStorage.getItem('marginalia_font_size') || '1.15rem';
fontSizeSelect.value = savedFontSize;
document.documentElement.style.setProperty('--reader-font-size', savedFontSize);
document.querySelectorAll('.book-content, .text-content').forEach((el) => {
  el.style.lineHeight = '1.75';
});

const savedHighlight = localStorage.getItem('marginalia_highlight_mode') || 'word';
highlightMode = savedHighlight;
highlightModeSelect.value = savedHighlight;

const savedBionic = localStorage.getItem('marginalia_bionic_mode') || 'off';
bionicMode = savedBionic;
if (bionicModeSelect) bionicModeSelect.value = savedBionic;

const savedRuler = localStorage.getItem('marginalia_pacing_ruler') || 'off';
pacingRulerMode = savedRuler;
if (pacingRulerSelect) pacingRulerSelect.value = savedRuler;
document.body.classList.toggle('pacing-ruler-active', pacingRulerMode === 'active');

const savedPdfCleanup = localStorage.getItem('marginalia_smart_pdf_cleanup');
smartPdfCleanup = savedPdfCleanup !== 'off';
if (smartPdfCleanupSelect) smartPdfCleanupSelect.value = smartPdfCleanup ? 'on' : 'off';

const savedCalibration = localStorage.getItem('marginalia_sync_calibration');
if (savedCalibration) {
  userManualCalibration = parseFloat(savedCalibration) || 1.0;
  karaokeCalibrationSlider.value = userManualCalibration;
  updateSyncCalibrationLabel(userManualCalibration);
}

// Bottom dock: restore the saved volume and prime the time display.
volumeSlider.value = String(Math.round(playbackVolume * 100));
volumeToggleBtn.textContent = playbackVolume === 0 ? '🔇' : '🔊';
audioElement.volume = playbackVolume;

initIndexedDB().then(() => {
  refreshCurrentDocAnnotations().then(() => renderPage(0)).catch(() => renderPage(0));
  checkShareHandoff();
}).catch(() => {
  renderPage(0);
  checkShareHandoff();
});
populateVoices();
updateAuthBadge();
updateSleepTimerUI();
refreshProPriceLabels();
confirmCheckoutReturn();

// Background sync triggers: the device coming back online, and the page becoming visible again (a
// phone that slept through a reconnect never fires 'online'). Debounced so switching tabs does not
// hammer the API. Both reading positions and bookmarks catch up here.
let backgroundSyncTimer = null;
function scheduleBackgroundSync(delay = 0) {
  if (backgroundSyncTimer) return;
  backgroundSyncTimer = setTimeout(() => {
    backgroundSyncTimer = null;
    flushPendingProgress();
    syncBookmarksFromCloud();
  }, delay);
}
window.addEventListener('online', () => scheduleBackgroundSync());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scheduleBackgroundSync(5000);
});

// Pull the account's reading positions once the local shelf is readable. Deliberately not awaited:
// IndexedDB may never open, and sync is never allowed to hold up the first render. The flush runs
// after the pull so a position written offline last session reaches the cloud on this launch.
initIndexedDB().then(() => {
  restoreProgressFromCloud().then(() => { flushPendingProgress(); });
  syncBookmarksFromCloud();
});

// --- RETURN FROM PAYSTACK ---
// Checkout sends the buyer back to "/" with ?trxref=…&reference=…. The webhook is what grants the
// plan and it can land a second or two after the redirect, so confirm the payment arrived and then
// watch the profile until the upgrade appears, rather than dropping them on an unchanged page.
async function confirmCheckoutReturn() {
  const params = new URLSearchParams(window.location.search);
  const reference = params.get('reference') || params.get('trxref');
  if (!reference) return;

  // One announcement per payment: strip the params so a reload or a shared link cannot replay it
  history.replaceState(null, '', window.location.pathname + window.location.hash);

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session?.user) {
    showToast('Payment received — sign in with the address you paid with to see your plan.');
    return;
  }

  showToast('Payment received — activating your plan…');

  // Poll rather than wait on the webhook: it is the thing that credits the account, and this is
  // only watching for the result.
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const { data: profile } = await supabaseClient
      .from('profiles')
      .select('tier, pro_tier, pro_expires_at')
      .eq('id', session.user.id)
      .maybeSingle();
    if (profile && isProActiveClient(profile)) {
      const name = planTierName(profile.pro_tier, PLAN_ALLOWANCES[profile.pro_tier]?.name || 'Pro');
      const until = new Date(profile.pro_expires_at)
        .toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      showToast(`✅ Payment confirmed — you are on ${name} until ${until}.`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  showToast('Payment received. If your plan is not showing yet, refresh in a minute — your charge is safe.');
}
