// Memory across sessions: short lessons from past interviews and practice
// ("Lead with the result", "Mention the Kafka migration for scale questions").
// The app suggests them after a session; only lessons the user keeps are used
// in later answers, practice and prep. Shared by the app and the MCP server.
// Pure; loads as CommonJS or as a browser global (CoreLessons).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CoreLessons = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const KINDS = ['delivery', 'structure', 'content', 'story', 'company'];
  const MAX_TEXT = 240;
  const MAX_IN_PROMPT = 8;

  const STOP = new Set('a an the and or but to of in on for with at by from is are be your you my i it this that when as so than then do not no more less each every one'.split(' '));
  function words(text) {
    return new Set(
      String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9%]+/g, ' ')
        .split(' ')
        .filter((w) => w && !STOP.has(w)),
    );
  }

  // Two lessons say the same thing when most of their content words overlap.
  function similar(a, b) {
    const x = words(a);
    const y = words(b);
    if (!x.size || !y.size) return false;
    let shared = 0;
    for (const w of x) if (y.has(w)) shared++;
    return shared / Math.min(x.size, y.size) >= 0.6 || shared / (x.size + y.size - shared) >= 0.5;
  }

  const DIMENSION_LESSONS = {
    specificity: { kind: 'content', text: 'Back every answer with one concrete example: a name, a number or a result.' },
    structure: { kind: 'structure', text: 'Use STAR: one sentence of situation, then what you did, then the measurable result.' },
    clarity: { kind: 'structure', text: 'Lead with the answer in one sentence, then explain.' },
    relevance: { kind: 'content', text: 'Tie each answer back to what this role needs before you finish.' },
    depth: { kind: 'content', text: 'Go one level deeper: name the trade-off you made and the alternative you rejected.' },
  };

  // Lessons that follow from the numbers alone (pace, fillers, practice
  // scores), so they need no AI call. session: a saved session.
  function metricLessons(session) {
    const out = [];
    const answers = (session?.answers || []).filter((a) => a.kind === 'mock');
    const speeches = [session?.speech, ...answers.map((a) => a.speech)].filter((s) => s && s.words >= 60);
    if (speeches.length) {
      const wordsSpoken = speeches.reduce((n, s) => n + s.words, 0);
      const wpm = Math.round(speeches.reduce((n, s) => n + (s.wpm || 0) * s.words, 0) / wordsSpoken);
      const fillers = speeches.reduce((n, s) => n + (s.fillers || 0), 0);
      const per100 = (fillers / wordsSpoken) * 100;
      if (wpm > 170) out.push({ kind: 'delivery', text: `Slow down to about 140–160 words a minute; pause after each key point.`, why: `You averaged ${wpm} words a minute.` });
      else if (wpm && wpm < 105) out.push({ kind: 'delivery', text: 'Keep a steadier pace: plan your first sentence, then speak without long gaps.', why: `You averaged ${wpm} words a minute.` });
      if (per100 >= 4) out.push({ kind: 'delivery', text: 'Pause silently instead of saying “um” or “like” while you think.', why: `${per100.toFixed(1)} filler words per 100 words.` });
    }
    const scored = answers.filter((a) => a.scores);
    if (scored.length) {
      const avg = {};
      for (const dim of Object.keys(DIMENSION_LESSONS)) {
        const vals = scored.map((a) => a.scores[dim]).filter((v) => typeof v === 'number');
        if (vals.length) avg[dim] = vals.reduce((a, b) => a + b, 0) / vals.length;
      }
      const [dim, value] = Object.entries(avg).sort((a, b) => a[1] - b[1])[0] || [];
      if (dim && value <= 5.5) out.push({ ...DIMENSION_LESSONS[dim], why: `Your ${dim} averaged ${value.toFixed(1)}/10 in this session.` });
    }
    return out.map((l) => ({ ...l, source: 'metrics', scope: 'general' }));
  }

  // The AI's reply: a JSON array of {kind, text, why, scope}. Tolerates prose
  // around it; anything malformed is dropped.
  function parseLessons(raw) {
    const s = String(raw || '');
    const start = s.indexOf('[');
    const end = s.lastIndexOf(']');
    if (start === -1 || end <= start) return [];
    let list;
    try {
      list = JSON.parse(s.slice(start, end + 1));
    } catch {
      return [];
    }
    if (!Array.isArray(list)) return [];
    return list
      .filter((l) => l && typeof l.text === 'string' && l.text.trim())
      .slice(0, 4)
      .map((l) => ({
        kind: KINDS.includes(l.kind) ? l.kind : 'content',
        text: l.text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT),
        why: typeof l.why === 'string' ? l.why.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT) : '',
        scope: l.scope === 'job' ? 'job' : 'general',
        source: 'ai',
      }));
  }

  // New suggestions that aren't already kept, pending or dismissed.
  function freshSuggestions(candidates, existing) {
    const out = [];
    for (const c of candidates) {
      if ([...existing, ...out].some((e) => similar(e.text, c.text))) continue;
      out.push(c);
    }
    return out;
  }

  // Kept lessons that apply to this job: general ones and ones for this job.
  function applicable(lessons, jobId) {
    return (lessons || [])
      .filter((l) => l.status === 'approved' && (!l.jobId || l.jobId === jobId))
      .sort((a, b) => (b.jobId ? 1 : 0) - (a.jobId ? 1 : 0) || (b.decidedAt || 0) - (a.decidedAt || 0))
      .slice(0, MAX_IN_PROMPT);
  }

  function lessonsBlock(lessons) {
    if (!lessons?.length) return '';
    return `<lessons_from_past_interviews>\nThe candidate kept these lessons from earlier interviews and practice. Apply them where they fit; they never override the verified-facts rule.\n${lessons.map((l) => `- [${l.kind}] ${l.text}`).join('\n')}\n</lessons_from_past_interviews>`;
  }

  return { KINDS, similar, metricLessons, parseLessons, freshSuggestions, applicable, lessonsBlock, MAX_TEXT };
});
