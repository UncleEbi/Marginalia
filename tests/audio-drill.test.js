import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync('public/index.html', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');

test('public/index.html defines Audio Drill trigger, setup modal, and HUD', () => {
  // Triggers
  assert.match(html, /id="audioDrillBtn"/, 'has audioDrillBtn in header');
  assert.match(html, /id="navAudioDrill"/, 'has navAudioDrill in drawer');

  // Setup modal & options
  assert.match(html, /id="audioDrillModal"/, 'has audioDrillModal');
  assert.match(html, /id="drillSourceSelect"/, 'has drillSourceSelect');
  assert.match(html, /id="drillPauseSelect"/, 'has drillPauseSelect');
  assert.match(html, /id="drillShuffleCheck"/, 'has drillShuffleCheck');
  assert.match(html, /id="drillControlsNote"/, 'has drillControlsNote');
  assert.match(html, /Next = Known/, 'mentions Next = Known control in setup modal');
  assert.match(html, /Back = Review/, 'mentions Back = Review control in setup modal');
  assert.match(html, /id="drillEmptyGuide"/, 'has drillEmptyGuide empty state');
  assert.match(html, /id="trySampleDrillBtn"/, 'has trySampleDrillBtn');
  assert.match(html, /Try a 2-card sample drill/i, 'offers 2-card sample drill button');
  assert.match(html, /id="startAudioDrillBtn"/, 'has startAudioDrillBtn');

  // HUD elements
  assert.match(html, /id="audioDrillHud"/, 'has audioDrillHud');
  assert.match(html, /id="drillProgressText"/, 'has drillProgressText');
  assert.match(html, /id="drillPromptText"/, 'has drillPromptText');
  assert.match(html, /id="drillAnswerText"/, 'has drillAnswerText');
  assert.match(html, /id="drillReviewBtn"/, 'has drillReviewBtn');
  assert.match(html, /id="drillPauseToggleBtn"/, 'has drillPauseToggleBtn');
  assert.match(html, /id="drillKnownBtn"/, 'has drillKnownBtn');
  assert.match(html, /id="drillStopBtn"/, 'has drillStopBtn');
});

test('public/app.js defines Active Recall state machine functions', () => {
  assert.match(app, /async function collectDrillCards\(/, 'collectDrillCards defined');
  assert.match(app, /async function openAudioDrillModal\(/, 'openAudioDrillModal defined');
  assert.match(app, /async function startAudioDrill\(/, 'startAudioDrill defined');
  assert.match(app, /async function runDrillCard\(/, 'runDrillCard defined');
  assert.match(app, /function rateDrillCard\(/, 'rateDrillCard defined');
  assert.match(app, /function pauseAudioDrill\(/, 'pauseAudioDrill defined');
  assert.match(app, /function resumeAudioDrill\(/, 'resumeAudioDrill defined');
  assert.match(app, /function stopAudioDrill\(/, 'stopAudioDrill defined');
});

test('Media Session actions route to Audio Drill rating when drill is active', () => {
  const mediaHandlers = {};
  const mockMediaSession = {
    setActionHandler: (action, fn) => {
      mediaHandlers[action] = fn;
    }
  };

  let ratedKnown = null;
  const context = {
    navigator: { mediaSession: mockMediaSession },
    isAudioDrillActive: true,
    rateDrillCard: (known) => { ratedKnown = known; },
    resumeAudioDrill: () => { context.resumed = true; },
    pauseAudioDrill: () => { context.paused = true; },
    stopAudioDrill: () => { context.stopped = true; },
    stopAudio: () => {},
    playCurrentSentence: () => {},
    skipSentence: () => {},
    handleHandsfreeNextTrack: () => {},
    triggerHandsfreeBookmark: () => {},
    unlockAudioForIOS: () => {},
    isPlaying: false,
    activeEngine: 'neural',
    resumed: false,
    paused: false,
    stopped: false
  };

  const handlerCode = app.slice(
    app.indexOf('(function registerMediaSessionHandlers() {'),
    app.indexOf('// --- TEXT SELECTION QUICK ACTIONS ---')
  );

  const fnFactory = new Function('ctx', `
    with (ctx) {
      ${handlerCode}
    }
  `);

  fnFactory(context);

  // When drill is active:
  mediaHandlers.nexttrack();
  assert.equal(ratedKnown, true, 'nexttrack marks card as known');

  mediaHandlers.previoustrack();
  assert.equal(ratedKnown, false, 'previoustrack marks card as review');

  mediaHandlers.seekforward();
  assert.equal(ratedKnown, true, 'seekforward marks card as known');

  mediaHandlers.seekbackward();
  assert.equal(ratedKnown, false, 'seekbackward marks card as review');

  mediaHandlers.pause();
  assert.equal(context.paused, true, 'pause pauses the audio drill');

  mediaHandlers.play();
  assert.equal(context.resumed, true, 'play resumes the audio drill');
});

test('collectDrillCards builds questions and answers from vocabulary and notes', async () => {
  const mockVocab = [
    { word: 'synapse', definition: 'Junction between two nerve cells', partOfSpeech: 'noun' }
  ];
  const mockAnnotations = [
    { page: 1, sentenceIdx: 3, quoteText: 'DNA is a double helix.', noteText: 'Discovered in 1953 by Watson & Crick.' }
  ];
  const mockBookmarks = [
    { page: 2, snippet: 'Photosynthesis converts light into chemical energy.' }
  ];

  const context = {
    currentDocName: 'Biology 101',
    getVocabFromDB: async () => mockVocab,
    currentDocAnnotations: mockAnnotations,
    bookmarks: mockBookmarks
  };

  const collectCode = app.slice(
    app.indexOf('async function collectDrillCards(source) {'),
    app.indexOf('async function openAudioDrillModal() {')
  );

  const fnFactory = new Function('ctx', `
    with (ctx) {
      ${collectCode}
      return collectDrillCards;
    }
  `);

  const collectDrillCards = fnFactory(context);

  // All cards
  const allCards = await collectDrillCards('all');
  assert.equal(allCards.length, 3);
  assert.ok(allCards.some(c => c.type === 'vocab' && c.prompt.includes('synapse')));
  assert.ok(allCards.some(c => c.type === 'note' && c.prompt.includes('double helix')));
  assert.ok(allCards.some(c => c.type === 'bookmark' && c.prompt.includes('Photosynthesis')));

  // Vocab only
  const vocabCards = await collectDrillCards('vocab');
  assert.equal(vocabCards.length, 1);
  assert.equal(vocabCards[0].type, 'vocab');

  // Notes only
  const noteCards = await collectDrillCards('notes');
  assert.equal(noteCards.length, 2);
  assert.ok(noteCards.every(c => c.type === 'note' || c.type === 'bookmark'));
});

test('audioDrillModal shows empty-state guide at 0 cards and runs 2-card sample drill', async () => {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://marginalia-rme.vercel.app/' });
  try {
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
    dom.window.Audio = function () { return { play: async () => {}, pause: () => {}, addEventListener: () => {} }; };
    dom.window.indexedDB = {
      open: () => {
        const req = { onupgradeneeded: null, onsuccess: null, onerror: null };
        setTimeout(() => { if (req.onerror) req.onerror(); }, 0);
        return req;
      }
    };
    dom.window.navigator.serviceWorker = { register: async () => ({ update: async () => {} }), addEventListener: () => {} };
    dom.window.supabase = {
      createClient: () => ({
        auth: {
          getSession: async () => ({ data: { session: null } }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } })
        },
        from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) })
      })
    };
    dom.window.JSZip = { loadAsync: async () => ({ files: {} }) };
    dom.window.mammoth = { convertToHtml: async () => ({ value: '' }), images: { imgElement: () => {} } };

    dom.window.eval(app);

    // Open Audio Drill when no cards exist
    dom.window.document.getElementById('audioDrillBtn').click();
    await new Promise((r) => setTimeout(r, 30));

    const emptyGuide = dom.window.document.getElementById('drillEmptyGuide');
    const startBtn = dom.window.document.getElementById('startAudioDrillBtn');
    const countLabel = dom.window.document.getElementById('drillAvailableCount');

    assert.equal(emptyGuide.style.display, 'block', 'empty-state guide displays when 0 cards exist');
    assert.equal(startBtn.disabled, true, 'Start Drill button disabled when 0 cards exist');
    assert.equal(countLabel.textContent, '0 cards in this deck');

    // Launch 2-card sample drill
    dom.window.document.getElementById('trySampleDrillBtn').click();
    await new Promise((r) => setTimeout(r, 20));

    const hud = dom.window.document.getElementById('audioDrillHud');
    const modal = dom.window.document.getElementById('audioDrillModal');
    const progress = dom.window.document.getElementById('drillProgressText');
    const prompt = dom.window.document.getElementById('drillPromptText');

    assert.equal(modal.style.display, 'none', 'setup modal closes when sample drill launches');
    assert.equal(hud.style.display, 'flex', 'HUD opens for sample drill');
    assert.equal(progress.textContent, 'Card 1 of 2');
    assert.match(prompt.textContent, /Sample Card 1/i);

    // Cleanly stop drill so no open timers linger
    dom.window.document.getElementById('drillStopBtn').click();
    assert.equal(hud.style.display, 'none', 'Exit button closes HUD');
  } finally {
    dom.window.close();
  }
});

test('Marginalia Quickstart expands across multi-chapter feature walkthrough pages', () => {
  assert.match(app, /1\. Welcome & Importing/);
  assert.match(app, /2\. Voices & Lock-Screen Audio/);
  assert.match(app, /3\. Chapters, Search & PDF View/);
  assert.match(app, /4\. Notes, Summary & AI Companion/);
  assert.match(app, /5\. Audio Drill & Study Kit/);
  assert.match(app, /6\. STEM Rules & Display Options/);
  assert.match(app, /Studio \(On-Device\) Kokoro neural voices/);
  assert.match(app, /Smart PDF Cleanup/);
  assert.match(app, /Page View/);
  assert.match(app, /Pronunciation Dictionary/);
});
