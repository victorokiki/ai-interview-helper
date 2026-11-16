// Real-browser check of the extension (run by hand; needs a Chromium build that
// allows extension debugging, e.g. Playwright's Chrome for Testing):
//
//   node tests/manual/real-browser.js "<path to chrome.exe>"
//
// Loads extension/ unpacked through the DevTools pipe, opens a local job page,
// clicks the extension's toolbar button (Extensions.triggerAction), checks the
// popup read the page and connected to the native host, presses Add to Jobs,
// and checks the job landed in the inbox. The host is registered under HKCU
// for the duration of the run and removed afterwards.
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hostFiles } = require('../../src/bridge/index.js');
const { HOST_NAME, EXTENSION_IDS } = require('../../src/bridge/ids.js');

const ROOT = path.join(__dirname, '..', '..');
const chromePath = process.argv[2];
if (!chromePath || !fs.existsSync(chromePath)) {
  console.error('Usage: node tests/manual/real-browser.js <chrome.exe>');
  process.exit(2);
}
const electronPath = require('electron');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ih-browser-'));
const data = path.join(tmp, 'data');
const profile = path.join(tmp, 'profile');
fs.mkdirSync(data, { recursive: true });
const launcherPath = path.join(tmp, 'host.bat');
const manifestPath = path.join(tmp, `${HOST_NAME}.json`);
const { launcher, manifest } = hostFiles({ platform: 'win32', execPath: electronPath, script: path.join(ROOT, 'src', 'bridge', 'host.js'), dataDir: data, launcherPath });
fs.writeFileSync(launcherPath, launcher);
fs.writeFileSync(manifestPath, JSON.stringify(manifest));
const KEYS = ['Google\\Chrome for Testing', 'Google\\Chrome', 'Chromium'].map((k) => `HKCU\\Software\\${k}\\NativeMessagingHosts\\${HOST_NAME}`);
for (const k of KEYS) execFileSync('reg', ['add', k, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { stdio: 'ignore' });

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};

const PAGE = `<!doctype html><html><head><title>Data Engineer at Northwind</title>
<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Data Engineer', hiringOrganization: { name: 'Northwind Traders' }, description: '<p>Own our <b>Spark</b> pipelines.</p>' })}</script>
</head><body><main><h1>Data Engineer</h1><p>Own our Spark pipelines.</p></main></body></html>`;
const server = http.createServer((req, res) => res.end(PAGE));

// Minimal DevTools protocol client over --remote-debugging-pipe (fd 3 in, fd 4 out, NUL-separated JSON).
function cdp(child) {
  let id = 0;
  let buf = '';
  const pending = new Map();
  const listeners = [];
  child.stdio[4].on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\0')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message} ${msg.error.data || ''}`)) : resolve(msg.result);
      } else listeners.forEach((l) => l(msg));
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const msg = { id: ++id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      pending.set(msg.id, { resolve, reject });
      child.stdio[3].write(JSON.stringify(msg) + '\0');
    });
  return { send, on: (l) => listeners.push(l) };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

server.listen(0, async () => {
  const url = `http://127.0.0.1:${server.address().port}/jobs/data-engineer`;
  const chrome = spawn(chromePath, ['--remote-debugging-pipe', '--enable-unsafe-extension-debugging', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-features=Translate', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const { send } = cdp(chrome);
  try {
    const version = await send('Browser.getVersion');
    console.log('Browser:', version.product);
    const { id } = await send('Extensions.loadUnpacked', { path: path.join(ROOT, 'extension') });
    check('extension loads unpacked with the fixed ID the host allows', id === EXTENSION_IDS[0], id);

    const { targetId } = await send('Target.createTarget', { url });
    await wait(1500);
    await send('Target.activateTarget', { targetId });
    // triggerAction needs the tab target (not the page target) of that tab.
    const tabs = (await send('Target.getTargets', { filter: [{ type: 'tab' }] })).targetInfos;
    const tab = tabs.find((t) => t.url === url) || tabs.find((t) => t.targetId === targetId);
    await send('Extensions.triggerAction', { id, targetId: tab.targetId });
    let popup = null;
    for (let i = 0; i < 40 && !popup; i++) {
      await wait(150);
      popup = (await send('Target.getTargets')).targetInfos.find((t) => t.url.startsWith(`chrome-extension://${id}/popup.html`));
    }
    check('toolbar button opens the popup', Boolean(popup));
    const { sessionId } = await send('Target.attachToTarget', { targetId: popup.targetId, flatten: true });
    const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
    let state = null;
    for (let i = 0; i < 60; i++) {
      state = await evaluate(`({ status: document.querySelector('#statusText').textContent, company: company.value, role: role.value, description: description.value, source: source.textContent, disabled: send.disabled })`);
      if (!state.disabled) break;
      await wait(150);
    }
    check('popup read the page (JSON-LD) through activeTab', state.company === 'Northwind Traders' && state.role === 'Data Engineer' && state.description === 'Own our Spark pipelines.', JSON.stringify(state));
    check('popup reached the app through native messaging', /Connected to Interview Helper/.test(state.status), state.status);
    await evaluate(`send.click()`);
    let result = '';
    for (let i = 0; i < 60 && !/Added|Could|isn/.test(result); i++) {
      await wait(150);
      result = await evaluate(`result.textContent`);
    }
    check('Add to Jobs confirms', /Added to Jobs/.test(result), result);
    const inbox = path.join(data, 'inbox');
    const files = fs.existsSync(inbox) ? fs.readdirSync(inbox).filter((f) => f.endsWith('.json')) : [];
    const job = files[0] && JSON.parse(fs.readFileSync(path.join(inbox, files[0]), 'utf8')).job;
    check('job written to the app inbox by the real host', job?.company === 'Northwind Traders' && job.url === url, JSON.stringify(job));
  } catch (err) {
    check('run', false, err.stack);
  } finally {
    chrome.kill();
    server.close();
    for (const k of KEYS) {
      try {
        execFileSync('reg', ['delete', k, '/f'], { stdio: 'ignore' });
      } catch {
        // Already gone.
      }
    }
    await wait(500);
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
    console.log(results.every(Boolean) ? 'ALL PASSED' : 'SOME FAILED');
    process.exit(results.every(Boolean) ? 0 : 1);
  }
});
