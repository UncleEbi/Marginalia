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

// --- PWA SERVICE WORKER ---
// (The Install App drawer item is set up further down, in setupInstallDrawerItem.)
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloadedForUpdate = false;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then((reg) => { reg.update().catch(() => {}); }) // look for a new version on every launch
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

// Freemium teaser: save only page 1 data
function saveBookToShelfFreemium(title, pages, chapters = []) {
  if (!indexedDB) return;
  const db = indexedDB.open('marginalia-db', 1);
  db.onupgradeneeded = (e) => {
    const db = e.target.result;
    if (!db.objectStoreNames.contains('books')) {
      db.createObjectStore('books', { keyPath: 'id' });
    }
  };
  db.onsuccess = (e) => {
    const db = e.target.result;
    const tx = db.transaction('books', 'readwrite');
    const store = tx.objectStore('books');
    // For freemium, only store page 1 data, chapters limited to first chapter only
    const firstChapter = chapters.length > 0 ? chapters[0] : { title: 'Page 1', pageIndex: 0 };
    const book = { id: title + Date.now(), title, pages: [pages[0] || {}], chapters: [firstChapter], freemium: true, created: Date.now() };
    store.put(book);
    tx.complete;
  };
}

// Show teaser access notice (for unauthenticated users)
function showTeaserAccessNotice() {
  const notice = document.createElement('div');
  notice.style.cssText = `
    position: fixed;
    top: 2rem;
    left: 50%;
    transform: translateX(-50%);
    background: var(--card-bg);
    border: 1px solid var(--border-color);
    padding: 1rem 1.5rem;
    border-radius: var(--border-radius);
    z-index: 1000;
    max-width: 90%;
    font-size: 0.95rem;
    color: var(--text-primary);
    text-align: center;
    box-shadow: var(--shadow-sm);
    animation: slideIn 0.3s ease-out;
  `;
  notice.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: center;">
      <span style="margin-right: 0.5rem;">📖</span>
      <span>You're reading page 1 for free! Sign in to unlock chapters 2+</span>
    </div>
    <button id="signinBtn" style="margin-left: 1rem; padding: 0.5rem 1rem; background: var(--primary); color: white; border: none; border-radius: var(--border-radius); font-size: 0.85rem; cursor: pointer;">Sign in</button>
  `;
  notice.querySelector('#signinBtn').addEventListener('click', () => {
    closeModalById('signin-modal');
    openSignInDialog();
  });
  document.body.appendChild(notice);
  
  // Auto-remove after 5 seconds
  setTimeout(() => { notice.remove(); }, 5000);
}

// Show full access notice (for authenticated users)
function showFullAccessNotice() {
  const notice = document.createElement('div');
  notice.style.cssText = `
    position: fixed;
    top: 2rem;
    left: 50%;
    transform: translateX(-50%);
    background: var(--success-bg);
    border: 1px solid var(--success);
    padding: 1rem 1.5rem;
    border-radius: var(--border-radius);
    z-index: 1000;
    max-width: 90%;
    font-size: 0.95rem;
    color: var(--success-fg);
    text-align: center;
    box-shadow: var(--shadow-sm);
    animation: slideIn 0.3s ease-out;
  `;
  notice.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: center;">
      <span style="margin-right: 0.5rem;">✅</span>
      <span>Full document access - all chapters available</span>
    </div>
  `;
  document.body.appendChild(notice);
  
  setTimeout(() => { notice.remove(); }, 3000);
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

  try {
    await supabaseClient.from('user_books').upsert({
      user_id: session.user.id,
      title: title,
      current_page: page,
      current_sentence: sentenceIdx,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,title' });
  } catch (e) {}
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

// Pro is active while the account is tier 'pro' AND the expiry is in the future
// (mirrors isProActive in lib/pro-plan.js so the UI agrees with the server)
function isProActiveClient(profile) {
  if (!profile || profile.tier !== 'pro') return false;
  const exp = profile.pro_expires_at ? Date.parse(profile.pro_expires_at) : NaN;
  return Number.isFinite(exp) && exp > Date.now();
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
    profileUpgradeBtn.textContent = `🌟 Upgrade to Pro (${monthly.amount_display}/mo)`;
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

  // "Marginalia Pro — ₦12,000 / month (Approx. ~$9.00 USD · Billed in NGN)" so global visitors
  // aren't confused by the naira numbers. Every figure still comes from the server.
  const monthly = planById(data, data.default_plan);
  if (headline && monthly) {
    const usd = monthly.amount_usd_display;
    headline.innerHTML = `
      <span class="pro-price-main">Marginalia Pro — ${escapeHtml(monthly.amount_display)} / month</span>
      <span class="pro-price-detail">${usd ? `Approx. ~${escapeHtml(usd)} USD · ` : ''}Billed in ${escapeHtml(String(data.currency || 'NGN'))}</span>
    `;
    headline.style.display = '';
  }

  data.plans.forEach((plan) => {
    const btn = document.createElement('button');
    btn.className = 'pro-plan-option' + (plan.id === data.default_plan ? ' featured' : '');
    btn.innerHTML = `
      <span class="pro-plan-label">
        ${escapeHtml(plan.label)}${plan.note ? ` <em>· ${escapeHtml(plan.note)}</em>` : ''}
      </span>
      <span class="pro-plan-price-col">
        <span class="pro-plan-price">${escapeHtml(plan.amount_display)}</span>
        ${plan.amount_usd_display ? `<span class="pro-plan-price-usd">~${escapeHtml(plan.amount_usd_display)} USD</span>` : ''}
      </span>
    `;
    btn.addEventListener('click', () => initiateProUpgrade(plan.id));
    list.appendChild(btn);
  });
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
      }).catch(() => {});
    }
  } catch (e) {}
}

// Bumped on every stop/skip so late network responses and stale speech callbacks are ignored
let speakToken = 0;

function cancelAllSpeech() {
  speakToken++;
  currentUtterance = null;
  audioElement.onended = null;
  audioElement.ontimeupdate = null;
  audioElement.onloadedmetadata = null;
  browserSpeech.cancel();
  try { audioElement.pause(); } catch (e) {}
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
  } catch (e) {}
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

(function registerMediaSessionHandlers() {
  if (!('mediaSession' in navigator)) return;
  const set = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch (e) {} };
  set('play', () => { if (!isPlaying) { if (activeEngine !== 'browser') unlockAudioForIOS(); isPlaying = true; playCurrentSentence(); } });
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
      } catch (e) {}
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
        renderPage(currentPage);
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

async function showBookmarksModal() {
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
          if (!done) showToast('Could not delete the bookmark. Please try again.');
          showBookmarksModal(); // refresh the list
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
}

navBookmarks.addEventListener('click', () => {
  closeDrawer();
  showBookmarksModal();
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

// The Account window's HTML ships with demo values (U / user@example.com / Free Tier / 5,000 / 5,000).
// Wipe them so nobody ever sees a pretend account: on page load, on sign-out, and whenever nobody is signed in.
function resetProfileModalPlaceholders() {
  profileModalAvatar.textContent = '';
  profileModalEmail.textContent = '';
  profileModalTier.textContent = '';
  profileNeuralCount.textContent = '—';
  profileNeuralProgress.style.width = '0%';
  profileSummaryCount.textContent = '—';
  profileByokStatus.textContent = '—';
  profileByokStatus.style.color = 'var(--text-muted)';
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

  const { data: profile, error: profileError } = await supabaseClient
    .from('profiles')
    .select('neural_chars_remaining, summary_credits_remaining, tier, pro_expires_at')
    .eq('id', user.id)
    .maybeSingle();

  // A failed lookup must not be shown as real numbers (it used to fall back to a full 5,000 / 3)
  if (profileError) {
    profileModalTier.textContent = "Couldn't load your account details";
    profileNeuralCount.textContent = '—';
    profileNeuralProgress.style.width = '0%';
    profileSummaryCount.textContent = '—';
    const keys = Boolean(localStorage.getItem('marginalia_byok_openai') || localStorage.getItem('marginalia_byok_eleven'));
    profileByokStatus.textContent = keys ? 'Active (Keys Configured)' : 'None Added';
    profileModal.style.display = 'flex';
    return;
  }

  const tier = profile?.tier || 'free';
  if (tier === 'pro') {
    profileModalTier.textContent = isProActiveClient(profile)
      ? `🌟 Pro · until ${new Date(profile.pro_expires_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
      : '⚡ Free Trial Account (Pro expired)';
  } else {
    profileModalTier.textContent = '⚡ Free Trial Account';
  }

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
      await supabaseClient.auth.signOut().catch(() => {});
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
    } catch (e) {}
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
            if (isProActiveClient(profile)) notice = "Plan: Pro (unlimited AI summaries)";
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
            showToast("Free AI summaries used up. Using offline summary.");
          } else if (res.ok && data && data.summary) {
            summary = data.summary;
            label = 'AI Summary';
            // the server tells us exactly how many are left after this one
            if (data.unlimited) {
              profileSummaryCount.textContent = 'Unlimited';
            } else if (typeof data.summaries_remaining === 'number') {
              profileSummaryCount.textContent = `${data.summaries_remaining} Remaining`;
              showToast(data.summaries_remaining === 0
                ? "That was your last free AI summary."
                : `Free AI summaries left: ${data.summaries_remaining}`);
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
  if (src && src.startsWith('blob:')) { try { URL.revokeObjectURL(src); } catch (e) {} }
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

async function getNeuralAudioSrc(text) {
  const key = neuralCacheKey(text);
  const hit = audioPreloadCache.get(key);
  if (hit && hit.src) return hit.src;
  if (audioInflight.has(key)) return audioInflight.get(key);

  // capture settings now; they can change while we await
  // Always ask the server for normal-speed audio: speed is applied on the phone via playbackRate.
  // (Sending the speed too made the server-side voices play at speed x speed.)
  const engine = activeEngine, voiceId = voicePicker.value, speed = 1;

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
      src = URL.createObjectURL(blob);
    } else {
      // errors (and older servers) answer with JSON
      const data = await res.json().catch(() => ({}));

      if (res.status === 401) {
        const err = new Error(data.error || "Session expired. Please sign in again.");
        err.status = 401;
        throw err;
      }
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);

      src = data.audio_base64 ? base64ToBlobUrl(data.audio_base64) : (data.audioUrl || '');
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
    getNeuralAudioSrc(t).catch(() => {}); // best effort; the real play path reports errors
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
      const customOpenAi = localStorage.getItem('marginalia_byok_openai') || '';
      const customEleven = localStorage.getItem('marginalia_byok_eleven') || '';
      const token = await getFreshAuthToken();

      if (!token && !customOpenAi && !customEleven) {
        stopAudio();
        showAuthAlert("Please sign in or enter your custom API key in Options.", "error");
        authModal.style.display = 'flex';
        return;
      }

      preloadStatus.textContent = "Connecting...";
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
    } else {
      alert(err.message);
    }
  }
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
    const NOVELTY = new Set(['albert','bad news','bahh','bells','boing','bubbles','cellos','deranged',
      'good news','hysterical','jester','organ','pipe organ','superstar','trinoids','whisper','wobble',
      'zarvox','fred','junior','kathy','ralph','agnes','bruce','vicki','victoria','princess']);
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
    const wanted = [prevChoice, savedChoice].find(k => k && list.some(item => item.id === k));
    list.forEach(item => {
      const opt = document.createElement('option');
      opt.value = item.id;
      opt.textContent = item.name;
      if (item.id === wanted) opt.selected = true;
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
  if (activeEngine === 'browser') {
    localStorage.setItem('marginalia_browser_voice', voicePicker.value);
  } else {
    // Neural voices are fixed presets, so the chosen one can be remembered exactly (per engine)
    localStorage.setItem(`marginalia_neural_voice_${activeEngine}`, voicePicker.value);
  }
  clearAudioCache();
  learnedCadenceMultiplier = cadenceByVoice.get(voiceCadenceKey()) || 1.0;
  const selectedOption = voicePicker.options[voicePicker.selectedIndex];
  activeVoiceBadge.textContent = `${activeEngine === 'browser' ? '🎙️' : '⚡'} ${selectedOption ? selectedOption.text.split('(')[0].trim() : 'Voice'}`;
  
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

function parseHtmlToBlocks(htmlString) {
  const doc = new DOMParser().parseFromString(htmlString, 'text/html');
  doc.querySelectorAll('script, style, head, nav, [role="doc-toc"]').forEach(el => el.remove());

  const blocks = [];
  if (!doc.body || doc.body.children.length === 0) {
    const rawText = (doc.body ? doc.body.textContent : doc.documentElement.textContent) || '';
    return splitIntoSentences(rawText);
  }

  const BLOCK_TAGS = new Set(['p','div','section','article','main','aside','header','footer','ul','ol','li','table','tbody','thead','tr','td','th','blockquote','figure','pre','dl','dt','dd','h1','h2','h3','h4','h5','h6','hr']);

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
  for (let i = 0; i < images.length; i++) {
    preloadStatus.textContent = `Reading scan ${i + 1}/${images.length}...`;

    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (customOpenAi) headers['x-custom-openai-key'] = customOpenAi;

    const res = await fetch('/api/ocr', {
      method: 'POST',
      headers,
      body: JSON.stringify({ imageBase64: images[i].dataUrl })
    });
    const data = await res.json().catch(() => ({}));

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

  // NEW: freemium teaser - only extract page 1 for unauthenticated users
  if (lowerName.endsWith('.pdf') || (uint8.length > 4 && uint8[0] === 0x25 && uint8[1] === 0x50 && uint8[2] === 0x44 && uint8[3] === 0x46)) {
    // Extract all page texts, then only keep page 1 for freemium teaser
    const pageTexts = await window.extractPdfTexts(lib, uint8);
    const pages = [];
    const chapters = [];

    if (pageTexts.length > 0) {
      const { pageNumber, text } = pageTexts[0];  // Only page 1
      const sents = splitIntoSentences(text);
      if (sents.length > 0) {
        chapters.push({ title: `PDF Page ${pageNumber}`, pageIndex: 0 });
        for (let s = 0; s < sents.length; s += 5) {
          pages.push(sents.slice(s, s + 5));
        }
      }
    }

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
    } catch (e) {}
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
    } catch (e) {}
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

// PRIMARY FILE IMPORT LISTENER (freemium teaser pattern)
fileInput.addEventListener('change', async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  stopAudio();
  currentDocName = file.name;
  docTitle.textContent = currentDocName;
  preloadStatus.textContent = "Opening...";
  contentPane.innerHTML = `<div style="text-align:center; padding:3rem; color:var(--text-muted); font-style:italic;">Processing "${escapeHtml(file.name)}"...</div>`;

  try {
    // Freemium teaser: extract only page 1 for unauthenticated users
    // (signedIn, not isUserSignedIn: a local const with the same name as the
    //  function would shadow it and hit the temporal dead zone in this block)
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
    renderPage(0);

    if (signedIn) {
      saveBookToShelf(currentDocName, bookPages, bookChapters);
      // Show full access - all chapters available
      showFullAccessNotice();
    } else {
      // Freemium: save only page 1, show sign-in prompt for more
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
});

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

initIndexedDB();
populateVoices();
renderPage(0);
updateAuthBadge();
updateSleepTimerUI();
refreshProPriceLabels();
