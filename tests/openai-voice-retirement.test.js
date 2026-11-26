// OpenAI retires tts-1, tts-1-hd and gpt-4o-mini-tts on 6 January 2027, and the model it names as
// the replacement cannot serve /v1/audio/speech. Two things keep readers reading through that:
//   * the route can speak through a Chat-Completions audio model (gpt-audio-*) when configured
//   * a retired model comes back as 410 OPENAI_TTS_RETIRED, and the app answers by moving the
//     reader onto Studio instead of alerting and stopping.
// These are source-contract checks, the same shape as the other route tests in this folder.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractFunction } from './helpers/extract-function.mjs';

const route = await readFile(new URL('../api/tts.js', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('the default OpenAI voice is the current speech model, never the retired tts-1', () => {
  assert.match(route, /DEFAULT_OPENAI_TTS_MODEL = 'gpt-4o-mini-tts'/);
  assert.match(route, /process\.env\.OPENAI_TTS_MODEL \|\| DEFAULT_OPENAI_TTS_MODEL/);
  assert.doesNotMatch(route, /OPENAI_TTS_MODEL \|\| 'tts-1'/, 'tts-1 shuts down on 6 January 2027');
});

test('a gpt-audio model is routed to Chat Completions audio, not the speech endpoint', () => {
  assert.match(route, /const CHAT_AUDIO_MODEL = \/\^gpt-audio\//);
  assert.match(route, /if \(CHAT_AUDIO_MODEL\.test\(model\)\)/);
  assert.match(route, /https:\/\/api\.openai\.com\/v1\/chat\/completions/);
  assert.match(route, /modalities: \['text', 'audio'\]/);
  assert.match(route, /audio: \{ voice, format: 'mp3' \}/);
  assert.match(route, /Read the user message aloud exactly as written/, 'narration must not become an answer');
});

test('a retired model becomes 410 OPENAI_TTS_RETIRED, not a generic 502', () => {
  assert.match(route, /OPENAI_TTS_RETIRED/);
  assert.match(route, /status === 404 \|\| status === 410/);
  assert.match(route, /model_not_found|deprecated|does not exist/);
  assert.match(route, /code: err\.code/, 'the code reaches the client');
});

test('the app switches the reader to Studio when the cloud model is retired', () => {
  assert.match(app, /err\.code = data\.code \|\| data\.error \|\| ''/, 'the server code wins over the message');
  assert.match(app, /function switchToStudioVoice\(\)/);
  assert.match(app, /err\.code === 'OPENAI_TTS_RETIRED' && activeEngine !== 'wasm'/);
  assert.match(app, /localStorage\.setItem\('marginalia_active_engine', 'wasm'\)/);
});

test('the fallback takes over continuous reading only, never tap-to-hear or export', () => {
  assert.match(app, /err\.code === 'OPENAI_TTS_RETIRED' && activeEngine !== 'wasm'\) \{\s*if \(standalone\)/,
    'a one-shot selection speak stays on the voice the reader picked');
  const exportFn = extractFunction('exportAudioForSentences').toString();
  assert.ok(!exportFn.includes('switchToStudioVoice'), 'export must report the failure, not change engines');
});

test('pausing cancels in-flight cloud prefetches so unseen audio is not billed', () => {
  const preload = extractFunction('preloadUpcoming').toString();
  assert.match(preload, /new AbortController\(\)/, 'each prefetch needs its own cancel handle');
  assert.match(preload, /getNeuralAudioSrc\(t, \{ signal: ctrl\.signal \}\)/);
  const getSrc = extractFunction('getNeuralAudioSrc').toString();
  assert.match(getSrc, /signal: opts\.signal/, 'the abort has to reach fetch()');
  const cancel = extractFunction('cancelAllSpeech').toString();
  assert.match(cancel, /abortCloudPrefetch\(\)/, 'pause, skip and engine switches all route through it');
});
