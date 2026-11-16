// Echo-cancellation benchmark: real WebRTC AEC3 (WASM) + real local Whisper,
// on a simulated speakers-to-microphone echo path. Answers "does AEC help
// transcription without hurting clean speech?" before it's enabled.
//
// Signals: Windows TTS voices (interviewer = David, candidate = Zira), 48 kHz.
// Echo path: direct sound after 30 ms plus 40 decaying reflections up to
// 200 ms, echo about as loud as the candidate (a hard laptop-speaker case),
// plus low background noise. Simulated room, real engines.
//
// Usage: MODEL_CACHE=<folder with Xenova/whisper-base.en> node tests/bench/echo.js
const fs = require('fs');
const path = require('path');
const WebRtcAec3 = require('@ennuicastr/webrtcaec3.js');

const SR = 48000;
const FRAME = 480; // 10 ms
const dir = path.join(__dirname, 'fixtures', 'echo');
const manifest = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8').replace(/^﻿/, '')).map((m) => [m.id, m]));

function readWav(id) {
  const buf = fs.readFileSync(path.join(dir, `${id}.wav`));
  const pcm = new Int16Array(buf.buffer, buf.byteOffset + 44, (buf.length - 44) >> 1);
  return Float32Array.from(pcm, (v) => v / 32768);
}

// Deterministic pseudo-random numbers so every run uses the same room.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}

function makeRoom(seed = 7) {
  const r = rng(seed);
  const taps = [[Math.round(0.03 * SR), 0.7]];
  for (let i = 0; i < 40; i++) {
    const t = 0.032 + Math.abs(r()) * 0.17;
    taps.push([Math.round(t * SR), 0.35 * r() * Math.exp(-(t - 0.03) / 0.06)]);
  }
  return taps;
}

function echoOf(render, taps) {
  const out = new Float32Array(render.length);
  for (const [d, g] of taps) for (let i = d; i < render.length; i++) out[i] += render[i - d] * g;
  return out;
}

function place(len, clip, atSec) {
  const out = new Float32Array(len);
  out.set(clip.subarray(0, Math.max(0, Math.min(clip.length, len - Math.round(atSec * SR)))), Math.round(atSec * SR));
  return out;
}

function add(...xs) {
  const out = new Float32Array(xs[0].length);
  for (const x of xs) for (let i = 0; i < out.length; i++) out[i] += x[i];
  return out;
}

function noise(len, level, seed = 3) {
  const r = rng(seed);
  return Float32Array.from({ length: len }, () => r() * level);
}

const energy = (x, from = 0, to = x.length) => {
  let e = 0;
  for (let i = from; i < to; i++) e += x[i] * x[i];
  return e / Math.max(1, to - from);
};

async function cancel(AEC, render, mic) {
  const aec = new AEC.AEC3(SR, 1, 1);
  const out = new Float32Array(mic.length);
  let pos = 0;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i + FRAME <= mic.length; i += FRAME) {
    aec.analyze([render.subarray(i, i + FRAME)]);
    const inp = [mic.subarray(i, i + FRAME)];
    const n = aec.processSize(inp);
    const buf = [new Float32Array(n)];
    aec.process(buf, inp);
    out.set(buf[0].subarray(0, Math.min(n, out.length - pos)), pos);
    pos += n;
  }
  const usPerFrame = Number(process.hrtime.bigint() - t0) / 1000 / Math.floor(mic.length / FRAME);
  aec.free();
  return { out, usPerFrame };
}

function to16k(x) {
  const out = new Float32Array(Math.floor(x.length / 3));
  for (let i = 0; i < out.length; i++) out[i] = (x[3 * i] + x[3 * i + 1] + x[3 * i + 2]) / 3;
  return out;
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
function wer(ref, hyp) {
  const r = norm(ref);
  const h = norm(hyp);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return d[r.length][h.length] / r.length;
}
// Interviewer-only words that show up in the candidate's transcript.
function leaked(interviewerText, candidateText, hyp) {
  const own = new Set(norm(candidateText));
  const theirs = new Set(norm(interviewerText).filter((w) => !own.has(w) && w.length > 3));
  return norm(hyp).filter((w) => theirs.has(w)).length;
}

(async () => {
  const AEC = await WebRtcAec3();
  const { pipeline, env } = require('@huggingface/transformers');
  if (!process.env.MODEL_CACHE) throw new Error('Set MODEL_CACHE to a folder containing Xenova/whisper-base.en');
  env.cacheDir = process.env.MODEL_CACHE;
  env.localModelPath = process.env.MODEL_CACHE;
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  const asr = await pipeline('automatic-speech-recognition', 'Xenova/whisper-base.en', {
    dtype: 'q8',
    device: 'cpu',
    session_options: { enableCpuMemArena: false, intraOpNumThreads: 4, interOpNumThreads: 1 },
  });
  const transcribe = async (x) => (await asr(to16k(x), { chunk_length_s: 30 })).text.trim();

  const room = makeRoom();
  const I1 = readWav('interviewer1');
  const I2 = readWav('interviewer2');
  const C1 = readWav('candidate1');
  const C2 = readWav('candidate2');
  const C3 = readWav('candidate3');
  const report = { at: new Date().toISOString(), note: 'Simulated speaker-to-mic echo path (direct 30 ms + 40 reflections to 200 ms, echo ≈ as loud as the candidate) with real WebRTC AEC3 and real Whisper base.en. Synthetic TTS voices.', scenarios: {} };
  const cpu = [];

  // A. Echo only: how much echo is removed (ERLE, dB) once AEC has converged.
  {
    const len = I2.length + SR;
    const render = place(len, I2, 0);
    const mic = add(echoOf(render, room), noise(len, 0.002));
    const { out, usPerFrame } = await cancel(AEC, render, mic);
    cpu.push(usPerFrame);
    const from = 2 * SR; // after 2 s of convergence
    const to = I2.length;
    report.scenarios.echoOnly = {
      erleDb: +(10 * Math.log10(energy(mic, from, to) / energy(out, from, to))).toFixed(1),
      rawTranscript: await transcribe(mic),
      aecTranscript: await transcribe(out),
    };
  }

  // B. Taking turns: interviewer asks, then the candidate answers.
  {
    const start = I1.length / SR + 0.4;
    const len = Math.round((start + C1.length / SR + 0.5) * SR);
    const render = place(len, I1, 0);
    const mic = add(echoOf(render, room), place(len, C1, start), noise(len, 0.002));
    const { out, usPerFrame } = await cancel(AEC, render, mic);
    cpu.push(usPerFrame);
    const raw = await transcribe(mic);
    const clean = await transcribe(out);
    report.scenarios.turnTaking = {
      rawWer: +wer(manifest.candidate1.text, raw).toFixed(3),
      aecWer: +wer(manifest.candidate1.text, clean).toFixed(3),
      rawLeakedWords: leaked(manifest.interviewer1.text, manifest.candidate1.text, raw),
      aecLeakedWords: leaked(manifest.interviewer1.text, manifest.candidate1.text, clean),
      raw,
      aec: clean,
    };
  }

  // C. Double talk: the candidate starts while the interviewer is still talking.
  {
    const len = Math.round((1 + C2.length / SR + 0.5) * SR);
    const render = place(len, I2, 0);
    const mic = add(echoOf(render, room), place(len, C2, 1.0), noise(len, 0.002));
    const { out, usPerFrame } = await cancel(AEC, render, mic);
    cpu.push(usPerFrame);
    const raw = await transcribe(mic);
    const clean = await transcribe(out);
    report.scenarios.doubleTalk = {
      rawWer: +wer(manifest.candidate2.text, raw).toFixed(3),
      aecWer: +wer(manifest.candidate2.text, clean).toFixed(3),
      rawLeakedWords: leaked(manifest.interviewer2.text, manifest.candidate2.text, raw),
      aecLeakedWords: leaked(manifest.interviewer2.text, manifest.candidate2.text, clean),
      raw,
      aec: clean,
    };
  }

  // D. No echo (headphones): AEC must not hurt clean speech.
  {
    const len = C3.length + SR;
    const render = new Float32Array(len);
    const mic = add(place(len, C3, 0.2), noise(len, 0.002));
    const { out, usPerFrame } = await cancel(AEC, render, mic);
    cpu.push(usPerFrame);
    const raw = await transcribe(mic);
    const clean = await transcribe(out);
    report.scenarios.noEcho = {
      rawWer: +wer(manifest.candidate3.text, raw).toFixed(3),
      aecWer: +wer(manifest.candidate3.text, clean).toFixed(3),
      levelChangeDb: +(10 * Math.log10(energy(out) / energy(mic))).toFixed(1),
      raw,
      aec: clean,
    };
  }

  report.cpu = { usPer10msFrame: +(cpu.reduce((a, b) => a + b, 0) / cpu.length).toFixed(1), shareOfOneCorePct: +((cpu.reduce((a, b) => a + b, 0) / cpu.length / 10000) * 100).toFixed(2) };
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'out', 'echo.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
