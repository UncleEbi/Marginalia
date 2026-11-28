import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync('public/app.js', 'utf8');

test('public/app.js defines Media Session methods and keep-alive controllers', () => {
  assert.match(app, /function updateMediaMetadata\(/, 'updateMediaMetadata is defined');
  assert.match(app, /function syncMediaSessionState\(/, 'syncMediaSessionState is defined');
  assert.match(app, /function startBrowserSpeechKeepAlive\(/, 'startBrowserSpeechKeepAlive is defined');
  assert.match(app, /function stopBrowserSpeechKeepAlive\(/, 'stopBrowserSpeechKeepAlive is defined');
  assert.match(app, /registerMediaSessionHandlers/, 'registerMediaSessionHandlers is defined');
});

test('updateMediaMetadata constructs MediaMetadata with book title, page info, artist, and artwork', () => {
  let createdMetadata = null;
  class MockMediaMetadata {
    constructor(init) {
      createdMetadata = init;
    }
  }

  const mockNavigator = {
    mediaSession: {
      metadata: null
    }
  };

  const context = {
    navigator: mockNavigator,
    MediaMetadata: MockMediaMetadata,
    currentDocName: 'Operating Systems Principles',
    currentPage: 2,
    bookPages: [1, 2, 3, 4, 5],
    getCurrentChapter: () => ({ title: 'Virtual Memory' }),
    console
  };

  const fnFactory = new Function('ctx', `
    with (ctx) {
      ${app.slice(app.indexOf('function updateMediaMetadata()'), app.indexOf('function startBrowserSpeechKeepAlive()'))}
      updateMediaMetadata();
    }
  `);

  fnFactory(context);

  assert.ok(createdMetadata, 'MediaMetadata was created');
  assert.equal(createdMetadata.title, 'Operating Systems Principles (Page 3 of 5 · Virtual Memory)');
  assert.equal(createdMetadata.artist, 'Marginalia Reader');
  assert.equal(createdMetadata.album, 'Operating Systems Principles');
  assert.ok(Array.isArray(createdMetadata.artwork));
  assert.ok(createdMetadata.artwork.some(a => a.src.includes('192')));
  assert.ok(createdMetadata.artwork.some(a => a.src.includes('512')));
});

test('syncMediaSessionState updates playbackState and controls silent keep-alive for SpeechSynthesis', () => {
  let keepAlivePlayed = false;
  let keepAlivePaused = false;

  class MockAudio {
    constructor() {
      this.loop = false;
      this.volume = 1;
      this.currentTime = 0;
    }
    play() {
      keepAlivePlayed = true;
      return Promise.resolve();
    }
    pause() {
      keepAlivePaused = true;
    }
  }

  const mockMediaSession = {
    playbackState: 'none'
  };

  const context = {
    navigator: { mediaSession: mockMediaSession },
    Audio: MockAudio,
    makeSilentWavUrl: () => 'blob:mock-silent-wav',
    activeEngine: 'browser',
    keepAliveAudio: null,
    console
  };

  const codeSegment = app.slice(
    app.indexOf('function startBrowserSpeechKeepAlive()'),
    app.indexOf('function skipSentence(delta)')
  );

  const fnFactory = new Function('ctx', `
    with (ctx) {
      ${codeSegment}
      return { startBrowserSpeechKeepAlive, stopBrowserSpeechKeepAlive, syncMediaSessionState, getKeepAliveAudio: () => keepAliveAudio };
    }
  `);

  const { syncMediaSessionState } = fnFactory(context);

  // Playing with browser engine -> sets playing & starts keep-alive
  syncMediaSessionState(true);
  assert.equal(mockMediaSession.playbackState, 'playing');
  assert.equal(keepAlivePlayed, true, 'keep-alive audio played for browser speech engine');

  // Pausing -> sets paused & stops keep-alive
  syncMediaSessionState(false);
  assert.equal(mockMediaSession.playbackState, 'paused');
  assert.equal(keepAlivePaused, true, 'keep-alive audio paused when stopped');

  // Studio plays through an AudioContext, which iOS can suspend on lock: the same keep-alive
  // element has to run for it too.
  context.activeEngine = 'wasm';
  keepAlivePlayed = false;
  syncMediaSessionState(true);
  assert.equal(keepAlivePlayed, true, 'keep-alive audio keeps the Studio media session alive');
});

test('registerMediaSessionHandlers binds play, pause, track skip, and seek handlers', () => {
  const handlers = {};
  const mockMediaSession = {
    setActionHandler: (action, fn) => {
      handlers[action] = fn;
    }
  };

  const context = {
    navigator: { mediaSession: mockMediaSession },
    isPlaying: false,
    isAudioDrillActive: false,
    activeEngine: 'neural',
    unlockAudioForIOS: () => {},
    playCurrentSentence: () => { context.isPlaying = true; },
    stopAudio: () => { context.isPlaying = false; },
    skipSentence: (delta) => { context.lastSkipDelta = delta; },
    handleHandsfreeNextTrack: () => { context.handsfreeCalled = true; },
    triggerHandsfreeBookmark: () => { context.bookmarkCalled = true; },
    lastSkipDelta: 0,
    handsfreeCalled: false,
    bookmarkCalled: false
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

  assert.ok(typeof handlers.play === 'function', 'play handler registered');
  assert.ok(typeof handlers.pause === 'function', 'pause handler registered');
  assert.ok(typeof handlers.previoustrack === 'function', 'previoustrack handler registered');
  assert.ok(typeof handlers.nexttrack === 'function', 'nexttrack handler registered');
  assert.ok(typeof handlers.seekbackward === 'function', 'seekbackward handler registered');
  assert.ok(typeof handlers.seekforward === 'function', 'seekforward handler registered');

  // Test action executions
  handlers.play();
  assert.equal(context.isPlaying, true, 'play action starts playback');

  handlers.pause();
  assert.equal(context.isPlaying, false, 'pause action stops playback');

  handlers.previoustrack();
  assert.equal(context.lastSkipDelta, -1, 'previoustrack jumps back a sentence');

  handlers.seekbackward();
  assert.equal(context.lastSkipDelta, -1, 'seekbackward jumps back a sentence');

  handlers.seekforward();
  assert.equal(context.lastSkipDelta, 1, 'seekforward jumps forward a sentence');

  handlers.nexttrack();
  assert.equal(context.handsfreeCalled, true, 'nexttrack delegates to handleHandsfreeNextTrack');
});
