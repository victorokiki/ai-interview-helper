// Fallback for check.js when no Chrome or Edge is installed: loads each fixture
// page in a hidden Electron window (same Chromium engine), waits for the
// harness to set its title, and writes the results as JSON to --out (Electron
// on Windows has no usable stdout): [{ file, title, pre }]
// Usage: electron tests/extension/electron-fixtures.js --out=<results.json> <fixture.html>...
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); // one window per fixture; don't quit between them
app.whenReady().then(async () => {
  const out = [];
  for (const file of process.argv.slice(2).filter((a) => a.endsWith('.html'))) {
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    let title = '(no title)';
    let pre = '';
    try {
      await win.loadFile(file);
      const end = Date.now() + 30000;
      while (Date.now() < end) {
        title = win.webContents.getTitle();
        if (/^JOBKIT-TEST (PASS|FAIL)/.test(title)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      pre = await win.webContents.executeJavaScript(`(document.getElementById('jk-results') || {}).textContent || ''`);
    } catch (e) {
      pre = 'Harness error: ' + e.message;
    }
    win.destroy();
    out.push({ file: path.basename(file), title, pre });
  }
  const dest = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
  if (dest) fs.writeFileSync(dest, JSON.stringify(out));
  app.exit(0);
});
