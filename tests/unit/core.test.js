const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../packages/core/coaching');
const P = require('../../packages/core/prompts');

test('speech metrics count fillers, restarts and pace', () => {
  const m = C.speechMetrics('um I I think, uh, we basically shipped it you know on time', 6);
  assert.equal(m.fillers, 4);
  assert.equal(m.repeats, 1);
  assert.equal(m.wpm, 130);
});

test('scores line is split from streamed feedback', () => {
  assert.equal(C.splitScores('SCO').body, '');
  const s = C.splitScores('SCORES clarity=7 overall=6\n### A');
  assert.equal(s.scores.overall, 6);
  assert.equal(s.body, '### A');
  assert.equal(C.splitScores('No scores').scores, null);
});

test('aggregate finds the weakest skill and averages', () => {
  const a = C.aggregate([
    { type: 'practice', t: 1, scenario: 'behavioral', scores: { clarity: 8, specificity: 4, overall: 6 } },
    { type: 'practice', t: 2, scenario: 'coding', scores: { clarity: 6, specificity: 6, overall: 7 } },
  ]);
  assert.equal(a.avgScore, 6.5);
  assert.equal(a.weakest.key, 'specificity');
});

test('profile prompt includes grounding, facts and job', () => {
  const sys = P.profileSystem(
    { resume: 'R', facts: [{ category: 'skill', text: 'Go' }], job: { company: 'Contoso', jobDescription: 'JD' } },
    P.LIVE_ROLE,
  );
  assert.match(sys, /bracketed placeholder/);
  assert.match(sys, /<verified_facts>\n- \[skill\] Go/);
  assert.match(sys, /Company: Contoso/);
});

test('style guide follows the preset', () => {
  const g = P.styleGuide({ length: 'medium', tone: 'formal', format: 'script', language: 'es', prompt: 'Be brief.' });
  assert.match(g, /about 110 words/);
  assert.match(g, /formal and precise/);
  assert.match(g, /Write the answer in Spanish/);
  assert.match(g, /<user_instructions>\nBe brief\./);
});

// Measured with tests/bench/providers.js (docs/BENCHMARKS.md, 16 Nov 2026):
// these rules raised grounding on three profiles. Keep them unless a new
// benchmark run shows something better.
test('live answers ask for specific, grounded, speakable answers', () => {
  assert.match(P.GROUNDING, /Use each fact as stated/);
  assert.match(P.GROUNDING, /do not add steps, causes or outcomes/);
  assert.match(P.GROUNDING, /closest real experience/);
  assert.match(P.LIVE_ROLE, /A generic answer that any candidate could give is a weak answer/);
  assert.match(P.LIVE_ROLE, /never imply experience at a scale or in an area the profile does not show/);
  assert.match(P.LIVE_ROLE, /the spoken answer must carry the key facts itself/);
  assert.match(P.LIVE_ROLE, /Say nothing about the company that the job description or notes do not support/);
  assert.match(P.TYPE_GUIDES.behavioral, /only the actions and results the facts state/);
});
