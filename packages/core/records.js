// Derived views over saved sessions, shared by the desktop app (src/store.js)
// and the MCP server (src/mcp/server.js): progress records and text search.
// Pure; loads as CommonJS or as a browser global (CoreRecords).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CoreRecords = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Flat records for the Progress view: one per graded practice answer and one
  // per live session with delivery metrics. Older mock answers predate the
  // per-dimension scores, so their "Score: N/10" line is read as the overall.
  function analyticsRecords(sessions) {
    const out = [];
    for (const s of sessions) {
      const jobId = s.jobId || null;
      if (s.type === 'mock') {
        const legacyKind = /Mock \(([^)]+)\)/.exec(s.title || '')?.[1] || 'mixed';
        for (const a of s.answers || []) {
          if (a.kind !== 'mock') continue;
          let scores = a.scores || null;
          if (!scores) {
            const m = /Score:\s*(\d+(?:\.\d+)?)\s*\/\s*10/i.exec(a.answer || '');
            if (m) scores = { overall: Number(m[1]) };
          }
          out.push({ type: 'practice', t: a.t || s.startedAt, sessionId: s.id, jobId, scenario: a.scenario || legacyKind, scores, speech: a.speech || null });
        }
      } else if (s.speech) {
        out.push({ type: 'live', t: s.startedAt, sessionId: s.id, jobId, speech: s.speech });
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }

  // Sessions whose text contains every word of the query, with a snippet
  // around the first match.
  function searchSessions(sessions, query) {
    const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const out = [];
    for (const s of sessions) {
      const text = [s.title, s.summary, ...(s.transcript || []).map((l) => l.text), ...(s.answers || []).flatMap((a) => [a.question, a.myAnswer, a.answer])]
        .filter(Boolean)
        .join('\n');
      const lower = text.toLowerCase();
      if (!terms.every((t) => lower.includes(t))) continue;
      const at = lower.indexOf(terms[0]);
      const from = Math.max(0, at - 60);
      const snippet = `${from > 0 ? '…' : ''}${text.slice(from, at + 120).replace(/\s+/g, ' ').trim()}…`;
      out.push({ id: s.id, snippet });
    }
    return out;
  }

  return { analyticsRecords, searchSessions };
});
