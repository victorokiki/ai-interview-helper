// Starts the real MCP server over stdio with the official SDK client against
// a fixture data folder, lists its tools and calls each one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ih-mcp-'));
  fs.mkdirSync(path.join(dir, 'sessions'));
  fs.writeFileSync(path.join(dir, 'jobs.json'), JSON.stringify([{ id: 'j1', company: 'Contoso', role: 'SRE', stage: 'interviewing', jobDescription: 'Run Kubernetes', interviewAt: Date.UTC(2026, 11, 1), followUpNotifiedAt: 5 }]));
  fs.writeFileSync(path.join(dir, 'facts.json'), JSON.stringify([{ id: 'f1', category: 'skill', text: 'Go and Kafka' }, { id: 'f2', category: 'achievement', text: 'Cut latency 60%' }]));
  fs.writeFileSync(path.join(dir, 'lessons.json'), JSON.stringify([{ id: 'l1', text: 'Lead with the result', kind: 'structure', jobId: null, status: 'approved', decidedAt: 5 }, { id: 'l2', text: 'Mention the Azure migration', kind: 'content', jobId: 'j1', status: 'approved', decidedAt: 6 }, { id: 'l3', text: 'Pending one', kind: 'content', jobId: null, status: 'suggested' }, { id: 'l4', text: 'Dismissed one', kind: 'content', jobId: null, status: 'dismissed' }]));
  fs.writeFileSync(path.join(dir, 'artifacts.json'), JSON.stringify([{ id: 'a1', jobId: 'j1', kind: 'prep', title: 'Interview prep plan · Contoso', content: '### Question plan\n1. [behavioral] Tell me about an outage — SRE', plan: [{ type: 'behavioral', question: 'Tell me about an outage', why: 'SRE' }], createdAt: 50 }]));
  fs.writeFileSync(
    path.join(dir, 'sessions', 's1.json'),
    JSON.stringify({ id: 's1', type: 'mock', jobId: 'j1', title: 'Mock (behavioral) — 1 question', startedAt: 10, answers: [{ kind: 'mock', scenario: 'behavioral', question: 'Tell me about an outage you handled', myAnswer: 'I led the incident', answer: 'Good', scores: { clarity: 7, specificity: 5, overall: 6 }, t: 11 }] }),
  );
  return dir;
}

test('MCP server exposes read-only tools that return the user data', { timeout: 60000 }, async () => {
  const dir = fixture();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', '..', 'src', 'mcp', 'server.js')],
    env: { ...process.env, INTERVIEW_HELPER_DATA: dir },
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['get_document', 'get_interview_brain', 'get_job', 'get_lessons', 'get_progress', 'get_session', 'list_jobs', 'question_bank', 'search_sessions']);
    assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true), 'every tool is marked read-only');

    const call = async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return { text: r.content[0].text, isError: r.isError };
    };
    const jobs = JSON.parse((await call('list_jobs')).text);
    assert.equal(jobs[0].company, 'Contoso');
    const job = JSON.parse((await call('get_job', { job_id: 'j1' })).text);
    assert.equal(job.documents[0].kind, 'prep');
    assert.equal(job.followUpNotifiedAt, undefined, 'internal fields are not exposed');
    assert.match((await call('get_interview_brain')).text, /## skill\n- Go and Kafka/);
    const progress = JSON.parse((await call('get_progress')).text);
    assert.equal(progress.practiceCount, 1);
    assert.ok(progress.nextSteps.length >= 1);
    const hits = JSON.parse((await call('search_sessions', { query: 'outage' })).text);
    assert.equal(hits[0].id, 's1');
    assert.equal(JSON.parse((await call('get_session', { session_id: 's1' })).text).questions[0].scores.overall, 6);
    assert.match(JSON.parse((await call('get_document', { document_id: 'a1' })).text).content, /Question plan/);
    const bank = JSON.parse((await call('question_bank')).text);
    assert.equal(bank.length, 1, 'the planned and practised outage question are merged');
    assert.equal(bank[0].bestScore, 6);
    const lessons = JSON.parse((await call('get_lessons')).text);
    assert.deepEqual(lessons.lessons.map((l) => [l.text, l.appliesTo]), [['Lead with the result', 'all interviews'], ['Mention the Azure migration', 'Contoso — SRE']]);
    assert.equal(lessons.waitingForReview, 1, 'suggestions are counted, not returned');
    assert.equal(JSON.parse((await call('get_lessons', { job_id: 'other' })).text).lessons.length, 1, 'job lessons only for that job');
    const missing = await call('get_job', { job_id: 'nope' });
    assert.equal(missing.isError, true);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
