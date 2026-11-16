/* global require, monaco, marked, DOMPurify */
// Coding Lab: Monaco editor, sandboxed runners (Python/JS/SQL workers), test
// results, and AI hints/review/error explanations.
const $ = (sel) => document.querySelector(sel);
const BASE = 'app://local/';
const LANG_LABEL = { python: 'Python', javascript: 'JavaScript', sql: 'SQL' };
const MONACO_LANG = { python: 'python', javascript: 'javascript', sql: 'sql' };
const TIME_LIMIT = { python: 5000, javascript: 5000, sql: 3000 };

const lab = { challenges: [], problem: null, language: 'python', editor: null, hints: 0, lastResult: null, busy: false };

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function md(el, text) {
  el.innerHTML = DOMPurify.sanitize(marked.parse(text || ''));
}
const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

// ---------- sandboxed runners ----------

class WorkerRunner {
  constructor(url, { module = false } = {}) {
    this.url = url;
    this.module = module;
    this.worker = null;
    this.ready = null;
    this.seq = 0;
    this.loadMs = null;
  }

  start() {
    if (this.worker) return this.ready;
    this.worker = new Worker(this.url, this.module ? { type: 'module' } : undefined);
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = ({ data }) => {
        if (data.type === 'ready') {
          this.loadMs = data.ms;
          resolve();
        } else if (data.type === 'fatal') {
          reject(new Error(data.error));
        } else {
          this.pending.get(data.id)?.(data);
          this.pending.delete(data.id);
        }
      };
      this.worker.onerror = (e) => reject(new Error(e.message || 'The code runner failed to start.'));
    });
    return this.ready;
  }

  stop() {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
  }

  // Resolves with the runner's reply, or a time-limit error (the worker is
  // terminated and restarted on the next run, so infinite loops can't hang).
  async run(payload, timeoutMs) {
    await this.start();
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.stop();
        resolve({ error: `Time limit exceeded (${timeoutMs / 1000} s). Look for an infinite loop or a slower-than-needed algorithm.`, timeout: true });
      }, timeoutMs);
      this.pending.set(id, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
      this.worker.postMessage({ type: 'run', id, ...payload });
    });
  }
}

const runners = {
  python: new WorkerRunner(`${BASE}src/renderer/runners/python-runner.mjs`, { module: true }),
  javascript: new WorkerRunner(`${BASE}src/renderer/runners/js-runner.js`),
  sql: new WorkerRunner(`${BASE}src/renderer/runners/sql-runner.js`),
};
window.labRunners = runners; // for tests and benchmarks

// Start loading the runtime for the chosen language in the background.
function warm(language) {
  const r = runners[language];
  if (r.worker) {
    r.ready.then(() => status(`${LANG_LABEL[language]} ready`)).catch((err) => status(err.message));
    return;
  }
  status(language === 'python' ? 'Loading Python…' : '');
  const t = performance.now();
  r.start()
    .then(() => status(`${LANG_LABEL[language]} ready (${Math.round(performance.now() - t)} ms)`))
    .catch((err) => status(err.message));
}

function status(text) {
  $('#engineStatus').textContent = text;
}

// ---------- problem & editor ----------

function codeKey() {
  return `lab:${lab.problem.id}:${lab.language}`;
}

function showProblem() {
  const p = lab.problem;
  $('#difficulty').textContent = p.difficulty[0].toUpperCase() + p.difficulty.slice(1);
  $('#difficulty').className = `chip ${p.difficulty}`;
  const examples = p.tests
    .filter((t) => !t.hidden)
    .map((t) =>
      p.languages.includes('sql')
        ? `**Expected rows:** \`${JSON.stringify(t.expected)}\``
        : `- \`${p.fn[lab.language] || p.fn.python}(${t.args.map((a) => JSON.stringify(a)).join(', ')})\` → \`${JSON.stringify(t.expected)}\``,
    )
    .join('\n');
  const hidden = p.tests.filter((t) => t.hidden).length;
  md($('#problemText'), `## ${p.title}\n\n*${p.topic}*\n\n${p.prompt}\n\n### Examples\n${examples}\n\n<p class="hint">Submit also runs ${hidden} hidden test${hidden === 1 ? '' : 's'}.</p>`);
  const langSel = $('#language');
  langSel.innerHTML = p.languages.map((l) => `<option value="${l}">${LANG_LABEL[l]}</option>`).join('');
  if (!p.languages.includes(lab.language)) lab.language = p.languages[0];
  langSel.value = lab.language;
  loadCode();
  lab.hints = 0;
  lab.lastResult = null;
  $('#assist').hidden = true;
  $('#results').innerHTML = '<p class="hint">Run your code to see the results. Code runs on this PC in a sandbox with no network access and a time limit.</p>';
  warm(lab.language);
}

function loadCode() {
  const code = store.get(codeKey()) ?? lab.problem.starter[lab.language];
  const model = lab.editor.getModel();
  monaco.editor.setModelLanguage(model, MONACO_LANG[lab.language]);
  lab.editor.setValue(code);
}

function selectProblem(id) {
  lab.problem = lab.challenges.find((c) => c.id === id) || lab.challenges[0];
  $('#problem').value = lab.problem.id;
  store.set('lab:last', lab.problem.id);
  showProblem();
}

// ---------- running ----------

async function run(submit) {
  if (lab.busy) return;
  lab.busy = true;
  setButtons(false);
  const p = lab.problem;
  const tests = submit ? p.tests : p.tests.filter((t) => !t.hidden);
  const code = lab.editor.getValue();
  store.set(codeKey(), code);
  $('#results').innerHTML = `<p class="hint">${lab.language === 'python' && !runners.python.worker ? 'Loading Python (first run takes a few seconds)…' : 'Running…'}</p>`;
  const t0 = performance.now();
  const payload =
    lab.language === 'sql'
      ? { code, tests, ordered: p.ordered }
      : { code, tests, fn: p.fn[lab.language], mode: p.compare };
  let res;
  try {
    res = await runners[lab.language].run(payload, TIME_LIMIT[lab.language]); // loading isn't counted; execution is
  } catch (err) {
    res = { error: err.message };
  }
  res.wallMs = Math.round(performance.now() - t0);
  res.tests = tests;
  lab.lastResult = res;
  renderResults(res, submit);
  const passed = (res.results || []).filter((r) => r.ok).length;
  window.api.saveAttempt({ problemId: p.id, difficulty: p.difficulty, language: lab.language, submitted: submit, passed, total: tests.length, hints: lab.hints, ms: res.ms || 0 });
  lab.busy = false;
  setButtons(true);
  return res;
}

function fmtValue(v) {
  return escapeHtml(JSON.stringify(v));
}

function renderResults(res, submit) {
  const box = $('#results');
  const tests = res.tests;
  if (res.error) {
    box.innerHTML = `<div class="summary fail">Error <button class="btn small" data-act="explain">Explain the error</button></div><pre>${escapeHtml(res.error)}</pre>${res.output ? `<div class="label">Output</div><pre>${escapeHtml(res.output)}</pre>` : ''}`;
  } else {
    const passed = res.results.filter((r) => r.ok).length;
    const all = passed === tests.length;
    const rows = res.results
      .map((r, i) => {
        const t = tests[i];
        const label = t.hidden ? 'Hidden test' : lab.language === 'sql' ? 'Rows' : `${lab.problem.fn[lab.language]}(${t.args.map((a) => JSON.stringify(a)).join(', ')})`;
        const detail = r.error
          ? `<pre>${escapeHtml(r.error)}</pre>`
          : t.hidden
            ? ''
            : r.ok
              ? `<code>${fmtValue(r.got)}</code>`
              : `<div>got <code>${fmtValue(r.got)}</code></div><div>expected <code>${fmtValue(t.expected)}</code></div>`;
        return `<div class="test-row ${r.ok ? 'pass' : 'fail'}"><span class="status">${r.ok ? '✓ Passed' : '✗ Failed'}</span><div><code>${escapeHtml(label)}</code>${detail}</div><span class="ms">${r.ms != null ? `${r.ms.toFixed(1)} ms` : ''}</span></div>`;
      })
      .join('');
    box.innerHTML = `<div class="summary ${all ? 'pass' : 'fail'}">${passed}/${tests.length} tests passed${submit ? ' (including hidden)' : ''}${all ? '' : ' <button class="btn small" data-act="explain">Explain the failure</button>'}${all && submit ? ' <button class="btn small" data-act="review">Review my solution</button>' : ''}</div>${rows}${res.output ? `<div class="label">Output</div><pre>${escapeHtml(res.output)}</pre>` : ''}`;
  }
  box.querySelector('[data-act="explain"]')?.addEventListener('click', () => assist('explain'));
  box.querySelector('[data-act="review"]')?.addEventListener('click', () => assist('review'));
}

function setButtons(enabled) {
  for (const id of ['#runBtn', '#submitBtn']) $(id).disabled = !enabled;
}

// ---------- AI coach ----------

const tasks = new Map();
window.api.onChunk(({ id, text }) => tasks.get(id)?.onText(text));
window.api.onDone((payload) => {
  const t = tasks.get(payload.id);
  if (!t) return;
  tasks.delete(payload.id);
  t.onDone(payload);
});

function resultsForAi() {
  const r = lab.lastResult;
  if (!r) return null;
  if (r.error) return { error: r.error };
  return { results: r.results.map((x, i) => ({ ok: x.ok, error: x.error, got: x.got, expected: r.tests[i].expected, hidden: r.tests[i].hidden })) };
}

function assist(mode) {
  if (mode === 'hint') lab.hints = Math.min(3, lab.hints + 1);
  const box = $('#assist');
  box.hidden = false;
  const title = { hint: `Hint ${lab.hints} of 3`, review: 'Review', explain: 'What went wrong' }[mode];
  box.innerHTML = `<div class="label">${title}</div><div class="body"><span class="muted">Thinking…</span></div>`;
  const body = box.querySelector('.body');
  let text = '';
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  tasks.set(id, {
    onText: (t) => {
      text += t;
      md(body, text);
    },
    onDone: (res) => {
      if (res.error) body.innerHTML = `<p>${escapeHtml(res.error)}</p>`;
      else md(body, text);
      $('#hintBtn').disabled = lab.hints >= 3;
    },
  });
  window.api
    .codeAssist({ id, mode, problemId: lab.problem.id, language: lab.language, code: lab.editor.getValue(), results: resultsForAi(), hintLevel: lab.hints })
    .catch((err) => {
      tasks.delete(id);
      body.innerHTML = `<p>${escapeHtml(err.message)}</p>`;
    });
}

// ---------- boot ----------

function applyTheme(theme) {
  document.documentElement.dataset.theme = ['light', 'dark'].includes(theme) ? theme : 'system';
  const dark = theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  monaco.editor.setTheme(dark ? 'vs-dark' : 'vs');
}

(async function init() {
  const [challenges, config] = await Promise.all([window.api.labChallenges(), window.api.getConfig()]);
  lab.challenges = challenges;
  self.MonacoEnvironment = { getWorkerUrl: () => `${BASE}node_modules/monaco-editor/min/vs/base/worker/workerMain.js` };
  require.config({ paths: { vs: `${BASE}node_modules/monaco-editor/min/vs` } });
  await new Promise((resolve) => require(['vs/editor/editor.main'], resolve));
  lab.editor = monaco.editor.create($('#editor'), {
    value: '',
    language: 'python',
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    fontFamily: "Consolas, 'Cascadia Code', monospace",
    scrollBeyondLastLine: false,
    tabSize: 4,
  });
  applyTheme(config.theme);
  lab.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => run(false));
  lab.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => run(true));
  lab.editor.onDidChangeModelContent(() => store.set(codeKey(), lab.editor.getValue()));

  const groups = [
    ['Algorithms', challenges.filter((c) => !c.languages.includes('sql'))],
    ['SQL', challenges.filter((c) => c.languages.includes('sql'))],
  ];
  $('#problem').innerHTML = groups
    .map(([label, list]) => `<optgroup label="${label}">${list.map((c) => `<option value="${c.id}">${escapeHtml(c.title)} · ${c.difficulty}</option>`).join('')}</optgroup>`)
    .join('');
  $('#problem').onchange = (e) => selectProblem(e.target.value);
  $('#language').onchange = (e) => {
    lab.language = e.target.value;
    store.set('lab:lang', lab.language);
    loadCode();
    showProblem();
  };
  $('#runBtn').onclick = () => run(false);
  $('#submitBtn').onclick = () => run(true);
  $('#hintBtn').onclick = () => assist('hint');
  $('#reviewBtn').onclick = () => assist('review');
  $('#resetBtn').onclick = () => {
    if (!confirm('Replace your code with the starter code?')) return;
    lab.editor.setValue(lab.problem.starter[lab.language]);
  };
  lab.language = store.get('lab:lang') || 'python';
  selectProblem(store.get('lab:last') || challenges[0].id);
  window.labReady = true;
})().catch((err) => {
  document.body.insertAdjacentHTML('afterbegin', `<div class="banner error">Coding Lab failed to start: ${escapeHtml(err.message)}</div>`);
});
