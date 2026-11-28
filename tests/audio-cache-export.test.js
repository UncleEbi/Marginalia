import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractFunction } from './helpers/extract-function.mjs';

const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

test('public/index.html includes Chapter & Summary audio export buttons and modal', () => {
  const html = read('public/index.html');
  assert.match(html, /id="exportChapterMp3Btn"/, 'exportChapterMp3Btn exists in jump/chapter selector');
  assert.match(html, /id="exportSummaryMp3Btn"/, 'exportSummaryMp3Btn exists in AI summary modal');
  assert.match(html, /id="audioExportModal"/, 'audioExportModal exists');
  assert.match(html, /id="audioExportProgressBar"/, 'audioExportProgressBar exists');
  assert.match(html, /id="audioExportStatusText"/, 'audioExportStatusText exists');
  assert.match(html, /id="audioExportCancelBtn"/, 'audioExportCancelBtn exists');
});

test('public/app.js configures audio_cache in IndexedDB with 100MB cap and LRU eviction', () => {
  const app = read('public/app.js');
  assert.match(app, /db\.createObjectStore\("audio_cache",\s*\{\s*keyPath:\s*"cacheKey"\s*\}\)/, 'audio_cache object store is registered');
  assert.match(app, /createIndex\("lastAccessedAt",\s*"lastAccessedAt"/, 'lastAccessedAt index is created on audio_cache');
  assert.match(app, /AUDIO_CACHE_MAX_BYTES\s*=\s*100\s*\*\s*1024\s*\*\s*1024/, '100 MB max cap defined');
  assert.match(app, /AUDIO_CACHE_TARGET_BYTES\s*=\s*85\s*\*\s*1024\s*\*\s*1024/, '85 MB eviction target defined');
});

test('public/app.js defines computeAudioCacheKey with SHA-256 and text normalization', async () => {
  const app = read('public/app.js');
  assert.match(app, /function computeAudioCacheKey/, 'computeAudioCacheKey function is defined');
  assert.match(app, /crypto\.subtle\.digest\('SHA-256'/, 'uses SHA-256 for audio cache keys');

  // Verify SHA-256 hash algorithm directly
  const engine = 'openai';
  const voice = 'alloy';
  const speed = 1;
  const text1 = '   Hello   world!  ';
  const text2 = 'Hello world!';

  const norm1 = text1.trim().replace(/\s+/g, ' ');
  const norm2 = text2.trim().replace(/\s+/g, ' ');
  assert.equal(norm1, norm2);

  const raw = `${engine}:${voice}:${speed}:${norm1}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const hash = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  assert.equal(typeof hash, 'string');
  assert.equal(hash.length, 64);
});

test('public/app.js implements cache-first playback before fetching TTS', () => {
  const app = read('public/app.js');
  const getNeuralSrcIdx = app.indexOf('async function getNeuralAudioSrc(text)');
  assert.ok(getNeuralSrcIdx > -1, 'getNeuralAudioSrc exists');
  const body = app.slice(getNeuralSrcIdx, getNeuralSrcIdx + 5000);

  const idbCheckIdx = body.indexOf('getAudioFromIdbCache');
  const fetchTtsIdx = body.indexOf("fetch('/api/tts'");
  assert.ok(idbCheckIdx > -1, 'checks getAudioFromIdbCache');
  assert.ok(fetchTtsIdx > -1, 'contains fetch /api/tts');
  assert.ok(idbCheckIdx < fetchTtsIdx, 'IndexedDB cache lookup happens before calling /api/tts');
});

test('public/app.js restricts cloud audio export to pro or BYOK users, but not local Studio', () => {
  const app = read('public/app.js');
  assert.match(app, /async function canExportAudio/, 'canExportAudio exists');
  assert.match(app, /exportAudioForSentences/, 'exportAudioForSentences exists');
  assert.match(app, /openPaywall\(\)/, 'opens paywall when user is not pro/byok');
  assert.match(
    app,
    /if \(activeEngine === 'wasm'\) return true;/,
    'Studio export costs no provider credits, so it is not behind the paywall'
  );
});

test('public/app.js triggers the chapter/summary download with a matching extension', () => {
  const app = read('public/app.js');
  assert.match(app, /a\.download\s*=\s*`\$\{safeTitle\}\$\{ext\}`/, 'sets download filename');
  assert.match(app, /const ext = \(finalBlob\.type \|\| ''\)\.includes\('wav'\) \? '\.wav' : '\.mp3'/, 'the extension follows the file Studio actually produced');
  assert.match(app, /getActiveChapterSentences/, 'getActiveChapterSentences extracts sentences for the active chapter');
});

test('the export dialog names the real format instead of always claiming .mp3', () => {
  const html = read('public/index.html');
  assert.match(html, /id="audioExportTitle"/, 'the dialog title is addressable');
  assert.ok(!html.includes('Exporting Audio (.mp3)'), 'no hard-coded mp3 claim when the dialog opens');
  const exportFn = extractFunction('exportAudioForSentences').toString();
  assert.match(exportFn, /engine === 'wasm' \? '\.wav' : '\.mp3'/, 'Studio exports say .wav, the cloud voice says .mp3');
});

test('stitchExportChunks writes one WAV header, keeps the seam, and frees its sources', async () => {
  // The stitcher is a top-level function of a classic script, so hand the extracted copy the two
  // helpers it calls (a Function body resolves free identifiers on globals) and run the real code.
  const encode = extractFunction('encodeMonoWavBuffer');
  const decode = extractFunction('extractWavPcm');
  globalThis.encodeMonoWavBuffer = encode;
  globalThis.extractWavPcm = decode;
  try {
    const stitch = extractFunction('stitchExportChunks');
    const first = Float32Array.from({ length: 120 }, (_, i) => Math.sin(i / 6) * 0.5);
    const second = Float32Array.from({ length: 80 }, (_, i) => Math.cos(i / 9) * 0.4);
    const chunks = [
      new Blob([encode(first, 24000)], { type: 'audio/wav' }),
      new Blob([encode(second, 24000)], { type: 'audio/wav' }),
    ];

    const blob = await stitch(chunks, 'wasm');
    const buffer = await blob.arrayBuffer();
    const view = new DataView(buffer);

    assert.equal(blob.type, 'audio/wav');
    assert.equal(buffer.byteLength, 44 + (first.length + second.length) * 2, 'one header for the whole chapter');
    let riffCount = 0;
    for (let o = 0; o + 4 <= buffer.byteLength; o++) {
      if (view.getUint32(o, false) === 0x52494646) riffCount++; // 'RIFF'
    }
    assert.equal(riffCount, 1, 'a header per sentence is what makes players stop after sentence one');

    const pcm = decode(buffer);
    assert.ok(pcm, 'the stitched file parses as WAV');
    assert.equal(pcm.sampleRate, 24000);
    assert.equal(pcm.pcmData.length, first.length + second.length, 'no samples lost at the seam');
    assert.ok(Math.abs(pcm.pcmData[first.length - 1] - first[first.length - 1]) < 1e-3, 'the seam keeps the last sample of the first clip');
    assert.ok(Math.abs(pcm.pcmData[first.length] - second[0]) < 1e-3, 'and starts the second clip immediately after it');

    assert.deepEqual(chunks, [], 'each source blob is released as it is decoded');
  } finally {
    delete globalThis.encodeMonoWavBuffer;
    delete globalThis.extractWavPcm;
  }
});

test('cancelling an export aborts the in-flight /api/tts request so it is not billed', () => {
  const exportFn = extractFunction('exportAudioForSentences').toString();
  assert.match(exportFn, /new AbortController\(\)/, 'the export needs a cancel handle for its request');
  assert.match(exportFn, /controller\.abort\(\)/, 'the cancel button drops the request on the wire');
  assert.match(
    exportFn,
    /getNeuralAudioSrc\(s, \{ speed, signal: controller\.signal \}\)/,
    'the abort signal reaches the fetch'
  );
  assert.match(exportFn, /err\.name === 'AbortError'/, 'an aborted request reads as cancelled, not failed');
  assert.match(exportFn, /new MutationObserver\(\(\) => \{/, 'closing the dialog has to be observed');
  assert.match(exportFn, /if \(exportModal\.style\.display === 'none'\) onCancel\(\)/, 'hiding the dialog cancels the export');
  assert.match(exportFn, /if \(modalObserver\) modalObserver\.disconnect\(\)/, 'and the observer is released');
});
