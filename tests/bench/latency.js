// Latency benchmark for the desktop app's own pipeline (everything except
// the cloud provider's own speed). Runs the real app against a local fake
// Ollama server with a realistic profile (resume, job, 60 facts, 30 documents)
// and measures each stage. Usage: npx electron tests/bench/latency.js
const { app } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, 'out');
fs.rmSync(out, { recursive: true, force: true });
const userData = path.join(out, 'userdata');
fs.mkdirSync(path.join(userData, 'documents'), { recursive: true });
app.setPath('userData', userData);

// Reuse a cached Whisper model if one exists (MODEL_CACHE=path), else it downloads (~75 MB).
if (process.env.MODEL_CACHE && fs.existsSync(process.env.MODEL_CACHE)) {
  fs.cpSync(process.env.MODEL_CACHE, path.join(userData, 'models'), { recursive: true });
}

const words = (n, seed) => Array.from({ length: n }, (_, i) => `${seed}${(i * 7919) % 997} delivered project outcomes stakeholders latency kafka`).join(' ');

const serverLog = new Map(); // question marker -> {recv, firstWrite, lastWrite}
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const recv = Date.now();
    const json = JSON.parse(body || '{}');
    const user = json.messages?.find((m) => m.role === 'user')?.content || '';
    const question = (user.match(/<question>([\s\S]*?)<\/question>/) || [, user])[1];
    const marker = (question.match(/BENCH-\d+|STREAMTEST|AUTO-\d+/) || ['other'])[0];
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const send = (t) => res.write(JSON.stringify({ message: { content: t }, done: false }) + '\n');
    send('TOK ');
    const entry = { recv, firstWrite: Date.now() };
    serverLog.set(marker, entry);
    if (marker === 'STREAMTEST') {
      // ~600 tokens at 50 tokens/s, Markdown-heavy, like a long answer.
      for (let i = 0; i < 600; i++) {
        await new Promise((r) => setTimeout(r, 20));
        send(i % 40 === 0 ? `\n\n### Part ${i / 40}\n- ` : i % 9 === 0 ? '**key** ' : 'word ');
      }
    }
    entry.lastWrite = Date.now();
    res.end(JSON.stringify({ done: true }) + '\n');
  });
});

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const summary = (xs) => ({ p50: pct(xs, 50), p95: pct(xs, 95), max: Math.max(...xs), n: xs.length });

server.listen(0, () => {
  const port = server.address().port;
  const jobId = 'job1';
  fs.writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({
      provider: 'ollama',
      ollamaUrl: `http://127.0.0.1:${port}`,
      ollamaModel: 'fake',
      transcription: 'local',
      whisperModel: 'Xenova/whisper-base.en',
      resume: words(400, 'resume'),
      extraNotes: words(60, 'note'),
      activeJobId: jobId,
      jobsMigrated: true,
      liveNoticeAck: true,
      autoAnswer: true,
    }),
  );
  fs.writeFileSync(
    path.join(userData, 'jobs.json'),
    JSON.stringify([{ id: jobId, company: 'Contoso', role: 'Backend Engineer', stage: 'interviewing', jobDescription: words(250, 'jd'), notes: '' }]),
  );
  fs.writeFileSync(
    path.join(userData, 'facts.json'),
    JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ id: `f${i}`, category: 'achievement', text: `Fact ${i}: ${words(3, 'f')}`, source: 'resume' }))),
  );
  for (let i = 0; i < 30; i++) {
    fs.writeFileSync(
      path.join(userData, 'documents', `d${i}.json`),
      JSON.stringify({ id: `d${i}`, name: `doc${i}.md`, addedAt: Date.now(), text: words(700, `doc${i}`) }),
    );
  }
  require(path.join(__dirname, '..', '..', 'src', 'main.js'));
});

function memoryMB() {
  const metrics = app.getAppMetrics();
  const total = metrics.reduce((n, m) => n + (m.memory?.workingSetSize || 0), 0);
  return { totalMB: Math.round(total / 1024), processes: metrics.map((m) => `${m.type}:${Math.round((m.memory?.workingSetSize || 0) / 1024)}`) };
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const results = { machine: `${require('os').cpus()[0].model} ×${require('os').cpus().length}`, electron: process.versions.electron };
    try {
      await wait(1500);
      results.memoryIdle = memoryMB();

      // 1. Typed/manual question → request at provider, and provider's first byte → first word on screen.
      await js(`window.__firstRender = (marker) => new Promise((resolve) => {
        const t0 = Date.now();
        answer(marker + ' Why do you want this role?');
        const obs = new MutationObserver(() => {
          const body = document.querySelector('#answers .card .body');
          if (body && body.textContent.includes('TOK')) { obs.disconnect(); resolve({ t0, tRender: Date.now() }); }
        });
        obs.observe(document.querySelector('#answers'), { childList: true, subtree: true, characterData: true });
      }); 0`);
      const prep = [];
      const deliver = [];
      for (let i = 0; i < 30; i++) {
        const marker = `BENCH-${i}`;
        const r = await js(`window.__firstRender('${marker}')`);
        const s = serverLog.get(marker);
        prep.push(s.recv - r.t0);
        deliver.push(r.tRender - s.firstWrite);
        await wait(50);
      }
      results.manualAnswer = {
        note: 'ms. prep = click → request reaches provider (prompt build incl. BM25 over 30 docs, IPC, HTTP). deliver = provider first byte → first word painted.',
        prep: summary(prep.slice(3)), // first 3 are warm-up
        deliver: summary(deliver.slice(3)),
      };

      // 2. Auto-answer: interviewer utterance finalized → request reaches provider.
      const auto = [];
      for (let i = 0; i < 8; i++) {
        const marker = `AUTO-${i}`;
        const t0 = await js(`(() => {
          state.live = state.live || { id: 'bench', type: 'live', transcript: [], answers: [], startedAt: Date.now() };
          state.transcribers = {};
          state.spec.reset(); // each sample is a separate question, not a follow-up
          document.querySelector('#autoAnswer').checked = true;
          const t = Date.now();
          onUtterance({ speaker: 'them', text: '${marker} tell me about a time you led a project?', t });
          return t;
        })()`);
        for (let k = 0; k < 400 && !serverLog.get(marker); k++) await wait(10);
        if (!serverLog.get(marker)) throw new Error(`auto-answer ${marker} never reached the provider; got ${[...serverLog.keys()].slice(-3)}; banner=${await js("document.querySelector('#banner').textContent")}; pending=${await js('JSON.stringify(state.pending)')}`);
        auto.push(serverLog.get(marker).recv - t0);
        await wait(200);
      }
      results.autoAnswer = { note: 'ms from a finished interviewer utterance to the request reaching the provider (v0.4 had a fixed 700 ms follow-up wait here; v0.5 starts at once and corrects if a follow-up arrives).', ...summary(auto) };
      await js(`state.live = null`);

      // 3. Streaming render cost for a long Markdown answer (600 tokens at 50 tok/s).
      await js(`(() => {
        window.__renders = [];
        const orig = renderMarkdown;
        renderMarkdown = (el, text) => { const t = performance.now(); orig(el, text); window.__renders.push(performance.now() - t); };
        window.__longTasks = 0;
        try { new PerformanceObserver((l) => (window.__longTasks += l.getEntries().length)).observe({ entryTypes: ['longtask'] }); } catch {}
        window.__streamDone = new Promise((resolve) => {
          answer('STREAMTEST long answer');
          const check = setInterval(() => {
            const card = document.querySelector('#answers .card');
            if (card && !card.classList.contains('streaming')) { clearInterval(check); resolve(Date.now()); }
          }, 5);
        });
      })()`);
      const streamDone = await js('window.__streamDone');
      const renders = await js('window.__renders');
      results.streaming = {
        note: 'Markdown re-render per animation frame while 600 tokens stream in.',
        renders: renders.length,
        renderMs: { p50: +pct(renders, 50).toFixed(2), p95: +pct(renders, 95).toFixed(2), max: +Math.max(...renders).toFixed(2) },
        longTasksOver50ms: await js('window.__longTasks'),
        lastTokenToDoneMs: streamDone - serverLog.get('STREAMTEST').lastWrite,
      };

      // 4. Voice-activity detection cost per 100 ms audio frame (48 kHz → 16 kHz + energy).
      results.vad = await js(`(() => {
        const lt = createTranscriber({ transcription: 'local' }, { speaker: 'me' });
        lt.ratio = 3;
        const frame = new Float32Array(4800).map(() => (Math.random() - 0.5) * 0.002);
        const n = 5000;
        const t = performance.now();
        for (let i = 0; i < n; i++) lt.onFrame(lt.downsample(frame));
        const us = ((performance.now() - t) / n) * 1000;
        return { note: 'µs of CPU per 100 ms frame (budget 100,000 µs)', usPerFrame: +us.toFixed(1) };
      })()`);

      // 5. Question detection cost.
      results.questionDetection = await js(`(() => {
        const lines = ['So tell me about a time you failed', 'We use Kafka for events.', 'What would you do differently?', 'Great, thanks.'];
        const n = 40000; const t = performance.now();
        let hits = 0; for (let i = 0; i < n; i++) if (looksLikeQuestion(lines[i % 4])) hits++;
        return { note: 'µs per utterance', usPerCall: +(((performance.now() - t) / n) * 1000).toFixed(2), hits };
      })()`);

      // 6. Local Whisper (base.en, CPU): model load, then transcription of a 6 s question.
      const wav = fs.readFileSync(path.join(__dirname, 'fixtures', 'question.wav')).toString('base64');
      results.whisper = await js(`(async () => {
        const bytes = Uint8Array.from(atob('${wav}'), (c) => c.charCodeAt(0));
        const pcm = new Int16Array(bytes.buffer, 44, (bytes.length - 44) >> 1);
        const audio = Float32Array.from(pcm, (v) => v / 32768);
        let t = performance.now();
        await window.api.warmupWhisper();
        const loadMs = Math.round(performance.now() - t);
        const runs = []; let text = '';
        for (let i = 0; i < 5; i++) { t = performance.now(); text = await window.api.transcribeLocal(audio); runs.push(Math.round(performance.now() - t)); }
        return { note: 'ms; audio length ' + (audio.length / 16000).toFixed(1) + ' s', loadMs, runs, text };
      })()`);
      // 7. Local Whisper with early end-of-question detection, real engine, fed in
      // real time (100 ms frames) from the spoken question, then 1.5 s of quiet.
      results.localSpeculation = await js(`(async () => {
        const bytes = Uint8Array.from(atob('${wav}'), (c) => c.charCodeAt(0));
        const pcm = new Int16Array(bytes.buffer, 44, (bytes.length - 44) >> 1);
        const audio = Float32Array.from(pcm, (v) => v / 32768);
        // Trim the file's trailing silence so "speech end" is the last spoken frame.
        let last = audio.length - 1;
        while (last > 0 && Math.abs(audio[last]) < 0.01) last--;
        const speech = audio.subarray(0, last + 1);
        const runs = [];
        for (let run = 0; run < 3; run++) {
          const ev = [];
          const lt = createTranscriber({ transcription: 'local' }, {
            speaker: 'them',
            onTurn: (e, text) => ev.push({ e, text, t: performance.now() }),
            onUtterance: (u) => ev.push({ e: 'final', text: u.text, t: performance.now() }),
          });
          lt.ratio = 1;
          const frames = [];
          for (let i = 0; i < speech.length; i += 1600) frames.push(speech.slice(i, i + 1600));
          for (let i = 0; i < 15; i++) frames.push(new Float32Array(1600));
          let speechEnd = 0;
          const start = performance.now();
          for (let i = 0; i < frames.length; i++) {
            const due = start + i * 100;
            const delay = due - performance.now();
            if (delay > 0) await new Promise((r) => setTimeout(r, delay));
            if (i === Math.ceil(speech.length / 1600)) speechEnd = performance.now();
            lt.onFrame(frames[i]);
          }
          for (let k = 0; k < 100 && !ev.some((x) => x.e === 'final'); k++) await new Promise((r) => setTimeout(r, 50));
          const eagerLast = [...ev].reverse().find((x) => x.e === 'eager');
          const final = ev.find((x) => x.e === 'final');
          runs.push({
            eagerAfterSpeechEndMs: eagerLast ? Math.round(eagerLast.t - speechEnd) : null,
            finalAfterSpeechEndMs: final ? Math.round(final.t - speechEnd) : null,
            eagerSignals: ev.filter((x) => x.e === 'eager').length,
            resumed: ev.filter((x) => x.e === 'resumed').length,
            finalText: final?.text,
            eagerMatchesFinal: !!eagerLast && CoreQuestion.sameQuestion(eagerLast.text, final?.text || ''),
          });
        }
        return { note: 'ms after the last spoken frame. A draft answer starts at the eager signal when it matches the final question.', runs };
      })()`);
      results.memoryAfter = memoryMB();
    } catch (err) {
      results.error = err.stack;
    }
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
    server.close();
    app.exit(0);
  });
});
