// Python sandbox (module Web Worker): Pyodide (CPython compiled to WASM).
// Served with a CSP that allows no network access (see src/lab.js); the host
// page terminates this worker when a run exceeds its time limit.
import { loadPyodide } from '../../../node_modules/pyodide/pyodide.mjs';
import '../../../packages/core/pyharness.js';

const MAX_OUTPUT = 20000;
const started = performance.now();
const ready = loadPyodide({ indexURL: new URL('../../../node_modules/pyodide/', import.meta.url).href }).then((py) => {
  self.postMessage({ type: 'ready', ms: Math.round(performance.now() - started) });
  return py;
});
ready.catch((err) => self.postMessage({ type: 'fatal', error: `Python failed to load: ${err.message}` }));

self.onmessage = async ({ data }) => {
  if (data.type !== 'run') return;
  const py = await ready;
  const out = [];
  let size = 0;
  const collect = (s) => {
    if (size > MAX_OUTPUT) return;
    size += s.length;
    out.push(size > MAX_OUTPUT ? `${s.slice(0, 200)}\n… output truncated` : s);
  };
  py.setStdout({ batched: collect });
  py.setStderr({ batched: collect });
  const ns = py.globals.get('dict')();
  const t0 = performance.now();
  try {
    py.runPython(data.code, { globals: ns });
    ns.set('_FN', data.fn);
    ns.set('_TESTS', JSON.stringify(data.tests));
    ns.set('_MODE', data.mode || 'exact');
    const results = JSON.parse(py.runPython(self.CorePyHarness.HARNESS, { globals: ns }));
    self.postMessage({ id: data.id, results, output: out.join('\n'), ms: Math.round(performance.now() - t0) });
  } catch (err) {
    // Python exceptions arrive as PythonError with the traceback in .message.
    const msg = String(err.message || err).replace(/^Traceback[\s\S]*?File "<exec>"/m, 'File "<your code>"');
    self.postMessage({ id: data.id, error: msg, output: out.join('\n'), ms: Math.round(performance.now() - t0) });
  } finally {
    ns.destroy();
  }
};
