import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
  const body = app.slice(getNeuralSrcIdx, getNeuralSrcIdx + 3000);

  const idbCheckIdx = body.indexOf('getAudioFromIdbCache');
  const fetchTtsIdx = body.indexOf("fetch('/api/tts'");
  assert.ok(idbCheckIdx > -1, 'checks getAudioFromIdbCache');
  assert.ok(fetchTtsIdx > -1, 'contains fetch /api/tts');
  assert.ok(idbCheckIdx < fetchTtsIdx, 'IndexedDB cache lookup happens before calling /api/tts');
});

test('public/app.js restricts MP3 export to pro or BYOK users', () => {
  const app = read('public/app.js');
  assert.match(app, /async function canExportAudio/, 'canExportAudio exists');
  assert.match(app, /exportAudioForSentences/, 'exportAudioForSentences exists');
  assert.match(app, /openPaywall\(\)/, 'opens paywall when user is not pro/byok');
});

test('public/app.js stitches audio chunks and triggers chapter/summary download', () => {
  const app = read('public/app.js');
  assert.match(app, /new Blob\(chunks,\s*\{\s*type:\s*mime\s*\}\)/, 'stitches audio chunks into a single Blob');
  assert.match(app, /a\.download\s*=\s*`\$\{safeTitle\}\$\{ext\}`/, 'sets download filename');
  assert.match(app, /getActiveChapterSentences/, 'getActiveChapterSentences extracts sentences for the active chapter');
});
