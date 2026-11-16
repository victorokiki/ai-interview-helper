// End-to-end test of the Obsidian export: choosing a vault in Settings, the
// first export, Open in Obsidian, automatic updates after changes in the app,
// a note edited in Obsidian left alone, deleted sessions removed, the
// transcripts and auto-update switches, Stop exporting, and Delete everything.
const electron = require('electron');
const { app, dialog, shell } = electron;
const fs = require('fs');
const path = require('path');

process.env.INTERVIEW_HELPER_VAULT_DELAY = '150';
const out = path.join(__dirname, 'out', 'vault');
fs.rmSync(out, { recursive: true, force: true });
const userData = path.join(out, 'userdata');
const vaultPath = path.join(out, 'My Vault');
fs.mkdirSync(path.join(userData, 'sessions'), { recursive: true });
fs.mkdirSync(path.join(vaultPath, '.obsidian'), { recursive: true });
fs.writeFileSync(path.join(vaultPath, 'Daily note.md'), 'mine');
app.setPath('userData', userData);

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [vaultPath] });
const opened = [];
shell.openExternal = async (url) => opened.push(url);

const now = Date.now();
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ provider: 'ollama', ollamaUrl: 'http://127.0.0.1:9', transcription: 'local', jobsMigrated: true, liveNoticeAck: true, meetingDetection: false, activeJobId: 'j1' }));
fs.writeFileSync(path.join(userData, 'jobs.json'), JSON.stringify([{ id: 'j1', company: 'Contoso', role: 'SRE', stage: 'interviewing', interviewAt: now + 2 * 86400000, notes: 'First notes', createdAt: 1 }, { id: 'j2', company: 'Fabrikam', role: 'PM', stage: 'applied', createdAt: 2 }]));
fs.writeFileSync(path.join(userData, 'sessions', 'live1.json'), JSON.stringify({ id: 'live1', type: 'live', jobId: 'j1', title: 'Contoso recruiter screen', startedAt: now - 86400000, summary: '## Overview\nGood call.', transcript: [{ speaker: 'them', text: 'Why Contoso?' }, { speaker: 'me', text: 'Your scale.' }], answers: [] }));
fs.writeFileSync(path.join(userData, 'sessions', 'mock1.json'), JSON.stringify({ id: 'mock1', type: 'mock', jobId: 'j2', title: 'Mock (behavioral) — 1 question', startedAt: now - 2 * 86400000, answers: [{ kind: 'mock', question: 'Tell me about a failure.', myAnswer: 'x', scores: { overall: 6 }, answer: 'ok' }] }));
fs.writeFileSync(path.join(userData, 'lessons.json'), JSON.stringify([{ id: 'l1', text: 'Lead with the result.', kind: 'structure', status: 'approved', jobId: null, decidedAt: 1 }]));
require(path.join(__dirname, '..', '..', 'src', 'main.js'));

const logs = [];
const check = (name, ok, extra = '') => {
  logs.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  fs.writeFileSync(path.join(out, 'log.txt'), logs.join(String.fromCharCode(10)));
};
const sub = path.join(vaultPath, 'Interview Helper');
const read = (rel) => (fs.existsSync(path.join(sub, rel)) ? fs.readFileSync(path.join(sub, rel), 'utf8') : null);
const list = (dir) => (fs.existsSync(path.join(sub, dir)) ? fs.readdirSync(path.join(sub, dir)) : []);

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
    const until = async (cond, ms = 6000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (typeof cond === 'function' ? cond() : await js(cond)) return true;
        await wait(50);
      }
      return false;
    };
    const job = async (id) => (await js('window.api.listJobs()')).find((j) => j.id === id);
    try {
      await wait(1000);
      // 1. Off until a folder is chosen.
      await js(`document.querySelector('.tab[data-tab="settings"]').click(); 0`);
      await until(`/Not set up/.test(document.querySelector('#vaultStatus').textContent)`);
      check('not set up by default; switches disabled', (await js(`document.querySelector('#vaultAuto').disabled && document.querySelector('#vaultSync').hidden`)) && !fs.existsSync(sub));

      // 2. Choose the vault: first export.
      await js(`document.querySelector('#vaultChoose').click(); 0`);
      await until(`/Obsidian vault/.test(document.querySelector('#vaultStatus').textContent)`);
      const status = await js(`document.querySelector('#vaultStatus').textContent`);
      check('status names the vault and the note count', status.includes(vaultPath) && /Updated just now: 8 notes, 8 written/.test(status), status);
      check('notes written in their own subfolder', JSON.stringify(list('Jobs').sort()) === JSON.stringify(['Contoso — SRE.md', 'Fabrikam — PM.md']) && list('Sessions').length === 2 && read('Interview Helper.md') && read('Lessons.md') && read('Interview Brain.md') && read('Question bank.md'));
      check('your other notes untouched', fs.readFileSync(path.join(vaultPath, 'Daily note.md'), 'utf8') === 'mine');
      const contoso = read('Jobs/Contoso — SRE.md');
      check('job note has properties, notes and a link to its session', /^---\ntags:\n  - "interview-helper"\n  - "job"\ncompany: "Contoso"/.test(contoso) && contoso.includes('First notes') && /\[\[Interview Helper\/Sessions\/.* Contoso recruiter screen\|Contoso recruiter screen\]\]/.test(contoso));
      const liveNote = () => read(`Sessions/${list('Sessions').find((f) => f.includes('recruiter'))}`);
      check('transcripts left out by default', /Transcript \(2 lines\) not exported/.test(liveNote()) && !liveNote().includes('Why Contoso?'));
      fs.writeFileSync(path.join(out, 'settings.png'), (await win.webContents.capturePage()).toPNG());

      // 3. Open in Obsidian.
      await js(`document.querySelector('#vaultObsidian').click(); 0`);
      await until(() => opened.length > 0);
      check('Open in Obsidian uses the obsidian:// link to the home note', opened[0] === `obsidian://open?path=${encodeURIComponent(path.join(sub, 'Interview Helper.md'))}`, opened[0]);

      // 4. Changes in the app update the notes.
      await js(`window.api.saveJob({ ...${JSON.stringify(await job('j1'))}, notes: 'Updated in the app' })`);
      await until(() => read('Jobs/Contoso — SRE.md')?.includes('Updated in the app'));
      check('saving a job updates its note automatically', read('Jobs/Contoso — SRE.md').includes('Updated in the app'));

      // 5. A note edited in Obsidian is left alone.
      fs.appendFileSync(path.join(sub, 'Jobs', 'Contoso — SRE.md'), '\n## My own prep\nAsk about on-call.');
      await js(`window.api.saveJob({ ...${JSON.stringify(await job('j1'))}, notes: 'Changed again' })`);
      await js(`window.api.saveJob({ ...${JSON.stringify(await job('j2'))}, notes: 'Fabrikam notes' })`);
      await until(() => read('Jobs/Fabrikam — PM.md')?.includes('Fabrikam notes'));
      await until(`/1 note you edited/.test(document.querySelector('#vaultStatus').textContent)`);
      check('edited note kept as you wrote it; others still update', read('Jobs/Contoso — SRE.md').includes('Ask about on-call.') && !read('Jobs/Contoso — SRE.md').includes('Changed again') && read('Jobs/Fabrikam — PM.md').includes('Fabrikam notes'));
      check('status says an edited note was left alone', /1 note you edited \(or that were already there\) left alone/.test(await js(`document.querySelector('#vaultStatus').textContent`)));

      // 6. Deleting a session removes its note.
      await js(`window.api.deleteSession('mock1')`);
      await until(() => list('Sessions').length === 1);
      check('deleted session note removed', list('Sessions').length === 1 && !read('Jobs/Fabrikam — PM.md').includes('Mock (behavioral)'));

      // 7. Transcripts switch.
      await js(`document.querySelector('#vaultTranscripts').click(); 0`);
      await until(() => liveNote()?.includes('Why Contoso?'));
      check('Include full transcripts adds them', /## Transcript\n\n\*\*Interviewer:\*\* Why Contoso\?/.test(liveNote()));

      // 8. Auto-update off.
      await js(`document.querySelector('#vaultAuto').click(); 0`);
      await wait(200);
      await js(`window.api.saveJob({ ...${JSON.stringify(await job('j2'))}, notes: 'Not exported yet' })`);
      await wait(600);
      check('with auto-update off, changes wait for Update now', !read('Jobs/Fabrikam — PM.md').includes('Not exported yet'));
      await js(`document.querySelector('#vaultSync').click(); 0`);
      await until(() => read('Jobs/Fabrikam — PM.md')?.includes('Not exported yet'));
      check('Update now exports them', read('Jobs/Fabrikam — PM.md').includes('Not exported yet'));

      // 9. Stop exporting leaves the notes where they are.
      await js(`document.querySelector('#vaultStop').click(); 0`);
      await until(`/Not set up/.test(document.querySelector('#vaultStatus').textContent)`);
      await js(`window.api.saveJob({ ...${JSON.stringify(await job('j2'))}, notes: 'After stopping' })`);
      await wait(500);
      check('Stop exporting: no more writes, notes stay', read('Jobs/Fabrikam — PM.md').includes('Not exported yet') && !read('Jobs/Fabrikam — PM.md').includes('After stopping'));

      // 10. Delete everything removes our unchanged notes, keeps edited ones and your own.
      await js(`window.api.vaultChoose()`);
      await wait(300);
      await js(`window.api.deleteData('everything')`);
      await wait(400);
      check('Delete everything removes exported notes but not edited ones or your own', !read('Lessons.md') && !read('Jobs/Fabrikam — PM.md') && read('Jobs/Contoso — SRE.md')?.includes('Ask about on-call.') && fs.existsSync(path.join(vaultPath, 'Daily note.md')));
    } catch (err) {
      logs.push('[e2e-error] ' + err.stack);
    }
    fs.writeFileSync(path.join(out, 'log.txt'), logs.join(String.fromCharCode(10)));
    app.exit(0);
  });
});
