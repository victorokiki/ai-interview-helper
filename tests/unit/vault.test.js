// Obsidian export: note paths, names, properties, links, transcripts option,
// and the writer's rules for edited, foreign and deleted notes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('../../packages/core/vault');

const t0 = new Date(2026, 10, 10, 9, 30).getTime();
const data = () => ({
  now: new Date(2026, 10, 15, 12, 0).getTime(),
  jobs: [
    { id: 'j1', company: 'Contoso', role: 'SRE: Platform/Infra', stage: 'interviewing', interviewAt: new Date(2026, 10, 18, 10, 0).getTime(), interviewLink: 'https://meet.google.com/abc', url: 'https://jobs.example/1', contacts: 'Sam Lee, sam@contoso.example', notes: 'Referred by Kim.', jobDescription: 'Run Kubernetes.', createdAt: 1 },
    { id: 'j2', company: 'CON', role: '', stage: 'saved', createdAt: 2 },
    { id: 'j3', company: 'Contoso', role: 'SRE- Platform-Infra', stage: 'applied', createdAt: 3 },
  ],
  sessions: [
    { id: 's1', type: 'mock', jobId: 'j1', title: 'Mock (behavioral) — 1 question', startedAt: t0, answers: [{ kind: 'mock', question: 'Tell me about a failure.', myAnswer: 'I missed a deadline.', scores: { clarity: 7, overall: 6 }, answer: '### What worked\n- Honest.' }] },
    { id: 's2', type: 'live', jobId: 'j1', title: 'Contoso | screen?', startedAt: t0 + 3600000, summary: '## Overview\nGood.', speech: { wpm: 150, fillers: 4 }, transcript: [{ speaker: 'them', text: 'Why us?' }, { speaker: 'me', text: 'Scale.' }], answers: [] },
  ],
  artifacts: [{ id: 'a1', jobId: 'j1', kind: 'research', title: 'Company research · Contoso', content: 'They run 2,000 services. [1]', sources: [{ n: 1, url: 'https://contoso.example/about', title: 'About [Contoso]' }], createdAt: t0 }],
  lessons: [
    { id: 'l1', text: 'Lead with the result.', kind: 'structure', status: 'approved', jobId: null },
    { id: 'l2', text: 'Mention the Kubernetes move.', kind: 'company', status: 'approved', jobId: 'j1' },
    { id: 'l3', text: 'Pending', kind: 'content', status: 'suggested', jobId: null },
  ],
  facts: [{ category: 'skill', text: 'Go and Kafka' }],
  bank: [{ question: 'A | B?', type: 'general', times: 2, bestScore: 7 }],
});

test('notes, names and links', () => {
  const files = V.buildVault(data(), { folder: 'Interview Helper' });
  const paths = files.map((f) => f.path);
  assert.deepEqual(paths.slice(0, 3), ['Jobs/Contoso — SRE- Platform-Infra.md', 'Jobs/CON_.md', 'Jobs/Contoso — SRE- Platform-Infra (2).md'], 'illegal characters, reserved names and collisions');
  assert.ok(paths.includes('Sessions/2026-11-10 0930 Mock (behavioral) — 1 question.md'));
  assert.ok(paths.includes('Sessions/2026-11-10 1030 Contoso - screen-.md'));
  assert.ok(paths.includes('Documents/Company research · Contoso 2026-11-10.md'));
  for (const p of ['Lessons.md', 'Interview Brain.md', 'Question bank.md', 'Interview Helper.md']) assert.ok(paths.includes(p), p);

  const job = files[0].content;
  assert.match(job, /^---\ntags:\n  - "interview-helper"\n  - "job"\ncompany: "Contoso"\nrole: "SRE: Platform\/Infra"\nstage: "interviewing"\ninterview: "2026-11-18T10:00"\nposting: "https:\/\/jobs.example\/1"\nmeeting: "https:\/\/meet.google.com\/abc"\nsessions: 2\naverage_score: 6\n---\n/);
  assert.match(job, /\n# Contoso — SRE: Platform\/Infra\n\n> \[!info\] Written by Interview Helper\n> .*link to it\.\n\n\*\*Stage:\*\* Interviewing/, 'blank lines keep the info box, title and facts apart');
  assert.ok(!/\n\n\n/.test(job), 'no double blank lines');
  assert.match(job, /\[Join meeting\]\(https:\/\/meet\.google\.com\/abc\)/);
  assert.match(job, /## Lessons for this job\n\n- Mention the Kubernetes move\./);
  assert.match(job, /- \[\[Interview Helper\/Sessions\/2026-11-10 0930 Mock \(behavioral\) — 1 question\|Mock \(behavioral\) — 1 question\]\] · 2026-11-10 · score 6/);
  assert.match(job, /\[\[Interview Helper\/Documents\/Company research · Contoso 2026-11-10\|Company research · Contoso\]\]/);
  assert.ok(!job.includes('Pending'));

  const live = files.find((f) => f.path.includes('screen')).content;
  assert.match(live, /job: "\[\[Interview Helper\/Jobs\/Contoso — SRE- Platform-Infra\|Contoso — SRE: Platform\/Infra\]\]"/, 'job property is a link');
  assert.match(live, /### Overview/, 'summary headings nested under the note');
  assert.match(live, /Transcript \(2 lines\) not exported/);
  assert.ok(!live.includes('Why us?'));
  const withTranscript = V.buildVault(data(), { transcripts: true }).find((f) => f.path.includes('screen')).content;
  assert.match(withTranscript, /## Transcript\n\n\*\*Interviewer:\*\* Why us\?  \n\*\*Me:\*\* Scale\./);

  const doc = files.find((f) => f.path.startsWith('Documents/')).content;
  assert.match(doc, /## Sources\n\n1\. \[About Contoso\]\(https:\/\/contoso\.example\/about\)/);
  assert.match(files.find((f) => f.path === 'Question bank.md').content, /\| A \\\| B\? \| general \| 2 \| 7 \|/);
  const home = files.find((f) => f.path === 'Interview Helper.md').content;
  assert.match(home, /## Upcoming interviews\n\n- 2026-11-18 10:00 · \[\[Interview Helper\/Jobs\/Contoso — SRE- Platform-Infra\|/);
  assert.match(files.find((f) => f.path === 'Lessons.md').content, /## All interviews\n\n- \*\*structure:\*\* Lead with the result\./);
  // Same input, same output (no needless rewrites).
  assert.deepEqual(V.buildVault(data(), {}), V.buildVault(data(), {}));
});

test('writer: edited, foreign and deleted notes; nothing outside the subfolder', () => {
  // src/vault.js only needs fs and the core module (no Electron).
  const { writeVault, removeExport, MANIFEST } = require('../../src/vault');
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ih-vault-'));
  try {
    const sub = path.join(vaultPath, 'Interview Helper');
    fs.mkdirSync(path.join(sub, 'Jobs'), { recursive: true });
    fs.writeFileSync(path.join(sub, 'Jobs', 'CON_.md'), 'my own note');
    fs.writeFileSync(path.join(vaultPath, 'Daily.md'), 'untouched');
    const first = writeVault({ vaultPath, folder: 'Interview Helper', data: data() });
    assert.equal(first.notes, 10); // 3 jobs, 2 sessions, 1 document, 4 overview notes
    assert.equal(first.written, 9);
    assert.deepEqual(first.foreign, ['Jobs/CON_.md']);
    assert.equal(fs.readFileSync(path.join(sub, 'Jobs', 'CON_.md'), 'utf8'), 'my own note');

    const again = writeVault({ vaultPath, folder: 'Interview Helper', data: data() });
    assert.equal(again.written, 0, 'unchanged notes are not rewritten');

    // Edit a job note, then change that job and another in the app.
    const jobFile = path.join(sub, 'Jobs', 'Contoso — SRE- Platform-Infra.md');
    fs.appendFileSync(jobFile, '\nMy prep thoughts.');
    const d = data();
    d.jobs[0].notes = 'Changed in the app';
    d.jobs[2].notes = 'Also changed';
    d.sessions = d.sessions.slice(0, 1); // the live session was deleted
    const third = writeVault({ vaultPath, folder: 'Interview Helper', data: d });
    assert.deepEqual(third.edited, ['Jobs/Contoso — SRE- Platform-Infra.md']);
    assert.match(fs.readFileSync(jobFile, 'utf8'), /My prep thoughts\.$/);
    assert.match(fs.readFileSync(path.join(sub, 'Jobs', 'Contoso — SRE- Platform-Infra (2).md'), 'utf8'), /Also changed/);
    assert.equal(third.removed, 1);
    assert.ok(!fs.readdirSync(path.join(sub, 'Sessions')).some((f) => f.includes('screen')));

    // A note deleted in Obsidian comes back on the next export.
    fs.rmSync(path.join(sub, 'Lessons.md'));
    writeVault({ vaultPath, folder: 'Interview Helper', data: d });
    assert.ok(fs.existsSync(path.join(sub, 'Lessons.md')));

    assert.ok(JSON.parse(fs.readFileSync(path.join(sub, MANIFEST), 'utf8')).files['Lessons.md']);
    assert.throws(() => writeVault({ vaultPath: path.join(vaultPath, 'missing'), data: d }), /missing/);

    // "Delete everything": our unchanged notes go; edited and foreign ones stay.
    const removed = removeExport({ vaultPath, folder: 'Interview Helper' });
    assert.equal(removed, 7, '9 notes minus the edited one and the one that was already there');
    assert.ok(fs.existsSync(jobFile));
    assert.ok(fs.existsSync(path.join(sub, 'Jobs', 'CON_.md')));
    assert.ok(!fs.existsSync(path.join(sub, 'Lessons.md')));
    assert.equal(fs.readFileSync(path.join(vaultPath, 'Daily.md'), 'utf8'), 'untouched');
  } finally {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});
