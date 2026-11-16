// Browser extension bridge: job-page parsing, import validation, the native
// messaging host's wire protocol (spawned for real), and launcher quoting.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const J = require('../../packages/core/jobpost');
const ids = require('../../src/bridge/ids');

const ROOT = path.join(__dirname, '..', '..');

test('JSON-LD JobPosting (in @graph, HTML description) is read first', () => {
  const ld = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Organization', name: 'Ignore me' },
      {
        '@type': 'JobPosting',
        title: 'Senior Site Reliability Engineer',
        hiringOrganization: { '@type': 'Organization', name: 'Contoso' },
        jobLocation: [{ address: { addressLocality: 'Seattle' } }],
        description: '&lt;p&gt;Run &lt;b&gt;Kubernetes&lt;/b&gt; at scale.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Go&lt;/li&gt;&lt;li&gt;On-call &amp;amp; incidents&lt;/li&gt;&lt;/ul&gt;',
      },
    ],
  });
  const job = J.parseJobPage({ url: 'https://careers.contoso.com/jobs/42', title: 'Careers', jsonLd: ['not json', ld], text: 'cookie banner' });
  assert.equal(job.source, 'structured');
  assert.equal(job.company, 'Contoso');
  assert.equal(job.role, 'Senior Site Reliability Engineer');
  assert.equal(job.description, 'Location: Seattle\n\nRun Kubernetes at scale.\n- Go\n- On-call & incidents');
});

test('titles and applicant-tracking URLs give role and company', () => {
  assert.deepEqual(J.splitTitle('Contoso hiring Data Engineer in London | LinkedIn'), { role: 'Data Engineer', company: 'Contoso' });
  assert.deepEqual(J.splitTitle('Job Application for Backend Engineer at Northwind'), { role: 'Backend Engineer', company: 'Northwind' });
  assert.deepEqual(J.splitTitle('Staff Engineer at Fabrikam - Careers'), { role: 'Staff Engineer', company: 'Fabrikam' });
  assert.deepEqual(J.splitTitle('Fabrikam - Product Manager', 'Fabrikam'), { role: 'Product Manager', company: 'Fabrikam' });
  assert.equal(J.companyFromUrl('https://jobs.lever.co/acme-robotics/123'), 'Acme Robotics');
  assert.equal(J.companyFromUrl('https://boards.greenhouse.io/embed/job_app?for=northwind&token=1'), 'Northwind');
  assert.equal(J.companyFromUrl('https://contoso.wd5.myworkdayjobs.com/en-US/External/job/1'), 'Contoso');
  const lever = J.parseJobPage({ url: 'https://jobs.lever.co/acme-robotics/123', title: 'Acme Robotics - Controls Engineer', h1: '', text: 'We build robots.' });
  assert.deepEqual([lever.company, lever.role, lever.description, lever.source], ['Acme Robotics', 'Controls Engineer', 'We build robots.', 'page']);
});

test('a selection becomes the description; short selections are ignored', () => {
  const sel = 'About the role\nYou will design and run our payments platform with a small team.';
  assert.equal(J.parseJobPage({ url: 'https://x.example/j', title: 'Engineer at X', selection: sel, text: 'whole page' }).source, 'selection');
  assert.equal(J.parseJobPage({ url: 'https://x.example/j', title: 'Engineer at X', selection: 'Engineer', text: 'whole page' }).description, 'whole page');
});

test('imports are validated and normalised', () => {
  assert.equal(J.cleanImport(null).ok, false);
  assert.equal(J.cleanImport({ url: 'https://a.example' }).ok, false, 'needs some content');
  assert.match(J.cleanImport({ role: 'SRE', url: 'javascript:alert(1)' }).error, /http or https/);
  assert.match(J.cleanImport({ role: 'SRE', url: 'file:///C:/secret.txt' }).error, /http or https/);
  const r = J.cleanImport({ company: ' Contoso\u0000 ', role: 'S'.repeat(500), description: 'a\r\n\r\n\r\n\r\nb', url: 'https://jobs.example/1#apply', extra: 'dropped' });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.job), ['company', 'role', 'description', 'url']);
  assert.equal(r.job.company, 'Contoso');
  assert.equal(r.job.role.length, 200);
  assert.equal(r.job.description, 'a\n\nb');
  assert.equal(r.job.url, 'https://jobs.example/1');
});

test('the extension ships the same parser as packages/core', () => {
  assert.equal(fs.readFileSync(path.join(ROOT, 'extension', 'lib', 'jobpost.js'), 'utf8'), fs.readFileSync(path.join(ROOT, 'packages', 'core', 'jobpost.js'), 'utf8'), 'run node scripts/build-extension.js');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  // Least privilege: pages are read or filled only on a click (or the fill shortcut), never in the background.
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'nativeMessaging', 'scripting', 'storage']);
  assert.equal(manifest.host_permissions, undefined, 'no required host permissions');
  assert.equal(manifest.content_scripts, undefined, 'no always-on content scripts');
  assert.equal(manifest.optional_permissions, undefined);
  // Optional host access only for application systems whose forms are embedded in other sites' pages, asked for per site.
  const bg = fs.readFileSync(path.join(ROOT, 'extension', 'background.js'), 'utf8');
  const jobSites = bg.match(/const JOB_SITES = \[([\s\S]*?)\]/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  assert.deepEqual(manifest.optional_host_permissions, jobSites);
  assert.ok(jobSites.length > 10 && jobSites.every((p) => /^https:\/\/\*\.[a-z.]+\/(hcmUI\/)?\*$/.test(p)), 'only https job-site patterns');
  assert.ok(jobSites.includes('https://*.greenhouse.io/*') && jobSites.includes('https://*.lever.co/*'));
  assert.deepEqual(manifest.commands, { 'fill-page': { suggested_key: { default: 'Alt+Shift+F' }, description: manifest.commands['fill-page'].description } });
  assert.equal(manifest.version, '1.1.0');
  // The key in the manifest fixes the extension ID the host allows; it must never change.
  const der = Buffer.from(manifest.key, 'base64');
  const id = require('crypto').createHash('sha256').update(der).digest('hex').slice(0, 32).replace(/./g, (h) => String.fromCharCode(97 + parseInt(h, 16)));
  assert.equal(id, 'ggejchpcmgenioaphbobmdgohgcjlfop');
  assert.deepEqual(ids.EXTENSION_IDS, [id]);
  // Autofill never talks to the app: only the popup's Add to Jobs uses native messaging.
  for (const f of ['background.js', 'options/options.js', ...fs.readdirSync(path.join(ROOT, 'extension', 'content')).map((n) => `content/${n}`)]) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'extension', f), 'utf8'), /sendNativeMessage|connectNative/, f);
  }
});

// Talks to the host exactly as Chrome does: length-prefixed JSON on stdio.
function runHost(argv, messages) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'bridge', 'host.js'), ...argv], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = Buffer.alloc(0);
    child.stdout.on('data', (c) => (out = Buffer.concat([out, c])));
    child.on('close', (code) => {
      const replies = [];
      while (out.length >= 4) {
        const len = out.readUInt32LE(0);
        replies.push(JSON.parse(out.subarray(4, 4 + len).toString('utf8')));
        out = out.subarray(4 + len);
      }
      resolve({ code, replies });
    });
    for (const m of messages) {
      const body = Buffer.isBuffer(m) ? m : Buffer.from(JSON.stringify(m));
      const head = Buffer.alloc(4);
      head.writeUInt32LE(m.fakeLength || body.length, 0);
      child.stdin.write(Buffer.concat([head, body]));
    }
    child.stdin.end();
  });
}

test('native host: ping, import to the inbox, and rejections', { timeout: 30000 }, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ih-host-'));
  const origin = ids.ALLOWED_ORIGINS[0];
  try {
    const ok = await runHost(['--data', data, origin, '--parent-window=0'], [{ type: 'ping' }, { type: 'importJob', job: { company: 'Contoso', role: 'SRE', description: 'Run things', url: 'https://jobs.example/1' } }, { type: 'importJob', job: { role: 'x', url: 'ftp://a' } }, { type: 'readFiles' }]);
    assert.equal(ok.code, 0);
    assert.deepEqual(ok.replies[0], { ok: true, app: 'Interview Helper', version: require('../../package.json').version });
    assert.deepEqual(ok.replies[1], { ok: true });
    assert.equal(ok.replies[2].ok, false);
    assert.deepEqual(ok.replies[3], { ok: false, error: 'Unknown message.' });
    const files = fs.readdirSync(path.join(data, 'inbox'));
    assert.equal(files.length, 1);
    assert.match(files[0], /^\d+-[a-z0-9]+\.json$/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'inbox', files[0]), 'utf8')).job.company, 'Contoso');

    const stranger = await runHost(['--data', data, 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/'], [{ type: 'ping' }]);
    assert.equal(stranger.code, 1);
    assert.match(stranger.replies[0].error, /not allowed/);

    const noData = await runHost([origin], [{ type: 'ping' }]);
    assert.equal(noData.code, 1);

    const huge = Buffer.from('{}');
    huge.fakeLength = 5 * 1024 * 1024;
    const big = await runHost(['--data', data, origin], [huge]);
    assert.equal(big.code, 1);
    assert.match(big.replies[0].error, /too large/);
    assert.equal(fs.readdirSync(path.join(data, 'inbox')).length, 1, 'nothing else written');
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('launcher and manifest quoting', () => {
  const { hostFiles } = require('../../src/bridge/index.js');
  const win = hostFiles({ platform: 'win32', execPath: 'C:\\Program Files\\Interview Helper\\Interview Helper.exe', script: 'C:\\x\\app.asar\\src\\bridge\\host.js', dataDir: 'C:\\Users\\a & b\\100%', launcherPath: 'C:\\d\\host.bat' });
  assert.equal(win.launcher, '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"C:\\Program Files\\Interview Helper\\Interview Helper.exe" "C:\\x\\app.asar\\src\\bridge\\host.js" --data "C:\\Users\\a & b\\100%%" %*\r\n');
  assert.deepEqual(win.manifest, { name: 'com.interviewhelper.bridge', description: win.manifest.description, path: 'C:\\d\\host.bat', type: 'stdio', allowed_origins: ids.ALLOWED_ORIGINS });
  const mac = hostFiles({ platform: 'darwin', execPath: "/Applications/Interview Helper.app/Contents/MacOS/Interview Helper", script: '/x/host.js', dataDir: "/Users/o'neil/Library/Application Support/Interview Helper", launcherPath: '/d/host.sh' });
  assert.match(mac.launcher, /^#!\/bin\/sh\nELECTRON_RUN_AS_NODE=1 exec '\/Applications\/Interview Helper\.app\/Contents\/MacOS\/Interview Helper' '\/x\/host\.js' --data '\/Users\/o'\\''neil\/Library\/Application Support\/Interview Helper' "\$@"\n$/);
});

test('browsers are registered under their real registry keys (with a backslash)', () => {
  const ids = require('../../src/bridge/ids');
  const BS = String.fromCharCode(92); // a backslash, spelled out so it can't be lost again
  assert.deepEqual(ids.BROWSERS.map((b) => b.win), [`Google${BS}Chrome`, `Microsoft${BS}Edge`, `BraveSoftware${BS}Brave-Browser`, 'Chromium']);
  for (const b of ids.BROWSERS) assert.ok(!ids.LEGACY_WIN_KEYS.includes(b.win), `${b.win} is not a legacy key`);
  // The uninstaller removes the same keys the app writes.
  const nsh = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'build', 'installer.nsh'), 'utf8');
  const key = (k) => ['Software', k, 'NativeMessagingHosts', ids.HOST_NAME].join(BS);
  for (const b of ids.BROWSERS) assert.ok(nsh.includes(key(b.win)), `uninstaller removes ${b.win}`);
  for (const k of ids.LEGACY_WIN_KEYS) assert.ok(nsh.includes(key(k)), `uninstaller cleans ${k}`);
});
