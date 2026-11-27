import test from 'node:test';
import assert from 'node:assert/strict';
import { appSource, extractFunction } from './helpers/extract-function.mjs';

// The recorder reads module-level state the extractor cannot carry across, so inject it the way the
// page has it: the extracted functions resolve these names from globalThis at call time.
globalThis.STUDIO_PERF_SAMPLES = 60;
globalThis.studioPerf = { samples: [], backend: 'unknown', device: '' };
globalThis.studioPerfVerbose = () => false;
const noteStudioSynth = extractFunction('noteStudioSynth');
const studioPerfSummary = extractFunction('studioPerfSummary');

const reset = () => { globalThis.studioPerf.samples.length = 0; };

test('a synthesized chunk is recorded with its real-time factor', () => {
  reset();
  const entry = noteStudioSynth({ backend: 'kokoro-worker', chars: 120, audioMs: 2000, synthMs: 500 });
  assert.equal(entry.rtf, 0.25, 'half a second of work for two seconds of speech');
  assert.equal(entry.chars, 120);
  assert.equal(globalThis.studioPerf.samples.length, 1);
});

test('the real-time factor marks the sentences that outrun the reader', () => {
  reset();
  noteStudioSynth({ backend: 'kokoro-worker', audioMs: 4000, synthMs: 1000 }); // 0.25, queue grows
  noteStudioSynth({ backend: 'kokoro-worker', audioMs: 2000, synthMs: 2000 }); // 1.0, queue holds
  noteStudioSynth({ backend: 'kokoro-main-thread', audioMs: 1000, synthMs: 3000 }); // 3.0, queue drains
  const summary = studioPerfSummary();
  assert.equal(summary.samples, 3);
  assert.equal(summary.slowerThanRealTime, 2, 'a factor of exactly 1 cannot build any lead');
  assert.equal(summary.rtf.median, 1);
  assert.equal(summary.rtf.worst, 3);
  assert.equal(summary.slowest[0].backend, 'kokoro-main-thread', 'the blocking fallback shows up as the worst');
});

test('a sample without audio is dropped instead of poisoning the factor', () => {
  reset();
  assert.equal(noteStudioSynth({ audioMs: 0, synthMs: 10 }), null);
  assert.equal(noteStudioSynth({ audioMs: 1000, synthMs: Number.NaN }), null);
  assert.equal(noteStudioSynth(null), null);
  const summary = studioPerfSummary();
  assert.equal(summary.samples, 0);
  assert.equal(summary.rtf.median, null);
  assert.equal(summary.rtf.worst, null);
});

test('the recorder keeps a bounded window so it can stay switched on', () => {
  reset();
  for (let i = 0; i < 75; i++) noteStudioSynth({ audioMs: 1000, synthMs: 100 + i });
  assert.equal(globalThis.studioPerf.samples.length, 60);
  assert.equal(studioPerfSummary().samples, 60);
  assert.equal(studioPerfSummary().rtf.worst, 0.17, 'the newest samples survive, not the oldest');
});

test('first-clause latency is summarised only for the sentences that reported one', () => {
  reset();
  noteStudioSynth({ audioMs: 1000, synthMs: 200, firstAudioMs: 300 });
  noteStudioSynth({ audioMs: 1000, synthMs: 200, firstAudioMs: 900 });
  noteStudioSynth({ audioMs: 1000, synthMs: 200 });
  const summary = studioPerfSummary();
  assert.equal(summary.firstAudioMs.median, 300);
  assert.equal(summary.firstAudioMs.worst, 900);
});

test('both synthesis paths report to the recorder and the summary is reachable from the page', () => {
  const src = appSource();
  assert.match(src, /queuedAt: studioNow\(\)/, 'worker jobs are timed from the postMessage');
  assert.match(src, /backend: 'kokoro-worker'/, 'worker results are recorded');
  assert.match(src, /backend: 'kokoro-main-thread'/, 'the blocking fallback is recorded');
  assert.match(src, /firstAudioMs: pending\.firstAudioMs/, 'streamed sentences report their first clause');
  assert.match(src, /window\.marginaliaStudioStats = studioPerfSummary/, 'the summary is readable from a console');
  assert.match(src, /studioPerf\.device = `\$\{msg\.device\}\/\$\{msg\.dtype\}`/, 'the backend message names the device');
});
