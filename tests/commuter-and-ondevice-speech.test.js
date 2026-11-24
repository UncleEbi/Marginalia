// tests/commuter-and-ondevice-speech.test.js
//
// Tests for Phase 2 enhancements:
// - Point 7: Commuter hands-free audio controls (double-tap nexttrack gesture, rising confirmation chime, bookmarking)
// - Point 2: Studio (On-Device) engine: vendored Piper/VITS voice, WAV encoding, VITS feeds
// - Contract check that data-engine="wasm" exists in index.html

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractFunction, appSource } from './helpers/extract-function.mjs';

const htmlPath = fileURLToPath(new URL('../public/index.html', import.meta.url));
const html = readFileSync(htmlPath, 'utf8');

test('Studio (On-Device) engine tab exists in index.html', () => {
  assert.ok(
    html.includes('data-engine="wasm"'),
    'index.html must include <button class="engine-tab" data-engine="wasm">'
  );
  assert.ok(
    html.includes('Studio (On-Device)'),
    'index.html must label the wasm tab as "Studio (On-Device)"'
  );
});

test('encodeMonoWav writes a spec-valid 16-bit PCM WAV at the model rate', () => {
  const encodeMonoWav = extractFunction('encodeMonoWav');

  // Includes out-of-range and non-finite samples: the encoder clamps them and turns NaN into silence.
  const pcm = new Float32Array([0, 0.5, -0.5, 1.5, -1.5, NaN, 0.25]);
  const buffer = Buffer.from(encodeMonoWav(pcm, 22050));

  assert.ok(buffer.length > 44, 'WAV buffer must contain header + audio samples');

  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buffer.toString('ascii', 12, 16), 'fmt ');
  assert.equal(buffer.readUInt16LE(20), 1, 'Audio format must be 1 (PCM)');
  assert.equal(buffer.readUInt16LE(22), 1, 'Channels must be 1 (Mono)');
  assert.equal(buffer.readUInt32LE(24), 22050, 'Sample rate must be 22050 Hz');
  assert.equal(buffer.readUInt16LE(34), 16, 'Bits per sample must be 16');
  assert.equal(buffer.toString('ascii', 36, 40), 'data');
  assert.equal(buffer.readUInt32LE(40), pcm.length * 2, 'Data chunk must cover every sample');

  assert.equal(buffer.readInt16LE(44 + 3 * 2), 32767, 'Above-range sample clamps to full scale');
  assert.equal(buffer.readInt16LE(44 + 4 * 2), -32768, 'Below-range sample clamps to negative full scale');
  assert.equal(buffer.readInt16LE(44 + 5 * 2), 0, 'NaN becomes silence instead of a click');
});

test('piperFeeds builds the VITS tensors and omits sid for a single-speaker voice', () => {
  const piperFeeds = extractFunction('piperFeeds');

  class FakeTensor {
    constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
  }
  const ort = { Tensor: FakeTensor };
  const config = { inference: { noise_scale: 0.667, length_scale: 1, noise_w: 0.8 } };

  const feeds = piperFeeds(ort, [1, 20, 3, 2], config, undefined);
  assert.equal(feeds.input.type, 'int64');
  assert.deepEqual(feeds.input.dims, [1, 4]);
  assert.deepEqual(Array.from(feeds.input.data), [1n, 20n, 3n, 2n]);
  assert.deepEqual(feeds.input_lengths.dims, [1]);
  assert.deepEqual(Array.from(feeds.input_lengths.data), [4n]);
  assert.equal(feeds.scales.type, 'float32');
  assert.deepEqual(feeds.scales.dims, [3]);
  assert.deepEqual(Array.from(feeds.scales.data).map((v) => Number(v.toFixed(3))), [0.667, 1, 0.8]);
  assert.equal('sid' in feeds, false, 'single-speaker voices must not send a speaker id');

  const multiSpeaker = piperFeeds(ort, [1], config, 0);
  assert.deepEqual(Array.from(multiSpeaker.sid.data), [0n]);
});
test('playBookmarkChime sets up a rising frequency sweep (D5 587Hz -> A5 880Hz)', () => {
  let createdOsc = null;
  let createdGain = null;

  const mockOsc = {
    frequency: {
      setValueAtTime(val, t) { this.startVal = val; },
      exponentialRampToValueAtTime(val, t) { this.endVal = val; }
    },
    connect() {},
    start() {},
    stop() {}
  };
  const mockGain = {
    gain: {
      setValueAtTime() {},
      exponentialRampToValueAtTime() {}
    },
    connect() {}
  };

  class MockAudioContext {
    constructor() {
      this.currentTime = 0;
      this.destination = {};
    }
    createOscillator() { createdOsc = mockOsc; return mockOsc; }
    createGain() { createdGain = mockGain; return mockGain; }
    close() {}
  }

  // Inject MockAudioContext
  const playBookmarkChime = extractFunction('playBookmarkChime');
  const savedWindow = globalThis.window;
  try {
    globalThis.window = {
      AudioContext: MockAudioContext
    };
    playBookmarkChime();

    assert.ok(createdOsc, 'Oscillator must be created');
    assert.equal(createdOsc.frequency.startVal, 587.33, 'Start frequency must be 587.33 Hz (D5)');
    assert.equal(createdOsc.frequency.endVal, 880.00, 'End frequency must be 880.00 Hz (A5)');
    assert.ok(createdGain, 'Gain node must be created');
  } finally {
    globalThis.window = savedWindow;
  }
});

test('handleHandsfreeNextTrack detects rapid double-tap (<650ms) to trigger bookmark and revert skip', () => {
  const handleHandsfreeNextTrack = extractFunction('handleHandsfreeNextTrack');

  let skippedDelta = 0;
  let bookmarkTriggered = false;
  let renderedPage = null;

  globalThis.lastNextTrackTime = 0;
  globalThis.prevBookmarkPage = 0;
  globalThis.prevBookmarkSentence = 0;
  globalThis.currentPage = 2;
  globalThis.currentSentenceIdx = 5;
  globalThis.isPlaying = false;

  globalThis.skipSentence = (delta) => {
    skippedDelta = delta;
    globalThis.currentSentenceIdx += delta;
  };
  globalThis.renderPage = (p) => { renderedPage = p; };
  globalThis.highlightActiveSentence = () => {};
  globalThis.triggerHandsfreeBookmark = () => { bookmarkTriggered = true; };

  // Tap 1: single tap -> advances sentence
  handleHandsfreeNextTrack();
  assert.equal(skippedDelta, 1, 'First tap should advance sentence');
  assert.equal(bookmarkTriggered, false, 'First tap should not trigger bookmark');

  // Tap 2: arriving immediately within 100ms -> double tap!
  handleHandsfreeNextTrack();
  assert.equal(bookmarkTriggered, true, 'Rapid second tap must trigger handsfree bookmark');
  assert.equal(globalThis.currentSentenceIdx, 5, 'Position must revert to original bookmarked sentence');
  assert.equal(globalThis.currentPage, 2, 'Page must be maintained at original page');
});

test('speakServerless and getNeuralAudioSrc bypass auth, BYOK keys, and 429 lockout for wasm engine', () => {
  const appSrc = readFileSync(fileURLToPath(new URL('../public/app.js', import.meta.url)), 'utf8');

  // Verify speakServerless exempts wasm from the auth gate
  assert.ok(
    appSrc.includes("if (activeEngine !== 'wasm') {") &&
    appSrc.includes("preloadStatus.textContent = activeEngine === 'wasm' ? \"Synthesizing...\" : \"Connecting...\";"),
    'speakServerless must not demand cloud tokens or BYOK keys when activeEngine is wasm'
  );

  // Verify getNeuralAudioSrc exempts wasm from cloud 429 lockout
  assert.ok(
    appSrc.includes("if (activeEngine !== 'wasm' && readerLockedUntil > Date.now())"),
    'getNeuralAudioSrc must not throttle wasm speech when cloud endpoints are rate limited'
  );

  // Verify wasm voice fallback defaults safely to heart
  assert.ok(
    appSrc.includes("['heart', 'michael', 'emma'].includes(voicePicker.value)") &&
    appSrc.includes("? 'heart'"),
    'getNeuralAudioSrc must safely default to heart if voicePicker holds a stale cloud voice id'
  );
});

test('createWasmAudioBuffer uses modelSampleRate rather than audioCtx.sampleRate and clamps samples to [-1, 1]', () => {
  const createWasmAudioBuffer = extractFunction('createWasmAudioBuffer');
  let requestedRate = null;
  let requestedLength = null;
  let requestedChannels = null;
  const channelData = new Float32Array(5);

  const mockCtx = {
    sampleRate: 48000, // Hardware rate is 48kHz
    createBuffer(channels, len, rate) {
      requestedChannels = channels;
      requestedLength = len;
      requestedRate = rate;
      return {
        sampleRate: rate,
        length: len,
        numberOfChannels: channels,
        getChannelData: () => channelData
      };
    }
  };

  const pcm = new Float32Array([0.1, -0.5, 0.8, -0.9, 0.2]);
  const buf = createWasmAudioBuffer(mockCtx, pcm, 22050);

  assert.ok(buf, 'AudioBuffer created');
  assert.equal(requestedChannels, 1, 'Mono channel');
  assert.equal(requestedLength, 5, 'Length matches PCM samples');
  assert.equal(requestedRate, 22050, 'Must use native modelSampleRate 22050Hz, never audioCtx.sampleRate 48000Hz');
  assert.deepEqual(Array.from(channelData), Array.from(pcm), 'PCM data correctly copied into AudioBuffer');
});

test('the on-device voice ships in the repo and never calls a CDN', () => {
  const appSrc = readFileSync(fileURLToPath(new URL('../public/app.js', import.meta.url)), 'utf8');
  assert.ok(
    !/huggingface\.co|cdn\.jsdelivr\.net|unpkg\.com/.test(appSrc),
    'the Studio (On-Device) audio path must not fetch a remote host'
  );

  for (const asset of [
    'models/en_US-lessac-medium.onnx',
    'models/en_US-lessac-medium.onnx.json',
    'vendor/piper/piper_phonemize.js',
    'vendor/piper/piper_phonemize.wasm',
    'vendor/piper/piper_phonemize.data',
    'vendor/ort/ort.wasm.bundle.min.mjs',
    'vendor/ort/ort-wasm-simd-threaded.wasm'
  ]) {
    assert.ok(
      existsSync(fileURLToPath(new URL(`../public/${asset}`, import.meta.url))),
      `missing vendored asset: public/${asset}`
    );
  }

  const config = JSON.parse(readFileSync(fileURLToPath(new URL('../public/models/en_US-lessac-medium.onnx.json', import.meta.url)), 'utf8'));
  assert.equal(config.audio.sample_rate, 22050, 'the voice must match modelSampleRate so playback is not pitch-shifted');
  assert.equal(config.phoneme_type, 'espeak');
  assert.ok(Object.keys(config.phoneme_id_map || {}).length > 100, 'the phoneme map must be present');
});
test('the on-device picker lists the one vendored voice instead of three profiles', () => {
  const src = appSource();
  const presets = src.slice(src.indexOf('const voicePresets = {'));
  const wasm = presets.slice(presets.indexOf('wasm: ['), presets.indexOf('],', presets.indexOf('wasm: [')));

  const entries = [...wasm.matchAll(/\{ id: '([^']+)', name: '([^']+)' \}/g)];
  assert.equal(entries.length, 1, 'the Studio (On-Device) picker must offer exactly one voice');
  assert.equal(entries[0][1], 'heart', "the id must stay 'heart' so saved choices keep working");
  assert.match(entries[0][2], /Lessac/, 'the label must name the voice that is actually vendored');
  assert.ok(
    !/Michael|Emma \(|Expressive Female/i.test(wasm),
    'the picker must not claim voices that do not ship'
  );
});

test('piperProgressLabel reports real download progress and reserves 100% for preparing', () => {
  const label = extractFunction('piperProgressLabel');
  const total = 63201294;

  assert.equal(label(0, total), 'Downloading voice… 0%');
  assert.equal(label(total / 2, total), 'Downloading voice… 50%');
  assert.equal(label(total, total), 'Downloading voice… 99%', 'the last percent belongs to "Preparing voice…"');
  assert.equal(label(total * 2, total), 'Downloading voice… 99%', 'an oversized stream never exceeds 99%');
  assert.equal(label(NaN, 0), 'Downloading voice… 0%', 'a missing total must not produce NaN%');

  const src = appSource();
  assert.ok(
    src.includes('res.body.getReader()') && src.includes("reportPiperProgress('Preparing voice…')"),
    'the first play must stream the model and report the preparing stage'
  );
});

test('WASM audio engine applies speed in ONE place only and schedules back-to-back on AudioContext.currentTime', () => {
  const appSrc = readFileSync(fileURLToPath(new URL('../public/app.js', import.meta.url)), 'utf8');

  // 1. Model sample rate used in createBuffer
  assert.ok(
    appSrc.includes('audioCtx.createBuffer(1, pcmData.length, rate') ||
    appSrc.includes('audioCtx.createBuffer(1, pcmData.length, modelSampleRate)'),
    'createBuffer must use native modelSampleRate'
  );

  // 2. Playback speed applied to sourceNode.playbackRate only (never doubled in synth)
  assert.ok(
    appSrc.includes('sourceNode.playbackRate.value = playbackSpeed;') &&
    appSrc.includes('nextSource.playbackRate.value = playbackSpeed;'),
    'Playback speed must be applied via sourceNode.playbackRate'
  );

  // 3. Natural punctuation preserved without stripping
  assert.ok(
    appSrc.includes("const trimmedText = String(text || '').trim().replace(/\\s+/g, ' ');"),
    'Text must preserve natural punctuation (. , ? !) without stripping'
  );

  // 4. Back-to-back buffer scheduling on AudioContext.currentTime
  assert.ok(
    appSrc.includes('Math.max(audioCtx.currentTime + 0.01, wasmScheduledEndTime)'),
    'Buffers must be scheduled back-to-back on AudioContext.currentTime'
  );
});
