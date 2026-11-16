// Python test harness for the Coding Lab, run inside Pyodide after the
// user's code. Expects globals _FN (function name), _TESTS (JSON) and _MODE
// (compare mode, same meanings as judge.js). Returns a JSON string of
// [{ok, got, ms} | {ok:false, error}]. Shared by the Python runner and tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CorePyHarness = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const HARNESS = String.raw`
import json, time, traceback

def _norm(v):
    if isinstance(v, (set, frozenset, tuple)):
        v = list(v)
    if isinstance(v, list):
        return [_norm(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _norm(x) for k, x in sorted(v.items(), key=lambda kv: str(kv[0]))}
    if v is None or isinstance(v, (bool, str)):
        return v
    if isinstance(v, float):
        r = round(v, 6)
        return int(r) if r == int(r) else r
    if isinstance(v, int):
        return v
    return repr(v)

def _key(v):
    return json.dumps(v, sort_keys=True)

def _canon(v, mode):
    v = _norm(v)
    if not isinstance(v, list):
        return v
    if mode == 'unordered-deep':
        v = [sorted(x, key=_key) if isinstance(x, list) else x for x in v]
    if mode in ('unordered', 'unordered-deep'):
        v = sorted(v, key=_key)
    return v

def _run_tests():
    fn = globals().get(_FN)
    if not callable(fn):
        raise NameError(f"Function {_FN}() is not defined. Keep the function name from the starter code.")
    results = []
    for t in json.loads(_TESTS):
        start = time.perf_counter()
        try:
            got = fn(*json.loads(json.dumps(t["args"])))
            ms = (time.perf_counter() - start) * 1000
            ok = _key(_canon(got, _MODE)) == _key(_canon(t["expected"], _MODE))
            results.append({"ok": ok, "got": _norm(got), "ms": ms})
        except Exception:
            results.append({"ok": False, "error": traceback.format_exc(limit=-2)})
    return json.dumps(results)

_run_tests()
`;
  return { HARNESS };
});
