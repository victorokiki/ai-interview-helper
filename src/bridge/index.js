// Browser extension bridge (main process): registers the native messaging host
// with the browsers when the user turns it on, removes it when they turn it
// off, and imports the jobs the host drops into <userData>/inbox/.
//
// Registration is per user (HKCU on Windows, ~/Library on macOS) and needs no
// admin rights. The uninstaller removes the registry keys (build/installer.nsh).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { HOST_NAME, ALLOWED_ORIGINS, BROWSERS, LEGACY_WIN_KEYS } = require('./ids');
const { cleanImport } = require('../../packages/core/jobpost');

// Tests point this at a throwaway key so they never touch the real browsers.
const REG_ROOT = process.env.INTERVIEW_HELPER_REG_ROOT || 'HKCU\\Software';

function hostScript(app) {
  return app.isPackaged ? path.join(process.resourcesPath, 'app.asar', 'src', 'bridge', 'host.js') : path.join(__dirname, 'host.js');
}

function extensionFolder(app) {
  return app.isPackaged ? path.join(process.resourcesPath, 'extension') : path.join(__dirname, '..', '..', 'extension');
}

// The launcher the browser runs, and the host manifest that points at it.
// Pure, so tests can check the quoting.
function hostFiles({ platform, execPath, script, dataDir, launcherPath }) {
  let launcher;
  if (platform === 'win32') {
    const q = (s) => `"${String(s).replace(/%/g, '%%')}"`;
    launcher = ['@echo off', 'set ELECTRON_RUN_AS_NODE=1', `${q(execPath)} ${q(script)} --data ${q(dataDir)} %*`, ''].join('\r\n');
  } else {
    const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    launcher = ['#!/bin/sh', `ELECTRON_RUN_AS_NODE=1 exec ${q(execPath)} ${q(script)} --data ${q(dataDir)} "$@"`, ''].join('\n');
  }
  const manifest = {
    name: HOST_NAME,
    description: 'Interview Helper: import job postings from the browser',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: ALLOWED_ORIGINS,
  };
  return { launcher, manifest };
}

function reg(args) {
  return new Promise((resolve) => execFile('reg', args, { windowsHide: true }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout || '') })));
}

function macHostDirs() {
  const base = path.join(require('os').homedir(), 'Library', 'Application Support');
  return BROWSERS.map((b) => ({ name: b.name, browserDir: path.join(base, b.mac), dir: path.join(base, b.mac, 'NativeMessagingHosts') }));
}

function createBridge({ app, onImport }) {
  const dir = () => path.join(app.getPath('userData'), 'bridge');
  const inbox = () => path.join(app.getPath('userData'), 'inbox');
  const launcherPath = () => path.join(dir(), process.platform === 'win32' ? 'host.bat' : 'host.sh');
  const manifestPath = () => path.join(dir(), `${HOST_NAME}.json`);

  // Versions before 0.18.1 wrote to misspelled keys (HKCU\Software\GoogleChrome
  // ...). Remove our entry there, and the empty keys if nothing else is in them.
  async function removeLegacyKeys() {
    for (const k of LEGACY_WIN_KEYS) {
      await reg(['delete', `${REG_ROOT}\\${k}\\NativeMessagingHosts\\${HOST_NAME}`, '/f']);
      const left = await reg(['query', `${REG_ROOT}\\${k}`, '/s']);
      const onlyEmpty = left.ok && !left.stdout.split(/\r?\n/).some((l) => /\sREG_/.test(l)) && !left.stdout.includes(`${k}\\NativeMessagingHosts\\`);
      if (onlyEmpty) await reg(['delete', `${REG_ROOT}\\${k}`, '/f']);
    }
  }

  // Writes the launcher and manifest, then tells each browser where they are.
  async function register() {
    fs.mkdirSync(dir(), { recursive: true });
    const { launcher, manifest } = hostFiles({
      platform: process.platform,
      execPath: process.execPath,
      script: hostScript(app),
      dataDir: app.getPath('userData'),
      launcherPath: launcherPath(),
    });
    fs.writeFileSync(launcherPath(), launcher, { mode: 0o755 });
    fs.writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2));
    const browsers = [];
    if (process.platform === 'win32') {
      await removeLegacyKeys();
      for (const b of BROWSERS) {
        const r = await reg(['add', `${REG_ROOT}\\${b.win}\\NativeMessagingHosts\\${HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', manifestPath(), '/f']);
        if (r.ok) browsers.push(b.name);
      }
    } else if (process.platform === 'darwin') {
      for (const b of macHostDirs()) {
        if (!fs.existsSync(b.browserDir)) continue;
        fs.mkdirSync(b.dir, { recursive: true });
        fs.writeFileSync(path.join(b.dir, `${HOST_NAME}.json`), JSON.stringify(manifest, null, 2));
        browsers.push(b.name);
      }
    }
    return { ok: browsers.length > 0, browsers };
  }

  async function unregister() {
    if (process.platform === 'win32') {
      await removeLegacyKeys();
      for (const b of BROWSERS) await reg(['delete', `${REG_ROOT}\\${b.win}\\NativeMessagingHosts\\${HOST_NAME}`, '/f']);
    } else if (process.platform === 'darwin') {
      for (const b of macHostDirs()) fs.rmSync(path.join(b.dir, `${HOST_NAME}.json`), { force: true });
    }
    fs.rmSync(dir(), { recursive: true, force: true });
    return { ok: true };
  }

  // Which browsers currently point at our manifest.
  async function status() {
    const browsers = [];
    if (process.platform === 'win32') {
      for (const b of BROWSERS) {
        const r = await reg(['query', `${REG_ROOT}\\${b.win}\\NativeMessagingHosts\\${HOST_NAME}`, '/ve']);
        if (r.ok && r.stdout.includes(manifestPath())) browsers.push(b.name);
      }
    } else if (process.platform === 'darwin') {
      for (const b of macHostDirs()) if (fs.existsSync(path.join(b.dir, `${HOST_NAME}.json`))) browsers.push(b.name);
    }
    return { registered: browsers.length > 0 && fs.existsSync(launcherPath()), browsers, extensionFolder: extensionFolder(app), extensionId: ALLOWED_ORIGINS[0].slice(19, -1) };
  }

  // Imports every complete file in the inbox. Each file is validated again
  // (the app doesn't trust the folder) and deleted whether or not it was valid.
  let draining = false;
  function drain() {
    if (draining) return;
    draining = true;
    try {
      if (!fs.existsSync(inbox())) return;
      for (const name of fs.readdirSync(inbox()).sort()) {
        const file = path.join(inbox(), name);
        if (!name.endsWith('.json')) {
          // Leftover temp files older than a minute are from a crashed host.
          if (name.endsWith('.tmp') && Date.now() - fs.statSync(file).mtimeMs > 60000) fs.rmSync(file, { force: true });
          continue;
        }
        let entry = null;
        try {
          if (fs.statSync(file).size <= 1024 * 1024) entry = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
          entry = null;
        }
        fs.rmSync(file, { force: true });
        const r = cleanImport(entry?.job);
        if (r.ok) onImport(r.job);
        else console.warn('Ignored a browser import:', r.error);
      }
    } catch (err) {
      console.warn('Browser import failed:', err.message);
    } finally {
      draining = false;
    }
  }

  let timer = null;
  function watch() {
    fs.mkdirSync(inbox(), { recursive: true });
    drain();
    try {
      fs.watch(inbox(), () => {
        clearTimeout(timer);
        timer = setTimeout(drain, 100);
      });
    } catch {
      // No change notifications here: the interval below still imports.
    }
    // Backstop in case a change notification is missed.
    setInterval(drain, 30000).unref?.();
  }

  return { register, unregister, status, watch, drain, launcherPath, manifestPath };
}

module.exports = { createBridge, hostFiles, REG_ROOT };
