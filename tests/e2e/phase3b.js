// End-to-end test of Phase 3b: echo filter, question-type guidance,
// Shorter/Longer/Regenerate, panel interviews with adaptive difficulty, the
// live practice meter, and meeting detection prompts. Fake local provider.
const { app } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, 'out', 'phase3b');
fs.rmSync(out, { recursive: true, force: true });
const userData = path.join(out, 'userdata');
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);

const requests = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const json = JSON.parse(body || '{}');
    if (!json.messages?.length) {
      res.end('{"done":true}');
      return;
    }
    const user = json.messages.find((m) => m.role === 'user')?.content || '';
    requests.push(user);
    const reply = user.startsWith('This is a panel interview') || user.startsWith('Ask ') ? 'What would you do differently next time?' : `ANSWER-${requests.length} with some words`;
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { content: reply }, done: false }) + '\n');
    res.end(JSON.stringify({ done: true }) + '\n');
  });
});

server.listen(0, () => {
  fs.writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({ provider: 'ollama', ollamaUrl: `http://127.0.0.1:${server.address().port}`, ollamaModel: 'fake', transcription: 'local', jobsMigrated: true, liveNoticeAck: true }),
  );
  require(path.join(__dirname, '..', '..', 'src', 'main.js'));
});

const logs = [];
const check = (name, ok, extra = '') => {
  logs.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  fs.writeFileSync(path.join(out, 'log.txt'), logs.join(String.fromCharCode(10)));
};

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') logs.push(`[console error] ${e.message} (${e.sourceId}:${e.lineNumber})`);
  });
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = 4000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await fn()) return true;
        await wait(25);
      }
      return false;
    };
    const shot = async (name) => fs.writeFileSync(path.join(out, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    try {
      await wait(1200);
      // 1. Echo filter
      await js(`state.live = { id: 'echo', type: 'live', transcript: [], answers: [], startedAt: Date.now() }; document.querySelector('#autoAnswer').checked = false; document.querySelector('#transcript').innerHTML = ''; 0`);
      const echo = await js(`(() => {
        const now = Date.now();
        onUtterance({ speaker: 'them', text: 'How would you design a rate limiter for a public API?', startedAt: now - 4000, t: now });
        onUtterance({ speaker: 'me', text: 'how would you design a rate limiter for a public', startedAt: now - 3800, t: now + 200 });
        onUtterance({ speaker: 'me', text: 'Echo arrives first: tell me about your biggest project', startedAt: now + 1000, t: now + 3000 });
        onUtterance({ speaker: 'them', text: 'Echo arrives first: tell me about your biggest project please', startedAt: now + 900, t: now + 3300 });
        onUtterance({ speaker: 'me', text: 'Sure, I would start with a token bucket per client key', startedAt: now + 5000, t: now + 8000 });
        return { lines: state.live.transcript.map((u) => u.speaker + ':' + u.text), dom: document.querySelectorAll('#transcript .line').length, removed: state.live.echoesRemoved };
      })()`);
      check('echo filter drops mic copies of the interviewer (either arrival order) and keeps real answers', echo.lines.length === 3 && echo.dom === 3 && echo.removed === 2 && echo.lines[2].startsWith('me:Sure'), JSON.stringify(echo));

      // 2. Question type: label and prompt guidance
      requests.length = 0;
      await js(`document.querySelector('#answers').innerHTML = ''; startLiveAnswer('Tell me about a time you led a team through a hard deadline?'); 0`);
      await until(async () => js(`!!document.querySelector('#answers .rewrite-actions')`));
      check('behavioral question gets STAR guidance in the prompt', requests[0]?.includes('Behavioral question: use STAR'), requests[0]?.slice(-500));
      check('answer title shows the question type', (await js(`document.querySelector('#answers .card .label span').textContent`)) === 'Answer · Behavioral');

      // 3. Rewrites
      await js(`[...document.querySelectorAll('#answers .rewrite-actions button')].find((b) => b.textContent === 'Shorter').click()`);
      await until(() => requests.length === 2);
      await until(async () => js(`!!document.querySelector('#answers .rewrite-actions')`));
      check('Shorter sends the previous answer with a rewrite instruction', requests[1].includes('<previous_answer>\nANSWER-1 with some words\n</previous_answer>') && requests[1].includes('about half as long'), requests[1].slice(-300));
      check('the rewritten answer replaces the card in place', (await js(`document.querySelectorAll('#answers .card').length === 1 && document.querySelector('#answers .card .label span').textContent === 'Answer · Shorter'`)));
      await js(`[...document.querySelectorAll('#answers .rewrite-actions button')].find((b) => b.textContent === 'Longer').click()`);
      await until(() => requests.length === 3);
      check('Longer asks for more detail from the verified facts only', requests[2].includes('Do not invent anything'));
      await shot('1-live-rewrites');
      await js(`state.live = null; 0`);

      // 4. Panel interview with adaptive difficulty
      await js(`document.querySelector('.tab[data-tab="mock"]').click(); document.querySelector('#mockSpeak').checked = false; document.querySelector('#mockPanel').value = 'panel'; document.querySelector('#mockDifficulty').value = 'auto'; document.querySelector('#mockKind').value = 'mixed'; 0`);
      requests.length = 0;
      await js(`document.querySelector('#mockNextBtn').click()`);
      await until(async () => !(await js(`document.querySelector('#mockNextBtn').disabled`)) && requests.length === 1);
      check('panel: first question comes from the Recruiter at medium difficulty', requests[0].includes('You are the Recruiter') && requests[0].includes('Difficulty: medium'), requests[0].slice(0, 300));
      check('question card names the panelist', (await js(`document.querySelector('#mockQuestionCard .label').textContent`)) === 'Question · Recruiter');
      // Two strong graded answers → the next question gets harder; the next panelist can follow up.
      await js(`state.mock.session.answers.push({ kind: 'mock', question: 'Q1', myAnswer: 'I led the payments team.', scores: { overall: 9 } }, { kind: 'mock', question: 'Q2', myAnswer: 'We cut latency in half.', scores: { overall: 9 } }); 0`);
      await js(`document.querySelector('#mockNextBtn').click()`);
      await until(async () => !(await js(`document.querySelector('#mockNextBtn').disabled`)) && requests.length === 2);
      check('panel rotates to the Hiring manager', requests[1].includes('You are the Hiring manager'));
      check('adaptive difficulty rises after strong scores', requests[1].includes('Difficulty: hard') && (await js(`document.querySelector('#mockQuestionCard .label').textContent`)) === 'Question · Hiring manager · hard');
      check('panelist sees the last exchange and may follow up on a gap', requests[1].includes('<last_exchange>\nQ: Q2\nA: We cut latency in half.') && requests[1].includes('pointed follow-up'));
      await js(`document.querySelector('#mockDifficulty').value = 'easy'; document.querySelector('#mockNextBtn').click()`);
      await until(() => requests.length === 3);
      check('fixed difficulty overrides adaptive', requests[2].includes('Difficulty: easy') && requests[2].includes('You are the Technical lead'));

      // 5. Live practice meter
      await until(async () => !(await js(`document.querySelector('#mockNextBtn').disabled`)));
      const meter = await js(`(() => {
        state.mock.recorder = { stop() {} };
        state.mock.recordStartedAt = Date.now() - 30000;
        state.mock.recordedMs = 0;
        document.querySelector('#mockAnswer').value = Array.from({ length: 90 }, (_, i) => (i % 15 === 0 ? 'um' : 'word')).join(' ');
        updateLiveMeter();
        const el = document.querySelector('#mockLive');
        const text = el.innerText;
        state.mock.recorder = null;
        return { visible: !el.hidden, text };
      })()`);
      check('live meter shows pace, fillers, time and a tip while recording', meter.visible && /180\s*words\/min/.test(meter.text) && /6\s*fillers/.test(meter.text) && /0:30/.test(meter.text) && /Slow down/.test(meter.text), JSON.stringify(meter));
      await shot('2-mock-panel');

      // 6. Meeting detection prompt
      await js(`state.live = null; 0`);
      win.webContents.send('meeting:detected', { app: 'Zoom' });
      await wait(200);
      const b = await js(`({ text: document.querySelector('#banner').textContent, button: !!document.querySelector('#banner button'), hidden: document.querySelector('#banner').classList.contains('hidden') })`);
      check('call app on the mic shows a Start session prompt', !b.hidden && b.text.includes('Zoom is using your microphone') && b.button, JSON.stringify(b));
      await shot('3-meeting-banner');
      await js(`banner(''); state.live = { id: 'x', transcript: [], answers: [] }; 0`);
      win.webContents.send('meeting:detected', { app: 'Teams' });
      await wait(200);
      check('no prompt during a live session', await js(`document.querySelector('#banner').classList.contains('hidden')`));
      await js(`state.live = null; 0`);

      // 7. Setting
      await js(`document.querySelector('.tab[data-tab="settings"]').click(); document.querySelector('#meetingDetection').checked = false; document.querySelector('#saveSettings').click()`);
      await wait(400);
      check('meeting detection can be turned off', (await js(`window.api.getConfig()`)).meetingDetection === false);
    } catch (err) {
      logs.push('[e2e-error] ' + err.stack);
    }
    fs.writeFileSync(path.join(out, 'log.txt'), logs.join(String.fromCharCode(10)));
    server.close();
    app.exit(0);
  });
});
