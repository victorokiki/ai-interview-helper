// Coding Lab window and the app:// protocol it is served from.
//
// Why a protocol: the lab runs code in Web Workers (Pyodide, sql.js, a JS
// sandbox) and the Monaco editor uses workers too. Workers need a real
// same-origin URL, which file:// doesn't give. app://local/... serves an
// allow-listed set of the app's own files with a strict Content-Security-
// Policy on every response:
//   - the lab page: scripts and connections only from the app itself;
//   - the code-runner workers: may compile code ('unsafe-eval', WASM) but can
//     only fetch the app's own files, so user code has no network access.
// The lab runs in its own window (own renderer process), so a runaway program
// can't freeze the live copilot window; runs also have a time limit.
const { app, protocol, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ALLOWED = [
  'src/renderer/',
  'packages/core/',
  'node_modules/monaco-editor/min/',
  'node_modules/pyodide/',
  'node_modules/sql.js/dist/',
  'node_modules/marked/lib/',
  'node_modules/dompurify/dist/',
  'node_modules/@fontsource-variable/inter/files/',
];
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
};
const PAGE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; worker-src 'self'; connect-src 'self'";
const RUNNER_CSP = "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self'";
const RUNNERS = /^src\/renderer\/runners\//;

// Must run before the app is ready (main.js calls it at load).
function registerScheme() {
  if (app.isReady()) return false;
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  ]);
  return true;
}

let registered = false;

function handleProtocol() {
  try {
    protocol.handle('app', async (req) => {
      const url = new URL(req.url);
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = path.normalize(path.join(ROOT, rel));
      const allowed = url.host === 'local' && !rel.includes('..') && file.startsWith(ROOT + path.sep) && ALLOWED.some((a) => rel.startsWith(a));
      if (!allowed) return new Response('Not found', { status: 404 });
      try {
        const data = await fs.promises.readFile(file); // works inside app.asar
        return new Response(data, {
          headers: {
            'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
            'content-security-policy': RUNNERS.test(rel) ? RUNNER_CSP : PAGE_CSP,
            'cache-control': 'no-cache',
          },
        });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    });
    registered = true;
  } catch (err) {
    console.warn('app:// protocol unavailable:', err.message);
  }
}

let labWin = null;

function openLab(preload) {
  if (labWin && !labWin.isDestroyed()) {
    labWin.show();
    labWin.focus();
    return labWin;
  }
  if (!registered) throw new Error('The Coding Lab could not start (app:// protocol not registered).');
  labWin = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    title: 'Coding Lab · Interview Helper',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  labWin.loadURL('app://local/src/renderer/codelab.html');
  labWin.on('closed', () => {
    labWin = null;
  });
  return labWin;
}

function labWindow() {
  return labWin && !labWin.isDestroyed() ? labWin : null;
}

module.exports = { registerScheme, handleProtocol, openLab, labWindow };
