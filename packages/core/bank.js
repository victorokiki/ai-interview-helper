// Personal question bank: every question the candidate has been asked in a
// live interview, practised in Mock, or has in a prep plan, merged when two
// wordings ask the same thing, with how often it came up and the best score.
// Pure; loads as CommonJS or as a browser global (CoreBank).
(function (root, factory) {
  const deps = typeof module === 'object' && module.exports ? [require('./question'), require('./coaching')] : [root.CoreQuestion, root.CoreCoaching];
  const api = factory(...deps);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CoreBank = api;
})(typeof self !== 'undefined' ? self : this, function (Q, C) {
  const MAX = 2000;

  // Plan question types → Mock practice scenarios.
  const TYPE_TO_SCENARIO = {
    behavioral: 'behavioral',
    technical: 'technical',
    'system-design': 'system-design',
    coding: 'coding',
    motivation: 'general',
    salary: 'salary',
    product: 'product-case',
    data: 'data-ml',
    recruiter: 'recruiter',
    general: 'general',
  };

  function questionBank(sessions, plans = []) {
    const entries = [];
    const add = (question, { source, score, at, jobId, type }) => {
      const q = String(question || '').trim();
      if (!q || q.startsWith('(') || entries.length >= MAX) return;
      let e = entries.find((x) => Q.sameQuestion(x.question, q));
      if (!e) {
        e = { question: q, type: type || Q.questionType(q), sources: [], times: 0, bestScore: null, lastAt: 0, jobIds: [] };
        entries.push(e);
      }
      if (!e.sources.includes(source)) e.sources.push(source);
      if (source !== 'plan') e.times++;
      if (typeof score === 'number' && (e.bestScore == null || score > e.bestScore)) e.bestScore = score;
      e.lastAt = Math.max(e.lastAt, at || 0);
      if (jobId && !e.jobIds.includes(jobId)) e.jobIds.push(jobId);
    };
    for (const s of sessions || []) {
      for (const a of s.answers || []) {
        if (a.kind === 'mock') add(a.question, { source: 'mock', score: C.overall(a.scores), at: a.t || s.startedAt, jobId: s.jobId });
        else if (a.kind === 'answer' && !a.rewrite) add(a.question, { source: 'live', at: a.t || s.startedAt, jobId: s.jobId });
      }
    }
    for (const p of plans || []) {
      for (const item of p.plan || []) add(item.question, { source: 'plan', at: p.createdAt, jobId: p.jobId, type: item.type });
    }
    return entries.sort((a, b) => b.lastAt - a.lastAt);
  }

  return { questionBank, TYPE_TO_SCENARIO };
});
