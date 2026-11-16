// Local speech-to-text with Whisper (transformers.js on onnxruntime-node).
// Runs in an Electron utility process so inference never blocks the UI; the
// model is downloaded once from Hugging Face and cached under userData.
const { pipeline, env } = require('@huggingface/transformers');

// Download through Chromium's network stack (system proxy, same TLS as the
// browser) rather than Node's fetch, which some networks reset.
try {
  const { net } = require('electron');
  if (net?.fetch) env.fetch = (url, init) => net.fetch(String(url), init);
} catch {
  // plain Node (tests): keep the default fetch
}

let asr = null;
let loadedModel = '';
let loading = null;
// One segment at a time: two speakers share this process.
let queue = Promise.resolve();

// Whisper tends to "hear" these on near-silent audio.
const HALLUCINATIONS = /^(thank you\.?|thanks for watching!?|you|bye\.?|\.+|okay\.?)$/i;

function clean(text) {
  const t = text
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return HALLUCINATIONS.test(t) ? '' : t;
}

async function load(model, cacheDir, onProgress) {
  if (asr && loadedModel === model) return asr;
  if (loading?.model === model) return loading.promise;
  env.cacheDir = cacheDir;
  const options = {
    dtype: 'q8',
    device: 'cpu',
    // Measured in tests/bench/whisper-memory.js: ONNX Runtime's CPU memory
    // arena plus one thread per core grew the process to ~1.3 GB; without
    // the arena and with 4 threads it peaks at ~430 MB and runs ~18% faster.
    session_options: { enableCpuMemArena: false, intraOpNumThreads: 4, interOpNumThreads: 1 },
    progress_callback: (p) => {
      if (p.status === 'progress' && p.file?.endsWith('.onnx')) onProgress(Math.round(p.progress || 0));
    },
  };
  // Load from the local cache first (fast, works offline); download only if
  // the model isn't there yet. The cache uses the same <org>/<model>/ layout.
  const fromCache = () => {
    env.localModelPath = cacheDir;
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    return pipeline('automatic-speech-recognition', model, options);
  };
  const download = () => {
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    return pipeline('automatic-speech-recognition', model, options);
  };
  const promise = fromCache().catch(download).then((pipe) => {
    asr = pipe;
    loadedModel = model;
    loading = null;
    return pipe;
  });
  loading = { model, promise };
  promise.catch(() => (loading = null));
  return promise;
}

async function transcribe({ model, language, audio, cacheDir }, onProgress) {
  const pipe = await load(model, cacheDir, onProgress);
  const options = {};
  // English-only checkpoints (".en") reject language/task options.
  if (!model.endsWith('.en')) {
    options.task = 'transcribe';
    if (language && language !== 'multi') options.language = language;
  }
  const out = await pipe(audio, options);
  return clean(out.text || '');
}

function handle(msg, reply) {
  if (msg.type === 'warmup') {
    queue = queue
      .then(() => load(msg.model, msg.cacheDir, (progress) => reply({ type: 'progress', progress })))
      .then(() => reply({ type: 'ready', id: msg.id }))
      .catch((err) => reply({ type: 'error', id: msg.id, error: err.message }));
    return;
  }
  if (msg.type === 'transcribe') {
    queue = queue
      .then(() => transcribe(msg, (progress) => reply({ type: 'progress', progress })))
      .then((text) => reply({ type: 'result', id: msg.id, text }))
      .catch((err) => reply({ type: 'error', id: msg.id, error: err.message }));
  }
}

if (process.parentPort) {
  process.parentPort.on('message', ({ data }) => handle(data, (m) => process.parentPort.postMessage(m)));
}

module.exports = { handle, transcribe };
