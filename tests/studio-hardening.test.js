// tests/studio-hardening.test.js
//
// Studio follow-ups 11-18. Each section pins one behaviour of the on-device voice that cannot be
// checked on a real phone from this workspace: levels, cache versioning, and the later export,
// diagnostics, consent, lead, seam and iOS routing work.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appSource, extractFunction } from './helpers/extract-function.mjs';

const workerSource = () => readFileSync(fileURLToPath(new URL('../public/tts-worker.js', import.meta.url)), 'utf8');

// --- 11. consistent Studio loudness -----------------------------------------

globalThis.STUDIO_TARGET_PEAK = 0.9;
globalThis.STUDIO_SILENCE_FLOOR = 0.02;
globalThis.STUDIO_MAX_GAIN = 8;
const normalizeStudioPcm = extractFunction('normalizeStudioPcm');
const peakOf = (samples) => samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);

test('quiet and loud Studio clips are level-matched to the same peak', () => {
  const quiet = normalizeStudioPcm(Float32Array.from([0.12, -0.05, 0.2]));
  const loud = normalizeStudioPcm(Float32Array.from([0.8, -0.4, 0.6]));

  assert.ok(Math.abs(peakOf(quiet) - 0.9) < 1e-6, 'a quiet clause is lifted to the target');
  assert.ok(Math.abs(peakOf(loud) - 0.9) < 1e-6, 'a loud clause is brought down to it');
  assert.deepEqual(Array.from(normalizeStudioPcm(Float32Array.from([0, 0, 0]))), [0, 0, 0], 'a pause stays silent');
  const nearSilence = Array.from(normalizeStudioPcm(Float32Array.from([0.001, -0.002])));
  assert.ok(
    Math.abs(nearSilence[0] - 0.001) < 1e-6 && Math.abs(nearSilence[1] + 0.002) < 1e-6,
    'near-silence is not amplified into noise'
  );
});

test('a hot clip is scaled to the target instead of clipping into a square wave', () => {
  const hot = normalizeStudioPcm(Float32Array.from([2, -2, 1.5]));
  const expected = [0.9, -0.9, 0.675];
  Array.from(hot).forEach((sample, i) => {
    assert.ok(Math.abs(sample - expected[i]) < 1e-6, `sample ${i} sits at the target level`);
  });
});

test('every Studio buffer and exported clip goes through the level matcher', () => {
  const app = appSource();
  assert.match(
    app,
    /audioBuffer\.getChannelData\(0\)\.set\(normalizeStudioPcm\(pcmData\)\)/,
    'scheduled playback buffers are level-matched'
  );
  assert.match(
    app,
    /const levelMatched = normalizeStudioPcm\(rawFloatSamples\)/,
    'encoded clips use the same matcher as playback'
  );
  assert.ok(!app.includes('maxAmp > 1.0'), 'the old scale-down-only normalisation is gone');
});

// --- 17. model/cache versioning + eviction ----------------------------------

test('the cached clip key carries the Studio model version', () => {
  const app = appSource();
  assert.match(app, /const STUDIO_MODEL_VERSION = 'kokoro_v1'/, 'the model has one version stamp');
  assert.match(app, /function wasmCacheEngine\(\) \{\s*return 'wasm_' \+ STUDIO_MODEL_VERSION;/, 'the engine key is built from it');
  assert.match(app, /computeAudioCacheKey\(wasmCacheEngine\(\)/, 'IndexedDB keys name the model version');
  assert.match(app, /saveAudioToIdbCache\(cacheKey, blob, wasmCacheEngine\(\)\)/, 'the clip is stored with its engine');
  assert.match(app, /engine: engine \|\| '',/, 'the cache row records which engine wrote it');
  assert.match(app, /pruneStaleStudioCache\(\)\.catch/, 'startup evicts clips an older model wrote');
});

test('only clips from an older Studio model are evicted', () => {
  const stale = extractFunction('studioCacheEntryIsStale');
  assert.equal(stale({ cacheKey: 'a'.repeat(64), engine: 'wasm_kokoro_v1' }, 'wasm_kokoro_v2'), true);
  assert.equal(stale({ cacheKey: 'b'.repeat(64), engine: 'wasm_kokoro_v2' }, 'wasm_kokoro_v2'), false);
  assert.equal(
    stale({ cacheKey: 'c'.repeat(64), engine: 'elevenlabs' }, 'wasm_kokoro_v2'),
    false,
    'cloud clips are not touched by a Studio model change'
  );
  assert.equal(
    stale({ cacheKey: 'd'.repeat(64) }, 'wasm_kokoro_v2'),
    false,
    'rows written before versioning are left alone'
  );
});

// --- 12. streaming WAV export ------------------------------------------------

globalThis.encodeMonoWavBuffer = extractFunction('encodeMonoWavBuffer');
globalThis.extractWavPcm = extractFunction('extractWavPcm');

test('the Studio export appends each clip as it arrives instead of holding every WAV', async () => {
  const sink = extractFunction('createWavExportSink')();
  const first = Float32Array.from({ length: 120 }, (_, i) => Math.sin(i / 6) * 0.5);
  const second = Float32Array.from({ length: 80 }, (_, i) => Math.cos(i / 9) * 0.4);

  assert.equal(
    await sink.add(new Blob([globalThis.encodeMonoWavBuffer(first, 24000)], { type: 'audio/wav' })),
    120,
    'the running sample count is available for progress'
  );
  assert.equal(sink.chunks, 1, 'the first clip is already decoded and released');
  await sink.add(new Blob([globalThis.encodeMonoWavBuffer(second, 24000)], { type: 'audio/wav' }));

  const blob = sink.finish();
  const buffer = await blob.arrayBuffer();
  const view = new DataView(buffer);
  let riffCount = 0;
  for (let o = 0; o + 4 <= buffer.byteLength; o++) {
    if (view.getUint32(o, false) === 0x52494646) riffCount++;
  }
  assert.equal(riffCount, 1, 'one header for the whole file');
  assert.equal(buffer.byteLength, 44 + 200 * 2, 'both clips are in the file');
  const decoded = globalThis.extractWavPcm(buffer);
  assert.equal(decoded.pcmData.length, 200, 'no samples lost at the seam');
  assert.equal(decoded.sampleRate, 24000);
  assert.equal(blob.type, 'audio/wav');
});

test('the export path uses the sink and fails loudly on a bad clip', async () => {
  const app = appSource();
  assert.match(app, /const wasmSink = engine === 'wasm' \? createWavExportSink\(\) : null;/, 'Studio exports use the sink');
  assert.match(app, /if \(wasmSink\) await wasmSink\.add\(blob\);/, 'each clip is added as it arrives');
  assert.match(
    app,
    /const finalBlob = wasmSink \? wasmSink\.finish\(\) : await stitchExportChunks\(chunks, engine\);/,
    'one file is written at the end'
  );

  const sink = extractFunction('createWavExportSink')();
  await assert.rejects(() => sink.add(new Blob([new Uint8Array(8)])), /Could not read the synthesized audio/);
  assert.throws(
    () => sink.finish(),
    /Could not synthesize audio chunks/,
    'an empty or cancelled export never writes a header-only file'
  );
});

test('a sample-rate change mid-export is refused instead of writing a broken WAV', async () => {
  const sink = extractFunction('createWavExportSink')();
  await sink.add(new Blob([globalThis.encodeMonoWavBuffer(Float32Array.from([0.1]), 24000)], { type: 'audio/wav' }));
  await assert.rejects(
    () => sink.add(new Blob([globalThis.encodeMonoWavBuffer(Float32Array.from([0.1]), 22050)], { type: 'audio/wav' })),
    /changed sample rate/
  );
});

// --- 14. model-download consent + offline readiness -------------------------

function fakeStudioStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); }
  };
}

// navigator and localStorage are host globals in newer Node versions, so assign them through a
// property descriptor instead of plain assignment.
function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

test('the model download is asked for once and a no is remembered', () => {
  setGlobal('localStorage', fakeStudioStorage());
  globalThis.STUDIO_MODEL_READY_KEY = 'marginalia_studio_model_ready_kokoro_v1';
  globalThis.STUDIO_MODEL_CONSENT_KEY = 'marginalia_studio_model_consent_v1';
  globalThis.renderStudioStats = () => {};
  globalThis.studioModelReady = extractFunction('studioModelReady');
  globalThis.studioModelConsent = extractFunction('studioModelConsent');
  globalThis.setStudioModelConsent = extractFunction('setStudioModelConsent');
  globalThis.setStudioModelReady = extractFunction('setStudioModelReady');
  const needed = extractFunction('studioModelConsentNeeded');
  const ask = extractFunction('askStudioModelDownload');

  assert.equal(needed(), true, 'a first Studio read has no model yet');
  globalThis.confirm = () => false;
  assert.equal(ask(), false);
  assert.equal(globalThis.studioModelConsent(), 'declined');
  assert.equal(needed(), true, 'declining does not make it ready');
  globalThis.confirm = () => true;
  assert.equal(ask(), true);
  assert.equal(globalThis.studioModelConsent(), 'granted');
  assert.equal(needed(), false, 'consent alone stops the question');
  globalThis.setStudioModelReady(true);
  assert.equal(globalThis.studioModelReady(), true, 'the model is remembered for offline reads');
  globalThis.setStudioModelConsent('');
  assert.equal(needed(), false, 'a ready model never asks again');
});

test('a declined download falls back to the native voice and Options reports readiness', () => {
  const app = appSource();
  const decline = app.slice(
    app.indexOf('function declineStudioModelDownload'),
    app.indexOf('function studioVoiceErrorMessage')
  );
  assert.match(decline, /activeEngine = 'browser'/, 'a declined Studio download falls back');
  assert.match(decline, /t\.dataset\.engine === 'browser'/, 'the engine tab follows the fallback');
  assert.match(decline, /showToast\(/, 'the reader is told why the voice changed');
  assert.match(app, /warmWasmTtsWorker\(\{ ask: true \}\)/, 'choosing Studio in Options asks again');
  assert.match(app, /setStudioModelReady\(true\)/, 'a finished warm-up marks the model ready');
  assert.match(app, /studioModelStatusText\(\)/, 'Options reports whether the model is on the device');

  const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
  assert.match(html, /id="studioModelStatus"/, 'the readiness line is in the diagnostics panel');
});

test('the failure message distinguishes a missing download from an offline playback', () => {
  setGlobal('navigator', { onLine: false });
  let ready = false;
  globalThis.studioModelReady = () => ready;
  const message = extractFunction('studioVoiceErrorMessage');

  assert.match(message(), /download the model/, 'a first read is told about the one-time download');
  ready = true;
  assert.match(message(), /offline/, 'a ready model that still fails offline says so');
  setGlobal('navigator', { onLine: true });
  assert.match(message(), /Try again/, 'online it is an ordinary retry');
});

// --- 15. adaptive lead and clause sizing -----------------------------------

globalThis.WASM_AHEAD_SECONDS = 6;
globalThis.WASM_CHUNK_CHARS = { fast: 80, steady: 60, slow: 40 };
globalThis.WASM_LEAD_SECONDS = { fast: 6, steady: 9, slow: 14 };
globalThis.studioPerfSummary = () => ({ samples: 0, rtf: { median: null } });
const studioChunkPlan = extractFunction('studioChunkPlan');

test('the lead and clause size follow the measured real-time factor', () => {
  assert.deepEqual(
    studioChunkPlan({ samples: 0, rtf: { median: null } }),
    { maxChars: 80, leadSeconds: 6, tier: 'fast' },
    'no measurements keeps the original fixed plan'
  );

  const fast = studioChunkPlan({ samples: 5, rtf: { median: 0.25 } });
  assert.deepEqual(fast, { maxChars: 80, leadSeconds: 6, tier: 'fast' }, 'a fast device keeps long clauses');

  const steady = studioChunkPlan({ samples: 5, rtf: { median: 0.7 } });
  assert.deepEqual(steady, { maxChars: 60, leadSeconds: 9, tier: 'steady' }, 'a device near real time gets shorter clauses');

  const slow = studioChunkPlan({ samples: 5, rtf: { median: 1.4 } });
  assert.deepEqual(
    slow,
    { maxChars: 40, leadSeconds: 14, tier: 'slow' },
    'synthesis that cannot keep up starts speaking sooner and keeps a deeper queue'
  );
  assert.equal(studioChunkPlan({ samples: 5, rtf: { median: 1 } }).tier, 'slow', 'exactly real time is already a drain');
});

test('the queue and the worker both take the adaptive plan', () => {
  const app = appSource();
  assert.match(app, /const plan = studioChunkPlan\(\);/, 'the fill reads one plan per pass');
  assert.match(app, />= plan\.leadSeconds\) break;/, 'the lead is the adaptive target');
  assert.match(app, /maxChars: studioChunkPlan\(\)\.maxChars,/, 'the clause size travels with the job');

  const worker = workerSource();
  assert.match(worker, /maxChars = 80/, 'the worker defaults to the long-standing size');
  assert.match(worker, /splitLongText\(text, maxChars\)/, 'and splits at the requested size');
  assert.match(worker, /maxChars: Number\(msg\.maxChars\) > 0/, 'the job carries it across the thread');
});

// --- 16. prosody-aware seams ------------------------------------------------

function extractWorkerFunction(name) {
  const source = workerSource();
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start > -1, `${name} exists in the worker`);
  let depth = 0;
  let end = source.indexOf('{', start);
  for (; end < source.length; end++) {
    if (source[end] === '{') depth++;
    else if (source[end] === '}') { depth--; if (!depth) break; }
  }
  return new Function('return ' + source.slice(start, end + 1))();
}

test('the pause between clauses follows the punctuation that ended the first', () => {
  // Read the pause table out of the worker itself, so this test can never drift from production.
  const worker = workerSource();
  const tableStart = worker.indexOf('const CLAUSE_PAUSE_MS');
  globalThis.CLAUSE_PAUSE_MS = new Function(
    `${worker.slice(tableStart, worker.indexOf('\n', tableStart))}\nreturn CLAUSE_PAUSE_MS;`
  )();
  const clauseGapMs = extractWorkerFunction('clauseGapMs');

  assert.equal(clauseGapMs('a comma,'), 120);
  assert.equal(clauseGapMs('a semicolon;'), 220);
  assert.equal(clauseGapMs('a colon:'), 220);
  assert.equal(clauseGapMs('a dash —'), 260);
  assert.equal(clauseGapMs('a finished thought.'), 260);
  assert.equal(clauseGapMs('he said “stop.”'), 260, 'a closing quote does not hide the full stop');
  assert.equal(clauseGapMs('a trailing ellipsis…'), 320);
  assert.equal(clauseGapMs('a clause split on words'), 40, 'a word split barely pauses');

  assert.match(worker, /clauseGapMs\(parts\[i\]\)/, 'the streamed seam uses the punctuation');
  assert.ok(!worker.includes('sampleRate * 0.08'), 'the flat 80 ms seam is gone');
});

// --- 18. iOS lock-screen MediaStream routing -------------------------------

function installIosRouteMocks({ play } = {}) {
  const element = {
    paused: true,
    srcObject: null,
    plays: 0,
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    play() { this.plays += 1; this.paused = false; return play ? play() : Promise.resolve(); },
    pause() { this.paused = true; }
  };
  setGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    maxTouchPoints: 5
  });
  setGlobal('MediaStream', function MediaStream() { });
  setGlobal('document', { createElement: () => element });
  setGlobal('wasmMediaStream', null);
  setGlobal('needsMediaStreamRouting', extractFunction('needsMediaStreamRouting'));
  setGlobal('resumeWasmMediaStreamAudio', extractFunction('resumeWasmMediaStreamAudio'));
  return element;
}

test('on iOS the Studio graph is routed through a media element the lock screen keeps alive', () => {
  const element = installIosRouteMocks();
  const connected = [];
  const gain = {
    disconnected: false,
    disconnect() { this.disconnected = true; },
    connect(node) { connected.push(node); }
  };
  const ctx = {
    destination: { id: 'dest' },
    createMediaStreamDestination: () => ({ stream: { id: 'stream' } })
  };

  const routed = extractFunction('routeWasmAudioThroughMediaStream')(ctx, gain);

  assert.ok(routed, 'iOS gets a media stream route');
  assert.equal(gain.disconnected, true, 'the graph leaves the direct destination');
  assert.equal(connected.length, 1, 'and feeds the media stream instead');
  assert.equal(connected[0], routed.destination);
  assert.deepEqual(element.srcObject, { id: 'stream' });
  assert.equal(element.attributes.playsinline, '', 'inline playback, or iOS takes over full screen');
  assert.equal(element.plays, 1, 'the element starts with the graph');
  assert.equal(globalThis.wasmMediaStream, routed);

  element.paused = true;
  globalThis.resumeWasmMediaStreamAudio();
  assert.equal(element.plays, 2, 'resuming after the lock screen restarts the element');
});

test('a refused media element falls back to the direct destination', async () => {
  installIosRouteMocks({ play: () => Promise.reject(new Error('NotAllowedError')) });
  const connected = [];
  const gain = {
    disconnected: false,
    disconnect() { this.disconnected = true; },
    connect(node) { connected.push(node); }
  };
  const ctx = {
    destination: { id: 'dest' },
    createMediaStreamDestination: () => ({ stream: { id: 'stream' } })
  };

  const routed = extractFunction('routeWasmAudioThroughMediaStream')(ctx, gain);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(routed.failed, true, 'the failed route is remembered');
  assert.equal(connected.length, 2, 'the next sentences go straight to the speakers');
  assert.equal(connected[0], routed.destination);
  assert.equal(connected[1], ctx.destination);
  assert.equal(globalThis.wasmMediaStream.element.paused, true, 'the stream element is stopped');
});

test('a desktop browser keeps the direct AudioContext destination', () => {
  setGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/128.0', maxTouchPoints: 0 });
  setGlobal('MediaStream', function MediaStream() { });
  setGlobal('document', { createElement: () => { throw new Error('should not create an element'); } });
  setGlobal('wasmMediaStream', null);
  setGlobal('needsMediaStreamRouting', extractFunction('needsMediaStreamRouting'));

  let touched = 0;
  const gain = { connect() { touched += 1; }, disconnect() { touched += 1; } };
  const ctx = { destination: {}, createMediaStreamDestination: () => { throw new Error('not on desktop'); } };

  assert.equal(extractFunction('routeWasmAudioThroughMediaStream')(ctx, gain), null);
  assert.equal(touched, 0, 'the desktop graph is untouched');
});

test('an iPad is routed like an iPhone', () => {
  setGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 });
  setGlobal('needsMediaStreamRouting', extractFunction('needsMediaStreamRouting'));
  assert.equal(globalThis.needsMediaStreamRouting(), true);

  setGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 });
  assert.equal(globalThis.needsMediaStreamRouting(), false, 'a Mac without a touch screen is not an iPad');
});
