// Child of window.js: verifies real persisted preference in a fresh app process.
const { app } = require('electron');
const path = require('path');
app.setPath('userData', path.resolve(process.argv[2]));
const expected = process.argv[3] === 'true';
app.on('browser-window-created', (_event, win) => {
  let protectedAtFirstShow = null;
  win.once('show', () => { protectedAtFirstShow = win.isContentProtected(); });
  win.webContents.once('did-finish-load', async () => {
    try {
      const status = await win.webContents.executeJavaScript('window.api.screenPrivacyStatus()');
      if (!win.isVisible()) await new Promise((resolve) => win.once('show', resolve));
      if (status.requested !== expected || status.enabled !== expected || protectedAtFirstShow !== expected) throw new Error('Restore mismatch');
      console.log('PRIVACY_RESTART_OK');
      app.exit(0);
    } catch (err) { console.error(err.message); app.exit(1); }
  });
});
require('../../src/main');
