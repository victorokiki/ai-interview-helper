// Echo cancellation for setups without headphones: returns a cleaned copy of
// the microphone with the call audio (which the speakers play and the mic
// picks up) removed, as an ordinary MediaStream, so every transcriber and the
// recorder can use it unchanged.
//
//   call stream ─▶ pcm-tap (10 ms) ─┐
//                                   ├─▶ aec-worker (WebRTC AEC3) ─▶ pcm-player ─▶ cleaned mic stream
//   mic stream  ─▶ pcm-tap (10 ms) ─┘
//
// Frames travel worklet → worker → worklet over MessagePorts, never through
// the page's main thread. Measured in tests/bench/echo.js: ~32 dB of echo
// removed, no change to clean speech.
async function createEchoCanceller(micStream, callStream) {
  const ctx = new AudioContext({ sampleRate: 48000 }); // AEC3 runs at 48 kHz
  await ctx.audioWorklet.addModule('pcm-worklet.js');
  const wasm = await window.api.aecWasm();
  const worker = new Worker('aec-worker.js');

  const tapCall = new AudioWorkletNode(ctx, 'pcm-tap', { processorOptions: { frameSamples: 480 } });
  const tapMic = new AudioWorkletNode(ctx, 'pcm-tap', { processorOptions: { frameSamples: 480 } });
  const player = new AudioWorkletNode(ctx, 'pcm-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
  const dest = ctx.createMediaStreamDestination();
  player.connect(dest);
  ctx.createMediaStreamSource(callStream).connect(tapCall);
  ctx.createMediaStreamSource(micStream).connect(tapMic);
  // Worklets only run while connected to the output; keep them silent.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  tapCall.connect(mute);
  tapMic.connect(mute);
  mute.connect(ctx.destination);

  const render = new MessageChannel();
  const capture = new MessageChannel();
  const out = new MessageChannel();
  tapCall.port.postMessage({ port: render.port1 }, [render.port1]);
  tapMic.port.postMessage({ port: capture.port1 }, [capture.port1]);
  player.port.postMessage({ port: out.port1 }, [out.port1]);

  const ready = new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.type === 'ready') resolve();
      if (data.type === 'error') reject(new Error(data.error));
    };
    worker.onerror = (e) => reject(new Error(e.message || 'Echo cancellation worker failed.'));
  });
  worker.postMessage({ type: 'init', wasm, render: render.port2, capture: capture.port2, out: out.port2 }, [render.port2, capture.port2, out.port2]);
  try {
    await ready;
  } catch (err) {
    worker.terminate();
    ctx.close();
    throw err;
  }

  return {
    stream: dest.stream,
    // CPU cost and frame counts, saved with the session.
    stats() {
      return new Promise((resolve) => {
        const prev = worker.onmessage;
        worker.onmessage = ({ data }) => {
          if (data.type !== 'stats') return;
          worker.onmessage = prev;
          resolve(data);
        };
        worker.postMessage({ type: 'stats' });
      });
    },
    stop() {
      worker.terminate();
      try {
        ctx.close();
      } catch {}
    },
  };
}

window.createEchoCanceller = createEchoCanceller;
