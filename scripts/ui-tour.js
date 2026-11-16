// Screenshot tour of every screen with realistic demo data, for UI/UX review.
//
//   npx electron scripts/ui-tour.js [dark|light]
//
// Runs the real app against an isolated demo data folder and a fake local AI
// (so nothing leaves the PC), then writes PNGs to tests/e2e/out/tour/<theme>/.
// All names, companies and numbers are made up.
const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const THEME = process.argv.find((a) => a === 'light' || a === 'dark') || 'dark';
const ROOT = path.join(__dirname, '..');
const out = path.join(ROOT, 'tests', 'e2e', 'out', 'tour', THEME);
const userData = path.join(ROOT, 'tests', 'e2e', 'out', 'tour', `userdata-${THEME}`);
fs.rmSync(out, { recursive: true, force: true });
fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(path.join(userData, 'sessions'), { recursive: true });
app.setPath('userData', userData);

const DAY = 86400000;
const now = Date.now();

const ANSWER = `**Short version:** I'd start by making the blast radius small, then fix the root cause.

- **Contain:** roll back the last deploy behind the feature flag; at Northwind this cut our median recovery time from 42 to 11 minutes.
- **Communicate:** one incident channel, a status update every 15 minutes, one person talking to customers.
- **Fix and learn:** blameless review within 48 hours, with owners and dates for each action.

*If they ask for an example:* the payments outage in March, where a retry storm took checkout down for 9 minutes.`;
const GRADE = `SCORES clarity=8 structure=7 specificity=6 relevance=8 depth=7 overall=7
### What worked
- Clear opening and a logical order: contain, communicate, fix.
- You named a real metric (42 → 11 minutes), which makes it credible.
### What to improve
- Say what *you* did, not what "we" did, at least once.
- Close with the result for the business: how many orders were saved.
### Stronger answer
When checkout went down in March, I was incident commander. I rolled back the retry change behind its flag within four minutes, kept a single update channel going every fifteen minutes, and ran the review two days later. We added circuit breakers to every payment call, and the same failure hasn't recurred since.`;
const MATCH = `MATCH overall=78 skills=85 experience=80 impact=62
### Strengths for this role
- Kubernetes operations at scale (400 nodes at Northwind)
- Incident command and on-call redesign
### Gaps
- Terraform modules at org scale
- Formal SLO programme ownership
### Suggested rewrites
- **Before:** Worked on reliability → **After:** Led on-call redesign for 6 teams; pages per week down 58%
### Keywords to add
- error budgets (only if true)`;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = JSON.parse(body || '{}');
    if (!json.messages?.length) return res.end('{"done":true}');
    const user = json.messages.find((m) => m.role === 'user')?.content || '';
    let reply = 'Tell me about a time a production incident was your fault. What happened, and what did you change afterwards?';
    if (user.includes('Evaluate the answer')) reply = GRADE;
    else if (user.includes('MATCH overall=N')) reply = MATCH;
    else if (user.includes('<question>')) reply = ANSWER;
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    // Stream in small pieces like a real model.
    const parts = reply.match(/[\s\S]{1,40}/g);
    for (const p of parts) res.write(JSON.stringify({ message: { content: p }, done: false }) + '\n');
    res.end(JSON.stringify({ done: true }) + '\n');
  });
});

// A copy of the made-up Job Kit test folder for the import screen.
const kitCopy = path.join(ROOT, 'tests', 'e2e', 'out', 'tour', `job-search-${THEME}`);
const FAKE_KIT = 'C:\\Users\\Jordan\\Documents\\job-search';

function seed(port) {
  fs.rmSync(kitCopy, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'tests', 'fixtures', 'jobkit', 'job-search'), kitCopy, { recursive: true });
  const vaultDir = path.join(ROOT, 'tests', 'e2e', 'out', 'tour', `vault-${THEME}`);
  fs.rmSync(vaultDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(vaultDir, '.obsidian'), { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({
      provider: 'ollama',
      ollamaUrl: `http://127.0.0.1:${port}`,
      ollamaModel: 'llama3.1',
      transcription: 'local',
      jobsMigrated: true,
      liveNoticeAck: true,
      meetingDetection: false,
      activeJobId: 'contoso',
      theme: THEME,
      autoAnswer: true,
      vaultPath: path.join(ROOT, 'tests', 'e2e', 'out', 'tour', `vault-${THEME}`),
      jobKitFolder: kitCopy,
      jobSearch: { country: 'United States', state: 'WA', local_places: ['seattle', 'bellevue', 'redmond'], tracks: { reliability: { priority: 1, titles: ['site reliability', 'sre', 'platform engineer', 'infrastructure engineer'] }, devops: { priority: 0.7, titles: ['devops', 'cloud engineer'] } }, exclude_titles: ['principal', 'director', 'manager'], extra_skills: ['prometheus', 'pagerduty'], pathway: { type: 'none' } },
      workSituation: { authCountry: 'United States', workAuthDetails: 'US citizen', workAuthorized: 'yes', needsSponsorship: 'no' },
      resume: 'Jordan Lee — Senior Site Reliability Engineer\nNorthwind Traders (2021–now): led on-call redesign for 6 teams; Kubernetes platform, 400 nodes.\nAdatum (2017–2021): SRE, payments platform.',
    }),
  );
  fs.writeFileSync(
    path.join(userData, 'jobs.json'),
    JSON.stringify([
      {
        id: 'contoso', company: 'Contoso', role: 'Senior Site Reliability Engineer', stage: 'interviewing', interviewAt: now + 2 * DAY + 3 * 3600000, interviewLink: 'https://meet.google.com/abc-defg-hij', url: 'https://jobs.contoso.example/sre-142',
        jobDescription: `Location: Seattle, WA (hybrid)\nPay: $185,000 to $230,000\nPosted: ${new Date(now - 3 * DAY).toISOString().slice(0, 10)}\n\nOwn reliability for our Kubernetes platform (2,000+ services). Lead incident response, define SLOs and error budgets, and build Terraform modules used across the org. You will work with Go, Prometheus and PagerDuty.\n\nWhat you'll do: run the on-call rotation with five product teams, lead blameless reviews after incidents, and turn what we learn into automation. You will own capacity planning for the platform, help teams adopt service level objectives, and mentor two engineers who joined this year.\n\nWhat we look for: 5+ years of experience in site reliability or infrastructure roles, hands-on Kubernetes at scale, infrastructure as code, and calm communication during incidents. Experience with error budgets is an asset. You must be legally entitled to work in the United States.`,
        notes: 'Referred by Kim. Panel: hiring manager, staff engineer, recruiter.', contacts: 'Sam Lee, Hiring manager, sam.lee@contoso.example\nPriya Rao, Staff Engineer, priya@contoso.example', createdAt: now - 20 * DAY, updatedAt: now,
        jobKit: { id: 'A0003', folder: 'Applications/2026-11-02 Contoso - Senior Site Reliability Engineer', status: 'Interviewing', importedAt: now - DAY },
        application: {
          source: 'jobkit', folder: 'Applications/2026-11-02 Contoso - Senior Site Reliability Engineer', resumeFile: 'Jordan_Lee_Resume_Contoso.pdf',
          resumeText: 'Jordan Lee\nSenior Site Reliability Engineer\nNorthwind Traders (2021 to now)\n- Led the on-call redesign for 6 teams; pages per week fell 58%.\n- Cut median incident recovery time from 42 to 11 minutes with flag-based rollbacks.\n- Owned the Kubernetes platform (400 nodes).',
          letterFile: 'Jordan_Lee_Cover_Letter_Contoso.pdf', letterText: 'Dear Contoso hiring team,\nYour platform runs 2,000+ services; at Northwind I cut median recovery time from 42 to 11 minutes on a 400-node Kubernetes platform.\nJordan Lee',
          answers: [{ question: 'Why do you want to work at Contoso?', answer: 'Reliability at your scale is the work I enjoy most: I led the on-call redesign for 6 teams at Northwind and want to do the same for 2,000 services.' }],
          fields: [{ label: 'Salary expectations', value: '$205,000' }, { label: 'Earliest start date', value: 'Four weeks after an offer' }],
          changesBeforeSubmitting: ['Changed the salary expectation from $200,000 to $205,000.'], gaps: ['Formal SLO programme ownership: not on the resume. Ways to address it: point to the error budgets used in the on-call redesign.'], keywordGaps: 'Terraform modules at org scale', formLink: 'https://jobs.contoso.example/sre-142/apply', lean: false, importedAt: now - DAY,
        },
      },
      { id: 'northwind', company: 'Tailspin Toys', role: 'Platform Engineer', stage: 'applied', applyBy: now + 4 * DAY, followUpAt: now + DAY, followUpNote: 'Email the recruiter about timeline', jobDescription: 'Location: Bellevue, WA\n\nBuild the internal developer platform on Kubernetes with Go and Terraform. 3+ years of experience.', notes: '', createdAt: now - 12 * DAY, updatedAt: now },
      { id: 'fabrikam', company: 'Fabrikam', role: 'Staff Infrastructure Engineer', stage: 'screening', jobDescription: 'Location: Remote (US)\n\nLead infrastructure for our data platform. Must be a U.S. citizen able to obtain a security clearance. 8+ years of experience.', notes: '', createdAt: now - 6 * DAY, updatedAt: now },
    ]),
  );
  fs.writeFileSync(
    path.join(userData, 'facts.json'),
    JSON.stringify([
      { id: 'f1', category: 'experience', text: 'Senior SRE at Northwind Traders since 2021, owning the Kubernetes platform (400 nodes).', source: 'resume' },
      { id: 'f2', category: 'achievement', text: 'Led the on-call redesign for 6 teams at Northwind; pages per week fell 58%.', source: 'resume' },
      { id: 'f3', category: 'achievement', text: 'Cut median incident recovery time from 42 to 11 minutes with flag-based rollbacks.', source: 'resume' },
      { id: 'f4', category: 'story', text: 'March payments outage at Northwind: retry storm took checkout down for 9 minutes; I was incident commander.', source: 'added by me' },
      { id: 'f5', category: 'skill', text: 'Kubernetes, Terraform, Go, Prometheus, PagerDuty.', source: 'resume' },
      { id: 'f6', category: 'education', text: 'BSc Computer Science, University of Lagos, 2016.', source: 'resume' },
    ]),
  );
  // Practice over three weeks, getting better.
  const scenarios = ['behavioral', 'system-design', 'behavioral', 'technical', 'behavioral', 'system-design', 'general', 'behavioral'];
  scenarios.forEach((sc, i) => {
    const t = now - (21 - i * 2.5) * DAY;
    const base = 4.5 + i * 0.45;
    const sc5 = (d) => Math.max(1, Math.min(10, Math.round(base + d)));
    fs.writeFileSync(
      path.join(userData, 'sessions', `mock${i}.json`),
      JSON.stringify({
        id: `mock${i}`,
        type: 'mock',
        jobId: i % 3 === 2 ? 'fabrikam' : 'contoso',
        title: `Mock (${sc}) — 1 question`,
        startedAt: t,
        endedAt: t + 900000,
        answers: [
          {
            kind: 'mock',
            scenario: sc,
            question: ['Tell me about a time you disagreed with your manager.', 'Design a rate limiter for a public API.', 'Describe a production incident you led.', 'How does Kubernetes schedule a pod?', 'Tell me about a project you are proud of.', 'Design a metrics pipeline for 2,000 services.', 'Why do you want to leave Northwind?', 'Tell me about a time you failed.'][i],
            myAnswer: 'Answer text',
            answer: '### What worked\n- Clear.\n### What to improve\n- More numbers.',
            scores: { clarity: sc5(1), structure: sc5(0), specificity: sc5(-1.5), relevance: sc5(1), depth: sc5(0), overall: sc5(0) },
            speech: { words: 260, wpm: 182 - i * 4, fillers: 14 - i, durationSec: 90 },
            t,
          },
        ],
      }),
    );
  });
  fs.writeFileSync(
    path.join(userData, 'sessions', 'live1.json'),
    JSON.stringify({
      id: 'live1',
      type: 'live',
      jobId: 'contoso',
      title: 'Contoso recruiter screen',
      startedAt: now - 4 * DAY,
      endedAt: now - 4 * DAY + 1800000,
      speech: { words: 1400, wpm: 158, fillers: 31, durationSec: 530 },
      summary: '## Overview\nA 30-minute recruiter screen covering background, motivation and salary.\n## Questions asked\n- Why Contoso? — good, tied to platform scale.\n- Salary expectations — gave a range.\n## What went well\n- Clear story about the on-call redesign.\n## What to improve\n- Shorter answer on why you are leaving.\n## Follow-ups\n- Send portfolio link.\n## Thank-you note\nHi Sam, thanks for the conversation today…',
      transcript: [
        { speaker: 'them', text: 'Why are you interested in Contoso?' },
        { speaker: 'me', text: 'Your platform runs at a scale where reliability work really matters.' },
      ],
      answers: [{ kind: 'answer', question: 'Why are you interested in Contoso?', answer: 'Because…', t: now - 4 * DAY }],
    }),
  );
  fs.writeFileSync(
    path.join(userData, 'coding.json'),
    JSON.stringify(
      [
        ['two-sum', 'easy', 'python', 4, 4],
        ['valid-parentheses', 'easy', 'python', 5, 5],
        ['binary-search', 'easy', 'javascript', 3, 4],
        ['longest-substring', 'medium', 'python', 4, 6],
        ['merge-intervals', 'medium', 'python', 6, 6],
      ].map(([problemId, difficulty, language, passed, total], i) => ({ id: `c${i}`, problemId, difficulty, language, submitted: true, passed, total, hints: i % 2, ms: 40, at: now - (10 - i) * DAY })),
    ),
  );
  fs.writeFileSync(
    path.join(userData, 'artifacts.json'),
    JSON.stringify([
      { id: 'a1', jobId: 'contoso', kind: 'research', title: 'Company research · Contoso', content: '### What they do\nContoso runs a cloud platform for retailers, serving about 2,000 internal services. [1]\n### Recent news\n- Moved all workloads to Kubernetes in 2025. [2]\n### Pay range\n$185k–$230k base for Senior SRE in the US. [3]', sources: [{ n: 1, url: 'https://contoso.example/about', title: 'About Contoso' }, { n: 2, url: 'https://news.example/contoso-k8s', title: 'Contoso finishes Kubernetes move' }, { n: 3, url: 'https://pay.example/contoso', title: 'Contoso salaries' }], createdAt: now - 3 * DAY },
      { id: 'a2', jobId: 'contoso', kind: 'prep', title: 'Interview prep plan · Contoso', content: '### Focus areas\n- Incident command\n- SLOs and error budgets\n### Question plan\n1. [behavioral] Tell me about an incident you led — they stress incident response\n2. [system-design] Design an alerting pipeline for 2,000 services — JD scale\n3. [technical] How do you set an SLO for a new service? — JD mentions SLOs', plan: [{ type: 'behavioral', question: 'Tell me about an incident you led', why: 'they stress incident response' }, { type: 'system-design', question: 'Design an alerting pipeline for 2,000 services', why: 'JD scale' }, { type: 'technical', question: 'How do you set an SLO for a new service?', why: 'JD mentions SLOs' }], createdAt: now - 2 * DAY },
    ]),
  );
  // New job matches from the last search (made up; no network in the tour).
  const day = (n) => new Date(now - n * DAY).toISOString().slice(0, 10);
  fs.writeFileSync(
    path.join(userData, 'matches.json'),
    JSON.stringify({
      lastRun: now - 2 * 3600000,
      newCount: 3,
      found: 1840,
      counts: {},
      errors: [],
      matches: [
        { key: 'm1', fresh: true, source: 'greenhouse', company: 'Litware', title: 'Senior Site Reliability Engineer', location: 'Seattle, WA', url: 'https://boards.greenhouse.io/litware/jobs/1', posted: day(1), score: 91, why: 'title fits reliability; 6 of 7 skills match; near home; asks for 5+ years', gaps: ['terraform'], flags: [] },
        { key: 'm2', fresh: true, source: 'lever', company: 'Adventure Works', title: 'Platform Engineer, Kubernetes', location: 'Bellevue, WA (hybrid)', url: 'https://jobs.lever.co/adventureworks/2', posted: day(2), score: 86, why: 'title fits reliability; 5 of 6 skills match; near home; asks for 4+ years', gaps: [], flags: [] },
        { key: 'm3', fresh: true, source: 'simplify-newgrad', company: 'Proseware', title: 'Infrastructure Engineer', location: 'Remote in USA', url: 'https://proseware.example/jobs/3', posted: day(2), score: 78, why: 'title fits reliability; 4 of 6 skills match; remote in the country', gaps: ['ansible'], flags: [] },
        { key: 'm4', fresh: false, source: 'remotive', company: 'Wingtip Toys', title: 'DevOps Engineer', location: 'Remote (US)', url: 'https://remotive.com/remote-jobs/devops/4', posted: day(6), score: 69, why: 'title fits devops; 4 of 7 skills match; remote in the country', gaps: ['aws', 'jenkins'], flags: [] },
      ],
      seen: {},
    }),
  );
  fs.writeFileSync(
    path.join(userData, 'lessons.json'),
    JSON.stringify([
      { id: 'l1', text: 'Use the March payments outage story for questions about failure or pressure.', kind: 'story', why: '', source: 'ai', jobId: null, status: 'approved', createdAt: now - 6 * DAY, decidedAt: now - 6 * DAY },
      { id: 'l2', text: 'Lead with the result in one sentence, then explain.', kind: 'structure', why: '', source: 'metrics', jobId: null, status: 'approved', createdAt: now - 5 * DAY, decidedAt: now - 5 * DAY },
      { id: 'l3', text: "Mention Contoso's 2025 Kubernetes move when asked why this company.", kind: 'company', why: '', source: 'ai', jobId: 'contoso', status: 'approved', createdAt: now - 3 * DAY, decidedAt: now - 3 * DAY },
      { id: 'l4', text: 'Slow down to about 140–160 words a minute; pause after each key point.', kind: 'delivery', why: 'You averaged 182 words a minute.', source: 'metrics', jobId: null, status: 'suggested', createdAt: now - DAY, decidedAt: null },
    ]),
  );
}

server.listen(0, () => {
  seed(server.address().port);
  require(path.join(ROOT, 'src', 'main.js'));
});

let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return;
  started = true;
  win.webContents.once('did-finish-load', async () => {
    const js = (code, w = win) => w.webContents.executeJavaScript(code);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (code, ms = 8000, w = win) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await js(code, w).catch(() => false)) return true;
        await wait(60);
      }
      return false;
    };
    const shots = [];
    const shot = async (name, label, w = win) => {
      await wait(250);
      fs.writeFileSync(path.join(out, `${name}.png`), (await w.webContents.capturePage()).toPNG());
      shots.push({ name, label });
    };
    const tab = (t) => js(`document.querySelector('.tab[data-tab="${t}"]').click(); 0`);
    const scrollTo = (sel, block = 'start') => js(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: '${block}' }); 0`);
    try {
      await wait(1500);
      // Live: a call in progress with an answer.
      await js(`(() => {
        addTranscriptLine({ speaker: 'them', text: 'Thanks for joining. To start, walk me through how you handle a major production incident.' });
        addTranscriptLine({ speaker: 'me', text: 'Sure. The first thing I do is make the blast radius smaller…' });
        try { setChip('them', 'listening'); setChip('me', 'listening'); } catch {}
        document.querySelector('#startBtn').textContent = 'Stop session';
        document.querySelector('#startBtn').classList.replace('primary', 'danger');
        document.querySelector('#liveDot').classList.add('live');
        document.querySelector('#askInput').value = 'Walk me through how you handle a major production incident.';
        document.querySelector('#answerBtn').click();
      })(); 0`);
      await until(`/If they ask for an example/.test(document.querySelector('#answers .card .body')?.textContent || '')`);
      await shot('live', 'Live: transcript and a streamed answer');
      // The local fact check under the finished answer.
      await until(`!!document.querySelector('#answers .card .fact-note')`, 8000);
      await js(`document.querySelector('#answers .card .fact-note')?.scrollIntoView({ block: 'end' }); 0`);
      await shot('fact-check', 'Live: fact check under an answer');
      await js('window.api.setCompact(true)');
      await wait(700);
      await shot('compact', 'Compact view: the floating copilot');
      await js('window.api.setCompact(false)');
      await wait(700);

      // Mock: question and feedback.
      await tab('mock');
      await js(`document.querySelector('#mockSpeak').checked = false; document.querySelector('#mockNextBtn').click(); 0`);
      await until(`/production incident/.test(document.querySelector('#mockQuestion').textContent)`);
      await shot('mock-question', 'Mock: a practice question');
      await js(`document.querySelector('#mockAnswer').value = 'When checkout went down in March, we rolled back the retry change and kept customers updated every 15 minutes. Recovery took 9 minutes.'; document.querySelector('#mockSubmitBtn').click(); 0`);
      await until(`/Stronger answer/.test(document.querySelector('#mockFeedback').textContent)`);
      await scrollTo('#mockFeedback');
      await shot('mock-feedback', 'Mock: scores and feedback');

      // Jobs.
      await tab('jobs');
      await until(`document.querySelectorAll('#jobList li').length === 3`);
      await shot('jobs', 'Jobs: list with fit scores, stages, reminders and deadlines');
      // New job matches (from the seeded last search).
      await js(`document.querySelector('#matchesBox').open = true; 0`);
      await until(`document.querySelectorAll('#matchList li [data-act="add"]').length === 4`);
      await scrollTo('#matchesBox');
      await shot('matches', 'Jobs: new job matches');
      await js(`document.querySelector('#matchesBox').open = false; 0`);
      // Import from Job Kit: the review list (a copy of the made-up test folder).
      await js(`document.querySelector('#importJobKit').click(); 0`);
      await until(`!document.querySelector('#jobkitReview').hidden`, 15000);
      await js(`document.querySelector('#jobkitHint').textContent = document.querySelector('#jobkitHint').textContent.replace(/^Folder: .*?\\./, ${JSON.stringify('Folder: C:\\Users\\Jordan\\Documents\\job-search.')}); 0`);
      await scrollTo('#jobkitReview');
      await shot('jobkit-review', 'Jobs: Import from Job Kit review');
      await js(`document.querySelector('#jobkitCancel').click(); 0`);
      await js(`document.querySelector('#jobList li').click(); 0`);
      await until(`!document.querySelector('#jobForm').hidden`);
      await shot('job-editor', 'Jobs: editing a job');
      await until(`!document.querySelector('#jobCheck').hidden`);
      await scrollTo('#jobCheck');
      await shot('job-check', 'Jobs: job check (fit, warnings, eligibility)');
      await js(`document.querySelector('#sentBox').open = true; 0`);
      await scrollTo('#sentBox');
      await shot('sent', 'Jobs: what you sent');
      await scrollTo('#careerTools');
      await shot('career-tools', 'Jobs: career tools and saved documents');
      await js(`document.querySelector('#careerTools [data-tool="check"]').click(); 0`);
      await until(`/% match/.test(document.querySelector('#careerOutput')?.innerText || '')`, 10000);
      await scrollTo('#careerOutput');
      await shot('resume-check', 'Jobs: resume check with match score and keywords');

      // Profile.
      await tab('profile');
      await until(`document.querySelectorAll('#factList li textarea').length >= 6`);
      await scrollTo('#factList', 'center');
      await shot('profile-brain', 'Profile: Interview Brain facts');
      await until(`document.querySelectorAll('#lessonList .lesson').length >= 3`);
      await scrollTo('#memory');
      await shot('profile-memory', 'Profile: memory (lessons)');
      await js(`document.querySelector('#searchBox').open = true; 0`);
      await until(`document.querySelector('#searchCountry').value === 'United States'`);
      await scrollTo('#searchBox');
      await shot('profile-search', 'Profile: your job search');

      // Progress.
      await tab('history');
      await until(`!!document.querySelector('#bankCard')`);
      await js(`document.querySelector('#tab-history').scrollTop = 0; 0`);
      await shot('progress', 'Progress: scores, skills and trends');
      await scrollTo('#nextSteps');
      await shot('progress-next', 'Progress: next steps');
      await scrollTo('#bankCard');
      await shot('progress-bank', 'Progress: question bank');
      await scrollTo('#historyTitle');
      await shot('history', 'Progress: session history');

      // Settings.
      await tab('settings');
      await until(`document.querySelector('#mcpConfig').textContent.includes('mcpServers')`);
      // An installed app's paths for a made-up user, instead of this PC's dev folder.
      const base = 'C:\\Users\\Jordan\\AppData\\Local\\Programs\\Interview Helper';
      const demoMcp = { mcpServers: { 'interview-helper': { command: `${base}\\Interview Helper.exe`, args: [`${base}\\resources\\app.asar\\src\\mcp\\server.js`], env: { ELECTRON_RUN_AS_NODE: '1' } } } };
      await js(`document.querySelector('#mcpConfig').textContent = ${JSON.stringify(JSON.stringify(demoMcp, null, 2))}; 0`);
      await js(`document.querySelector('#tab-settings').scrollTop = 0; 0`);
      await shot('settings', 'Settings: AI model and transcription');
      await scrollTo('#shortcutList', 'center');
      await shot('settings-window', 'Settings: window and shortcuts');
      await scrollTo('#mcpConfig', 'center');
      await shot('settings-connect', 'Settings: MCP and browser extension');
      await js(`window.api.vaultSync()`);
      await scrollTo('#vaultStatus', 'center');
      // Show a made-up vault path instead of this PC's folder.
      // (re-applied whenever a background sync redraws the status).
      await js(`(() => {
        const fake = ${JSON.stringify('C:\\Users\\Jordan\\Documents\\Career vault')};
        const swap = () => document.querySelectorAll('#vaultStatus code').forEach((c) => c.textContent !== fake && (c.textContent = fake));
        swap();
        new MutationObserver(swap).observe(document.querySelector('#vaultStatus'), { childList: true, subtree: true, characterData: true });
      })(); 0`);
      await shot('settings-obsidian', 'Settings: Obsidian export');
      await until(`/Job-search folder/.test(document.querySelector('#jobkitStatus').textContent)`);
      await js(`document.querySelectorAll('#jobkitStatus code').forEach((c) => (c.textContent = ${JSON.stringify(FAKE_KIT)})); 0`);
      await scrollTo('.jobkit-card', 'center');
      await shot('settings-jobkit', 'Settings: Autonomous Job Kit and browser extension');
      await until(`/stored in/.test(document.querySelector('#dataInfo').textContent)`);
      await js(`document.querySelector('#dataInfo').textContent = document.querySelector('#dataInfo').textContent.replace(/stored in .*$/, ${JSON.stringify('stored in C:\\Users\\Jordan\\AppData\\Roaming\\Interview Helper')}); 0`);
      await scrollTo('.share-card', 'center');
      await shot('settings-sharing', 'Settings: screen sharing status');
      await scrollTo('#dataFlows');
      await shot('settings-privacy', 'Settings: privacy and data');

      // Coding Lab window.
      const labPromise = new Promise((resolve) => app.once('browser-window-created', (_e2, w) => resolve(w)));
      await js(`window.api.openLab(); 0`);
      const lab = await labPromise;
      await new Promise((r) => lab.webContents.once('did-finish-load', r));
      await until(`!!document.querySelector('.monaco-editor')`, 15000, lab);
      await wait(1500);
      await shot('codelab', 'Coding Lab window', lab);
      lab.destroy();

      // Browser extension popup (rendered with a stand-in for the Chrome API).
      const raw = { url: 'https://jobs.contoso.example/sre-142', title: 'Senior Site Reliability Engineer at Contoso', jsonLd: [JSON.stringify({ '@type': 'JobPosting', title: 'Senior Site Reliability Engineer', hiringOrganization: { name: 'Contoso' }, description: '<p>Own reliability for our Kubernetes platform.</p><ul><li>Incident response</li><li>SLOs and error budgets</li></ul>', jobLocationType: 'TELECOMMUTE' })], selection: '', text: '' };
      fs.writeFileSync(path.join(out, 'raw.json'), JSON.stringify(raw));
      const popup = new BrowserWindow({ show: false, width: 380, height: 540, useContentSize: true, webPreferences: { preload: path.join(ROOT, 'tests', 'e2e', 'tour-stub.js'), contextIsolation: false, sandbox: false, additionalArguments: [`--raw=${path.join(out, 'raw.json')}`] } });
      popup.webContents.on('did-finish-load', () => popup.webContents.insertCSS(`:root { color-scheme: ${THEME}; }`));
      await popup.loadFile(path.join(ROOT, 'extension', 'popup.html'));
      await until(`/Connected/.test(document.querySelector('#statusText').textContent)`, 5000, popup);
      await wait(500);
      await shot('extension', 'Browser extension popup', popup);
      popup.destroy();
      // The extension's autofill profile page (same stand-in, made-up profile).
      const opts = new BrowserWindow({ show: false, width: 900, height: 760, useContentSize: true, webPreferences: { preload: path.join(ROOT, 'tests', 'e2e', 'tour-stub.js'), contextIsolation: false, sandbox: false, additionalArguments: [`--raw=${path.join(out, 'raw.json')}`] } });
      opts.webContents.on('did-finish-load', () => opts.webContents.insertCSS(`:root { color-scheme: ${THEME}; }`));
      await opts.loadFile(path.join(ROOT, 'extension', 'options', 'options.html'));
      await wait(1200);
      await shot('extension-options', 'Browser extension: autofill profile', opts);
      opts.destroy();
      fs.rmSync(path.join(out, 'raw.json'), { force: true });

      fs.writeFileSync(path.join(out, 'shots.json'), JSON.stringify(shots, null, 2));
    } catch (err) {
      fs.writeFileSync(path.join(out, 'error.txt'), err.stack);
    }
    server.close();
    app.exit(0);
  });
});
