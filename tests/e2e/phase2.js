// End-to-end test of Phase 2 (presets, translation, consent + recording,
// search, export, privacy/retention, theme, font) against a fake Ollama.
const electron = require('electron');
const { app } = electron;
const http = require('http');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, 'out', 'phase2');
fs.rmSync(out, { recursive: true, force: true });
const userData = path.join(out, 'userdata');
fs.mkdirSync(path.join(userData, 'sessions'), { recursive: true });
app.setPath('userData', userData);

// Save dialogs return a fixed path instead of opening.
electron.dialog.showSaveDialog = async (_w, opts) => ({ canceled: false, filePath: path.join(out, path.basename(opts.defaultPath)) });

const requests = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = JSON.parse(body || '{}');
    const system = json.messages?.find((m) => m.role === 'system')?.content || '';
    const user = json.messages?.find((m) => m.role === 'user')?.content || '';
    requests.push({ system, user });
    let reply = 'ANSWER';
    if (system.startsWith('You translate interview transcript lines into English')) reply = user.includes('Hello there') ? 'SAME' : 'Tell me about your last project.';
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { content: reply }, done: false }) + '\n');
    res.end(JSON.stringify({ done: true }) + '\n');
  });
});

const day = 86400000;
server.listen(0, () => {
  fs.writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({ provider: 'ollama', ollamaUrl: `http://127.0.0.1:${server.address().port}`, ollamaModel: 'fake', transcription: 'local', answerStyle: 'detailed', jobsMigrated: true }),
  );
  const mk = (id, startedAt, transcript, title) =>
    fs.writeFileSync(path.join(userData, 'sessions', `${id}.json`), JSON.stringify({ id, type: 'live', title, startedAt, transcript, answers: [] }));
  mk('recent', Date.now() - day, [{ speaker: 'them', text: 'How did you scale the Kafka cluster at Northwind?' }, { speaker: 'me', text: 'We partitioned by tenant.' }], 'Northwind call');
  mk('other', Date.now() - 2 * day, [{ speaker: 'them', text: 'Tell me about yourself.' }], 'Intro call');
  mk('ancient', Date.now() - 400 * day, [{ speaker: 'them', text: 'Old question about Kafka' }], 'Old call');
  require(path.join(__dirname, '..', '..', 'src', 'main.js'));
});

const logs = [];
const check = (name, ok, extra = '') => { logs.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); fs.writeFileSync(path.join(out, 'log.txt'), logs.join(String.fromCharCode(10))); };

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
      await wait(1200);
      // font + icons
      check('Inter font loaded', await js(`document.fonts.ready.then(() => document.fonts.check('13px "Inter Variable"'))`));
      check('title bar uses SVG icons', (await js(`document.querySelectorAll('.titlebar svg.icon').length`)) === 4); // compact, pin, minimize, close

      // presets: old answerStyle carries over
      check('old answer style carried over as active preset', (await js(`document.querySelector('#activePreset').value`)) === 'detailed');
      await js(`document.querySelector('.tab[data-tab="settings"]').click()`);
      await wait(400);
      check('built-in preset is read-only', await js(`document.querySelector('#presetName').disabled && !document.querySelector('#presetBuiltInNote').hidden`));
      await js(`document.querySelector('#presetDuplicate').click();
        document.querySelector('#presetName').value='Spanish formal';
        document.querySelector('#presetLength').value='medium'; document.querySelector('#presetTone').value='formal';
        document.querySelector('#presetFormat').value='script'; document.querySelector('#presetLanguage').value='es';
        document.querySelector('#presetPrompt').value='Mention my AWS certification.';
        document.querySelector('#presetForm').requestSubmit();`);
      await until(`[...document.querySelectorAll('#presetPick option')].some(o => o.textContent.startsWith('Spanish formal'))`);
      await js(`document.querySelector('#presetUse').click()`);
      await wait(300);
      const cfg = await js('window.api.getConfig()');
      check('custom preset saved and active', cfg.activePresetId?.startsWith('p-') && (await js(`document.querySelector('#activePreset').selectedOptions[0].textContent`)) === 'Spanish formal');
      await shot('1-settings-presets');

      // answer uses the preset
      await js(`document.querySelector('.tab[data-tab="live"]').click(); document.querySelector('#askInput').value='Why do you want this job?'; document.querySelector('#answerBtn').click();`);
      await until(`document.querySelector('#answers .card:not(.streaming)')`);
      const u = requests.find((r) => r.user.includes('Why do you want this job?'))?.user || '';
      check('answer request follows preset', u.includes('only a spoken answer of about 110 words') && u.includes('Tone: formal and precise') && u.includes('Write the answer in Spanish') && u.includes('<user_instructions>\nMention my AWS certification.'), u.slice(-400));

      // translation
      await js(`window.api.saveConfig({ translateTo: 'en' }).then(c => { state.config = c; })`);
      await wait(200);
      await js(`window.__p = document.createElement('p'); window.__u = { text: 'Cuéntame sobre tu último proyecto.' }; translateLine(window.__p, window.__u)`);
      await until(`window.__p.querySelector('.translation')`);
      check('interviewer line translated and stored', (await js(`window.__p.querySelector('.translation').textContent + '|' + window.__u.translation`)) === 'Tell me about your last project.|Tell me about your last project.');
      await js(`window.__p2 = document.createElement('p'); translateLine(window.__p2, { text: 'Hello there, nice to meet you.' })`);
      await wait(600);
      check('no translation shown when already in English', !(await js(`window.__p2.querySelector('.translation')`)));

      // consent dialog
      await js(`window.__consent = confirmStart(true); 0`);
      await wait(200);
      check('consent dialog opens with Start blocked until consent', await js(`document.querySelector('#startDialog').open && document.querySelector('#dlgStart').disabled && !document.querySelector('#dlgConsentRow').hidden`));
      await shot('2-consent-dialog');
      await js(`document.querySelector('#dlgConsent').click()`);
      check('Start enabled after consent', !(await js(`document.querySelector('#dlgStart').disabled`)));
      await js(`document.querySelector('#dlgStart').click()`);
      const consent = await js('window.__consent');
      check('dialog resolves record=true and saves notice ack', consent?.record === true && (await js('window.api.getConfig()')).liveNoticeAck === true);
      const noDialog = await js(`confirmStart(false)`);
      check('no dialog once acknowledged and not recording', noDialog?.record === false && !(await js(`document.querySelector('#startDialog').open`)));

      // recording with a synthetic tone
      await js(`(async () => { const ctx = new AudioContext(); const osc = ctx.createOscillator(); const dst = ctx.createMediaStreamDestination(); osc.connect(dst); osc.start(); window.__tone = { ctx, osc }; await startRecording('recent', [dst.stream]); })()`);
      await wait(5500);
      const recChip = await js(`!document.querySelector('#chipRec').hidden`);
      await js(`stopRecording()`);
      const rec = await js(`window.api.getRecording('recent').then(b => b ? [b.byteLength, [...new Uint8Array(b).slice(0,4)]] : null)`);
      check('recording written as WebM', recChip && rec && rec[0] > 2000 && rec[1].join(',') === '26,69,223,163', JSON.stringify(rec));
      // mark the session as recorded and check History shows a player
      await js(`window.api.getSession('recent').then(s => window.api.saveSession({ ...s, recorded: true }))`);

      // search + snippet
      await js(`document.querySelector('.tab[data-tab="history"]').click()`);
      await until(`document.querySelectorAll('#historyList li').length >= 2`);
      await js(`const i = document.querySelector('#historySearch'); i.value = 'kafka northwind'; i.dispatchEvent(new Event('input'))`);
      await wait(700);
      const items = await js(`[...document.querySelectorAll('#historyList li')].map(li => li.innerText)`);
      check('search finds only matching session with snippet', items.length === 1 && items[0].includes('Northwind call') && /scale the Kafka cluster/.test(items[0]), JSON.stringify(items));
      await shot('3-search');
      await js(`document.querySelector('#historyList li').click()`);
      await until(`document.querySelector('#historyDetail audio')`);
      check('history detail shows recording player', await js(`!!document.querySelector('#historyDetail audio')`));
      await js(`document.querySelector('#histExport').click()`);
      await wait(600);
      const mdFile = path.join(out, 'Northwind call.md');
      const md = fs.existsSync(mdFile) ? fs.readFileSync(mdFile, 'utf8') : '';
      check('session exported to Markdown', md.startsWith('# Northwind call') && md.includes('**Interviewer:** How did you scale'), md.slice(0, 120));
      await shot('4-history-recording');

      // retention: 365 days removes the 400-day-old session
      await js(`document.querySelector('.tab[data-tab="settings"]').click()`);
      await wait(500);
      await js(`window.confirm = () => true; document.querySelector('#retentionDays').value='365'; document.querySelector('#savePrivacy').click()`);
      await wait(700);
      const ids = (await js('window.api.listSessions()')).map((s) => s.id).sort();
      check('retention deleted only the old session', ids.join(',') === 'other,recent', ids.join(','));
      check('data info and flows shown', /Whisper on this PC/.test(await js(`document.querySelector('#dataFlows').innerText`)) && /2 sessions/.test(await js(`document.querySelector('#dataInfo').textContent`)));

      // export all
      await js(`document.querySelector('#exportAll').click()`);
      await wait(800);
      const exp = fs.readdirSync(out).find((f) => f.startsWith('interview-helper-export-'));
      const bundle = exp ? JSON.parse(fs.readFileSync(path.join(out, exp), 'utf8')) : null;
      check('export all contains sessions and presets, no secrets', bundle && bundle.sessions.length === 2 && bundle.presets.length === 1 && !JSON.stringify(bundle).includes('deepgramKey'));

      // theme
      await js(`document.querySelector('#theme').value='light'; document.querySelector('#saveSettings').click()`);
      await wait(500);
      const bg = await js(`getComputedStyle(document.body).backgroundColor`);
      check('light theme applies', bg === 'rgb(246, 247, 249)', bg);
      await js(`document.querySelector('#tab-settings').scrollTop = 99999`);
      await wait(200);
      await shot('5-settings-light-privacy');
      await js(`document.querySelector('.tab[data-tab="live"]').click()`);
      await wait(300);
      await shot('6-live-light');

      // delete recordings, then everything
      await js(`document.querySelector('.tab[data-tab="settings"]').click()`);
      await wait(300);
      await js(`document.querySelector('#deleteRecordings').click()`);
      await wait(500);
      check('delete all recordings', !(await js(`window.api.getRecording('recent')`)));
      await js(`document.querySelector('#deleteEverything').click()`);
      await wait(2500); // page reloads
      const after = await js(`Promise.all([window.api.listSessions(), window.api.listPresets(), window.api.getConfig(), window.api.listJobs()])`);
      check('delete everything resets data and settings', after[0].length === 0 && after[1].every((p) => p.builtIn) && after[2].provider === 'anthropic' && after[3].length === 0);
    } catch (err) {
      logs.push('[e2e-error] ' + err.stack);
    }
    fs.writeFileSync(path.join(out, 'log.txt'), logs.join('\n'));
    server.close();
    app.exit(0);
  });
});
