// End-to-end test of step 2 of the Autonomous Job Kit integration: reading a
// posting from its link (only known job sites, every redirect checked), the
// job check (fit score, scam warnings, eligibility) in the editor and the
// jobs list, Profile → Your job search, and the local fact check under live
// answers and career documents. Job sites are stood in for by replacing
// Node's fetch (the only network path src/postings.js uses); the AI is a fake
// Ollama server.
const electron = require('electron');
const { app } = electron;
const fs = require('fs');
const http = require('http');
const path = require('path');

const out = path.join(__dirname, 'out', 'jobcheck');
fs.rmSync(out, { recursive: true, force: true });
const userData = path.join(out, 'userdata');
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);

const FIX = path.join(__dirname, '..', 'fixtures', 'jobkit');
const greenhouse = fs.readFileSync(path.join(FIX, 'postings', 'greenhouse_job.json'), 'utf8');

// Stand-in job sites. Every URL the app asks for is logged.
const fetched = [];
const realFetch = global.fetch;
global.fetch = async (url, init = {}) => {
  const u = String(url);
  fetched.push(u);
  const json = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/json' } });
  if (/^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/stripe\/jobs\/8194287/.test(u)) return json(greenhouse);
  if (/^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/stripe\/?(\?|$)/.test(u)) return json('{"name":"Stripe"}');
  if (/^https:\/\/api\.lever\.co\/v0\/postings\/bouncy\//.test(u)) return new Response('', { status: 302, headers: { location: 'https://evil.example.com/steal' } });
  if (/^https:\/\/(127\.0\.0\.1|localhost)/.test(u)) return realFetch(url, init);
  return new Response('not found', { status: 404 });
};

const SEARCH = JSON.parse(fs.readFileSync(path.join(FIX, 'job-search', 'search.json'), 'utf8'));
const RESUME = 'Jordan Lee. Data Analyst at Harbourline Logistics. Led the Kafka migration that cut reporting latency by 20%. Skills: Python, SQL, Power BI, Excel.';
const NORTHWIND = 'Location: Halifax, NS (hybrid)\nPay: $58,000 to $66,000\n\nWe are looking for a data analyst to build dashboards in Power BI and Tableau and write SQL against PostgreSQL. 2+ years of experience. Snowflake is an asset. Must be a Canadian citizen.';
const SCAM = 'Data entry clerk, work from home. Before you start you must pay a $50 training fee with gift cards. Message the hiring manager on Telegram for an instant interview.';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = JSON.parse(body || '{}');
    if (!json.messages?.length) return res.end('{"done":true}');
    const user = json.messages.find((m) => m.role === 'user')?.content || '';
    let reply = '- Led the Kafka migration that cut reporting latency by 20%\n- Managed Terraform infrastructure for 40 services [add metric]';
    if (user.includes('<question>')) {
      reply = user.includes('invented')
        ? '- **Result:** cut latency by 35%\n- Ran it on Kubernetes\n\n**Spoken answer:**\n"I led our Kafka migration and cut latency by 35% on Kubernetes."'
        : '- **Result:** cut reporting latency by 20%\n\n**Spoken answer:**\n"At Harbourline Logistics I led the Kafka migration and cut reporting latency by 20%."';
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { content: reply }, done: false }) + '\n');
    res.end(JSON.stringify({ done: true }) + '\n');
  });
});

server.listen(0, () => {
  const port = server.address().port;
  fs.writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({
      provider: 'ollama', ollamaUrl: `http://127.0.0.1:${port}`, ollamaModel: 'fake', transcription: 'local', jobsMigrated: true, liveNoticeAck: true, meetingDetection: false, activeJobId: 'j1', resume: RESUME, autoAnswer: false,
      jobSearch: require('../../packages/core/jobkit').cleanSearch(SEARCH),
      workSituation: { authCountry: 'Canada', workAuthDetails: 'PGWP until 2027-05-01', workAuthorized: 'yes' },
    }),
  );
  fs.writeFileSync(
    path.join(userData, 'jobs.json'),
    JSON.stringify([
      { id: 'j1', company: 'Northwind Freight', role: 'Data Analyst', stage: 'applied', jobDescription: NORTHWIND },
      { id: 'j2', company: 'Quick Cash Jobs', role: 'Data Entry Clerk', stage: 'saved', jobDescription: SCAM },
    ]),
  );
  require(path.join(__dirname, '..', '..', 'src', 'main.js'));
});

const logs = [];
const check = (name, ok, extra = '') => {
  logs.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  fs.writeFileSync(path.join(out, 'log.txt'), logs.join(String.fromCharCode(10)));
};
const readJobs = () => JSON.parse(fs.readFileSync(path.join(userData, 'jobs.json'), 'utf8'));
const allowedOnly = () => fetched.filter((u) => !/^https:\/\/(127\.0\.0\.1|localhost)/.test(u)).every((u) => require('../../packages/core/postings').isAllowedUrl(u));

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
    const until = async (code, ms = 10000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await js(code)) return true;
        await wait(50);
      }
      return false;
    };
    const openJob = async (name) => {
      await js(`document.querySelector('.tab[data-tab="jobs"]').click(); 0`);
      await until(`document.querySelectorAll('#jobList li').length >= 2 && !document.querySelector('#jobList').hidden`);
      await js(`[...document.querySelectorAll('#jobList li')].find((li) => li.textContent.includes(${JSON.stringify(name)})).click(); 0`);
      await until(`!document.querySelector('#jobForm').hidden`);
    };
    try {
      await wait(1000);
      // 1. Jobs list chips.
      await js(`document.querySelector('.tab[data-tab="jobs"]').click(); 0`);
      await until(`document.querySelectorAll('#jobList li').length === 2`);
      const chips = await js(`[...document.querySelectorAll('#jobList li')].map((li) => [li.querySelector('.job-title').textContent, [...li.querySelectorAll('.chip')].map((c) => c.textContent)])`);
      const nwChips = chips.find((c) => c[0].includes('Northwind'))[1];
      const scamChips = chips.find((c) => c[0].includes('Quick Cash'))[1];
      check('jobs list shows the fit score and "May rule you out"', nwChips.some((c) => /^Fit \d+$/.test(c)) && nwChips.includes('May rule you out'), JSON.stringify(chips));
      check('a scam-like posting gets a warning chip', scamChips.includes('Scam warning'));
      check('a short but ordinary posting gets no scam chip', !nwChips.includes('Scam warning'));

      // 2. The job check in the editor.
      await openJob('Northwind');
      const card = await js(`document.querySelector('#jobCheck').hidden ? '' : document.querySelector('#jobCheck').textContent`);
      check('job check shows the score, its parts and why', /\d+\/100/.test(card) && /Title\s*30\/30/.test(card) && /title fits data/.test(card) && /near home/.test(card), card.slice(0, 300));
      check('skill gaps listed with the honest-answer note', /aren't in your résumé/.test(card) && /snowflake/i.test(card) && /tableau/i.test(card) && /Never add them/.test(card));
      check('eligibility: the citizenship sentence may rule this temporary resident out', /Eligibility: May rule you out/.test(card) && /Canadian citizenship required and you are a temporary resident/.test(card) && /Must be a Canadian citizen\./.test(card));
      fs.writeFileSync(path.join(out, 'check.png'), (await win.webContents.capturePage()).toPNG());
      await js(`document.querySelector('#jobDescription').value += ' Send your bank details and pay a $40 equipment fee to start.'; document.querySelector('#jobDescription').dispatchEvent(new Event('input')); 0`);
      await wait(1000); // the check waits for typing to pause (400 ms)
      await until(`/Possible scam warning signs/.test(document.querySelector('#jobCheck').textContent)`, 5000);
      const edited = await js(`document.querySelector('#jobCheck').textContent`);
      check('the check updates as you edit the description', /asks you to pay/.test(edited) && /bank or ID details/.test(edited), edited.slice(-300));
      await js(`document.querySelector('#cancelJob').click(); 0`);

      // 3. Fill from link (Greenhouse).
      await js(`document.querySelector('#newJob').click(); 0`);
      await until(`!document.querySelector('#jobForm').hidden`);
      await js(`document.querySelector('#jobUrl').value = 'https://job-boards.greenhouse.io/stripe/jobs/8194287'; document.querySelector('#fillFromLink').click(); 0`);
      await until(`/Read the Greenhouse posting/.test(document.querySelector('#banner').textContent)`, 15000);
      const filled = await js(`({ company: document.querySelector('#jobCompany').value, role: document.querySelector('#jobRole').value, desc: document.querySelector('#jobDescription').value, url: document.querySelector('#jobUrl').value })`);
      check('Fill from link reads company, role and description', filled.company === 'Stripe' && filled.role === 'Data Analyst, Intern' && /^Location: Toronto/.test(filled.desc) && filled.desc.length > 500, JSON.stringify({ ...filled, desc: filled.desc.slice(0, 80) }));
      check('only allowed job-site addresses were contacted', fetched.length > 0 && allowedOnly(), JSON.stringify(fetched));
      check('the job check appears for the filled posting', !(await js(`document.querySelector('#jobCheck').hidden`)) && /\/100/.test(await js(`document.querySelector('#jobCheck').textContent`)));
      await js(`document.querySelector('#jobForm').requestSubmit(); 0`);
      await until(`!document.querySelector('#jobList').hidden`);
      check('the job is saved with its posting link', readJobs().some((j) => j.company === 'Stripe' && j.url === 'https://job-boards.greenhouse.io/stripe/jobs/8194287'));

      // 4. Unsupported site and a redirect to another address.
      const before = fetched.length;
      const other = await js(`window.api.readPosting('https://example.com/careers/123')`);
      check('another site is explained and never contacted', other.code === 'unsupported' && /browser extension/.test(other.error) && fetched.length === before);
      const bounce = await js(`window.api.readPosting('https://jobs.lever.co/bouncy/0d1e2f3a-1111-2222-3333-444455556666')`);
      check('a redirect to an unknown address is refused, not followed', bounce.code === 'blocked' && !fetched.some((u) => u.includes('evil.example.com')), JSON.stringify(bounce));
      const local = await js(`window.api.readPosting('https://127.0.0.1/jobs/1')`);
      check('local addresses are refused', !!local.error && !fetched.some((u) => u === 'https://127.0.0.1/jobs/1'));

      // 5. Profile → Your job search.
      await js(`document.querySelector('.tab[data-tab="profile"]').click(); 0`);
      await until(`document.querySelector('#searchCountry').value === 'Canada'`);
      const form = await js(`({ region: document.querySelector('#searchRegion').value, places: document.querySelector('#searchPlaces').value, tracks: document.querySelector('#searchTracks').value, details: document.querySelector('#sitDetails').value })`);
      check('Your job search shows the saved settings', form.region === 'NS' && form.places === 'halifax, dartmouth, bedford' && form.tracks.split('\n').length === 3 && /^data analyst, business analyst/.test(form.tracks) && form.details === 'PGWP until 2027-05-01', JSON.stringify(form));
      await js(`document.querySelector('#searchTracks').value = 'registered nurse, rn'; document.querySelector('#sitDetails').value = 'Canadian citizen'; document.querySelector('#saveSearch').click(); 0`);
      await until(`window.api.getConfig().then((c) => c.workSituation?.workAuthDetails === 'Canadian citizen')`);
      const cfg = await js(`window.api.getConfig()`);
      check('saving keeps the track name and priority, replaces titles', JSON.stringify(Object.keys(cfg.jobSearch.tracks)) === '["data"]' && cfg.jobSearch.tracks.data.priority === 1 && cfg.jobSearch.tracks.data.titles.join('|') === 'registered nurse|rn' && cfg.jobSearch.province === 'NS');
      await openJob('Northwind');
      const after = await js(`document.querySelector('#jobCheck').textContent`);
      check('the check follows the new settings (title no longer fits, citizen now eligible)', /Title\s*0\/30/.test(after) && !/May rule you out/.test(after), after.slice(0, 200));
      await js(`document.querySelector('#cancelJob').click(); 0`);

      // 6. Fact check under live answers.
      await js(`document.querySelector('.tab[data-tab="live"]').click(); 0`);
      await js(`document.querySelector('#askInput').value = 'Tell me about the grounded Kafka work'; document.querySelector('#answerBtn').click(); 0`);
      await until(`document.querySelectorAll('#answers .card .rewrite-actions').length === 1`);
      await wait(400);
      check('a grounded answer gets no fact-check note', !(await js(`!!document.querySelector('#answers .card .fact-note')`)));
      await js(`document.querySelector('#askInput').value = 'Tell me about the invented Kafka work'; document.querySelector('#answerBtn').click(); 0`);
      await until(`!!document.querySelector('#answers .card .fact-note')`);
      const note = await js(`document.querySelector('#answers .card .fact-note').textContent`);
      check('an answer with an invented number and tool is flagged', /Not in your résumé or facts:.*35%.*Kubernetes|Kubernetes.*35%/.test(note), note);
      fs.writeFileSync(path.join(out, 'factcheck.png'), (await win.webContents.capturePage()).toPNG());

      // 7. Fact check on a tailored résumé.
      await openJob('Northwind');
      await js(`document.querySelector('#careerTools [data-tool="resume"]').click(); 0`);
      await until(`!!document.querySelector('#careerOutput .fact-note')`, 15000);
      const docNote = await js(`document.querySelector('#careerOutput .fact-note').textContent`);
      check('a tailored résumé lists details not in your résumé and placeholders', /Terraform/.test(docNote) && /40/.test(docNote) && /1 placeholder to fill in/.test(docNote), docNote);
    } catch (err) {
      logs.push('[e2e-error] ' + err.stack);
    }
    fs.writeFileSync(path.join(out, 'log.txt'), logs.join(String.fromCharCode(10)));
    server.close();
    app.exit(0);
  });
});
