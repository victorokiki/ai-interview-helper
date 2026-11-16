// SQL sandbox (Web Worker): SQLite compiled to WASM (sql.js). Every test gets
// a fresh in-memory database built from the challenge's schema and seed data.
importScripts('../../../node_modules/sql.js/dist/sql-wasm.js', '../../../packages/core/judge.js');

const started = performance.now();
const ready = initSqlJs({ locateFile: (f) => new URL(`../../../node_modules/sql.js/dist/${f}`, self.location.href).href }).then((SQL) => {
  self.postMessage({ type: 'ready', ms: Math.round(performance.now() - started) });
  return SQL;
});
ready.catch((err) => self.postMessage({ type: 'fatal', error: `SQL engine failed to load: ${err.message}` }));

self.onmessage = async ({ data }) => {
  if (data.type !== 'run') return;
  const SQL = await ready;
  const t0 = performance.now();
  const results = data.tests.map((t) => {
    const db = new SQL.Database();
    try {
      db.exec(t.schema);
      const s = performance.now();
      const res = db.exec(data.code);
      const ms = performance.now() - s;
      const last = res.length ? res[res.length - 1] : { columns: [], values: [] };
      return {
        ok: self.CoreJudge.rowsEqual(last.values, t.expected, data.ordered),
        columns: last.columns,
        got: last.values.slice(0, 50),
        rowCount: last.values.length,
        ms,
      };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    } finally {
      db.close();
    }
  });
  self.postMessage({ id: data.id, results, ms: Math.round(performance.now() - t0) });
};
