const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../../packages/core/question');

test('detects questions by mark or opener, needs 4+ words', () => {
  assert.equal(Q.looksLikeQuestion('Tell me about a time you failed'), true);
  assert.equal(Q.looksLikeQuestion('So how would you scale this?'), true);
  assert.equal(Q.looksLikeQuestion('We use Kafka for events.'), false);
  assert.equal(Q.looksLikeQuestion('Why?'), false);
});

test('same question despite contractions, fillers and a swapped word', () => {
  assert.equal(Q.sameQuestion("What's your biggest weakness?", 'What is your biggest weakness?'), true);
  assert.equal(Q.sameQuestion('So um tell me about a time you led a team', 'Tell me about a time you led a team?'), true);
  assert.equal(Q.sameQuestion('Tell me about a time you led a team?', 'Tell me about a time you lead a team?'), true);
  assert.equal(Q.sameQuestion('How would you design a URL shortener?', 'How would you design URL shortener?'), true);
});

test('changed question when real content is added or replaced', () => {
  assert.equal(Q.sameQuestion('Tell me about a time you led a team?', 'Tell me about a time you led a team that was failing?'), false);
  assert.equal(Q.sameQuestion('How would you design a cache?', 'How would you design a rate limiter?'), false);
  assert.equal(Q.sameQuestion('', 'anything here'), false);
});

test('counts new content words', () => {
  assert.equal(Q.newContentWords('How do you test?', 'How do you test, right?'), 0);
  assert.equal(Q.newContentWords('How do you test?', 'How do you test distributed payment systems?'), 3);
});
