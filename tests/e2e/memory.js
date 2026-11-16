// End-to-end test of memory across sessions: lessons suggested after a mock
// session (metrics + AI), kept / edited / dismissed in the card, used in live
// answers, practice questions and grading (per job), managed in Profile →
// Memory, not suggested twice, suggested for a live session, and switched off.
const { app } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, 'out', 'memory');
fs.rmSync(out, { recursive: true, force: true });
const userData = path.join(out, 'userdata');
fs.mkdirSync(path.join(userData, 'sessions'), { recursive: true });
app.setPath('userData', userData);

const requests = [];
const LESSONS_REPLY = JSON.stringify([
  { kind: 'story', text: 'Use the payments outage story for questions about failure.', why: 'Your failure answer had no example.', scope: 'general' },
  { kind: 'company', text: "Mention Contoso's move to Kubernetes when asked why this company.", why: 'You did not connect to their platform work.', scope: 'job' },
]);
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = JSON.parse(body || '{}');
    if (!json.messages?.length) return res.end('{"done":true}');
    const system = json.messages.find((m) => m.role === 'system')?.content || '';
    const user = json.messages.find((m) => m.role === 'user')?.content || '';
    requests.push({ system, user });
    let reply = 'Tell me about a time you failed.';
    if (user.includes('Suggest up to 3 lessons')) reply = LESSONS_REPLY;
    else if (user.includes('Evaluate the answer')) reply = 'SCORES clarity=6 structure=5 specificity=3 relevance=6 depth=5 overall=5\n### What worked\nHonest.\n### What to improve\nNo example.\n### Stronger answer\nI led…';
    else if (user.includes('post-interview summary')) reply = '## Overview\nA short call.';
    else if (user.includes('<question>')) reply = `ANSWER block=${system.includes('<lessons_from_past_interviews>')} story=${system.includes('payments outage story')} contoso=${system.includes('move to Kubernetes')}`;
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { content: reply }, done: false }) + '\n');
    res.end(JSON.stringify({ done: true }) + '\n');
  });
});

server.listen(0, () => {
  const port = server.address().port;
  fs.writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({ provider: 'ollama', ollamaUrl: `http://127.0.0.1:${port}`, ollamaModel: 'fake', transcription: 'local', jobsMigrated: true, liveNoticeAck: true, meetingDetection: false, activeJobId: 'j1', resume: 'Jordan Lee, SRE.', autoAnswer: false, autoSummary: true }),
  );
  fs.writeFileSync(
    path.join(userData, 'jobs.json'),
    JSON.stringify([
      { id: 'j1', company: 'Contoso', role: 'SRE', stage: 'interviewing', jobDescription: 'Kubernetes', notes: '' },
      { id: 'j2', company: 'Fabrikam', role: 'Platform Engineer', stage: 'applied', jobDescription: 'Terraform', notes: '' },
    ]),
  );
  require(path.join(__dirname, '..', '..', 'src', 'main.js'));
});

const logs = [];
const check = (name, ok, extra = '') => {
  logs.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  fs.writeFileSync(path.join(out, 'log.txt'), logs.join(String.fromCharCode(10)));
};
const readLessons = () => JSON.parse(fs.readFileSync(path.join(userData, 'lessons.json'), 'utf8'));

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
    const until = async (code, ms = 8000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await js(code)) return true;
        await wait(50);
      }
      return false;
    };
    const liveAnswer = async (q) => {
      const before = await js(`document.querySelectorAll('#answers .card').length`);
      await js(`document.querySelector('.tab[data-tab="live"]').click(); document.querySelector('#askInput').value = ${JSON.stringify(q)}; document.querySelector('#answerBtn').click(); 0`);
      await until(`document.querySelectorAll('#answers .card').length > ${before} && /ANSWER/.test(document.querySelector('#answers .card .body').textContent)`);
      return js(`document.querySelector('#answers .card .body').textContent`);
    };
    try {
      await wait(1200);
      // 1. A mock session, then End: suggestions appear.
      await js(`document.querySelector('.tab[data-tab="mock"]').click(); document.querySelector('#mockSpeak').checked = false; document.querySelector('#mockNextBtn').click(); 0`);
      await until(`document.querySelector('#mockQuestion').textContent.includes('failed')`);
      await js(`document.querySelector('#mockAnswer').value = 'I once missed a deadline and learned to plan better.'; document.querySelector('#mockSubmitBtn').click(); 0`);
      await until(`!document.querySelector('#mockFeedback').hidden && /Stronger answer/.test(document.querySelector('#mockFeedback').textContent)`);
      await js(`document.querySelector('#mockEndBtn').click(); 0`);
      await until(`document.querySelectorAll('#mockLessons .lesson').length === 3`);
      const suggestPrompt = requests.find((r) => r.user.includes('Suggest up to 3 lessons'));
      check('lesson prompt has the practice answer, its scores and feedback', /Scores: clarity=6 structure=5 specificity=3/.test(suggestPrompt?.user) && suggestPrompt.user.includes('I once missed a deadline') && suggestPrompt.user.includes('No example.'));
      check('lesson prompt keeps the verified-facts rule', suggestPrompt.system.includes('never suggest claiming anything that is not in the verified facts'));
      const items = await js(`[...document.querySelectorAll('#mockLessons .lesson')].map((li) => [li.querySelector('.kind').textContent, li.querySelector('textarea').value, li.querySelector('select').value])`);
      check('card shows a metric lesson and the AI lessons, job lesson scoped to Contoso', items[0][0] === 'Content' && /concrete example/.test(items[0][1]) && items[1][0] === 'Story' && items[2][0] === 'Company' && items[2][2] === 'j1' && items[1][2] === '', JSON.stringify(items));
      fs.writeFileSync(path.join(out, 'card.png'), (await win.webContents.capturePage()).toPNG());

      // 2. Dismiss the metric one, edit and keep the story, keep the company one.
      await js(`(() => {
        const li = document.querySelectorAll('#mockLessons .lesson');
        li[0].querySelector('[data-act="dismiss"]').click();
        li[1].querySelector('textarea').value = 'Use the payments outage story (cut errors 40%) for questions about failure.';
        li[1].querySelector('[data-act="keep"]').click();
        li[2].querySelector('[data-act="keep"]').click();
      })(); 0`);
      await until(`document.querySelectorAll('#mockLessons .lesson.decided').length === 3`);
      const stored = readLessons();
      check('decisions saved: 1 dismissed, 2 kept, the edit kept', stored.filter((l) => l.status === 'dismissed').length === 1 && stored.filter((l) => l.status === 'approved').length === 2 && stored.some((l) => l.text.includes('cut errors 40%') && l.jobId === null) && stored.some((l) => l.kind === 'company' && l.jobId === 'j1'));

      // 3. Kept lessons reach live answers, practice questions and grading.
      const ans = await liveAnswer('Why Contoso?');
      check('live answer prompt includes both lessons for the Contoso job', ans.includes('block=true story=true contoso=true'), ans);
      const before = requests.length;
      await js(`document.querySelector('.tab[data-tab="mock"]').click(); document.querySelector('#mockNextBtn').click(); 0`);
      await until(`document.querySelector('#mockQuestion').textContent.includes('failed')`);
      const q = requests.slice(before).find((r) => r.user.includes('Reply with the question only'));
      check('practice question uses the lessons', q?.system.includes('payments outage story') && q.user.includes("If one of the candidate's lessons fits"));
      await js(`document.querySelector('#mockAnswer').value = 'Our payments outage cut errors 40% after I fixed retries.'; document.querySelector('#mockSubmitBtn').click(); 0`);
      await until(`/Stronger answer/.test(document.querySelector('#mockFeedback').textContent)`);
      const grade = requests.filter((r) => r.user.includes('Evaluate the answer')).pop();
      check('feedback says whether a lesson was applied', grade.user.includes('saying whether the candidate applied it') && grade.system.includes('<lessons_from_past_interviews>'));
      await js(`document.querySelector('#mockEndBtn').click(); 0`);
      await wait(800);

      // 4. Another job: only the general lesson.
      await js(`window.api.setActiveJob('j2')`);
      const ans2 = await liveAnswer('Why Fabrikam?');
      check('a Contoso-only lesson is left out for Fabrikam', ans2.includes('block=true story=true contoso=false'), ans2);

      // 5. Not suggested twice.
      const second = await js(`window.api.suggestLessons(${JSON.stringify(stored[0].sessionId)})`);
      check('same lessons are not suggested again (kept or dismissed)', second.added.length === 0, JSON.stringify(second.added.map((l) => l.text)));

      // 6. Profile → Memory.
      await js(`document.querySelector('.tab[data-tab="profile"]').click(); 0`);
      await until(`document.querySelectorAll('#lessonList .lesson').length >= 2`);
      const memory = await js(`[document.querySelectorAll('#lessonList .lesson').length, document.querySelector('#lessonDismissed').textContent, document.querySelectorAll('#lessonPending .lesson').length]`);
      check('Memory lists kept lessons, pending ones, and the dismissed count', memory[0] === 2 && /1 dismissed or forgotten lesson won’t be suggested again/.test(memory[1]), JSON.stringify(memory));
      await js(`document.querySelector('#newLesson').value = 'Ask about on-call load at the end.'; document.querySelector('#addLessonForm').requestSubmit(); 0`);
      await until(`[...document.querySelectorAll('#lessonList textarea')].some((t) => t.value === 'Ask about on-call load at the end.')`);
      check('own lesson added and kept', readLessons().some((l) => l.source === 'me' && l.status === 'approved'));
      await js(`(() => { const li = [...document.querySelectorAll('#lessonList .lesson')].find((l) => /move to Kubernetes/.test(l.querySelector('textarea').value)); const s = li.querySelector('select'); s.value = ''; s.dispatchEvent(new Event('change')); })(); 0`);
      await wait(300);
      check('changing "applies to" makes a job lesson general', readLessons().find((l) => l.kind === 'company').jobId === null);
      await js(`[...document.querySelectorAll('#lessonList .lesson')].find((l) => /move to Kubernetes/.test(l.querySelector('textarea').value)).querySelector('.icon-btn').click(); 0`);
      await until(`![...document.querySelectorAll('#lessonList textarea')].some((t) => /move to Kubernetes/.test(t.value))`);
      check('forget takes a lesson out of use but remembers it so it isn’t suggested again', readLessons().find((l) => l.kind === 'company').status === 'dismissed' && /2 dismissed or forgotten lessons/.test(await js(`document.querySelector('#lessonDismissed').textContent`)));
      await js(`document.querySelector('#memory').scrollIntoView(); 0`);
      await wait(100);
      fs.writeFileSync(path.join(out, 'memory.png'), (await win.webContents.capturePage()).toPNG());

      // 7. Stopping a live session: summary, then lessons (pace from the call, AI sees the summary).
      await js(`document.querySelector('.tab[data-tab="live"]').click(); 0`);
      const mine = 'I would keep remote state in a bucket with locking and versioning so two applies never collide and we can roll back a bad change quickly, and I would split state per environment and per team so the blast radius of any mistake stays small and reviews stay fast for everyone involved in the change';
      await js(`state.live = { id: 'live2', type: 'live', jobId: 'j2', title: 'Fabrikam call', startedAt: Date.now() - 600000, transcript: [
        { speaker: 'them', text: 'How do you manage state in Terraform?', t: Date.now() - 500000 },
        { speaker: 'me', text: ${JSON.stringify(mine)}, dur: 17, t: Date.now() - 480000 },
        { speaker: 'them', text: 'And drift?', t: Date.now() - 400000 },
        { speaker: 'me', text: 'Scheduled plans that alert on any difference.', dur: 3, t: Date.now() - 390000 },
      ], answers: [] }; stopLive(); 0`);
      await until(`!!document.querySelector('#answers .lessons-card .lesson')`, 10000);
      const liveCard = await js(`[...document.querySelectorAll('#answers .lessons-card .lesson')].map((li) => li.querySelector('textarea').value + ' | ' + (li.querySelector('.why')?.textContent || ''))`);
      const summaryIdx = requests.findIndex((r) => r.user.includes('post-interview summary') && r.user.includes('manage state in Terraform'));
      const liveIdx = requests.findIndex((r, i) => i > summaryIdx && r.user.includes('Suggest up to 3 lessons') && r.user.includes('manage state in Terraform'));
      check('stopping a live session: summary first, then a lessons card with only the new pace lesson', summaryIdx >= 0 && liveIdx > summaryIdx && liveCard.length === 1 && /Slow down/.test(liveCard[0]) && /words a minute/.test(liveCard[0]), JSON.stringify(liveCard));
      check('live lesson prompt has the summary, transcript and known lessons', requests[liveIdx].user.includes('<summary>\n## Overview') && requests[liveIdx].user.includes('<lessons_already_known>'));
      fs.writeFileSync(path.join(out, 'live.png'), (await win.webContents.capturePage()).toPNG());

      // 8. Switches.
      await js(`document.querySelector('#useLessons').click(); 0`);
      await wait(200);
      const ans3 = await liveAnswer('Why this role?');
      check('"Use kept lessons" off removes them from prompts', ans3.includes('block=false'), ans3);
      await js(`document.querySelector('.tab[data-tab="profile"]').click(); document.querySelector('#suggestLessons').click(); 0`);
      await wait(200);
      const n = requests.length;
      const off = await js(`window.api.suggestLessons('live2')`);
      check('"Suggest lessons" off: no suggestions and no AI call', off.added.length === 0 && requests.length === n);

      // 9. Clearing the dismissed list.
      await js(`document.querySelector('#clearDismissed').click(); 0`);
      await until(`document.querySelector('#lessonDismissed').textContent === ''`);
      check('clearing the dismissed list removes those records', !readLessons().some((l) => l.status === 'dismissed'));

      // 10. Job lessons go with their job.
      await js(`window.api.updateLesson(${JSON.stringify(readLessons().find((l) => l.source === 'me').id)}, { jobId: 'j2' })`);
      await js(`window.api.deleteJob('j2')`);
      check('deleting a job deletes its lessons', !readLessons().some((l) => l.jobId === 'j2'));
    } catch (err) {
      logs.push('[e2e-error] ' + err.stack);
    }
    fs.writeFileSync(path.join(out, 'log.txt'), logs.join(String.fromCharCode(10)));
    server.close();
    app.exit(0);
  });
});
