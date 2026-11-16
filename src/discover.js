// Job discovery (main process): finds new postings from public sources
// (SimplifyJobs lists, Job Bank, employer boards on Greenhouse, Lever, Ashby,
// SmartRecruiters and Workday, Remotive), ranks them with the fit score and
// keeps what's new since the last run. Rules: packages/core/discover.js
// (ported from Autonomous Job Kit). Network goes only through a fetcher
// limited to CoreDiscover.isAllowedDiscoveryUrl. Results are stored in
// userData/matches.json; nothing about the user is sent anywhere (the
// requests carry only the search terms, country and board names).
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const Discover = require('../packages/core/discover');
const { createFetcher } = require('./postings');

const MAX_BYTES = 40 * 1024 * 1024; // SimplifyJobs lists are ~13 MB, big boards ~10 MB
const KEEP_MATCHES = 40;
const ENRICH_TOP = 15;
const REMOTIVE_PER_DAY = 4; // Remotive's API terms ask for at most 4 calls a day

const fetcher = createFetcher({ isAllowed: Discover.isAllowedDiscoveryUrl, maxBytes: MAX_BYTES });
let running = null;

function file() {
  return path.join(app.getPath('userData'), 'matches.json');
}

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return d && typeof d === 'object' ? d : {};
  } catch {
    return {};
  }
}

function save(d) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(d, null, 2));
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// What the renderer shows: matches not added or dismissed, best first.
function status() {
  const d = load();
  const hidden = new Set([...(d.dismissed || []), ...(d.added || [])]);
  return {
    lastRun: d.lastRun || null,
    running: Boolean(running),
    matches: (d.matches || []).filter((m) => !hidden.has(m.key)),
    errors: d.errors || [],
    counts: d.counts || {},
    newCount: d.newCount || 0,
    found: d.found || 0,
    remotive: (d.matches || []).some((m) => m.source === 'remotive'),
  };
}

// One run. deps: { search, master, jobs (existing, for "already tracked"), onProgress }
async function run({ search, master, jobs = [] }) {
  if (running) return running;
  running = (async () => {
    const d = load();
    const date = today();
    // Remotive: at most REMOTIVE_PER_DAY calls a day.
    const rc = d.remotiveCalls?.date === date ? d.remotiveCalls.count : 0;
    let sources = Discover.defaultSources(search);
    if (rc >= REMOTIVE_PER_DAY) sources = sources.filter((s) => s !== 'remotive');
    const collected = await Discover.collect(search, { fetcher, sources });
    const remotiveUsed = collected.requests.filter((r) => /remotive\.com/.test(r.url)).length;
    const tracked = jobs.map((j) => ({ url: j.url || '', company: j.company || '', role: j.role || '' }));
    const ranked = Discover.rank(collected.jobs, master, search, { today: date, days: 45, tracked });
    let best = ranked.jobs;
    try {
      best = (await Discover.enrich(ranked.jobs, master, search, { today: date, days: 45, tracked, fetcher, top: ENRICH_TOP })).jobs;
    } catch (err) {
      collected.errors.push({ source: 'descriptions', message: err.message });
    }
    const top = best.slice(0, KEEP_MATCHES);
    const { fresh } = Discover.newSince(top, d.seen || {});
    const freshKeys = new Set(fresh.map((j) => Discover.jobKey(j)));
    const matches = top.map((j) => ({
      key: Discover.jobKey(j),
      fresh: freshKeys.has(Discover.jobKey(j)),
      source: j.source,
      company: j.company,
      title: j.title,
      location: j.location,
      url: j.url,
      posted: j.posted,
      score: j.score,
      why: j.why,
      gaps: (j.gaps || []).slice(0, 12),
      // Listings often carry little or no description, so the kit's "very
      // short description" warning would be noise here.
      flags: (j.flags || []).filter((f) => !/very short, vague description/i.test(f)).slice(0, 6),
      description: String(j.description || '').slice(0, 20000),
    }));
    const next = {
      ...d,
      lastRun: Date.now(),
      matches,
      newCount: fresh.length,
      found: ranked.found,
      counts: collected.counts,
      errors: collected.errors.slice(0, 30),
      seen: Discover.rememberSeen(d.seen || {}, top, date),
      remotiveCalls: { date, count: rc + remotiveUsed },
    };
    save(next);
    return status();
  })();
  try {
    return await running;
  } finally {
    running = null;
  }
}

function hide(key, list) {
  const d = load();
  d[list] = [...new Set([...(d[list] || []), String(key)])].slice(-2000);
  save(d);
}

function get(key) {
  return (load().matches || []).find((m) => m.key === key) || null;
}

const dueForDailyRun = (now = Date.now()) => {
  const last = load().lastRun || 0;
  return now - last > 20 * 3600 * 1000;
};

function clear() {
  if (fs.existsSync(file())) fs.unlinkSync(file());
}

module.exports = { status, run, hide, get, dueForDailyRun, clear, fetcher };
