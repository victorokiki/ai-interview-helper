// End-to-end test of the Phase 4a career tools through the real UI: resume
// check (match + keywords), tailored resume with PDF/Word export, follow-up
// email from the last interview, company research via a fake Claude server
// speaking the real streaming format (web search, citations, pause_turn),
// saved documents, link safety, and clean-up when a job is deleted.
const electron = require('electron');
const { app } = electron;
const http = require('http');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, 'out', 'career');
fs.rmSync(out, { recursive: true, force: true });
const userData = path.join(out, 'userdata');
fs.mkdirSync(path.join(userData, 'sessions'), { recursive: true });
app.setPath('userData', userData);

electron.dialog.showSaveDialog = async (_w, opts) => ({ canceled: false, filePath: path.join(out, path.basename(opts.defaultPath)) });
const opened = [];
electron.shell.openExternal = async (url) => {
  opened.push(url);
};

const prompts = [];
const anthropicRequests = [];
const REPLIES = {
  check: 'MATCH overall=72 skills=80 experience=65 impact=55\n### Strengths for this role\n- Go and Kafka at scale\n### Gaps\n- Kubernetes\n### Suggested rewrites\n- **Before:** Worked on payments → **After:** Led payments team of 6\n### Keywords to add\n- kubernetes (only if true)',
  resume: '# Jordan Lee\njordan@example.com\n\n## Summary\nBackend engineer.\n\n## Experience\n### Senior Engineer — Northwind, 2021–2025\n- Cut checkout latency from 900 ms to 350 ms\n\n## Skills\nGo, Kafka\n\n## Education\nBSc Computer Science',
  followup: 'Subject: Thank you\n\nHi Sam, thanks for discussing the payments migration today.',
};

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.end();
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = JSON.parse(body || '{}');
    if (req.url.startsWith('/v1/models')) return res.end('{"data":[]}');
    if (req.url.startsWith('/v1/messages')) {
      anthropicRequests.push(json);
      const msg = { id: `msg_${anthropicRequests.length}`, type: 'message', role: 'assistant', model: json.model, content: [], stop_reason: null, usage: { input_tokens: 50, output_tokens: 0 } };
      if (anthropicRequests.length === 1) {
        // First turn: a search, then the server pauses the turn.
        return sse(res, [
          ['message_start', { message: msg }],
          ['content_block_start', { index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} } }],
          ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"Contoso Cloud interview process"}' } }],
          ['content_block_stop', { index: 0 }],
          ['content_block_start', { index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://contoso.example/about', title: 'About Contoso', encrypted_content: 'x', page_age: 'May 2026' }] } }],
          ['content_block_stop', { index: 1 }],
          ['message_delta', { delta: { stop_reason: 'pause_turn', stop_sequence: null }, usage: { output_tokens: 20 } }],
          ['message_stop', {}],
        ]);
      }
      // Resumed turn: text with citations.
      const cite = (url, title) => ({ type: 'web_search_result_location', url, title, cited_text: 'Contoso builds developer cloud tools', encrypted_index: 'e' });
      return sse(res, [
        ['message_start', { message: msg }],
        ['content_block_start', { index: 0, content_block: { type: 'text', text: '', citations: [] } }],
        ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: '## Company snapshot\n' } }],
        ['content_block_stop', { index: 0 }],
        ['content_block_start', { index: 1, content_block: { type: 'text', text: '', citations: [] } }],
        ['content_block_delta', { index: 1, delta: { type: 'citations_delta', citation: cite('https://contoso.example/about', 'About Contoso') } }],
        ['content_block_delta', { index: 1, delta: { type: 'citations_delta', citation: cite('https://news.example/contoso', 'Contoso raises Series C') } }],
        ['content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Contoso builds developer cloud tools.' } }],
        ['content_block_stop', { index: 1 }],
        ['content_block_start', { index: 2, content_block: { type: 'text', text: '', citations: [] } }],
        ['content_block_delta', { index: 2, delta: { type: 'text_delta', text: '\n\n## Compensation\nNot found.' } }],
        ['content_block_stop', { index: 2 }],
        ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 40 } }],
        ['message_stop', {}],
      ]);
    }
    // Ollama
    if (!json.messages?.length) return res.end('{"done":true}');
    const user = json.messages.find((m) => m.role === 'user')?.content || '';
    const system = json.messages.find((m) => m.role === 'system')?.content || '';
    prompts.push({ user, system });
    const tool = user.includes('MATCH overall=N') ? 'check' : user.includes('Rewrite the candidate') ? 'resume' : user.includes('follow-up email') ? 'followup' : 'other';
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { content: REPLIES[tool] || 'Some text.' }, done: false }) + '\n');
    res.end(JSON.stringify({ done: true }) + '\n');
  });
});

server.listen(0, () => {
  const port = server.address().port;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  fs.writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({
      provider: 'ollama',
      ollamaUrl: `http://127.0.0.1:${port}`,
      ollamaModel: 'fake',
      transcription: 'local',
      jobsMigrated: true,
      liveNoticeAck: true,
      meetingDetection: false,
      resume: 'Jordan Lee. Senior Engineer at Northwind 2021-2025. Built Go services on Kafka and PostgreSQL. Cut p99 checkout latency from 900 ms to 350 ms.',
    }),
  );
  fs.writeFileSync(path.join(userData, 'facts.json'), JSON.stringify([{ id: 'f1', category: 'achievement', text: 'Cut p99 checkout latency from 900 ms to 350 ms at Northwind', source: 'resume' }]));
  fs.writeFileSync(
    path.join(userData, 'jobs.json'),
    JSON.stringify([{ id: 'job1', company: 'Contoso Cloud', role: 'Staff Backend Engineer', stage: 'interviewing', jobDescription: 'Build high-throughput APIs in Go and Kafka. Experience with Kubernetes and AWS. Kafka at scale; Go services; distributed systems on-call.', notes: '' }]),
  );
  fs.writeFileSync(
    path.join(userData, 'sessions', 'live1.json'),
    JSON.stringify({ id: 'live1', type: 'live', jobId: 'job1', title: 'Contoso call', startedAt: Date.now() - 3600000, transcript: [{ speaker: 'them', text: 'Tell me about the payments migration.' }], answers: [], summary: '## Overview\nDiscussed the payments migration and on-call.' }),
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
  // Only the first window is the app; later ones are the hidden PDF printer.
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
    const runTool = async (tool) => {
      await js(`document.querySelector('#careerTools [data-tool="${tool}"]').click(); 0`);
      await until(`!document.querySelector('#careerOutput').classList.contains('streaming') && !document.querySelector('#careerTools [data-tool="${tool}"]').disabled`);
      await wait(150);
      return js(`document.querySelector('#careerOutput').innerText`);
    };
    try {
      await wait(1200);
      await js(`document.querySelector('.tab[data-tab="jobs"]').click(); 0`);
      await until(`document.querySelectorAll('#jobList li').length === 1`);
      await js(`document.querySelector('#jobList li').click(); 0`);
      await until(`!document.querySelector('#careerTools').hidden`);
      check('career tools appear for a saved job', await js(`document.querySelectorAll('#careerTools [data-tool]').length === 7`));

      // Resume check
      const checkText = await runTool('check');
      const checkPrompt = prompts.find((p) => p.user.includes('MATCH overall=N'));
      check('resume check prompt has keyword coverage and the no-invention rule', /keyword_coverage coverage="\d+%"/.test(checkPrompt?.user || '') && /never invent employers/.test(checkPrompt?.system || '') && /<verified_facts>/.test(checkPrompt?.system || ''));
      check('match score and bars shown, MATCH line hidden', /72\s*% match/.test(checkText) && /Skills\s*80%/.test(checkText) && !checkText.includes('MATCH overall'), checkText.slice(0, 160));
      check('keyword chips show present and missing terms', (await js(`document.querySelectorAll('.kw.yes').length > 0 && document.querySelectorAll('.kw.no').length > 0 && [...document.querySelectorAll('.kw.no')].some((k) => k.textContent === 'kubernetes')`)));
      fs.writeFileSync(path.join(out, '1-resume-check.png'), (await win.webContents.capturePage()).toPNG());

      // Tailored resume + exports
      const resumeText = await runTool('resume');
      check('tailored resume generated', resumeText.includes('Jordan Lee') && resumeText.includes('Northwind'));
      await js(`document.querySelector('#careerOutput [data-act="pdf"]').click(); 0`);
      await wait(2500);
      await js(`document.querySelector('#careerOutput [data-act="docx"]').click(); 0`);
      await wait(800);
      const pdf = path.join(out, 'Tailored resume - Contoso Cloud.pdf');
      const docx = path.join(out, 'Tailored resume - Contoso Cloud.docx');
      check('PDF export written', fs.existsSync(pdf) && fs.readFileSync(pdf).slice(0, 5).toString() === '%PDF-' && fs.statSync(pdf).size > 5000, fs.existsSync(pdf) ? `${fs.statSync(pdf).size} bytes` : 'missing');
      let docxText = '';
      if (fs.existsSync(docx)) docxText = (await require('mammoth').extractRawText({ path: docx })).value;
      check('Word export written with the resume text', docxText.includes('Jordan Lee') && docxText.includes('Cut checkout latency'), docxText.slice(0, 80));

      // Follow-up email uses the last interview for this job
      await runTool('followup');
      const fu = prompts.find((p) => p.user.includes('follow-up email'));
      check('follow-up email uses the last interview summary', fu?.user.includes('Discussed the payments migration') && fu.user.includes('<last_interview'));

      // Research needs Claude
      const needClaude = await runTool('research');
      check('research explains it needs Claude when another provider is selected', /needs?\s.*Claude|Choose Claude/i.test(needClaude), needClaude.slice(0, 120));

      // Research with (fake) Claude: web search + citations + pause_turn
      await js(`window.api.saveConfig({ provider: 'anthropic', anthropicKey: 'test-key', anthropicModel: 'claude-opus-5-5' }).then((c) => { state.config = c; })`);
      await wait(200);
      const researchText = await runTool('research');
      check('research sends the web search tool', anthropicRequests[0]?.tools?.[0]?.type === 'web_search_20250305' && anthropicRequests[0].tools[0].max_uses > 0);
      check('pause_turn resumed with the paused assistant turn', anthropicRequests.length === 2 && anthropicRequests[1].messages[1]?.role === 'assistant' && anthropicRequests[1].messages[1].content.some((b) => b.type === 'server_tool_use'));
      check('research shows numbered citations and a source list', /developer cloud tools\. \[1\] \[2\]/.test(researchText) && /Sources/.test(researchText) && (await js(`document.querySelectorAll('#careerOutput a[href^="https://"]').length === 2`)), researchText.slice(0, 200));
      fs.writeFileSync(path.join(out, '2-research.png'), (await win.webContents.capturePage()).toPNG());

      // Links open outside the app; the window stays put.
      const before = win.webContents.getURL();
      await js(`document.querySelector('#careerOutput a[href^="https://"]').click(); 0`);
      await wait(500);
      check('source links open in the browser, not in the app', opened.includes('https://contoso.example/about') && win.webContents.getURL() === before, JSON.stringify(opened));

      // Saved documents
      const saved = await js(`window.api.careerList('job1')`);
      check('documents saved per job (check, resume, follow-up, research)', ['check', 'resume', 'followup', 'research'].every((k) => saved.some((a) => a.kind === k)) && saved.find((a) => a.kind === 'research').sources.length === 2 && saved.find((a) => a.kind === 'check').match.overall === 72, saved.map((a) => a.kind).join(','));
      check('saved list shows them', (await js(`document.querySelectorAll('#careerList li.clickable').length`)) === saved.length);

      // Deleting the job removes its documents
      await js(`window.confirm = () => true; document.querySelector('#deleteJob').click(); 0`);
      await wait(600);
      check('deleting a job deletes its documents', (await js(`window.api.careerList('job1')`)).length === 0);
    } catch (err) {
      logs.push('[e2e-error] ' + err.stack);
    }
    fs.writeFileSync(path.join(out, 'log.txt'), logs.join(String.fromCharCode(10)));
    server.close();
    app.exit(0);
  });
});
