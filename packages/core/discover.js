// Job discovery: find jobs and internships in Canada, the US or the UK from
// public sources, keep the ones that fit the user's tracks, rank them by fit
// and tell what is new since the last digest. A faithful port of the
// Autonomous Job Kit's internship-application/scripts/find_jobs.py,
// find_internships.py (the SimplifyJobs filters) and job_digest.py, with the
// duplicate keys of lib/jobkit/queue.py (MIT, same author), checked against the
// Python by tests/unit/discover.test.js.
//
// Sources (all public job data, read politely: one request a second per site,
// one every 5 seconds for Job Bank as its robots.txt asks):
//   simplify-intern / simplify-newgrad  SimplifyJobs listings.json (locations in the search country only)
//   jobbank          Canada only: Job Bank search, one per search.jobbank_queries entry
//   greenhouse, lever, ashby, smartrecruiters, workday   the boards in search.employers
//   remotive         remote jobs open to the search country (Remotive API)
//
// Pure: no file access, and every request goes through the fetcher the caller
// passes in, fetcher(url, { method, headers, body }) -> Promise<{ status, url, headers, text }>,
// and only to addresses isAllowedDiscoveryUrl() accepts (the main process
// enforces the same list, redirects included). Fit scores come from fit.js
// (rank_jobs.py), scam warnings from redflags.js and the optional description
// fetch from postings.js. Loads as CommonJS or as a browser global (CoreDiscover).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./fit'), require('./postings'), require('./redflags'));
  } else {
    root.CoreDiscover = factory(root.CoreFit, root.CorePostings, root.CoreRedFlags);
  }
})(typeof self !== 'undefined' ? self : this, function (CoreFit, CorePostings, CoreRedFlags) {
  'use strict';

  // ---------- Python compatibility ----------
  // rx() compiles a Python `re` pattern with Python's meaning (Unicode \b \w \d \s,
  // "." without newline, "$" also before a final newline); see postings.js.
  const rx = CorePostings._internal.rx;
  const urlsplit = CorePostings._internal.urlsplit;
  const quote = CorePostings._internal.quote;
  const asciiDigits = CoreFit._internals.asciiDigits;
  const unescapeHtml = CorePostings.unescapeHtml;
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isDict = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

  const WS = '\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
  const WS_EDGE = new RegExp(`^[${WS}]+|[${WS}]+$`, 'gu');
  const WS_RUN = new RegExp(`[${WS}]+`, 'gu');
  const pyStrip = (s) => String(s).replace(WS_EDGE, '');
  const cpLen = (s) => Array.from(String(s)).length;
  const cpSlice = (s, a, b) => Array.from(String(s)).slice(a, b).join('');
  // Python truthiness for JSON values
  const truthy = (v) => !(v === null || v === undefined || v === false || v === 0 || v === '' || Number.isNaN(v) ||
    (Array.isArray(v) && v.length === 0) || (isDict(v) && Object.keys(v).length === 0));
  const or = (a, b) => (truthy(a) ? a : b);
  // str() of a JSON scalar
  function pyStr(v) {
    if (v === null || v === undefined) return 'None';
    if (v === true) return 'True';
    if (v === false) return 'False';
    if (typeof v === 'number') return String(v);
    if (Array.isArray(v)) return '[' + v.map((x) => (typeof x === 'string' ? `'${x}'` : pyStr(x))).join(', ') + ']';
    if (isDict(v)) return '{' + Object.entries(v).map(([k, x]) => `'${k}': ${typeof x === 'string' ? `'${x}'` : pyStr(x)}`).join(', ') + '}';
    return String(v);
  }
  // Python sorts strings by code point; JS's default sort compares UTF-16 units.
  function cpCompare(a, b) {
    const x = Array.from(a);
    const y = Array.from(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const d = x[i].codePointAt(0) - y[i].codePointAt(0);
      if (d) return d;
    }
    return x.length - y.length;
  }
  // str.title(): upper case after an uncased character, lower case after a cased one
  const CASED = /[\p{Lu}\p{Ll}\p{Lt}]/u;
  function pyTitle(s) {
    let out = '';
    let prev = false;
    for (const ch of String(s)) {
      const cased = CASED.test(ch);
      out += cased ? (prev ? ch.toLowerCase() : ch.toUpperCase()) : ch;
      prev = cased;
    }
    return out;
  }

  // ---------- jobkit/text.py and jobkit/queue.py: the keys that spot the same posting twice ----------

  /** Lower case, letters and digits only, single spaces (text.norm). */
  function norm(text) {
    return pyStrip(String(truthy(text) ? pyStr(text) : '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(WS_RUN, ' '));
  }
  const COMPANY_NOISE = rx(String.raw`\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|plc|llp|gmbh|sa|ag|` +
    String.raw`the|group|holdings|technologies|technology|labs)\b`, 'g');
  /** A company name reduced for matching ("Acme, Inc." and "ACME" give the same key) (text.name_key). */
  function nameKey(company) {
    const k = pyStrip(norm(String(truthy(company) ? pyStr(company) : '').split('&').join(' and ')).replace(COMPANY_NOISE, ' ').replace(WS_RUN, ' '));
    return k || norm(company);
  }
  /** One key for "this company, this job title", or null (queue.role_key). */
  function roleKey(company, role) {
    const c = nameKey(company);
    const r = norm(role);
    return c && r ? `${c}|${r}` : null;
  }

  function unquote(s) {
    if (!s.includes('%')) return s;
    return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => {
      const bytes = new Uint8Array(m.length / 3);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(m.substr(i * 3 + 1, 2), 16);
      return new TextDecoder('utf-8').decode(bytes);
    });
  }
  // urllib.parse.parse_qsl(query): pairs in order, blank values dropped
  function parseQsl(query) {
    const out = [];
    for (const nv of String(query).split('&')) {
      if (!nv) continue;
      const j = nv.indexOf('=');
      if (j < 0) continue;
      const v = nv.slice(j + 1);
      if (v.length) out.push([unquote(nv.slice(0, j).replace(/\+/g, ' ')), unquote(v.replace(/\+/g, ' '))]);
    }
    return out;
  }
  const quotePlus = (s) => (s.includes(' ') ? quote(s, ' ').replace(/ /g, '+') : quote(s, ''));
  const urlencode = (pairs) => pairs.map(([k, v]) => quotePlus(String(k)) + '=' + quotePlus(String(v))).join('&');
  // urllib.parse.urlunsplit (Python 3.14) without a fragment
  const USES_NETLOC = new Set(['', 'ftp', 'http', 'gopher', 'nntp', 'telnet', 'imap', 'wais', 'file', 'mms', 'https', 'shttp',
    'snews', 'prospero', 'rtsp', 'rtsps', 'rtspu', 'rsync', 'svn', 'svn+ssh', 'sftp', 'nfs', 'git', 'git+ssh', 'ws', 'wss', 'itms-services']);
  function urlunsplit(scheme, netloc, path, query) {
    let url = path;
    let nl = netloc;
    if (!nl) nl = scheme && USES_NETLOC.has(scheme) && (!url || url[0] === '/') ? '' : null;
    if (nl !== null) {
      if (url && url[0] !== '/') url = '/' + url;
      url = '//' + nl + url;
    } else if (url.slice(0, 2) === '//') {
      url = '//' + url;
    }
    if (scheme) url = scheme + ':' + url;
    if (query) url += '?' + query;
    return url;
  }

  const TRACKING = rx('^(?:(utm_|ref$|source$|src$|lever-source|gh_src|iis|iisn))', 'i');
  /** Scheme and host in lower case, no fragment, no tracking parameters, no trailing slash (queue.clean_url). */
  function cleanUrl(url) {
    const u = urlsplit(pyStrip(truthy(url) ? pyStr(url) : ''));
    const keep = parseQsl(u.query).filter(([k]) => !TRACKING.test(k));
    const path = u.path.replace(/\/+$/, '') || '/';
    return urlunsplit(u.scheme.toLowerCase() || 'https', u.netloc.toLowerCase(), path, urlencode(keep));
  }

  const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const GH_JOB = rx(String.raw`greenhouse\.io/.*?/jobs/(\d+)`);
  const GH_TOKEN = rx(String.raw`[?&]token=(\d+)`);
  const UUID_RX = rx(UUID, 'i');
  const WD_ID = rx(String.raw`_([A-Z]{0,4}-?\d{3,}(?:-\d+)?)(?:/|$|\?)`);
  const SR_ID = rx(String.raw`/(\d{6,})`);
  const ICIMS_ID = rx(String.raw`/jobs/(\d+)`);
  const JB_ID = rx(String.raw`/jobposting/(\d+)`);
  const ID_VALUE = rx(String.raw`^(?:[\w-]{4,})(?![\s\S])`);
  const ID_PARAMS = ['jobId', 'jobid', 'job_id', 'jid', 'reqId', 'requisitionId', 'id'];

  /** Keys that identify a posting whatever link points at it: the cleaned link without its query, plus the
   *  application system's own job ID when the link shows one (queue.posting_keys). A Set. */
  function postingKeys(url) {
    const keys = new Set();
    if (!truthy(url)) return keys;
    const u = urlsplit(pyStrip(pyStr(url)));
    const host = u.netloc.toLowerCase();
    const path = u.path;
    const q = new Map(parseQsl(u.query));
    keys.add(cleanUrl(url).split('?')[0]);
    if (q.get('gh_jid')) keys.add('greenhouse:' + q.get('gh_jid'));
    let m = GH_JOB.exec(host + path) || GH_TOKEN.exec(u.query);
    if (m && host.includes('greenhouse')) keys.add('greenhouse:' + m[1]);
    m = UUID_RX.exec(path);
    if (m && host.includes('lever.co')) keys.add('lever:' + m[0].toLowerCase());
    if (m && host.includes('ashbyhq.com')) keys.add('ashby:' + m[0].toLowerCase());
    if (host.includes('myworkday')) {
      m = WD_ID.exec(path + '/');
      if (m) keys.add(`workday:${host.split('.')[0]}:${m[1].toUpperCase()}`);
    }
    if (host.includes('smartrecruiters.com')) {
      m = SR_ID.exec(path);
      if (m) keys.add('smartrecruiters:' + m[1]);
    }
    if (host.includes('icims.com')) {
      m = ICIMS_ID.exec(path);
      if (m) keys.add(`icims:${host.split('.')[0]}:${m[1]}`);
    }
    if (host.includes('jobbank.gc.ca')) {
      m = JB_ID.exec(path);
      if (m) keys.add('jobbank:' + m[1]);
    }
    for (const k of ID_PARAMS) {
      if (q.get(k) && ID_VALUE.test(q.get(k))) {
        keys.add(`${host}:${k}:${q.get(k)}`);
        break;
      }
    }
    return keys;
  }

  // ---------- dates (find_jobs.day) ----------

  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const localIso = (d) => `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const ISO_START = rx(String.raw`^(?:(\d{4}-\d{2}-\d{2}))`);
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const ABBR = MONTHS.map((m) => m.slice(0, 3));
  // time.strptime(s, '%B %d, %Y') / '%b %d, %Y': whole string, case-insensitive month, whitespace runs for spaces
  const D = String.raw`(3[01]|[12]\d|0[1-9]|[1-9]| [1-9])`;
  const strptimeRx = (names) => rx(`^(?:(${[...names].sort((a, b) => b.length - a.length).join('|')})\\s+${D},\\s+(\\d\\d\\d\\d))(?![\\s\\S])`, 'i');
  const LONG_DATE = strptimeRx(MONTHS);
  const SHORT_DATE = strptimeRx(ABBR);
  const isLeap = (y) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const DIM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  /** YYYY-MM-DD from epoch seconds or milliseconds (local date, as date.fromtimestamp), ISO text,
   *  or "November 10, 2026" / "Nov 10, 2026"; '' otherwise. */
  function day(v) {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'boolean') v = v ? 1 : 0;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return '';
      const d = new Date((v > 1e11 ? v / 1000 : v) * 1000);
      return Number.isNaN(d.getTime()) ? '' : localIso(d);
    }
    if (typeof v !== 'string') return '';
    const s = pyStrip(v);
    const m = ISO_START.exec(s);
    if (m) return m[1];
    for (const [re, names] of [[LONG_DATE, MONTHS], [SHORT_DATE, ABBR]]) {
      const p = re.exec(s);
      if (!p) continue;
      const month = names.indexOf(p[1].toLowerCase()) + 1;
      const dd = parseInt(asciiDigits(p[2]).trim(), 10);
      const year = parseInt(asciiDigits(p[3]), 10);
      if (year < 1) continue;
      const dim = month === 2 && isLeap(year) ? 29 : DIM[month - 1];
      if (dd > dim) continue;
      return `${pad(year, 4)}-${pad(month)}-${pad(dd)}`;
    }
    return '';
  }
  const DAY_MS = 86400000;
  const isoToDays = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
    if (!m) return null;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    const back = new Date(t);
    if (back.getUTCDate() !== +m[3] || back.getUTCMonth() !== +m[2] - 1) return null;
    return Math.round(t / DAY_MS);
  };
  const daysToIso = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
  function todayIso(today) {
    if (today instanceof Date) return localIso(today);
    if (typeof today === 'string' && isoToDays(today.slice(0, 10)) !== null) return today.slice(0, 10);
    if (today === undefined || today === null) return localIso(new Date());
    throw new Error(`discover: today must be YYYY-MM-DD, got ${JSON.stringify(today)}`);
  }

  /** One job record, as find_jobs.job() builds it. */
  function makeJob(source, company, title, location, url, posted = '', description = '', kind = '') {
    return {
      source,
      company: pyStrip(unescapeHtml(truthy(company) ? pyStr(company) : '')),
      title: pyStrip(unescapeHtml(truthy(title) ? pyStr(title) : '')),
      location: pyStrip(truthy(location) ? pyStr(location) : ''),
      url,
      posted: day(posted),
      description: or(description, ''),
      kind,
    };
  }

  // ---------- countries (rank_jobs.COUNTRIES: what Remotive and SmartRecruiters call them) ----------

  const COUNTRIES = Object.freeze({
    CA: Object.freeze({ name: 'Canada', remotive: 'canada|worldwide|anywhere|north america|americas', sr: 'ca' }),
    US: Object.freeze({ name: 'the US', remotive: String.raw`\busa?\b|united states|worldwide|anywhere|north america|americas`, sr: 'us' }),
    GB: Object.freeze({ name: 'the UK', remotive: String.raw`\buk\b|united kingdom|europe|emea|worldwide|anywhere`, sr: 'gb' }),
  });
  const SR_COUNTRY = { ca: 'Canada', us: 'United States', gb: 'United Kingdom' };

  // ---------- sources ----------

  const SIMPLIFY = Object.freeze({
    'simplify-intern': 'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json',
    'simplify-newgrad': 'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json',
  });
  const SOURCES = Object.freeze([
    { id: 'simplify-intern', label: 'SimplifyJobs internship list', countries: ['CA', 'US', 'GB'] },
    { id: 'simplify-newgrad', label: 'SimplifyJobs new-grad list', countries: ['CA', 'US', 'GB'] },
    { id: 'jobbank', label: 'Job Bank (Government of Canada)', countries: ['CA'] },
    { id: 'greenhouse', label: 'Greenhouse boards (search.json employers)', countries: ['CA', 'US', 'GB'] },
    { id: 'lever', label: 'Lever boards (search.json employers)', countries: ['CA', 'US', 'GB'] },
    { id: 'ashby', label: 'Ashby boards (search.json employers)', countries: ['CA', 'US', 'GB'] },
    { id: 'smartrecruiters', label: 'SmartRecruiters boards (search.json employers)', countries: ['CA', 'US', 'GB'] },
    { id: 'workday', label: 'Workday boards (search.json employers)', countries: ['CA', 'US', 'GB'] },
    { id: 'remotive', label: 'Remotive (remote jobs open to your country)', countries: ['CA', 'US', 'GB'] },
  ].map((s) => Object.freeze({ ...s, countries: Object.freeze(s.countries) })));
  const ALL_SOURCES = SOURCES.map((s) => s.id);

  /** The sources that apply to the search's country (Job Bank lists Canadian jobs only). */
  function defaultSources(search) {
    const code = CoreFit.countryCode(search || {});
    return SOURCES.filter((s) => s.countries.includes(code)).map((s) => s.id);
  }

  // ---------- which addresses discovery may request ----------
  // Everything postings.js may request (the job-site APIs and pages, Job Bank included) plus the three
  // addresses only discovery uses, each held to the paths it needs.
  const DISCOVERY_PATHS = Object.freeze({
    'api.ashbyhq.com': Object.freeze({ prefixes: Object.freeze(['/posting-api/job-board/']) }),
    'remotive.com': Object.freeze({ prefixes: Object.freeze(['/api/remote-jobs']) }),
    'raw.githubusercontent.com': Object.freeze({
      exact: Object.freeze(Object.values(SIMPLIFY).map((u) => new URL(u).pathname)),
    }),
  });
  const DISCOVERY_HOSTS = Object.freeze([...CorePostings.ALLOWED_HOSTS, ...Object.keys(DISCOVERY_PATHS)]);

  /** True only for an https address discovery requests: a postings.js job-site address, the Ashby posting API,
   *  Remotive's /api/remote-jobs, or one of the two SimplifyJobs listings.json files. */
  function isAllowedDiscoveryUrl(url) {
    if (CorePostings.isAllowedUrl(url)) return true;
    let u;
    try {
      u = new URL(String(url));
    } catch {
      return false;
    }
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
    const host = u.hostname.toLowerCase();
    if (!hasOwn(DISCOVERY_PATHS, host)) return false;
    const rule = DISCOVERY_PATHS[host];
    const path = u.pathname;
    if (/%2f|%5c|%2e|\\/i.test(path)) return false;
    if (rule.exact) return rule.exact.includes(path) && !u.search;
    // "/a/b/" covers what is below it; "/a/b" covers itself and what is below it
    return rule.prefixes.some((p) => (p.endsWith('/') ? path.length > p.length && path.startsWith(p) : path === p || path.startsWith(p + '/')));
  }

  // ---------- network, through the injected fetcher ----------

  class DiscoveryError extends Error {
    constructor(message, kind, status = null) {
      super(message);
      this.name = kind === 'http' ? 'HTTPError' : 'DiscoveryError';
      this.kind = kind; // http | blocked | network | parse
      this.status = status;
    }
  }
  const hostOf = (url) => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  };

  const JOB_BANK_HOST = 'www.jobbank.gc.ca';
  function makeNet(fetcher, opts = {}) {
    if (typeof fetcher !== 'function') throw new TypeError('discover.collect needs a fetcher function');
    const delayMs = opts.delayMs ?? 1000;
    const hostDelayMs = opts.hostDelayMs ?? { [JOB_BANK_HOST]: 5000 };
    const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const last = new Map();
    const requests = [];
    async function get(url, { data, raw = false } = {}) {
      const host = hostOf(url);
      if (!isAllowedDiscoveryUrl(url)) {
        throw new DiscoveryError(`${host || 'this address'} is not one of the addresses job discovery contacts`, 'blocked');
      }
      const gap = hasOwn(hostDelayMs, host) ? hostDelayMs[host] : delayMs;
      const wait = (last.has(host) ? last.get(host) : -Infinity) + gap - Date.now();
      if (wait > 0) await sleep(wait);
      // Job Bank answers 500 to an Accept header that prefers JSON, so pages ask for HTML
      const headers = { 'User-Agent': CorePostings.USER_AGENT, Accept: raw ? 'text/html,application/xhtml+xml' : 'application/json' };
      let body;
      if (data !== undefined) {
        body = JSON.stringify(data);
        headers['Content-Type'] = 'application/json';
      }
      const init = body !== undefined ? { method: 'POST', headers, body } : { method: 'GET', headers };
      requests.push({ url, method: init.method, body: body === undefined ? null : body });
      let res;
      try {
        res = await fetcher(url, init);
      } catch (e) {
        if (e && e.code === 'blocked') throw new DiscoveryError(e.message || 'blocked', 'blocked');
        throw new DiscoveryError(`could not connect to ${host}: ${(e && e.message) || e}`, 'network');
      } finally {
        last.set(host, Date.now());
      }
      res = res || {};
      const finalUrl = typeof res.url === 'string' && res.url ? res.url : url;
      if (finalUrl !== url && !isAllowedDiscoveryUrl(finalUrl)) {
        throw new DiscoveryError(`${hostOf(finalUrl) || 'a redirect'} is not one of the addresses job discovery contacts`, 'blocked');
      }
      const status = Number(res.status) || 0;
      if (!(status >= 200 && status < 300)) throw new DiscoveryError(`HTTP Error ${status}`, 'http', status);
      const text = res.text == null ? '' : String(res.text);
      if (raw) return text;
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new DiscoveryError(`${host} did not return JSON (${e.message})`, 'parse');
      }
    }
    return { get, requests };
  }

  // Each parser turns one source response into job records, exactly as the matching find_jobs.py function does.
  const list = (v) => (Array.isArray(v) ? v : []);
  const get = (o, k, dflt) => (isDict(o) && hasOwn(o, k) ? o[k] : dflt);

  /** SimplifyJobs listings.json -> jobs at locations in the search country (find_jobs.simplify). */
  function parseSimplify(name, data, search) {
    const out = [];
    for (const x of list(data)) {
      if (!isDict(x) || !truthy(get(x, 'active')) || !truthy(get(x, 'is_visible', true))) continue;
      const here = list(or(get(x, 'locations'), [])).filter((l) => {
        const p = CoreFit.placeFit(l, search);
        return p !== null && p !== 'remote';
      });
      if (!here.length) continue;
      out.push(makeJob(name, get(x, 'company_name'), get(x, 'title'), here.slice(0, 3).join('; '), get(x, 'url'),
        get(x, 'date_posted'), '', name.endsWith('intern') ? 'internship' : 'new grad'));
    }
    return out;
  }

  const JB_ARTICLE = rx('<article id="article-(\\d+)"(.*?)</article>', 'gs');
  const TAG = /<[^>]+>/g;
  const SPACES = rx('\\s+', 'g');
  /** A Job Bank search results page -> jobs (find_jobs.jobbank). */
  function parseJobBank(page) {
    const out = [];
    for (const m of String(page).matchAll(JB_ARTICLE)) {
      const pid = m[1];
      const body = m[2];
      const cls = (c) => {
        // an <li> holds icon <span>s, so match it to its own closing tag first
        const mm = rx(`<li class="${c}">(.*?)</li>`, 's').exec(body) || rx(`<span class="${c}">(.*?)</span>`, 's').exec(body);
        return mm ? pyStrip(mm[1].replace(TAG, ' ').replace(SPACES, ' ').split('Location').join('')) : '';
      };
      const loc = cls('location').split('(').join(', ').split(')').join('');
      out.push(makeJob('jobbank', cls('business'), cls('noctitle'), loc + ', Canada',
        `https://www.jobbank.gc.ca/jobsearch/jobposting/${pid}`, cls('date'), cls('salary')));
    }
    return out;
  }

  /** Greenhouse board API jobs -> jobs (find_jobs.greenhouse). */
  function parseGreenhouse(board, data, name = board) {
    return list(get(data, 'jobs', [])).map((j) => makeJob('greenhouse', name, get(j, 'title'), get(or(get(j, 'location'), {}), 'name'),
      get(j, 'absolute_url'), or(get(j, 'first_published'), get(j, 'updated_at')), get(j, 'content')));
  }

  /** Lever postings API -> jobs (find_jobs.lever). */
  function parseLever(company, data) {
    return list(data).map((j) => {
      const cats = or(get(j, 'categories'), {});
      const loc = [get(cats, 'location'), get(j, 'workplaceType') === 'remote' ? get(j, 'workplaceType') : ''].filter(truthy).join(', ');
      // as in the kit, a list without text content fails the board (str.join of None)
      const lists = list(or(get(j, 'lists'), [])).map((l, i) => {
        const c = get(l, 'content', '');
        if (typeof c !== 'string') throw new TypeError(`sequence item ${i}: expected str instance, ${c === null ? 'NoneType' : typeof c} found`);
        return c;
      });
      return makeJob('lever', pyTitle(String(company).split('-').join(' ')), get(j, 'text'), loc, get(j, 'hostedUrl'), get(j, 'createdAt'),
        String(or(get(j, 'descriptionPlain'), '')) + ' ' + lists.join(' '));
    });
  }

  /** Ashby posting API -> jobs (find_jobs.ashby). */
  function parseAshby(org, data) {
    return list(get(data, 'jobs', [])).map((j) => {
      const places = [or(get(j, 'location'), '')].concat(list(or(get(j, 'secondaryLocations'), [])).map((s) => get(s, 'location', '')));
      const country = or(get(or(get(or(get(j, 'address'), {}), 'postalAddress'), {}), 'addressCountry'), '');
      let loc = places.filter(truthy).join('; ');
      if (truthy(country) && !loc.toLowerCase().includes(String(country).toLowerCase())) loc += `, ${country}`;
      if (truthy(get(j, 'isRemote'))) loc += ' (Remote)';
      return makeJob('ashby', org, get(j, 'title'), loc, get(j, 'jobUrl'), get(j, 'publishedAt'), get(j, 'descriptionPlain'));
    });
  }

  /** SmartRecruiters postings API -> jobs (find_jobs.smartrecruiters). */
  function parseSmartRecruiters(company, data, search) {
    const sr = COUNTRIES[CoreFit.countryCode(search || {})].sr;
    return list(get(data, 'content', [])).map((j) => {
      const l = or(get(j, 'location'), {});
      const loc = [get(l, 'city'), get(l, 'region'), SR_COUNTRY[sr], truthy(get(l, 'remote')) ? 'Remote' : ''].filter(truthy).join(', ');
      return makeJob('smartrecruiters', or(get(or(get(j, 'company'), {}), 'name'), company), get(j, 'name'), loc,
        `https://jobs.smartrecruiters.com/${company}/${pyStr(get(j, 'id'))}`, get(j, 'releasedDate'));
    });
  }

  /** Workday search results (one query) -> jobs (find_jobs.workday). */
  function parseWorkday(w, data) {
    return list(get(data, 'jobPostings', [])).map((j) => {
      const ep = get(j, 'externalPath', '');
      return makeJob('workday', or(get(w, 'company'), get(w, 'tenant')), get(j, 'title'), get(j, 'locationsText'),
        `https://${w.host}/${w.site}${typeof ep === 'string' ? ep : pyStr(ep)}`, '');
    });
  }

  /** Remotive API -> remote jobs open to the search country (find_jobs.remotive). */
  function parseRemotive(data, search) {
    const c = COUNTRIES[CoreFit.countryCode(search || {})];
    const open = rx(c.remotive, 'i');
    const out = [];
    for (const j of list(get(data, 'jobs', []))) {
      const where = String(or(get(j, 'candidate_required_location'), ''));
      if (!open.test(where)) continue;
      out.push(makeJob('remotive', get(j, 'company_name'), get(j, 'title'), `Remote (${where}, open to ${c.name})`,
        get(j, 'url'), get(j, 'publication_date'), get(j, 'description')));
    }
    return out;
  }

  // The source requests themselves (find_jobs.py's simplify, jobbank, greenhouse... functions)
  const seg = (s) => encodeURIComponent(String(s));
  const SOURCE_FNS = {
    async simplify(net, name, search) {
      return parseSimplify(name, await net.get(SIMPLIFY[name]), search);
    },
    async jobbank(net, search, errors) {
      const out = [];
      for (const q of list(get(search, 'jobbank_queries', []))) {
        // Job Bank ignores free-text locations ("Vancouver, BC"); the province filter fprov is what narrows results.
        const params = [['searchstring', q], ['sort', 'D']];
        if (truthy(get(search, 'province'))) params.push(['fprov', String(search.province).toUpperCase()]);
        let page;
        try {
          page = await net.get('https://www.jobbank.gc.ca/jobsearch/jobsearch?' + urlencode(params), { raw: true });
        } catch (e) { // one failed search shouldn't lose the others
          errors.push({ source: `jobbank:${q}`, message: `${e.name}: ${cpSlice(e.message, 0, 100)}` });
          continue;
        }
        out.push(...parseJobBank(page));
      }
      return out;
    },
    async greenhouse(net, board) {
      const d = await net.get(`https://boards-api.greenhouse.io/v1/boards/${seg(board)}/jobs?content=true`);
      let name = board;
      try {
        name = or(get(await net.get(`https://boards-api.greenhouse.io/v1/boards/${seg(board)}`), 'name'), board);
      } catch { /* the board's name is optional */ }
      return parseGreenhouse(board, d, name);
    },
    async lever(net, company) {
      return parseLever(company, await net.get(`https://api.lever.co/v0/postings/${seg(company)}?mode=json`));
    },
    async ashby(net, org) {
      return parseAshby(org, await net.get(`https://api.ashbyhq.com/posting-api/job-board/${seg(org)}?includeCompensation=false`));
    },
    async smartrecruiters(net, company, search) {
      const sr = COUNTRIES[CoreFit.countryCode(search)].sr;
      return parseSmartRecruiters(company, await net.get(`https://api.smartrecruiters.com/v1/companies/${seg(company)}/postings?country=${sr}&limit=100`), search);
    },
    async workday(net, w) {
      for (const k of ['host', 'tenant', 'site']) {
        if (!isDict(w) || !hasOwn(w, k)) throw new DiscoveryError(`a workday entry needs "${k}"`, 'parse');
      }
      const base = `https://${w.host}/wday/cxs/${seg(w.tenant)}/${seg(w.site)}`;
      const out = [];
      for (const q of list(or(get(w, 'queries'), ['']))) {
        out.push(...parseWorkday(w, await net.get(base + '/jobs', { data: { appliedFacets: {}, limit: 20, offset: 0, searchText: q } })));
      }
      return out;
    },
    async remotive(net, search) {
      const out = [];
      for (const cat of list(get(search, 'remotive_categories', ['data', 'software-dev', 'customer-support']))) {
        const d = await net.get(`https://remotive.com/api/remote-jobs?category=${quote(String(cat))}&limit=100`);
        out.push(...parseRemotive(d, search));
      }
      return out;
    },
  };

  function errorMessage(e) {
    if (e instanceof DiscoveryError && e.kind === 'http') {
      return `HTTP ${e.status}` + (e.status === 404 ? ' (no such board: check the name in search.json)' : '');
    }
    return `${(e && e.name) || 'Error'}: ${cpSlice((e && e.message) || String(e), 0, 120)}`;
  }

  /**
   * Run each source; a failing one is recorded in errors and the rest still run (find_jobs.collect).
   * options: { fetcher (required), sources (default defaultSources(search)), maxPerSource (cap per board/source,
   *            default none), delayMs (between requests to one host, default 1000),
   *            hostDelayMs ({ host: ms }, default { 'www.jobbank.gc.ca': 5000 }), sleep (ms) => Promise }
   * -> { jobs, errors: [{ source, message }], counts: { label: number }, requests: [{ url, method, body }] }
   */
  async function collect(search, options = {}) {
    search = search || {};
    const net = makeNet(options.fetcher, options);
    const sources = options.sources || defaultSources(search);
    const cap = Number.isFinite(options.maxPerSource) && options.maxPerSource >= 0 ? options.maxPerSource : Infinity;
    const emp = or(get(search, 'employers'), {});
    const errors = [];
    const plan = [];
    for (const s of sources) {
      if (String(s).startsWith('simplify')) {
        if (hasOwn(SIMPLIFY, s)) plan.push([s, () => SOURCE_FNS.simplify(net, s, search)]);
        else plan.push([s, () => { throw new DiscoveryError(`unknown source ${s}`, 'parse'); }]);
      } else if (s === 'jobbank') {
        if (CoreFit.countryCode(search) !== 'CA') continue; // Job Bank lists Canadian jobs only
        plan.push([s, () => SOURCE_FNS.jobbank(net, search, errors)]);
      } else if (s === 'remotive') {
        plan.push([s, () => SOURCE_FNS.remotive(net, search)]);
      } else if (['greenhouse', 'lever', 'ashby', 'smartrecruiters'].includes(s)) {
        for (const b of list(get(emp, s, []))) plan.push([`${s}:${b}`, () => SOURCE_FNS[s](net, b, search)]);
      } else if (s === 'workday') {
        for (const w of list(get(emp, 'workday', []))) plan.push([`workday:${pyStr(get(w, 'tenant'))}`, () => SOURCE_FNS.workday(net, w)]);
      }
    }
    const jobs = [];
    const counts = {};
    for (const [label, fn] of plan) {
      try {
        const got = (await fn()).slice(0, cap);
        counts[label] = got.length;
        jobs.push(...got);
      } catch (e) {
        errors.push({ source: label, message: errorMessage(e) });
      }
    }
    return { jobs, errors, counts, requests: net.requests };
  }

  /** The SimplifyJobs listings.json (find_internships.load_listings, without the 3-hour file cache:
   *  wrap the fetcher to cache). name: simplify-intern (default) or simplify-newgrad. */
  async function fetchListings(options = {}) {
    const name = options.source || 'simplify-intern';
    if (!hasOwn(SIMPLIFY, name)) throw new TypeError(`unknown SimplifyJobs list ${name}`);
    const data = await makeNet(options.fetcher, options).get(SIMPLIFY[name]);
    if (!Array.isArray(data)) throw new DiscoveryError('the listings file is not a list', 'parse');
    return data;
  }

  // ---------- filtering and ranking (find_jobs.run, order, enrich, queueable) ----------

  /** Keys for tracker rows [{ url | posting_url, company, role }] (find_jobs.tracker_index). */
  function trackerKeys(rows) {
    const keys = new Set();
    for (const r of list(rows)) {
      for (const k of postingKeys(get(r, 'posting_url', get(r, 'url')))) keys.add(k);
      const k = roleKey(get(r, 'company'), get(r, 'role'));
      if (k) keys.add(k);
    }
    return keys;
  }

  const redFlagsDefault = CoreRedFlags && typeof CoreRedFlags.redFlags === 'function' ? CoreRedFlags.redFlags : undefined;
  function scoreOptions(options) {
    return {
      today: todayIso(options.today),
      sponsors: options.sponsors,
      // the kit shows scam warnings with every score; pass redFlags: null to leave them out
      redFlags: options.redFlags === undefined ? redFlagsDefault : options.redFlags || undefined,
    };
  }
  /** Co-op and student-only roles need enrolment in a school program; queue them only when the profile says
   *  the user is enrolled and returning to school after the job (find_jobs.queueable). */
  function queueable(job, profile) {
    const studentOnly = list(job && job.flags).some((f) => String(f).startsWith('co-op or student only'));
    const p = profile || {};
    return !studentOnly || (p.enrolled === 'yes' && p.returningToSchool === 'yes');
  }
  function scored(job, master, search, options, sOpts) {
    const fit = CoreFit.score(job, master, search, sOpts);
    const out = {
      ...job, score: fit.score, track: fit.track, place: fit.place, why: fit.why, gaps: fit.gaps, flags: fit.flags,
      matchedSkills: fit.matchedSkills, yearsRequired: fit.yearsRequired, parts: fit.parts,
    };
    out.queueable = queueable(out, options.profile);
    return out;
  }
  /** Best fit first; newest first among equal scores (find_jobs.order). Sorts in place and returns the array. */
  function order(jobs) {
    jobs.sort((a, b) => cpCompare(b.posted || '0000', a.posted || '0000'));
    jobs.sort((a, b) => b.score - a.score);
    return jobs;
  }

  const SKIP_REASONS = ['linkedin', 'not_in_country', 'title_not_in_tracks', 'excluded_title', 'too_old', 'already_tracked',
    'already_in_jobs_txt', 'duplicate'];

  /**
   * Filter and score collected jobs (find_jobs.run without the network): drops LinkedIn or missing links,
   * places outside the search country (Remotive is kept), excluded titles, titles in no track, postings older
   * than `days`, postings already tracked or queued, and repeats; scores the rest with fit.js and orders them.
   * options: { today, days (drop older postings; the kit uses 45 for a search, 14 for the digest), profile
   *            (for queueable), tracked (tracker rows [{ url, company, role }]), queued (links already in the
   *            queue), redFlags (default: redflags.js; null for none), sponsors (fit.js), top (slice the result) }
   * -> { jobs: [job + { score, track, place, why, gaps, flags, matchedSkills, yearsRequired, parts, queueable }],
   *      skipped: { reason: count }, found, kept }
   */
  function rank(jobs, master, search, options = {}) {
    search = search || {};
    const sOpts = scoreOptions(options);
    const today = isoToDays(sOpts.today);
    const days = options.days;
    const tracked = trackerKeys(options.tracked);
    const queuedLinks = new Set();
    const queuedKeys = new Set();
    for (const q of list(options.queued)) {
      queuedLinks.add(cleanUrl(q).split('?')[0].toLowerCase());
      for (const k of postingKeys(q)) queuedKeys.add(k);
    }
    const skipped = Object.fromEntries(SKIP_REASONS.map((k) => [k, 0]));
    const seen = new Set();
    const keep = [];
    const meets = (keys, set) => [...keys].some((k) => set.has(k));
    for (const j of list(jobs)) {
      const url = String(or(j.url, ''));
      if (!url || url.toLowerCase().includes('linkedin.com')) { skipped.linkedin++; continue; }
      if (CoreFit.placeFit(j.location, search) === null && j.source !== 'remotive') { skipped.not_in_country++; continue; }
      if (CoreFit.excluded(j.title, search)) { skipped.excluded_title++; continue; }
      if (!CoreFit.bestTrack(j.title, search).track) { skipped.title_not_in_tracks++; continue; }
      if (truthy(days) && j.posted) {
        const posted = isoToDays(j.posted);
        if (posted !== null && today - posted > days) { skipped.too_old++; continue; }
      }
      const pk = postingKeys(url);
      const dupe = roleKey(j.company, j.title);
      const keys = new Set(pk);
      if (dupe !== null) keys.add(dupe);
      if (meets(keys, tracked)) { skipped.already_tracked++; continue; }
      if (meets(pk, queuedKeys) || queuedLinks.has(url.split('?')[0].replace(/\/+$/, '').toLowerCase())) { skipped.already_in_jobs_txt++; continue; }
      if (seen.has(dupe) || meets(pk, seen)) { skipped.duplicate++; continue; }
      for (const k of pk) seen.add(k);
      seen.add(dupe); // as the kit does: a job with no company/title key marks "no key" as seen
      keep.push(scored(j, master, search, options, sOpts));
    }
    order(keep);
    const top = Number.isInteger(options.top) && options.top >= 0 ? options.top : keep.length;
    return { jobs: keep.slice(0, top), skipped, found: list(jobs).length, kept: keep.length };
  }

  /**
   * Listings without a description (SimplifyJobs, Job Bank, SmartRecruiters) can't be skill-matched or screened,
   * so read the full posting for the best few through postings.js, rescore and re-sort (find_jobs.enrich).
   * Only links postings.js reads (known job sites) are fetched; others keep their listing.
   * options: rank()'s options plus { fetcher, top (default search.enrich_top or 30), postingOptions (postings.js
   *          fetchPosting options, e.g. { delayMs }), fetchPosting (url) => Promise<{ description, posted }> to
   *          replace postings.js }
   * -> { jobs (new array, re-ordered), fetched }
   */
  async function enrich(ranked, master, search, options = {}) {
    search = search || {};
    const sOpts = scoreOptions(options);
    const top = Number.isInteger(options.top) ? options.top : get(search, 'enrich_top', 30);
    const read = options.fetchPosting || ((url) => CorePostings.fetchPosting(url, options.fetcher, options.postingOptions));
    const jobs = list(ranked).slice();
    let n = 0;
    for (let i = 0; i < Math.min(top, jobs.length); i++) {
      const j = jobs[i];
      if (cpLen(CoreFit.textOf(j.description)) > 400 || String(j.url).toLowerCase().includes('linkedin.com')) continue;
      let p;
      try {
        p = await read(j.url);
      } catch {
        continue;
      }
      if (p && !p.error && truthy(p.description)) {
        const next = { ...j, description: p.description };
        if (truthy(p.posted) && !j.posted) next.posted = day(p.posted);
        jobs[i] = scored(next, master, search, options, sOpts);
        n++;
      }
    }
    order(jobs);
    return { jobs, fetched: n };
  }

  /** The best queueable jobs scoring at least minScore, at most search.max_queue_per_run (find_jobs.pick_for_queue). */
  function pickForQueue(ranked, search, profile, minScore) {
    search = search || {};
    const min = minScore ?? get(search, 'min_score_to_queue', 55);
    return list(ranked).filter((j) => j.score >= min && queueable(j, profile)).slice(0, get(search, 'max_queue_per_run', 15));
  }

  /** The note written after a queued link in jobs.txt (find_jobs.note, without the link). */
  function queueNote(j) {
    const loc = cpSlice(String(j.location).split('|').join('/').split('#').join(''), 0, 60);
    return `${String(j.company).split('|').join('/')} | ${String(j.title).split('|').join('/')} | ${loc} | ` +
      `posted ${j.posted || 'unknown'} | fit ${j.score} (${pyStr(j.track)})`;
  }

  // ---------- employer boards (find_jobs.add_employer) ----------

  const LOCALE_SEG = rx('^(?:[a-z]{2}-[A-Z]{2})(?![\\s\\S])');
  /** The search.json employers entry for any link to a Greenhouse, Lever, Ashby, SmartRecruiters or Workday
   *  board (a posting or the careers page): { system, entry }, or null for anything else. */
  function parseEmployerUrl(url) {
    if (typeof url !== 'string') return null;
    const u = urlsplit(pyStrip(url));
    let path = u.path;
    if (['https', 'http', ''].includes(u.scheme) && path.includes(';')) { // urlparse() moves ";params" off the path
      const i = path.includes('/') ? path.indexOf(';', path.lastIndexOf('/')) : path.indexOf(';');
      if (i >= 0) path = path.slice(0, i);
    }
    const host = u.netloc.toLowerCase();
    const parts = path.split('/').filter(Boolean);
    if (host.endsWith('greenhouse.io') && parts.length) {
      const f = parseQsl(u.query).find(([k]) => k === 'for');
      return { system: 'greenhouse', entry: f ? f[1] : parts[0] };
    }
    if (host.endsWith('lever.co') && parts.length) return { system: 'lever', entry: parts[0] };
    if (host.endsWith('ashbyhq.com') && parts.length) return { system: 'ashby', entry: parts[0] };
    if (host.includes('smartrecruiters.com') && parts.length) return { system: 'smartrecruiters', entry: parts[0] };
    if (host.includes('myworkdayjobs.com') || host.includes('myworkdaysite.com')) {
      const rest = parts.filter((p) => !LOCALE_SEG.test(p));
      let tenant;
      let site;
      const i = rest.indexOf('recruiting');
      if (i >= 0) { // myworkdaysite.com/recruiting/<tenant>/<site>
        if (i + 2 >= rest.length) return null; // the kit stops with an error here
        tenant = rest[i + 1];
        site = rest[i + 2];
      } else {
        tenant = host.split('.')[0];
        site = rest.length ? rest[0] : '';
      }
      return { system: 'workday', entry: { company: tenant, host, tenant, site, queries: ['engineer', 'analyst', 'data'] } };
    }
    return null;
  }

  // Python ==: dicts compare without regard to key order
  function sameEntry(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) {
      return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameEntry(x, b[i]));
    }
    if (isDict(a) || isDict(b)) {
      if (!isDict(a) || !isDict(b)) return false;
      const ka = Object.keys(a);
      return ka.length === Object.keys(b).length && ka.every((k) => hasOwn(b, k) && sameEntry(a[k], b[k]));
    }
    return a === b;
  }
  /** search with the employer added (a copy) unless it is already there: { search, added }. */
  function addEmployer(search, parsed) {
    const out = JSON.parse(JSON.stringify(search || {}));
    if (!parsed) return { search: out, added: false };
    const { system: kind, entry } = parsed;
    out.employers = isDict(out.employers) ? out.employers : {};
    const current = Array.isArray(out.employers[kind]) ? out.employers[kind] : (out.employers[kind] = []);
    const there = current.some((e) => sameEntry(e, entry)) ||
      (kind === 'workday' && current.some((w) => isDict(w) && w.host === entry.host && w.site === entry.site));
    if (!there) current.push(entry);
    return { search: out, added: !there };
  }

  // ---------- the digest (job_digest.py) ----------

  /** The posting's digest key: the first of its posting keys in sorted order, else its link (job_digest.key). */
  function jobKey(job) {
    const keys = [...postingKeys(job && job.url)].sort(cpCompare);
    return keys.length ? keys[0] : job && job.url;
  }
  const seenHas = (seen) => {
    if (seen instanceof Set) return (k) => seen.has(k);
    if (Array.isArray(seen)) { const s = new Set(seen); return (k) => s.has(k); }
    if (isDict(seen)) return (k) => hasOwn(seen, k);
    return () => false;
  };
  /** Ranked jobs not seen in an earlier digest: { fresh (best first), keys (every ranked job's key, to remember),
   *  older (how many were seen before) }. seenKeys: Set, array or { key: date } (.cache/seen.json). */
  function newSince(ranked, seenKeys) {
    const has = seenHas(seenKeys);
    const jobs = list(ranked);
    const fresh = jobs.filter((j) => !has(jobKey(j)));
    const keys = [...new Set(jobs.map(jobKey))];
    return { fresh, keys, older: jobs.length - fresh.length };
  }
  /** seen.json after a digest: every ranked job's key with the date first seen, forgetting keys first seen
   *  more than keepDays (120) ago (job_digest.save_seen). Returns a new object. */
  function rememberSeen(seen, ranked, today, keepDays = 120) {
    const t = todayIso(today);
    const out = isDict(seen) ? { ...seen } : {};
    for (const j of list(ranked)) { const k = jobKey(j); if (!hasOwn(out, k)) out[k] = t; }
    const cutoff = daysToIso(isoToDays(t) - keepDays);
    for (const k of Object.keys(out)) if (!(String(out[k]) >= cutoff)) delete out[k];
    return out;
  }

  const mdEscape = (s) => pyStrip(String(truthy(s) ? pyStr(s) : '').split('|').join('/').split('\n').join(' '));
  const WEEKDAYS = ['Thursday', 'Friday', 'Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday'];
  const MONTH_NAMES = MONTHS.map((m) => m[0].toUpperCase() + m.slice(1));
  /**
   * The daily digest (job_digest.write_digest): counts, the best new matches, flags worth a look, skill gaps
   * that keep coming up and failed sources, as data and as the kit's markdown.
   * options: { today, older (still-open matches from earlier digests), found (postings searched),
   *            counts (collect().counts), errors (collect().errors), queued (jobs added to the queue),
   *            minScore (default 55), top (default 15) }
   */
  function digest(fresh, options = {}) {
    const t = todayIso(options.today);
    const minScore = options.minScore ?? 55;
    const top = options.top ?? 15;
    const jobs = list(fresh);
    const queued = list(options.queued);
    const errors = list(options.errors);
    const good = jobs.filter((j) => j.score >= minScore);
    const best = jobs.slice(0, top);
    const flagged = best.filter((j) => list(j.flags).length)
      .map((j) => ({ company: j.company, title: j.title, url: j.url, flags: j.flags.map((f) => String(f).split(':')[0]) }));
    const counter = new Map();
    for (const j of jobs.slice(0, Math.max(top, 30))) for (const g of list(j.gaps)) counter.set(g, (counter.get(g) || 0) + 1);
    const gaps = [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const [y, m, d] = t.split('-').map(Number);
    const heading = `${WEEKDAYS[((isoToDays(t) % 7) + 7) % 7]} ${MONTH_NAMES[m - 1]} ${d}, ${y}`;
    const lines = [`# Job digest, ${heading}`, '',
      `${jobs.length} new postings match your tracks (${good.length} score ${minScore} or more). ` +
      `${options.older || 0} matches from earlier digests are still open. ` +
      `Searched ${options.found || 0} postings from ${Object.keys(options.counts || {}).length} sources.`];
    if (queued.length) lines.push('', `Added ${queued.length} to jobs.txt: ` + queued.map((j) => `${j.company} (${j.score})`).join('; ') + '.');
    lines.push('', '## Best new matches', '');
    if (jobs.length) {
      lines.push('| Fit | Role | Company | Location | Posted | Why |', '|---|---|---|---|---|---|');
      for (const j of best) {
        lines.push(`| ${j.score} | [${mdEscape(j.title)}](${j.url}) | ${mdEscape(j.company)} | ` +
          `${cpSlice(mdEscape(j.location), 0, 40)} | ${j.posted || '?'} | ${mdEscape(j.why)} |`);
      }
    } else {
      lines.push('Nothing new today.');
    }
    if (flagged.length) {
      lines.push('', '## Check before applying', '');
      for (const f of flagged) lines.push(`- **${mdEscape(f.company)}, ${mdEscape(f.title)}**: ` + f.flags.join('; '));
    }
    if (gaps.length) {
      lines.push('', '## Skills these postings ask for that your resume does not show', '',
        gaps.map(([g, n]) => `${g} (${n})`).join(', ') + '.',
        'These are never added to a resume. If one keeps coming up, a short course or project could close it.');
    }
    if (errors.length) lines.push('', '## Sources that failed today', '', ...errors.map((e) => `- ${e.source}: ${e.message}`));
    return {
      date: t, newCount: jobs.length, goodCount: good.length, olderCount: options.older || 0, best, flagged,
      gaps, errors, queued, markdown: lines.join('\n') + '\n',
    };
  }

  // ---------- the SimplifyJobs filters (find_internships.py) ----------

  const US_STATES = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
    CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
    IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
    ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
    MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
    NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
    ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
    RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
    UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
    WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia', PR: 'Puerto Rico',
  };
  const STATE_NAMES = Object.fromEntries(Object.entries(US_STATES).map(([k, v]) => [norm(v), k]));
  const US_WORDS = rx(String.raw`\b(usa|u s a|united states|us|nationwide)\b`);
  const US_SHORT = new Set(['nyc', 'sf', 'la', 'south sf', 'dc', 'remote']);
  const ABROAD_WORDS = rx(String.raw`\b(canada|united kingdom|uk|england|scotland|wales|ireland|france|germany|` +
    String.raw`switzerland|netherlands|india|china|japan|singapore|australia|mexico|brazil|israel|` +
    String.raw`spain|italy|poland|sweden|denmark|united arab emirates|uae|hong kong|taiwan|korea)\b`);
  const CITY_ALIASES = { 'new york': 'nyc', 'new york city': 'nyc', 'san francisco': 'sf', 'los angeles': 'la' };
  const CATEGORY_WORDS = {
    'machine learning': 'ml', 'artificial intelligence': 'ai', 'data science': 'data',
    swe: 'software', 'software engineering': 'software', pm: 'product',
    'product management': 'product', quantitative: 'quant', 'quantitative finance': 'quant',
    finance: 'quant', electrical: 'hardware', embedded: 'hardware',
  };
  const DEGREES = [['phd', rx(String.raw`\b(phd|ph d|doctor|doctoral|doctorate)\b`)], ['mba', rx(String.raw`\bmba\b`)],
    ['master', rx(String.raw`\b(master|masters|ms|msc|m s|meng|graduate)\b`)],
    ['associate', rx(String.raw`\b(associate|associates)\b`)],
    ['bachelor', rx(String.raw`\b(bachelor|bachelors|bs|bsc|ba|b s|beng|undergraduate|undergrad)\b`)]];
  const DEFAULT_TERM = 'Summer 2027';

  /** Canonical degree word (phd, mba, master, associate, bachelor) for a degree name, or null. */
  function degreeLevel(value) {
    const s = norm(value);
    for (const [name, re] of DEGREES) if (re.test(s)) return name;
    return null;
  }
  const LOC_SPLIT = /[,\-–]/;
  /** True when a SimplifyJobs-style location is in the U.S. ("Austin, TX", "Remote in USA", "NYC", "California"). */
  function isUsLocation(loc) {
    const raw = pyStrip(truthy(loc) ? pyStr(loc) : '');
    if (!raw) return false;
    const n = norm(raw);
    if (ABROAD_WORDS.test(n)) return false;
    if (US_WORDS.test(n) || US_SHORT.has(n)) return true;
    const parts = raw.split(LOC_SPLIT).map(pyStrip).filter(Boolean);
    const last = parts.length ? parts[parts.length - 1] : raw;
    if (cpLen(last) === 2 && hasOwn(US_STATES, last.toUpperCase())) return true;
    return hasOwn(STATE_NAMES, norm(last)) || hasOwn(STATE_NAMES, n);
  }
  const US_NAMES = new Set(['us', 'usa', 'u s', 'u s a', 'united states', 'united states of america', 'america']);
  const usProfile = (profile) => US_NAMES.has(norm((profile || {}).country));
  const yes = (v) => (typeof v === 'boolean' ? v : ['yes', 'y', 'true', '1'].includes(norm(v)));
  /** profile needsSponsorshipForInternship, else needsSponsorship, else false. */
  function defaultNeedsSponsorship(profile) {
    const p = profile || {};
    for (const k of ['needsSponsorshipForInternship', 'needsSponsorship']) {
      const v = p[k];
      if (typeof v === 'boolean' || norm(v)) return yes(v);
    }
    return false;
  }
  function termOk(listing, term) {
    if (['any', 'all', ''].includes(norm(term))) return true;
    return list(or(listing.terms, [])).some((t) => norm(t) === norm(term));
  }
  function categoryOk(listing, cats) {
    if (!truthy(cats)) return true;
    const have = norm(listing.category);
    const haveWords = new Set(have.split(' ').filter(Boolean));
    for (const c of cats) {
      const q = hasOwn(CATEGORY_WORDS, norm(c)) ? CATEGORY_WORDS[norm(c)] : norm(c);
      if (!q) continue;
      if (have.includes(q) || q.split(' ').filter(Boolean).every((w) => haveWords.has(w))) return true;
      if (q === 'data' && (haveWords.has('ai') || haveWords.has('ml'))) return true;
      if ((q === 'ai' || q === 'ml') && haveWords.has('data')) return true;
    }
    return false;
  }
  const isAlpha = (s) => s.length > 0 && /^\p{L}+$/u.test(s);
  /** Does a location match a wanted place (a state/province code, a city, a state name or "Remote")? */
  function locationMatch(loc, want) {
    loc = String(loc);
    const n = norm(loc);
    const w = pyStrip(want);
    const wn = norm(w);
    if (!wn) return false;
    if (wn === 'remote') return n.includes('remote');
    if (cpLen(w) === 2 && isAlpha(w)) { // a state or province code
      const code = w.toUpperCase();
      if (loc.split(',').slice(1).some((p) => pyStrip(p).toUpperCase() === code)) return true;
      const state = hasOwn(US_STATES, code) ? US_STATES[code] : null;
      return Boolean(state) && (n === norm(state) || n.endsWith(' ' + norm(state)));
    }
    if ((' ' + n + ' ').includes(' ' + wn + ' ')) return true;
    const alias = hasOwn(CITY_ALIASES, wn) ? CITY_ALIASES[wn] : null;
    if (alias && (n === alias || n.startsWith(alias + ' '))) return true;
    if (hasOwn(STATE_NAMES, wn)) return loc.split(',').slice(1).some((p) => pyStrip(p).toUpperCase() === STATE_NAMES[wn]);
    return false;
  }
  function wordsIn(title, words) {
    const t = ' ' + norm(title) + ' ';
    return words.some((w) => norm(w) && t.includes(' ' + norm(w) + ' '));
  }
  // date_posted (else date_updated) as a UTC date, as find_internships._posted reads it
  function listingPosted(listing) {
    const ts = or(listing.date_posted, listing.date_updated);
    let n;
    if (typeof ts === 'number') n = Math.trunc(ts);
    else if (typeof ts === 'boolean') n = ts ? 1 : 0;
    else if (typeof ts === 'string' && /^[+-]?\d+$/.test(pyStrip(asciiDigits(ts)).replace(/_/g, ''))) n = parseInt(pyStrip(asciiDigits(ts)).replace(/_/g, ''), 10);
    else return null;
    const d = new Date(n * 1000);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }

  /**
   * Filter SimplifyJobs listings for the user (find_internships.search). filters: { term, category: [],
   * location: [], keyword: [], excludeKeyword: [], degree, needsSponsorship (true/false; default from the
   * profile), noCitizenship, days, includeAbroad }. context: { today, tracked (tracker rows), queued (links),
   * queuedRoles ("Company | Role" notes as [company, role] pairs) }.
   * -> { results: [{ company, role, location, url, posted, sponsorship, category, terms }] newest first,
   *      skipped: { reason: count }, term }
   */
  function searchInternships(listings, filters = {}, profile = {}, context = {}) {
    const a = filters || {};
    profile = isDict(profile) ? profile : {};
    const today = isoToDays(todayIso(context.today));
    const skipped = {};
    const skip = (r) => { skipped[r] = (skipped[r] || 0) + 1; };
    const term = a.term || pyStrip(or(profile.internshipTerm, '')) || DEFAULT_TERM;
    const needsSp = a.needsSponsorship !== undefined && a.needsSponsorship !== null ? a.needsSponsorship : defaultNeedsSponsorship(profile);
    const usOnly = usProfile(profile) && !a.includeAbroad;
    const wantDegree = a.degree ? degreeLevel(a.degree) : null;
    const tracked = new Set();
    const trackedRoles = new Set();
    for (const r of list(context.tracked)) {
      for (const k of postingKeys(get(r, 'posting_url', get(r, 'url')))) tracked.add(k);
      const rk = roleKey(get(r, 'company'), get(r, 'role'));
      if (rk) trackedRoles.add(rk);
    }
    const queuedKeys = new Set();
    for (const q of list(context.queued)) for (const k of postingKeys(q)) queuedKeys.add(k);
    const queuedRoles = new Set(list(context.queuedRoles).map(([c, r]) => roleKey(c, r)).filter(Boolean));
    const seen = new Set();
    const kept = [];
    const meets = (keys, set) => [...keys].some((k) => set.has(k));
    const str = (v) => (truthy(v) ? pyStr(v) : '');
    for (const x of list(listings)) {
      if (!isDict(x)) continue;
      const url = pyStrip(str(x.url)).split('#')[0];
      const company = pyStrip(str(x.company_name));
      const role = pyStrip(str(x.title));
      let locs = list(or(x.locations, [])).map((l) => pyStrip(pyStr(l))).filter(Boolean);
      const sponsorship = str(x.sponsorship);
      if (!truthy(get(x, 'active', true)) || x.is_visible === false) { skip('closed'); continue; }
      if (!url || url.toLowerCase().includes('linkedin.com')) { skip('linkedin_or_no_link'); continue; }
      if (!termOk(x, term)) { skip('other_term'); continue; }
      if (!categoryOk(x, a.category)) { skip('category'); continue; }
      if (usOnly && locs.length) {
        const us = locs.filter(isUsLocation);
        if (!us.length) { skip('outside_us'); continue; }
        locs = us;
      }
      if (truthy(a.location) && !locs.some((l) => a.location.some((w) => locationMatch(l, w)))) { skip('location'); continue; }
      if (truthy(a.keyword) && !wordsIn(role, a.keyword)) { skip('keyword'); continue; }
      if (truthy(a.excludeKeyword) && wordsIn(role, a.excludeKeyword)) { skip('excluded_keyword'); continue; }
      const degrees = new Set(list(or(x.degrees, [])).map(degreeLevel).filter((d) => d !== null));
      if (wantDegree && degrees.size && !degrees.has(wantDegree)) { skip('degree'); continue; }
      const sp = norm(sponsorship);
      if ((needsSp || a.noCitizenship) && sp.includes('citizenship')) { skip('citizenship_required'); continue; }
      if (needsSp && (sp.includes('does not') || sp.includes('no sponsorship'))) { skip('no_sponsorship'); continue; }
      const posted = listingPosted(x);
      if (a.days !== undefined && a.days !== null && posted && today - isoToDays(posted) > a.days) { skip('too_old'); continue; }
      const keys = postingKeys(url);
      const rk = roleKey(company, role);
      if (meets(keys, tracked) || (rk && trackedRoles.has(rk))) { skip('already_tracked'); continue; }
      if (meets(keys, queuedKeys) || (rk && queuedRoles.has(rk))) { skip('already_in_jobs_txt'); continue; }
      if (meets(keys, seen) || (rk && seen.has(rk))) { skip('duplicate'); continue; }
      for (const k of keys) seen.add(k);
      if (rk) seen.add(rk);
      kept.push({ company, role, location: locs.join('; '), url, posted: posted || '', sponsorship,
        category: or(x.category, ''), terms: or(x.terms, []) });
    }
    kept.sort((p, q) => cpCompare(q.posted, p.posted));
    return { results: kept, skipped, term };
  }

  return {
    SOURCES, ALL_SOURCES, SIMPLIFY, COUNTRIES, DISCOVERY_HOSTS, DISCOVERY_PATHS, SKIP_REASONS, DEFAULT_TERM,
    defaultSources, isAllowedDiscoveryUrl, collect, fetchListings,
    rank, enrich, order, queueable, pickForQueue, queueNote, trackerKeys,
    newSince, jobKey, rememberSeen, digest,
    parseEmployerUrl, addEmployer,
    searchInternships, degreeLevel, isUsLocation, locationMatch, defaultNeedsSponsorship, usProfile,
    postingKeys, roleKey, nameKey, cleanUrl, norm, day, makeJob,
    parseSimplify, parseJobBank, parseGreenhouse, parseLever, parseAshby, parseSmartRecruiters, parseWorkday, parseRemotive,
    DiscoveryError,
    _internals: { pyTitle, parseQsl, urlunsplit, listingPosted, cpCompare },
  };
});
