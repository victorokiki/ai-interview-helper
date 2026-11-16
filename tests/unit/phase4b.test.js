const test = require('node:test');
const assert = require('node:assert/strict');
const Career = require('../../packages/core/career');
const Bank = require('../../packages/core/bank');
const C = require('../../packages/core/coaching');
const R = require('../../packages/core/records');

test('prep plan lines are parsed; unknown types become general', () => {
  const plan = Career.parsePlan(
    '### Focus areas\n- scale\n### Question plan\n1. [behavioral] Tell me about leading a team — the role is a lead\n2. [system-design] How would you scale our API? - JD says 50k RPS\n3) [weird] Odd one\nnot a plan line',
  );
  assert.deepEqual(
    plan.map((p) => [p.type, p.question, p.why]),
    [
      ['behavioral', 'Tell me about leading a team', 'the role is a lead'],
      ['system-design', 'How would you scale our API?', 'JD says 50k RPS'],
      ['general', 'Odd one', ''],
    ],
  );
  assert.match(Career.careerPrompt('prep', { research: 'Contoso info' }), /<company_research>\nContoso info/);
});

test('question bank merges rewordings, counts, keeps best score and plan items', () => {
  const sessions = [
    { id: 'm1', type: 'mock', startedAt: 1, jobId: 'j1', answers: [{ kind: 'mock', question: "What's your biggest weakness?", scores: { overall: 5 }, t: 10 }] },
    { id: 'm2', type: 'mock', startedAt: 2, jobId: 'j1', answers: [{ kind: 'mock', question: 'What is your biggest weakness?', scores: { overall: 8 }, t: 20 }] },
    { id: 'l1', type: 'live', startedAt: 3, jobId: 'j2', answers: [{ kind: 'answer', question: 'How would you design a cache?', t: 30 }, { kind: 'answer', question: 'How would you design a cache?', rewrite: 'shorter', t: 31 }] },
  ];
  const plans = [{ jobId: 'j1', createdAt: 40, plan: [{ type: 'behavioral', question: 'Tell me about a conflict with a peer' }] }];
  const b = Bank.questionBank(sessions, plans);
  const weak = b.find((q) => /weakness/.test(q.question));
  assert.equal(b.length, 3);
  assert.equal(weak.times, 2);
  assert.equal(weak.bestScore, 8);
  assert.equal(b.find((q) => /cache/.test(q.question)).times, 1, 'rewrites are not extra askings');
  const planned = b.find((q) => /conflict/.test(q.question));
  assert.deepEqual([planned.times, planned.sources, planned.type], [0, ['plan'], 'behavioral']);
  assert.equal(Bank.TYPE_TO_SCENARIO.motivation, 'general');
});

test('learning path: first step for a newcomer, targeted steps from results', () => {
  assert.equal(C.learningPath(C.aggregate([]), null)[0].action.scenario, 'behavioral');
  const recs = [
    { type: 'practice', t: 1, scenario: 'behavioral', scores: { clarity: 8, structure: 7, specificity: 4, relevance: 8, depth: 7, overall: 6 } },
    { type: 'practice', t: 2, scenario: 'coding', scores: { clarity: 6, structure: 6, specificity: 6, relevance: 6, depth: 5, overall: 5 } },
    { type: 'live', t: 3, speech: { words: 500, wpm: 185, fillers: 25 } },
  ];
  const steps = C.learningPath(C.aggregate(recs), { byDifficulty: { easy: { solved: 1, total: 4 } } });
  const titles = steps.map((s) => s.title).join(' | ');
  assert.match(titles, /Work on specificity/);
  assert.match(titles, /More Coding practice/);
  assert.ok(steps.length <= 4);
  assert.equal(steps.find((s) => /specificity/.test(s.title)).action.scenario, 'behavioral');
});

test('shared records: legacy scores and search', () => {
  const s = [{ id: 'a', type: 'mock', title: 'Mock (behavioral) — 1 question', startedAt: 5, answers: [{ kind: 'mock', question: 'Q', answer: '**Score: 7/10**' }] }, { id: 'b', type: 'live', startedAt: 6, title: 'Kafka call', transcript: [{ speaker: 'them', text: 'Tell me about Kafka partitions' }] }];
  const recs = R.analyticsRecords(s);
  assert.deepEqual([recs[0].scenario, recs[0].scores.overall], ['behavioral', 7]);
  assert.deepEqual(R.searchSessions(s, 'kafka partitions').map((h) => h.id), ['b']);
});
