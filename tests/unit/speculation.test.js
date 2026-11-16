const test = require('node:test');
const assert = require('node:assert/strict');
const { SpeculationController } = require('../../packages/core/speculation');

// Records what the controller asks the host to do.
function harness() {
  let clock = 1000;
  let seq = 0;
  const log = [];
  const host = {
    now: () => clock,
    start: (question, opts) => {
      const id = `a${++seq}`;
      log.push({ op: 'start', id, question, ...opts });
      return id;
    },
    cancel: (id, reason) => log.push({ op: 'cancel', id, reason }),
    promote: (id, question) => log.push({ op: 'promote', id, question }),
  };
  const spec = new SpeculationController(host);
  return { spec, log, tick: (ms) => (clock += ms), now: () => clock };
}

test('eager then same final: the draft is promoted, one request only', () => {
  const { spec, log } = harness();
  spec.eager('Tell me about a time you led a team?');
  spec.end('Tell me about a time you led a team?');
  assert.deepEqual(log.map((l) => l.op), ['start', 'promote']);
  assert.equal(log[0].draft, true);
  assert.equal(spec.stats.promoted, 1);
});

test('eager then a changed final: draft cancelled, corrected answer on the full question', () => {
  const { spec, log } = harness();
  spec.eager('How would you design a cache?');
  spec.end('How would you design a cache for a global payments platform?');
  assert.deepEqual(log.map((l) => l.op), ['start', 'cancel', 'start']);
  assert.equal(log[1].reason, 'changed');
  assert.equal(log[2].question, 'How would you design a cache for a global payments platform?');
  assert.equal(log[2].corrected, true);
  assert.equal(spec.stats.corrections, 1);
});

test('interviewer resumes: draft dropped; the final starts fresh', () => {
  const { spec, log } = harness();
  spec.eager('What is your biggest weakness?');
  spec.resumed();
  spec.end('What is your biggest weakness and how are you working on it?');
  assert.deepEqual(log.map((l) => l.op), ['start', 'cancel', 'start']);
  assert.equal(log[1].reason, 'resumed');
  assert.equal(log[2].draft, false);
  assert.equal(spec.stats.cancelledDrafts, 1);
});

test('no eager signal: the answer starts the moment the final arrives (no fixed wait)', () => {
  const { spec, log } = harness();
  spec.end('Why do you want to work here?');
  assert.deepEqual(log.map((l) => l.op), ['start']);
  assert.equal(log[0].draft, false);
});

test('a statement followed by a question is answered as one question', () => {
  const { spec, log } = harness();
  spec.end('We are migrating our monolith to services.');
  assert.equal(log.length, 0);
  spec.end('How would you approach that?');
  assert.equal(log[0].question, 'We are migrating our monolith to services. How would you approach that?');
});

test('follow-up sentence soon after: corrected answer covering both', () => {
  const { spec, log, tick, now } = harness();
  spec.end('Tell me about a project you are proud of?');
  tick(1200);
  spec.end('Especially one involving distributed systems and scaling.', now() - 200);
  assert.deepEqual(log.map((l) => l.op), ['start', 'cancel', 'start']);
  assert.equal(log[1].reason, 'follow-up');
  assert.match(log[2].question, /proud of\? Especially one involving distributed systems/);
});

test('a trivial tail ("right?") does not restart the answer', () => {
  const { spec, log, tick } = harness();
  spec.end('How do you handle production incidents?');
  tick(800);
  spec.end('Right?');
  assert.deepEqual(log.map((l) => l.op), ['start']);
});

test('a question well after the window is a new question', () => {
  const { spec, log, tick } = harness();
  spec.end('How do you handle production incidents?');
  tick(10000);
  spec.end('What does your ideal team look like?');
  assert.deepEqual(log.map((l) => l.op), ['start', 'cancel', 'start']);
  assert.equal(log[1].reason, 'new-question');
  assert.equal(log[2].corrected, false);
});

test('repeated eager for the same question does not start twice', () => {
  const { spec, log } = harness();
  spec.eager('How would you design Twitter?');
  spec.eager('How would you design Twitter?');
  assert.equal(log.filter((l) => l.op === 'start').length, 1);
});

test('takePending returns unanswered text for a manual answer', () => {
  const { spec } = harness();
  spec.end('We have a lot of legacy code.');
  assert.equal(spec.takePending(), 'We have a lot of legacy code.');
  assert.equal(spec.takePending(), '');
});
