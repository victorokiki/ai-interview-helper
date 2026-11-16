// Acoustic echo cancellation worker: WebRTC AEC3 (BSD-3-Clause) compiled to
// WebAssembly, by @ennuicastr/webrtcaec3.js. Receives 10 ms frames of the
// call audio ("render", what the speakers play) and the microphone
// ("capture") on two MessagePorts straight from audio worklets, removes the
// call audio from the mic, and sends cleaned frames to a playback worklet.
// Runs off the UI thread (CPU per 10 ms frame: see tests/e2e/echo.js metrics).
importScripts('../../node_modules/@ennuicastr/webrtcaec3.js/dist/webrtcaec3-0.3.0.js');

const SAMPLE_RATE = 48000;
let aec = null;
let frames = 0;
let busyUs = 0;
let renderFrames = 0;
let analyzeUs = 0;

// Near-silent audio from the Web Audio graph contains denormal floats, which
// WebAssembly processes ~10x slower (measured: 3.5 ms vs 0.35 ms per frame).
// Inaudible dither (about -180 dBFS) keeps every value, including AEC3's
// internal filter states, out of the denormal range.
let seed = 22222;
function dither(frame) {
  for (let i = 0; i < frame.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    frame[i] += (seed / 4294967296 - 0.5) * 1e-9;
  }
  return frame;
}

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      // The WASM bytes come from the main process, so no file fetch is needed.
      const AEC3 = await self.WebRtcAec3({ wasmBinary: data.wasm });
      aec = new AEC3.AEC3(SAMPLE_RATE, 1, 1);
    } catch (err) {
      self.postMessage({ type: 'error', error: `Echo cancellation failed to start: ${err.message || err}` });
      return;
    }
    data.render.onmessage = (e) => {
      const t = performance.now();
      aec.analyze([dither(e.data)]);
      analyzeUs += (performance.now() - t) * 1000;
      renderFrames++;
    };
    data.capture.onmessage = (e) => {
      const t = performance.now();
      const input = [dither(e.data)];
      const n = aec.processSize(input);
      const out = new Float32Array(n);
      aec.process([out], input);
      busyUs += (performance.now() - t) * 1000;
      frames++;
      if (n) data.out.postMessage(out, [out.buffer]);
    };
    self.postMessage({ type: 'ready' });
  } else if (data.type === 'stats') {
    self.postMessage({
      type: 'stats',
      frames,
      renderFrames,
      usPerFrame: frames ? Math.round((busyUs + analyzeUs) / frames) : null,
      processUs: frames ? Math.round(busyUs / frames) : null,
      analyzeUs: renderFrames ? Math.round(analyzeUs / renderFrames) : null,
    });
  }
};
