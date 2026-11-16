// End-to-end test of Phase 3: speculative answers with corrections, turn
// signals from every transcriber, Claude through Chromium's network stack,
// connection prewarm, and bounded on-screen history. Fake local providers;
// these checks verify behaviour, not production speed.
const { app } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, 'out', 'phase3');
fs.rmSync(out, { recursive: true, force: true });
const userData = path.join(out, 'userdata');
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);

const requests = []; // {kind, question, closedEarly, done, at}
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const url = req.url;
    if (url.startsWith('/v1/models')) {
      requests.push({ kind: 'anthropic-prewarm', key: req.headers['x-api-key'], at: Date.now() });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":[]}');
      return;
    }
    const json = JSON.parse(body || '{}');
    if (url.startsWith('/v1/messages')) {
      // Minimal Anthropic Messages SSE stream.
      requests.push({ kind: 'anthropic', at: Date.now() });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: json.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      for (const piece of ['Hello ', 'from ', 'fake ', 'Claude.']) {
        await new Promise((r) => setTimeout(r, 20));
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: piece } });
      }
      ev('content_block_stop', { index: 0 });
      ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
      ev('message_stop', {});
      res.end();
      return;
    }
    // Ollama /api/chat
    if (!json.messages?.length) {
      requests.push({ kind: 'ollama-prewarm', keepAlive: json.keep_alive, at: Date.now() });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"done":true}');
      return;
    }
    const user = json.messages.find((m) => m.role === 'user')?.content || '';
    const question = (user.match(/<question>\n([\s\S]*?)\n<\/question>/) || [, ''])[1];
    const entry = { kind: 'answer', question, closedEarly: false, done: false, at: Date.now() };
    requests.push(entry);
    res.on('close', () => {
      if (!entry.done) entry.closedEarly = true;
    });
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    // Slow stream (2 s) so cancellations are observable.
    for (let i = 0; i < 40 && !entry.closedEarly; i++) {
      res.write(JSON.stringify({ message: { content: `w${i} ` }, done: false }) + '\n');
      await new Promise((r) => setTimeout(r, 50));
    }
    entry.done = !entry.closedEarly;
    res.end(JSON.stringify({ done: true }) + '\n');
  });
});

server.listen(0, () => {
  const port = server.address().port;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  fs.writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({ provider: 'ollama', ollamaUrl: `http://127.0.0.1:${port}`, ollamaModel: 'fake', transcription: 'local', jobsMigrated: true, liveNoticeAck: true, autoAnswer: true }),
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
    const answers = () => requests.filter((r) => r.kind === 'answer');
    const until = async (fn, ms = 4000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await fn()) return true;
        await wait(20);
      }
      return false;
    };
    const fakeLive = `state.live = { id: 'e2e', type: 'live', transcript: [], answers: [], startedAt: Date.now() }; state.spec.reset(); document.querySelector('#autoAnswer').checked = true; document.querySelector('#answers').innerHTML = ''; 0`;
    try {
      await wait(1200);
      const idle = app.getAppMetrics().map((m) => m.serviceName || m.type);
      check('idle window does not start the audio or video-capture services', !idle.some((n) => /audio|video_capture/i.test(n)), idle.join(','));
      check('shared core loaded in the renderer', await js(`typeof CoreQuestion.sameQuestion === 'function' && typeof CoreSpeculation.SpeculationController === 'function' && typeof CoreCoaching.aggregate === 'function'`));

      // 1. eager → same final: one request, draft promoted, negative lead time.
      await js(fakeLive);
      await js(`onTurn('eager', 'Tell me about a time you led a team?')`);
      await until(() => answers().length === 1);
      await wait(150);
      check('eager signal starts a draft answer', await js(`!!document.querySelector('#answers .card.draft') && document.querySelector('#answers .card .label span').textContent === 'Draft answer'`));
      await js(`onUtterance({ speaker: 'them', text: 'Tell me about a time you led a team?', t: Date.now(), startedAt: Date.now() - 2500 })`);
      await wait(100);
      check('same final question promotes the draft (no second request)', answers().length === 1 && (await js(`!document.querySelector('#answers .card.draft') && document.querySelector('#answers .card .label span').textContent === 'Answer · Behavioral'`))); // v0.6 shows the question type in the title
      await until(() => answers()[0].done, 4000);
      await wait(200);
      const rec1 = await js(`state.live.answers[0]`);
      check('promoted answer recorded with negative lead time (words on screen before the question was final)', rec1?.latency?.speculative === true && rec1.latency.leadMs < 0, JSON.stringify(rec1?.latency));

      // 2. eager → resumed: draft cancelled (stream really stopped) and removed.
      await js(fakeLive);
      requests.length = 0;
      await js(`onTurn('eager', 'What is your biggest weakness?')`);
      await until(() => answers().length === 1);
      await wait(200);
      await js(`onTurn('resumed', '')`);
      await until(() => answers()[0].closedEarly, 2000);
      check('resumed speech cancels the draft request upstream', answers()[0].closedEarly === true);
      check('cancelled draft disappears from the screen', (await js(`document.querySelectorAll('#answers .card').length`)) === 0);
      await js(`onUtterance({ speaker: 'them', text: 'What is your biggest weakness and how are you fixing it?', t: Date.now(), startedAt: Date.now() - 3000 })`);
      await until(() => answers().length === 2);
      check('final answer uses the full, final question', answers()[1].question === 'What is your biggest weakness and how are you fixing it?', answers()[1].question);

      // 3. eager → changed final without a resume signal: corrected answer.
      await js(fakeLive);
      requests.length = 0;
      await js(`onTurn('eager', 'How would you design a cache?')`);
      await until(() => answers().length === 1);
      await js(`onUtterance({ speaker: 'them', text: 'How would you design a cache for a global payments platform?', t: Date.now(), startedAt: Date.now() - 3000 })`);
      await until(() => answers().length === 2);
      await wait(150);
      check('changed question: draft stopped and replaced by a corrected answer', answers()[0].closedEarly && (await js(`document.querySelectorAll('#answers .card').length === 1 && document.querySelector('#answers .card .label span').textContent.startsWith('Answer · updated')`)));

      // 4. final without an eager signal starts immediately (old path waited 700 ms).
      await js(fakeLive);
      requests.length = 0;
      const t0 = await js(`(() => { const t = Date.now(); onUtterance({ speaker: 'them', text: 'Why do you want to work here?', t, startedAt: t - 2000 }); return t; })()`);
      await until(() => answers().length === 1);
      const startDelay = answers()[0].at - t0;
      check('answer request starts right after the final transcript (no 700 ms wait)', startDelay < 150, `${startDelay} ms`);

      // 5. follow-up sentence → corrected answer covering both sentences.
      await wait(300);
      await js(`onUtterance({ speaker: 'them', text: 'Especially compared with your current company and team.', t: Date.now(), startedAt: Date.now() - 100 })`);
      await until(() => answers().length === 2);
      check('follow-up sentence restarts the answer with both sentences', /work here\? Especially compared with your current company/.test(answers()[1].question) && answers()[0].closedEarly, answers()[1]?.question);

      // 6. manual mode: no automatic answers; Answer now uses the pending text.
      await js(`state.live = { id: 'e2e2', type: 'live', transcript: [], answers: [], startedAt: Date.now() }; state.spec.reset(); document.querySelector('#autoAnswer').checked = false; 0`);
      requests.length = 0;
      await js(`onTurn('eager', 'How do you prioritise work?'); onUtterance({ speaker: 'them', text: 'How do you prioritise work?', t: Date.now() })`);
      await wait(300);
      check('manual mode starts nothing automatically', answers().length === 0);
      await js(`document.querySelector('#answerBtn').click()`);
      await until(() => answers().length === 1);
      check('Answer now answers the pending question', answers()[0]?.question === 'How do you prioritise work?');
      await js(`document.querySelector('#autoAnswer').checked = true; state.live = null; 0`);

      // 7. Deepgram Flux message handling.
      const flux = await js(`(() => {
        const ev = [];
        const f = new FluxTranscriber({ apiKey: 'x', speaker: 'them', onInterim: (t) => ev.push('interim:' + t), onTurn: (e, t) => ev.push(e + ':' + t), onUtterance: (u) => ev.push('utt:' + u.text + ':' + u.dur.toFixed(1)) });
        const m = (event, transcript, words = []) => f.handleMessage({ type: 'TurnInfo', event, transcript, words, turn_index: 0, end_of_turn_confidence: 0.6 });
        f.handleMessage({ type: 'Connected', request_id: 'r', sequence_id: 0 });
        m('StartOfTurn', 'Tell');
        m('Update', 'Tell me about');
        m('EagerEndOfTurn', 'Tell me about yourself?');
        m('TurnResumed', 'Tell me about yourself?');
        m('EndOfTurn', 'Tell me about yourself and your last role?', [{ word: 'Tell', start: 0.2, end: 0.4 }, { word: 'role?', start: 2.0, end: 2.6 }]);
        return ev;
      })()`);
      check('Flux events map to interim, eager, resumed and the final utterance', flux.join('|') === 'interim:Tell me about|interim:Tell me about yourself?|eager:Tell me about yourself?|resumed:|interim:|utt:Tell me about yourself and your last role?:2.4', flux.join('|'));
      check('Flux connects to /v2/listen with eager mode and 16 kHz linear16', await js(`(() => { const u = new FluxTranscriber({ apiKey: 'x', speaker: 'them', language: 'en' }).url(); return u.startsWith('wss://api.deepgram.com/v2/listen?') && u.includes('model=flux-general-en') && u.includes('encoding=linear16') && u.includes('sample_rate=16000') && u.includes('eager_eot_threshold=0.5'); })()`));

      // 8. Deepgram Nova-3: a final segment ending in "?" is an early signal.
      const nova = await js(`(() => {
        const ev = [];
        const t = new Transcriber({ apiKey: 'x', speaker: 'them', onTurn: (e, x) => ev.push(e + ':' + x), onUtterance: (u) => ev.push('utt:' + u.text + ':' + (u.startedAt > 0)) });
        const r = (text, is_final, speech_final) => t.handleMessage({ type: 'Results', is_final, speech_final, channel: { alternatives: [{ transcript: text, words: [] }] } });
        r('How would', false, false);
        r('How would you scale it?', true, false);
        r('and', false, false);
        r('and keep it cheap?', true, true);
        return ev;
      })()`);
      check('Nova-3 emits eager on a final "?", resumed on more speech, then the utterance', nova.join('|') === 'eager:How would you scale it?|resumed:|utt:How would you scale it? and keep it cheap?:true', nova.join('|'));

      // 9. Local Whisper: early transcript reused when only silence follows.
      const local = await js(`(async () => {
        const ev = []; let calls = 0;
        const lt = createTranscriber({ transcription: 'local' }, { speaker: 'them', onTurn: (e, x) => ev.push(e + ':' + x), onUtterance: (u) => ev.push('utt:' + u.text) });
        lt.ratio = 1;
        lt.enqueue = () => { calls++; return new Promise((r) => setTimeout(() => r('Tell me about yourself?'), 30)); };
        const loud = new Float32Array(1600).map((_, i) => 0.3 * Math.sin(i / 3));
        const quiet = new Float32Array(1600);
        for (let i = 0; i < 10; i++) lt.onFrame(loud);
        for (let i = 0; i < 3; i++) lt.onFrame(quiet);
        await new Promise((r) => setTimeout(r, 80));
        for (let i = 0; i < 4; i++) lt.onFrame(quiet);
        await new Promise((r) => setTimeout(r, 80));
        const reuse = { calls, ev: ev.slice() };
        ev.length = 0; calls = 0;
        for (let i = 0; i < 10; i++) lt.onFrame(loud);
        for (let i = 0; i < 3; i++) lt.onFrame(quiet);
        for (let i = 0; i < 5; i++) lt.onFrame(loud);
        for (let i = 0; i < 7; i++) lt.onFrame(quiet);
        await new Promise((r) => setTimeout(r, 150));
        return { reuse, resumed: { calls, ev } };
      })()`);
      check('local engine signals eager after 300 ms and transcribes only once when silence follows', local.reuse.calls === 1 && local.reuse.ev.join('|') === 'eager:Tell me about yourself?|utt:Tell me about yourself?', JSON.stringify(local.reuse));
      // Pause → eager (stale once they resume) → speech → pause → fresh eager on the
      // whole sentence, which the final then reuses: 2 transcriptions, not 3.
      check('local engine drops the stale early text when the speaker resumes, then reuses the fresh one', local.resumed.calls === 2 && local.resumed.ev.join('|') === 'resumed:|eager:Tell me about yourself?|utt:Tell me about yourself?', JSON.stringify(local.resumed));

      // 10. Prewarm: Ollama loads the model; Claude opens its connection.
      requests.length = 0;
      const pw = await js(`window.api.prewarm()`);
      check('prewarm loads the Ollama model (empty chat, keep_alive)', pw.ok && requests.some((r) => r.kind === 'ollama-prewarm' && r.keepAlive === '30m'), JSON.stringify(pw));
      await js(`window.api.saveConfig({ provider: 'anthropic', anthropicKey: 'test-key', anthropicModel: 'claude-haiku-5-5' }).then((c) => (state.config = c))`);
      const pw2 = await js(`window.api.prewarm()`);
      check('prewarm opens the Claude connection with a metadata request', pw2.ok && requests.some((r) => r.kind === 'anthropic-prewarm' && r.key === 'test-key'), JSON.stringify(pw2));

      // 11. Claude streaming through Chromium's network stack (SDK + net.fetch).
      await js(`document.querySelector('#answers').innerHTML = ''; answer('Say hello'); 0`);
      const streamed = await until(async () => (await js(`document.querySelector('#answers .card:not(.streaming) .body')?.textContent || ''`)).includes('Hello from fake Claude.'), 5000);
      check('Claude SDK streams through net.fetch', streamed, await js(`document.querySelector('#answers .card .body')?.textContent`));
      await js(`window.api.saveConfig({ provider: 'ollama' }).then((c) => (state.config = c))`);

      // 12. Bounded on-screen history.
      await js(`for (let i = 0; i < 400; i++) addTranscriptLine({ speaker: i % 2 ? 'me' : 'them', text: 'line ' + i }); 0`);
      check('transcript keeps at most 300 lines on screen', (await js(`document.querySelectorAll('#transcript .line:not(.interim)').length`)) === 300);
      await js(`state.live = { id: 'cap', type: 'live', transcript: [], answers: [], startedAt: Date.now() }; for (let i = 0; i < 25; i++) startLiveAnswer('Question number ' + i + ' about things?'); 0`);
      await wait(200);
      check('answers area keeps at most 20 cards', (await js(`document.querySelectorAll('#answers .card').length`)) === 20);
      await js(`state.streams.forEach((e, id) => window.api.cancel(id)); state.live = null; 0`);

      // 13. Flux is selectable and shows the Deepgram key field.
      await js(`document.querySelector('.tab[data-tab="settings"]').click(); document.querySelector('#transcription').value = 'deepgram-flux'; document.querySelector('#transcription').dispatchEvent(new Event('change'))`);
      await wait(200);
      check('Flux option shows the Deepgram key field', await js(`!document.querySelector('#deepgramKey').closest('[data-engine]').hidden`));
    } catch (err) {
      logs.push('[e2e-error] ' + err.stack);
    }
    fs.writeFileSync(path.join(out, 'log.txt'), logs.join(String.fromCharCode(10)));
    server.close();
    app.exit(0);
  });
});
