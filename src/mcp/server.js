// Interview Helper MCP server (stdio): lets Claude Desktop and other MCP
// clients read the user's interview-prep data on this PC. Read-only by design.
//
// Run by the MCP client, not by the app:
//   command: <Interview Helper.exe>   env: ELECTRON_RUN_AS_NODE=1
//   args:    <resources/app.asar/src/mcp/server.js>
// Data folder: INTERVIEW_HELPER_DATA, else %APPDATA%\Interview Helper.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const records = require('../../packages/core/records');
const coaching = require('../../packages/core/coaching');
const bank = require('../../packages/core/bank');
const lessonsCore = require('../../packages/core/lessons');
const CHALLENGES = require('../../packages/core/challenges.json');

const DATA =
  process.env.INTERVIEW_HELPER_DATA ||
  path.join(process.env.APPDATA || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config')), 'Interview Helper');

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8'));
  } catch {
    return fallback;
  }
}

function sessions() {
  const dir = path.join(DATA, 'sessions');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.startedAt - a.startedAt);
}

const date = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : null);
const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const notFound = (what) => ({ content: [{ type: 'text', text: `${what} not found.` }], isError: true });
const READ_ONLY = { readOnlyHint: true, openWorldHint: false };

const server = new McpServer({ name: 'interview-helper', version: '1.0.0' });

server.registerTool(
  'list_jobs',
  { title: 'List jobs', description: 'Job applications the user is preparing for: company, role, stage, interview date, follow-up and deadline.', inputSchema: {}, annotations: READ_ONLY },
  async () =>
    text(
      readJson('jobs.json', []).map((j) => ({
        id: j.id,
        company: j.company,
        role: j.role,
        stage: j.stage,
        interview: date(j.interviewAt),
        applyBy: date(j.applyBy),
        followUp: date(j.followUpAt),
        followUpNote: j.followUpNote || undefined,
      })),
    ),
);

server.registerTool(
  'get_job',
  { title: 'Get a job', description: 'One job in full (job description, notes, contacts), what the user already sent the employer when imported from Autonomous Job Kit (resume, cover letter, form answers, known gaps), and the career documents saved for it.', inputSchema: { job_id: z.string() }, annotations: READ_ONLY },
  async ({ job_id }) => {
    const job = readJson('jobs.json', []).find((j) => j.id === job_id);
    if (!job) return notFound('Job');
    const docs = readJson('artifacts.json', [])
      .filter((a) => a.jobId === job_id)
      .map((a) => ({ id: a.id, kind: a.kind, title: a.title, created: date(a.createdAt) }));
    const { followUpNotifiedAt, deadlineNotifiedAt, interviewNotifiedAt, interviewSoonNotifiedAt, ...rest } = job;
    return text({ ...rest, interviewAt: date(job.interviewAt), applyBy: date(job.applyBy), followUpAt: date(job.followUpAt), documents: docs });
  },
);

server.registerTool(
  'get_interview_brain',
  { title: 'Get Interview Brain facts', description: "The user's verified career facts (roles, projects, achievements, skills, stories). Use only these for claims about the user.", inputSchema: {}, annotations: READ_ONLY },
  async () => {
    const facts = readJson('facts.json', []);
    if (!facts.length) return text('No Interview Brain facts yet.');
    const groups = {};
    for (const f of facts) (groups[f.category] ||= []).push(f.text);
    return text(Object.entries(groups).map(([k, v]) => `## ${k}\n${v.map((t) => `- ${t}`).join('\n')}`).join('\n\n'));
  },
);

server.registerTool(
  'get_progress',
  { title: 'Get practice progress', description: 'Practice scores (overall, per skill, per question type), speaking pace and filler words, Coding Lab results, and suggested next steps.', inputSchema: { job_id: z.string().optional() }, annotations: READ_ONLY },
  async ({ job_id }) => {
    const recs = records.analyticsRecords(sessions()).filter((r) => !job_id || r.jobId === job_id);
    const agg = coaching.aggregate(recs);
    const attempts = readJson('coding.json', []);
    const codingAgg = attempts.length ? coaching.aggregateCoding(attempts, CHALLENGES) : null;
    const { series, ...summary } = agg;
    return text({ ...summary, coding: codingAgg, nextSteps: coaching.learningPath(agg, codingAgg).map(({ title, detail }) => ({ title, detail })) });
  },
);

server.registerTool(
  'search_sessions',
  { title: 'Search interview sessions', description: 'Full-text search over live interviews and mock practice (transcripts, answers, summaries).', inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(50).optional() }, annotations: READ_ONLY },
  async ({ query, limit = 10 }) => {
    const all = sessions();
    const hits = records.searchSessions(all, query).slice(0, limit);
    return text(hits.map((h) => ({ ...h, title: all.find((s) => s.id === h.id)?.title, date: date(all.find((s) => s.id === h.id)?.startedAt) })));
  },
);

server.registerTool(
  'get_session',
  { title: 'Get a session', description: 'One interview or mock session: summary, transcript (last 200 lines) and questions with feedback.', inputSchema: { session_id: z.string() }, annotations: READ_ONLY },
  async ({ session_id }) => {
    const s = sessions().find((x) => x.id === session_id);
    if (!s) return notFound('Session');
    return text({
      title: s.title,
      type: s.type,
      started: date(s.startedAt),
      summary: s.summary || null,
      transcript: (s.transcript || []).slice(-200).map((l) => `${l.speaker === 'me' ? 'Me' : 'Interviewer'}: ${l.text}`),
      questions: (s.answers || []).map((a) => ({ kind: a.kind, question: a.question, myAnswer: a.myAnswer, feedback: a.answer, scores: a.scores })),
    });
  },
);

server.registerTool(
  'get_document',
  { title: 'Get a career document', description: 'A saved resume check, tailored resume, cover letter, LinkedIn text, follow-up email, company research (with sources) or prep plan.', inputSchema: { document_id: z.string() }, annotations: READ_ONLY },
  async ({ document_id }) => {
    const a = readJson('artifacts.json', []).find((x) => x.id === document_id);
    if (!a) return notFound('Document');
    return text({ title: a.title, kind: a.kind, created: date(a.createdAt), content: a.content, sources: a.sources, plan: a.plan, match: a.match });
  },
);

server.registerTool(
  'question_bank',
  { title: 'Question bank', description: 'Every question the user was asked or practised (merged when worded differently), how often, and their best score.', inputSchema: { filter: z.string().optional() }, annotations: READ_ONLY },
  async ({ filter }) => {
    const plans = readJson('artifacts.json', []).filter((a) => a.kind === 'prep');
    const f = (filter || '').toLowerCase();
    return text(
      bank
        .questionBank(sessions(), plans)
        .filter((q) => !f || q.question.toLowerCase().includes(f))
        .slice(0, 50)
        .map((q) => ({ question: q.question, type: q.type, asked: q.times, bestScore: q.bestScore, sources: q.sources, last: date(q.lastAt) })),
    );
  },
);

server.registerTool(
  'get_lessons',
  { title: 'Get kept lessons', description: "Lessons the user kept from past interviews and practice (delivery, structure, content, stories), general or for one job. Use them when coaching the user. Only lessons the user approved are returned.", inputSchema: { job_id: z.string().optional() }, annotations: READ_ONLY },
  async ({ job_id }) => {
    const all = readJson('lessons.json', []);
    const kept = job_id ? lessonsCore.applicable(all, job_id) : all.filter((l) => l.status === 'approved');
    const jobsById = Object.fromEntries(readJson('jobs.json', []).map((j) => [j.id, [j.company, j.role].filter(Boolean).join(' — ')]));
    return text({
      lessons: kept.map((l) => ({ text: l.text, kind: l.kind, appliesTo: l.jobId ? jobsById[l.jobId] || 'a deleted job' : 'all interviews', kept: date(l.decidedAt) })),
      waitingForReview: all.filter((l) => l.status === 'suggested').length,
    });
  },
);

server.connect(new StdioServerTransport()).catch((err) => {
  process.stderr.write(`Interview Helper MCP server failed: ${err.message}\n`);
  process.exit(1);
});
