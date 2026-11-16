// End-to-end test of Phase 4b: job tracker reminders, the company prep plan
// feeding Mock, the question bank and next steps in Progress, and the MCP
// configuration in Settings. Fake local provider.
const { app } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, 'out', 'phase4b');
fs.rmSync(out, { recursive: true, force: true });
const userData = path.join(out, 'userdata');
fs.mkdirSync(path.join(userData, 'sessions'), { recursive: true });
app.setPath('userData', userData);

const prompts = [];
const PLAN = '### Focus areas\n- reliability\n### Gaps to prepare\n- Kubernetes\n### Stories to have ready\n- outage\n### Question plan\n1. [behavioral] Tell me about the worst outage you handled — SRE role\n2. [system-design] How would you design our alerting pipeline? — JD mentions alerting\n3. [motivation] Why do you want to join Contoso? — always asked';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = JSON.parse(body || '{}');
    if (!json.messages?.length) return res.end('{"done":true}');
    const user = json.messages.find((m) => m.role === 'user')?.content || '';
    prompts.push(user);
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { content: user.includes('### Question plan') ? PLAN : 'What is a question?' }, done: false }) + '\n');
    res.end(JSON.stringify({ done: true }) + '\n');
  });
});

server.listen(0, () => {
  const port = server.address().port;
  fs.writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({ provider: 'ollama', ollamaUrl: `http://127.0.0.1:${port}`, ollamaModel: 'fake', transcription: 'local', jobsMigrated: true, liveNoticeAck: true, meetingDetection: false, resume: 'Jordan Lee, SRE at Northwind.' }),
  );
  fs.writeFileSync(path.join(userData, 'jobs.json'), JSON.stringify([{ id: 'job1', company: 'Contoso', role: 'SRE', stage: 'interviewing', jobDescription: 'Run Kubernetes and alerting.', notes: '' }]));
  fs.writeFileSync(path.join(userData, 'artifacts.json'), JSON.stringify([{ id: 'r1', jobId: 'job1', kind: 'research', title: 'Company research · Contoso', content: 'Contoso runs a large alerting platform. [1]', createdAt: Date.now() - 1000 }]));
  fs.writeFileSync(
    path.join(userData, 'sessions', 'm1.json'),
    JSON.stringify({ id: 'm1', type: 'mock', jobId: 'job1', title: 'Mock (behavioral) — 1 question', startedAt: Date.now() - 86400000, answers: [{ kind: 'mock', scenario: 'behavioral', question: 'Describe a time you disagreed with your manager', myAnswer: 'x', answer: 'y', scores: { clarity: 7, structure: 6, specificity: 4, relevance: 7, depth: 6, overall: 5 }, t: Date.now() - 86400000 }] }),
  );
  require(path.join(__dirname, '..', '..', 'src', 'main.js'));
});

const logs = [];
const check = (name, ok, extra = '') => {
  logs.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  fs.writeFileSync(path.join(out, 'log.txt'), logs.join(String.fromCharCode(10)));
};

let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return;
  started = true;
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') logs.push(`[console error] ${e.message} (${e.sourceId}:${e.lineNumber})`);
  });
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (code, ms = 6000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await js(code)) return true;
        await wait(50);
      }
      return false;
    };
    try {
      await wait(1200);
      // 1. Job tracker + reminders
      await js(`document.querySelector('.tab[data-tab="jobs"]').click(); 0`);
      await until(`document.querySelectorAll('#jobList li').length === 1`);
      await js(`document.querySelector('#jobList li').click(); 0`);
      await until(`!document.querySelector('#jobForm').hidden`);
      await js(`(() => {
        const past = new Date(Date.now() - 3600000); const local = new Date(past - past.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        document.querySelector('#jobFollowUp').value = local;
        document.querySelector('#jobFollowUpNote').value = 'Email Sam the design doc';
        document.querySelector('#jobContacts').value = 'Sam Lee, Hiring manager, sam@contoso.example';
        const t = new Date(Date.now() + 6 * 3600000); document.querySelector('#jobApplyBy').value = new Date(t - t.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
        document.querySelector('#jobForm').requestSubmit();
      })(); 0`);
      await until(`/Follow up on Contoso|Application for Contoso/.test(document.querySelector('#banner').textContent)`);
      const job = (await js('window.api.listJobs()'))[0];
      check('tracker fields saved (contacts, follow-up, deadline)', job.contacts.includes('Sam Lee') && job.followUpAt < Date.now() && job.applyBy > Date.now() && job.followUpNote === 'Email Sam the design doc');
      check('due reminders fire once and are marked', !!job.followUpNotifiedAt && !!job.deadlineNotifiedAt);
      const bannerText = await js(`document.querySelector('#banner').textContent`);
      check('reminder shows in the app with an Open job button', /Follow up on Contoso — SRE: Email Sam the design doc|Application for Contoso — SRE is due/.test(bannerText) && (await js(`!!document.querySelector('#banner button')`)), bannerText);
      check('no repeat reminder after re-checking', (await js('window.api.checkReminders()')).length === 0);
      await js(`banner(''); document.querySelector('#cancelJob').click(); 0`);
      await until(`!document.querySelector('#jobList').hidden`);
      const meta = await js(`document.querySelector('#jobList li .meta').textContent`);
      check('jobs list shows follow-up and deadline status', /Follow-up overdue|Follow up today/.test(meta) && /Apply by/.test(meta), meta);

      // 2. Prep plan (uses the saved company research)
      await js(`document.querySelector('#jobList li').click(); 0`);
      await until(`!document.querySelector('#careerTools').hidden`);
      await js(`document.querySelector('#careerTools [data-tool="prep"]').click(); 0`);
      await until(`!document.querySelector('#careerOutput').classList.contains('streaming') && document.querySelector('#careerOutput').innerText.includes('Question plan')`);
      const prepPrompt = prompts.find((p) => p.includes('### Question plan'));
      check('prep plan prompt includes the company research', prepPrompt?.includes('<company_research>\nContoso runs a large alerting platform'));
      const plans = await js('window.api.careerPlans()');
      check('prep plan parsed into practice questions', plans.length === 1 && plans[0].plan.length === 3 && plans[0].plan[1].type === 'system-design', JSON.stringify(plans[0]?.plan));

      // 3. Mock practises the plan in order without calling the AI
      await js(`document.querySelector('.tab[data-tab="mock"]').click(); document.querySelector('#mockSpeak').checked = false; 0`);
      await until(`[...document.querySelectorAll('#mockSource option')].some((o) => o.value.startsWith('plan:'))`);
      const before = prompts.length;
      await js(`document.querySelector('#mockSource').value = document.querySelector('#mockSource option[value^="plan:"]').value; document.querySelector('#mockNextBtn').click(); 0`);
      await wait(200);
      const q1 = await js(`[document.querySelector('#mockQuestion').textContent, document.querySelector('#mockQuestionCard .label').textContent, state.mock.kind]`);
      check('first plan question shown, typed for grading, no AI call', q1[0] === 'Tell me about the worst outage you handled' && q1[1] === 'Plan question 1 of 3 · behavioral' && q1[2] === 'behavioral' && prompts.length === before, JSON.stringify(q1));
      await js(`document.querySelector('#mockNextBtn').click(); 0`);
      await wait(100);
      check('plan continues in order (system design → system-design scenario)', (await js(`document.querySelector('#mockQuestion').textContent`)) === 'How would you design our alerting pipeline?' && (await js('state.mock.kind')) === 'system-design');
      await js(`document.querySelector('#mockNextBtn').click(); 0`);
      await wait(100);
      await js(`document.querySelector('#mockNextBtn').click(); 0`);
      await wait(100);
      check('finished plan says so', /practised every question in this plan/.test(await js(`document.querySelector('#mockQuestion').textContent`)));
      await js(`document.querySelector('#mockSource').value = 'ai'; 0`);

      // 4. Progress: next steps + question bank
      await js(`document.querySelector('.tab[data-tab="history"]').click(); 0`);
      await until(`!!document.querySelector('#bankCard') && !!document.querySelector('#nextSteps')`);
      const steps = await js(`document.querySelector('#nextSteps').innerText`);
      check('next steps target the weakest skill', /Work on specificity/i.test(steps) && (await js(`!!document.querySelector('#nextSteps [data-step]')`)), steps.replace(/\n/g, ' | '));
      const bankText = await js(`document.querySelector('#bankList').innerText`);
      check('question bank lists practised and planned questions', /disagreed with your manager/.test(bankText) && /worst outage/.test(bankText) && /best 5\.0/.test(bankText), bankText.slice(0, 200));
      await js(`const f = document.querySelector('#bankFilter'); f.value = 'alerting'; f.dispatchEvent(new Event('input')); 0`);
      check('bank filter narrows the list', (await js(`document.querySelectorAll('#bankList li').length`)) === 1);
      fs.writeFileSync(path.join(out, 'progress.png'), (await win.webContents.capturePage()).toPNG());
      const before2 = prompts.length;
      await js(`document.querySelector('#bankList [data-q]').click(); 0`);
      await until(`document.querySelector('#mockQuestion').textContent === 'How would you design our alerting pipeline?'`);
      check('Practise from the bank opens that question in Mock without an AI call', (await js(`document.querySelector('#mockQuestionCard .label').textContent`)).includes('from your bank') && prompts.length === before2);

      // 5. MCP configuration in Settings
      await js(`document.querySelector('.tab[data-tab="settings"]').click(); 0`);
      await until(`document.querySelector('#mcpConfig').textContent.includes('mcpServers')`);
      const cfg = JSON.parse(await js(`document.querySelector('#mcpConfig').textContent`))['mcpServers']['interview-helper'];
      check('MCP configuration points at this app run as Node', cfg.env.ELECTRON_RUN_AS_NODE === '1' && cfg.command === process.execPath && /src[\\/]mcp[\\/]server\.js$/.test(cfg.args[0]) && fs.existsSync(cfg.args[0]), JSON.stringify(cfg));
    } catch (err) {
      logs.push('[e2e-error] ' + err.stack);
    }
    fs.writeFileSync(path.join(out, 'log.txt'), logs.join(String.fromCharCode(10)));
    server.close();
    app.exit(0);
  });
});
