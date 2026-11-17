// Windows-only native capture diagnostic. No screenshots are saved or uploaded.
// Does not verify a meeting application's capture path.
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const path = require('path');
const { createScreenPrivacy } = require('../../src/screen-privacy');
app.setPath('userData', path.join(__dirname, 'out', 'privacy-capture', 'userdata'));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  if (process.platform !== 'win32') { console.log('SKIP: Windows capture diagnostic'); return app.exit(0); }
  let win;
  try {
    const display = screen.getPrimaryDisplay();
    const { x, y } = display.workArea;
    win = new BrowserWindow({ x: x + 40, y: y + 40, width: 280, height: 220,
      frame: false, alwaysOnTop: true, backgroundColor: '#f70dd3',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await win.loadURL('data:text/html,<body style="margin:0;background:rgb(247,13,211)"></body>');
    win.show();
    win.setAlwaysOnTop(true, 'screen-saver');
    win.moveTop();
    const privacy = createScreenPrivacy();
    async function count(enabled) {
      const state = privacy.apply(win, enabled);
      if (state.enabled !== enabled) throw new Error('Native state mismatch');
      await pause(900);
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } });
      const source = sources.find((s) => s.display_id === String(display.id));
      if (!source || source.thumbnail.isEmpty()) throw new Error('Primary display capture unavailable');
      const pixels = source.thumbnail.toBitmap();
      let n = 0;
      // BGRA. Match a magenta range, not the exact colour: displays with colour
      // management capture (247,13,211) as about (228,50,206), which a tight
      // tolerance never matched (0 pixels even with protection off).
      for (let i = 0; i < pixels.length; i += 4) {
        const b = pixels[i], g = pixels[i + 1], r = pixels[i + 2];
        if (r > 170 && g < 110 && b > 150 && r - g > 100) n++;
      }
      return n;
    }
    const off = await count(false), on = await count(true), restored = await count(false);
    console.log(JSON.stringify({ platform: process.platform, os: require('os').release(), electron: process.versions.electron, markerPixels: { off, on, restored } }));
    if (off < 300) throw new Error('Inconclusive: unprotected marker was not visible in the captured display');
    if (on > off * 0.01 || restored < off * 0.5) throw new Error('Local capture exclusion/reversal was not verified');
    console.log('PASS: Windows Electron desktop capture excludes protected marker and restores it when disabled');
    app.exit(0);
  } catch (err) { console.error('FAIL:', err.message); app.exit(1); }
});
