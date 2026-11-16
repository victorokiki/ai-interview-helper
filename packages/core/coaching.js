// Speech coaching metrics, score parsing and progress aggregation.
// Shared by the desktop renderer, the future server/web/mobile apps and tests.
// Plain JS, no dependencies; loads as CommonJS or as a browser global (CoreCoaching).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CoreCoaching = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const SCENARIOS = {
    general: 'General',
    behavioral: 'Behavioral',
    coding: 'Coding',
    'system-design': 'System design',
    'product-case': 'Product case',
    'data-ml': 'Data / ML',
    salary: 'Salary negotiation',
    recruiter: 'Recruiter screen',
    mixed: 'Mixed',
    technical: 'Technical',
    'role-specific': 'Role-specific',
  };

  const DIMENSIONS = [
    ['clarity', 'Clarity'],
    ['structure', 'Structure'],
    ['specificity', 'Specificity'],
    ['relevance', 'Relevance'],
    ['depth', 'Depth'],
  ];

  // Words that are almost always filler. "Like", "so" and "actually" are left
  // out because they are often used correctly.
  const HARD_FILLERS = ['um', 'umm', 'uh', 'uhh', 'erm', 'er', 'ah', 'hmm', 'mm'];
  const SOFT_FILLERS = ['you know', 'i mean', 'basically', 'literally', 'kind of', 'sort of'];
  // 'session' = a whole live call, where answer length doesn't apply.
  const NO_LENGTH_ADVICE = ['coding', 'system-design', 'data-ml', 'session'];

  // Delivery numbers for a spoken answer. seconds = measured speaking time
  // (0 when the answer was typed, so no pace is reported).
  function speechMetrics(text, seconds = 0) {
    const lower = String(text || '').toLowerCase();
    const words = lower.match(/[a-z0-9']+/g) || [];
    const counts = {};
    for (const w of words) if (HARD_FILLERS.includes(w)) counts[w] = (counts[w] || 0) + 1;
    for (const phrase of SOFT_FILLERS) {
      const n = (lower.match(new RegExp(`\\b${phrase}\\b`, 'g')) || []).length;
      if (n) counts[phrase] = n;
    }
    const fillers = Object.values(counts).reduce((a, b) => a + b, 0);
    // Immediate repeats ("I I think", "the the") usually mean a restart.
    const repeats = (lower.match(/\b([a-z']+)[\s,.]+\1\b/g) || []).length;
    return {
      words: words.length,
      seconds: seconds ? Math.round(seconds) : 0,
      wpm: seconds >= 5 && words.length >= 10 ? Math.round(words.length / (seconds / 60)) : null,
      fillers,
      fillerRate: words.length ? Math.round((fillers * 1000) / words.length) / 10 : 0,
      topFillers: Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3),
      repeats,
    };
  }

  // Plain-language tips from the metrics, most important first.
  function speechTips(m, scenario) {
    const tips = [];
    if (m.wpm && m.wpm > 170) tips.push(`Fast pace (${m.wpm} words/min). Aim for 130–160 and pause after key points.`);
    if (m.wpm && m.wpm < 105) tips.push(`Slow pace (${m.wpm} words/min). Aim for 130–160; shorter sentences help.`);
    if (m.fillers >= 3 && m.fillerRate > 2.5) {
      const top = m.topFillers.map(([w, n]) => `“${w}” ×${n}`).join(', ');
      tips.push(`${m.fillers} filler words (${top}). A short silent pause works better.`);
    }
    if (m.repeats >= 3) tips.push(`${m.repeats} repeated words or restarts. Slow down at the start of sentences.`);
    if (!NO_LENGTH_ADVICE.includes(scenario)) {
      if (m.words > 0 && m.words < 40) tips.push('Short answer. Add a concrete example and the result.');
      if (m.words > 330) tips.push(`Long answer (${m.words} words). Aim for 1–2 minutes, about 150–300 words.`);
    }
    return tips;
  }

  // One line for the grader prompt.
  function deliverySummary(m) {
    return [
      `${m.words} words`,
      m.wpm ? `${m.wpm} words per minute` : 'typed or untimed, so no pace',
      `${m.fillers} filler words`,
      `${m.repeats} repeated words or restarts`,
    ].join(', ');
  }

  // Separates the grader's first line ("SCORES clarity=7 …") from the
  // Markdown feedback. While the first line is still streaming, body is ''.
  function splitScores(text) {
    const t = String(text || '').replace(/^\s+/, '');
    const nl = t.indexOf('\n');
    const first = (nl === -1 ? t : t.slice(0, nl)).replace(/^[`*\s]+/, '');
    if (/^SCORES\b/i.test(first)) {
      if (nl === -1) return { scores: null, body: '' };
      const scores = {};
      for (const m of first.matchAll(/([a-z]+)\s*[=:]\s*(\d+(?:\.\d+)?)/gi)) {
        scores[m[1].toLowerCase()] = Math.max(0, Math.min(10, Number(m[2])));
      }
      return { scores: Object.keys(scores).length ? scores : null, body: t.slice(nl + 1).replace(/^\s+/, '') };
    }
    if (nl === -1 && 'SCORES'.startsWith(first.trim().toUpperCase())) return { scores: null, body: '' };
    return { scores: null, body: text };
  }

  function overall(scores) {
    if (!scores) return null;
    if (typeof scores.overall === 'number') return scores.overall;
    const dims = DIMENSIONS.map(([k]) => scores[k]).filter((v) => typeof v === 'number');
    return dims.length ? dims.reduce((a, b) => a + b, 0) / dims.length : null;
  }

  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const fmt = (n, d = 1) => (n == null ? '–' : Number(n).toFixed(d));

  // Summary numbers for the Progress view from analytics records.
  function aggregate(records) {
    const practice = records.filter((r) => r.type === 'practice');
    const scored = practice.filter((r) => overall(r.scores) != null);
    const overalls = scored.map((r) => overall(r.scores));
    const recent = overalls.slice(-5);
    const before = overalls.slice(-10, -5);
    const dims = {};
    for (const [k] of DIMENSIONS) dims[k] = mean(scored.map((r) => r.scores[k]).filter((v) => typeof v === 'number'));
    const rated = DIMENSIONS.filter(([k]) => dims[k] != null);
    const weakest = rated.length ? rated.reduce((a, b) => (dims[b[0]] < dims[a[0]] ? b : a)) : null;
    const byScenario = {};
    for (const r of practice) {
      const s = (byScenario[r.scenario] ||= { count: 0, scores: [] });
      s.count++;
      const o = overall(r.scores);
      if (o != null) s.scores.push(o);
    }
    const speech = records.map((r) => r.speech).filter((m) => m && m.words);
    const paced = speech.filter((m) => m.wpm);
    const totalWords = speech.reduce((a, m) => a + m.words, 0);
    return {
      practiceCount: practice.length,
      liveCount: records.filter((r) => r.type === 'live').length,
      avgScore: mean(overalls),
      recentAvg: mean(recent),
      trend: before.length >= 2 ? mean(recent) - mean(before) : null,
      dims,
      weakest: weakest ? { key: weakest[0], label: weakest[1], value: dims[weakest[0]] } : null,
      byScenario: Object.entries(byScenario)
        .map(([key, v]) => ({ key, label: SCENARIOS[key] || key, count: v.count, avg: mean(v.scores) }))
        .sort((a, b) => b.count - a.count),
      avgWpm: paced.length ? Math.round(mean(paced.map((m) => m.wpm))) : null,
      fillersPer100: totalWords ? (speech.reduce((a, m) => a + m.fillers, 0) * 100) / totalWords : null,
      series: scored.map((r) => ({ t: r.t, v: overall(r.scores) })),
    };
  }

  // Adaptive difficulty from the last few overall scores in this session:
  // strong answers make the next question harder, weak ones easier.
  function nextDifficulty(current, recentOverall) {
    const order = ['easy', 'medium', 'hard'];
    const i = Math.max(0, order.indexOf(current || 'medium'));
    const last = recentOverall.filter((v) => typeof v === 'number').slice(-2);
    if (!last.length) return order[i];
    const avg = mean(last);
    if (avg >= 8 && i < 2) return order[i + 1];
    if (avg <= 5 && i > 0) return order[i - 1];
    return order[i];
  }

  // Coding Lab summary: solved = a submission that passed every test.
  function aggregateCoding(attempts, challenges) {
    const subs = attempts.filter((a) => a.submitted);
    const solved = new Set(subs.filter((a) => a.total && a.passed === a.total).map((a) => a.problemId));
    const byDifficulty = {};
    for (const c of challenges) {
      const d = (byDifficulty[c.difficulty] ||= { total: 0, solved: 0 });
      d.total++;
      if (solved.has(c.id)) d.solved++;
    }
    const firstTries = challenges.filter((c) => {
      const first = subs.find((a) => a.problemId === c.id);
      return first && first.total && first.passed === first.total;
    }).length;
    return {
      solved: solved.size,
      total: challenges.length,
      submissions: subs.length,
      passRate: subs.length ? subs.filter((a) => a.total && a.passed === a.total).length / subs.length : null,
      firstTries,
      byDifficulty,
      hintsPerSolve: solved.size ? subs.filter((a) => solved.has(a.problemId)).reduce((n, a) => n + a.hints, 0) / solved.size : null,
    };
  }

  // "Next steps": a short, concrete learning path from the candidate's own
  // results (weakest skill, weakest practice type, delivery, coding).
  const SKILL_PLAN = {
    clarity: { scenario: 'general', tip: 'Lead with your answer in one sentence, then support it.' },
    structure: { scenario: 'behavioral', tip: 'Use situation, task, action, result, and keep the situation to one sentence.' },
    specificity: { scenario: 'behavioral', tip: 'Name the project, what you did, and a number for the result.' },
    relevance: { scenario: 'mixed', tip: 'End each answer by tying it to what this job needs.' },
    depth: { scenario: 'system-design', tip: 'Explain trade-offs and the alternatives you rejected.' },
  };

  function learningPath(agg, coding) {
    const steps = [];
    if (!agg || !agg.practiceCount) {
      steps.push({ title: 'Do your first mock interview', detail: 'Five behavioral questions give the coach enough to find your weakest skill.', action: { type: 'mock', scenario: 'behavioral' } });
    } else {
      if (agg.weakest && agg.weakest.value < 8) {
        const p = SKILL_PLAN[agg.weakest.key];
        steps.push({ title: `Work on ${agg.weakest.label.toLowerCase()} (avg ${fmt(agg.weakest.value)})`, detail: p.tip, action: { type: 'mock', scenario: p.scenario } });
      }
      const weakType = agg.byScenario.filter((s) => s.avg != null).sort((a, b) => a.avg - b.avg)[0];
      if (weakType && weakType.avg < 7) {
        steps.push({ title: `More ${weakType.label} practice (avg ${fmt(weakType.avg)})`, detail: 'Your lowest-scoring practice type so far.', action: { type: 'mock', scenario: weakType.key } });
      }
      const untried = ['behavioral', 'system-design', 'coding', 'recruiter'].find((k) => !agg.byScenario.some((s) => s.key === k));
      if (untried && steps.length < 3) steps.push({ title: `Try a ${SCENARIOS[untried]} question`, detail: "You haven't practised this type yet.", action: { type: 'mock', scenario: untried } });
    }
    if (agg?.avgWpm && agg.avgWpm > 170) steps.push({ title: `Slow down (${agg.avgWpm} words/min)`, detail: 'Aim for 130–160; pause after each key point.', action: null });
    else if (agg?.avgWpm && agg.avgWpm < 105) steps.push({ title: `Speed up a little (${agg.avgWpm} words/min)`, detail: 'Aim for 130–160; shorter sentences help.', action: null });
    if (agg?.fillersPer100 != null && agg.fillersPer100 > 3) steps.push({ title: `Cut filler words (${fmt(agg.fillersPer100)} per 100 words)`, detail: 'Replace "um" with a short silent pause.', action: null });
    if (coding) {
      const d = ['easy', 'medium', 'hard'].find((x) => coding.byDifficulty[x] && coding.byDifficulty[x].solved < coding.byDifficulty[x].total);
      if (d) steps.push({ title: `Solve a ${d} coding problem`, detail: `${coding.byDifficulty[d].solved} of ${coding.byDifficulty[d].total} ${d} problems solved.`, action: { type: 'lab' } });
    }
    return steps.slice(0, 4);
  }

  return { learningPath, aggregateCoding, nextDifficulty, SCENARIOS, DIMENSIONS, speechMetrics, speechTips, deliverySummary, splitScores, overall, aggregate, mean, fmt };
});
