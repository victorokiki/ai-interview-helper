// End-to-end test of job discovery (step 3 of the Autonomous Job Kit plan):
// Find jobs now through the real main process and renderer, answered from
// saved source responses (tests/fixtures/jobkit/discover) by replacing Node's
// fetch, the only network path src/discover.js uses. Checks the matches list,
// that only allowed addresses are contacted, Add to Jobs, Dismiss, "new since
// last time", following an employer, the daily switch, and the message when
// no target roles are set.
const electron = require('electron');
const { app } = electron;
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, 'out', 'discover');
fs.rmSync(out, { recursive: true, force: true });
const userData = path.join(out, 'userdata');
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);

const DIR = path.join(__dirname, '..', 'fixtures', 'jobkit', 'discover');
const ROUTES = require(path.join(DIR, 'routes.json'));
const INPUTS = require(path.join(DIR, 'inputs.json'));
const D = require('../../packages/core/discover');

const fetched = [];
global.fetch = async (url, init = {}) => {
  const u = String(url);
  fetched.push(u);
  let r = ROUTES[u];
  if (r && r.post) r = init.method === 'POST' ? { file: r.post[JSON.parse(init.body).searchText] } : null;
  if (!r || (!r.file && !r.status)) return new Response('Not Found', { status: 404 });
  if (r.status) return new Response('error', { status: r.status });
  return new Response(fs.readFileSync(path.join(DIR, 'responses', r.file)), { status: 200, headers: { 'content-type': /\.html$/.test(r.file) ? 'text/html' : 'application/json' } });
};

const search = require('../../packages/core/jobkit').cleanSearch(INPUTS.searches.ca);
fs.writeFileSync(
  path.join(userData, 'config.json'),
  JSON.stringify({ provider: 'ollama', ollamaUrl: 'http://127.0.0.1:9', transcription: 'local', jobsMigrated: true, liveNoticeAck: true, meetingDetection: false, resume: INPUTS.master, jobSearch: search }),
);
fs.writeFileSync(path.join(userData, 'jobs.json'), '[]');
require(path.join(__dirname, '..', '..', 'src', 'main.js'));

const logs = [];
const check = (name, ok, extra = '') => {
  logs.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  fs.writeFileSync(path.join(out, 'log.txt'), logs.join(String.fromCharCode(10)));
};
const readJobs = () => JSON.parse(fs.readFileSync(path.join(userData, 'jobs.json'), 'utf8'));

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
        await wait(100);
      }
      return false;
    };
    try {
      await wait(1000);
      await js(`document.querySelector('.tab[data-tab="jobs"]').click(); 0`);
      await until(`/not searched yet/.test(document.querySelector('#matchesSummary').textContent)`);
      check('before the first search the panel says so', true);

      // 1. Find jobs now.
      await js(`document.querySelector('#discoverRun').click(); 0`);
      await until(`!document.querySelector('#discoverRun').disabled && document.querySelectorAll('#matchList li').length > 1`, 120000);
      const items = await js(`[...document.querySelectorAll('#matchList li')].map((li) => li.textContent.replace(/\\s+/g, ' ').trim())`);
      const matches = items.filter((t) => /Fit \d+/.test(t));
      check('matches are listed with their fit score, newest marked New', matches.length >= 5 && matches.every((t) => /^New /.test(t)), `${matches.length} matches; ${matches[0]?.slice(0, 120)}`);
      const scores = matches.map((t) => Number(/Fit (\d+)/.exec(t)[1]));
      check('best matches first', scores.every((s, i) => i === 0 || scores[i - 1] >= s), JSON.stringify(scores));
      check('every address contacted is on the discovery allowlist', fetched.length > 10 && fetched.every((u) => D.isAllowedDiscoveryUrl(u)), `${fetched.length} requests`);
      check('the "very short description" warning is not shown on matches', !items.some((t) => /very short, vague description/.test(t)));
      check('sources that failed are reported, the rest still searched', items.some((t) => /Some sources didn't answer:.*(jobbank|lever)/.test(t)));
      check('Remotive is credited when its jobs are listed', !(await js(`document.querySelector('#remotiveCredit').hidden`)) === items.some((t) => /remotive/.test(t)));
      const banner = await js(`document.querySelector('#banner').textContent`);
      check('a banner says how many are new', /\d+ new job match/.test(banner), banner);
      fs.writeFileSync(path.join(out, 'matches.png'), (await win.webContents.capturePage()).toPNG());

      // 2. Add the best one to Jobs; dismiss the next.
      const firstTitle = matches[0].replace(/^New /, '').split(' Fit ')[0];
      await js(`document.querySelector('#matchList li [data-act="add"]').click(); 0`);
      await until(`/Added .* to Jobs/.test(document.querySelector('#banner').textContent)`);
      const job = readJobs()[0];
      check('Add to Jobs creates a saved job with the link and description', readJobs().length === 1 && job.stage === 'saved' && /^https:\/\//.test(job.url) && /Found by job discovery/.test(job.jobDescription) && firstTitle.includes(job.role), JSON.stringify({ role: job?.role, company: job?.company, url: job?.url }));
      await until(`document.querySelectorAll('#matchList li [data-act="add"]').length === ${matches.length - 1}`);
      check('the added job leaves the matches list', true);
      await js(`document.querySelector('#matchList li [data-act="dismiss"]').click(); 0`);
      await until(`document.querySelectorAll('#matchList li [data-act="add"]').length === ${matches.length - 2}`);
      check('Dismiss removes a match and it stays dismissed', (await js(`window.api.discoverStatus()`)).matches.length === matches.length - 2);

      // 3. Searching again: nothing new.
      fetched.length = 0;
      const again = await js(`window.api.discoverRun()`);
      check('a second search finds nothing new (seen before)', again.newCount === 0 && again.matches.length === matches.length - 2 && again.matches.every((m) => !m.fresh), `new ${again.newCount}`);
      check('jobs already in Jobs are not offered again', !again.matches.some((m) => m.url === job.url));

      // 4. Follow an employer; daily switch.
      await js(`document.querySelector('#employerUrl').value = 'https://job-boards.greenhouse.io/stripe/jobs/8194287'; document.querySelector('#employerAdd').click(); 0`);
      await until(`/Following stripe/.test(document.querySelector('#banner').textContent)`);
      const cfg = await js(`window.api.getConfig()`);
      check('following an employer adds its board to the search', cfg.jobSearch.employers.greenhouse.includes('stripe') && cfg.jobSearch.employers.greenhouse.includes('northwind'));
      await js(`document.querySelector('#employerUrl').value = 'https://example.com/careers'; document.querySelector('#employerAdd').click(); 0`);
      await until(`/Paste a link to a Greenhouse/.test(document.querySelector('#banner').textContent)`);
      check('another link is explained', true);
      await js(`document.querySelector('#discoverDaily').click(); 0`);
      await until(`window.api.getConfig().then((c) => c.discoverDaily === true)`);
      check('the daily search can be turned on', true);

      // 5. Without target roles there's nothing to match against.
      await js(`window.api.saveConfig({ jobSearch: null })`);
      const none = await js(`window.api.discoverRun()`);
      check('without target roles the search explains what to set', /Add your target roles/.test(none.error || ''));
    } catch (err) {
      logs.push('[e2e-error] ' + err.stack);
    }
    fs.writeFileSync(path.join(out, 'log.txt'), logs.join(String.fromCharCode(10)));
    app.exit(0);
  });
});
