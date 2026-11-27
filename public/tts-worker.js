// public/tts-worker.js
//
// Runs Kokoro-82M WebAssembly neural TTS off the main UI thread so scrolling,
// pausing, Word Karaoke, and touch interactions never freeze during synthesis.

const KOKORO_CDN_URL = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm';
const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

// WebGPU runs Kokoro far faster than WASM, but it needs a half-precision build: model_fp16.onnx is
// 155.7 MiB against the 88.1 MiB q8 WASM one, and its runtime wasm binary is 20.6 MiB against
// 10.6 MiB. So only take the GPU path when the adapter can actually run f16 shaders and the
// connection can afford the extra download; otherwise stay on the q8 WASM build rather than fall
// back to the 310.5 MiB fp32 model.
const WASM_BACKEND = { device: 'wasm', dtype: 'q8' };
const WEBGPU_BACKEND = { device: 'webgpu', dtype: 'fp16' };

// The fp16 build is ~78 MiB heavier than the q8 one, so a metered or slow link gets the q8 build
// even on a capable GPU. `downlink` is in Mbps and only trusted when the browser reports one.
const MIN_GPU_DOWNLINK_MBPS = 3;
const SLOW_EFFECTIVE_TYPES = new Set(['slow-2g', '2g', '3g']);

// Why the GPU path was skipped, or null when the connection can afford it. The string is reported
// with the backend so a reader can see which gate fired without opening DevTools' network tab.
function connectionLimit() {
  const connection = typeof navigator !== 'undefined' ? navigator.connection : null;
  // No Network Information API (Safari, older Firefox): keep the GPU path rather than guess.
  if (!connection) return null;
  if (connection.saveData) return 'data-saver';
  if (SLOW_EFFECTIVE_TYPES.has(connection.effectiveType)) return `slow-${connection.effectiveType}`;
  if (typeof connection.downlink === 'number' && connection.downlink > 0
    && connection.downlink < MIN_GPU_DOWNLINK_MBPS) return `slow-${connection.downlink}Mbps`;
  return null;
}

let activeBackend = WASM_BACKEND;
let ttsPromise = null;
let activeSessionId = 0;
let running = false;
const queue = [];

// Chunks are deliberately small: the first one is what the reader hears, and it arrives after one
// inference instead of one per sentence, so Studio starts speaking several times sooner and the
// clauses behind it stream in while it plays.
function splitLongText(text, maxLen = 80) {
  const clean = String(text || '').trim().replace(/\s+/g, ' ');
  if (!clean) return [];
  if (clean.length <= maxLen) return [clean];

  // Clause boundaries with the punctuation kept on the clause before them. No lookbehind: Safari
  // before 16.4 cannot parse one, and a regex literal that fails to parse takes the whole worker
  // down — every sentence then falls back to the main thread, which is the slowest path there is.
  const clauses = (clean.match(/[^,;:\u2014]+[,;:\u2014]?/g) || [clean])
    .map((clause) => clause.trim())
    .filter(Boolean);
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

const downloadProgress = new Map();

function reportProgress(info) {
  if (!info) return;
  if (info.status === 'progress' && info.file) {
    downloadProgress.set(info.file, { loaded: info.loaded || 0, total: info.total || 0 });
    let loadedSum = 0;
    let totalSum = 0;
    downloadProgress.forEach((v) => { loadedSum += v.loaded; totalSum += v.total; });
    if (totalSum > 0) {
      const pct = Math.min(99, Math.floor((loadedSum / totalSum) * 100));
      self.postMessage({ type: 'progress', stage: 'downloading', pct });
    }
  } else if (info.status === 'ready' || info.status === 'done') {
    self.postMessage({ type: 'progress', stage: 'preparing' });
  }
}

// A worker can reach WebGPU too, so the whole pipeline stays off the UI thread.
async function chooseBackend() {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    return { backend: WASM_BACKEND, reason: 'no-webgpu' };
  }
  const limit = connectionLimit();
  if (limit) return { backend: WASM_BACKEND, reason: limit };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { backend: WASM_BACKEND, reason: 'no-gpu-adapter' };
    if (!adapter.features.has('shader-f16')) return { backend: WASM_BACKEND, reason: 'no-shader-f16' };
    return { backend: WEBGPU_BACKEND, reason: 'webgpu-ready' };
  } catch (err) {
    return { backend: WASM_BACKEND, reason: 'adapter-error' };
  }
}

async function getTts() {
  if (!ttsPromise) {
    ttsPromise = (async () => {
      self.postMessage({ type: 'progress', stage: 'downloading', pct: 0 });
      downloadProgress.clear(); // a failed GPU start must not leave stale byte counts behind
      const { KokoroTTS } = await import(KOKORO_CDN_URL);
      const load = (backend) => KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
        device: backend.device,
        dtype: backend.dtype,
        progress_callback: reportProgress
      });

      const { backend: preferred, reason } = await chooseBackend();
      let tts;
      let backendReason = reason;
      try {
        tts = await load(preferred);
        activeBackend = preferred;
      } catch (err) {
        // A machine can advertise WebGPU and still fail to build the session; the WASM build is
        // always available, so a failed GPU start never costs the reader their voice.
        if (preferred.device !== 'webgpu') throw err;
        tts = await load(WASM_BACKEND);
        activeBackend = WASM_BACKEND;
        backendReason = 'webgpu-init-failed';
      }
      self.postMessage({
        type: 'backend',
        device: activeBackend.device,
        dtype: activeBackend.dtype,
        reason: backendReason
      });
      return tts;
    })().catch((err) => {
      ttsPromise = null;
      throw err;
    });
  }
  return ttsPromise;
}

// Every sentence longer than one chunk is split at its clauses, and each one is handed to `emit` as
// soon as it is synthesized, so the reader hears the opening clause while the rest is still being
// generated. The clause's inter-sentence pause is carried inside its samples (except for the last
// one) so the player can schedule the chunks back to back without knowing about gaps. Text that
// fits in one chunk still comes back merged.
async function synthesizeSegments(tts, text, voice, speed, emit, isCancelled) {
  const parts = splitLongText(text);
  if (parts.length === 0) return { pcm: new Float32Array(0), sampleRate: 24000 };

  if (parts.length === 1) {
    const out = await tts.generate(parts[0], { voice, speed });
    const raw = out && (out.audio || out.data);
    return {
      pcm: raw ? Float32Array.from(raw) : new Float32Array(0),
      sampleRate: (out && out.sampling_rate) || 24000
    };
  }

  let sampleRate = 24000;
  for (let i = 0; i < parts.length; i++) {
    if (isCancelled()) return { cancelled: true };
    const out = await tts.generate(parts[i], { voice, speed });
    if (out && out.sampling_rate) sampleRate = out.sampling_rate;
    // Synthesizing can outlive the request that asked for it: stop before emitting stale audio.
    if (isCancelled()) return { cancelled: true };
    const raw = out && (out.audio || out.data);
    let pcm = raw && raw.length ? Float32Array.from(raw) : new Float32Array(0);
    if (pcm.length && i < parts.length - 1) {
      const gapSamples = Math.round(sampleRate * 0.08);
      const padded = new Float32Array(pcm.length + gapSamples);
      padded.set(pcm);
      pcm = padded;
    }
    emit({
      index: i,
      count: parts.length,
      text: parts[i],
      pcm,
      sampleRate,
      final: i === parts.length - 1
    });
  }
  return { streamed: true, sampleRate };
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
        if (job.type === 'warmup') {
          // Load the model and compile/allocate now, so the first Play only has to synthesize. The
          // throwaway utterance is skipped when a real job is already waiting behind this warmup.
          if (queue.length === 0) {
            try {
              await tts.generate('Ready.', { voice: job.voice, speed: 1 });
            } catch (err) {}
          }
          self.postMessage({ type: 'warmed' });
          continue;
        }

        self.postMessage({ type: 'progress', stage: 'synthesizing' });
        const out = await synthesizeSegments(
          tts,
          job.text,
          job.voice,
          job.speed,
          (chunk) => {
            // The merge buffer is not built for streamed jobs, so hand over a copy and keep the
            // original intact for the (single-clause) merged path below.
            const copy = chunk.pcm.slice();
            self.postMessage(
              {
                type: 'chunk',
                id: job.id,
                index: chunk.index,
                count: chunk.count,
                text: chunk.text,
                pcmBuffer: copy.buffer,
                sampleRate: chunk.sampleRate,
                final: chunk.final
              },
              [copy.buffer]
            );
          },
          () => job.sessionId != null && job.sessionId < activeSessionId
        );
        if (out.cancelled) {
          self.postMessage({ type: 'cancelled', id: job.id });
          continue;
        }
        if (out.streamed) {
          self.postMessage({ type: 'result', id: job.id, streamed: true, sampleRate: out.sampleRate });
          continue;
        }
        self.postMessage(
          { type: 'result', id: job.id, pcmBuffer: out.pcm.buffer, sampleRate: out.sampleRate },
          [out.pcm.buffer]
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

  if (msg.type === 'warmup') {
    queue.push({
      id: null,
      type: 'warmup',
      voice: msg.voice || 'af_heart',
      sessionId: activeSessionId
    });
    drainQueue();
    return;
  }

  if (msg.type === 'synthesize') {
    const job = {
      id: msg.id,
      text: msg.text,
      voice: msg.voice || 'af_heart',
      speed: Number(msg.speed) > 0 ? Number(msg.speed) : 1,
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
