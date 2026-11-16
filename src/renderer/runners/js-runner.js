// JavaScript sandbox (Web Worker): no DOM, no Node, no network (CSP, see
// src/lab.js). The host terminates the worker when a run exceeds its limit.
importScripts('../../../packages/core/judge.js');

const MAX_LOG = 20000;

function fmt(v) {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

self.postMessage({ type: 'ready', ms: 0 });

self.onmessage = ({ data }) => {
  if (data.type !== 'run') return;
  const logs = [];
  let size = 0;
  const log = (...args) => {
    const line = args.map(fmt).join(' ');
    size += line.length;
    if (size <= MAX_LOG) logs.push(line);
  };
  const sandboxConsole = { log, info: log, warn: log, error: log, debug: log };
  const t0 = performance.now();
  if (!self.CoreJudge.validIdentifier(data.fn)) {
    self.postMessage({ id: data.id, error: 'Invalid function name.' });
    return;
  }
  let fn;
  try {
    // The user's code runs in its own function scope with a private console.
    fn = new Function('console', `"use strict";\n${data.code}\n;return typeof ${data.fn} === 'function' ? ${data.fn} : undefined;`)(sandboxConsole);
  } catch (err) {
    self.postMessage({ id: data.id, error: `${err.name}: ${err.message}`, output: logs.join('\n') });
    return;
  }
  if (!fn) {
    self.postMessage({ id: data.id, error: `Function ${data.fn}() is not defined. Keep the function name from the starter code.`, output: logs.join('\n') });
    return;
  }
  const results = data.tests.map((t) => {
    const s = performance.now();
    try {
      const got = fn(...structuredClone(t.args));
      const ms = performance.now() - s;
      return { ok: self.CoreJudge.equal(got, t.expected, data.mode), got: self.CoreJudge.normalize(got), ms };
    } catch (err) {
      return { ok: false, error: err && err.stack ? String(err.stack).split('\n').slice(0, 3).join('\n') : String(err) };
    }
  });
  self.postMessage({ id: data.id, results, output: logs.join('\n'), ms: Math.round(performance.now() - t0) });
};
