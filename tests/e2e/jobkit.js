// End-to-end test of the Autonomous Job Kit import: a copy of a real
// job-search folder (tracker.xlsx written by the kit's tracker.py, job
// folders, PDFs, profile.json) through the folder picker, the review list,
// applying it, what the AI prompt then contains, re-importing, the job
// editor's "What you sent", the Settings switch, folder links that point
// outside the folder, and that nothing in the folder is changed.
const electron = require('electron');
const { app, dialog } = electron;
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const out = path.join(__dirname, 'out', 'jobkit');
fs.rmSync(out, { recursive: true, force: true });
const userData = path.join(out, 'userdata');
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);

// A copy of the fixture, so the test can prove nothing in it is changed.
const kitFolder = path.join(out, 'job-search');
fs.cpSync(path.join(__dirname, '..', 'fixtures', 'jobkit', 'job-search'), kitFolder, { recursive: true });
function folderHash(dir) {
  const h = crypto.createHash('sha256');
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      h.update(path.relative(dir, p));
      if (e.isDirectory()) walk(p);
      else h.update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}
const before = folderHash(kitFolder);

// A second folder whose tracker links to a folder outside it.
const evil = path.join(out, 'evil');
const secret = path.join(out, 'secret');
fs.mkdirSync(evil, { recursive: true });
fs.mkdirSync(secret, { recursive: true });
fs.writeFileSync(path.join(secret, 'application-record.md'), '# X\n\n## Written answers\n### Q\nSECRET-TEXT\n');

let pickFolder = kitFolder;
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pickFolder] });

const requests = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = JSON.parse(body || '{}');
    if (!json.messages?.length) return res.end('{"done":true}');
    const system = json.messages.find((m) => m.role === 'system')?.content || '';
    requests.push({ system, user: json.messages.find((m) => m.role === 'user')?.content || '' });
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { content: 'OK' }, done: false }) + '\n');
    res.end(JSON.stringify({ done: true }) + '\n');
  });
});

server.listen(0, async () => {
  const JSZip = require('jszip');
  const zip = new JSZip();
  zip.file('xl/workbook.xml', '<workbook xmlns:r="r"><sheets><sheet name="Applications" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file('xl/worksheets/sheet1.xml', '<worksheet xmlns:r="r"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Company</t></is></c><c r="B1" t="inlineStr"><is><t>Role</t></is></c><c r="C1" t="inlineStr"><is><t>Folder</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Sneaky</t></is></c><c r="B2" t="inlineStr"><is><t>Role</t></is></c><c r="C2" t="inlineStr"><is><t>Open folder</t></is></c></row></sheetData><hyperlinks><hyperlink ref="C2" r:id="rId1"/></hyperlinks></worksheet>');
  zip.file('xl/worksheets/_rels/sheet1.xml.rels', '<Relationships><Relationship Id="rId1" Target="../secret" TargetMode="External"/></Relationships>');
  fs.writeFileSync(path.join(evil, 'tracker.xlsx'), await zip.generateAsync({ type: 'nodebuffer' }));

  const port = server.address().port;
  fs.writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({ provider: 'ollama', ollamaUrl: `http://127.0.0.1:${port}`, ollamaModel: 'fake', transcription: 'local', jobsMigrated: true, liveNoticeAck: true, meetingDetection: false, activeJobId: 'j1', resume: 'Alex Tremblay, data analyst.', autoAnswer: false }),
  );
  fs.writeFileSync(path.join(userData, 'jobs.json'), JSON.stringify([{ id: 'j1', company: 'Northwind Freight', role: 'Junior Data Analyst', stage: 'applied', notes: 'Referred by Kim.', jobDescription: '' }]));
  fs.writeFileSync(path.join(userData, 'facts.json'), JSON.stringify([{ id: 'f1', category: 'other', text: 'Notice period: Two weeks', source: 'me' }]));
  require(path.join(__dirname, '..', '..', 'src', 'main.js'));
});

const logs = [];
const check = (name, ok, extra = '') => {
  logs.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  fs.writeFileSync(path.join(out, 'log.txt'), logs.join(String.fromCharCode(10)));
};
const readJobs = () => JSON.parse(fs.readFileSync(path.join(userData, 'jobs.json'), 'utf8'));
const readConfig = () => JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));

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
    const until = async (code, ms = 15000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await js(code)) return true;
        await wait(50);
      }
      return false;
    };
    const ask = async (question) => {
      requests.length = 0;
      await js(`window.api.answer({ id: 'q${Date.now()}', question: ${JSON.stringify(question)}, transcript: [] })`);
      const end = Date.now() + 8000;
      while (!requests.length && Date.now() < end) await wait(50);
      return requests[0]?.system || '';
    };
    try {
      await wait(1000);
      // 1. Before importing: no application in the prompt.
      const plain = await ask('What salary are you expecting?');
      check('before import the prompt has no application block', plain.length > 0 && !plain.includes('<application_sent>\nThe candidate'));

      // 2. Pick the folder: the review list.
      await js(`document.querySelector('.tab[data-tab="jobs"]').click(); 0`);
      await until(`document.querySelectorAll('#jobList li').length === 1`);
      await js(`document.querySelector('#importJobKit').click(); 0`);
      await until(`!document.querySelector('#jobkitReview').hidden`);
      const rows = await js(`[...document.querySelectorAll('#jobkitList li')].map((li) => [li.querySelector('.cal-title').textContent.trim(), li.querySelector('select').value, li.querySelector('.meta').textContent])`);
      check('review lists the four tracker rows with suggested actions', JSON.stringify(rows.map((r) => r[1])) === JSON.stringify(['update:j1', 'new', 'skip', 'new']), JSON.stringify(rows.map((r) => r.slice(0, 2))));
      check('Northwind row shows status, interview time and what was sent', /Interviewing → Interviewing/.test(rows[0][2]) && /interview .*Dec 3/.test(rows[0][2]) && /sent: résumé, cover letter, 2 written answers, 3 form fields, 2 gaps/.test(rows[0][2]), rows[0][2]);
      check('lean application shows its pasted answers; skipped row says why', /sent: résumé, 3 written answers/.test(rows[1][2]) && /Skipped in the job kit/.test(rows[2][2]) && /Rejected → Rejected/.test(rows[3][2]), `${rows[1][2]} | ${rows[2][2]}`);
      const facts = await js(`[...document.querySelectorAll('#jobkitFacts li')].map((li) => [li.textContent.trim(), li.querySelector('input').checked])`);
      const factText = facts.map((f) => f[0]).join(' | ');
      check('profile facts offered (interview ones ticked), existing fact not repeated', facts.some((f) => f[0] === 'Salary expectation: $60,000 to $65,000' && f[1]) && facts.some((f) => /^How did you hear/.test(f[0]) && !f[1]) && !factText.includes('Notice period: Two weeks'), factText.slice(0, 300));
      check('self-identification is never offered', !/Woman|Test value|age|years of age|accommodation/i.test(factText));
      check('nothing changed before Import', readJobs().length === 1 && !readJobs()[0].application);
      fs.writeFileSync(path.join(out, 'review.png'), (await win.webContents.capturePage()).toPNG());

      // 3. Import (untick one suggested fact).
      await js(`[...document.querySelectorAll('#jobkitFacts li')].find((li) => li.textContent.includes('Security clearance')).querySelector('input').click(); 0`);
      await js(`document.querySelector('#jobkitApply').click(); 0`);
      await until(`/Job Kit import:/.test(document.querySelector('#banner').textContent)`);
      const bannerText = await js(`document.querySelector('#banner').textContent`);
      check('banner summarises the import', /added 2 jobs, updated 1, \d+ facts added to Interview Brain/.test(bannerText), bannerText);
      const jobs = readJobs();
      const nw = jobs.find((j) => j.id === 'j1');
      const bw = jobs.find((j) => j.company === 'Bluewater Bank');
      const fab = jobs.find((j) => j.company === 'Fabrikam');
      check('Contoso (skipped) was not added', jobs.length === 3 && !jobs.some((j) => j.company === 'Contoso Ltd'));
      check('Northwind: stage, interview time, deadline, URL, description, notes kept', nw.stage === 'interviewing' && nw.interviewAt === new Date(2026, 11, 3, 14, 0).getTime() && nw.applyBy === new Date(2026, 10, 30, 23, 59).getTime() && nw.url === 'https://example.com/jobs/123' && /^Location: Halifax, NS \(hybrid\)\nPay: \$58,000/.test(nw.jobDescription) && /^Referred by Kim\.\nJob kit: Interviewing \(2026-11-16\), stage: Technical round, next step: Prepare SQL questions\./.test(nw.notes), JSON.stringify({ stage: nw.stage, notes: nw.notes }));
      const a = nw.application || {};
      check('Northwind: résumé and letter text read from the real PDFs', /6 hours to 40 minutes/.test(a.resumeText) && /Harbourline Logistics/.test(a.resumeText) && /Dear Northwind Freight hiring team/.test(a.letterText) && a.resumeFile === 'Alex_Tremblay_Resume_Northwind.pdf' && a.letterFile === 'Alex_Tremblay_Cover_Letter_Northwind.pdf');
      check('Northwind: answers, form fields without contact details, edits, gaps', a.answers?.length === 2 && JSON.stringify(a.fields.map((f) => f.label)) === JSON.stringify(['Salary expectations', 'Earliest start date', 'Are you legally entitled to work in Canada?']) && a.changesBeforeSubmitting?.[0]?.includes('$62,000') && a.gaps?.length === 2 && nw.jobKit?.id === 'A0001', JSON.stringify(a.fields));
      check('Bluewater: new job from a lean application', bw.stage === 'applied' && bw.application?.lean === true && bw.application.answers.length === 3 && !bw.application.letterText && /Built weekly reports/.test(bw.application.resumeText) && bw.url === 'https://boards.greenhouse.io/bluewater/jobs/4455');
      check('Fabrikam: rejected, no folder, no application', fab.stage === 'rejected' && !fab.application);
      const factsNow = JSON.parse(fs.readFileSync(path.join(userData, 'facts.json'), 'utf8')).map((f) => f.text);
      check('ticked facts added; unticked and existing ones not', factsNow.includes('Salary expectation: $60,000 to $65,000') && !factsNow.includes('Security clearance: None (willing to obtain)') && factsNow.filter((t) => t === 'Notice period: Two weeks').length === 1 && !factsNow.some((t) => t.startsWith('How did you hear')));
      check('folder remembered', readConfig().jobKitFolder === kitFolder);
      const cfgAfter = readConfig();
      check('search.json and work authorization saved for the job check (nothing else from the profile)', cfgAfter.jobSearch?.tracks?.data?.titles?.includes('data analyst') && cfgAfter.jobSearch.province === 'NS' && cfgAfter.workSituation?.workAuthDetails === 'Canadian citizen' && !('gender' in cfgAfter.workSituation) && !('race' in cfgAfter.workSituation) && !('email' in cfgAfter.workSituation), JSON.stringify(cfgAfter.workSituation));
      check('nothing in the job-search folder changed', folderHash(kitFolder) === before);

      // 4. The prompt for the active job now carries what was sent.
      const sys = await ask('What salary are you expecting?');
      check('live answer prompt has the application block', sys.includes('<application_sent>\nThe candidate already sent this application to Northwind Freight, Junior Data Analyst') && sys.includes('<resume_sent file="Alex_Tremblay_Resume_Northwind.pdf">') && sys.includes('- Salary expectations: $62,000') && sys.includes('<known_gaps>'));
      check('grounding names the application; contact fields from the form not repeated', sys.includes('<candidate_resume> or <application_sent>') && !/- (Email|First name):/.test(sys));

      // 5. Job editor: What you sent; saving the form keeps it.
      await until(`document.querySelectorAll('#jobList li').length === 3`);
      await js(`[...document.querySelectorAll('#jobList li')].find((li) => li.textContent.includes('Northwind')).click(); 0`);
      await until(`!document.querySelector('#jobForm').hidden`);
      check('job editor shows What you sent', !(await js(`document.querySelector('#sentBox').hidden`)) && /résumé, cover letter, 2 written answers/.test(await js(`document.querySelector('#sentSummary').textContent`)));
      await js(`document.querySelector('#sentBox').open = true; document.querySelector('#sentBox').scrollIntoView(); 0`);
      check('What you sent lists the résumé text and answers', /6 hours to 40 minutes/.test(await js(`document.querySelector('#sentBody').textContent`)) && /Why do you want to work at Northwind Freight\?/.test(await js(`document.querySelector('#sentBody').textContent`)));
      await js(`(() => { const box = document.querySelector('#sentBox'); for (let el = box.parentElement; el; el = el.parentElement) if (el.scrollHeight > el.clientHeight) el.scrollTop += box.getBoundingClientRect().top - 120; })(); 0`);
      await wait(400);
      fs.writeFileSync(path.join(out, 'sent.png'), (await win.webContents.capturePage()).toPNG());
      await js(`document.querySelector('#jobStage').value = 'offer'; document.querySelector('#jobForm').requestSubmit(); 0`);
      await wait(400);
      check('saving the job form keeps the application and job-kit link', readJobs().find((j) => j.id === 'j1').application?.resumeText?.length > 50 && readJobs().find((j) => j.id === 'j1').jobKit?.id === 'A0001' && readJobs().find((j) => j.id === 'j1').stage === 'offer');

      // 6. Re-import: matched by the link; the user's stage and notes stay.
      const again = await js(`window.api.jobKitPlan(false)`);
      const nwItem = again.items.find((i) => i.app.trackerId === 'A0001');
      check('re-import matches the linked job', nwItem.action === 'update' && nwItem.jobId === 'j1' && again.items.filter((i) => i.action === 'update').length === 3, JSON.stringify(again.items.map((i) => [i.app.company, i.action])));
      const notesBefore = readJobs().find((j) => j.id === 'j1').notes;
      await js(`window.api.jobKitApply(${JSON.stringify(again.items.filter((i) => i.action !== 'skip').map((i) => ({ key: i.app.key, action: i.action, jobId: i.jobId })))}, [])`);
      const after = readJobs();
      check('re-import keeps the user\'s stage, adds no duplicate jobs or notes', after.length === 3 && after.find((j) => j.id === 'j1').stage === 'offer' && after.find((j) => j.id === 'j1').notes === notesBefore);

      // 7. Settings: status and the switch.
      await js(`document.querySelector('.tab[data-tab="settings"]').click(); 0`);
      await until(`/job-search/.test(document.querySelector('#jobkitStatus').textContent)`);
      check('Settings shows the folder and how many jobs have what you sent', /2 jobs have what you sent attached/.test(await js(`document.querySelector('#jobkitStatus').textContent`)) && (await js(`document.querySelector('#useSentApplication').checked`)));
      await js(`document.querySelector('#useSentApplication').click(); 0`);
      await until(`window.api.getConfig().then((c) => c.useSentApplication === false)`);
      const off = await ask('What salary are you expecting?');
      check('turned off: the prompt no longer has it', off.length > 0 && !off.includes('<application_sent>\nThe candidate'));
      await js(`document.querySelector('#useSentApplication').click(); 0`);
      await until(`window.api.getConfig().then((c) => c.useSentApplication !== false)`);

      // 8. Remove from one job.
      await js(`window.api.clearApplication('j1')`);
      check('Remove clears it from the job only', !readJobs().find((j) => j.id === 'j1').application && !!readJobs().find((j) => j.company === 'Bluewater Bank').application);
      const removed = await ask('What salary are you expecting?');
      check('after removing, the prompt has no application block', !removed.includes('<application_sent>\nThe candidate'));

      // 9. A tracker whose folder link leads outside the job-search folder.
      pickFolder = evil;
      const evilPlan = await js(`window.api.jobKitPlan(true)`);
      check('folder links outside the job-search folder are not read', evilPlan.items.length === 1 && !evilPlan.items[0].app.application && evilPlan.errors.some((e) => /outside the job-search folder/.test(e)) && !JSON.stringify(evilPlan).includes('SECRET-TEXT'), JSON.stringify(evilPlan.errors));
      pickFolder = path.join(out, 'nothing-here');
      fs.mkdirSync(pickFolder, { recursive: true });
      const empty = await js(`window.api.jobKitPlan(true)`);
      check('an unrelated folder is explained, and not remembered', empty.items.length === 0 && /No tracker\.xlsx or Applications folder/.test(empty.errors[0]) && readConfig().jobKitFolder === evil);
    } catch (err) {
      logs.push('[e2e-error] ' + err.stack);
    }
    fs.writeFileSync(path.join(out, 'log.txt'), logs.join(String.fromCharCode(10)));
    server.close();
    app.exit(0);
  });
});
