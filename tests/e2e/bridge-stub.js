// Preload for the popup test window: stands in for the parts of the Chrome
// extension API the popup uses. sendNativeMessage starts the REAL launcher the
// app registered, the same way Chrome does (cmd /c "<launcher>" <origin>).
const { spawn } = require('child_process');
const fs = require('fs');

const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3);
const raw = JSON.parse(fs.readFileSync(arg('raw'), 'utf8'));
const launcher = arg('launcher');
const origin = arg('origin');
const sent = [];

function nativeMessage(message, cb) {
  if (!launcher) {
    chromeApi.runtime.lastError = { message: 'Specified native messaging host not found.' };
    setTimeout(() => {
      cb(undefined);
      chromeApi.runtime.lastError = undefined;
    });
    return;
  }
  sent.push(message);
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${launcher}" ${origin} --parent-window=0"`], { windowsVerbatimArguments: true, windowsHide: true });
  let out = Buffer.alloc(0);
  child.stdout.on('data', (c) => (out = Buffer.concat([out, c])));
  child.on('close', () => {
    let reply;
    if (out.length >= 4) reply = JSON.parse(out.subarray(4, 4 + out.readUInt32LE(0)).toString('utf8'));
    else chromeApi.runtime.lastError = { message: 'Native host has exited.' };
    cb(reply);
    chromeApi.runtime.lastError = undefined;
  });
  const body = Buffer.from(JSON.stringify(message));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  child.stdin.end(Buffer.concat([head, body]));
}

const chromeApi = {
  runtime: { lastError: undefined, sendNativeMessage: (host, message, cb) => (host === 'com.interviewhelper.bridge' ? nativeMessage(message, cb) : cb(undefined)) },
  tabs: { query: async () => [{ id: 7, url: raw.url }] },
  scripting: { executeScript: async ({ target, files }) => (target.tabId === 7 && files[0] === 'grab.js' ? [{ result: raw }] : []) },
};
Object.defineProperty(window, 'chrome', { value: chromeApi, configurable: true, writable: true });
window.__sentNative = sent;
