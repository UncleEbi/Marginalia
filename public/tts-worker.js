// public/tts-worker.js
//
// Runs Kokoro-82M WebAssembly neural TTS off the main UI thread so scrolling,
// pausing, Word Karaoke, and touch interactions never freeze during synthesis.

const KOKORO_CDN_URL = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm';
const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
// Exactly the specifier kokoro-js@1.2.1 imports internally (see its dependency
// on @huggingface/transformers@^3.5.1). Importing the same URL resolves to the
// same module instance, so mutating its env is what onnxruntime actually reads.
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/+esm';

let ttsPromise = null;
let activeSessionId = 0;
let running = false;
const queue = [];

function splitLongText(text, maxLen = 180) {
  const clean = String(text || '').trim().replace(/\s+/g, ' ');
  if (!clean) return [];
  if (clean.length <= maxLen) return [clean];

  const clauses = clean.split(/(?<=[,;:\u2014])\s+/);
  const chunks = [];
  let buf = '';

  for (const clause of clauses) {
    if (buf && (buf.length + 1 + clause.length) > maxLen) {
      chunks.push(buf);
      buf = clause;
    } else {
      buf = buf ? `${buf} ${clause}` : clause;
    }
  }
  if (buf) chunks.push(buf);

  // Fallback word split if a single clause exceeds maxLen without punctuation
  const finalChunks = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxLen) {
      finalChunks.push(chunk);
    } else {
      const words = chunk.split(/\s+/);
      let cur = '';
      for (const w of words) {
        if (cur && (cur.length + 1 + w.length) > maxLen) {
          finalChunks.push(cur);
          cur = w;
        } else {
          cur = cur ? `${cur} ${w}` : w;
        }
      }
      if (cur) finalChunks.push(cur);
    }
  }
  return finalChunks;
}

// WASM threads need SharedArrayBuffer, which needs a cross-origin isolated page
// (COOP/COEP on the document). Without isolation onnxruntime stays
// single-threaded whatever we ask for, so report what actually happens instead
// of assuming the headers worked.
async function configureThreads() {
  const isolated = !!self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
  const requested = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1));
  const threads = isolated ? requested : 1;
  const diag = {
    stage: 'configured',
    isolated,
    requested,
    threads,
    applied: null,
    envSource: null,
    wasmKeys: null,
    hasSAB: typeof SharedArrayBuffer !== 'undefined',
    hardwareConcurrency: navigator.hardwareConcurrency || null,
    error: null
  };
  try {
    const mod = await import(TRANSFORMERS_URL);
    const wasm = mod && mod.env && mod.env.backends && mod.env.backends.onnx && mod.env.backends.onnx.wasm;
    if (wasm) {
      wasm.numThreads = threads;
      diag.applied = wasm.numThreads;
      diag.wasmKeys = Object.keys(wasm);
      diag.envSource = 'transformers';
      self.__ortWasmEnv = wasm;
    } else {
      diag.error = 'env.backends.onnx.wasm unavailable';
    }
  } catch (err) {
    diag.error = String((err && err.message) || err);
  }
  console.log('[tts-worker] threads', JSON.stringify(diag));
  self.postMessage({ type: 'diag', ...diag });
  return diag;
}

async function getTts() {
  if (!ttsPromise) {
    ttsPromise = (async () => {
      self.postMessage({ type: 'progress', stage: 'downloading', pct: 0 });
      const { KokoroTTS } = await import(KOKORO_CDN_URL);
      await configureThreads();
      const fileProgress = new Map();

      const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: (info) => {
          if (!info) return;
          if (info.status === 'progress' && info.file) {
            fileProgress.set(info.file, { loaded: info.loaded || 0, total: info.total || 0 });
            let loadedSum = 0;
            let totalSum = 0;
            fileProgress.forEach((v) => { loadedSum += v.loaded; totalSum += v.total; });
            if (totalSum > 0) {
              const pct = Math.min(99, Math.floor((loadedSum / totalSum) * 100));
              self.postMessage({ type: 'progress', stage: 'downloading', pct });
            }
          } else if (info.status === 'ready' || info.status === 'done') {
            self.postMessage({ type: 'progress', stage: 'preparing' });
          }
        }
      });
      self.postMessage({
        type: 'diag',
        stage: 'ready',
        numThreads: (self.__ortWasmEnv && self.__ortWasmEnv.numThreads) || null,
        wasmKeys: self.__ortWasmEnv ? Object.keys(self.__ortWasmEnv) : null,
        isolated: !!self.crossOriginIsolated
      });
      return tts;
    })().catch((err) => {
      ttsPromise = null;
      throw err;
    });
  }
  return ttsPromise;
}

async function synthesizeSegments(tts, text, voice) {
  const parts = splitLongText(text, 180);
  if (parts.length === 0) return { pcm: new Float32Array(0), sampleRate: 24000 };

  if (parts.length === 1) {
    const out = await tts.generate(parts[0], { voice, speed: 1 });
    const raw = out && (out.audio || out.data);
    return {
      pcm: raw ? Float32Array.from(raw) : new Float32Array(0),
      sampleRate: (out && out.sampling_rate) || 24000
    };
  }

  const arrays = [];
  let sampleRate = 24000;
  let totalLen = 0;
  const gapSamples = Math.round(sampleRate * 0.08);

  for (let i = 0; i < parts.length; i++) {
    const out = await tts.generate(parts[i], { voice, speed: 1 });
    const raw = out && (out.audio || out.data);
    if (out && out.sampling_rate) sampleRate = out.sampling_rate;
    if (raw && raw.length) {
      const f = Float32Array.from(raw);
      arrays.push(f);
      totalLen += f.length;
      if (i < parts.length - 1) totalLen += gapSamples;
    }
  }

  const merged = new Float32Array(totalLen);
  let offset = 0;
  for (let i = 0; i < arrays.length; i++) {
    merged.set(arrays[i], offset);
    offset += arrays[i].length;
    if (i < arrays.length - 1) offset += gapSamples;
  }
  return { pcm: merged, sampleRate };
}

async function drainQueue() {
  if (running) return;
  running = true;

  try {
    while (queue.length > 0) {
      const job = queue.shift();
      if (job.sessionId != null && job.sessionId < activeSessionId) {
        self.postMessage({ type: 'cancelled', id: job.id });
        continue;
      }

      try {
        const tts = await getTts();
        if (job.sessionId != null && job.sessionId < activeSessionId) {
          self.postMessage({ type: 'cancelled', id: job.id });
          continue;
        }
        self.postMessage({ type: 'progress', stage: 'synthesizing' });
        const { pcm, sampleRate } = await synthesizeSegments(tts, job.text, job.voice);
        self.postMessage(
          { type: 'result', id: job.id, pcmBuffer: pcm.buffer, sampleRate },
          [pcm.buffer]
        );
      } catch (err) {
        self.postMessage({
          type: 'error',
          id: job.id,
          message: err?.message || 'On-device synthesis failed.'
        });
      }
    }
  } finally {
    running = false;
  }
}

self.addEventListener('message', (e) => {
  const msg = e.data || {};

  if (msg.type === 'cancel') {
    if (typeof msg.sessionId === 'number') {
      activeSessionId = Math.max(activeSessionId, msg.sessionId);
    }
    for (let i = queue.length - 1; i >= 0; i--) {
      const job = queue[i];
      if (job.sessionId == null || job.sessionId < activeSessionId) {
        queue.splice(i, 1);
        self.postMessage({ type: 'cancelled', id: job.id });
      }
    }
    return;
  }

  if (msg.type === 'synthesize') {
    const job = {
      id: msg.id,
      text: msg.text,
      voice: msg.voice || 'af_heart',
      sessionId: typeof msg.sessionId === 'number' ? msg.sessionId : activeSessionId,
      priority: msg.priority === 'high' ? 0 : 1
    };
    if (job.priority === 0) {
      // Insert active-sentence requests ahead of background preloads
      const firstNormalIdx = queue.findIndex((q) => q.priority > 0);
      if (firstNormalIdx === -1) queue.push(job);
      else queue.splice(firstNormalIdx, 0, job);
    } else {
      queue.push(job);
    }
    drainQueue();
  }
});
