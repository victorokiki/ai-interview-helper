// Meeting-app compatibility check on this PC (run by hand on Windows):
//
//   npx electron tests/manual/meeting-compat.js "<path to chrome.exe>"
//
// Uses a real Chromium tab, the way Google Meet, Teams on the web and Zoom on
// the web run:
//   1. the tab opens the real microphone → meeting detection (src/meeting.js,
//      Windows consent store) must report a browser call starting, then ending;
//   2. the tab plays a quiet 440 Hz tone for 3 s → the app's system-audio
//      capture (getDisplayMedia with loopback audio, as in src/main.js) must
//      hear it.
// Desktop Zoom and Teams use the same two OS paths (microphone consent store,
// system audio output) but need signed-in accounts, so they are checked by hand.
const { app, BrowserWindow, session, desktopCapturer } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const meeting = require('../../src/meeting');

const chromePath = process.argv.find((a) => /chrome\.exe$/i.test(a));
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const pageStatus = [];
const PAGE = `<!doctype html><title>Call</title><p id="s">starting</p><script>
  new MutationObserver(() => fetch('/status?' + encodeURIComponent(document.getElementById('s').textContent))).observe(document.getElementById('s'), { childList: true, characterData: true, subtree: true });
  const params = new URLSearchParams(location.search);
  if (params.get('mode') === 'mic') {
    navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => { window.stream = s; document.getElementById('s').textContent = 'mic on: ' + s.getAudioTracks()[0].label; }).catch((e) => (document.getElementById('s').textContent = 'mic error: ' + e.name));
  } else {
    const ctx = new AudioContext(); const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = 440; g.gain.value = 0.06; o.connect(g).connect(ctx.destination); o.start(); setTimeout(() => o.stop(), 3000);
    document.getElementById('s').textContent = 'tone';
  }
</script>`;

app.whenReady().then(async () => {
  if (process.platform !== 'win32' || !chromePath || !fs.existsSync(chromePath)) {
    console.log('Usage on Windows: npx electron tests/manual/meeting-compat.js "<chrome.exe>"');
    return app.exit(2);
  }
  const server = http
    .createServer((req, res) => {
      if (req.url.startsWith('/status?')) pageStatus.push(decodeURIComponent(req.url.slice(8)));
      res.end(req.url.startsWith('/blank') ? '<title>capture</title>' : PAGE);
    })
    .listen(0);
  await new Promise((r) => server.once('listening', r));
  const url = (mode) => `http://127.0.0.1:${server.address().port}/?mode=${mode}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ih-meet-'));
  const ownExe = path.basename(process.execPath);
  const launch = (mode) => spawn(chromePath, [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', `--app=${url(mode)}`], { stdio: 'ignore' });

  try {
    // 1. Microphone use by a browser call is detected, then its end.
    const before = await meeting.queryActive(ownExe);
    const chrome = launch('mic');
    let active = [];
    const isChrome = (a) => a.app === 'Chrome';
    for (let i = 0; i < 30 && !active.some(isChrome); i++) {
      await wait(500);
      active = await meeting.queryActive(ownExe);
    }
    const hit = active.find(isChrome);
    check('a browser tab using the microphone is detected as a call app', Boolean(hit), hit ? `${hit.app}, via ${hit.id.startsWith('session:') ? 'audio sessions' : 'the registry'}` : `nothing detected; the tab said: ${pageStatus.join(' | ') || '(nothing)'}`);
    chrome.kill();
    let gone = false;
    for (let i = 0; i < 20 && !gone; i++) {
      await wait(500);
      gone = !(await meeting.queryActive(ownExe)).some(isChrome);
    }
    meeting.stopProbe();
    check('when the tab closes, the call is no longer reported', gone);

    // 2. System audio (loopback) capture hears another app's sound.
    session.defaultSession.setDisplayMediaRequestHandler(async (_r, cb) => {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      cb({ video: sources[0], audio: 'loopback' });
    });
    const w = new BrowserWindow({ show: false });
    await w.loadURL(`http://127.0.0.1:${server.address().port}/blank`); // a secure context (localhost)
    await w.webContents.executeJavaScript(`(async () => {
      const s = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      s.getVideoTracks().forEach((t) => t.stop());
      const ctx = new AudioContext(); const an = ctx.createAnalyser(); an.fftSize = 8192;
      ctx.createMediaStreamSource(s).connect(an);
      window.peak = { db: -200, hz: 0 };
      const buf = new Float32Array(an.frequencyBinCount);
      setInterval(() => { an.getFloatFrequencyData(buf); let m = -Infinity, k = 0; for (let i = 5; i < buf.length; i++) if (buf[i] > m) { m = buf[i]; k = i; } if (m > window.peak.db) window.peak = { db: Math.round(m), hz: Math.round(k * ctx.sampleRate / an.fftSize) }; }, 50);
      return true;
    })()`);
    await wait(500);
    const tone = launch('tone');
    await wait(4500);
    tone.kill();
    const peak = await w.webContents.executeJavaScript('window.peak');
    check('loopback capture hears audio played by the browser tab (440 Hz tone)', Math.abs(peak.hz - 440) <= 12 && peak.db > -90, `loudest ${peak.hz} Hz at ${peak.db} dB`);
    w.destroy();
  } catch (err) {
    check('run', false, err.stack);
  }
  server.close();
  await wait(500);
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  console.log(results.every(Boolean) ? 'ALL PASSED' : 'SOME FAILED');
  app.exit(results.every(Boolean) ? 0 : 1);
});
