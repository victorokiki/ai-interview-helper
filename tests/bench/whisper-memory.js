// Compares Whisper memory use and speed under different ONNX Runtime session
// options. Runs in plain Node: node tests/bench/whisper-memory.js <variant>
// Variants: default | tuned. Needs the model cached in tests/bench/out/userdata/models.
const fs = require('fs');
const path = require('path');
const { pipeline, env } = require('@huggingface/transformers');

const variant = process.argv[2] || 'default';
const OPTIONS = {
  default: {},
  tuned: { session_options: { enableCpuMemArena: false, intraOpNumThreads: 4, interOpNumThreads: 1 } },
};

(async () => {
  env.cacheDir = path.join(__dirname, 'out', 'userdata', 'models');
  env.allowRemoteModels = false;
  env.localModelPath = env.cacheDir;
  env.allowLocalModels = true;
  const wav = fs.readFileSync(path.join(__dirname, 'fixtures', 'question.wav'));
  const pcm = new Int16Array(wav.buffer, wav.byteOffset + 44, (wav.length - 44) >> 1);
  const audio = Float32Array.from(pcm, (v) => v / 32768);
  const mb = () => Math.round(process.memoryUsage().rss / 1048576);
  let t = Date.now();
  const asr = await pipeline('automatic-speech-recognition', 'Xenova/whisper-base.en', { dtype: 'q8', device: 'cpu', ...OPTIONS[variant] });
  const loadMs = Date.now() - t;
  const afterLoad = mb();
  const runs = [];
  let text = '';
  let peak = afterLoad;
  for (let i = 0; i < 5; i++) {
    t = Date.now();
    text = (await asr(audio, { chunk_length_s: 30 })).text;
    runs.push(Date.now() - t);
    peak = Math.max(peak, mb());
  }
  console.log(JSON.stringify({ variant, loadMs, rssAfterLoadMB: afterLoad, rssPeakMB: peak, runsMs: runs, text: text.trim() }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
