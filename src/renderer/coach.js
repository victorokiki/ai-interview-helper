// Progress charts and score/delivery widgets for the Mock, Live, Progress and
// Jobs views. The metrics themselves live in packages/core/coaching.js.
(function () {
  const { SCENARIOS, DIMENSIONS, speechMetrics, speechTips, deliverySummary, splitScores, overall, aggregate, fmt } = window.CoreCoaching;

  // Small inline SVG line chart of scores (0–10) over time.
  function sparkline(series, { width = 300, height = 64 } = {}) {
    if (series.length < 2) return '<p class="hint">Grade at least two practice answers to see a trend.</p>';
    const pad = 6;
    const xs = series.map((_, i) => pad + (i * (width - 2 * pad)) / (series.length - 1));
    const ys = series.map((p) => height - pad - (p.v / 10) * (height - 2 * pad));
    const points = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
    const dots = xs
      .map((x, i) => `<circle cx="${x.toFixed(1)}" cy="${ys[i].toFixed(1)}" r="2.5" style="fill:var(--accent)"><title>${fmt(series[i].v)} / 10 · ${new Date(series[i].t).toLocaleDateString()}</title></circle>`)
      .join('');
    const mid = height - pad - 0.5 * (height - 2 * pad);
    return `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Score trend">
      <line x1="0" x2="${width}" y1="${mid}" y2="${mid}" style="stroke:var(--border);stroke-dasharray:3 3" />
      <polyline points="${points}" style="fill:none;stroke:var(--accent);stroke-width:2" vector-effect="non-scaling-stroke" />
      ${dots}</svg>`;
  }

  function bar(label, value) {
    const pct = value == null ? 0 : Math.round(value * 10);
    return `<div class="bar-row"><span class="bar-label">${label}</span><span class="bar"><span style="width:${pct}%"></span></span><span class="bar-value">${fmt(value)}</span></div>`;
  }

  // Overall score plus one bar per dimension.
  function scoresHtml(scores) {
    if (!scores) return '';
    const o = overall(scores);
    return `<div class="scores">
      <div class="score-big"><span>${fmt(o)}</span><small>/ 10</small></div>
      <div class="score-bars">${DIMENSIONS.filter(([k]) => scores[k] != null).map(([k, l]) => bar(l, scores[k])).join('')}</div>
    </div>`;
  }

  function speechHtml(m, scenario) {
    if (!m || !m.words) return '';
    const tips = speechTips(m, scenario);
    const stats = [
      m.wpm ? `<span><b>${m.wpm}</b> words/min</span>` : '',
      `<span><b>${m.words}</b> words</span>`,
      `<span><b>${m.fillers}</b> fillers</span>`,
      m.seconds ? `<span><b>${Math.floor(m.seconds / 60)}:${String(m.seconds % 60).padStart(2, '0')}</b> speaking</span>` : '',
    ].join('');
    return `<div class="delivery"><div class="label">Delivery</div><div class="stats">${stats}</div>
      <ul class="tips">${(tips.length ? tips : ['Delivery looks good: steady pace and few fillers.']).map((t) => `<li>${t}</li>`).join('')}</ul></div>`;
  }

  window.Coach = { ...window.CoreCoaching, sparkline, bar, scoresHtml, speechHtml };
})();
