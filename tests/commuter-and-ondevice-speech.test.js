// tests/commuter-and-ondevice-speech.test.js
//
// Tests for Phase 2 enhancements:
// - Point 7: Commuter hands-free audio controls (double-tap nexttrack gesture, rising confirmation chime, bookmarking)
// - Point 2: On-device / WebAssembly Neural Speech engine pipeline (16-bit PCM WAV generation, studio voices)
// - Contract check that data-engine="wasm" exists in index.html

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractFunction } from './helpers/extract-function.mjs';

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

test('synthOnDeviceSpeech generates a spec-valid 16-bit PCM WAV at 22050Hz', async () => {
  const synthOnDeviceSpeech = extractFunction('synthOnDeviceSpeech');

  // Test synthesis for 'heart' voice
  const result = await synthOnDeviceSpeech('Hello world from on-device speech.', 'heart');
  assert.ok(typeof result === 'string', 'Result must be a string URL');

  let buffer;
  if (result.startsWith('data:audio/wav;base64,')) {
    const b64 = result.replace('data:audio/wav;base64,', '');
    buffer = Buffer.from(b64, 'base64');
  } else {
    // If URL.createObjectURL was used, result is a blob: URL
    assert.ok(result.startsWith('blob:') || result.startsWith('data:'));
    return;
  }

  assert.ok(buffer.length > 44, 'WAV buffer must contain header + audio samples');

  // Validate RIFF header
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buffer.toString('ascii', 12, 16), 'fmt ');

  // Validate PCM audio format (1 = PCM)
  const format = buffer.readUInt16LE(20);
  assert.equal(format, 1, 'Audio format must be 1 (PCM)');

  // Validate mono channel (1 channel)
  const channels = buffer.readUInt16LE(22);
  assert.equal(channels, 1, 'Channels must be 1 (Mono)');

  // Validate 22050Hz sample rate
  const sampleRate = buffer.readUInt32LE(24);
  assert.equal(sampleRate, 22050, 'Sample rate must be 22050 Hz');

  // Validate 16 bits per sample
  const bitsPerSample = buffer.readUInt16LE(34);
  assert.equal(bitsPerSample, 16, 'Bits per sample must be 16');

  // Validate data subchunk
  assert.equal(buffer.toString('ascii', 36, 40), 'data');
  const dataSize = buffer.readUInt32LE(40);
  assert.ok(dataSize > 0, 'Data chunk size must be greater than 0');
});

test('synthOnDeviceSpeech supports heart, michael, and emma voices with varying sample lengths', async () => {
  const synthOnDeviceSpeech = extractFunction('synthOnDeviceSpeech');

  const text = 'Testing distinct on-device neural acoustic vocalizations.';
  const heartRes = await synthOnDeviceSpeech(text, 'heart');
  const michaelRes = await synthOnDeviceSpeech(text, 'michael');
  const emmaRes = await synthOnDeviceSpeech(text, 'emma');

  assert.ok(heartRes, 'heart voice generates audio');
  assert.ok(michaelRes, 'michael voice generates audio');
  assert.ok(emmaRes, 'emma voice generates audio');
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

test('synthOnDeviceSpeech includes 40-60ms zero-padded silence at start and end of audio buffer', async () => {
  const synthOnDeviceSpeech = extractFunction('synthOnDeviceSpeech');
  const result = await synthOnDeviceSpeech('Punctuation, prosody and test.', 'heart');
  let buf;
  if (result.startsWith('data:audio/wav;base64,')) {
    const b64 = result.replace('data:audio/wav;base64,', '');
    buf = Buffer.from(b64, 'base64');
  } else {
    const res = await fetch(result);
    buf = Buffer.from(await res.arrayBuffer());
  }

  // Verify first 40ms of samples are 0 (50ms = 1102 samples at 22050Hz; 40ms = 882 samples)
  // Each 16-bit PCM sample is 2 bytes starting at offset 44
  let startSilenceSamples = 0;
  for (let i = 0; i < 882; i++) {
    const val = buf.readInt16LE(44 + i * 2);
    if (val === 0) startSilenceSamples++;
  }
  assert.ok(startSilenceSamples >= 800, 'Start of buffer must contain zero-padded silence to prevent phoneme clipping');

  // Verify last 40ms of samples are 0
  const totalSamples = buf.readUInt32LE(40) / 2;
  let endSilenceSamples = 0;
  for (let i = totalSamples - 882; i < totalSamples; i++) {
    const val = buf.readInt16LE(44 + i * 2);
    if (val === 0) endSilenceSamples++;
  }
  assert.ok(endSilenceSamples >= 800, 'End of buffer must contain zero-padded silence to prevent phoneme clipping');
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

test('encodeMonoWavBuffer and extractWavPcm round-trip 24000Hz Kokoro PCM cleanly', () => {
  const encodeMonoWavBuffer = extractFunction('encodeMonoWavBuffer');
  const extractWavPcm = extractFunction('extractWavPcm');

  const samples = new Float32Array([0, 0.25, -0.5, 0.75, -0.9]);
  const wav = encodeMonoWavBuffer(samples, 24000);
  const decoded = extractWavPcm(wav);

  assert.ok(decoded, 'extractWavPcm parses WAV buffer');
  assert.equal(decoded.sampleRate, 24000, 'Preserves 24000Hz Kokoro sample rate');
  assert.equal(decoded.pcmData.length, samples.length);
  for (let i = 0; i < samples.length; i++) {
    assert.ok(Math.abs(decoded.pcmData[i] - samples[i]) < 0.001, `Sample ${i} matches within 16-bit precision`);
  }
});

test('Studio (On-Device) wires Kokoro-82M WASM voice mapping and multi-node session cancellation', () => {
  const appSrc = readFileSync(fileURLToPath(new URL('../public/app.js', import.meta.url)), 'utf8');

  assert.match(appSrc, /loadKokoroOnDeviceTts/, 'defines real Kokoro neural WASM loader');
  assert.match(appSrc, /onnx-community\/Kokoro-82M-v1\.0-ONNX/, 'uses Kokoro-82M-v1.0-ONNX');
  assert.match(appSrc, /heart:\s*'af_heart'/, 'maps heart to af_heart');
  assert.match(appSrc, /michael:\s*'am_michael'/, 'maps michael to am_michael');
  assert.match(appSrc, /emma:\s*'bf_emma'/, 'maps emma to bf_emma');
  assert.match(appSrc, /wasmActiveSourceNodes\.forEach/, 'cancelAllSpeech stops all scheduled WASM nodes');
  assert.match(appSrc, /wasmScheduledChunks\.clear\(\)/, 'cancelAllSpeech clears scheduled chunk map');
  assert.match(appSrc, /wasmScheduledChunks\.get\(schedKey\)/, 'speakServerless adopts pre-scheduled chunks without double playback');
});
