// End-to-end test of echo cancellation inside the real app: real WebRTC AEC3
// in the renderer's worker, fed in real time through the audio worklets, on a
// simulated speaker-to-mic echo path (interviewer clip → delays/gains → mic,
// then the candidate speaking). Checks that echo is removed, the candidate's
// voice is preserved, the off switch works, and the CPU cost.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, 'out', 'echo');
fs.rmSync(out, { recursive: true, force: true });
const userData = path.join(out, 'userdata');
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ provider: 'ollama', transcription: 'local', jobsMigrated: true, liveNoticeAck: true, meetingDetection: false }));
require(path.join(__dirname, '..', '..', 'src', 'main.js'));

const logs = [];
const metrics = {};
const check = (name, ok, extra = '') => {
  logs.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  fs.writeFileSync(path.join(out, 'log.txt'), logs.join(String.fromCharCode(10)));
};
const fixture = (id) => fs.readFileSync(path.join(__dirname, '..', 'bench', 'fixtures', 'echo', `${id}.wav`)).toString('base64');

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') logs.push(`[console error] ${e.message} (${e.sourceId}:${e.lineNumber})`);
  });
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    try {
      await new Promise((r) => setTimeout(r, 1000));
      check('echo canceller is available in the live window', await js(`typeof createEchoCanceller === 'function'`));
      const res = await js(`(async () => {
        const decode = (b64) => { const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const pcm = new Int16Array(bytes.buffer, 44, (bytes.length - 44) >> 1); return Float32Array.from(pcm, (v) => v / 32768); };
        const interviewer = decode('${fixture('interviewer1')}');
        const candidate = decode('${fixture('candidate1')}');
        const SR = 48000;
        const src = new AudioContext({ sampleRate: SR });
        const buf = (x) => { const b = src.createBuffer(1, x.length, SR); b.copyToChannel(x, 0); return b; };
        // Call audio stream (what the speakers play).
        const callSrc = src.createBufferSource(); callSrc.buffer = buf(interviewer);
        const callDest = src.createMediaStreamDestination(); callSrc.connect(callDest);
        // Mic = echo of the call (30 ms direct + 85 ms reflection) + candidate later.
        const micDest = src.createMediaStreamDestination();
        const d1 = src.createDelay(1); d1.delayTime.value = 0.03; const g1 = src.createGain(); g1.gain.value = 0.7;
        const d2 = src.createDelay(1); d2.delayTime.value = 0.085; const g2 = src.createGain(); g2.gain.value = -0.25;
        callSrc.connect(d1).connect(g1).connect(micDest); callSrc.connect(d2).connect(g2).connect(micDest);
        const candSrc = src.createBufferSource(); candSrc.buffer = buf(candidate); candSrc.connect(micDest);

        const aec = await createEchoCanceller(micDest.stream, callDest.stream);
        // Measure loudness of the raw mic and the cleaned stream every 50 ms.
        const meter = new AudioContext({ sampleRate: SR });
        const tap = (stream) => { const a = meter.createAnalyser(); a.fftSize = 2048; meter.createMediaStreamSource(stream).connect(a); return a; };
        const aMic = tap(micDest.stream); const aOut = tap(aec.stream);
        const rms = (a) => { const d = new Float32Array(a.fftSize); a.getFloatTimeDomainData(d); let s = 0; for (const v of d) s += v * v; return s / d.length; };
        const samples = [];
        const t0 = src.currentTime + 0.1;
        const iEnd = interviewer.length / SR;
        const cStart = iEnd + 0.6;
        callSrc.start(t0); candSrc.start(t0 + cStart);
        const total = cStart + candidate.length / SR + 0.3;
        const started = performance.now();
        await new Promise((resolve) => {
          const timer = setInterval(() => {
            const t = (performance.now() - started) / 1000;
            samples.push({ t, mic: rms(aMic), out: rms(aOut) });
            if (t > total) { clearInterval(timer); resolve(); }
          }, 50);
        });
        const avg = (from, to, k) => { const xs = samples.filter((s) => s.t >= from && s.t <= to).map((s) => s[k]); return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length); };
        const db = (x) => 10 * Math.log10(x);
        const echoWin = [2.5, iEnd - 0.2];
        const nearWin = [cStart + 0.8, cStart + candidate.length / SR - 0.5];
        const stats = await aec.stats();
        const tracks = aec.stream.getAudioTracks().length;
        aec.stop(); src.close(); meter.close();
        return {
          erleDb: +(db(avg(...echoWin, 'mic')) - db(avg(...echoWin, 'out'))).toFixed(1),
          nearEndChangeDb: +(db(avg(...nearWin, 'out')) - db(avg(...nearWin, 'mic'))).toFixed(1),
          stats, tracks,
        };
      })()`);
      metrics.realtime = res;
      check('cleaned mic is an ordinary audio stream', res.tracks === 1);
      check('echo removed in the live pipeline (≥ 15 dB)', res.erleDb >= 15, `${res.erleDb} dB`);
      check('candidate voice preserved (within 6 dB)', Math.abs(res.nearEndChangeDb) <= 6, `${res.nearEndChangeDb} dB`);
      check('worker processed render and capture frames', res.stats.frames > 500 && res.stats.renderFrames > 500, JSON.stringify(res.stats));
      check('CPU per 10 ms frame stays small (< 2 ms)', res.stats.usPerFrame != null && res.stats.usPerFrame < 2000, `${res.stats.usPerFrame} µs`);

      // Off switch and missing call audio: the raw mic is used as-is.
      const sw = await js(`(async () => {
        const ctx = new AudioContext(); const mic = ctx.createMediaStreamDestination().stream; const call = ctx.createMediaStreamDestination().stream;
        state.config = { ...state.config, echoCancellation: 'off' };
        const off = (await micForTranscription(mic, call)) === mic && !state.aec;
        state.config = { ...state.config, echoCancellation: 'on' };
        const noCall = (await micForTranscription(mic, null)) === mic && !state.aec;
        const on = await micForTranscription(mic, call);
        const result = { off, noCall, onIsCleaned: on !== mic && !!state.aec };
        state.aec.stop(); state.aec = null; ctx.close();
        return result;
      })()`);
      check('setting Off uses the raw microphone', sw.off);
      check('no call audio: raw microphone, no canceller', sw.noCall);
      check('setting On gives a cleaned stream', sw.onIsCleaned);
      check('echo cancellation setting exists and defaults to On', (await js(`window.api.getConfig()`)).echoCancellation === 'on' && (await js(`!!document.querySelector('#echoCancellation option[value="on"]')`)));
      check('license notices file is generated', fs.existsSync(path.join(__dirname, '..', '..', 'build', 'THIRD_PARTY_NOTICES.txt')) && (await js(`!!document.querySelector('#openLicenses')`)));
    } catch (err) {
      logs.push('[e2e-error] ' + err.stack);
    }
    fs.writeFileSync(path.join(out, 'log.txt'), logs.join(String.fromCharCode(10)));
    fs.writeFileSync(path.join(out, 'metrics.json'), JSON.stringify(metrics, null, 2));
    app.exit(0);
  });
});
