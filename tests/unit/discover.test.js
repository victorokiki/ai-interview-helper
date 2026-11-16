// Job discovery (packages/core/discover.js), a port of the Autonomous Job Kit's find_jobs.py, find_internships.py
// and job_digest.py. The parity tables compare it with what the Python gives for the same canned source responses
// (tests/fixtures/jobkit/discover: responses/ trimmed from real ones, routes.json, inputs.json, and expected.json
// written by gen_parity.py), then the behaviour the kit documents is checked case by case. Every request goes
// through a fake fetcher that fails the test if an address is outside isAllowedDiscoveryUrl().
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const D = require('../../packages/core/discover');
const P = require('../../packages/core/postings');

const DIR = path.join(__dirname, '..', 'fixtures', 'jobkit', 'discover');
const INPUTS = require(path.join(DIR, 'inputs.json'));
const EXPECTED = require(path.join(DIR, 'expected.json'));
const ROUTES = require(path.join(DIR, 'routes.json'));
const S = INPUTS.searches;
const TODAY = INPUTS.today;
const FAST = { delayMs: 0, hostDelayMs: {} };
const response = (file) => fs.readFileSync(path.join(DIR, 'responses', file), 'utf8');

// A fetcher answering from routes.json (anything else is HTTP 404); it fails the test on any address the main
// process would refuse, and keeps every request it saw.
function fakeFetcher(overrides = {}) {
  const seen = [];
  async function fetcher(url, init) {
    assert.ok(D.isAllowedDiscoveryUrl(url), `requested a refused address: ${url}`);
    assert.ok(init && init.headers && init.headers['User-Agent'], 'sends a User-Agent');
    seen.push({ url, init });
    if (overrides[url]) return overrides[url](url, init);
    let r = ROUTES[url];
    if (r && r.post) r = init.method === 'POST' ? { file: r.post[JSON.parse(init.body).searchText] } : null;
    if (!r || (!r.file && !r.status)) return { status: 404, url, headers: {}, text: 'Not Found' };
    if (r.status) return { status: r.status, url, headers: {}, text: 'error' };
    return { status: 200, url, headers: { 'content-type': 'application/json' }, text: response(r.file) };
  }
  fetcher.seen = seen;
  return fetcher;
}

const FIELDS = ['source', 'company', 'title', 'location', 'url', 'posted', 'description', 'kind', 'score', 'track', 'place', 'why',
  'gaps', 'flags', 'matchedSkills', 'yearsRequired', 'parts', 'queueable'];
const pick = (j) => Object.fromEntries(FIELDS.map((k) => [k, j[k]]));
const fakeRead = async (url) => INPUTS.enrich[url] || { error: 'not in the enrich table' };

async function pipeline(key) {
  const fetcher = fakeFetcher();
  const collected = await D.collect(S[key], { fetcher, sources: D.ALL_SOURCES, ...FAST });
  const opts = { today: TODAY, days: INPUTS.days, tracked: INPUTS.tracker, queued: INPUTS.queued, profile: INPUTS.profile };
  const ranked = D.rank(collected.jobs, INPUTS.master, S[key], opts);
  const enriched = await D.enrich(ranked.jobs, INPUTS.master, S[key], { ...opts, fetchPosting: fakeRead });
  return { fetcher, collected, ranked, enriched };
}

// ---------- parity with the kit ----------

for (const key of ['ca', 'us']) {
  test(`parity (${key}): collect() requests the same addresses and builds the same job records as find_jobs.collect()`, async () => {
    const { fetcher, collected } = await pipeline(key);
    const want = EXPECTED.collect[key];
    // the kit also tries a Workday host outside the allowlist; discover.js refuses it without a request
    assert.deepEqual(collected.requests.map((r) => r.url), want.requests.filter(D.isAllowedDiscoveryUrl));
    assert.deepEqual(fetcher.seen.map((r) => r.url), collected.requests.map((r) => r.url));
    assert.deepEqual(collected.jobs, want.jobs);
    assert.deepEqual(collected.counts, want.counts);
    assert.deepEqual(collected.errors.map((e) => e.source), Object.keys(want.errors));
    for (const e of collected.errors) if (e.source === 'greenhouse:ghost') assert.equal(e.message, want.errors[e.source]);
  });

  test(`parity (${key}): rank() + enrich() give the kit's filter counts, scores, flags and order`, async () => {
    const { ranked, enriched } = await pipeline(key);
    const want = EXPECTED.rank[key];
    assert.deepEqual(ranked.skipped, want.skipped);
    assert.equal(ranked.kept, want.kept);
    assert.equal(ranked.found, want.found);
    assert.equal(enriched.fetched, want.fetched);
    assert.deepEqual(enriched.jobs.map(pick), want.jobs);
    assert.deepEqual(D.pickForQueue(enriched.jobs, S[key], INPUTS.profile).map((j) => j.url), want.picked);
    assert.deepEqual(enriched.jobs.map(D.queueNote), want.notes);
  });
}

test('parity: the fixtures cover every source, filter reason and the enrich step', () => {
  const ca = EXPECTED.rank.ca;
  for (const [reason, n] of Object.entries(ca.skipped)) assert.ok(n > 0, reason);
  assert.equal(new Set(ca.jobs.map((j) => j.source)).size, 9);
  assert.ok(ca.fetched >= 2);
  assert.ok(ca.jobs.some((j) => !j.queueable), 'a co-op role the profile cannot queue');
  assert.equal(Object.keys(EXPECTED.collect.ca.errors).length, 4);
});

test('parity: newSince(), jobKey() and rememberSeen() match job_digest.py', async () => {
  const { enriched } = await pipeline('ca');
  const want = EXPECTED.digest;
  const seen = Object.fromEntries(INPUTS.seen.map((k) => [k, '2026-11-01']));
  const { fresh, keys, older } = D.newSince(enriched.jobs, seen);
  assert.deepEqual(enriched.jobs.map(D.jobKey), want.keys);
  assert.deepEqual(fresh.map((j) => j.url), want.fresh);
  assert.equal(older, want.older);
  assert.deepEqual(keys, [...new Set(want.keys)]);
  assert.deepEqual(D.newSince(enriched.jobs, new Set(INPUTS.seen)).fresh, fresh);
  assert.deepEqual(D.newSince(enriched.jobs, INPUTS.seen).fresh, fresh);
  assert.deepEqual(D.rememberSeen(seen, enriched.jobs, TODAY), want.seenAfter);
});

test('parity: digest() writes the kit\'s markdown digest', async () => {
  const { enriched } = await pipeline('ca');
  const want = EXPECTED.digest;
  const seen = Object.fromEntries(INPUTS.seen.map((k) => [k, '2026-11-01']));
  const { fresh, older } = D.newSince(enriched.jobs, seen);
  const queued = D.pickForQueue(fresh, S.ca, INPUTS.profile);
  assert.deepEqual(queued.map((j) => j.url), want.queued);
  const d = D.digest(fresh, { today: TODAY, older, found: want.found, counts: want.counts, errors: want.errors, queued,
    minScore: S.ca.min_score_to_queue, top: 15 });
  assert.equal(d.markdown, want.markdown);
  assert.equal(d.newCount, fresh.length);
  assert.ok(d.gaps.length && d.flagged.length);
});

test('parity: posting keys, clean links, role keys, day() and title case match jobkit and find_jobs', () => {
  const f = INPUTS.functions;
  const want = EXPECTED.functions;
  assert.deepEqual(f.postingKeys.map((u) => [...D.postingKeys(u)].sort(D._internals.cpCompare)), want.postingKeys);
  assert.deepEqual(f.postingKeys.map(D.cleanUrl), want.cleanUrl);
  assert.deepEqual(f.postingKeys.map((u) => D.jobKey({ url: u })), want.jobKey);
  assert.deepEqual(f.roles.map(([c, r]) => D.roleKey(c, r)), want.roleKey);
  assert.deepEqual(f.roles.map(([c]) => D.nameKey(c)), want.nameKey);
  assert.deepEqual(f.roles.map(([, r]) => D.norm(r)), want.norm);
  assert.deepEqual(f.day.map(D.day), want.day);
  assert.deepEqual(f.title.map(D._internals.pyTitle), want.title);
});

test('parity: parseEmployerUrl() reads board links as add_employer() does', () => {
  assert.deepEqual(INPUTS.employers.map(D.parseEmployerUrl), EXPECTED.employers);
});

test('parity: searchInternships() filters SimplifyJobs listings as find_internships.search() does', () => {
  const I = INPUTS.internships;
  const want = EXPECTED.internships;
  assert.equal(want.cases.length, I.cases.length);
  I.cases.forEach((c, i) => {
    const got = D.searchInternships(I.listings, c.filters, c.profile, { today: I.today, ...(c.context || {}) });
    assert.equal(want.cases[i].name, c.name);
    assert.deepEqual(got.results, want.cases[i].results, c.name);
    assert.deepEqual(got.skipped, want.cases[i].skipped, c.name);
    assert.equal(got.term, want.cases[i].term, c.name);
  });
  assert.deepEqual(I.usLocations.map(D.isUsLocation), want.usLocations);
  assert.deepEqual(I.degrees.map(D.degreeLevel), want.degrees);
  assert.deepEqual(I.locationMatches.map(([l, w]) => D.locationMatch(l, w)), want.locationMatches);
});

test('internships: the kit\'s documented cases (U.S. profile defaults, newest first, sponsorship)', () => {
  const I = INPUTS.internships;
  const r = D.searchInternships(I.listings, {}, { country: 'United States', needsSponsorship: 'no' }, { today: I.today });
  const companies = r.results.map((x) => x.company).sort();
  for (const c of ['Adatum', 'Contoso', 'Litware', 'Northwind Robotics', 'Proseware', 'Tailspin', 'Wingtip']) assert.ok(companies.includes(c), c);
  assert.equal(r.skipped.closed, 1);
  assert.equal(r.skipped.outside_us, 1);
  assert.equal(r.skipped.duplicate, 1);
  assert.equal(r.results.find((x) => x.company === 'Proseware').location, 'Chicago, IL');
  assert.deepEqual([r.results[0].company, r.results[0].posted, r.results[1].posted], ['Edge Case', '2026-11-14', '2026-11-13']);
  const sp = D.searchInternships(I.listings, {}, { country: 'United States', needsSponsorshipForInternship: 'yes' }, { today: I.today });
  assert.ok(!sp.results.some((x) => ['Litware', 'Adatum'].includes(x.company)));
});

// ---------- the allowlist ----------

test('allowlist: every address collect() may request passes, and the extra hosts are held to their paths', () => {
  for (const u of Object.keys(ROUTES)) assert.ok(D.isAllowedDiscoveryUrl(u), u);
  for (const u of Object.values(D.SIMPLIFY)) assert.ok(D.isAllowedDiscoveryUrl(u), u);
  for (const u of ['https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true', 'https://api.lever.co/v0/postings/acme?mode=json',
    'https://api.smartrecruiters.com/v1/companies/Acme/postings?country=gb&limit=100', 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/jobs',
    'https://www.jobbank.gc.ca/jobsearch/jobsearch?searchstring=x&sort=D', 'https://remotive.com/api/remote-jobs',
    'https://api.ashbyhq.com/posting-api/job-board/acme', 'https://jobs.ashbyhq.com/acme/1fc309c8-da20-4ff2-84c7-8b863ece2b0b']) {
    assert.ok(D.isAllowedDiscoveryUrl(u), u);
  }
  // postings.js's own list is included unchanged
  for (const h of P.ALLOWED_HOSTS) assert.ok(D.DISCOVERY_HOSTS.includes(h), h);
  assert.deepEqual(D.DISCOVERY_HOSTS.slice(P.ALLOWED_HOSTS.length), ['api.ashbyhq.com', 'remotive.com', 'raw.githubusercontent.com']);
});

test('allowlist negatives: other GitHub paths, http, other hosts, look-alikes, ports, credentials and tricks', () => {
  const bad = [
    'http://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json',
    'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/README.md',
    'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/main/.github/scripts/listings.json',
    'https://raw.githubusercontent.com/evil/Summer2027-Internships/dev/.github/scripts/listings.json',
    'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json?x=1',
    'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/../../../../evil/x/dev/.github/scripts/listings.json',
    'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts%2flistings.json',
    'https://raw.githubusercontent.com:8443/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json',
    'https://user:pw@raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json',
    'https://raw.githubusercontent.com.evil.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json',
    'https://evilraw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json',
    'https://github.com/SimplifyJobs/Summer2027-Internships', 'https://gist.githubusercontent.com/x/y/raw/listings.json',
    'http://remotive.com/api/remote-jobs?category=data', 'https://remotive.com/remote-jobs/data/x-1', 'https://remotive.com/api/remote-jobsx',
    'https://remotive.com/', 'https://www.remotive.com/api/remote-jobs', 'https://remotive.io/api/remote-jobs', 'https://remotive.com.evil.io/api/remote-jobs',
    'https://api.ashbyhq.com/', 'https://api.ashbyhq.com/posting-api/job-board/', 'https://api.ashbyhq.com/other/acme',
    'https://api.ashbyhq.com/posting-api/job-board/%2e%2e/admin', 'https://evilashbyhq.com/posting-api/job-board/acme',
    'http://boards-api.greenhouse.io/v1/boards/acme/jobs', 'https://boards-api.greenhouse.io.evil.com/v1/boards/acme/jobs',
    'https://jobs.example.com/wday/cxs/x/y/jobs', 'https://myworkdayjobs.com/wday/cxs/x/y/jobs', 'https://127.0.0.1/api/remote-jobs',
    'https://localhost/x', 'file:///etc/passwd', 'ftp://remotive.com/api/remote-jobs', 'javascript:alert(1)', 'not a url', '', null, undefined, 42,
  ];
  for (const u of bad) assert.equal(D.isAllowedDiscoveryUrl(u), false, String(u));
});

test('allowlist: collect() refuses a board host outside the list and a redirect off it, and keeps going', async () => {
  const search = { ...S.ca, jobbank_queries: [], employers: { workday: [{ host: 'jobs.example.com', tenant: 't', site: 's' }], greenhouse: ['northwind'] } };
  const fetcher = fakeFetcher({
    'https://boards-api.greenhouse.io/v1/boards/northwind/jobs?content=true': (url) =>
      ({ status: 200, url: 'https://attacker.example.net/jobs.json', headers: {}, text: '{"jobs": []}' }),
  });
  const r = await D.collect(search, { fetcher, sources: ['workday', 'greenhouse', 'remotive'], ...FAST });
  assert.deepEqual(r.errors.map((e) => e.source), ['workday:t', 'greenhouse:northwind']);
  assert.match(r.errors[0].message, /not one of the addresses/);
  assert.match(r.errors[1].message, /not one of the addresses/);
  assert.ok(!fetcher.seen.some((s) => s.url.includes('example.com')));
  assert.ok(r.counts.remotive > 0, 'the other sources still ran');
});

// ---------- sources, errors and politeness ----------

test('sources: Job Bank only for a Canadian search; ids and labels', () => {
  assert.deepEqual(D.ALL_SOURCES, ['simplify-intern', 'simplify-newgrad', 'jobbank', 'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday', 'remotive']);
  assert.ok(D.defaultSources(S.ca).includes('jobbank'));
  assert.ok(!D.defaultSources(S.us).includes('jobbank'));
  assert.ok(!D.defaultSources(S.gb).includes('jobbank'));
  assert.ok(D.defaultSources({}).includes('jobbank'), 'no country is Canada, as in the kit');
  for (const s of D.SOURCES) assert.ok(s.id && s.label);
});

test('errors: one failing source never stops the others (network error, HTTP error, bad JSON, bad entry)', async () => {
  const fetcher = fakeFetcher({
    'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json': () => { throw new Error('socket hang up'); },
    'https://api.ashbyhq.com/posting-api/job-board/fabrikam?includeCompensation=false': () => ({ status: 503, headers: {}, text: '' }),
  });
  const search = { ...S.ca, employers: { ...S.ca.employers, workday: [{ host: 'tailspin.wd3.myworkdayjobs.com', tenant: 'tailspin' }] } };
  const r = await D.collect(search, { fetcher, ...FAST });
  const errs = Object.fromEntries(r.errors.map((e) => [e.source, e.message]));
  assert.match(errs['simplify-newgrad'], /socket hang up/);
  assert.equal(errs['ashby:fabrikam'], 'HTTP 503');
  assert.equal(errs['greenhouse:ghost'], 'HTTP 404 (no such board: check the name in search.json)');
  assert.match(errs['lever:broken'], /did not return JSON/);
  assert.match(errs['jobbank:broken query'], /^HTTPError: HTTP Error 500/);
  assert.match(errs['workday:tailspin'], /needs "site"/);
  for (const ok of ['simplify-intern', 'jobbank', 'greenhouse:northwind', 'lever:contoso-labs', 'smartrecruiters:Litware', 'remotive']) {
    assert.ok(r.counts[ok] > 0, ok);
  }
});

test('errors: a Lever list without text content fails that board, as the kit\'s str.join does', async () => {
  const body = JSON.parse(response('lever-contoso-labs.json'));
  body[1].lists[0].content = null;
  const fetcher = fakeFetcher({ 'https://api.lever.co/v0/postings/contoso-labs?mode=json': (url) => ({ status: 200, url, text: JSON.stringify(body) }) });
  const r = await D.collect(S.ca, { fetcher, sources: ['lever'], ...FAST });
  assert.deepEqual(r.errors.map((e) => e.source), ['lever:contoso-labs', 'lever:broken']);
  assert.match(r.errors[0].message, /^TypeError: sequence item 0: expected str instance, NoneType found/);
});

test('politeness: one request a second per site, one every 5 seconds for Job Bank; delays are options', async () => {
  const waits = [];
  const sleep = (ms) => { waits.push(ms); return Promise.resolve(); };
  await D.collect(S.ca, { fetcher: fakeFetcher(), sources: ['jobbank'], sleep });
  assert.equal(waits.length, 2);
  for (const w of waits) assert.ok(w > 4800 && w <= 5000, String(w));
  waits.length = 0;
  await D.collect(S.ca, { fetcher: fakeFetcher(), sources: ['remotive'], sleep });
  assert.equal(waits.length, 1);
  assert.ok(waits[0] > 800 && waits[0] <= 1000);
  waits.length = 0;
  await D.collect(S.ca, { fetcher: fakeFetcher(), sources: ['jobbank', 'remotive'], sleep, ...FAST });
  assert.equal(waits.length, 0);
});

test('collect: maxPerSource caps each board; a missing fetcher is a TypeError', async () => {
  const r = await D.collect(S.ca, { fetcher: fakeFetcher(), sources: ['simplify-intern', 'greenhouse'], maxPerSource: 2, ...FAST });
  assert.deepEqual(r.counts, { 'simplify-intern': 2, 'greenhouse:northwind': 2 });
  assert.equal(r.jobs.length, 4);
  await assert.rejects(D.collect(S.ca, {}), TypeError);
});

test('fetchListings: the SimplifyJobs list as an array; anything else is an error', async () => {
  const list = await D.fetchListings({ fetcher: fakeFetcher(), ...FAST });
  assert.ok(Array.isArray(list) && list.length > 10);
  const notList = fakeFetcher({ [D.SIMPLIFY['simplify-newgrad']]: (url) => ({ status: 200, url, text: '{"a": 1}' }) });
  await assert.rejects(D.fetchListings({ fetcher: notList, source: 'simplify-newgrad', ...FAST }), /not a list/);
  await assert.rejects(D.fetchListings({ fetcher: notList, source: 'other' }), TypeError);
});

// ---------- parsing details ----------

test('parsing: Job Bank articles, Greenhouse escaped HTML, Lever title case, Ashby country and remote, Remotive filter', () => {
  const jb = D.parseJobBank(response('jobbank-data-analyst.html'));
  assert.deepEqual(jb[0], { source: 'jobbank', company: 'Harbour & Pine Analytics', title: 'data analyst', location: 'Toronto , ON, Canada',
    url: 'https://www.jobbank.gc.ca/jobsearch/jobposting/50674101', posted: '2026-11-13', description: 'Salary $32.00 to $41.00 hourly', kind: '' });
  assert.equal(jb[1].posted, '2026-11-02');
  const gh = D.parseGreenhouse('northwind', JSON.parse(response('greenhouse-northwind-jobs.json')), 'Northwind Traders');
  assert.equal(gh[0].title, 'Software Developer & Data Tools');
  assert.equal(gh[1].posted, '2026-11-15', 'updated_at when first_published is empty');
  const lv = D.parseLever('contoso-labs', JSON.parse(response('lever-contoso-labs.json')));
  assert.equal(lv[0].company, 'Contoso Labs');
  assert.equal(lv[0].location, 'Toronto, Ontario, remote');
  const ab = D.parseAshby('fabrikam', JSON.parse(response('ashby-fabrikam.json')));
  assert.equal(ab[0].location, 'Toronto, Canada');
  assert.equal(ab[1].location, 'Remote - Canada; Montreal, Quebec (Remote)');
  const us = D.parseRemotive(JSON.parse(response('remotive-data.json')), S.us);
  assert.deepEqual(us.map((j) => j.title), ['Data Engineer', 'Senior Data Scientist'], 'USA Only and Worldwide, not Canada');
  assert.deepEqual(D.parseRemotive(JSON.parse(response('remotive-software-dev.json')), S.gb).map((j) => j.location), ['Remote (Europe, open to the UK)']);
  assert.equal(D.parseSimplify('simplify-intern', [{ active: true, locations: ['Toronto, ON, Canada'] }, { locations: ['Toronto, ON'] }], S.ca).length, 1);
});

test('day(): epoch numbers give the local date, as date.fromtimestamp does', () => {
  const local = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  assert.equal(D.day(0), local(0));
  assert.equal(D.day(true), local(1000));
  assert.equal(D.day(1794843089000), local(1794843089000));
  assert.equal(D.day('  November 6, 2026 '), '2026-11-06');
});

// ---------- ranking options ----------

test('rank: scam warnings come from redflags.js by default; redFlags: null leaves them out; top slices', async () => {
  const { collected } = await pipeline('ca');
  const base = { today: TODAY, days: 45 };
  const withFlags = D.rank(collected.jobs, INPUTS.master, S.ca, base);
  assert.ok(withFlags.jobs.some((j) => j.flags.some((f) => f.startsWith('scam warning'))));
  const without = D.rank(collected.jobs, INPUTS.master, S.ca, { ...base, redFlags: null });
  assert.ok(!without.jobs.some((j) => j.flags.some((f) => f.startsWith('scam warning'))));
  assert.deepEqual(without.jobs.map((j) => j.score), withFlags.jobs.map((j) => j.score), 'flags never change the score');
  const top = D.rank(collected.jobs, INPUTS.master, S.ca, { ...base, top: 3 });
  assert.equal(top.jobs.length, 3);
  assert.equal(top.kept, withFlags.kept);
  assert.equal(D.rank(collected.jobs, INPUTS.master, S.ca, { ...base, days: 0 }).skipped.too_old, 0, 'days 0 means no age limit, as in the kit');
});

test('queueable: co-op roles are queued only for an enrolled student returning to school', async () => {
  const { enriched } = await pipeline('ca');
  const coop = enriched.jobs.find((j) => j.flags.some((f) => f.startsWith('co-op or student only')));
  assert.equal(D.queueable(coop, {}), false);
  assert.equal(D.queueable(coop, { enrolled: 'yes', returningToSchool: 'no' }), false);
  assert.equal(D.queueable(coop, { enrolled: 'yes', returningToSchool: 'yes' }), true);
  const picked = D.pickForQueue(enriched.jobs, S.ca, { enrolled: 'yes', returningToSchool: 'yes' });
  assert.ok(picked.includes(coop));
  assert.equal(D.pickForQueue(enriched.jobs, { max_queue_per_run: 2 }, {}, 0).length, 2);
});

test('enrich: by default only job-site links are read, through postings.js and the same fetcher', async () => {
  const fetcher = fakeFetcher();
  const job = { source: 'simplify-intern', company: 'Shopify', title: 'Software Engineer Intern', location: 'Toronto, ON, Canada',
    url: 'https://www.shopify.com/careers/x', posted: '', description: '', kind: 'internship' };
  const ranked = D.rank([job], INPUTS.master, S.ca, { today: TODAY }).jobs;
  const r = await D.enrich(ranked, INPUTS.master, S.ca, { today: TODAY, fetcher, postingOptions: { delayMs: 0, retryDelayMs: 0 } });
  assert.equal(r.fetched, 0);
  assert.equal(fetcher.seen.length, 0, 'shopify.com is not a job-site address: nothing was requested');
});

// ---------- employers and the digest ----------

test('addEmployer: adds a board once (Workday matched by host and site)', () => {
  const p = D.parseEmployerUrl('https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/X_JR1');
  const once = D.addEmployer({ employers: {} }, p);
  assert.equal(once.added, true);
  const twice = D.addEmployer(once.search, { system: 'workday', entry: { ...p.entry, queries: ['x'] } });
  assert.equal(twice.added, false);
  const gh = D.addEmployer(twice.search, D.parseEmployerUrl('https://boards.greenhouse.io/acme/jobs/1'));
  assert.deepEqual(gh.search.employers.greenhouse, ['acme']);
  assert.equal(D.addEmployer(gh.search, { system: 'greenhouse', entry: 'acme' }).added, false);
  assert.equal(D.parseEmployerUrl('https://www.linkedin.com/jobs/view/1'), null);
});

test('digest: nothing new says so; rememberSeen forgets keys first seen more than 120 days ago', () => {
  const d = D.digest([], { today: TODAY, older: 3, found: 10, counts: { a: 1 }, errors: [] });
  assert.match(d.markdown, /^# Job digest, Monday November 16, 2026\n/);
  assert.match(d.markdown, /Nothing new today\./);
  assert.ok(!d.markdown.includes('## Check before applying'));
  const kept = D.rememberSeen({ old: '2026-07-01', recent: '2026-10-01' }, [{ url: 'https://boards.greenhouse.io/a/jobs/1' }], TODAY);
  assert.deepEqual(kept, { recent: '2026-10-01', 'greenhouse:1': TODAY });
});
