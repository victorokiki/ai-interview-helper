// End-to-end test of the browser extension bridge: turning it on in Settings
// (registry entries under a throwaway key, launcher and manifest), the real
// launcher → native host → inbox → app import chain, duplicates, a bad inbox
// file, the extension's page reader on a real page, the popup sending through
// the real launcher, and turning it off again.
const { app, BrowserWindow } = require('electron');
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const REG_ROOT = 'HKCU\\Software\\InterviewHelperE2E';
process.env.INTERVIEW_HELPER_REG_ROOT = REG_ROOT;
const regDelete = () => {
  try {
    execFileSync('reg', ['delete', REG_ROOT, '/f'], { stdio: 'ignore' });
  } catch {
    // Not there.
  }
};
regDelete();
// A leftover from versions before 0.18.1, which wrote to a misspelled key.
const LEGACY = [REG_ROOT, 'GoogleChrome', 'NativeMessagingHosts', 'com.interviewhelper.bridge'].join(String.fromCharCode(92));
execFileSync('reg', ['add', LEGACY, '/ve', '/t', 'REG_SZ', '/d', 'old', '/f'], { stdio: 'ignore' });
const legacyLeft = () => {
  try {
    execFileSync('reg', ['query', [REG_ROOT, 'GoogleChrome'].join(String.fromCharCode(92))], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const ROOT = path.join(__dirname, '..', '..');
const out = path.join(__dirname, 'out', 'bridge');
fs.rmSync(out, { recursive: true, force: true });
const userData = path.join(out, 'userdata');
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
const { ALLOWED_ORIGINS, BROWSERS, HOST_NAME } = require(path.join(ROOT, 'src', 'bridge', 'ids.js'));
const ORIGIN = ALLOWED_ORIGINS[0];

// A job page with schema.org JobPosting data, as Greenhouse, Lever, Workday and most career sites publish.
const PAGE = `<!doctype html><html><head><title>Platform Engineer - Fabrikam Careers</title>
<meta property="og:site_name" content="Fabrikam Careers">
<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Platform Engineer', hiringOrganization: { '@type': 'Organization', name: 'Fabrikam' }, description: '<p>Build our <b>developer platform</b>.</p><ul><li>Terraform</li><li>Kubernetes</li></ul>', jobLocationType: 'TELECOMMUTE' })}</script>
</head><body><nav>Home · Jobs</nav><main><h1>Platform Engineer</h1><p>Build our developer platform.</p></main></body></html>`;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE);
});

server.listen(0, () => {
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ provider: 'ollama', ollamaUrl: 'http://127.0.0.1:9', transcription: 'local', jobsMigrated: true, liveNoticeAck: true, meetingDetection: false }));
  require(path.join(ROOT, 'src', 'main.js'));
});

const logs = [];
const check = (name, ok, extra = '') => {
  logs.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  fs.writeFileSync(path.join(out, 'log.txt'), logs.join(String.fromCharCode(10)));
};

// Sends one message through the launcher exactly as Chrome does.
function viaLauncher(launcher, message, origin = ORIGIN) {
  return new Promise((resolve) => {
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${launcher}" ${origin} --parent-window=0"`], { windowsVerbatimArguments: true, windowsHide: true });
    let buf = Buffer.alloc(0);
    child.stdout.on('data', (c) => (buf = Buffer.concat([buf, c])));
    child.on('close', (code) => resolve({ code, reply: buf.length >= 4 ? JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString('utf8')) : null }));
    const body = Buffer.from(JSON.stringify(message));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    child.stdin.end(Buffer.concat([head, body]));
  });
}

const regValue = (b) => {
  try {
    return execFileSync('reg', ['query', `${REG_ROOT}\\${b.win}\\NativeMessagingHosts\\${HOST_NAME}`, '/ve'], { encoding: 'utf8' });
  } catch {
    return '';
  }
};

let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return;
  started = true;
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') logs.push(`[console error] ${e.message} (${e.sourceId}:${e.lineNumber})`);
  });
  win.webContents.once('did-finish-load', async () => {
    const js = (code, w = win) => w.webContents.executeJavaScript(code);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (code, ms = 8000, w = win) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await js(code, w)) return true;
        await wait(50);
      }
      return false;
    };
    try {
      await wait(1000);
      // 1. Off by default; turning it on registers every browser.
      await js(`document.querySelector('.tab[data-tab="settings"]').click(); 0`);
      await until(`/Off\\./.test(document.querySelector('#bridgeStatus').textContent)`);
      check('bridge is off by default', (await js(`document.querySelector('#bridgeToggle').textContent`)) === 'Turn on');
      await js(`document.querySelector('#bridgeToggle').click(); 0`);
      await until(`/On for/.test(document.querySelector('#bridgeStatus').textContent)`);
      const statusText = await js(`document.querySelector('#bridgeStatus').textContent`);
      check('Turn on registers Chrome, Edge, Brave and Chromium', /Google Chrome, Microsoft Edge, Brave, Chromium/.test(statusText) && statusText.includes(ORIGIN.slice(19, -1)), statusText);
      const manifestPath = path.join(userData, 'bridge', `${HOST_NAME}.json`);
      const launcher = path.join(userData, 'bridge', 'host.bat');
      check('registry points each browser at the manifest', BROWSERS.every((b) => regValue(b).includes(manifestPath)));
      // Spelled-out vendor paths, so a wrong key name can't pass by matching itself.
      const literal = (sub) => {
        try {
          return execFileSync('reg', ['query', [REG_ROOT, ...sub, 'NativeMessagingHosts', HOST_NAME].join(String.fromCharCode(92)), '/ve'], { encoding: 'utf8' });
        } catch {
          return '';
        }
      };
      check('Turn on removes the misspelled key older versions left behind', !legacyLeft());
      check('the keys are the browsers\' real ones (Google\\Chrome, Microsoft\\Edge, BraveSoftware\\Brave-Browser)', [['Google', 'Chrome'], ['Microsoft', 'Edge'], ['BraveSoftware', 'Brave-Browser'], ['Chromium']].every((sub) => literal(sub).includes(manifestPath)));
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      check('manifest allows only our extension and runs the launcher', manifest.name === HOST_NAME && manifest.type === 'stdio' && manifest.path === launcher && JSON.stringify(manifest.allowed_origins) === JSON.stringify(ALLOWED_ORIGINS));
      check('launcher runs this app as Node with the host script', fs.readFileSync(launcher, 'utf8').includes(`"${process.execPath}"`) && fs.readFileSync(launcher, 'utf8').includes('ELECTRON_RUN_AS_NODE=1'));
      await js(`document.querySelector('#bridgeStatus').scrollIntoView({ block: 'center' }); 0`);
      await wait(100);
      fs.writeFileSync(path.join(out, 'settings.png'), (await win.webContents.capturePage()).toPNG());
      check('config remembers the setting', JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')).browserBridge === true);

      // 2. The real chain: launcher → host → inbox → app.
      const ping = await viaLauncher(launcher, { type: 'ping' });
      check('ping through the launcher answers with the app version', ping.reply?.ok && ping.reply.version === require(path.join(ROOT, 'package.json')).version, JSON.stringify(ping));
      const stranger = await viaLauncher(launcher, { type: 'ping' }, 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/');
      check('another extension is refused', stranger.code !== 0 && /not allowed/.test(stranger.reply?.error || ''));
      const job = { company: 'Contoso', role: 'Platform Engineer', description: 'Run Kubernetes clusters.', url: 'https://jobs.example/contoso/42#apply' };
      const sent = await viaLauncher(launcher, { type: 'importJob', job });
      check('import accepted by the host', sent.reply?.ok === true, JSON.stringify(sent));
      await until(`/Added Contoso — Platform Engineer to Jobs from your browser\\./.test(document.querySelector('#banner').textContent)`);
      check('app shows the import with an Open job button', (await js(`document.querySelector('#banner').textContent`)).includes('Added Contoso') && (await js(`!!document.querySelector('#banner button')`)));
      const list = await js('window.api.listJobs()');
      check('job saved with description, posting URL (no #fragment) and import note', list.length === 1 && list[0].jobDescription === 'Run Kubernetes clusters.' && list[0].url === 'https://jobs.example/contoso/42' && list[0].stage === 'saved' && /Imported from jobs\.example/.test(list[0].notes), JSON.stringify(list[0]));
      check('first imported job becomes the active job', (await js('window.api.getConfig()')).activeJobId === list[0].id);
      check('inbox emptied', fs.readdirSync(path.join(userData, 'inbox')).length === 0);
      await js(`document.querySelector('#banner button').click(); 0`);
      await until(`!document.querySelector('#jobForm').hidden`);
      check('Open job shows the posting URL with an Open link', (await js(`document.querySelector('#jobUrl').value`)) === 'https://jobs.example/contoso/42' && !(await js(`document.querySelector('#openPosting').hidden`)));
      await js(`document.querySelector('#cancelJob').click(); 0`);

      // 3. Same posting again, and a bad file in the inbox.
      await viaLauncher(launcher, { type: 'importJob', job });
      await until(`/already in Jobs/.test(document.querySelector('#banner').textContent)`);
      check('same posting is not added twice', (await js('window.api.listJobs()')).length === 1 && /Contoso — Platform Engineer is already in Jobs/.test(await js(`document.querySelector('#banner').textContent`)));
      fs.writeFileSync(path.join(userData, 'inbox', '1-bad.json'), JSON.stringify({ job: { role: 'Evil', url: 'javascript:alert(1)' } }));
      fs.writeFileSync(path.join(userData, 'inbox', '2-broken.json'), '{not json');
      await wait(800);
      check('invalid inbox files are dropped, not imported', (await js('window.api.listJobs()')).length === 1 && fs.readdirSync(path.join(userData, 'inbox')).length === 0);

      // 4. The extension's page reader on a real page.
      const page = new BrowserWindow({ show: false });
      await page.loadURL(`http://127.0.0.1:${server.address().port}/jobs/platform-engineer`);
      const raw = await page.webContents.executeJavaScript(fs.readFileSync(path.join(ROOT, 'extension', 'grab.js'), 'utf8'));
      page.destroy();
      check('page reader collects title, JSON-LD and page text', raw.jsonLd.length === 1 && raw.h1 === 'Platform Engineer' && raw.siteName === 'Fabrikam Careers' && raw.text.includes('developer platform') && !raw.text.includes('Home · Jobs'), JSON.stringify(raw).slice(0, 200));
      fs.writeFileSync(path.join(out, 'raw.json'), JSON.stringify(raw));

      // 5. The popup, sending through the real launcher.
      const popup = new BrowserWindow({
        show: false,
        width: 400,
        height: 640,
        webPreferences: { preload: path.join(__dirname, 'bridge-stub.js'), contextIsolation: false, sandbox: false, additionalArguments: [`--raw=${path.join(out, 'raw.json')}`, `--launcher=${launcher}`, `--origin=${ORIGIN}`] },
      });
      popup.webContents.on('console-message', (e) => {
        if (e.level === 'error') logs.push(`[console error] popup: ${e.message}`);
      });
      await popup.loadFile(path.join(ROOT, 'extension', 'popup.html'));
      await until(`/Connected to Interview Helper/.test(document.querySelector('#statusText').textContent) && !document.querySelector('#send').disabled`, 10000, popup);
      const fields = await js(`[company.value, role.value, description.value, source.textContent, statusText.textContent]`, popup);
      check('popup fills the job from the page data and shows the connection', fields[0] === 'Fabrikam' && fields[1] === 'Platform Engineer' && fields[2] === 'Location: Remote\n\nBuild our developer platform.\n- Terraform\n- Kubernetes' && /job details the page publishes/.test(fields[3]) && fields[4].includes(require(path.join(ROOT, 'package.json')).version), JSON.stringify(fields));
      fs.writeFileSync(path.join(out, 'popup.png'), (await popup.webContents.capturePage()).toPNG());
      await js(`role.value = 'Senior Platform Engineer'; form.dispatchEvent(new Event('input')); send.click(); 0`, popup);
      await until(`/Added to Jobs/.test(result.textContent)`, 10000, popup);
      check('popup sends the edited job and confirms', (await js(`result.className`, popup)) === 'result ok');
      await until(`/Added Fabrikam — Senior Platform Engineer/.test(document.querySelector('#banner').textContent)`);
      const jobs2 = await js('window.api.listJobs()');
      check('popup import reaches the app with the edit', jobs2.length === 2 && jobs2[1].role === 'Senior Platform Engineer' && jobs2[1].url.endsWith('/jobs/platform-engineer'));
      popup.destroy();

      const offline = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'bridge-stub.js'), contextIsolation: false, sandbox: false, additionalArguments: [`--raw=${path.join(out, 'raw.json')}`] } });
      await offline.loadFile(path.join(ROOT, 'extension', 'popup.html'));
      await until(`/isn’t connected yet/.test(statusText.textContent)`, 5000, offline);
      check('popup explains how to connect when the app is not set up', /Settings → Browser extension/.test(await js('statusText.textContent', offline)) && (await js('send.disabled', offline)));
      offline.destroy();

      // 6. Turning it off removes everything it registered.
      await js(`document.querySelector('.tab[data-tab="settings"]').click(); document.querySelector('#bridgeToggle').click(); 0`);
      await until(`/Off\\./.test(document.querySelector('#bridgeStatus').textContent)`);
      check('Turn off removes registry entries and the launcher', BROWSERS.every((b) => !regValue(b)) && !fs.existsSync(path.join(userData, 'bridge')) && JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')).browserBridge === false);
      fs.writeFileSync(path.join(out, 'banner.png'), (await win.webContents.capturePage()).toPNG());
    } catch (err) {
      logs.push('[e2e-error] ' + err.stack);
    }
    regDelete();
    fs.writeFileSync(path.join(out, 'log.txt'), logs.join(String.fromCharCode(10)));
    server.close();
    app.exit(0);
  });
});
