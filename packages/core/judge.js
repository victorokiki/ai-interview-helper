// Answer checking for the Coding Lab. Shared by the JS runner (worker), the
// SQL runner, the unit tests and (later) the server.
//   compare modes: 'exact' | 'unordered' (outer order ignored) |
//                  'unordered-deep' (inner lists sorted too)
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CoreJudge = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // JSON-like normal form: tuples/sets → arrays, -0 → 0, floats rounded so
  // 0.1 + 0.2 equals 0.3.
  function normalize(v) {
    if (v instanceof Set) return [...v].map(normalize);
    if (Array.isArray(v)) return v.map(normalize);
    if (typeof v === 'number') return Object.is(v, -0) ? 0 : Math.round(v * 1e6) / 1e6;
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = normalize(v[k]);
      return out;
    }
    return v === undefined ? null : v;
  }

  const key = (v) => JSON.stringify(v);

  function canonical(v, mode) {
    let n = normalize(v);
    if (!Array.isArray(n)) return n;
    if (mode === 'unordered-deep') n = n.map((x) => (Array.isArray(x) ? [...x].sort((a, b) => (key(a) < key(b) ? -1 : 1)) : x));
    if (mode === 'unordered' || mode === 'unordered-deep') n = [...n].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    return n;
  }

  function equal(got, expected, mode = 'exact') {
    return key(canonical(got, mode)) === key(canonical(expected, mode));
  }

  // SQL: compare row values (column names may differ); ordered or not.
  function rowsEqual(gotRows, expectedRows, ordered) {
    const norm = (rows) => rows.map((r) => r.map((c) => (typeof c === 'number' ? Math.round(c * 100) / 100 : c)));
    return equal(norm(gotRows), norm(expectedRows), ordered ? 'exact' : 'unordered');
  }

  // Safe function names only (they are spliced into generated code).
  function validIdentifier(name) {
    return /^[A-Za-z_$][\w$]*$/.test(String(name || ''));
  }

  return { normalize, equal, rowsEqual, validIdentifier };
});
