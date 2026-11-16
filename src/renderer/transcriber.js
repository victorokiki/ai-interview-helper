// Speech-to-text engines. One instance per speaker: the system audio
// (interviewer, "them") and the microphone ("me").
//
// Every engine reports through the same callbacks:
//   onInterim(text)            live, not-yet-final text ('' clears it)
//   onUtterance({speaker, text, t, startedAt, dur})   one finished utterance
//   onTurn(event, text)        early turn signals for speculative answers:
//                              'eager'   probably finished (start a draft)
//                              'resumed' kept talking (drop the draft)
//   onStatus(text), onError(err)

const noop = () => {};

function baseCallbacks(self, o) {
  self.speaker = o.speaker;
  self.onInterim = o.onInterim || noop;
  self.onUtterance = o.onUtterance || noop;
  self.onTurn = o.onTurn || noop;
  self.onStatus = o.onStatus || noop;
  self.onError = o.onError || ((err) => console.error(err));
}

// Tell the app when the capture device disappears (unplugged, driver reset).
function watchTracks(self, stream) {
  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', () => {
      if (!self.stopped) self.onStatus('device lost');
    });
  }
}

// ---------- Deepgram Nova-3 (live words) ----------

const RECONNECT_DELAYS = [300, 1000, 3000];

class Transcriber {
  constructor({ apiKey, language = 'en', ...o }) {
    baseCallbacks(this, o);
    this.apiKey = apiKey;
    this.language = language;
    this.finalParts = [];
    this.speechSeconds = 0; // speaking time in the utterance being built
    this.turnStartedAt = 0;
    this.eagerText = null;
    this.stream = null;
    this.recorder = null;
    this.socket = null;
    this.keepAlive = null;
    this.stopped = false;
    this.attempt = 0;
  }

  static async captureSystemAudio() {
    // main.js answers this with the primary screen + loopback audio.
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    stream.getVideoTracks().forEach((t) => t.stop());
    if (!stream.getAudioTracks().length) {
      throw new Error('No system audio track. Loopback capture may be unsupported on this OS.');
    }
    return new MediaStream(stream.getAudioTracks());
  }

  static async captureMicrophone() {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  }

  url() {
    const params = new URLSearchParams({
      model: 'nova-3',
      language: this.language,
      smart_format: 'true',
      punctuate: 'true',
      interim_results: 'true',
      endpointing: '400',
      utterance_end_ms: '1200',
      vad_events: 'true',
    });
    // Keep "um"/"uh" in the candidate's own transcript so the speech coach can count them.
    if (this.speaker === 'me') params.set('filler_words', 'true');
    return `wss://api.deepgram.com/v1/listen?${params}`;
  }

  async start(mediaStream) {
    this.stream = mediaStream;
    watchTracks(this, mediaStream);
    await this.connect();
    this.onStatus('listening');
  }

  async connect() {
    const socket = new WebSocket(this.url(), ['token', this.apiKey]);
    this.socket = socket;
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error('Could not connect to Deepgram. Check your Deepgram API key.'));
    });
    this.attempt = 0;
    socket.onmessage = (event) => this.handleMessage(JSON.parse(event.data));
    socket.onclose = (event) => this.onSocketClose(event);

    // A new socket needs a new WebM stream (with its own header).
    this.recorder = new MediaRecorder(this.stream, { mimeType: 'audio/webm;codecs=opus' });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0 && socket.readyState === WebSocket.OPEN) socket.send(e.data);
    };
    this.recorder.start(250);

    // Deepgram closes idle sockets after ~10s without audio data.
    clearInterval(this.keepAlive);
    this.keepAlive = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'KeepAlive' }));
    }, 8000);
  }

  // Unexpected close (network blip, server restart): reconnect a few times.
  async onSocketClose(event) {
    clearInterval(this.keepAlive);
    try {
      if (this.recorder?.state !== 'inactive') this.recorder?.stop();
    } catch {}
    if (this.stopped) return;
    this.flush();
    if (this.attempt >= RECONNECT_DELAYS.length) {
      this.onStatus(`disconnected (${event.code}${event.reason ? `: ${event.reason}` : ''})`);
      return;
    }
    this.onStatus('reconnecting');
    await new Promise((r) => setTimeout(r, RECONNECT_DELAYS[this.attempt++]));
    if (this.stopped) return;
    try {
      await this.connect();
      this.onStatus('listening');
    } catch {
      this.onSocketClose({ code: 1006, reason: 'reconnect failed' });
    }
  }

  handleMessage(msg) {
    if (msg.type === 'UtteranceEnd') {
      this.flush();
      return;
    }
    if (msg.type !== 'Results') return;
    const alt = msg.channel?.alternatives?.[0];
    const text = alt?.transcript || '';
    if (text && !this.turnStartedAt) this.turnStartedAt = Date.now();
    if (msg.is_final) {
      if (text) this.finalParts.push(text);
      const words = alt?.words;
      if (words?.length) this.speechSeconds += Math.max(0, words[words.length - 1].end - words[0].start);
      const joined = this.finalParts.join(' ');
      this.onInterim(joined);
      if (msg.speech_final) {
        this.flush();
      } else if (!this.eagerText && /\?\s*$/.test(joined)) {
        // A finalized segment ending in "?" usually means the question is done;
        // start drafting before the endpointing silence completes.
        this.eagerText = joined;
        this.onTurn('eager', joined);
      }
    } else {
      if (this.eagerText && text.trim()) {
        this.eagerText = null;
        this.onTurn('resumed', '');
      }
      this.onInterim([...this.finalParts, text].filter(Boolean).join(' '));
    }
  }

  flush() {
    const text = this.finalParts.join(' ').trim();
    const dur = this.speechSeconds;
    const startedAt = this.turnStartedAt || Date.now();
    this.finalParts = [];
    this.speechSeconds = 0;
    this.turnStartedAt = 0;
    this.eagerText = null;
    this.onInterim('');
    if (text) this.onUtterance({ speaker: this.speaker, text, t: Date.now(), startedAt, dur });
  }

  stop() {
    this.stopped = true;
    clearInterval(this.keepAlive);
    try {
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    } catch {}
    try {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'CloseStream' }));
      this.socket?.close();
    } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
    this.flush();
    this.onStatus('stopped');
  }
}

// ---------- Deepgram Flux (turn detection, for the interviewer) ----------
// wss://api.deepgram.com/v2/listen with raw 16 kHz linear16 audio in 80 ms
// chunks. TurnInfo events: Update, StartOfTurn, EagerEndOfTurn, TurnResumed,
// EndOfTurn (https://developers.deepgram.com/docs/flux/quickstart).

class FluxTranscriber {
  constructor({ apiKey, language = 'en', ...o }) {
    baseCallbacks(this, o);
    this.apiKey = apiKey;
    this.language = language;
    this.stream = null;
    this.ctx = null;
    this.node = null;
    this.socket = null;
    this.stopped = false;
    this.attempt = 0;
    this.turnStartedAt = 0;
  }

  url() {
    const multi = this.language && this.language !== 'en';
    const params = new URLSearchParams({
      model: multi ? 'flux-general-multi' : 'flux-general-en',
      encoding: 'linear16',
      sample_rate: '16000',
      eot_threshold: '0.75',
      // Eager mode: EagerEndOfTurn lets us start a draft answer early.
      eager_eot_threshold: '0.5',
      eot_timeout_ms: '3000',
    });
    if (multi && this.language !== 'multi') params.append('language_hint', this.language);
    return `wss://api.deepgram.com/v2/listen?${params}`;
  }

  async start(mediaStream) {
    this.stream = mediaStream;
    watchTracks(this, mediaStream);
    // The audio graph resamples to 16 kHz for us.
    this.ctx = new AudioContext({ sampleRate: 16000 });
    await this.ctx.audioWorklet.addModule('pcm-worklet.js');
    const source = this.ctx.createMediaStreamSource(mediaStream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-tap', { processorOptions: { frameSamples: 1280 } });
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    source.connect(this.node).connect(mute).connect(this.ctx.destination);
    this.node.port.onmessage = (e) => this.sendFrame(e.data);
    await this.connect();
    this.onStatus('listening');
  }

  sendFrame(f32) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const pcm = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) pcm[i] = Math.max(-1, Math.min(1, f32[i])) * 0x7fff;
    this.socket.send(pcm.buffer);
  }

  async connect() {
    const socket = new WebSocket(this.url(), ['token', this.apiKey]);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error('Could not connect to Deepgram Flux. Check your Deepgram API key.'));
    });
    this.attempt = 0;
    socket.onmessage = (event) => this.handleMessage(JSON.parse(event.data));
    socket.onclose = (event) => this.onSocketClose(event);
  }

  async onSocketClose(event) {
    if (this.stopped) return;
    if (this.attempt >= RECONNECT_DELAYS.length) {
      this.onStatus(`disconnected (${event.code}${event.reason ? `: ${event.reason}` : ''})`);
      return;
    }
    this.onStatus('reconnecting');
    await new Promise((r) => setTimeout(r, RECONNECT_DELAYS[this.attempt++]));
    if (this.stopped) return;
    try {
      await this.connect();
      this.onStatus('listening');
    } catch {
      this.onSocketClose({ code: 1006, reason: 'reconnect failed' });
    }
  }

  handleMessage(msg) {
    if (msg.type === 'Error') {
      this.onError(new Error(`Deepgram Flux: ${msg.description || msg.code}`));
      return;
    }
    if (msg.type !== 'TurnInfo') return;
    const text = (msg.transcript || '').trim();
    switch (msg.event) {
      case 'StartOfTurn':
        this.turnStartedAt = Date.now();
        break;
      case 'Update':
        if (text && !this.turnStartedAt) this.turnStartedAt = Date.now();
        this.onInterim(text);
        break;
      case 'EagerEndOfTurn':
        this.onInterim(text);
        if (text) this.onTurn('eager', text);
        break;
      case 'TurnResumed':
        this.onTurn('resumed', '');
        break;
      case 'EndOfTurn': {
        this.onInterim('');
        const words = msg.words || [];
        const dur = words.length ? Math.max(0, words[words.length - 1].end - words[0].start) : 0;
        const startedAt = this.turnStartedAt || Date.now();
        this.turnStartedAt = 0;
        if (text) this.onUtterance({ speaker: this.speaker, text, t: Date.now(), startedAt, dur });
        break;
      }
      default:
        break;
    }
  }

  stop() {
    this.stopped = true;
    try {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'CloseStream' }));
      this.socket?.close();
    } catch {}
    try {
      this.node?.disconnect();
      this.ctx?.close();
    } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
    this.onInterim('');
    this.onStatus('stopped');
  }
}

// ---------- Local Whisper (offline) ----------
// Splits the stream into utterances with an energy-based voice detector and
// sends each one to the local Whisper model in the main process.
// Early turn signal: after 300 ms of quiet the segment is transcribed right
// away ('eager'). If the speaker stays quiet until the segment ends (700 ms),
// that same text is the final transcript, so the question is transcribed once
// and early instead of after the full silence.
const FRAME_MS = 100;
const EAGER_SILENCE_FRAMES = 3; // 0.3 s of quiet: probably done
const END_SILENCE_FRAMES = 7; // 0.7 s of quiet ends an utterance
const MAX_SEGMENT_FRAMES = 200; // cut long monologues every 20 s
const MIN_SPEECH_FRAMES = 3;
const PREROLL_FRAMES = 3;

function concatFrames(frames) {
  const audio = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
  let offset = 0;
  for (const f of frames) {
    audio.set(f, offset);
    offset += f.length;
  }
  return audio;
}

class LocalTranscriber {
  constructor(o) {
    baseCallbacks(this, o);
    this.stream = null;
    this.ctx = null;
    this.node = null;
    this.noise = 0.004;
    this.preroll = [];
    this.segment = null;
    this.chain = Promise.resolve();
    this.queued = 0;
    this.stopped = false;
  }

  async start(mediaStream) {
    this.stream = mediaStream;
    watchTracks(this, mediaStream);
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule('pcm-worklet.js');
    const source = this.ctx.createMediaStreamSource(mediaStream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-tap');
    // The worklet only runs while connected to the output; keep it silent.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    source.connect(this.node).connect(mute).connect(this.ctx.destination);
    this.ratio = this.ctx.sampleRate / 16000;
    this.node.port.onmessage = (e) => this.onFrame(this.downsample(e.data));
    this.onStatus('listening');
  }

  // Box-filter decimation to the 16 kHz Whisper expects.
  downsample(input) {
    if (this.ratio === 1) return input;
    const out = new Float32Array(Math.floor(input.length / this.ratio));
    for (let i = 0; i < out.length; i++) {
      const from = Math.floor(i * this.ratio);
      const to = Math.min(input.length, Math.floor((i + 1) * this.ratio));
      let sum = 0;
      for (let j = from; j < to; j++) sum += input[j];
      out[i] = sum / Math.max(1, to - from);
    }
    return out;
  }

  onFrame(pcm) {
    let energy = 0;
    for (let i = 0; i < pcm.length; i++) energy += pcm[i] * pcm[i];
    const rms = Math.sqrt(energy / pcm.length);
    const threshold = Math.max(0.012, this.noise * 3);
    const loud = rms > threshold;

    if (!this.segment) {
      this.noise = Math.min(0.05, this.noise * 0.95 + rms * 0.05);
      this.preroll.push(pcm);
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
      if (loud) {
        this.segment = { frames: [...this.preroll], speech: 1, silence: 0, t: Date.now() - PREROLL_FRAMES * FRAME_MS, eager: null };
        this.preroll = [];
      }
      return;
    }
    const seg = this.segment;
    seg.frames.push(pcm);
    if (loud) {
      seg.speech++;
      seg.silence = 0;
      if (seg.eager) {
        seg.eager = null; // the speaker carried on; that early text is stale
        this.onTurn('resumed', '');
      }
    } else {
      seg.silence++;
      if (seg.silence === EAGER_SILENCE_FRAMES && seg.speech >= MIN_SPEECH_FRAMES && !seg.eager) this.eagerTranscribe(seg);
    }
    if (seg.silence >= END_SILENCE_FRAMES || seg.frames.length >= MAX_SEGMENT_FRAMES) this.endSegment();
  }

  enqueue(audio) {
    const job = this.chain.then(() => window.api.transcribeLocal(audio));
    this.chain = job.catch(() => {});
    return job;
  }

  eagerTranscribe(seg) {
    const eager = { speech: seg.speech, promise: null };
    seg.eager = eager;
    this.queued++;
    eager.promise = this.enqueue(concatFrames(seg.frames)).finally(() => this.queued--);
    eager.promise
      .then((text) => {
        // Only signal if nothing new was said since (still the same eager).
        if (text && seg.eager === eager && seg.speech === eager.speech) this.onTurn('eager', text);
      })
      .catch(() => {});
  }

  endSegment() {
    const seg = this.segment;
    this.segment = null;
    if (!seg || seg.speech < MIN_SPEECH_FRAMES) return;
    // Speaking time: the segment minus pre-roll and the trailing silence.
    const dur = (Math.max(0, seg.frames.length - seg.silence - PREROLL_FRAMES) * FRAME_MS) / 1000;
    const reuse = seg.eager && seg.eager.speech === seg.speech; // only silence since the early transcript
    this.queued++;
    this.onInterim('…');
    const textPromise = reuse ? seg.eager.promise : this.enqueue(concatFrames(seg.frames));
    // Chained so utterances from this speaker arrive in order.
    const deliver = this.delivered || Promise.resolve();
    this.delivered = deliver
      .then(() => textPromise)
      .then((text) => {
        if (text) this.onUtterance({ speaker: this.speaker, text, t: seg.t, startedAt: seg.t, dur });
      })
      .catch((err) => this.onError(err))
      .finally(() => {
        if (--this.queued === 0) this.onInterim('');
      });
  }

  // True while speech is being captured or transcribed.
  get busy() {
    return Boolean(this.segment) || this.queued > 0;
  }

  stop() {
    this.stopped = true;
    this.endSegment();
    try {
      this.node?.disconnect();
      this.ctx?.close();
    } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
    this.onStatus('stopped');
  }
}

// Picks the engine chosen in Settings. Flux is used for the interviewer
// (turn detection); the candidate's mic stays on Nova-3, which keeps filler
// words for the speech coach.
function createTranscriber(config, options) {
  if (config.transcription === 'local') return new LocalTranscriber(options);
  if (config.transcription === 'deepgram-flux' && options.speaker === 'them') {
    return new FluxTranscriber({ apiKey: config.deepgramKey, language: config.language, ...options });
  }
  return new Transcriber({ apiKey: config.deepgramKey, language: config.language, ...options });
}

window.Transcriber = Transcriber;
window.FluxTranscriber = FluxTranscriber;
window.createTranscriber = createTranscriber;
