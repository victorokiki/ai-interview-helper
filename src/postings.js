// Reading a job posting from its link (main process). The parsing rules are
// in packages/core/postings.js (ported from Autonomous Job Kit); this file is
// the only network access, and it is deliberately narrow:
// - https only, and only the job-site addresses CorePostings.isAllowedUrl
//   accepts (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, iCIMS,
//   Oracle Recruiting Cloud, Rippling, Canada's Job Bank). Every redirect is
//   checked again, so a link can't bounce the app to another address.
// - No cookies or sign-in, a generic User-Agent, a 15 s timeout, 5 MB cap,
//   and one request every 5 s to Job Bank (its robots.txt asks for that).
const Postings = require('../packages/core/postings');

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) InterviewHelper-PostingReader/1.0';
const SLOW_HOSTS = { 'www.jobbank.gc.ca': 5000 };
const lastHit = new Map();

function blocked(url) {
  const err = new Error(`Interview Helper only reads postings from known job sites, and ${safeHost(url)} isn't one of them. Use the browser extension on that page, or paste the description.`);
  err.code = 'blocked';
  err.url = String(url); // the reader can learn a Greenhouse board from a refused redirect
  return err;
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'that address';
  }
}

async function readCapped(res, maxBytes = MAX_BYTES) {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      reader.cancel().catch(() => {});
      const err = new Error('The job page is too large to read.');
      err.code = 'parse';
      throw err;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

async function pace(url) {
  const host = new URL(url).hostname;
  const gap = SLOW_HOSTS[host];
  if (!gap) return;
  const wait = (lastHit.get(host) || 0) + gap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(host, Date.now());
}

// A fetcher limited to the addresses `isAllowed` accepts (every redirect hop
// included). The posting reader uses CorePostings.isAllowedUrl; job discovery
// passes its own list.
function createFetcher({ isAllowed = Postings.isAllowedUrl, maxBytes = MAX_BYTES } = {}) {
  return async function fetcher(url, { method = 'GET', headers = {}, body } = {}) {
  let current = String(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowed(current)) throw blocked(current);
    await pace(current);
    let res;
    try {
      res = await fetch(current, {
        method: hop ? 'GET' : method,
        headers: { 'user-agent': USER_AGENT, accept: 'application/json, text/html;q=0.9, */*;q=0.5', ...headers },
        body: hop ? undefined : body,
        redirect: 'manual',
        credentials: 'omit',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const e = new Error(err.name === 'TimeoutError' ? 'The job site took too long to answer. Try again.' : `Couldn't reach the job site (${err.cause?.code || err.message}).`);
      e.code = 'network';
      throw e;
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).toString();
      continue;
    }
    const text = await readCapped(res, maxBytes);
    return { status: res.status, url: current, headers: Object.fromEntries([...res.headers].map(([k, v]) => [k.toLowerCase(), v])), text };
  }
  const err = new Error('The job link redirected too many times.');
  err.code = 'network';
  throw err;
  };
}

// The fetcher handed to CorePostings.fetchPosting.
const fetcher = createFetcher();

// A posting object, or { error, code } with a message for the user.
async function readPosting(url) {
  const link = String(url || '').trim();
  try {
    const u = new URL(link);
    if (!/^https?:$/.test(u.protocol)) throw new Error('bad protocol');
  } catch {
    return { error: 'That doesn\'t look like a web link.', code: 'unsupported' };
  }
  if (!Postings.detect(link)) {
    return { error: `Interview Helper can read postings from Greenhouse, Lever, Ashby, Workday, SmartRecruiters, iCIMS, Oracle, Rippling and Canada's Job Bank. For ${safeHost(link)}, use the browser extension on the posting, or paste the description.`, code: 'unsupported' };
  }
  try {
    return { posting: await Postings.fetchPosting(link.replace(/^http:/i, 'https:'), fetcher) };
  } catch (err) {
    return { error: err.message || String(err), code: err.code || 'network' };
  }
}

module.exports = { readPosting, fetcher, createFetcher };
