// Memory across sessions: metric lessons, AI reply parsing, duplicates,
// which kept lessons reach a prompt, and the prompt block.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../../packages/core/lessons');
const P = require('../../packages/core/prompts');

test('metric lessons: fast pace, fillers and the weakest practice dimension', () => {
  const session = {
    type: 'mock',
    answers: [
      { kind: 'mock', scores: { clarity: 7, structure: 6, specificity: 4, relevance: 7, depth: 6 }, speech: { words: 300, wpm: 190, fillers: 15 } },
      { kind: 'mock', scores: { clarity: 8, structure: 7, specificity: 5, relevance: 8, depth: 6 }, speech: { words: 200, wpm: 180, fillers: 9 } },
    ],
  };
  const out = L.metricLessons(session);
  assert.deepEqual(out.map((l) => l.kind), ['delivery', 'delivery', 'content']);
  assert.match(out[0].why, /186 words a minute/);
  assert.match(out[1].why, /4\.8 filler words per 100/);
  assert.match(out[2].text, /concrete example/);
  assert.match(out[2].why, /specificity averaged 4\.5/);
  assert.ok(out.every((l) => l.source === 'metrics' && l.scope === 'general'));
  // Good numbers, or too little speech to judge: nothing to suggest.
  assert.deepEqual(L.metricLessons({ type: 'live', speech: { words: 400, wpm: 150, fillers: 4 } }), []);
  assert.deepEqual(L.metricLessons({ type: 'live', speech: { words: 30, wpm: 220, fillers: 9 } }), []);
});

test('AI replies are parsed defensively', () => {
  const raw = 'Here you go:\n[{"kind":"story","text":"Use the  payments outage story for failure questions.","why":"Asked twice","scope":"general"},{"kind":"weird","text":"Mention Contoso\'s move to Azure.","scope":"job"},{"text":""},{"kind":"content"}]';
  assert.deepEqual(L.parseLessons(raw), [
    { kind: 'story', text: 'Use the payments outage story for failure questions.', why: 'Asked twice', scope: 'general', source: 'ai' },
    { kind: 'content', text: "Mention Contoso's move to Azure.", why: '', scope: 'job', source: 'ai' },
  ]);
  assert.deepEqual(L.parseLessons('no lessons'), []);
  assert.deepEqual(L.parseLessons('[not json'), []);
  assert.deepEqual(L.parseLessons('[]'), []);
});

test('duplicates of kept, pending or dismissed lessons are not suggested again', () => {
  assert.equal(L.similar('Lead with the result in one sentence', 'Lead with the result, in one sentence.'), true);
  assert.equal(L.similar('Slow down when explaining system design', 'Mention the Kafka migration for scale questions'), false);
  const existing = [{ text: 'Pause silently instead of saying “um” or “like” while you think.', status: 'dismissed' }];
  const fresh = L.freshSuggestions(
    [
      { text: 'Pause silently instead of saying um or like while you think' },
      { text: 'Mention the Kafka migration for scale questions' },
      { text: 'Mention the Kafka migration when asked about scale questions' },
    ],
    existing,
  );
  assert.deepEqual(fresh.map((l) => l.text), ['Mention the Kafka migration for scale questions']);
});

test('only kept lessons for this job (or all jobs) reach the prompt, job ones first, at most 8', () => {
  const lessons = [
    { id: 'a', text: 'General A', kind: 'delivery', status: 'approved', jobId: null, decidedAt: 1 },
    { id: 'b', text: 'Job 1 only', kind: 'company', status: 'approved', jobId: 'j1', decidedAt: 2 },
    { id: 'c', text: 'Job 2 only', kind: 'company', status: 'approved', jobId: 'j2', decidedAt: 3 },
    { id: 'd', text: 'Pending', kind: 'content', status: 'suggested', jobId: null },
    { id: 'e', text: 'Dismissed', kind: 'content', status: 'dismissed', jobId: null },
  ];
  assert.deepEqual(L.applicable(lessons, 'j1').map((l) => l.id), ['b', 'a']);
  assert.deepEqual(L.applicable(lessons, null).map((l) => l.id), ['a']);
  const many = Array.from({ length: 12 }, (_, i) => ({ id: String(i), text: `L${i}`, kind: 'content', status: 'approved', jobId: null, decidedAt: i }));
  assert.equal(L.applicable(many, null).length, 8);
  assert.equal(L.applicable(many, null)[0].id, '11', 'newest first');

  const block = L.lessonsBlock(L.applicable(lessons, 'j1'));
  assert.match(block, /^<lessons_from_past_interviews>\n.*never override the verified-facts rule\.\n- \[company\] Job 1 only\n- \[delivery\] General A\n<\/lessons_from_past_interviews>$/);
  assert.equal(L.lessonsBlock([]), '');
  const system = P.profileSystem({ resume: 'R', facts: [], lessonsBlock: block }, 'ROLE');
  assert.ok(system.endsWith(block), 'block goes at the end of the profile');
  assert.ok(!P.profileSystem({ resume: 'R', facts: [] }, 'ROLE').includes('lessons_from_past_interviews'));
});
