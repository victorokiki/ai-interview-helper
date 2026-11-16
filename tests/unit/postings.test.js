// Job-posting reader (packages/core/postings.js), ported from the Autonomous
// Job Kit's lib/jobkit/postings.py: every supported application system read
// from a trimmed real posting (tests/fixtures/jobkit/postings, the kit's own
// fixtures), link detection, the job-site address allowlist, error codes, and
// the pure text helpers. Ports the relevant cases of the kit's
// tests/test_postings.py.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../../packages/core/postings');

const FIX = path.join(__dirname, '..', 'fixtures', 'jobkit', 'postings');
const fixture = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const FAST = { delayMs: 0, retryDelayMs: 0 };

// Answers requests from fixtures by URL pattern, like the kit's FakeFetcher. Every request the module makes
// (and every address it ends up on) must be on the allowlist.
function fakeFetcher(routes, { redirects = {}, statuses = {}, org = 'Ramp' } = {}) {
  const seen = [];
  const fetcher = async (url, opts = {}) => {
    assert.ok(P.isAllowedUrl(url), `requested an address outside the allowlist: ${url}`);
    assert.equal(typeof opts.headers, 'object');
    seen.push({ url, method: opts.method || 'GET', body: opts.body });
    if (opts.body && opts.body.includes('ApiOrganization')) {
      return { status: 200, url, headers: {}, text: JSON.stringify({ data: { organization: { name: org } } }) };
    }
    for (const [pat, status] of Object.entries(statuses)) {
      if (new RegExp(pat).test(url)) {
        const s = Array.isArray(status) ? status.shift() : status;
        if (s !== undefined && s !== 200) return { status: s, url, headers: {}, text: '' };
      }
    }
    for (const [pat, loc] of Object.entries(redirects)) {
      if (new RegExp(pat).test(url)) {
        assert.ok(P.isAllowedUrl(loc), `redirected outside the allowlist: ${loc}`);
        return { status: 200, url: loc, headers: { 'Content-Type': 'text/html' }, text: '<html></html>' };
      }
    }
    for (const [pat, name] of Object.entries(routes)) {
      if (new RegExp(pat).test(url)) return { status: 200, url, headers: {}, text: fixture(name) };
    }
    return { status: 404, url, headers: {}, text: 'not found' };
  };
  fetcher.seen = seen;
  return fetcher;
}

async function rejects(promise, code) {
  try {
    await promise;
  } catch (e) {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    assert.ok(e.message && e.message.length > 20, 'a friendly message');
    return e;
  }
  assert.fail(`expected a ${code} error`);
}

// ---------- links ----------

test('detect: the link shapes of every supported system', () => {
  const cases = {
    'https://job-boards.greenhouse.io/stripe/jobs/8194287': ['greenhouse', { board: 'stripe', id: '8194287' }],
    'https://boards.greenhouse.io/embed/job_app?for=acme&token=123456': ['greenhouse', { board: 'acme', id: '123456' }],
    'https://stripe.com/jobs/search?gh_jid=8194287': ['greenhouse', { board: null, id: '8194287' }],
    'https://jobs.lever.co/palantir/6ed76ce8-4156-4b60-b120-403538bd66cd/apply':
      ['lever', { company: 'palantir', id: '6ed76ce8-4156-4b60-b120-403538bd66cd' }],
    'https://jobs.ashbyhq.com/ramp/acf6b28d-767f-483f-8ff2-114620cd7e04':
      ['ashby', { org: 'ramp', id: 'acf6b28d-767f-483f-8ff2-114620cd7e04' }],
    'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/Switzerland-Zurich/GPU-Compiler-Intern_JR2029779':
      ['workday', { tenant: 'nvidia', site: 'NVIDIAExternalCareerSite', slug: 'GPU-Compiler-Intern_JR2029779' }],
    'https://wd3.myworkdaysite.com/en-US/recruiting/acme/External/job/Toronto/Analyst_R-1234':
      ['workday', { tenant: 'acme', site: 'External', slug: 'Analyst_R-1234' }],
    'https://jobs.smartrecruiters.com/ServiceNow/744000161596339-senior-software-engineer':
      ['smartrecruiters', { company: 'ServiceNow', id: '744000161596339' }],
    'https://careers-gdms.icims.com/jobs/75487/intern-engineer/job': ['icims', {}],
    'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210690282':
      ['oracle', { site: 'CX_1001', id: '210690282' }],
    'https://ats.rippling.com/rippling/jobs/ef0b7266-678c-4a23-a439-1a5e7362b604':
      ['rippling', { board: 'rippling', id: 'ef0b7266-678c-4a23-a439-1a5e7362b604' }],
    'https://www.jobbank.gc.ca/jobsearch/jobposting/50723978': ['jobbank', { id: '50723978' }],
  };
  for (const [url, [system, want]] of Object.entries(cases)) {
    const d = P.detect(url);
    assert.ok(d, url);
    assert.equal(d.system, system, url);
    for (const [k, v] of Object.entries(want)) assert.equal(d[k], v, `${url}: ${k}`);
  }
  // LinkedIn and other sites are not supported systems
  assert.equal(P.detect('https://www.linkedin.com/jobs/view/4000000000'), null);
  assert.equal(P.systemOf('https://www.linkedin.com/jobs/view/4000000000'), 'linkedin');
  assert.equal(P.detect('https://careers.example.com/job/42'), null);
  assert.equal(P.systemOf('https://careers.example.com/job/42'), 'other');
  assert.equal(P.detect(''), null);
  assert.equal(P.detect(null), null);
  assert.deepEqual([...P.SYSTEMS].sort(), ['ashby', 'greenhouse', 'icims', 'jobbank', 'lever', 'oracle', 'rippling', 'smartrecruiters', 'workday']);
});

test('isAllowedUrl: only https job-site addresses the module needs', () => {
  const yes = [
    'https://boards-api.greenhouse.io/v1/boards/stripe/jobs/1?questions=true',
    'https://boards-api.eu.greenhouse.io/v1/boards/x/jobs/1',
    'https://boards.greenhouse.io/embed/job_app?token=1',
    'https://job-boards.greenhouse.io/embed/job_app?for=stripe&token=1',
    'https://api.lever.co/v0/postings/x/y', 'https://api.eu.lever.co/v0/postings/x/y', 'https://jobs.lever.co/x/y/apply',
    'https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting',
    'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/Site/job/x', 'https://wd3.myworkdaysite.com/wday/cxs/acme/External/job/x',
    'https://api.smartrecruiters.com/v1/companies/x/postings/1',
    'https://careers-gdms.icims.com/jobs/75487/intern-engineer/job?in_iframe=1',
    'https://jpmc.fa.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails',
    'https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/1/job/2',
    'https://api.rippling.com/platform/api/ats/v1/board/x/jobs/y', 'https://ats.rippling.com/x/jobs/y',
    'https://www.jobbank.gc.ca/jobsearch/jobposting/1',
    'https://JOBS.LEVER.CO:443/x',
  ];
  for (const u of yes) assert.equal(P.isAllowedUrl(u), true, u);
  const no = [
    'http://boards-api.greenhouse.io/v1/boards/stripe/jobs/1', // not https
    'https://127.0.0.1/jobs/1', 'https://127.0.0.1:9/jobs/1', 'http://127.0.0.1:9/jobs/1', 'https://[::1]/x',
    'https://93.184.216.34/x', 'https://0x7f000001/x', 'https://localhost/x',
    'https://example.com/jobs/1', 'https://stripe.com/jobs/search?gh_jid=8194287',
    'https://greenhouse.io.evil.com/v1/boards/x', 'https://boards-api.greenhouse.io.evil.com/x', 'https://evilgreenhouse.io/x',
    'https://api.lever.co.evil.com/x', 'https://evil.com/?u=https://api.lever.co', 'https://evil.com\\@api.lever.co/x',
    'https://user:pw@api.lever.co/x', 'https://api.lever.co:8443/x', 'https://api.lever.co./x',
    'https://myworkdayjobs.com/x', 'https://evil-myworkdayjobs.com/x', 'https://icims.com.evil.org/x',
    'https://objectstorage.us-ashburn-1.oraclecloud.com/n/x/b/y/o/z', 'https://oraclecloud.com/x',
    'https://www.rippling.com/careers', 'https://jobbank.gc.ca/x', 'https://www.linkedin.com/jobs/view/1',
    'ftp://api.lever.co/x', 'javascript:alert(1)', 'not a url', '', null,
  ];
  for (const u of no) assert.equal(P.isAllowedUrl(u), false, String(u));
  assert.ok(Object.isFrozen(P.ALLOWED_HOSTS));
  assert.ok(P.ALLOWED_HOSTS.includes('*.myworkdayjobs.com'));
  assert.ok(P.ALLOWED_HOSTS.includes('boards-api.greenhouse.io'));
});

// ---------- each application system (offline fixtures) ----------

test('Greenhouse: posting, questions and cover letter from the board API', async () => {
  const f = fakeFetcher({ 'boards-api\\.greenhouse\\.io/v1/boards/stripe/jobs/8194287': 'greenhouse_job.json' });
  const p = await P.fetchPosting('https://job-boards.greenhouse.io/stripe/jobs/8194287', f, FAST);
  assert.equal(f.seen[0].url, 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs/8194287?questions=true&pay_transparency=true');
  assert.deepEqual([p.company, p.role, p.location], ['Stripe', 'Data Analyst, Intern', 'Toronto']);
  assert.equal(p.system, 'greenhouse');
  assert.equal(p.posted, '2026-10-01');
  assert.equal(p.formPublished, true);
  assert.equal(p.checkCompany, false);
  const labels = p.questions.map((q) => q.label);
  assert.ok(labels.includes('Resume/CV'));
  const sponsor = p.questions.find((q) => q.label.includes('sponsorship'));
  assert.equal(sponsor.type, 'yes/no');
  assert.equal(p.coverLetter, 'none');
  assert.deepEqual(P.coverLetter(p), { status: 'none', quote: '' });
  const written = P.writtenQuestions(p.questions);
  assert.ok(written.some((w) => w.includes('data-related project')));
  assert.ok(!written.some((w) => w.toLowerCase().includes('employer')));
  assert.ok(!p.description.slice(0, 200).includes('<'));
  // the job-posting.md question lines
  assert.ok(p.questions.map((q) => P.questionLine(q)).includes('- [required] Resume/CV (file)'));
  assert.ok(p.questions.map((q) => P.questionLine(q)).some((l) =>
    /^- \[required\] Are you currently eligible to work in Canada\? \(yes\/no; options: Yes, I am .+ \| No, .+\)$/.test(l)));
});

test('Greenhouse company page with ?gh_jid=: the board comes from the Greenhouse embed redirect', async () => {
  const f = fakeFetcher({ 'boards-api\\.greenhouse\\.io/v1/boards/stripe/jobs/8194287': 'greenhouse_job.json' },
    { redirects: { 'embed/job_app\\?token=8194287': 'https://job-boards.greenhouse.io/embed/job_app?for=stripe&token=8194287' } });
  const p = await P.fetchPosting('https://stripe.com/jobs/search?gh_jid=8194287', f, FAST);
  assert.equal(p.company, 'Stripe');
  assert.equal(p.system, 'greenhouse');
  assert.equal(p.url, 'https://stripe.com/jobs/search?gh_jid=8194287');
  assert.ok(!f.seen.some((r) => r.url.includes('stripe.com')), 'the company page itself is never requested');
});

test('Greenhouse company page whose board cannot be learned from Greenhouse: unsupported, company page not fetched', async () => {
  const f = fakeFetcher({});
  const e = await rejects(P.fetchPosting('https://careers.acme.example/jobs?gh_jid=555', f, FAST), 'unsupported');
  assert.match(e.message, /Greenhouse link|browser extension/);
  assert.deepEqual(f.seen.map((r) => r.url), ['https://boards.greenhouse.io/embed/job_app?token=555']);
});

test('Greenhouse embed redirect that leaves the allowlist still yields the board (address read, not fetched)', async () => {
  const routes = { 'boards-api\\.greenhouse\\.io/v1/boards/stripe/jobs/8194287': 'greenhouse_job.json' };
  const inner = fakeFetcher(routes);
  const f = async (url, opts) => {
    if (url.includes('embed/job_app')) {
      const err = new Error('redirect refused');
      err.code = 'blocked';
      err.url = 'https://stripe.com/jobs/search?gh_jid=8194287&for=stripe';
      throw err;
    }
    return inner(url, opts);
  };
  const p = await P.fetchPosting('https://stripe.com/jobs/search?gh_jid=8194287', f, FAST);
  assert.equal(p.company, 'Stripe');
});

test('Lever: posting API plus the /apply form', async () => {
  const f = fakeFetcher({ 'api\\.lever\\.co/v0/postings/palantir/': 'lever_posting.json', 'jobs\\.lever\\.co/palantir/.*/apply': 'lever_apply.html' });
  const p = await P.fetchPosting('https://jobs.lever.co/palantir/6ed76ce8-4156-4b60-b120-403538bd66cd', f, FAST);
  assert.equal(p.company, 'Palantir Technologies');
  assert.equal(p.checkCompany, false);
  assert.equal(p.role, 'Administrative Business Partner');
  assert.ok(p.location.includes('hybrid'));
  assert.ok(p.posted.startsWith('2026-'));
  const req = Object.fromEntries(p.questions.map((q) => [q.label, q.required]));
  assert.equal(req['Resume/CV'], true);
  assert.equal(req.Phone, false);
  assert.ok(P.writtenQuestions(p.questions).includes('Why do you want to work at Palantir?'));
  assert.equal(p.coverLetter, 'optional');
  assert.ok(p.coverLetterQuote.includes('cover letter'));
});

test('Ashby: GraphQL posting and organization name', async () => {
  const f = fakeFetcher({ 'non-user-graphql\\?op=ApiJobPosting': 'ashby_job.json' });
  const p = await P.fetchPosting('https://jobs.ashbyhq.com/ramp/acf6b28d-767f-483f-8ff2-114620cd7e04', f, FAST);
  assert.deepEqual([p.company, p.role], ['Ramp', 'Software Engineering Intern, Backend']);
  assert.equal(p.pay, '$12.5K per month');
  assert.ok(p.location.includes('on-site'));
  const types = Object.fromEntries(p.questions.map((q) => [q.label, q.type]));
  assert.equal(types.Resume, 'file');
  assert.equal(types['Requesting visa sponsorship?'], 'yes/no');
  assert.deepEqual(P.writtenQuestions(p.questions), ['Share something you’ve built that you’re proud of.']);
  assert.equal(p.coverLetter, 'none');
  assert.ok(f.seen.every((r) => r.method === 'POST'));
  const body = JSON.parse(f.seen[0].body);
  assert.equal(body.operationName, 'ApiJobPosting');
  assert.deepEqual(body.variables, { organizationHostedJobsPageName: 'ramp', jobPostingId: 'acf6b28d-767f-483f-8ff2-114620cd7e04' });
});

test('Workday: the cxs job API', async () => {
  const f = fakeFetcher({ '/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/GPU-Compiler-Intern_JR2029779': 'workday_job.json' });
  const p = await P.fetchPosting('https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/Switzerland-Zurich/' +
    'GPU-Compiler-Intern_JR2029779', f, FAST);
  assert.equal(f.seen[0].url, 'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/GPU-Compiler-Intern_JR2029779');
  assert.equal(p.company, 'NVIDIA Switzerland AG');
  assert.equal(p.role, 'GPU Compiler Intern');
  assert.equal(p.posted, '2026-11-11');
  assert.equal(p.coverLetter, 'none');
});

test('SmartRecruiters: the postings API', async () => {
  const f = fakeFetcher({ 'api\\.smartrecruiters\\.com/v1/companies/ServiceNow/postings/744000161596339': 'smartrecruiters_job.json' });
  const p = await P.fetchPosting('https://jobs.smartrecruiters.com/ServiceNow/744000161596339-senior-software-engineer', f, FAST);
  assert.equal(p.company, 'ServiceNow');
  assert.ok(p.location.includes('Santa Clara'));
  assert.ok(p.location.includes('hybrid'));
  assert.equal(p.coverLetter, 'unknown');
});

test('Oracle Recruiting Cloud: requisition details with the site number', async () => {
  const f = fakeFetcher({ recruitingCEJobRequisitionDetails: 'oracle_job.json' });
  const p = await P.fetchPosting('https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210690282', f, FAST);
  assert.equal(p.role, '2027 Markets Summer Analyst Program - Research');
  assert.ok(p.pay.includes('100,000'));
  assert.equal(p.checkCompany, true);
  assert.ok(f.seen[0].url.includes('siteNumber=CX_1001'));
  assert.ok(f.seen[0].url.includes('finder=ById;Id=%22210690282%22,siteNumber=CX_1001'));
});

test('Rippling: board API with the application questions', async () => {
  const f = fakeFetcher({ 'api\\.rippling\\.com/platform/api/ats/v1/board/rippling/jobs/': 'rippling_job.json' });
  const p = await P.fetchPosting('https://ats.rippling.com/rippling/jobs/ef0b7266-678c-4a23-a439-1a5e7362b604', f, FAST);
  assert.equal(p.company, 'Rippling');
  assert.equal(p.coverLetter, 'optional');
  const knock = p.questions.find((q) => q.label.toLowerCase().includes('sponsorship'));
  assert.equal(knock.required, true);
  assert.equal(knock.type, 'yes/no');
});

test('Job Bank: the posting page (schema.org microdata)', async () => {
  const f = fakeFetcher({ 'jobbank\\.gc\\.ca/jobsearch/jobposting/50723978': 'jobbank_direct.html' });
  const p = await P.fetchPosting('https://www.jobbank.gc.ca/jobsearch/jobposting/50723978', f, FAST);
  assert.equal(f.seen[0].url, 'https://www.jobbank.gc.ca/jobsearch/jobposting/50723978');
  assert.deepEqual([p.company, p.role], ['The Roaring Rolls', 'cook']);
  assert.equal(p.location, 'Canmore, AB (on-site)');
  assert.equal(p.posted, '2026-11-13');
  assert.ok(p.deadline.startsWith('2026-12-01'));
  assert.ok(p.pay.includes('37.35'));
  assert.ok(p.description.includes('NOC 2021: 63200'));
  assert.ok(p.description.includes('Prepare and cook complete meals'));
  assert.ok(!p.description.includes('<div'));
  assert.equal(p.coverLetter, 'unknown');
  // the pure parser gives the same posting
  assert.deepEqual(P.parseJobBank(fixture('jobbank_direct.html'), p.url), p);
});

test('iCIMS: JSON-LD from the in_iframe page', async () => {
  const f = fakeFetcher({ 'icims\\.com/jobs/75487/intern-engineer/job\\?in_iframe=1': 'icims_jsonld.html' });
  const p = await P.fetchPosting('https://careers-gdms.icims.com/jobs/75487/intern-engineer/job', f, FAST);
  assert.equal(f.seen[0].url, 'https://careers-gdms.icims.com/jobs/75487/intern-engineer/job?in_iframe=1');
  assert.equal(p.company, 'General Dynamics Mission Systems, Inc');
  assert.equal(p.role, 'Intern Engineer');
  assert.ok(p.location.includes('Pittsfield'));
  assert.equal(p.deadline, ''); // validThrough a year away is an automatic expiry, not a deadline
  assert.ok(!p.pay.includes('0.00'));
  // the pure parser (also for the browser extension) reads the same page
  assert.deepEqual(P.parseJsonLd(fixture('icims_jsonld.html'), p.url, 'icims'), p);
  assert.equal(P.parseJsonLd('<html>no data</html>', p.url), null);
});

// ---------- refusals and errors ----------

test('LinkedIn and other sites are never fetched', async () => {
  const f = fakeFetcher({});
  let e = await rejects(P.fetchPosting('https://www.linkedin.com/jobs/view/4000000000', f, FAST), 'unsupported');
  assert.match(e.message.toLowerCase(), /paste/);
  e = await rejects(P.fetchPosting('https://careers.example.com/job/42', f, FAST), 'unsupported');
  assert.match(e.message, /browser extension/);
  await rejects(P.fetchPosting('http://127.0.0.1:9/jobs/1', f, FAST), 'unsupported');
  await rejects(P.fetchPosting('not-a-link', f, FAST), 'unsupported');
  assert.deepEqual(f.seen, []);
});

test('a closed posting gives not_found with a hint to open it in the browser', async () => {
  const f = fakeFetcher({});
  const e = await rejects(P.fetchPosting('https://jobs.lever.co/acme/00000000-0000-0000-0000-000000000000', f, FAST), 'not_found');
  assert.match(e.message, /browser/);
  assert.equal(e.status, 404);
  // api.lever.co, then the EU API, then the posting page itself (second chance: JSON-LD)
  assert.deepEqual(f.seen.map((r) => r.url), [
    'https://api.lever.co/v0/postings/acme/00000000-0000-0000-0000-000000000000',
    'https://api.eu.lever.co/v0/postings/acme/00000000-0000-0000-0000-000000000000',
    'https://jobs.lever.co/acme/00000000-0000-0000-0000-000000000000',
  ]);
});

test('server errors are retried once; a failing site is a network error; data that is not JSON is a parse error', async () => {
  const route = { 'api\\.smartrecruiters\\.com/v1/companies/ServiceNow/postings/744000161596339': 'smartrecruiters_job.json' };
  const url = 'https://jobs.smartrecruiters.com/ServiceNow/744000161596339-senior-software-engineer';
  let f = fakeFetcher(route, { statuses: { 'api\\.smartrecruiters': [503] } });
  assert.equal((await P.fetchPosting(url, f, FAST)).company, 'ServiceNow');
  assert.equal(f.seen.length, 2);
  f = fakeFetcher(route, { statuses: { 'api\\.smartrecruiters': [500, 500], 'jobs\\.smartrecruiters': [403] } });
  const e = await rejects(P.fetchPosting(url, f, FAST), 'network');
  assert.equal(e.status, 500);
  f = async () => ({ status: 200, url: 'https://api.smartrecruiters.com/x', headers: {}, text: '<html>' });
  await rejects(P.fetchPosting(url, f, FAST), 'parse');
});

test('no connection, refused requests and redirects off the allowlist', async () => {
  const url = 'https://jobs.smartrecruiters.com/ServiceNow/744000161596339-senior-software-engineer';
  let calls = 0;
  const offline = async () => {
    calls++;
    throw Object.assign(new Error('getaddrinfo ENOTFOUND api.smartrecruiters.com'), { code: 'ENOTFOUND' });
  };
  let e = await rejects(P.fetchPosting(url, offline, FAST), 'network');
  assert.match(e.message, /No connection/);
  assert.equal(calls, 1);
  const refused = async (u) => { throw Object.assign(new Error('refused'), { code: 'blocked', url: u }); };
  await rejects(P.fetchPosting(url, refused, FAST), 'blocked');
  const offsite = async () => ({ status: 200, url: 'https://evil.example/landing', headers: {}, text: '{}' });
  e = await rejects(P.fetchPosting(url, offsite, FAST), 'blocked');
  assert.match(e.message, /job sites the app contacts/);
  // an Oracle host outside the Recruiting Cloud addresses is never contacted
  const f = fakeFetcher({});
  await rejects(P.fetchPosting('https://objectstorage.oraclecloud.com/sites/CX/job/1', async (u) => f(u, {}), FAST), 'blocked');
  assert.deepEqual(f.seen, []);
});

test('an unexpected data shape is reported as a parse error', async () => {
  const f = async (url) => ({ status: 200, url, headers: {}, text: '[1, 2, 3]' });
  const e = await rejects(P.fetchPosting('https://ats.rippling.com/rippling/jobs/ef0b7266-678c-4a23-a439-1a5e7362b604', f, FAST), 'parse');
  assert.match(e.detail, /could not read this posting/);
});

test('fetchPosting waits between requests to the same host', async () => {
  const f = fakeFetcher({ 'non-user-graphql\\?op=ApiJobPosting': 'ashby_job.json' });
  const t0 = Date.now();
  await P.fetchPosting('https://jobs.ashbyhq.com/ramp/acf6b28d-767f-483f-8ff2-114620cd7e04', f, { delayMs: 120, retryDelayMs: 0 });
  assert.ok(Date.now() - t0 >= 100, 'two Ashby requests, one pause');
});

// ---------- cover letter, pay, text helpers ----------

const posting = (description, coverLetterField = null, formPublished = false, system = 'other') =>
  ({ description, coverLetterField, formPublished, system });

test('cover letter rules', () => {
  assert.equal(P.coverLetter(posting('Great team.', 'required', true)).status, 'required');
  assert.equal(P.coverLetter(posting('Great team.', 'optional', true)).status, 'optional');
  let r = P.coverLetter(posting('Please submit your resume and a cover letter explaining your interest.'));
  assert.equal(r.status, 'asked');
  assert.ok(r.quote.includes('cover letter'));
  r = P.coverLetter(posting('No cover letter needed. Just apply!', 'optional', true));
  assert.equal(r.status, 'not wanted');
  assert.equal(P.coverLetter(posting('Please do not send a cover letter.')).status, 'not wanted');
  assert.equal(P.coverLetter(posting('Great team.', null, true)).status, 'none');
  assert.equal(P.coverLetter(posting('Great team.', null, false, 'workday')).status, 'none');
  assert.equal(P.coverLetter(posting('Great team.')).status, 'unknown');
  // "U.S." does not end a sentence
  assert.deepEqual(P.splitSentences('Must be a U.S. citizen. Apply now!'), ['Must be a U.S. citizen.', 'Apply now!']);
});

test('pay from text', () => {
  assert.equal(P.payFromText('The base salary range is $120,000 - $150,000 USD per year.'), '$120,000 - $150,000 USD per year');
  assert.equal(P.payFromText('We process $275B in annualized spend.'), '');
  assert.equal(P.payFromText('Hourly rate: $25/hour'), '$25/hour');
  assert.equal(P.payFromText('USD $0.00 - USD $0.00 /Yr.'), '');
  assert.equal(P.payFromText('Salary: £30,000 - £35,000 per annum'), '£30,000 - £35,000 per annum');
});

test('dates and deadlines', () => {
  assert.equal(P.isoDate('Posted on November 13, 2026'), '2026-11-13');
  assert.equal(P.isoDate('2026-11-14T00:09:37.401Z'), '2026-11-14');
  assert.equal(P.isoDate(1786469891368), '2026-08-11');
  assert.equal(P.isoDate('13 Nov 2026'), '2026-11-13');
  assert.equal(P.isoDate('Feb 30, 2026'), '');
  assert.equal(P.isoDate(null), '');
  assert.ok(P.deadlineFromText('Applications close on January 15, 2027 at noon.').includes('January 15, 2027'));
  assert.equal(P.deadlineFromText('Apply by Friday.'), '');
});

test('fromText: a pasted description', () => {
  const p = P.fromText('Junior Data Analyst at Maple Leaf Analytics\nLocation: Halifax, NS\n\nYou will build ' +
    'dashboards. Please include a cover letter.', 'https://careers.example.com/jobs/77');
  assert.deepEqual([p.role, p.company, p.location], ['Junior Data Analyst', 'Maple Leaf Analytics', 'Halifax, NS']);
  assert.equal(p.system, 'other');
  assert.equal(p.coverLetter, 'asked');
  const q = P.fromText('Data Analyst\nWe are hiring.', 'https://jobs.lever.co/mapleco/' + '1'.repeat(8) + '-1111-1111-1111-' + '1'.repeat(12));
  assert.equal(q.company, 'Mapleco');
  assert.equal(q.checkCompany, true);
  assert.equal(q.system, 'lever');
  const h = P.fromText('<p>Title: Barista</p><p>Employer: Bean Co</p><ul><li>Salary: $17/hour</li></ul>', '', { role: 'Lead Barista' });
  assert.deepEqual([h.role, h.company, h.pay], ['Lead Barista', 'Bean Co', '$17/hour']);
  const agency = P.fromText('Analyst\nOur client, a leading bank, is hiring.', 'https://careers.example.com/1', { company: 'Acme' });
  assert.equal(agency.checkCompany, true, 'staffing-agency wording is flagged');
  assert.equal(P.companyFromUrl('https://careers.harbour.example/jobs/12'), 'Harbour');
});

test('cleanText and htmlToText', () => {
  // expected values are what the kit's Python gives for the same input
  assert.equal(P.cleanText('<ul><li>One</li><li>Two &amp; three</li></ul><p>•</p><p>Four</p>'), '- One\n- Two & three\n\n- Four');
  assert.equal(P.htmlToText('a<br>b&nbsp;&nbsp;c<script>x</script>'), 'a\nb c');
  // like Python's html.unescape: legacy names without ";" (also as a prefix), Windows-1252 numeric references
  assert.equal(P.unescapeHtml('&lt;b&gt; &ampx &#x27; &#150; &notit; &zzz;'), "<b> &x ' – ¬it; &zzz;");
});

test('the module is pure (no file, network or Electron access)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'packages', 'core', 'postings.js'), 'utf8');
  assert.ok(!/\brequire\s*\(/.test(src), 'no require()');
  assert.ok(!/\bfetch\s*\(/.test(src), 'no global fetch()');
  assert.ok(!/XMLHttpRequest|electron|child_process/.test(src));
});
