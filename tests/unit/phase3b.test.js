const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../../packages/core/echo');
const Q = require('../../packages/core/question');
const C = require('../../packages/core/coaching');
const P = require('../../packages/core/prompts');
const { parseActive } = require('../../src/meeting');

const them = { speaker: 'them', text: 'How would you design a rate limiter for a public API?', startedAt: 10000, t: 14000 };

test('mic copy of the interviewer during their speech is echo', () => {
  assert.equal(E.isEcho({ speaker: 'me', text: 'how would you design a rate limiter for a public', startedAt: 10300, t: 14200 }, them), true);
});

test('repeating the question back later, with own words, is not echo', () => {
  assert.equal(E.isEcho({ speaker: 'me', text: "So you're asking how I would design a rate limiter, let me think", startedAt: 17000, t: 19000 }, them), false);
});

test('a real answer overlapping in time is not echo', () => {
  assert.equal(E.isEcho({ speaker: 'me', text: 'Sure, I would start with a token bucket per client', startedAt: 13000, t: 16000 }, them), false);
});

test('very short mic fragments are never dropped', () => {
  assert.equal(E.isEcho({ speaker: 'me', text: 'rate limiter', startedAt: 11000, t: 11500 }, them), false);
});

test('question types', () => {
  assert.equal(Q.questionType('Tell me about a time you disagreed with your manager?'), 'behavioral');
  assert.equal(Q.questionType('How would you design a rate limiter for 50k requests per second?'), 'system-design');
  assert.equal(Q.questionType('What is the difference between a process and a thread?'), 'technical');
  assert.equal(Q.questionType('Why do you want to work here?'), 'motivation');
  assert.equal(Q.questionType('What are your salary expectations?'), 'salary');
  assert.equal(Q.questionType('Implement a function to reverse a linked list.'), 'coding');
  assert.equal(Q.questionType('How are you today?'), 'general');
  for (const t of ['behavioral', 'technical', 'system-design', 'coding', 'motivation', 'salary']) assert.ok(P.TYPE_GUIDES[t].length > 20);
});

test('adaptive difficulty moves with recent scores', () => {
  assert.equal(C.nextDifficulty('medium', [8, 9]), 'hard');
  assert.equal(C.nextDifficulty('medium', [4, 5]), 'easy');
  assert.equal(C.nextDifficulty('hard', [9, 9]), 'hard');
  assert.equal(C.nextDifficulty('easy', [3]), 'easy');
  assert.equal(C.nextDifficulty('medium', [6, 7]), 'medium');
  assert.equal(C.nextDifficulty(null, []), 'medium');
});

test('panel has four interviewers and rewrites cover three modes', () => {
  assert.deepEqual(P.PANEL.map((p) => p.id), ['recruiter', 'manager', 'tech', 'hr']);
  assert.deepEqual(Object.keys(P.REWRITES), ['shorter', 'longer', 'regenerate']);
});

// Format copied from `reg query ...ConsentStore\microphone /s` on Windows 11.
const REG = [
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone',
  '    Value    REG_SZ    Allow',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\MSTeams_8wekyb3d8bbwe',
  '    Value    REG_SZ    Allow',
  '    LastUsedTimeStart    REG_QWORD    0x1dd53088e9b9184',
  '    LastUsedTimeStop    REG_QWORD    0x0',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\Microsoft.WindowsSoundRecorder_8wekyb3d8bbwe',
  '    LastUsedTimeStart    REG_QWORD    0x1dd1c04e0709edc',
  '    LastUsedTimeStop    REG_QWORD    0x0',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Users#me#AppData#Roaming#Zoom#bin#Zoom.exe',
  '    LastUsedTimeStart    REG_QWORD    0x1dd53088e9b9184',
  '    LastUsedTimeStop    REG_QWORD    0x1dd530b2634d248',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Program Files#Google#Chrome#Application#chrome.exe',
  '    LastUsedTimeStart    REG_QWORD    0x1dd53088e9b9184',
  '    LastUsedTimeStop    REG_QWORD    0x0',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Program Files#Interview Helper#Interview Helper.exe',
  '    LastUsedTimeStart    REG_QWORD    0x1dd53088e9b9184',
  '    LastUsedTimeStop    REG_QWORD    0x0',
].join('\r\n');

test('meeting detection: call apps using the mic now, not our own app or ended calls', () => {
  const active = parseActive(REG, 'Interview Helper.exe').map((a) => a.app);
  assert.deepEqual(active, ['Microsoft Teams', 'Chrome']);
});

test('meeting detection: audio sessions (current Windows 11) parsed into call apps', () => {
  const { parseSessions } = require('../../src/meeting');
  const out = '19388\tchrome\r\n2210\tms-teams\r\n4410\tZoom\r\n77\tInterview Helper\r\n99\taudiodg\r\n19400\tchrome\r\n';
  assert.deepEqual(parseSessions(out, 'Interview Helper.exe').map((a) => a.app), ['Chrome', 'Microsoft Teams', 'Zoom']);
  assert.deepEqual(parseSessions('', 'x.exe'), []);
});

// Real check on Windows: the probe compiles and answers (no call app needs to run).
test('meeting detection: the audio-session probe runs on this PC', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const meeting = require('../../src/meeting');
  const first = await meeting.querySessions('node.exe');
  assert.ok(Array.isArray(first));
  const t = Date.now();
  await meeting.querySessions('node.exe');
  assert.ok(Date.now() - t < 1000, 'later checks are fast');
  meeting.stopProbe();
});
