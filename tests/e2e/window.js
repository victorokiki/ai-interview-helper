// End-to-end test of the floating window on the real OS: opacity (live
// preview and saved), always on top, compact view and back, remembered
// position, global shortcuts pressed through Windows (SendKeys), changing a
// shortcut, a shortcut held by another process, the screen-sharing status
// and preview (real capture), full-speed timers while hidden, an answer that
// keeps streaming while the window is toggled, and CPU / memory use.
const { app, BrowserWindow, globalShortcut } = require('electron');
const { execFile } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, 'out', 'window');
fs.rmSync(out, { recursive: true, force: true });
const userData = path.join(out, 'userdata');
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);

// A slow streamed answer: 30 chunks, 70 ms apart.
const CHUNKS = Array.from({ length: 30 }, (_, i) => `part${i} `);
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const json = JSON.parse(body || '{}');
    if (!json.messages?.length) return res.end('{"done":true}');
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    for (const c of CHUNKS) {
      res.write(JSON.stringify({ message: { content: c }, done: false }) + '\n');
      await new Promise((r) => setTimeout(r, 70));
    }
    res.end(JSON.stringify({ done: true }) + '\n');
  });
});

const sendKeys = (keys) =>
  new Promise((resolve) => execFile('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys}')`], { windowsHide: true }, () => resolve()));

server.listen(0, () => {
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ provider: 'ollama', ollamaUrl: `http://127.0.0.1:${server.address().port}`, ollamaModel: 'fake', transcription: 'local', jobsMigrated: true, liveNoticeAck: true, meetingDetection: false, autoAnswer: false }));
  require(path.join(__dirname, '..', '..', 'src', 'main.js'));
});

const logs = [];
const check = (name, ok, extra = '') => {
  logs.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  fs.writeFileSync(path.join(out, 'log.txt'), logs.join(String.fromCharCode(10)));
};
const config = () => JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));

let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return;
  started = true;
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') logs.push(`[console error] ${e.message} (${e.sourceId}:${e.lineNumber})`);
  });
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (cond, ms = 6000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (typeof cond === 'function' ? cond() : await js(cond)) return true;
        await wait(50);
      }
      return false;
    };
    try {
      await wait(1200);
      // 1. Defaults.
      check('starts on top, 96% opaque, full size', win.isAlwaysOnTop() && Math.abs(win.getOpacity() - 0.96) < 0.01 && win.getBounds().width === 480 && win.getBounds().height === 760, JSON.stringify(win.getBounds()));
      const nativePrivacy = ['win32', 'darwin'].includes(process.platform);
      check('privacy is off by default', (await js('window.api.screenPrivacyStatus()')).requested === false);
      await js(`document.querySelector('.tab[data-tab="settings"]').click(); 0`);
      await until(`!document.querySelector('#screenSharePrivacy').disabled`);
      if (nativePrivacy) {
        await js(`document.querySelector('#screenSharePrivacy').click(); 0`);
        await until(() => config().screenSharePrivacy === true && win.isContentProtected());
        check('privacy toggle applies native protection and persists', win.isContentProtected() && config().screenSharePrivacy === true);
        check('status reports native state without claiming verified exclusion', /not verified/.test(await js(`document.querySelector('#screenPrivacyStatus').textContent`)));
      }
      const invalid = await js(`window.api.setScreenPrivacy('false').then(() => false, () => true)`);
      check('privacy IPC rejects non-boolean values', invalid);

      // 2. Opacity: live preview, then saved.
      await js(`document.querySelector('.tab[data-tab="settings"]').click(); const o = document.querySelector('#opacity'); o.value = '0.6'; o.dispatchEvent(new Event('input')); 0`);
      await until(() => Math.abs(win.getOpacity() - 0.6) < 0.01);
      check('opacity slider previews on the real window', Math.abs(win.getOpacity() - 0.6) < 0.01, String(win.getOpacity()));
      await js(`document.querySelector('#saveSettings').click(); 0`);
      await until(() => config().opacity === 0.6);
      check('opacity saved', config().opacity === 0.6);

      // 3. Always on top switch.
      await until(`document.querySelector('#alwaysOnTop').checked === true`);
      await js(`document.querySelector('#alwaysOnTop').click(); 0`);
      await until(() => !win.isAlwaysOnTop());
      check('always-on-top off (real window) and remembered', !win.isAlwaysOnTop() && config().alwaysOnTop === false && !(await js(`document.querySelector('#pinBtn').classList.contains('active')`)));
      await js(`document.querySelector('#pinBtn').click(); 0`);
      await until(() => win.isAlwaysOnTop());
      check('pin button turns it back on', win.isAlwaysOnTop() && config().alwaysOnTop === true && (await js(`document.querySelector('#alwaysOnTop').checked`)));

      // 4. Position and size are remembered.
      win.setBounds({ x: 120, y: 90, width: 520, height: 700 });
      await until(() => config().windowBounds?.width === 520, 3000);
      check('moving and resizing is remembered', JSON.stringify(config().windowBounds) === JSON.stringify({ x: 120, y: 90, width: 520, height: 700 }), JSON.stringify(config().windowBounds));

      // 5. Compact view and back (from Settings, which comes back afterwards).
      await js(`document.querySelector('#compactBtn').click(); 0`);
      await until(() => win.getBounds().width === 360);
      const cb = win.getBounds();
      const ui = await js(`({ compact: document.body.classList.contains('compact'), tabs: getComputedStyle(document.querySelector('.tabs')).display, live: document.querySelector('#tab-live').classList.contains('active'), answer: getComputedStyle(document.querySelector('#answerBtn')).display, ask: getComputedStyle(document.querySelector('.ask')).display })`);
      check('compact view: small window at the same top-right corner, only the copilot', cb.width === 360 && cb.height === 320 && cb.x === 120 + 520 - 360 && cb.y === 90 && ui.compact && ui.tabs === 'none' && ui.live && ui.answer !== 'none' && ui.ask === 'none', JSON.stringify({ cb, ui }));
      check('compact window can shrink further (min 300×180)', JSON.stringify(win.getMinimumSize()) === '[300,180]');
      // Text size in compact view: the slider scales the transcript and answer, is saved, and comes back on start.
      const zoomBefore = await js(`getComputedStyle(document.querySelector('.transcript')).zoom`);
      await js(`(() => { const s = document.querySelector('#copilotScale'); s.value = '1.4'; s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change')); })(); 0`);
      await until(async () => (await js('window.api.getConfig()')).copilotScale === 1.4);
      const zoomAfter = await js(`getComputedStyle(document.querySelector('.transcript')).zoom`);
      check('text size slider scales the compact transcript and answer, and is saved', zoomBefore === '1' && zoomAfter === '1.4' && (await js(`document.querySelector('#copilotScaleValue').textContent`)) === '140%' && config().copilotScale === 1.4, JSON.stringify({ zoomBefore, zoomAfter }));
      const restored = await js(`(async () => { document.documentElement.style.setProperty('--copilot-scale', '1'); state.config = await window.api.getConfig(); fillSettings(); return getComputedStyle(document.documentElement).getPropertyValue('--copilot-scale').trim(); })()`);
      check('the saved text size is applied again when settings load at start', restored === '1.4', restored);
      const clamped = await js(`applyCopilotScale(5)`);
      check('text size stays between 80% and 160%', clamped === 1.6 && (await js(`applyCopilotScale(0.1)`)) === 0.8);
      await js(`applyCopilotScale(1.4); 0`);
      const fullZoom = await js(`(() => { document.body.classList.remove('compact'); const z = getComputedStyle(document.querySelector('.transcript')).zoom; document.body.classList.add('compact'); return z; })()`);
      check('the full window is not scaled by the compact text size', fullZoom === '1', fullZoom);
      fs.writeFileSync(path.join(out, 'compact-empty.png'), (await win.webContents.capturePage()).toPNG());
      await js(`document.querySelector('#compactBtn').click(); 0`);
      await until(() => win.getBounds().width === 520);
      check('full view restores size, place and the Settings tab', JSON.stringify(win.getBounds()) === JSON.stringify({ x: 120, y: 90, width: 520, height: 700 }) && (await js(`document.querySelector('.tab[data-tab="settings"]').classList.contains('active')`)) && JSON.stringify(win.getMinimumSize()) === '[380,420]');

      // 6. Global shortcuts, pressed through Windows.
      const st = await js('window.api.getShortcuts()');
      check('all five shortcuts registered', Object.values(st.status).every((s) => s.ok) && ['CommandOrControl+Shift+H', 'CommandOrControl+Shift+U', 'CommandOrControl+Shift+Y'].every((a) => globalShortcut.isRegistered(a)), JSON.stringify(st.status));
      await sendKeys('^+y');
      await until(() => win.getBounds().width === 360);
      check('Ctrl+Shift+Y (real key press) switches to compact view', win.getBounds().width === 360 && (await js(`document.body.classList.contains('compact')`)));
      await sendKeys('^+y');
      await until(() => win.getBounds().width === 520);
      await sendKeys('^+u');
      await until(() => win.isMinimized());
      check('Ctrl+Shift+U minimizes', win.isMinimized());
      await sendKeys('^+u');
      await until(() => !win.isMinimized() && win.isVisible());
      check('Ctrl+Shift+U brings it back', !win.isMinimized() && win.isVisible());
      await sendKeys('^+h');
      await until(() => !win.isVisible());
      check('Ctrl+Shift+H hides', !win.isVisible());

      // 7. Timers keep full speed while hidden (background throttling off).
      const gaps = await js(`new Promise((res) => { const out = []; let last = performance.now(); let n = 0; const tick = () => { const t = performance.now(); out.push(Math.round(t - last)); last = t; if (++n < 10) setTimeout(tick, 50); else res(out); }; setTimeout(tick, 50); })`);
      check('50 ms timers stay near 50 ms while hidden', Math.max(...gaps.slice(1)) < 150, gaps.join(','));
      await sendKeys('^+h');
      await until(() => win.isVisible());
      check('Ctrl+Shift+H shows it again', win.isVisible());

      // 8. Changing a shortcut, turning one off, and one held by another app.
      await js(`document.querySelector('.tab[data-tab="settings"]').click(); 0`);
      await until(`document.querySelectorAll('.shortcut-key').length === 5`);
      await js(`document.querySelector('.shortcut-key[data-name="compact"]').click(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'J', code: 'KeyJ', ctrlKey: true, shiftKey: true, bubbles: true })); 0`);
      await until(() => globalShortcut.isRegistered('CommandOrControl+Shift+J'));
      check('new keys recorded and registered; old ones released', globalShortcut.isRegistered('CommandOrControl+Shift+J') && !globalShortcut.isRegistered('CommandOrControl+Shift+Y') && config().shortcuts.compact === 'CommandOrControl+Shift+J');
      await sendKeys('^+j');
      await until(() => win.getBounds().width === 360);
      check('the new shortcut works', win.getBounds().width === 360);
      await js('window.api.setCompact(false)');
      await until(() => win.getBounds().width === 520);
      await js(`document.querySelector('.shortcut-key[data-name="screenshot"]').click(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', bubbles: true })); 0`);
      await until(() => !globalShortcut.isRegistered('CommandOrControl+Shift+S'));
      check('Backspace turns a shortcut off', !globalShortcut.isRegistered('CommandOrControl+Shift+S') && /Off/.test(await js(`document.querySelector('.shortcut-key[data-name="screenshot"]').textContent`)));
      // Windows refuses reserved keys (F12 is kept for debuggers): flagged.
      await js(`document.querySelector('.shortcut-key[data-name="minimize"]').click(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12', code: 'F12', bubbles: true })); 0`);
      await until(`!!document.querySelector('.shortcut-warn')`);
      check('keys Windows refuses are flagged', /Windows didn’t accept these keys/.test(await js(`document.querySelector('.shortcut-list').textContent`)) && (await js('window.api.getShortcuts()')).status.minimize.ok === false);
      fs.writeFileSync(path.join(out, 'shortcuts.png'), (await win.webContents.capturePage()).toPNG());
      await js(`window.api.setShortcut('minimize', 'CommandOrControl+Shift+U')`);

      // 9. Local capture is a diagnostic, not a meeting-app compatibility test.
      if (nativePrivacy) {
        check('protection survives compact, opacity, shortcuts and hide/restore', win.isContentProtected());
        await js(`window.api.setScreenPrivacy(false)`);
        await js(`document.querySelector('.tab[data-tab="settings"]').click(); 0`);
        await until(`/Privacy mode off/.test(document.querySelector('#screenPrivacyStatus').textContent)`);
      }
      await js(`document.querySelector('#sharePreview').scrollIntoView(); document.querySelector('#sharePreview').click(); 0`);
      await until(`document.querySelectorAll('#sharePreviewBox img').length > 0`, 10000);
      const preview = await js(`[document.querySelector('.share-status').textContent, document.querySelector('#sharePreviewBox img').src.length, document.querySelectorAll('#sharePreviewBox img').length]`);
      check('screen-sharing status accurately reports protection off', /Privacy mode off/.test(preview[0]));
      check('preview captures each screen', preview[1] > 5000 && preview[2] >= 1, `${preview[2]} screen(s), ${preview[1]} bytes`);
      if (typeof win.isContentProtected === 'function') check('window content protection is off', win.isContentProtected() === false);
      check('preview explains capture-path limitations', /may capture differently/.test(await js(`document.querySelector('#sharePreviewBox').textContent`)));
      if (nativePrivacy) {
        await js(`document.querySelector('#screenSharePrivacy').click(); 0`);
        await until(() => win.isContentProtected());
        check('changing privacy clears stale preview', await js(`document.querySelector('#sharePreviewBox').hidden && !document.querySelector('#sharePreviewBox').children.length`));
        const protectedPreview = await js('window.api.screenPreview()');
        check('local preview preserves enabled protection and reports native state', win.isContentProtected() && protectedPreview.privacy.enabled && protectedPreview.screens.length > 0);
      }
      fs.writeFileSync(path.join(out, 'share.png'), (await win.webContents.capturePage()).toPNG());

      // 10. Streaming continues through compact, opacity, minimize, hide and show.
      await js(`document.querySelector('.tab[data-tab="live"]').click(); document.querySelector('#askInput').value = 'Tell me about yourself?'; document.querySelector('#answerBtn').click(); 0`);
      await wait(300);
      if (nativePrivacy) await js('window.api.setScreenPrivacy(false)');
      await js('window.api.setCompact(true)');
      await wait(200);
      if (nativePrivacy) await js('window.api.setScreenPrivacy(true)');
      await js('window.api.previewOpacity(0.5)');
      await wait(200);
      win.minimize();
      await wait(400);
      win.restore();
      await wait(200);
      win.hide();
      await wait(400);
      win.showInactive();
      await js('window.api.setCompact(false)');
      await until(`/part29/.test(document.querySelector('#answers .card .body').textContent) && !document.querySelector('#answers .card').classList.contains('streaming')`, 10000);
      const text = await js(`document.querySelector('#answers .card .body').textContent`);
      check('answer streamed completely while the window was toggled', CHUNKS.every((c) => text.includes(c.trim())), text.slice(0, 80));
      if (nativePrivacy) check('privacy toggles during streaming retain native state', win.isContentProtected() && config().screenSharePrivacy === true);
      await js('window.api.previewOpacity(0.96)');

      // 11. CPU and memory (whole app: main, renderer, GPU, utility).
      const sample = async (ms) => {
        app.getAppMetrics();
        await wait(ms);
        const m = app.getAppMetrics();
        return { cpu: Math.round(m.reduce((a, p) => a + p.cpu.percentCPUUsage, 0) * 10) / 10, mb: Math.round(m.reduce((a, p) => a + p.memory.workingSetSize, 0) / 1024) };
      };
      await wait(1500);
      const idle = await sample(4000);
      let toggles = 0;
      const t = setInterval(() => {
        js(`window.api.setCompact(${toggles % 2 === 0})`);
        toggles++;
      }, 400);
      const busy = await sample(4000);
      clearInterval(t);
      await js('window.api.setCompact(false)');
      check('idle CPU and memory are low', idle.cpu < 5 && idle.mb < 600, `idle ${idle.cpu}% CPU, ${idle.mb} MB`);
      check('switching views 10 times in 4 s stays light', busy.cpu < 60, `${busy.cpu}% CPU, ${busy.mb} MB`);
      fs.writeFileSync(path.join(out, 'metrics.json'), JSON.stringify({ idle, busy }, null, 2));
      // Fresh processes load the same test configuration from disk. No real user data.
      if (nativePrivacy) {
        globalShortcut.unregisterAll();
        for (const enabled of [true, false]) {
          await js(`window.api.setScreenPrivacy(${enabled})`);
          const result = await new Promise((resolve) => execFile(process.execPath,
            [path.join(__dirname, 'privacy-restart.js'), userData, String(enabled)],
            { timeout: 20000, windowsHide: true }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));
          check(`fresh app restores privacy ${enabled ? 'on' : 'off'} before showing`, !result.err && result.stdout.includes('PRIVACY_RESTART_OK'), result.err?.message || result.stderr.slice(0, 120));
        }
      }
    } catch (err) {
      logs.push('[e2e-error] ' + err.stack);
    }
    fs.writeFileSync(path.join(out, 'log.txt'), logs.join(String.fromCharCode(10)));
    server.close();
    app.exit(0);
  });
});
