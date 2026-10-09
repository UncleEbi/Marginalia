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

// --- PWA SERVICE WORKER & INSTALL ---
let deferredPrompt = null;
const navInstallPwa = document.getElementById('navInstallPwa');

if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW registration failed:', err));
  });
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (navInstallPwa) navInstallPwa.style.display = 'flex';
});

if (navInstallPwa) {
  navInstallPwa.addEventListener('click', async () => {
    closeDrawer();
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') navInstallPwa.style.display = 'none';
      deferredPrompt = null;
    } else {
      alert("To install Marginalia, tap Share in Safari or the three dots in Chrome, then select 'Add to Home Screen'.");
    }
  });
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

// --- COLLAPSIBLE VOICE BAR ---
const controlsToggleBar = document.getElementById('controlsToggleBar');
const controlsBody = document.getElementById('controlsBody');
const toggleCaret = document.getElementById('toggleCaret');
const activeVoiceBadge = document.getElementById('activeVoiceBadge');

controlsToggleBar.addEventListener('click', () => {
  const isCollapsed = controlsBody.classList.toggle('collapsed');
  toggleCaret.textContent = isCollapsed ? 'Settings ▾' : 'Hide ▴';
});

// --- INDEXEDDB STORAGE ---
const DB_NAME = "MarginaliaBookDB";
const DB_VERSION = 1;
let dbInstance = null;

function initIndexedDB() {
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("books")) {
        db.createObjectStore("books", { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("bookmarks")) {
        db.createObjectStore("bookmarks", { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = (e) => {
      dbInstance = e.target.result;
      resolve(dbInstance);
    };
    req.onerror = () => resolve(null);
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

// Sync progress to cloud when logged in, fallback to local storage
async function syncProgressToCloud(title, page, sentenceIdx) {
  // Always update local IndexedDB first
  await updateBookProgressInDB(title, page, sentenceIdx);

  if (!supabaseClient) return;
  const token = await getFreshAuthToken();
  if (!token) return;

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session?.user) return;

  await supabaseClient.from('user_books').upsert({
    user_id: session.user.id,
    title: title,
    current_page: page,
    current_sentence: sentenceIdx,
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id,title' }).catch(() => {});
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

async function initiateProUpgrade() {
  const token = await getFreshAuthToken();
  if (!token || !supabaseClient) {
    authModal.style.display = 'flex';
    return;
  }

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session?.user) {
    authModal.style.display = 'flex';
    return;
  }

  try {
    const res = await fetch('/api/paystack-init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: session.user.email,
        userId: session.user.id
      })
    });

    const data = await res.json();
    if (data.authorization_url) {
      window.location.href = data.authorization_url;
    } else {
      alert(data.error || 'Could not start checkout.');
    }
  } catch (err) {
    alert('Payment checkout error: ' + err.message);
  }
}

// Attach to upgrade buttons
document.getElementById('profileUpgradeBtn')?.addEventListener('click', initiateProUpgrade);
document.getElementById('upgradeProBtn')?.addEventListener('click', initiateProUpgrade);

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
        store.put(book);
      }
    };
  } catch (e) {}
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

const browserSpeech = window.speechSynthesis;
let currentUtterance = null;
const audioElement = document.getElementById('neuralAudio');
const silentAudioLoop = document.getElementById('silentAudioLoop');
const audioPreloadCache = new Map();

// Selection elements
const selectionPopover = document.getElementById('selectionPopover');
const btnSelectionSpeak = document.getElementById('btnSelectionSpeak');
const btnSelectionDefine = document.getElementById('btnSelectionDefine');
const btnSelectionCopy = document.getElementById('btnSelectionCopy');
let currentSelectedText = "";

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
    if (playing && activeEngine === 'browser') {
      if (!keepAliveAudio) {
        keepAliveAudio = new Audio(makeSilentWavUrl());
        keepAliveAudio.loop = true;
      }
      keepAliveAudio.play().catch(() => {});
    } else if (keepAliveAudio) {
      keepAliveAudio.pause();
    }
  } catch (e) {}
}

function skipSentence(delta) {
  const wasPlaying = isPlaying;
  isPlaying = false;
  if (currentUtterance) { currentUtterance.onend = null; currentUtterance.onerror = null; }
  audioElement.onended = null;
  browserSpeech.cancel();
  audioElement.pause();
  cancelWordAnimation();

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

(function registerMediaSessionHandlers() {
  if (!('mediaSession' in navigator)) return;
  const set = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch (e) {} };
  set('play', () => { if (!isPlaying) { isPlaying = true; playCurrentSentence(); } });
  set('pause', () => stopAudio());
  set('stop', () => stopAudio());
  set('previoustrack', () => skipSentence(-1));
  set('nexttrack', () => skipSentence(1));
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

btnSelectionSpeak.addEventListener('click', (e) => {
  e.stopPropagation();
  selectionPopover.style.display = 'none';
  if (!currentSelectedText) return;
  stopAudio();
  if (activeEngine === 'browser') {
    const utter = new SpeechSynthesisUtterance(currentSelectedText);
    utter.rate = playbackSpeed;
    const voices = browserSpeech.getVoices();
    if (voices.length > 0 && voicePicker.value && voicePicker.value !== "default") {
      const v = voices.find(vx => (vx.voiceURI === voicePicker.value) || (`${vx.name}:::${vx.lang}` === voicePicker.value));
      if (v) { utter.voice = v; utter.lang = v.lang; }
    }
    browserSpeech.speak(utter);
  } else {
    speakServerless(currentSelectedText);
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
    alert(`📖 "${cleanWord}" (${part}):\n\n${def}`);
  } catch (err) {
    alert(`Could not find a dictionary entry for "${cleanWord}".`);
  }
});

btnSelectionCopy.addEventListener('click', (e) => {
  e.stopPropagation();
  selectionPopover.style.display = 'none';
  navigator.clipboard.writeText(currentSelectedText);
  alert("Text copied to clipboard!");
});

// --- DRAWER CONTROLLER ---
function openDrawer() {
  sideDrawer.classList.add('open');
  drawerOverlay.classList.add('active');
}
function closeDrawer() {
  sideDrawer.classList.remove('open');
  drawerOverlay.classList.remove('active');
}

openDrawerBtn.addEventListener('click', openDrawer);
closeDrawerBtn.addEventListener('click', closeDrawer);
drawerOverlay.addEventListener('click', closeDrawer);

// --- SHELF & RECENT MODALS ---
async function showShelfModal(mode = "shelf") {
  closeDrawer();
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
          <span class="shelf-card-title">${b.title}</span>
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
          showShelfModal(mode);
        }
      });

      card.addEventListener('click', () => {
        stopAudio();
        bookPages = b.pages;
        bookChapters = b.chapters || [{ title: "Beginning", pageIndex: 0 }];
        currentDocName = b.title;
        currentPage = b.currentPage || 0;
        currentSentenceIdx = b.currentSentenceIdx || 0;
        docTitle.textContent = currentDocName;
        shelfModal.style.display = 'none';
        renderPage(currentPage);
      });

      document.addEventListener('visibilitychange', () => {
  if (!document.hidden && isPlaying && activeEngine === 'browser') {
    syncMediaSessionState(true);
  }
});
      
      shelfModalList.appendChild(card);
    });
  }
  shelfModal.style.display = 'flex';
}

navRecentList.addEventListener('click', () => showShelfModal("recent"));
navMyShelf.addEventListener('click', () => showShelfModal("shelf"));
navUploadFile.addEventListener('click', () => {
  closeDrawer();
  fileInput.value = '';
  fileInput.click();
});

// --- BOOKMARKS ---
addBookmarkBtn.addEventListener('click', async () => {
  const activeItem = bookPages[currentPage]?.[currentSentenceIdx];
  const snippet = typeof activeItem === 'string' ? activeItem : (activeItem?.caption || "Diagram");
  await saveBookmarkToDB(currentDocName, currentPage, currentSentenceIdx, snippet);
  alert(`Bookmark saved: Page ${currentPage + 1}`);
});

navBookmarks.addEventListener('click', async () => {
  closeDrawer();
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
          <span class="shelf-card-title">${m.bookTitle} — Page ${m.page + 1}</span>
          <span class="shelf-card-sub" style="font-style:italic;">"${m.snippet.slice(0, 42)}..."</span>
        </div>
        <span style="font-size:0.8rem; color:var(--accent); font-weight:600;">Jump →</span>
      `;
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
});

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
        <span>${ch.title}</span>
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
  karaokeCalibrationContainer.style.display = highlightMode === 'word' ? 'block' : 'none';
  customOpenAiKeyInput.value = localStorage.getItem('marginalia_byok_openai') || '';
  customElevenKeyInput.value = localStorage.getItem('marginalia_byok_eleven') || '';
  karaokeCalibrationSlider.value = userManualCalibration;
  updateSyncCalibrationLabel(userManualCalibration);
  optionsModal.style.display = 'flex';
}

btnDrawerNightToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  const nextTheme = current === 'dark' ? 'oled' : (current === 'oled' ? 'sepia' : (current === 'sepia' ? 'light' : 'dark'));
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

function applyFontFace(val) {
  contentPane.style.fontFamily = val === 'serif' ? 'var(--font-reader)' :
    val === 'monospace' ? 'monospace' : 'var(--font-ui)';
}

fontSelect.addEventListener('change', (e) => {
  applyFontFace(e.target.value);
  localStorage.setItem('marginalia_font_face', e.target.value);
});

fontSizeSelect.addEventListener('change', (e) => {
  document.documentElement.style.setProperty('--reader-font-size', e.target.value);
  localStorage.setItem('marginalia_font_size', e.target.value);
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

  applyFontFace(selectedFont);
  document.documentElement.style.setProperty('--reader-font-size', selectedSize);
  document.documentElement.setAttribute('data-theme', selectedTheme);
  highlightMode = selectedHighlight;
  userManualCalibration = parseFloat(calib) || 1.0;

  highlightActiveSentence();
  updateAuthBadge();

  saveOptionsBtn.textContent = '✓ Saved!';
  setTimeout(() => {
    saveOptionsBtn.textContent = 'Save & Done';
    closeModalById('optionsModal');
  }, 350);
});

// --- PROFILE & AUTHENTICATION CONTROLLER ---
async function openProfileModal() {
  if (!supabaseClient) {
    authModal.style.display = 'flex';
    return;
  }
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session || !session.user) {
    authStatusAlert.style.display = 'none';
    authModal.style.display = 'flex';
    return;
  }

  const user = session.user;
  const email = user.email || 'Reader';
  const initial = email.charAt(0).toUpperCase();

  profileModalAvatar.textContent = initial;
  profileModalEmail.textContent = email;

  const { data: profile } = await supabaseClient
    .from('profiles')
    .select('neural_chars_remaining, summary_credits_remaining, tier')
    .eq('id', user.id)
    .maybeSingle();

  const tier = profile?.tier || 'free';
  profileModalTier.textContent = tier === 'pro' ? '🌟 Pro Subscriber' : '⚡ Free Trial Account';

  const chars = profile?.neural_chars_remaining ?? 5000;
  profileNeuralCount.textContent = `${chars.toLocaleString()} / 5,000 Chars`;
  const fillPct = Math.max(0, Math.min(100, (chars / 5000) * 100));
  profileNeuralProgress.style.width = `${fillPct}%`;

  const summaries = profile?.summary_credits_remaining ?? 3;
  profileSummaryCount.textContent = `${summaries} Remaining`;

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
  if (!supabaseClient) {
    authModal.style.display = 'flex';
    return;
  }
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session && session.user) {
    openProfileModal();
  } else {
    authStatusAlert.style.display = 'none';
    authModal.style.display = 'flex';
  }
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
  paywallModal.style.display = 'flex';
});

profileSignOutBtn.addEventListener('click', async () => {
  if (confirm("Are you sure you want to sign out of your account?")) {
    if (supabaseClient) {
      await supabaseClient.auth.signOut().catch(() => {});
    }
    localStorage.removeItem('marginalia_auth_token');
    localStorage.removeItem('marginalia_auth_user');
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
    } catch (e) {}
  }
  return cachedToken || null;
}

async function updateAuthBadge(explicitRemaining = null) {
  const hasByok = Boolean(localStorage.getItem('marginalia_byok_openai') || localStorage.getItem('marginalia_byok_eleven'));
  if (hasByok) {
    creditDisplay.innerHTML = `<span class="user-avatar-mini">🔑</span> BYOK Active`;
  }

  if (!supabaseClient) {
    if (!hasByok) creditDisplay.textContent = "⚡ Free Tier";
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
      creditDisplay.innerHTML = `<span class="user-avatar-mini">${initial}</span> BYOK Active`;
      return;
    }

    if (explicitRemaining !== null) {
      creditDisplay.innerHTML = `<span class="user-avatar-mini">${initial}</span>${explicitRemaining.toLocaleString()}`;
      return;
    }

    const { data: profile } = await supabaseClient
      .from('profiles')
      .select('neural_chars_remaining')
      .eq('id', session.user.id)
      .maybeSingle();

    const remaining = profile ? profile.neural_chars_remaining : 5000;
    creditDisplay.innerHTML = `<span class="user-avatar-mini">${initial}</span>${remaining.toLocaleString()}`;
  } else {
    if (!hasByok) creditDisplay.textContent = "Sign In";
    drawerUserTitle.textContent = "Marginalia Library";
    drawerUserSubtitle.textContent = "Tap to sign in";
  }
}

authSignInBtn.addEventListener('click', async () => {
  authStatusAlert.style.display = 'none';
  if (!supabaseClient) {
    showAuthAlert("Supabase credentials not configured in app.js.", "error");
    return;
  }
  const email = authEmail.value.trim();
  const password = authPass.value;
  if (!email || !password) {
    showAuthAlert("Please enter both email and password.", "error");
    return;
  }

  authSignInBtn.disabled = true;
  authSignInBtn.textContent = "Signing in...";
  try {
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) {
      if (error.message.toLowerCase().includes('email not confirmed')) {
        showAuthAlert("Email not confirmed. Check your email inbox or turn off 'Confirm email' in Supabase Dashboard (Authentication -> Providers -> Email).", "error");
      } else {
        showAuthAlert(error.message, "error");
      }
    } else {
      if (data?.session?.access_token) {
        localStorage.setItem('marginalia_auth_token', data.session.access_token);
        localStorage.setItem('marginalia_auth_user', JSON.stringify(data.session.user));
      }
      showAuthAlert("Success! Signed in.", "success");
      setTimeout(() => {
        authModal.style.display = 'none';
        updateAuthBadge();
      }, 500);
    }
  } catch (err) {
    showAuthAlert(err.message, "error");
  } finally {
    authSignInBtn.disabled = false;
    authSignInBtn.textContent = "Sign In";
  }
});

authSignUpBtn.addEventListener('click', async () => {
  authStatusAlert.style.display = 'none';
  if (!supabaseClient) {
    showAuthAlert("Supabase credentials not configured in app.js.", "error");
    return;
  }
  const email = authEmail.value.trim();
  const password = authPass.value;
  if (!email || !password) {
    showAuthAlert("Please enter both email and password.", "error");
    return;
  }

  authSignUpBtn.disabled = true;
  authSignUpBtn.textContent = "Signing up...";
  try {
    const { data, error } = await supabaseClient.auth.signUp({ email, password });
    if (error) {
      showAuthAlert(error.message, "error");
    } else if (data?.user && !data?.session) {
      showAuthAlert("Account created! Check your email inbox to confirm your email, or turn off 'Confirm email' in Supabase Dashboard (Authentication -> Providers -> Email) to sign in immediately.", "info");
    } else {
      if (data?.session?.access_token) {
        localStorage.setItem('marginalia_auth_token', data.session.access_token);
        localStorage.setItem('marginalia_auth_user', JSON.stringify(data.session.user));
      }
      showAuthAlert("Account created & signed in!", "success");
      setTimeout(() => {
        authModal.style.display = 'none';
        updateAuthBadge();
      }, 500);
    }
  } catch (err) {
    showAuthAlert(err.message, "error");
  } finally {
    authSignUpBtn.disabled = false;
    authSignUpBtn.textContent = "Sign Up";
  }
});

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
          const { data: profile } = await supabaseClient.from('profiles').select('summary_credits_remaining, tier').eq('id', session.user.id).maybeSingle();
          if (profile) {
            if (profile.tier === 'pro') notice = "Plan: Pro (unlimited AI summaries)";
            else {
              const trials = profile.summary_credits_remaining ?? 3;
              notice = trials > 0 ? `Free trial: ${trials} AI summaries left` : "AI trial used up: offline summary active";
            }
          }
        }
      } catch (e) {}
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
          if (SUPABASE_PROJECT_URL && !SUPABASE_PROJECT_URL.includes("your-project")) {
            headers['x-supabase-url'] = SUPABASE_PROJECT_URL;
            headers['x-supabase-key'] = SUPABASE_ANON_KEY;
          }
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
            showToast("AI trial balance exhausted. Using offline summary.");
          } else if (res.ok && data && data.summary) {
            summary = data.summary;
            label = 'AI Summary';
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
    renderPage(currentPage);
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

function cancelWordAnimation() {
  if (wordAnimFrameId) {
    cancelAnimationFrame(wordAnimFrameId);
    wordAnimFrameId = null;
  }
}

// --- DOM BUILDERS ---
function buildSentenceDOM(sentenceText, sIdx) {
  const span = document.createElement('span');
  span.className = 'sentence';
  span.id = `sent-${sIdx}`;

  const words = sentenceText.split(/(\s+)/);
  let wordCount = 0;

  words.forEach(chunk => {
    if (chunk.trim().length > 0) {
      const wSpan = document.createElement('span');
      wSpan.className = 'word';
      wSpan.id = `w-${sIdx}-${wordCount}`;
      wSpan.textContent = chunk;
      span.appendChild(wSpan);
      wordCount++;
    } else {
      span.appendChild(document.createTextNode(chunk));
    }
  });

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
  const items = bookPages[idx] || [];

  items.forEach((item, sIdx) => {
    if (typeof item === 'object' && item.type === 'image') {
      contentPane.appendChild(buildDiagramDOM(item, sIdx));
    } else {
      contentPane.appendChild(buildSentenceDOM(item, sIdx));
    }
  });

  pageIndicatorText.innerHTML = `Page ${idx + 1} of${bookPages.length} <span style="font-size:0.68rem; opacity:0.7;">▾</span>`;
  const currentCh = getCurrentChapter();
  chapterIndicatorText.textContent = currentCh.title;

  prevPageBtn.disabled = idx === 0;
  nextPageBtn.disabled = idx >= bookPages.length - 1;
  highlightActiveSentence();
  updateBookProgressInDB(currentDocName, currentPage, currentSentenceIdx);
  updateMediaMetadata();
}

function highlightActiveSentence() {
  document.querySelectorAll('.sentence').forEach(el => el.classList.remove('active-sentence'));
  document.querySelectorAll('.reader-diagram').forEach(el => el.classList.remove('active-diagram'));
  document.querySelectorAll('.word').forEach(el => el.classList.remove('active-word'));

  if (highlightMode === 'none') return;

  const target = document.getElementById(`sent-${currentSentenceIdx}`);
  if (target) {
    if (target.classList.contains('reader-diagram')) {
      target.classList.add('active-diagram');
    } else {
      target.classList.add('active-sentence');
    }
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function highlightActiveWord(wIdx) {
  if (highlightMode !== 'word') {
    document.querySelectorAll('.word.active-word').forEach(el => el.classList.remove('active-word'));
    return;
  }
  document.querySelectorAll(`#sent-${currentSentenceIdx} .word`).forEach((el, index) => {
    if (index === wIdx) el.classList.add('active-word');
    else el.classList.remove('active-word');
  });
}

// --- PLAYBACK ENGINE ---
async function playCurrentSentence() {
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
  browserSpeech.cancel();
  cancelWordAnimation();

  currentUtterance = new SpeechSynthesisUtterance(text);
  currentUtterance.rate = playbackSpeed;

  const voices = browserSpeech.getVoices();
  if (voices.length > 0 && voicePicker.value && voicePicker.value !== "default") {
    const selectedVoice = voices.find(v => (v.voiceURI === voicePicker.value) || (`${v.name}:::${v.lang}` === voicePicker.value));
    if (selectedVoice) {
      currentUtterance.voice = selectedVoice;
      currentUtterance.lang = selectedVoice.lang;
    }
  }

  const wordsArr = text.trim().split(/\s+/).filter(w => w.length > 0);
  const computed = computeWordTimeline(wordsArr, playbackSpeed);
  const timeline = computed.timeline;
  estimatedSentenceDurationMs = computed.totalEstMs;

  let boundaryCount = 0;
  let usingNativeBoundaries = false;

  currentUtterance.onboundary = (e) => {
    if (e.name === 'word') {
      boundaryCount++;
      if (boundaryCount > 1) {
        usingNativeBoundaries = true;
        cancelWordAnimation();
      }
      if (highlightMode === 'word') {
        const words = text.slice(0, e.charIndex).trim().split(/\s+/);
        highlightActiveWord(words[0] === "" ? 0 : words.length);
      }
    }
  };

  currentUtterance.onstart = () => {
    if (highlightMode === 'word') highlightActiveWord(0);
    sentenceSpeechStartTime = performance.now();

    const leadInDelayMs = 180 / playbackSpeed;

    function renderFrame() {
      if (!isPlaying || usingNativeBoundaries || highlightMode !== 'word') return;
      const elapsedMs = performance.now() - sentenceSpeechStartTime;
      const effectiveElapsedSec = Math.max(0, (elapsedMs - leadInDelayMs) / 1000);

      let activeIdx = 0;
      for (let i = 0; i < timeline.length; i++) {
        if (effectiveElapsedSec >= timeline[i].start) {
          activeIdx = i;
        } else {
          break;
        }
      }
      highlightActiveWord(activeIdx);

      if (elapsedMs < estimatedSentenceDurationMs + 1200) {
        wordAnimFrameId = requestAnimationFrame(renderFrame);
      }
    }

    if (highlightMode === 'word') {
      wordAnimFrameId = requestAnimationFrame(renderFrame);
    }
  };

  currentUtterance.onend = () => {
    cancelWordAnimation();

    if (sentenceSpeechStartTime && estimatedSentenceDurationMs > 400) {
      const actualElapsedMs = performance.now() - sentenceSpeechStartTime;
      const observedRatio = actualElapsedMs / estimatedSentenceDurationMs;
      if (observedRatio >= 0.65 && observedRatio <= 1.6) {
        learnedCadenceMultiplier = (learnedCadenceMultiplier * 0.6) + (observedRatio * 0.4);
      }
    }

    if (!isPlaying) return;
    currentSentenceIdx++;
    playCurrentSentence();
  };

  currentUtterance.onerror = () => stopAudio();
  browserSpeech.speak(currentUtterance);
}

async function speakServerless(text) {
  try {
    const customOpenAi = localStorage.getItem('marginalia_byok_openai') || '';
    const customEleven = localStorage.getItem('marginalia_byok_eleven') || '';
    const token = await getFreshAuthToken();

    if (!token && !customOpenAi && !customEleven) {
      stopAudio();
      showAuthAlert("Please sign in or enter your custom API key in Options.", "error");
      authModal.style.display = 'flex';
      return;
    }

    const cacheKey = `${activeEngine}_${voicePicker.value}_${playbackSpeed}_${text}`;
    let cached = audioPreloadCache.get(cacheKey);
    let audioSrc = cached?.src;

    if (!audioSrc) {
      preloadStatus.textContent = "Connecting...";
      const headers = { 'Content-Type': 'application/json' };
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
        body: JSON.stringify({
          text,
          voiceId: voicePicker.value,
          engine: activeEngine,
          speed: playbackSpeed
        })
      });

      const data = await res.json().catch(() => ({}));

      if (res.status === 401) {
        updateAuthBadge();
        authModal.style.display = 'flex';
        showAuthAlert(data.error || "Session expired. Please sign in again.", "error");
        return;
      }

      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);

      audioSrc = data.audio_base64 
        ? `data:audio/mp3;base64,${data.audio_base64}`
        : (data.audioUrl || '');

      if (data.remaining_chars !== undefined) updateAuthBadge(data.remaining_chars);
    }

    audioElement.src = audioSrc;
    audioElement.playbackRate = playbackSpeed;
    await audioElement.play();

    const wordsArr = text.trim().split(/\s+/).filter(w => w.length > 0);
    let timeline = null;

    audioElement.ontimeupdate = () => {
      if (!timeline && audioElement.duration) {
        timeline = computeWordTimeline(wordsArr, playbackSpeed, audioElement.duration).timeline;
      }
      if (timeline && highlightMode === 'word') {
        const cur = audioElement.currentTime;
        let activeIdx = 0;
        for (let i = 0; i < timeline.length; i++) {
          if (cur >= timeline[i].start) {
            activeIdx = i;
          } else {
            break;
          }
        }
        highlightActiveWord(activeIdx);
      }
    };

    audioElement.onended = () => {
      if (!isPlaying) return;
      currentSentenceIdx++;
      playCurrentSentence();
    };

  } catch (err) {
    stopAudio();
    alert(err.message);
  }
}

function stopAudio() {
  isPlaying = false;
  mainPlayToggle.textContent = '▶';
  syncMediaSessionState(false);
  cancelWordAnimation();
  browserSpeech.cancel();
  audioElement.pause();
  document.querySelectorAll('.word').forEach(el => el.classList.remove('active-word'));
}

// --- CONTROLS HOOKS ---
mainPlayToggle.addEventListener('click', () => {
  if (isPlaying) stopAudio();
  else {
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
      browserSpeech.cancel();
      playCurrentSentence();
    } else {
      audioElement.playbackRate = playbackSpeed;
    }
  }
});

// --- VOICES & ENGINES ---
const voicePresets = {
  browser: [],
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
  ],
  azure: [
    { id: 'en-US-JennyNeural', name: 'Jenny (Neural US)' },
    { id: 'en-US-GuyNeural', name: 'Guy (Neural US)' },
    { id: 'en-GB-SoniaNeural', name: 'Sonia (Neural UK)' }
  ]
};

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
    const indexed = voices.map(v => v);

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
      return a.name.localeCompare(b.name);
    });

    const defVoice = indexed.find(v => v.lang.toLowerCase().startsWith('en')) || indexed[0];

    indexed.forEach(v => {
      const opt = document.createElement('option');
      const vKey = v.voiceURI || `${v.name}:::${v.lang}`;
      opt.value = vKey;
      opt.textContent = `${v.name} (${v.lang})`;

      if (prevChoice && vKey === prevChoice) {
        opt.selected = true;
      } else if (!prevChoice && defVoice && vKey === (defVoice.voiceURI || `${defVoice.name}:::${defVoice.lang}`)) {
        opt.selected = true;
      }
      voicePicker.appendChild(opt);
    });

    const selectedOption = voicePicker.options[voicePicker.selectedIndex];
    activeVoiceBadge.textContent = `🎙️ ${selectedOption ? selectedOption.text.split('(')[0].trim() : 'Native Voice'}`;
  } else {
    const list = voicePresets[activeEngine] || [];
    list.forEach(item => {
      const opt = document.createElement('option');
      opt.value = item.id;
      opt.textContent = item.name;
      if (item.id === prevChoice) opt.selected = true;
      voicePicker.appendChild(opt);
    });
    const selectedOption = voicePicker.options[voicePicker.selectedIndex];
    activeVoiceBadge.textContent = `⚡ ${selectedOption ? selectedOption.text : activeEngine}`;
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
  audioPreloadCache.clear();
  learnedCadenceMultiplier = 1.0;
  const selectedOption = voicePicker.options[voicePicker.selectedIndex];
  activeVoiceBadge.textContent = `${activeEngine === 'browser' ? '🎙️' : '⚡'} ${selectedOption ? selectedOption.text.split('(')[0].trim() : 'Voice'}`;
  
  if (isPlaying) {
    stopAudio();
    isPlaying = true;
    setTimeout(() => { playCurrentSentence(); }, 60);
  }
});

document.querySelectorAll('.engine-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.engine-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    activeEngine = tab.dataset.engine;
    audioPreloadCache.clear();
    learnedCadenceMultiplier = 1.0;
    populateVoices();
    if (isPlaying) {
      stopAudio();
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
      paywallModal.style.display = 'flex';
      renderPage(currentPage);
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

function splitIntoSentences(text) {
  if (!text || !text.trim()) return [];
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    try {
      const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
      const segments = Array.from(segmenter.segment(text));
      return segments.map(s => s.segment.replace(/\s+/g, ' ').trim()).filter(s => s.length > 0);
    } catch (e) {}
  }
  const matches = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [text];
  return matches.map(s => s.replace(/\s+/g, ' ').trim()).filter(s => s.length > 0);
}

function parseHtmlToBlocks(htmlString) {
  const doc = new DOMParser().parseFromString(htmlString, 'text/html');
  doc.querySelectorAll('script, style, head, nav, [role="doc-toc"]').forEach(el => el.remove());

  const blocks = [];
  const elements = doc.body ? Array.from(doc.body.children) : [];

  if (elements.length === 0) {
    const rawText = (doc.body ? doc.body.textContent : doc.documentElement.textContent) || '';
    return splitIntoSentences(rawText);
  }

  elements.forEach(el => {
    const imgs = el.querySelectorAll('img, image');
    if (el.tagName.toLowerCase() === 'img' || imgs.length > 0) {
      const imgEl = el.tagName.toLowerCase() === 'img' ? el : imgs[0];
      const src = imgEl.getAttribute('src');
      if (src && src.startsWith('data:')) {
        const caption = imgEl.getAttribute('alt') || el.querySelector('figcaption')?.textContent || '';
        blocks.push({ type: 'image', src, caption: caption.trim() });
        return;
      }
    }

    const txt = el.textContent.replace(/\s+/g, ' ').trim();
    if (txt.length > 0) {
      const sents = splitIntoSentences(txt);
      sents.forEach(s => blocks.push(s));
    }
  });

  return blocks.length > 0 ? blocks : splitIntoSentences(doc.body ? doc.body.textContent : '');
}

// --- EPUB EXTRACTOR WITH TABLE OF CONTENTS ---
async function parseEpubArchive(zip) {
  const allKeys = Object.keys(zip.files);
  const containerKey = allKeys.find(k => k.toLowerCase().endsWith('container.xml'));
  let opfKey = null;

  if (containerKey) {
    const containerXml = await zip.files[containerKey].async("text");
    const m = containerXml.match(/full-path=["']([^"']+)["']/i);
    if (m) {
      const target = m[1].trim();
      opfKey = allKeys.find(k => k.toLowerCase() === target.toLowerCase()) || target;
    }
  }
  if (!opfKey) opfKey = allKeys.find(k => k.toLowerCase().endsWith('.opf'));

  let orderedFiles = [];
  let manifest = {};

  if (opfKey && zip.files[opfKey]) {
    const opfXml = await zip.files[opfKey].async("text");
    const opfDir = opfKey.includes('/') ? opfKey.substring(0, opfKey.lastIndexOf('/') + 1) : '';

    const itemRegex = /<item\b[^>]*>/gi;
    let match;
    while ((match = itemRegex.exec(opfXml)) !== null) {
      const tag = match[0];
      const idMatch = tag.match(/\bid=["']([^"']+)["']/i);
      const hrefMatch = tag.match(/\bhref=["']([^"']+)["']/i);
      if (idMatch && hrefMatch) {
        const rawHref = decodeURIComponent(hrefMatch[1].split('#')[0]);
        const fullPath = (opfDir + rawHref).replace(/\/+/g, '/');
        const exact = allKeys.find(k => k.toLowerCase() === fullPath.toLowerCase()) || fullPath;
        manifest[idMatch[1]] = exact;
      }
    }

    const spineRegex = /<itemref\b[^>]*\bidref=["']([^"']+)["']/gi;
    while ((match = spineRegex.exec(opfXml)) !== null) {
      const idref = match[1];
      if (manifest[idref] && zip.files[manifest[idref]]) {
        orderedFiles.push(manifest[idref]);
      }
    }
  }

  if (orderedFiles.length === 0) {
    orderedFiles = allKeys.filter(k => {
      const lower = k.toLowerCase();
      return (lower.endsWith('.xhtml') || lower.endsWith('.html') || lower.endsWith('.htm')) &&
             !lower.includes('toc') && !lower.includes('nav') && !lower.endsWith('.ncx');
    }).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  }

  const chaptersList = [];
  const extractedPages = [];
  const perPage = 5;

  for (let fIdx = 0; fIdx < orderedFiles.length; fIdx++) {
    const chapterKey = orderedFiles[fIdx];
    if (!zip.files[chapterKey] || zip.files[chapterKey].dir) continue;

    const rawHtml = await zip.files[chapterKey].async("text");
    const chapterDir = chapterKey.includes('/') ? chapterKey.substring(0, chapterKey.lastIndexOf('/') + 1) : '';

    let chapTitle = "";
    const titleMatch = rawHtml.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i) || rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) {
      chapTitle = titleMatch[1].replace(/<[^>]+>/g, '').trim();
    }
    if (!chapTitle || chapTitle.length < 2) {
      chapTitle = `Section ${fIdx + 1}`;
    }

    const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
    const images = Array.from(doc.querySelectorAll('img, image'));

    for (const img of images) {
      const srcAttr = img.getAttribute('src') || img.getAttribute('xlink:href');
      if (!srcAttr || srcAttr.startsWith('data:') || srcAttr.startsWith('http')) continue;

      const resolved = normalizeZipPath(chapterDir, decodeURIComponent(srcAttr.split('#')[0]));
      const matchedImgKey = allKeys.find(k => k.toLowerCase() === resolved.toLowerCase()) || resolved;

      if (zip.files[matchedImgKey] && !zip.files[matchedImgKey].dir) {
        const ext = matchedImgKey.split('.').pop().toLowerCase();
        const mime = ext === 'png' ? 'image/png' : ext === 'svg' ? 'image/svg+xml' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        const base64Data = await zip.files[matchedImgKey].async('base64');
        img.setAttribute('src', `data:${mime};base64,${base64Data}`);
      }
    }

    const chapterBlocks = parseHtmlToBlocks(doc.body ? doc.body.innerHTML : rawHtml);
    if (chapterBlocks.length > 0) {
      const startPageIndex = extractedPages.length;
      chaptersList.push({ title: chapTitle, pageIndex: startPageIndex });

      for (let i = 0; i < chapterBlocks.length; i += perPage) {
        extractedPages.push(chapterBlocks.slice(i, i + perPage));
      }
    }
  }

  function decodeHtmlEntities(str) {
  if (!str) return '';
  const txt = document.createElement('textarea');
  txt.innerHTML = str;
  return txt.value;
}
  
  if (extractedPages.length === 0) {
    throw new Error("No readable text found in EPUB.");
  }

  return { pages: extractedPages, chapters: chaptersList };
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
    if (typeof pdfjsLib === 'undefined') throw new Error("PDF engine is still loading. Please try again.");
    const pdf = await pdfjsLib.getDocument({ data: uint8 }).promise;
    const pages = [];
    const chapters = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageStr = content.items.map(it => it.str).join(' ');
      if (pageStr.trim().length > 0) {
        const sents = splitIntoSentences(pageStr);
        if (sents.length > 0) {
          chapters.push({ title: `PDF Page ${i}`, pageIndex: pages.length });
          for (let s = 0; s < sents.length; s += 5) {
            pages.push(sents.slice(s, s + 5));
          }
        }
      }
    }
    if (pages.length === 0) throw new Error("No readable digital text found. This PDF may be a flat image scan.");
    return { pages, chapters };
  }

  if (lowerName.endsWith('.html') || lowerName.endsWith('.htm')) {
    const raw = new TextDecoder('utf-8').decode(uint8);
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

  const raw = new TextDecoder('utf-8').decode(uint8);
  const sents = splitIntoSentences(raw);
  if (sents.length === 0) throw new Error("Document is empty.");
  const pages = [];
  for (let i = 0; i < sents.length; i += 5) pages.push(sents.slice(i, i + 5));
  return { pages, chapters: [{ title: "Beginning", pageIndex: 0 }] };
}

function splitIntoSentences(text) {
  if (!text || !text.trim()) return [];

  // --- Clean raw HTML/XML entities here before splitting ---
  text = text
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    try {
      const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
      const segments = Array.from(segmenter.segment(text));
      return segments.map(s => s.segment.replace(/\s+/g, ' ').trim()).filter(s => s.length > 0);
    } catch (e) {}
  }
  const matches = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [text];
  return matches.map(s => s.replace(/\s+/g, ' ').trim()).filter(s => s.length > 0);
}

// PRIMARY FILE IMPORT LISTENER
fileInput.addEventListener('change', async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  stopAudio();
  currentDocName = file.name;
  docTitle.textContent = currentDocName;
  preloadStatus.textContent = "Opening...";
  contentPane.innerHTML = `<div style="text-align:center; padding:3rem; color:var(--text-muted); font-style:italic;">Processing "${file.name}"...</div>`;

  try {
    const result = await processUploadedDocument(file);
    bookPages = result.pages;
    bookChapters = result.chapters || [{ title: "Beginning", pageIndex: 0 }];

    currentPage = 0;
    currentSentenceIdx = 0;
    learnedCadenceMultiplier = 1.0;
    preloadStatus.textContent = "Ready";
    renderPage(0);
    saveBookToShelf(currentDocName, bookPages, bookChapters);

  } catch (err) {
    preloadStatus.textContent = "Error";
    alert(err.message);
    renderPage(currentPage);
  } finally {
    fileInput.value = '';
  }
});

// STARTUP PREFERENCES RESTORATION
const savedTheme = localStorage.getItem('marginalia_theme') || 'dark';
document.documentElement.setAttribute('data-theme', savedTheme);
optionThemeSelect.value = savedTheme;

const savedFont = localStorage.getItem('marginalia_font_face') || 'serif';
fontSelect.value = savedFont;
applyFontFace(savedFont);

const savedFontSize = localStorage.getItem('marginalia_font_size') || '1.15rem';
fontSizeSelect.value = savedFontSize;
document.documentElement.style.setProperty('--reader-font-size', savedFontSize);

const savedHighlight = localStorage.getItem('marginalia_highlight_mode') || 'word';
highlightMode = savedHighlight;
highlightModeSelect.value = savedHighlight;

const savedCalibration = localStorage.getItem('marginalia_sync_calibration');
if (savedCalibration) {
  userManualCalibration = parseFloat(savedCalibration) || 1.0;
  karaokeCalibrationSlider.value = userManualCalibration;
  updateSyncCalibrationLabel(userManualCalibration);
}

initIndexedDB();
populateVoices();
renderPage(0);
updateAuthBadge();
