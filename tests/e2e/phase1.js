// End-to-end test of the Phase 1 features against a fake Ollama server.
// Seeds pre-upgrade data (job description in the profile, an old mock
// session) to check the migration, then drives the UI.
const { app } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, 'out', 'phase1');
fs.rmSync(out, { recursive: true, force: true });
const userData = path.join(out, 'userdata');
fs.mkdirSync(path.join(userData, 'sessions'), { recursive: true });
app.setPath('userData', userData);

const requests = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const json = JSON.parse(body || '{}');
    const system = json.messages?.find((m) => m.role === 'system')?.content || '';
    const user = json.messages?.find((m) => m.role === 'user')?.content || '';
    requests.push({ system, user });
    let reply;
    if (user.includes('Reply with only a JSON array')) {
      reply = 'Here you go:\n[{"category":"experience","text":"Senior engineer at Northwind 2021-2025 leading the payments team of 6","source":"resume"},{"category":"achievement","text":"Cut checkout latency 40% at Northwind by moving to event-driven queues","source":"resume"},{"category":"skill","text":"Go, Kafka, PostgreSQL","source":"resume"}]';
    } else if (user.includes('SCORES clarity=N')) {
      reply = 'SCORES clarity=7 structure=6 specificity=4 relevance=8 depth=6 overall=6\n### What worked\nClear opening.\n### What to improve\nAdd a number.\n### Stronger answer\nAt Northwind I cut checkout latency 40%.';
    } else if (user.startsWith('Ask ')) {
      reply = 'Tell me about a time you improved a slow system.';
    } else {
      reply = `ANSWER facts=${system.includes('<verified_facts>')} job=${system.includes('<job_description>')} company=${system.includes('Company: Contoso')}`;
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    // Small chunks so the SCORES line arrives split across deltas.
    for (let i = 0; i < reply.length; i += 7) {
      res.write(JSON.stringify({ message: { content: reply.slice(i, i + 7) }, done: false }) + '\n');
      await new Promise((r) => setTimeout(r, 2));
    }
    res.end(JSON.stringify({ done: true }) + '\n');
  });
});

server.listen(0, () => {
  const port = server.address().port;
  fs.writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({
      provider: 'ollama',
      ollamaUrl: `http://127.0.0.1:${port}`,
      ollamaModel: 'fake',
      transcription: 'local',
      resume: 'Jane Doe. Senior engineer at Northwind 2021-2025. Cut checkout latency 40%.',
      jobDescription: 'OLD JD: Backend engineer, Go and Kafka.',
      autoSummary: false,
    }),
  );
  fs.writeFileSync(
    path.join(userData, 'sessions', 'old1.json'),
    JSON.stringify({
      id: 'old1',
      type: 'mock',
      title: 'Mock (behavioral) — 1 question',
      startedAt: Date.now() - 86400000,
      transcript: [],
      answers: [{ kind: 'mock', question: 'Old Q', myAnswer: 'old', answer: '**Score: 7/10**\n### What worked', t: Date.now() - 86400000 }],
    }),
  );
  require(path.join(__dirname, '..', '..', 'src', 'main.js'));
});

const logs = [];
const check = (name, ok, extra = '') => logs.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') logs.push(`[console ${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`);
  });
  win.webContents.once('did-finish-load', async () => {
    const wc = win.webContents;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const shot = async (name) => fs.writeFileSync(path.join(out, `${name}.png`), (await wc.capturePage()).toPNG());
    const js = (code) => wc.executeJavaScript(code);
    const until = async (code, ms = 8000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await js(code)) return true;
        await wait(100);
      }
      return false;
    };
    try {
      await wait(1000);
      // 1. migration
      const jobs = await js('window.api.listJobs()');
      const cfg = await js('window.api.getConfig()');
      check('migration created a job from old JD', jobs.length === 1 && jobs[0].jobDescription.startsWith('OLD JD') && cfg.activeJobId === jobs[0].id);
      check('job picker shows the job', (await js(`document.querySelector('#activeJob').selectedOptions[0].textContent`)) === 'My target role');

      // 2. jobs tab: edit job, add a second job
      await js(`document.querySelector('.tab[data-tab="jobs"]').click()`);
      await until(`document.querySelectorAll('#jobList li').length === 1`);
      await shot('1-jobs');
      await js(`document.querySelector('#jobList li').click()`);
      await js(`document.querySelector('#jobCompany').value='Contoso'; document.querySelector('#jobRole').value='Backend Engineer'; document.querySelector('#jobStage').value='interviewing';
        const d=new Date(Date.now()+3*86400000); d.setHours(10,0,0,0); document.querySelector('#jobDate').value=new Date(d-d.getTimezoneOffset()*60000).toISOString().slice(0,16);
        document.querySelector('#jobForm').requestSubmit();`);
      await until(`!document.querySelector('#jobList').hidden && document.querySelector('#jobList li .job-title')?.textContent.includes('Contoso')`);
      await js(`document.querySelector('#newJob').click(); document.querySelector('#jobCompany').value='Fabrikam'; document.querySelector('#jobRole').value='SRE'; document.querySelector('#jobForm').requestSubmit();`);
      await until(`document.querySelectorAll('#jobList li').length === 2`);
      const jobText = await js(`document.querySelector('#jobList').innerText`);
      check('jobs list shows both jobs, active first, interview countdown', /Contoso — Backend Engineer[\s\S]*Interview in 3 days[\s\S]*Fabrikam/.test(jobText), JSON.stringify(jobText.slice(0, 200)));
      await shot('2-jobs-list');

      // 3. Interview Brain extraction
      await js(`document.querySelector('.tab[data-tab="profile"]').click()`);
      await wait(300);
      await js(`document.querySelector('#extractFacts').click()`);
      await until(`document.querySelectorAll('#factList textarea').length === 3`);
      check('extracted 3 facts', (await js(`document.querySelectorAll('#factList textarea').length`)) === 3, await js(`document.querySelector('#banner').textContent`));
      // edit one fact, add one, save
      await js(`const t=document.querySelector('#factList textarea'); t.value='Senior engineer at Northwind 2021-2025, led payments team of 6 people'; t.dispatchEvent(new Event('input'));
        document.querySelector('#addFact').click(); const n=document.querySelector('#factList textarea'); n.value='Mentored 3 junior engineers'; n.dispatchEvent(new Event('input'));
        document.querySelector('#saveFacts').click();`);
      await wait(400);
      const facts = await js('window.api.listFacts()');
      check('facts saved with edit and new fact', facts.length === 4 && facts.some((f) => f.text.includes('6 people')) && facts.some((f) => f.text === 'Mentored 3 junior engineers'));
      // extracting again must not duplicate
      await js(`document.querySelector('#extractFacts').click()`);
      check('extract button disables at once', await js(`document.querySelector('#extractFacts').disabled`));
      await until(`!document.querySelector('#extractFacts').disabled`, 8000);
      await wait(300);
      check('re-extract does not duplicate', (await js('window.api.listFacts()')).length === 5 /* edited fact differs from original */, String((await js('window.api.listFacts()')).length));
      await shot('3-profile-brain');

      // 4. live answer uses job + facts
      await js(`document.querySelector('.tab[data-tab="live"]').click(); document.querySelector('#askInput').value='Why this company?'; document.querySelector('#answerBtn').click();`);
      await until(`document.querySelector('#answers .card:not(.streaming)')`);
      const ans = await js(`document.querySelector('#answers .card .body').innerText`);
      check('answer prompt has facts, job description and company', ans.includes('facts=true job=true company=true'), ans);
      const sys = requests.find((r) => r.user.includes('Why this company?'))?.system || '';
      check('grounding rule in system prompt', sys.includes('bracketed placeholder') && sys.includes('Interview: '));

      // 5. mock: system design scenario, typed answer with fillers, scores
      await js(`document.querySelector('.tab[data-tab="mock"]').click(); document.querySelector('#mockSpeak').checked=false; document.querySelector('#mockKind').value='system-design'; document.querySelector('#mockNextBtn').click();`);
      await until(`!document.querySelector('#mockSubmitBtn').disabled`);
      check('mock question asked with scenario prompt', requests.some((r) => r.user.startsWith("Ask a system design question scoped to this role's seniority")));
      await js(`document.querySelector('#mockAnswer').value='Um so I would uh start with the requirements, you know, then um I I would design the the queue and basically shard the database by user.'; document.querySelector('#mockSubmitBtn').click();`);
      await until(`document.querySelector('#mockFeedback .scores') && !document.querySelector('#mockSubmitBtn').disabled`);
      await wait(300);
      const fb = await js(`document.querySelector('#mockFeedback').innerText`);
      check('scores shown, SCORES line hidden', fb.includes('6.0') && fb.includes('Specificity') && !fb.includes('SCORES'), JSON.stringify(fb.slice(0, 160)));
      check('delivery metrics shown', /fillers/.test(fb) && /filler words/.test(fb), JSON.stringify(fb.slice(-260)));
      const gradeReq = requests.find((r) => r.user.includes('SCORES clarity=N'));
      check('grader got scenario + delivery metrics', gradeReq.user.includes('<interview_type>System design</interview_type>') && /\d+ filler words/.test(gradeReq.user), (gradeReq.user.match(/<delivery_metrics>[\s\S]*?<\/delivery_metrics>/) || [''])[0]);
      await shot('4-mock-feedback');
      await js(`document.querySelector('#mockEndBtn').click()`);
      await wait(400);

      // 6. progress
      await js(`document.querySelector('.tab[data-tab="history"]').click()`);
      await until(`document.querySelector('#progress .tiles')`);
      await wait(300);
      const prog = await js(`document.querySelector('#progress').innerText`);
      check('progress counts old + new practice answers', /Practice answers\s*2/.test(prog), JSON.stringify(prog.slice(0, 200)));
      check('progress averages legacy 7 and new 6', /Average score\s*6\.5/.test(prog));
      check('focus next = weakest skill', /focus next: specificity/i.test(prog));
      check('by practice type lists both', prog.includes('System design') && prog.includes('Behavioral'));
      await shot('5-progress');
      // filter by job: only the new answer belongs to Contoso
      const contoso = (await js('window.api.listJobs()')).find((j) => j.company === 'Contoso').id;
      await js(`document.querySelector('#progressJob').value=${JSON.stringify(contoso)}; document.querySelector('#progressJob').dispatchEvent(new Event('change'))`);
      await wait(600);
      const prog2 = await js(`document.querySelector('#progress').innerText`);
      check('job filter narrows to that job', /Practice answers\s*1/.test(prog2) && (await js(`document.querySelectorAll('#historyList li').length`)) === 1);
      // session detail shows scores + delivery
      await js(`document.querySelector('#historyList li').click()`);
      await until(`!document.querySelector('#historyDetail').hidden`);
      await wait(300);
      const det = await js(`document.querySelector('#historyDetail').innerText`);
      check('history detail shows scenario, scores and delivery', /system design/i.test(det) && /structure/i.test(det) && /delivery/i.test(det));
      await shot('6-history-detail');

      // 7. narrow window: no horizontal overflow on any tab
      win.setSize(380, 700);
      await wait(400);
      const overflow = [];
      for (const tab of ['live', 'mock', 'jobs', 'profile', 'history', 'settings']) {
        await js(`document.querySelector('.tab[data-tab="${tab}"]').click()`);
        await wait(250);
        if (await js(`[...document.querySelectorAll('.panel.active, .panel.active *')].some(el => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible' && !el.matches('pre, pre *, textarea, select, svg *') && getComputedStyle(el).textOverflow !== 'ellipsis')`)) overflow.push(tab);
        if (await js(`document.documentElement.scrollWidth > window.innerWidth + 1`)) overflow.push(tab + '(page)');
      }
      check('no horizontal overflow at 380px', overflow.length === 0, overflow.join(','));
      await js(`document.querySelector('.tab[data-tab="history"]').click()`);
      await wait(500);
      await shot('7-progress-narrow');

      // 8. speech metrics unit checks
      const m = await js(`Coach.speechMetrics('um I I think, uh, we basically shipped it you know on time', 6)`);
      check('speechMetrics counts fillers and repeats', m.fillers === 4 && m.repeats === 1 && m.wpm === 130, JSON.stringify(m));
      const sp = await js(`[Coach.splitScores('SCO'), Coach.splitScores('SCORES clarity=7 overall=6\\n### A'), Coach.splitScores('No scores here')]`);
      check('splitScores handles partial, full and missing', sp[0].body === '' && sp[1].scores.overall === 6 && sp[1].body === '### A' && sp[2].scores === null && sp[2].body === 'No scores here');
    } catch (err) {
      logs.push('[e2e-error] ' + err.stack);
    }
    fs.writeFileSync(path.join(out, 'log.txt'), logs.join('\n'));
    server.close();
    app.exit(0);
  });
});
