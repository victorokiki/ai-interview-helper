// End-to-end test of the Coding Lab: the real lab window, real Pyodide,
// sql.js and the JS sandbox, time limits, network isolation, the app://
// allow-list, AI hints/review (fake local provider) and Progress stats.
const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, 'out', 'codelab');
fs.rmSync(out, { recursive: true, force: true });
const userData = path.join(out, 'userdata');
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);

// The app:// scheme must be registered before the app is ready, so main.js
// is required synchronously; the fake provider gets a fixed port.
const PORT = 47000 + Math.floor(Math.random() * 2000);
const requests = [];
http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = JSON.parse(body || '{}');
      if (!json.messages?.length) return res.end('{"done":true}');
      requests.push(json.messages.find((m) => m.role === 'user')?.content || '');
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { content: 'Think about a hash map from value to index.' }, done: false }) + '\n');
      res.end(JSON.stringify({ done: true }) + '\n');
    });
  })
  .listen(PORT);
fs.writeFileSync(
  path.join(userData, 'config.json'),
  JSON.stringify({ provider: 'ollama', ollamaUrl: `http://127.0.0.1:${PORT}`, ollamaModel: 'fake', transcription: 'local', jobsMigrated: true, liveNoticeAck: true, meetingDetection: false }),
);
require(path.join(__dirname, '..', '..', 'src', 'main.js'));

const logs = [];
const check = (name, ok, extra = '') => {
  logs.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  fs.writeFileSync(path.join(out, 'log.txt'), logs.join(String.fromCharCode(10)));
};
const metrics = {};

let mainWin = null;
app.on('browser-window-created', (_e, win) => {
  if (mainWin) {
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error') logs.push(`[lab console error] ${e.message} (${e.sourceId}:${e.lineNumber})`);
    });
    return;
  }
  mainWin = win;
  win.webContents.once('did-finish-load', () => runTests(win).catch((err) => logs.push('[e2e-error] ' + err.stack)).finally(finish));
});

function finish() {
  fs.writeFileSync(path.join(out, 'log.txt'), logs.join(String.fromCharCode(10)));
  fs.writeFileSync(path.join(out, 'metrics.json'), JSON.stringify(metrics, null, 2));
  app.exit(0);
}

async function runTests(win) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  await wait(1000);

  check('Mock tab has an Open Coding Lab button', await js(`!!document.querySelector('#openLab')`));
  const t0 = Date.now();
  await js(`document.querySelector('#openLab').click(); 0`);
  let labWin = null;
  for (let i = 0; i < 100 && !labWin; i++) {
    labWin = BrowserWindow.getAllWindows().find((w) => w !== win);
    await wait(50);
  }
  check('lab opens in its own window', !!labWin);
  const lab = (code) => labWin.webContents.executeJavaScript(code);
  for (let i = 0; i < 200 && !(await lab('window.labReady === true').catch(() => false)); i++) await wait(100);
  metrics.labOpenMs = Date.now() - t0;
  check('Monaco editor and 14 problems load', await lab(`typeof monaco.editor.create === 'function' && document.querySelectorAll('#problem option').length === 14`), `${metrics.labOpenMs} ms to ready`);

  const pick = (id, lang) => lab(`selectProblem('${id}'); document.querySelector('#language').value = '${lang}'; document.querySelector('#language').dispatchEvent(new Event('change')); 0`);
  const setCode = (code) => lab(`lab.editor.setValue(${JSON.stringify(code)}); 0`);
  const runIt = async (submit) => {
    const t = Date.now();
    const r = await lab(`run(${submit}).then((r) => ({ error: r.error || null, passed: (r.results || []).filter((x) => x.ok).length, total: r.tests.length, timeout: !!r.timeout, results: r.results || null, output: r.output || '' }))`);
    r.wall = Date.now() - t;
    return r;
  };
  const resultsText = () => lab(`document.querySelector('#results').innerText`);

  // Python: correct, wrong, exception, infinite loop
  await pick('two-sum', 'python');
  await setCode('def two_sum(nums, target):\n    seen = {}\n    for i, n in enumerate(nums):\n        if target - n in seen:\n            return [seen[target - n], i]\n        seen[n] = i\n');
  const py1 = await runIt(true);
  metrics.pythonFirstRunMs = py1.wall;
  metrics.pythonLoadMs = await lab('window.labRunners.python.loadMs');
  check('Python: correct solution passes all tests including hidden', !py1.error && py1.passed === 4 && py1.total === 4, JSON.stringify(py1).slice(0, 200));
  const py1b = await runIt(true);
  metrics.pythonWarmRunMs = py1b.wall;
  await setCode('def two_sum(nums, target):\n    print("debug", nums)\n    return [0, 0]\n');
  const py2 = await runIt(true);
  const txt2 = await resultsText();
  check('Python: wrong answer shows got/expected for visible tests, captured print output', py2.passed === 0 && /got\s*\[0,0\]/.test(txt2.replace(/\s/g, ' ').replace(/ /g, '')) && py2.output.includes('debug [2, 7, 11, 15]'), txt2.slice(0, 200));
  check('Python: hidden tests reveal pass/fail only', (await lab(`[...document.querySelectorAll('.test-row')].filter((r) => r.innerText.includes('Hidden test')).every((r) => !r.innerText.includes('expected'))`)));
  await setCode('def two_sum(nums, target):\n    return nums[99]\n');
  const py3 = await runIt(false);
  check('Python: exceptions show the traceback line', py3.results?.[0]?.error?.includes('IndexError'), JSON.stringify(py3.results?.[0]).slice(0, 200));
  await setCode('def two_sum(nums, target):\n    while True:\n        pass\n');
  const py4 = await runIt(false);
  check('Python: infinite loop stopped by the 5 s time limit', py4.timeout && py4.wall < 7000, `${py4.wall} ms`);
  await setCode('def two_sum(nums, target):\n    return [0, 1]\n');
  const py5 = await runIt(false);
  check('Python: runner restarts after a timeout', !py5.error && py5.passed === 1, `${py5.wall} ms (includes reload)`);
  metrics.pythonReloadAfterTimeoutMs = py5.wall;

  // Network isolation (Python via Pyodide's JS bridge, JS via synchronous XHR)
  await setCode('def two_sum(nums, target):\n    try:\n        from js import XMLHttpRequest\n        x = XMLHttpRequest.new()\n        x.open("GET", "https://example.com/", False)\n        x.send()\n        return "network-open"\n    except Exception as e:\n        return "blocked"\n');
  const pyNet = await runIt(false);
  check('Python code cannot reach the network', pyNet.results?.[0]?.got === 'blocked', JSON.stringify(pyNet.results?.[0]));

  // JavaScript
  await pick('group-anagrams', 'javascript');
  await setCode('function groupAnagrams(strs) {\n  const m = new Map();\n  for (const s of strs) {\n    const k = [...s].sort().join("");\n    m.set(k, [...(m.get(k) || []), s]);\n  }\n  return [...m.values()];\n}\n');
  const js1 = await runIt(true);
  check('JavaScript: correct solution passes (order-insensitive judging)', !js1.error && js1.passed === js1.total && js1.total === 4, JSON.stringify(js1).slice(0, 200));
  await setCode('function groupAnagrams(strs) {\n  try {\n    const x = new XMLHttpRequest();\n    x.open("GET", "https://example.com/", false);\n    x.send();\n    return "network-open";\n  } catch (e) {\n    return "blocked";\n  }\n}\n');
  const jsNet = await runIt(false);
  check('JavaScript code cannot reach the network', jsNet.results?.[0]?.got === 'blocked', JSON.stringify(jsNet.results?.[0]));
  await setCode('function groupAnagrams(strs) { while (true) {} }\n');
  const js2 = await runIt(false);
  check('JavaScript: infinite loop stopped by the time limit', js2.timeout && js2.wall < 7000, `${js2.wall} ms`);
  await setCode('function wrongName(strs) { return []; }\n');
  const js3 = await runIt(false);
  check('JavaScript: a renamed function gives a clear error', /groupAnagrams\(\) is not defined/.test(js3.error || ''), js3.error);

  // SQL
  await pick('running-total', 'sql');
  await setCode('SELECT day, SUM(amount) OVER (ORDER BY day) AS running_total FROM sales ORDER BY day;');
  const sq1 = await runIt(true);
  metrics.sqlRunMs = sq1.wall;
  check('SQL: window-function solution passes all tests', !sq1.error && sq1.passed === 2, JSON.stringify(sq1).slice(0, 200));
  await setCode('SELECT day, amount FROM sales;');
  const sq2 = await runIt(false);
  check('SQL: wrong rows fail', sq2.passed === 0);
  await setCode('SELEC nonsense;');
  const sq3 = await runIt(false);
  check('SQL: syntax errors are reported', /syntax error/i.test(sq3.results?.[0]?.error || ''), JSON.stringify(sq3.results?.[0]));

  // app:// allow-list and runner CSP
  const fetched = await lab(`Promise.all(['app://local/package.json', 'app://local/src/main.js', 'app://local/src/renderer/runners/js-runner.js'].map((u) => fetch(u).then((r) => [r.status, r.headers.get('content-security-policy')])))`);
  check('app:// serves only allow-listed files', fetched[0][0] === 404 && fetched[1][0] === 404 && fetched[2][0] === 200, JSON.stringify(fetched.map((f) => f[0])));
  check('runner scripts carry a no-network CSP', /connect-src 'self'/.test(fetched[2][1]) && /default-src 'self'/.test(fetched[2][1]));

  // AI coach
  await pick('two-sum', 'python');
  await lab(`document.querySelector('#hintBtn').click(); 0`);
  for (let i = 0; i < 60 && !requests.length; i++) await wait(50);
  await wait(200);
  check('Hint asks for level 1 without the full solution', requests[0]?.includes('Give hint 1 of 3') && requests[0].includes('Never write the full solution in python'), requests[0]?.slice(-300));
  check('hint text appears in the lab', (await lab(`document.querySelector('#assist').innerText`)).includes('hash map'));
  await lab(`document.querySelector('#reviewBtn').click(); 0`);
  for (let i = 0; i < 60 && requests.length < 2; i++) await wait(50);
  check('Review asks for correctness and a Big-O line', requests[1]?.includes('Time: O(...), Space: O(...)') && requests[1].includes('### Correctness'));
  fs.writeFileSync(path.join(out, 'lab.png'), (await labWin.webContents.capturePage()).toPNG());

  // Progress card in the main window
  const attempts = await js('window.api.labAttempts()');
  check('runs and submissions are recorded', attempts.filter((a) => a.submitted).length >= 4 && attempts.some((a) => a.problemId === 'running-total' && a.submitted && a.passed === 2));
  await js(`document.querySelector('.tab[data-tab="history"]').click(); 0`);
  for (let i = 0; i < 40 && !(await js(`!!document.querySelector('#codingCard')`)); i++) await wait(100);
  const card = await js(`document.querySelector('#codingCard')?.innerText || ''`);
  check('Progress shows Coding Lab stats', /3\/14 solved/i.test(card) && /submissions/i.test(card), card.replace(/\n/g, ' | '));
  fs.writeFileSync(path.join(out, 'progress.png'), (await win.webContents.capturePage()).toPNG());

  const procs = app.getAppMetrics();
  metrics.memoryWithLabMB = Math.round(procs.reduce((n, m) => n + m.memory.workingSetSize, 0) / 1024);
  labWin.close();
  await wait(1500);
  metrics.memoryAfterLabClosedMB = Math.round(app.getAppMetrics().reduce((n, m) => n + m.memory.workingSetSize, 0) / 1024);
}
