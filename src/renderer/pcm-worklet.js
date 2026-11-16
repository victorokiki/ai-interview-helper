// Audio worklets.
//
// pcm-tap: taps raw PCM off a MediaStream in fixed frames (mono, at the
// AudioContext's sample rate). Frame size defaults to 100 ms; pass
// processorOptions.frameSamples to change it (Deepgram Flux wants 80 ms, echo
// cancellation 10 ms). Frames go to this.port, or to a MessagePort sent in as
// {port} (so they can flow straight to a Worker without touching the page).
//
// pcm-player: plays PCM frames it receives (on its port or a {port} sent in)
// as a live audio stream, with a small jitter buffer. Used to turn the echo
// canceller's output back into a MediaStream.
class PcmTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const size = options?.processorOptions?.frameSamples || Math.round(sampleRate / 10);
    this.frame = new Float32Array(size);
    this.filled = 0;
    this.out = this.port;
    this.port.onmessage = (e) => {
      if (e.data?.port) this.out = e.data.port;
    };
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    const length = channels[0].length;
    for (let i = 0; i < length; i++) {
      let sum = 0;
      for (const ch of channels) sum += ch[i];
      this.frame[this.filled++] = sum / channels.length;
      if (this.filled === this.frame.length) {
        const f = this.frame.slice();
        this.out.postMessage(f, [f.buffer]);
        this.filled = 0;
      }
    }
    return true;
  }
}

class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.buffered = 0;
    this.started = false;
    this.startAt = Math.round(sampleRate * 0.02); // 20 ms jitter buffer
    const onFrame = (e) => {
      if (e.data?.port) {
        e.data.port.onmessage = onFrame;
        return;
      }
      if (e.data instanceof Float32Array) {
        this.queue.push(e.data);
        this.buffered += e.data.length;
        // Never let latency build up: drop the oldest audio beyond 200 ms.
        while (this.buffered > sampleRate * 0.2 && this.queue.length > 1) {
          this.buffered -= this.queue.shift().length - this.offset;
          this.offset = 0;
        }
      }
    };
    this.port.onmessage = onFrame;
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!this.started) {
      if (this.buffered < this.startAt) {
        out.fill(0);
        return true;
      }
      this.started = true;
    }
    for (let i = 0; i < out.length; i++) {
      const head = this.queue[0];
      if (!head) {
        out.fill(0, i);
        this.started = false; // underrun: rebuild the jitter buffer
        break;
      }
      out[i] = head[this.offset++];
      this.buffered--;
      if (this.offset === head.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-tap', PcmTap);
registerProcessor('pcm-player', PcmPlayer);
