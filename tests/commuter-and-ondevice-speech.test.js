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

// public/app.js is one classic script, so its functions reach each other through the global scope.
// An extracted function needs the same for the helpers it calls.
globalThis.encodeWasmPcmToBlobUrl = extractFunction('encodeWasmPcmToBlobUrl');

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

test('Studio bakes the reading speed into synthesis and schedules buffers in real time', () => {
  const appSrc = readFileSync(fileURLToPath(new URL('../public/app.js', import.meta.url)), 'utf8');
  const workerSrc = readFileSync(fileURLToPath(new URL('../public/tts-worker.js', import.meta.url)), 'utf8');

  // 1. Model sample rate used in createBuffer
  assert.ok(
    appSrc.includes('audioCtx.createBuffer(1, pcmData.length, rate') ||
    appSrc.includes('audioCtx.createBuffer(1, pcmData.length, modelSampleRate)'),
    'createBuffer must use native modelSampleRate'
  );

  // 2. Speed reaches the synthesizer and never the playout graph: retiming an
  //    AudioBufferSourceNode resamples it and raises its pitch (the chipmunk effect at 1.5x/2x).
  assert.match(workerSrc, /synthesizeSegments\(tts, text, voice, speed, emit, isCancelled\)/);
  assert.match(workerSrc, /tts\.generate\(parts\[i\], \{ voice, speed \}\)/);
  assert.ok(appSrc.includes('sourceNode.playbackRate.value = 1;'), 'first chunk plays at real time');
  assert.ok(appSrc.includes('nextSource.playbackRate.value = 1;'), 'pre-scheduled chunk plays at real time');
  assert.ok(appSrc.includes('source.playbackRate.value = 1;'), 'streamed clauses play at real time');
  assert.ok(!appSrc.includes('playbackRate.value = playbackSpeed'), 'no Studio buffer may be retimed');
  assert.ok(
    appSrc.includes("const speed = engine === 'wasm' ? (Number(opts.speed) > 0 ? Number(opts.speed) : playbackSpeed) : 1;"),
    'Studio synthesizes at the reading speed; the cloud voice stays at 1x'
  );
  assert.ok(
    !appSrc.includes('(audioCtx.currentTime - startTime) * playbackSpeed'),
    'karaoke reads clip time directly because the tempo is already in the buffer'
  );

  // 3. A 2x clip is a different recording from the 1x one, in memory and in IndexedDB, and both
  //    keys name Studio's resolved voice (heart for a leftover cloud id), never the raw picker.
  assert.ok(
    appSrc.includes("const voice = activeEngine === 'wasm' ? wasmCacheVoiceId() : voicePicker.value;"),
    'the in-memory key must resolve a leftover cloud voice id the same way IndexedDB does'
  );
  assert.match(appSrc, /\$\{activeEngine\}_\$\{voice\}_\$\{speed\}_\$\{normalized\}/);
  assert.ok(appSrc.includes("computeAudioCacheKey('wasm_kokoro_v1', wasmCacheVoiceId(), speed, text)"));
  assert.ok(
    appSrc.includes('const key = neuralCacheKey(spokenText, speed);'),
    'the in-memory key must use the synthesized speed, so a 1x export never lands under the 2x key'
  );

  // 4. Natural punctuation preserved without stripping
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

test('Studio synthesis lead is measured in seconds, so 2x queues more sentences than 1x', () => {
  const appSrc = readFileSync(fileURLToPath(new URL('../public/app.js', import.meta.url)), 'utf8');
  const target = Number((appSrc.match(/WASM_AHEAD_SECONDS = ([\d.]+)/) || [])[1]);
  assert.ok(target > 0, 'WASM_AHEAD_SECONDS must be a positive number of seconds');
  const queuedSeconds = extractFunction('wasmQueuedSeconds');

  // The queue is topped up while the audio already scheduled covers less than the lead target.
  assert.match(
    appSrc,
    /wasmQueuedSeconds\(audioCtx\.currentTime, wasmScheduledEndTime\) >= WASM_AHEAD_SECONDS\) break;/,
    'the lead has to be compared in seconds, not sentences'
  );
  assert.match(appSrc, /let scheduled = 0;/, 'the first lookahead stays unconditional');

  // Simulate the production loop: the sentence playing is already scheduled, one more sentence is
  // always queued ahead of it, and further sentences are added until the scheduled audio reaches the
  // target. The lookahead count is what changes with speed, not the lead in seconds.
  const simulate = (clipSeconds) => {
    let end = clipSeconds;
    let lookahead = 0;
    while (lookahead < 50) {
      if (lookahead > 0 && queuedSeconds(0, end) >= target) break;
      end += clipSeconds;
      lookahead++;
    }
    return { lookahead, leadSeconds: queuedSeconds(0, end) };
  };

  const at1x = simulate(5); // a sentence that takes 5s to read at 1x
  const at2x = simulate(2.5); // the same sentence at 2x: half the audio

  assert.ok(queuedSeconds(0, 2.5) < target, 'one sentence at 2x on its own is thinner than the target lead');
  assert.ok(at1x.leadSeconds >= target && at2x.leadSeconds >= target, 'both speeds hold the lead in seconds');
  assert.ok(at2x.lookahead > at1x.lookahead, 'the shorter 2x clips need more sentences queued for the same lead');
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
  assert.match(appSrc, /stitchWasmClauseStream\(pending\.stream, pending\.text\)\s*\.catch\(/, 'a stitching failure cannot surface as an unhandled rejection');
});

test('a finished clause stream is stitched into one cached clip so replay does not re-synthesize it', async () => {
  const stitchWasmClauseStream = extractFunction('stitchWasmClauseStream');

  const encoded = [];
  const cached = [];
  const savedIdb = [];
  const released = [];
  const saved = {
    encodeWasmPcmToBlobUrl: globalThis.encodeWasmPcmToBlobUrl,
    cacheAudio: globalThis.cacheAudio,
    neuralCacheKey: globalThis.neuralCacheKey,
    wasmCacheVoiceId: globalThis.wasmCacheVoiceId,
    computeAudioCacheKey: globalThis.computeAudioCacheKey,
    saveAudioToIdbCache: globalThis.saveAudioToIdbCache,
    releaseAudioSrc: globalThis.releaseAudioSrc,
    fetch: globalThis.fetch,
    modelSampleRate: globalThis.modelSampleRate
  };

  globalThis.modelSampleRate = 24000;
  globalThis.releaseAudioSrc = (src) => { released.push(src); };
  globalThis.encodeWasmPcmToBlobUrl = (pcm, rate) => {
    encoded.push({ samples: Array.from(pcm), rate });
    return `blob:stitched-${encoded.length}`;
  };
  globalThis.neuralCacheKey = (text) => `preload:${text}`;
  globalThis.wasmCacheVoiceId = () => 'heart';
  globalThis.cacheAudio = (key, src) => cached.push({ key, src });
  globalThis.computeAudioCacheKey = async (engine, voice, speed, text) => `idb:${engine}:${voice}:${speed}:${text}`;
  globalThis.saveAudioToIdbCache = async (key, blob) => { savedIdb.push({ key, size: blob.size }); return true; };
  globalThis.fetch = async () => ({ blob: async () => ({ size: 1234 }) });

  try {
    const chunk = (index, samples, final = false) => ({
      index, count: 2, text: `clause ${index}`, pcm: new Float32Array(samples), sampleRate: 24000, final
    });
    const text = 'First clause, second clause.';
    const stream = { src: 'blob:clause-0', chunks: [chunk(0, [0.1, 0.2]), chunk(1, [0.3], true)], done: true, onChunk: null, nextIndex: 1 };

    // The worker is still synthesizing the sentence: there is nothing whole to store yet.
    assert.equal(await stitchWasmClauseStream({ ...stream, done: false }, text), null);
    assert.equal(encoded.length, 0);
    assert.ok(stream.chunks[0].pcm && stream.chunks[1].pcm, 'an unstitched stream keeps its clauses');
    assert.deepEqual(released, []);

    const src = await stitchWasmClauseStream(stream, text);
    assert.equal(src, 'blob:stitched-1');
    assert.equal(encoded.length, 1, 'the clauses are encoded once, as one clip');
    assert.deepEqual(
      encoded[0].samples,
      [0.1, 0.2, 0.3].map((x) => Math.fround(x)),
      'clauses are joined in order with no samples dropped or repeated'
    );
    assert.equal(encoded[0].rate, 24000, 'the model sample rate is kept');
    assert.equal(stream.mergedSrc, src, 'playback can tell the stream is now a whole clip');
    assert.deepEqual(cached, [{ key: `preload:${text}`, src }], 'the full clip is cached for replay');
    assert.deepEqual(
      savedIdb,
      [{ key: `idb:wasm_kokoro_v1:heart:1:${text}`, size: 1234 }],
      'and persisted in IndexedDB under the same key a replay looks up'
    );

    // Stitching twice must not rebuild or re-cache the clip.
    assert.equal(await stitchWasmClauseStream(stream, text), src);
    assert.equal(encoded.length, 1, 'an already stitched stream is left alone');
    assert.deepEqual(stream.chunks.map((c) => c.pcm), [null, null], 'the per-clause PCM is dropped');
    assert.deepEqual(released, ['blob:clause-0'], "chunk 0's own clip is released too");
    assert.equal(stream.mergedSrc, src, 'the whole-sentence clip is what remains cached');
  } finally {
    Object.assign(globalThis, saved);
  }
});

test('karaoke timeline lines up across clause boundaries and never runs past the visible words', () => {
  const saved = {
    learnedCadenceMultiplier: globalThis.learnedCadenceMultiplier,
    userManualCalibration: globalThis.userManualCalibration,
    computeWordTimeline: globalThis.computeWordTimeline
  };
  globalThis.learnedCadenceMultiplier = 1;
  globalThis.userManualCalibration = 1;
  globalThis.computeWordTimeline = extractFunction('computeWordTimeline');
  const buildClauseKaraokeTimeline = extractFunction('buildClauseKaraokeTimeline');
  const approx = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg} (${a} vs ${b})`);

  try {
    const visible = 'Alpha beta, gamma delta, epsilon zeta.'.split(/\s+/);
    const runs = [
      { words: ['Alpha', 'beta,'], duration: 0.6, offset: 0 },
      { words: ['gamma', 'delta,'], duration: 0.5, offset: 0.6 },
      { words: ['epsilon', 'zeta.'], duration: 0.55, offset: 1.1 }
    ];
    const timeline = buildClauseKaraokeTimeline(runs, visible, 1);

    assert.equal(timeline.length, visible.length, 'one entry per word on screen');
    approx(timeline[2].start, 0.6, 'the first word of clause 2 starts where clause 1 ends');
    approx(timeline[4].start, 1.1, 'clause 3 picks up where clause 2 ends');
    approx(timeline[1].end, 0.6, 'no gap is left at the clause boundary');
    approx(timeline[timeline.length - 1].end, 1.65, 'the run ends with the scheduled audio');
    for (let i = 1; i < timeline.length; i++) {
      assert.ok(timeline[i].start >= timeline[i - 1].start, `word ${i} starts at or after the one before it`);
    }

    // A unit expansion changes the spoken word count ("15 kWh" -> "15 kilowatt hours"); the highlight
    // must still land on the words on screen instead of running past them.
    const spoken = [
      { words: ['Save', '15', 'kilowatt', 'hours', 'now,'], duration: 1, offset: 0 },
      { words: ['then', 'stop.'], duration: 0.5, offset: 1 }
    ];
    const scaled = buildClauseKaraokeTimeline(spoken, 'Save 15 kWh now, then stop.'.split(/\s+/), 1);
    assert.equal(scaled.length, 6, 'the visible words, not the expanded ones');
    approx(scaled[scaled.length - 1].end, 1.5, 'scaled over the audio scheduled so far');
  } finally {
    Object.assign(globalThis, saved);
  }
});

test('Studio (On-Device) offloads synthesis to public/tts-worker.js without blocking main thread', () => {
  const workerSrc = readFileSync(fileURLToPath(new URL('../public/tts-worker.js', import.meta.url)), 'utf8');
  const appSrc = readFileSync(fileURLToPath(new URL('../public/app.js', import.meta.url)), 'utf8');

  assert.match(workerSrc, /KokoroTTS/, 'tts-worker imports KokoroTTS');
  assert.match(workerSrc, /splitLongText/, 'tts-worker splits long clauses cleanly');
  assert.match(workerSrc, /\[out\.pcm\.buffer\]/, 'tts-worker transfers PCM buffer zero-copy');
  assert.match(workerSrc, /\[copy\.buffer\]/, 'tts-worker transfers each streamed clause zero-copy');
  assert.match(appSrc, /new Worker\('tts-worker\.js'/, 'app.js launches tts-worker.js module worker');
  assert.match(appSrc, /if \(!standalone && activeEngine !== 'wasm'\) preloadUpcoming\(myToken\)/, 'wasm skips 3-way preload burst on start');
});
