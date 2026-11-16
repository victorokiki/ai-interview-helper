// Job-posting reader: turns a posting link on a known application system
// (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, iCIMS, Oracle Recruiting
// Cloud, Rippling, Canada's Job Bank) into one posting record: company, role,
// location, deadline, pay, description as plain text, the published
// application questions and what the posting says about a cover letter.
// Port of the Autonomous Job Kit's lib/jobkit/postings.py (MIT, same author):
// same rules, regexes and edge cases. Python regex semantics are kept with
// rx() below (Unicode \b \w \d \s, "." without newline, "$" before a final
// newline).
//
// Pure: no file or network access. fetchPosting() makes every request through
// the fetcher the caller passes in, and only to addresses isAllowedUrl()
// accepts (the app only contacts known job-site addresses; the main process
// enforces the same list, redirects included). Pages from other sites are
// never fetched: parseJsonLd() reads schema.org JobPosting data from HTML the
// caller already has (the browser extension, iCIMS).
// Loads as CommonJS or as a browser global (CorePostings).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CorePostings = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const USER_AGENT = 'Mozilla/5.0 (compatible; InterviewHelper; personal job-search helper reading public job postings)';
  const SYSTEMS = ['greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'icims', 'oracle', 'rippling', 'jobbank'];

  // Hosts fetchPosting() may request. "*." at the start stands for one or more
  // DNS labels; a "*" label elsewhere stands for exactly one label.
  const ALLOWED_HOSTS = Object.freeze([
    'boards-api.greenhouse.io', 'boards-api.eu.greenhouse.io',
    'boards.greenhouse.io', 'boards.eu.greenhouse.io', 'job-boards.greenhouse.io', 'job-boards.eu.greenhouse.io',
    'api.lever.co', 'api.eu.lever.co', 'jobs.lever.co', 'jobs.eu.lever.co',
    'jobs.ashbyhq.com',
    '*.myworkdayjobs.com', '*.myworkdaysite.com', '*.myworkday.com',
    'api.smartrecruiters.com', 'jobs.smartrecruiters.com',
    '*.icims.com',
    '*.fa.oraclecloud.com', '*.fa.*.oraclecloud.com',
    'api.rippling.com', 'ats.rippling.com',
    'www.jobbank.gc.ca',
  ]);

  // ---------- Python compatibility ----------

  const W = '\\p{L}\\p{N}_';
  const S = '\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
  // Python's str.isspace() characters, as code points (two of them end a line in source text)
  const WS_CHARS = String.fromCharCode(9, 10, 11, 12, 13, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001,
    0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000);
  const LINE_BREAKS = new RegExp('\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]');

  // A Python `re` pattern source as a JS RegExp with the same meaning.
  function rx(src, flags = '') {
    const dotAll = flags.includes('s');
    let out = '';
    let inClass = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') {
        const n = src[++i];
        if (n === 'b' && !inClass) out += `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))`;
        else if (n === 'w') out += inClass ? W : `[${W}]`;
        else if (n === 'W' && !inClass) out += `[^${W}]`;
        else if (n === 'd') out += '\\p{Nd}';
        else if (n === 'D') out += '\\P{Nd}';
        else if (n === 's') out += inClass ? S : `[${S}]`;
        else if (n === 'S' && !inClass) out += `[^${S}]`;
        else if (n === 'Z' && !inClass) out += '(?![\\s\\S])';
        else out += '\\' + n;
        continue;
      }
      if (inClass) {
        if (c === ']') inClass = false;
        out += c;
        continue;
      }
      if (c === '[') {
        inClass = true;
        out += c;
        if (src[i + 1] === '^') { out += '^'; i++; }
        if (src[i + 1] === ']') { out += '\\]'; i++; }
      } else if (c === '.' && !dotAll) out += '[^\\n]';
      else if (c === '$') out += '(?=\\n?(?![\\s\\S]))';
      else out += c;
    }
    return new RegExp(out, flags + 'u');
  }
  const rxCache = new Map();
  function R(src, flags = '') {
    const key = flags + '\u0000' + src;
    let r = rxCache.get(key);
    if (!r) { r = rx(src, flags); rxCache.set(key, r); }
    r.lastIndex = 0;
    return r;
  }
  const search = (src, s, flags = '') => R(src, flags.replace('g', '')).exec(s);
  const match = (src, s, flags = '') => R('^(?:' + src + ')', flags.replace('g', '')).exec(s);
  const fullmatch = (src, s, flags = '') => R('^(?:' + src + ')\\Z', flags.replace('g', '')).exec(s);
  const sub = (src, repl, s, flags = '') => s.replace(R(src, flags.includes('g') ? flags : flags + 'g'), repl);
  const finditer = (src, s, flags = '') => Array.from(s.matchAll(R(src, flags.includes('g') ? flags : flags + 'g')));
  const findall = (src, s, flags = '') => finditer(src, s, flags).map((m) => (m.length > 1 ? m[1] ?? '' : m[0]));

  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isDict = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  function pyType(x) {
    if (x === null || x === undefined) return 'NoneType';
    if (Array.isArray(x)) return 'list';
    if (typeof x === 'string') return 'str';
    if (typeof x === 'number') return Number.isInteger(x) ? 'int' : 'float';
    if (typeof x === 'boolean') return 'bool';
    return 'dict';
  }
  function truthy(x) {
    if (x === null || x === undefined || x === false || x === 0 || x === '') return false;
    if (Array.isArray(x)) return x.length > 0;
    if (typeof x === 'object') return Object.keys(x).length > 0;
    return true;
  }
  // Python's `a or b or c`
  function or(...xs) {
    for (const x of xs) if (truthy(x)) return x;
    return xs[xs.length - 1];
  }
  // Python's dict.get (raises on a non-dict, like Python's AttributeError)
  function get(o, k, dflt) {
    if (!isDict(o)) throw new TypeError(`'${pyType(o)}' object has no attribute 'get'`);
    return hasOwn(o, k) && o[k] !== undefined ? o[k] : dflt;
  }
  const pick = (map, k, dflt) => (typeof k === 'string' && hasOwn(map, k) ? map[k] : dflt);
  // Python's iteration over a value
  function iter(x) {
    if (Array.isArray(x)) return x;
    if (typeof x === 'string') return Array.from(x);
    if (isDict(x)) return Object.keys(x);
    throw new TypeError(`'${pyType(x)}' object is not iterable`);
  }
  // Python's str()
  function pyStr(x) {
    if (x === null || x === undefined) return 'None';
    if (x === true) return 'True';
    if (x === false) return 'False';
    if (typeof x === 'string') return x;
    if (typeof x === 'number') {
      if (Number.isNaN(x)) return 'nan';
      if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
      return String(x);
    }
    return JSON.stringify(x);
  }
  function needStr(s) {
    if (typeof s !== 'string') throw new TypeError(`'${pyType(s)}' object has no attribute 'strip'`);
    return s;
  }
  function charSet(chars) {
    return chars === undefined ? WS_CHARS : chars;
  }
  function lstrip(s, chars) {
    needStr(s);
    const set = charSet(chars);
    let i = 0;
    while (i < s.length && set.includes(s[i])) i++;
    return s.slice(i);
  }
  function rstrip(s, chars) {
    needStr(s);
    const set = charSet(chars);
    let j = s.length;
    while (j > 0 && set.includes(s[j - 1])) j--;
    return s.slice(0, j);
  }
  const strip = (s, chars) => lstrip(rstrip(s, chars), chars);
  function splitlines(s) {
    if (s === '') return [];
    const parts = s.split(LINE_BREAKS);
    if (parts[parts.length - 1] === '') parts.pop();
    return parts;
  }
  const cut = (s, n) => Array.from(s).slice(0, n).join('');
  const plen = (s) => Array.from(s).length;
  function title(s) {
    let out = '';
    let prev = false;
    for (const ch of s) {
      const cased = /[\p{Lu}\p{Ll}\p{Lt}]/u.test(ch);
      out += cased ? (prev ? ch.toLowerCase() : ch.toUpperCase()) : ch;
      prev = cased;
    }
    return out;
  }
  function commas(intDigits) {
    return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  // f'{x:,.0f}' (round half to even, like Python)
  function fmt0(x) {
    let r = Math.round(x);
    if (Math.abs(x % 1) === 0.5) r = 2 * Math.round(x / 2);
    const neg = r < 0 || Object.is(r, -0) ? '-' : '';
    return neg + commas(String(Math.abs(r)));
  }
  // f'{x:,}' for an int or float
  function fmtComma(x) {
    if (typeof x === 'boolean') x = x ? 1 : 0;
    if (typeof x !== 'number') throw new TypeError(`unsupported format string passed to ${pyType(x)}.__format__`);
    if (!Number.isFinite(x)) return pyStr(x);
    const s = String(Math.abs(x));
    if (/e/i.test(s)) return (x < 0 ? '-' : '') + s;
    const [a, b] = s.split('.');
    return (x < 0 ? '-' : '') + commas(a) + (b !== undefined ? '.' + b : '');
  }

  // ---- URLs, the way Python's urllib.parse splits them ----

  function urlsplit(url) {
    let s = String(url).replace(/^[\x00-\x20]+/, '').replace(/[\t\r\n]/g, '');
    let scheme = '';
    let netloc = '';
    let query = '';
    let fragment = '';
    const m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(s);
    if (m) { scheme = m[1].toLowerCase(); s = s.slice(m[0].length); }
    if (s.startsWith('//')) {
      const r = s.slice(2);
      const i = r.search(/[/?#]/);
      netloc = i < 0 ? r : r.slice(0, i);
      s = i < 0 ? '' : r.slice(i);
    }
    let i = s.indexOf('#');
    if (i >= 0) { fragment = s.slice(i + 1); s = s.slice(0, i); }
    i = s.indexOf('?');
    if (i >= 0) { query = s.slice(i + 1); s = s.slice(0, i); }
    return { scheme, netloc, path: s, query, fragment };
  }
  function utf8Decode(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    try {
      return decodeURIComponent(Array.from(bytes, (b) => '%' + b.toString(16).padStart(2, '0')).join(''));
    } catch {
      return Array.from(bytes, (b) => String.fromCharCode(b)).join('');
    }
  }
  function unquote(s) {
    if (!s.includes('%')) return s;
    return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => {
      const bytes = new Uint8Array(m.length / 3);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(m.substr(i * 3 + 1, 2), 16);
      return utf8Decode(bytes);
    });
  }
  function utf8Bytes(ch) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(ch));
    return Array.from(unescape(encodeURIComponent(ch)), (c) => c.charCodeAt(0)); // eslint-disable-line no-undef
  }
  function quote(s, safe = '/') {
    let out = '';
    for (const ch of s) {
      if (/[A-Za-z0-9_.~-]/.test(ch) || safe.includes(ch)) out += ch;
      else out += utf8Bytes(ch).map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('');
    }
    return out;
  }
  const quotePlus = (s) => (s.includes(' ') ? quote(s, ' ').replace(/ /g, '+') : quote(s, ''));
  // dict(urllib.parse.parse_qsl(query)): blank values dropped, last value wins, first-seen order kept
  function parseQs(query) {
    const out = new Map();
    for (const nv of query.split('&')) {
      if (!nv) continue;
      const j = nv.indexOf('=');
      if (j < 0) continue;
      const k = nv.slice(0, j);
      const v = nv.slice(j + 1);
      if (v.length) out.set(unquote(k.replace(/\+/g, ' ')), unquote(v.replace(/\+/g, ' ')));
    }
    return out;
  }
  const urlencode = (q) => Array.from(q, ([k, v]) => quotePlus(String(k)) + '=' + quotePlus(String(v))).join('&');
  const hostOf = (url) => urlsplit(url).netloc.toLowerCase();

  function hostMatches(host, pattern) {
    const h = host.split('.');
    const p = pattern.split('.');
    const label = (l) => /^[a-z0-9_-]+$/.test(l);
    const same = (a, b) => a.length === b.length && a.every((l, i) => (b[i] === '*' ? label(l) : l === b[i]));
    if (p[0] === '*') {
      const rest = p.slice(1);
      if (h.length < rest.length + 1) return false;
      return h.slice(0, h.length - rest.length).every(label) && same(h.slice(h.length - rest.length), rest);
    }
    return same(h, p);
  }

  // True only for an https address on a host this module requests (ALLOWED_HOSTS).
  function isAllowedUrl(url) {
    let u;
    try {
      u = new URL(String(url));
    } catch {
      return false;
    }
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
    const host = u.hostname.toLowerCase();
    if (!host || host.endsWith('.') || host.startsWith('[') || /^[0-9.]+$/.test(host) || /^0x/i.test(host)) return false;
    return ALLOWED_HOSTS.some((p) => hostMatches(host, p));
  }

  // ---- html.unescape ----

  const ENTITY_LIST =
    'quot:34 amp:38 lt:60 gt:62 apos:39 nbsp:160 iexcl:161 cent:162 pound:163 curren:164 yen:165 brvbar:166 sect:167 ' +
    'uml:168 copy:169 ordf:170 laquo:171 not:172 shy:173 reg:174 macr:175 deg:176 plusmn:177 sup2:178 sup3:179 acute:180 ' +
    'micro:181 para:182 middot:183 cedil:184 sup1:185 ordm:186 raquo:187 frac14:188 frac12:189 frac34:190 iquest:191 ' +
    'Agrave:192 Aacute:193 Acirc:194 Atilde:195 Auml:196 Aring:197 AElig:198 Ccedil:199 Egrave:200 Eacute:201 Ecirc:202 ' +
    'Euml:203 Igrave:204 Iacute:205 Icirc:206 Iuml:207 ETH:208 Ntilde:209 Ograve:210 Oacute:211 Ocirc:212 Otilde:213 ' +
    'Ouml:214 times:215 Oslash:216 Ugrave:217 Uacute:218 Ucirc:219 Uuml:220 Yacute:221 THORN:222 szlig:223 agrave:224 ' +
    'aacute:225 acirc:226 atilde:227 auml:228 aring:229 aelig:230 ccedil:231 egrave:232 eacute:233 ecirc:234 euml:235 ' +
    'igrave:236 iacute:237 icirc:238 iuml:239 eth:240 ntilde:241 ograve:242 oacute:243 ocirc:244 otilde:245 ouml:246 ' +
    'divide:247 oslash:248 ugrave:249 uacute:250 ucirc:251 uuml:252 yacute:253 thorn:254 yuml:255 AMP:38 COPY:169 GT:62 ' +
    'LT:60 QUOT:34 REG:174 OElig:338 oelig:339 Scaron:352 scaron:353 Yuml:376 fnof:402 circ:710 tilde:732 Alpha:913 ' +
    'Beta:914 Gamma:915 Delta:916 Epsilon:917 Zeta:918 Eta:919 Theta:920 Iota:921 Kappa:922 Lambda:923 Mu:924 Nu:925 ' +
    'Xi:926 Omicron:927 Pi:928 Rho:929 Sigma:931 Tau:932 Upsilon:933 Phi:934 Chi:935 Psi:936 Omega:937 alpha:945 beta:946 ' +
    'gamma:947 delta:948 epsilon:949 zeta:950 eta:951 theta:952 iota:953 kappa:954 lambda:955 mu:956 nu:957 xi:958 ' +
    'omicron:959 pi:960 rho:961 sigmaf:962 sigma:963 tau:964 upsilon:965 phi:966 chi:967 psi:968 omega:969 thetasym:977 ' +
    'upsih:978 piv:982 ensp:8194 emsp:8195 thinsp:8201 zwnj:8204 zwj:8205 lrm:8206 rlm:8207 hyphen:8208 dash:8208 ' +
    'ndash:8211 mdash:8212 lsquo:8216 rsquo:8217 sbquo:8218 ldquo:8220 rdquo:8221 bdquo:8222 dagger:8224 Dagger:8225 ' +
    'bull:8226 bullet:8226 hellip:8230 permil:8240 prime:8242 Prime:8243 lsaquo:8249 rsaquo:8250 oline:8254 frasl:8260 ' +
    'euro:8364 image:8465 weierp:8472 real:8476 trade:8482 alefsym:8501 larr:8592 uarr:8593 rarr:8594 darr:8595 ' +
    'harr:8596 crarr:8629 lArr:8656 uArr:8657 rArr:8658 dArr:8659 hArr:8660 forall:8704 part:8706 exist:8707 empty:8709 ' +
    'nabla:8711 isin:8712 notin:8713 ni:8715 prod:8719 sum:8721 minus:8722 lowast:8727 radic:8730 prop:8733 infin:8734 ' +
    'ang:8736 and:8743 or:8744 cap:8745 cup:8746 int:8747 there4:8756 sim:8764 cong:8773 asymp:8776 ne:8800 equiv:8801 ' +
    'le:8804 ge:8805 sub:8834 sup:8835 nsub:8836 sube:8838 supe:8839 oplus:8853 otimes:8855 perp:8869 sdot:8901 ' +
    'lceil:8968 rceil:8969 lfloor:8970 rfloor:8971 lang:10216 rang:10217 loz:9674 spades:9824 clubs:9827 hearts:9829 ' +
    'diams:9830 Tab:9 NewLine:10 excl:33 num:35 dollar:36 percnt:37 lpar:40 rpar:41 ast:42 plus:43 comma:44 period:46 ' +
    'sol:47 colon:58 semi:59 equals:61 quest:63 commat:64 lsqb:91 lbrack:91 bsol:92 rsqb:93 rbrack:93 Hat:94 lowbar:95 ' +
    'grave:96 lcub:123 lbrace:123 verbar:124 vert:124 rcub:125 rbrace:125 half:189 centerdot:183 check:10003 ' +
    'cross:10007 star:9734 starf:9733 nbsp:160';
  // Names HTML5 also accepts without the semicolon (the Latin-1 set and six capitals).
  const LEGACY = new Set(('AElig AMP Aacute Acirc Agrave Aring Atilde Auml COPY Ccedil ETH Eacute Ecirc Egrave Euml GT ' +
    'Iacute Icirc Igrave Iuml LT Ntilde Oacute Ocirc Ograve Oslash Otilde Ouml QUOT REG THORN Uacute Ucirc Ugrave Uuml ' +
    'Yacute aacute acirc acute aelig agrave amp aring atilde auml brvbar ccedil cedil cent copy curren deg divide eacute ' +
    'ecirc egrave eth euml frac12 frac14 frac34 gt iacute icirc iexcl igrave iquest iuml laquo lt macr micro middot ' +
    'nbsp not ntilde oacute ocirc ograve ordf ordm oslash otilde ouml para plusmn pound quot raquo reg sect shy sup1 ' +
    'sup2 sup3 szlig thorn times uacute ucirc ugrave uml uuml yacute yen yuml').split(' '));
  const ENTITIES = Object.create(null);
  for (const pair of ENTITY_LIST.split(' ')) {
    const [name, code] = pair.split(':');
    ENTITIES[name + ';'] = String.fromCodePoint(Number(code));
    if (LEGACY.has(name)) ENTITIES[name] = String.fromCodePoint(Number(code));
  }
  const INVALID_CHARREFS = {
    0x00: '�', 0x0d: '\r', 0x80: '€', 0x81: '\x81', 0x82: '‚', 0x83: 'ƒ', 0x84: '„',
    0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹',
    0x8c: 'Œ', 0x8d: '\x8d', 0x8e: 'Ž', 0x8f: '\x8f', 0x90: '\x90', 0x91: '‘', 0x92: '’',
    0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™',
    0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9d: '\x9d', 0x9e: 'ž', 0x9f: 'Ÿ',
  };
  const invalidCodepoint = (n) => (n >= 0x1 && n <= 0x8) || n === 0xb || (n >= 0xe && n <= 0x1f) ||
    (n >= 0x7f && n <= 0x9f) || (n >= 0xfdd0 && n <= 0xfdef) || (n & 0xfffe) === 0xfffe;
  const CHARREF = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/g;
  function unescapeHtml(s) {
    s = String(s);
    if (!s.includes('&')) return s;
    return s.replace(CHARREF, (all, ref) => {
      if (ref[0] === '#') {
        const hex = ref[1] === 'x' || ref[1] === 'X';
        const digits = ref.slice(hex ? 2 : 1).replace(/;$/, '');
        const num = hex ? parseInt(digits, 16) : parseInt(digits, 10);
        if (hasOwn(INVALID_CHARREFS, num)) return INVALID_CHARREFS[num];
        if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return '�';
        if (invalidCodepoint(num)) return '';
        return String.fromCodePoint(num);
      }
      if (ref in ENTITIES) return ENTITIES[ref];
      for (let x = ref.length - 1; x > 1; x--) {
        if (ref.slice(0, x) in ENTITIES) return ENTITIES[ref.slice(0, x)] + ref.slice(x);
      }
      return '&' + ref;
    });
  }

  // ---- text.py ----

  function htmlToText(s) {
    s = unescapeHtml(truthy(s) ? pyStr(s) : '');
    s = sub('<(script|style)[^>]*>.*?</\\1>', ' ', s, 'is');
    s = sub('<br\\s*/?>|</(p|div|li|h[1-6]|tr|ul|ol)>', '\n', s, 'i');
    s = sub('<li[^>]*>', '- ', s, 'i');
    s = sub('<[^>]+>', ' ', s);
    s = unescapeHtml(s);
    const lines = splitlines(s).map((l) => strip(sub('[ \\t\\xa0]+', ' ', l)));
    return strip(sub('\\n{3,}', '\n\n', lines.join('\n')));
  }
  const norm = (text) => strip(sub('\\s+', ' ', sub('[^a-z0-9]+', ' ', (truthy(text) ? pyStr(text) : '').toLowerCase())));

  // ---------- the posting record ----------

  function newPosting(url, system = 'other') {
    return {
      url, system, company: '', role: '', location: '', deadline: '', pay: '', posted: '', description: '',
      questions: [], form_published: false, cover_letter_field: null, cover_letter_note: '', check_company: false,
    };
  }

  class FetchError extends Error {
    constructor(message, kind = 'http', status = null) {
      super(message);
      this.kind = kind;
      this.status = status;
    }
  }

  const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

  // [system, info] as postings.detect() gives them, 'linkedin' and 'other' included.
  function classify(url) {
    const u = urlsplit(strip(truthy(url) ? pyStr(url) : ''));
    const host = u.netloc.toLowerCase();
    const path = u.path;
    const q = parseQs(u.query);
    const seg = path.split('/').filter((s) => s);
    if (host.includes('linkedin.') || host === 'lnkd.in') return ['linkedin', {}];
    if (host.includes('greenhouse.io') || truthy(q.get('gh_jid'))) {
      const info = { eu: host.includes('.eu.'), board: q.get('for') ?? null, id: q.get('gh_jid') ?? q.get('token') ?? null };
      if (host.includes('greenhouse.io')) {
        const m = search('/(?:v1/boards/)?([\\w.-]+)/jobs/(\\d+)', path);
        if (m && m[1] !== 'embed') { info.board = m[1]; info.id = m[2]; }
      }
      return ['greenhouse', info];
    }
    if (host.endsWith('lever.co')) {
      const m = search('/([\\w.-]+)/(' + UUID + ')', path, 'i');
      return ['lever', { eu: host.includes('.eu.'), company: m ? m[1] : (seg[0] ?? ''), id: m ? m[2].toLowerCase() : '' }];
    }
    if (host.endsWith('ashbyhq.com')) {
      const m = search('/([^/]+)/(' + UUID + ')', path, 'i');
      return ['ashby', { org: m ? unquote(m[1]) : (seg[0] ?? ''), id: m ? m[2].toLowerCase() : '' }];
    }
    if (host.includes('myworkdayjobs.com') || host.includes('myworkdaysite.com') || host.includes('myworkday.com')) {
      let tenant = '';
      let rest = seg.slice();
      if (rest.length && fullmatch('[a-z]{2}(-[A-Za-z]{2})?', rest[0])) rest = rest.slice(1);
      if (host.includes('myworkdaysite.com') || (rest.length && rest[0] === 'recruiting')) {
        if (rest.length && rest[0] === 'recruiting') rest = rest.slice(1);
        if (rest.length) { tenant = rest[0]; rest = rest.slice(1); } else { tenant = ''; rest = []; }
      } else {
        tenant = host.split('.')[0];
      }
      if (rest.length && (rest[0] === 'wday' || rest[0] === 'cxs')) {
        rest = rest.filter((r) => r !== 'wday' && r !== 'cxs');
        if (rest.length && rest[0] === tenant) rest = rest.slice(1);
      }
      const site = rest.length ? rest[0] : '';
      const tail = rest.slice(1).reverse();
      const found = tail.find((s) => search('_[A-Za-z0-9-]*\\d', s));
      const slug = found !== undefined ? found : (rest.length > 1 ? rest[rest.length - 1] : '');
      return ['workday', { base: `${u.scheme || 'https'}://${u.netloc}`, tenant, site, slug }];
    }
    if (host.includes('smartrecruiters.com')) {
      const m = search('/([^/]+)/(\\d{6,})', path);
      return ['smartrecruiters', { company: m ? m[1] : '', id: m ? m[2] : '' }];
    }
    if (host.endsWith('icims.com')) return ['icims', {}];
    if (host.includes('oraclecloud.com')) {
      const m = search('/sites/([^/]+)/(?:job|requisitions/preview)/(\\d+)', path);
      return ['oracle', { host: u.netloc, site: m ? m[1] : '', id: m ? m[2] : '' }];
    }
    if (host.includes('rippling.com') && (host.includes('ats.') || path.includes('/jobs/'))) {
      const m = search('/([^/]+)/jobs/(' + UUID + ')', path, 'i');
      return ['rippling', { board: m ? m[1] : '', id: m ? m[2] : '' }];
    }
    if (host.includes('jobbank.gc.ca') || host.includes('guichetemplois.gc.ca')) {
      const m = search('/jobposting/(\\d+)', path);
      return ['jobbank', { id: m ? m[1] : '' }];
    }
    return ['other', {}];
  }

  // { system, ...info } for a supported posting link, or null (LinkedIn and other sites).
  function detect(url) {
    const [system, info] = classify(url);
    return SYSTEMS.includes(system) ? { system, ...info } : null;
  }

  // ---------- shared helpers ----------

  function cleanText(s) {
    const lines = splitlines(htmlToText(s));
    const out = [];
    let i = 0;
    while (i < lines.length) {
      let line = strip(lines[i].replace(/\xa0/g, ' '));
      if (line === '-' || line === '•' || line === '*') {
        let j = i + 1;
        while (j < lines.length && !strip(lines[j])) j++;
        if (j < lines.length) {
          out.push('- ' + strip(lines[j]));
          i = j + 1;
          continue;
        }
        i++;
        continue;
      }
      line = line.replace(R('^[•●▪·]\\s*'), '- ');
      out.push(line);
      i++;
    }
    return strip(sub('\\n{3,}', '\n\n', out.join('\n')));
  }

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  function ymd(y, m, d) {
    if (!(m >= 1 && m <= 12 && d >= 1 && y >= 1 && y <= 9999)) return '';
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    if (d > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]) return '';
    return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
  }
  function strptimeBdY(mon, day, year) {
    const m = MONTHS.indexOf(mon.toLowerCase()) + 1;
    if (!m || !/^\d{1,2}$/.test(day)) return '';
    return ymd(Number(year), m, Number(day));
  }
  function fromEpochMs(ms) {
    if (!Number.isFinite(ms)) return '';
    const t = new Date(ms);
    if (Number.isNaN(t.getTime())) return '';
    const y = t.getUTCFullYear();
    if (y < 1 || y > 9999) return '';
    return `${pad(y, 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  }

  // 'YYYY-MM-DD' from an ISO string, epoch milliseconds, or text like 'November 13, 2026'; '' when unknown.
  function isoDate(value) {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'number' || typeof value === 'boolean') return fromEpochMs(Math.trunc(Number(value)));
    if (typeof value === 'string' && /^[0-9]+$/.test(value) && value.length >= 12) return fromEpochMs(Number(value));
    const s = strip(pyStr(value));
    let m = search('(\\d{4})-(\\d{2})-(\\d{2})', s);
    if (m) return m[0];
    m = search('([A-Za-z]{3,9})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})', s);
    if (m) {
      const d = strptimeBdY(m[1].slice(0, 3), m[2], m[3]);
      if (d) return d;
    }
    m = search('(\\d{1,2})\\s+([A-Za-z]{3,9})\\.?,?\\s+(\\d{4})', s);
    if (m) {
      const d = strptimeBdY(m[2].slice(0, 3), m[1], m[3]);
      if (d) return d;
    }
    return '';
  }

  function todayParts() {
    const t = new Date();
    return [t.getFullYear(), t.getMonth() + 1, t.getDate()];
  }
  const dayNumber = (y, m, d) => Date.UTC(y, m - 1, d) / 86400000;
  function todayIso(offsetDays = 0) {
    const [y, m, d] = todayParts();
    const t = new Date(Date.UTC(y, m - 1, d - offsetDays));
    return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  }

  // Listing end dates far in the future are automatic expiry dates, not deadlines.
  function realDeadline(value) {
    const d = isoDate(value);
    if (!d) return '';
    const [y, m, dd] = d.split('-').map(Number);
    if (!ymd(y, m, dd)) return '';
    const days = dayNumber(y, m, dd) - dayNumber(...todayParts());
    return days >= -30 && days <= 180 ? d : '';
  }

  const PAY = '(?:(?:CA|US|C|A)?[$£€]|\\b(?:CAD|USD|GBP|EUR)\\s?)\\s?\\d[\\d,]*(?:\\.\\d+)?\\s?[kK]?' +
    '(?:\\s?(?:-|–|—|to)\\s?(?:(?:CA|US|C)?[$£€]|(?:CAD|USD|GBP|EUR)\\s?)?\\s?\\d[\\d,]*(?:\\.\\d+)?\\s?[kK]?)?' +
    '(?:\\s?(?:CAD|USD|GBP|EUR))?(?:\\s?(?:/|per|an|a)\\s?(?:hour|hr|year|yr|annum|month|week|day))?';
  const PAY_WORDS = '\\b(?:salary|pay|compensation|wage|rate|base|stipend|range|hourly|annual|per\\s+(?:hour|year))\\b';

  // A pay range or rate quoted in a description, or ''. Ignores money that isn't pay (e.g. "$275B in spend").
  function payFromText(text) {
    for (const line of splitlines(truthy(text) ? pyStr(text) : '')) {
      for (const m of finditer(PAY, line, 'i')) {
        const s = strip(m[0]);
        const end = m.index + m[0].length;
        const ranged = !!search('\\d\\s?[kK]?\\s?(?:-|–|—|to)\\s?\\D{0,4}\\d', s);
        const unit = !!search('(?:/|per|an|a)\\s?(?:hour|hr|year|yr|annum|month|week|day)$', s, 'i');
        if (search('\\d\\s?[bBmM]\\b', line.slice(end, end + 3)) && !unit) continue;
        if (ranged || unit || search(PAY_WORDS, line, 'i')) {
          if (fullmatch('\\D*\\d{1,3}\\D*', s) && !unit) continue; // "$5" alone: too small to be a salary
          if (!search('[1-9]', s)) continue; // "$0.00 - $0.00": a blank pay field
          return s;
        }
      }
    }
    return '';
  }

  const DEADLINE = '\\b(?:deadline|apply\\s+by|applications?\\s+(?:will\\s+)?(?:close|closes|are\\s+due|due|must\\s+be\\s+received)|' +
    'closing\\s+date|accepting\\s+applications\\s+(?:until|through)|submit\\s+(?:your\\s+application\\s+)?by|' +
    'posting\\s+(?:closes|ends))\\b[^.\\n]{0,80}';
  const DATEISH = '\\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s+\\d{1,2}|\\b\\d{1,2}\\s+(?:jan|feb|mar|apr|' +
    'may|jun|jul|aug|sep|oct|nov|dec)|\\d{4}-\\d{2}-\\d{2}|\\b\\d{1,2}/\\d{1,2}/\\d{2,4}';

  function deadlineFromText(text) {
    for (const m of finditer(DEADLINE, truthy(text) ? pyStr(text) : '', 'i')) {
      if (search(DATEISH, m[0], 'i')) return strip(sub('\\s+', ' ', m[0]), ' :-');
    }
    return '';
  }

  const place = (...parts) => parts.map((x) => strip(truthy(x) ? pyStr(x) : '')).filter((p) => p).join(', ');
  function workplace(value) {
    const v = norm(value).replace(/ /g, '');
    return pick({ onsite: 'on-site', hybrid: 'hybrid', remote: 'remote', telecommute: 'remote' }, v, '');
  }
  function withMode(location, mode) {
    if (mode && !location.toLowerCase().includes(mode)) return location ? `${location} (${mode})` : mode;
    return location;
  }

  const YESNO = new Set(['yes', 'no']);
  function question(label, required, qtype, options) {
    const opts = iter(or(options, [])).map((o) => strip(pyStr(o))).filter((o) => o);
    if (qtype === 'select' && opts.length && (opts.every((o) => YESNO.has(o.toLowerCase())) ||
        (opts.length === 2 && match('yes\\b', opts[0], 'i') && match('no\\b', opts[1], 'i')))) {
      qtype = 'yes/no';
    }
    return { label: strip(sub('\\s+', ' ', htmlToText(label))), required: truthy(required), type: qtype, options: opts };
  }

  function coverField(p) {
    for (const q of p.questions) {
      if (search('cover\\s*letter|letter\\s+of\\s+(?:interest|motivation)|motivation\\s+letter', q.label, 'i')) {
        p.cover_letter_field = q.required ? 'required' : 'optional';
        return;
      }
    }
  }

  // ---------- network, through the injected fetcher ----------

  const isTimeout = (e) => !!e && (e.name === 'TimeoutError' || e.code === 'ETIMEDOUT' || e.code === 'timeout' ||
    /timed?\s*out/i.test(String(e.message || '')));

  function makeNet(fetcher, opts = {}) {
    if (typeof fetcher !== 'function') throw new TypeError('fetchPosting needs a fetcher function');
    const delayMs = opts.delayMs ?? 1000;
    const retryDelayMs = opts.retryDelayMs ?? 2000;
    const last = new Map();
    const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
    async function pause(host) {
      const wait = (last.has(host) ? last.get(host) : -Infinity) + delayMs - Date.now();
      if (wait > 0) await sleep(wait);
      last.set(host, Date.now());
    }
    function blocked(url, host) {
      const e = new FetchError(`${host || 'this address'} is not one of the job-site addresses the app contacts`, 'blocked');
      e.url = url;
      return e;
    }
    async function request(url, { accept = 'application/json', data, headers, follow = true } = {}) {
      const host = hostOf(url);
      if (!isAllowedUrl(url)) throw blocked(url, host);
      const h = { 'User-Agent': USER_AGENT, Accept: accept, 'Accept-Language': 'en-CA,en;q=0.9', ...(headers || {}) };
      let body;
      if (data !== undefined && data !== null) {
        body = JSON.stringify(data);
        h['Content-Type'] = 'application/json';
      }
      const method = body ? 'POST' : 'GET';
      for (const attempt of [1, 2]) {
        await pause(host);
        let res;
        try {
          res = await fetcher(url, body ? { method, headers: h, body } : { method, headers: h });
        } catch (e) {
          if (e && e.code === 'blocked') {
            const b = blocked(e.url || url, hostOf(e.url || url));
            b.message = e.message || b.message;
            throw b;
          }
          if (attempt === 1 && isTimeout(e)) continue;
          throw new FetchError(`could not connect to ${host}: ${(e && e.message) || e}`, 'network');
        }
        res = res || {};
        const status = Number(res.status) || 0;
        const rh = {};
        for (const [k, v] of Object.entries(res.headers || {})) rh[k.toLowerCase()] = v;
        const finalUrl = typeof res.url === 'string' && res.url ? res.url : url;
        if (finalUrl !== url && !isAllowedUrl(finalUrl)) throw blocked(finalUrl, hostOf(finalUrl));
        if (!follow && [301, 302, 303, 307, 308].includes(status)) return { status, headers: rh, text: '', url: finalUrl };
        if (status >= 200 && status < 300) return { status, headers: rh, text: res.text == null ? '' : String(res.text), url: finalUrl };
        if ([429, 500, 502, 503, 504].includes(status) && attempt === 1) {
          await sleep(retryDelayMs);
          continue;
        }
        throw new FetchError(`${host} answered HTTP ${status}`, status === 404 || status === 410 ? 'notfound' : 'http', status);
      }
      throw new FetchError(`${host} did not answer`, 'network');
    }
    return {
      request,
      async json(url, data) {
        const { text } = await request(url, { data });
        try {
          return JSON.parse(text);
        } catch {
          throw new FetchError(`${hostOf(url)} did not return JSON`, 'parse');
        }
      },
      async html(url) {
        return (await request(url, { accept: 'text/html,application/xhtml+xml' })).text;
      },
      // Where a link redirects to: the Location header when the fetcher hands back the redirect itself,
      // otherwise the final address after redirects (or, when a redirect was refused, the refused address).
      async location(url) {
        try {
          const r = await request(url, { accept: 'text/html', follow: false });
          if (r.headers.location) return String(r.headers.location);
          return r.url !== url ? r.url : null;
        } catch (e) {
          if (e instanceof FetchError && e.kind === 'blocked' && e.url && e.url !== url) return e.url;
          throw e;
        }
      },
    };
  }

  // ---------- Greenhouse ----------

  const GH_TYPES = {
    input_text: 'text', textarea: 'textarea', input_file: 'file', multi_value_single_select: 'select',
    multi_value_multi_select: 'multi', boolean: 'yes/no',
  };

  async function greenhouseBoard(info, url, f) {
    if (truthy(info.board)) return info.board;
    if (truthy(info.id)) {
      try {
        const loc = (await f.location(`https://boards.greenhouse.io/embed/job_app?token=${info.id}`)) || '';
        const m = search('[?&]for=([\\w.-]+)', loc) || search('greenhouse\\.io/([\\w.-]+)/jobs/', loc);
        if (m) return m[1];
      } catch (e) {
        if (!(e instanceof FetchError) || e.kind === 'network') throw e;
      }
    }
    // The Python version reads the company's own page here; the app only does that on job-site addresses.
    if (!isAllowedUrl(url)) return '';
    try {
      const page = await f.html(url);
      const m = search('greenhouse\\.io/embed/job_board/js\\?for=([\\w.-]+)', page) ||
        search('(?:job-)?boards(?:\\.eu)?\\.greenhouse\\.io/([\\w.-]+)', page);
      if (m && m[1] !== 'embed' && m[1] !== 'v1') return m[1];
    } catch (e) {
      if (!(e instanceof FetchError) || e.kind === 'network') throw e;
    }
    return '';
  }

  async function fetchGreenhouse(url, info, f) {
    const p = newPosting(url, 'greenhouse');
    const board = await greenhouseBoard(info, url, f);
    if (!board && truthy(info.id) && !isAllowedUrl(url)) throw new FetchError('greenhouse-company-page', 'unsupported');
    if (!board || !truthy(info.id)) throw new FetchError('could not tell which Greenhouse board this job belongs to', 'parse');
    const bases = info.eu ? ['https://boards-api.eu.greenhouse.io', 'https://boards-api.greenhouse.io']
      : ['https://boards-api.greenhouse.io', 'https://boards-api.eu.greenhouse.io'];
    let d = null;
    let lastErr = null;
    for (const base of bases) {
      try {
        d = await f.json(`${base}/v1/boards/${board}/jobs/${info.id}?questions=true&pay_transparency=true`);
        break;
      } catch (e) {
        lastErr = e;
        if (!(e instanceof FetchError) || e.kind !== 'notfound') throw e;
      }
    }
    if (d === null) throw lastErr;
    p.company = or(get(d, 'company_name'), board);
    p.check_company = !truthy(get(d, 'company_name'));
    p.role = strip(or(get(d, 'title'), ''));
    p.location = strip(or(get(or(get(d, 'location'), {}), 'name'), ''));
    p.posted = isoDate(or(get(d, 'first_published'), get(d, 'updated_at')));
    p.deadline = isoDate(get(d, 'application_deadline'));
    p.description = cleanText(or(get(d, 'content'), ''));
    const ranges = or(get(d, 'pay_input_ranges'), []);
    if (truthy(ranges)) {
      const r = ranges[0];
      const lo = get(r, 'min_cents');
      const hi = get(r, 'max_cents');
      const cur = or(get(r, 'currency_type'), '');
      const money = (c) => {
        if (c === null || c === undefined) return '?';
        if (typeof c !== 'number') throw new TypeError(`unsupported operand type(s) for /: '${pyType(c)}' and 'int'`);
        return fmt0(c / 100);
      };
      p.pay = strip(`${money(lo)} - ${money(hi)} ${pyStr(cur)}`) + (truthy(get(r, 'title')) ? ` (${pyStr(r.title)})` : '');
    }
    p.form_published = hasOwn(d, 'questions');
    for (const qd of iter(or(get(d, 'questions'), []))) {
      const fields = iter(or(get(qd, 'fields'), [])).filter((x) => get(x, 'type') !== 'input_hidden');
      if (!fields.length) continue;
      const main = fields.find((x) => get(x, 'type') === 'input_file') || fields[0];
      const qtype = pick(GH_TYPES, get(main, 'type'), 'text');
      const opts = iter(or(get(main, 'values'), [])).map((v) => get(v, 'label'));
      p.questions.push(question(or(get(qd, 'label'), ''), get(qd, 'required'), qtype, opts));
    }
    coverField(p);
    return p;
  }

  // ---------- Lever ----------

  const LEVER_TYPES = {
    'multiple-choice': 'select', 'multiple-select': 'multi', dropdown: 'select', textarea: 'textarea',
    text: 'text', 'file-upload': 'file', date: 'text',
  };

  // Questions from a Lever /apply page: the standard fields and the custom question cards (JSON in a hidden input).
  function leverForm(page) {
    const qs = [];
    for (const m of finditer('<div class="application-label">(.*?)</div>', page, 's')) {
      const raw = m[1];
      const label = strip(sub('✱|✳|\\*', '', htmlToText(raw)));
      if (label) qs.push(question(label, raw.includes('class="required"'), search('resume|cv\\b', label, 'i') ? 'file' : 'text'));
    }
    for (const m of finditer('<input[^>]*name="cards\\[[^\\]]+\\]\\[baseTemplate\\]"[^>]*>', page)) {
      const v = search('value="([^"]*)"', m[0]);
      if (!v) continue;
      let card;
      try {
        card = JSON.parse(unescapeHtml(v[1]));
      } catch {
        continue;
      }
      for (const fld of iter(or(get(card, 'fields'), []))) {
        const opts = iter(or(get(fld, 'options'), [])).map((o) => (isDict(o) ? get(o, 'text') : o));
        qs.push(question(or(get(fld, 'text'), ''), get(fld, 'required'), pick(LEVER_TYPES, get(fld, 'type'), 'text'), opts));
      }
    }
    const comments = search('<textarea[^>]*name="comments"[^>]*>', page);
    let note = '';
    if (comments) {
      const ph = search('placeholder="([^"]*)"', comments[0]);
      if (ph && search('cover\\s+letter', ph[1], 'i')) note = `Additional information box: "${unescapeHtml(ph[1])}"`;
    }
    return [qs, note];
  }

  async function fetchLever(url, info, f) {
    const p = newPosting(url, 'lever');
    if (!truthy(info.company) || !truthy(info.id)) throw new FetchError('this Lever link does not point at one posting', 'parse');
    const api = info.eu ? 'https://api.eu.lever.co' : 'https://api.lever.co';
    let d;
    try {
      d = await f.json(`${api}/v0/postings/${info.company}/${info.id}`);
    } catch (e) {
      if (!(e instanceof FetchError) || e.kind !== 'notfound' || info.eu) throw e;
      d = await f.json(`https://api.eu.lever.co/v0/postings/${info.company}/${info.id}`);
    }
    const cats = or(get(d, 'categories'), {});
    p.role = strip(or(get(d, 'text'), ''));
    const locs = or(get(cats, 'allLocations'), truthy(get(cats, 'location')) ? [cats.location] : []);
    p.location = withMode(iter(locs).map((x) => needStr(x)).join('; '), workplace(get(d, 'workplaceType')));
    p.posted = isoDate(get(d, 'createdAt'));
    const parts = [or(get(d, 'description'), '')];
    for (const lst of iter(or(get(d, 'lists'), []))) {
      parts.push(`<h3>${pyStr(get(lst, 'text', ''))}</h3><ul>${pyStr(get(lst, 'content', ''))}</ul>`);
    }
    parts.push(or(get(d, 'additional'), ''));
    p.description = cleanText(parts.map(needStr).join('\n'));
    const sr = or(get(d, 'salaryRange'), {});
    if (truthy(get(sr, 'min')) || truthy(get(sr, 'max'))) {
      const interval = (truthy(get(sr, 'interval')) ? pyStr(sr.interval) : '').replace(/-/g, ' ');
      p.pay = strip(`${fmtComma(hasOwn(sr, 'min') ? sr.min : 0)} - ${fmtComma(hasOwn(sr, 'max') ? sr.max : 0)} ` +
        `${pyStr(get(sr, 'currency', ''))} ${interval}`);
    }
    p.company = info.company;
    p.check_company = true;
    const applyUrl = or(get(d, 'applyUrl'), rstrip(needStr(get(d, 'hostedUrl', '')), '/') + '/apply');
    try {
      const page = await f.html(applyUrl);
      const t = search('<title>([^<]+)', page);
      if (t) {
        const ttl = strip(unescapeHtml(t[1]));
        if (ttl.includes(' - ')) {
          p.company = strip(ttl.slice(0, ttl.indexOf(' - ')));
          p.check_company = false;
        }
      }
      [p.questions, p.cover_letter_note] = leverForm(page);
      p.form_published = p.questions.length > 0;
      coverField(p);
      if (!p.cover_letter_field && p.cover_letter_note) p.cover_letter_field = 'optional';
    } catch (e) {
      if (!(e instanceof FetchError) || e.kind === 'network') throw e;
    }
    return p;
  }

  // ---------- Ashby ----------

  const ASHBY_Q = 'query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) { ' +
    'jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) { ' +
    'id title locationName workplaceType employmentType descriptionHtml publishedDate applicationDeadline ' +
    'compensationTierSummary secondaryLocationNames applicationForm { sections { title fieldEntries { ' +
    '... on FormFieldEntry { id field isRequired descriptionHtml isHidden } } } } } }';
  const ASHBY_ORG = 'query ApiOrganizationFromHostedJobsPageName($organizationHostedJobsPageName: String!) { ' +
    'organization: organizationFromHostedJobsPageName(organizationHostedJobsPageName: $organizationHostedJobsPageName) ' +
    '{ name } }';
  const ASHBY_TYPES = {
    String: 'text', LongText: 'textarea', Email: 'text', Phone: 'text', File: 'file', Boolean: 'yes/no',
    ValueSelect: 'select', MultiValueSelect: 'multi', Date: 'text', Number: 'text', Location: 'text',
    EducationHistory: 'text', Score: 'select', SocialLink: 'text',
  };

  async function ashbyGraphql(f, op, query, variables) {
    const d = await f.json(`https://jobs.ashbyhq.com/api/non-user-graphql?op=${op}`, { operationName: op, variables, query });
    if (truthy(get(d, 'errors')) && !truthy(get(d, 'data'))) {
      const msg = Array.isArray(d.errors) ? get(d.errors[0], 'message', 'error') : 'error';
      if (pyStr(msg).includes('secondaryLocationNames')) throw new FetchError(pyStr(msg), 'schema');
      throw new FetchError(`Ashby: ${pyStr(msg)}`, 'parse');
    }
    return or(get(d, 'data'), {});
  }

  async function fetchAshby(url, info, f) {
    const p = newPosting(url, 'ashby');
    if (!truthy(info.org) || !truthy(info.id)) throw new FetchError('this Ashby link does not point at one posting', 'parse');
    const v = { organizationHostedJobsPageName: info.org, jobPostingId: info.id };
    let data;
    try {
      data = await ashbyGraphql(f, 'ApiJobPosting', ASHBY_Q, v);
    } catch (e) {
      if (!(e instanceof FetchError) || e.kind !== 'schema') throw e;
      data = await ashbyGraphql(f, 'ApiJobPosting', ASHBY_Q.replace(' secondaryLocationNames', ''), v);
    }
    const jp = get(data, 'jobPosting');
    if (!truthy(jp)) throw new FetchError('Ashby has no such posting (it may be closed)', 'notfound');
    let org;
    try {
      const od = await ashbyGraphql(f, 'ApiOrganizationFromHostedJobsPageName', ASHBY_ORG, { organizationHostedJobsPageName: info.org });
      org = get(or(get(od, 'organization'), {}), 'name');
    } catch (e) {
      if (!(e instanceof FetchError)) throw e;
      org = null;
    }
    p.company = or(org, info.org);
    p.check_company = !truthy(org);
    p.role = strip(or(get(jp, 'title'), ''));
    const locs = [or(get(jp, 'locationName'), '')].concat(iter(or(get(jp, 'secondaryLocationNames'), [])));
    p.location = withMode(locs.filter((l) => truthy(l)).map(needStr).join('; '), workplace(get(jp, 'workplaceType')));
    p.posted = isoDate(get(jp, 'publishedDate'));
    p.deadline = isoDate(get(jp, 'applicationDeadline'));
    p.pay = or(get(jp, 'compensationTierSummary'), '');
    p.description = cleanText(or(get(jp, 'descriptionHtml'), ''));
    const form = or(get(jp, 'applicationForm'), {});
    p.form_published = truthy(get(form, 'sections'));
    for (const sec of iter(or(get(form, 'sections'), []))) {
      for (const e of iter(or(get(sec, 'fieldEntries'), []))) {
        const fld = or(get(e, 'field'), {});
        if (!truthy(fld) || truthy(get(e, 'isHidden'))) continue;
        const opts = iter(or(get(fld, 'selectableValues'), [])).filter(isDict).map((o) => get(o, 'label'));
        p.questions.push(question(or(get(fld, 'title'), ''), get(e, 'isRequired'), pick(ASHBY_TYPES, get(fld, 'type'), 'text'), opts));
      }
    }
    coverField(p);
    if (!truthy(p.pay)) p.pay = payFromText(p.description);
    return p;
  }

  // ---------- Workday ----------

  function workdayPosted(j) {
    const s = truthy(get(j, 'postedOn')) ? pyStr(j.postedOn) : '';
    if (search('today', s, 'i')) return todayIso(0);
    if (search('yesterday', s, 'i')) return todayIso(1);
    const m = search('(\\d+)\\+?\\s+days?\\s+ago', s, 'i');
    if (m && !s.includes('+')) return todayIso(Number(m[1]));
    return '';
  }

  async function fetchWorkday(url, info, f) {
    const p = newPosting(url, 'workday');
    if (!(truthy(info.tenant) && truthy(info.site) && truthy(info.slug))) {
      throw new FetchError('this Workday link does not point at one posting', 'parse');
    }
    const d = await f.json(`${info.base}/wday/cxs/${info.tenant}/${info.site}/job/${info.slug}`);
    const j = or(get(d, 'jobPostingInfo'), {});
    if (!truthy(j)) throw new FetchError('Workday returned no posting (it may be closed)', 'notfound');
    let org = strip(or(get(or(get(d, 'hiringOrganization'), {}), 'name'), ''));
    org = sub('^[A-Z]{0,4}\\d{1,5}\\s+', '', org);
    p.company = org || title(info.tenant.replace(/-/g, ' '));
    p.check_company = !org;
    p.role = strip(or(get(j, 'title'), ''));
    const locs = [or(get(j, 'location'), '')].concat(iter(or(get(j, 'additionalLocations'), [])));
    p.location = withMode(locs.filter((l) => truthy(l)).map(needStr).join('; '), workplace(or(get(j, 'remoteType'), '')));
    p.posted = isoDate(get(j, 'startDate')) || workdayPosted(j);
    p.deadline = realDeadline(get(j, 'endDate'));
    p.description = cleanText(or(get(j, 'jobDescription'), ''));
    p.pay = payFromText(p.description);
    p.cover_letter_field = null; // Workday doesn't publish its form: "none" unless the description asks
    return p;
  }

  // ---------- SmartRecruiters ----------

  async function fetchSmartRecruiters(url, info, f) {
    const p = newPosting(url, 'smartrecruiters');
    if (!truthy(info.company) || !truthy(info.id)) throw new FetchError('this SmartRecruiters link does not point at one posting', 'parse');
    const d = await f.json(`https://api.smartrecruiters.com/v1/companies/${info.company}/postings/${info.id}`);
    p.company = strip(or(get(or(get(d, 'company'), {}), 'name'), info.company));
    p.role = strip(or(get(d, 'name'), ''));
    const loc = or(get(d, 'location'), {});
    const mode = truthy(get(loc, 'remote')) ? 'remote' : truthy(get(loc, 'hybrid')) ? 'hybrid' : '';
    p.location = withMode(or(get(loc, 'fullLocation'), place(get(loc, 'city'), get(loc, 'region'), get(loc, 'country'))), mode);
    p.posted = isoDate(get(d, 'releasedDate'));
    const secs = or(get(or(get(d, 'jobAd'), {}), 'sections'), {});
    const parts = [];
    for (const key of ['jobDescription', 'qualifications', 'additionalInformation', 'companyDescription']) {
      const sec = or(get(secs, key), {});
      if (truthy(get(sec, 'text'))) parts.push(`<h3>${pyStr(or(get(sec, 'title'), ''))}</h3>${pyStr(sec.text)}`);
    }
    p.description = cleanText(parts.join('\n'));
    p.pay = payFromText(p.description);
    return p;
  }

  // ---------- Oracle Recruiting Cloud ----------

  async function fetchOracle(url, info, f) {
    const p = newPosting(url, 'oracle');
    if (!truthy(info.id)) throw new FetchError('this Oracle link does not point at one posting', 'parse');
    const finder = `ById;Id="${info.id}"` + (truthy(info.site) ? `,siteNumber=${info.site}` : '');
    const d = await f.json(`https://${info.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?` +
      `expand=all&onlyData=true&finder=${quote(finder, ';=,')}`);
    const items = or(get(d, 'items'), []);
    if (!truthy(items)) throw new FetchError('Oracle returned no posting (it may be closed)', 'notfound');
    const j = items[0];
    p.role = strip(or(get(j, 'Title'), ''));
    const locs = [or(get(j, 'PrimaryLocation'), '')].concat(iter(or(get(j, 'secondaryLocations'), [])).map((x) => or(get(x, 'Name'), '')));
    p.location = withMode(locs.filter((l) => truthy(l)).map(needStr).join('; '),
      workplace(or(get(j, 'WorkplaceType'), get(j, 'WorkplaceTypeCode'), '')));
    p.posted = isoDate(get(j, 'ExternalPostedStartDate'));
    p.deadline = realDeadline(get(j, 'ExternalPostedEndDate'));
    const parts = ['ExternalDescriptionStr', 'ExternalResponsibilitiesStr', 'ExternalQualificationsStr',
      'OrganizationDescriptionStr', 'CorporateDescriptionStr'].map((k) => or(get(j, k), ''));
    const flex = iter(or(get(j, 'requisitionFlexFields'), [])).filter((x) => truthy(get(x, 'Value')));
    p.description = cleanText(parts.map(needStr).join('\n') + flex.map((x) => `<p>${pyStr(get(x, 'Prompt'))}: ${pyStr(x.Value)}</p>`).join(''));
    const payField = flex.find((x) => search('pay|salary|wage|compensation', pyStr(get(x, 'Prompt')), 'i'));
    const pay = payField ? payField.Value : '';
    p.pay = or(pay, payFromText(p.description));
    const host = info.host.split('.')[0];
    const guess = plen(host) <= 5 ? host.toUpperCase() : title(host);
    p.company = or(get(j, 'LegalEmployer'), get(j, 'Organization'), guess);
    p.check_company = !truthy(or(get(j, 'LegalEmployer'), get(j, 'Organization')));
    return p;
  }

  // ---------- Rippling ----------

  const RIPPLING_TYPES = {
    SHORT_ANSWER: 'text', LONG_ANSWER: 'textarea', PARAGRAPH: 'textarea', FILE: 'file', PHONE_NUMBER: 'text',
    PRONOUN: 'select', EMAIL: 'text', URL: 'text', select: 'select', text: 'text', textarea: 'textarea',
    paragraph: 'textarea', longtext: 'textarea', file: 'file', date: 'text', number: 'text', boolean: 'yes/no',
  };

  async function fetchRippling(url, info, f) {
    const p = newPosting(url, 'rippling');
    if (!truthy(info.board) || !truthy(info.id)) throw new FetchError('this Rippling link does not point at one posting', 'parse');
    const d = await f.json(`https://api.rippling.com/platform/api/ats/v1/board/${info.board}/jobs/${info.id}`);
    p.company = strip(or(get(d, 'companyName'), info.board));
    p.check_company = !truthy(get(d, 'companyName'));
    p.role = strip(or(get(d, 'name'), ''));
    p.location = iter(or(get(d, 'workLocations'), [])).map((x) => pyStr(isDict(x) ? get(x, 'name') : x)).join('; ');
    p.posted = isoDate(get(d, 'createdOn'));
    const desc = or(get(d, 'description'), {});
    p.description = isDict(desc) ? cleanText(needStr(or(get(desc, 'role'), '')) + '\n' + needStr(or(get(desc, 'company'), '')))
      : cleanText(pyStr(desc));
    const pr = or(get(d, 'payRangeDetails'), []);
    if (truthy(pr) && isDict(pr[0])) {
      const r = pr[0];
      const lo = or(get(r, 'rangeStart'), get(r, 'min'));
      const hi = or(get(r, 'rangeEnd'), get(r, 'max'));
      if (truthy(lo) || truthy(hi)) {
        p.pay = typeof lo === 'number' && typeof hi === 'number'
          ? strip(`${fmtComma(lo)} - ${fmtComma(hi)} ${pyStr(get(r, 'currency', ''))} ${(truthy(get(r, 'frequency')) ? pyStr(r.frequency) : '').toLowerCase()}`)
          : `${pyStr(lo)} - ${pyStr(hi)}`;
      }
    }
    if (!truthy(p.pay)) p.pay = payFromText(p.description);
    const app = or(get(d, 'activeJobApplication'), {});
    for (const q of iter(or(get(app, 'basicQuestions'), []))) {
      p.questions.push(question(or(get(q, 'title'), ''), get(q, 'required'), pick(RIPPLING_TYPES, get(q, 'fieldType'), 'text')));
    }
    for (const block of iter(or(get(app, 'additionalQuestions'), []))) {
      for (const q of iter(or(get(or(get(block, 'form'), {}), 'questions'), []))) {
        let qtype = pick(RIPPLING_TYPES, get(q, 'dataType'), 'text');
        const opts = or(get(q, 'strChoices'), iter(or(get(q, 'intChoices'), [])).map(pyStr));
        if (qtype === 'select' && truthy(get(q, 'isMultiSelectEnabled')) && iter(opts).length > 2) qtype = 'multi';
        p.questions.push(question(or(get(q, 'title'), ''), get(q, 'isRequired'), qtype, opts));
      }
    }
    p.form_published = truthy(app);
    coverField(p);
    return p;
  }

  // ---------- Job Bank (Canada) ----------

  function prop(page, name) {
    const m = search(`property="${name}"[^>]*>(.*?)</(?:span|p|h1|div|strong)>`, page, 's');
    return m ? strip(sub('\\s+', ' ', htmlToText(m[1]))) : '';
  }

  function parseJobBankRaw(page, url) {
    page = String(page ?? '');
    const p = newPosting(url, 'jobbank');
    p.role = prop(page, 'title');
    let m = search('property="hiringOrganization".*?property="name"[^>]*>(.*?)</span>', page, 's');
    p.company = m ? strip(sub('\\s+', ' ', htmlToText(m[1]))) : '';
    p.posted = isoDate(prop(page, 'datePosted'));
    const adv = isoDate(prop(page, 'validThrough'));
    p.deadline = adv ? `${adv} (advertised until)` : '';
    const city = prop(page, 'addressLocality');
    const region = prop(page, 'addressRegion');
    let mode = '';
    const wl = search('Work location</span>\\s*<span>([^<]+)</span>', page);
    if (wl) mode = strip(wl[1]).toLowerCase().replace(/on site/g, 'on-site');
    p.location = withMode(place(city, region), mode);
    const sal = search('property="baseSalary"(.*?)</li>', page, 's');
    if (sal) {
      let s = strip(sub('\\s+', ' ', htmlToText('<span ' + sal[1])));
      s = sub('^[^$\\d]*', '', s);
      s = sub('\\b(YEAR|HOUR|WEEK|MONTH)\\s+', '', s);
      p.pay = s ? ('$' + lstrip(s, '$ ')).replace(/\$ /g, '$') : '';
    }
    const parts = [];
    const head = search('<h2[^>]*>\\s*Job details\\s*</h2>(.*?)(?:<div[^>]*job-posting-detail-requirements|<h3>\\s*Advertised until)', page, 's');
    if (head) {
      const block = sub('<span[^>]*class="hidden"[^>]*>.*?</span>', ' ', head[1], 's');
      const items = [];
      for (const li of findall('<li[^>]*>(.*?)</li>', block, 's')) {
        const t = strip(sub('\\s+', ' ', htmlToText(li)), ' -');
        if (t && !match('^(?:Location|Work location|Salary|Source|Various locations)\\b', t) && !items.includes(t)) items.push(t);
      }
      if (items.length) parts.push(items.map((t) => '- ' + t).join('\n'));
    }
    const req = search('job-posting-detail-requirements[^>]*>(.*?)(?:Show how to apply|<h3>\\s*Advertised until|id="howtoapply)', page, 's');
    if (req) {
      parts.push(cleanText(req[1]));
    } else {
      const desc = search('property="description"[^>]*>(.*?)</span>', page, 's');
      if (desc) parts.push(cleanText(unescapeHtml(desc[1])));
    }
    let text = parts.filter((x) => strip(x)).join('\n\n');
    // "Who can apply" as one sentence, so the eligibility screen reads it as a whole
    text = sub('(You can apply if you are:|The employer accepts applications from:)\\s*((?:\\n\\s*-\\s*[^\\n]+)+)',
      (all, g1, g2) => g1 + ' ' + splitlines(strip(g2)).map((x) => strip(x, ' -')).join('; ') + '.', text);
    const noc = search('class="noc-title">([^<]*)</span>\\s*<span class="noc-no">NOC\\s*(\\d{5})', page);
    if (noc) {
      text += `\n\nNOC 2021: ${noc[2]} (${strip(noc[1])})`;
    } else {
      m = search('NOC\\s*(?:2021)?\\s*:?\\s*(\\d{5})', page);
      if (m) text += `\n\nNOC 2021: ${m[1]}`;
    }
    if (search('provided by a partner site', page)) {
      text += "\n\n(This posting comes from a partner site; the full posting and how to apply are on the employer's site.)";
    }
    p.description = strip(sub('\\n{3,}', '\n\n', text));
    return p;
  }

  async function fetchJobBank(url, info, f) {
    if (!truthy(info.id)) throw new FetchError('this Job Bank link does not point at one posting', 'parse');
    const page = (await f.request(`https://www.jobbank.gc.ca/jobsearch/jobposting/${info.id}`, { accept: 'text/html' })).text;
    if (!page.includes('property="title"')) throw new FetchError('Job Bank did not return the posting (it may have expired)', 'notfound');
    return parseJobBankRaw(page, url);
  }

  // ---------- schema.org JobPosting JSON-LD ----------

  function firstJsonLdPosting(page) {
    for (const m of finditer('<script[^>]*type=["\']application/ld\\+json["\'][^>]*>(.*?)</script>', page, 'si')) {
      let d;
      try {
        d = JSON.parse(strip(m[1]));
      } catch {
        try {
          d = JSON.parse(unescapeHtml(strip(m[1])));
        } catch {
          continue;
        }
      }
      const stack = [d];
      while (stack.length) {
        const x = stack.pop();
        if (Array.isArray(x)) {
          stack.push(...x);
        } else if (isDict(x)) {
          const t = x['@type'];
          if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) return x;
          if (hasOwn(x, '@graph')) stack.push(x['@graph']);
        }
      }
    }
    return null;
  }

  function parseJsonLdRaw(page, url, system = 'other') {
    const j = firstJsonLdPosting(String(page ?? ''));
    if (!j) return null;
    const p = newPosting(url, system);
    p.role = strip(unescapeHtml(pyStr(or(get(j, 'title'), ''))));
    const org = get(j, 'hiringOrganization');
    p.company = strip(unescapeHtml(pyStr(or(isDict(org) ? get(org, 'name') : org, ''))));
    let locs = or(get(j, 'jobLocation'), []);
    locs = Array.isArray(locs) ? locs : [locs];
    const names = [];
    for (const loc of locs) {
      const a = isDict(loc) ? get(or(loc, {}), 'address') : null;
      if (isDict(a)) {
        const country = typeof get(a, 'addressCountry') === 'string' ? a.addressCountry : get(or(get(a, 'addressCountry'), {}), 'name');
        names.push(place(get(a, 'addressLocality'), get(a, 'addressRegion'), country));
      } else if (typeof a === 'string') {
        names.push(a);
      }
    }
    const mode = (truthy(get(j, 'jobLocationType')) ? pyStr(j.jobLocationType) : '').toUpperCase().includes('TELECOMMUTE') ? 'remote' : '';
    p.location = withMode(names.filter((n) => n).join('; '), mode);
    p.posted = isoDate(get(j, 'datePosted'));
    p.deadline = realDeadline(get(j, 'validThrough'));
    p.description = cleanText(pyStr(or(get(j, 'description'), '')));
    const sal = get(j, 'baseSalary');
    if (isDict(sal)) {
      const v = or(get(sal, 'value'), {});
      let amount;
      let unit;
      if (isDict(v)) {
        const lo = get(v, 'minValue');
        const hi = get(v, 'maxValue');
        unit = or(get(v, 'unitText'), '');
        amount = truthy(lo) && truthy(hi) && lo !== hi ? `${pyStr(lo)} - ${pyStr(hi)}` : pyStr(or(lo, hi, get(v, 'value'), ''));
      } else {
        amount = pyStr(v);
        unit = '';
      }
      if (strip(amount)) p.pay = strip(`${amount} ${pyStr(or(get(sal, 'currency'), ''))} ${pyStr(unit).toLowerCase()}`);
    }
    if (!truthy(p.pay)) p.pay = payFromText(p.description);
    return p;
  }

  async function fetchPage(url, info, f, system = 'other') {
    let pageUrl = url;
    if (system === 'icims') {
      const u = urlsplit(url);
      const q = parseQs(u.query);
      q.set('in_iframe', '1');
      const path = u.netloc && u.path && !u.path.startsWith('/') ? '/' + u.path : u.path;
      pageUrl = `${u.scheme ? u.scheme + ':' : ''}//${u.netloc}${path}?${urlencode(q)}`;
    }
    const page = await f.html(pageUrl);
    const p = parseJsonLdRaw(page, url, system);
    if (p === null) throw new FetchError('no job data on this page (it may need JavaScript)', 'parse');
    if (!truthy(p.company)) {
      p.company = companyFromUrl(url);
      p.check_company = true;
    }
    return p;
  }

  // ---------- pasted text ----------

  function companyFromUrl(url) {
    const info = classify(url)[1];
    let slug = or(info.board, info.company, info.org, info.tenant, '');
    if (!truthy(slug)) {
      const host = urlsplit(truthy(url) ? pyStr(url) : '').netloc.toLowerCase().split(':')[0];
      const parts = host.split('.').filter((x) => !['www', 'jobs', 'careers', 'apply', 'boards', 'job-boards'].includes(x));
      slug = parts.length >= 2 ? parts[parts.length - 2] : (parts.length ? parts[0] : '');
      slug = sub('^(careers|jobs)-', '', slug);
    }
    return title(strip(sub('[-_]+', ' ', unquote(slug))));
  }

  function fromTextRaw(text, url, company = '', role = '') {
    const system = truthy(url) ? classify(url)[0] : 'other';
    const p = newPosting(url, system);
    let body = search('<(p|div|li|br|ul)\\b', truthy(text) ? text : '', 'i') ? cleanText(text) : strip(truthy(text) ? pyStr(text) : '');
    body = sub('\\r\\n?', '\n', body);
    p.description = sub('\\n{3,}', '\n\n', body);
    const lines = splitlines(p.description).map((l) => strip(l)).filter((l) => l);
    const field = (...names) => {
      for (const l of lines.slice(0, 40)) {
        const m = match(`^(?:${names.join('|')})\\s*[:\\-–]\\s*(.+)$`, l, 'i');
        if (m) return strip(m[1]);
      }
      return '';
    };
    const head = lines.length ? lines[0] : '';
    const m = match('^#?\\s*(.+?)\\s+at\\s+(.+)$', head);
    p.role = or(role, field('job title', 'title', 'role', 'position'), m ? m[1] : (plen(head) <= 100 ? head : ''));
    p.company = or(company, field('company', 'employer', 'organization', 'organisation'), m ? m[2] : '');
    if (!truthy(p.company)) {
      p.company = truthy(url) ? companyFromUrl(url) : '';
      p.check_company = true;
    }
    p.location = field('location', 'job location', 'work location', 'city');
    p.pay = or(field('salary', 'pay', 'compensation', 'wage'), payFromText(p.description));
    p.posted = isoDate(field('posted', 'date posted', 'posted on'));
    p.deadline = or(field('deadline', 'apply by', 'closing date', 'application deadline'), deadlineFromText(p.description));
    return p;
  }

  // ---------- finishing ----------

  const STAFFING = '\\b(?:staffing|recruit(?:ing|ment|ers?)|talent\\s+(?:solutions|partners|acquisition\\s+partners)|' +
    'robert\\s+half|teksystems|randstad|adecco|insight\\s+global|kforce|aerotek|manpower|hays|michael\\s+page|' +
    'kelly\\s+services|apex\\s+systems|cybercoders|jobot|motion\\s+recruitment|modis|akkodis|beacon\\s+hill|' +
    'actalent|procom|astra\\s+north)\\b';
  const CLIENT = '\\b(?:our\\s+client|on\\s+behalf\\s+of\\s+(?:a|our)\\s+client|client\\s+company|for\\s+a\\s+(?:leading|well[- ]known)\\s+client)\\b';

  // Fill gaps that every system shares: pay and deadline from the text, staffing-agency check.
  function finishRaw(p) {
    if (!truthy(p.pay)) p.pay = payFromText(p.description);
    if (!truthy(p.deadline)) p.deadline = deadlineFromText(p.description);
    if (search(STAFFING, truthy(p.company) ? pyStr(p.company) : '', 'i') || search(CLIENT, truthy(p.description) ? pyStr(p.description) : '', 'i')) {
      p.check_company = true;
    }
    p.description = or(p.description, '');
    return p;
  }

  // ---------- cover letter, written questions ----------

  const ABBREV = '\\b(?:U\\.\\s?S\\.(?:\\s?A\\.)?|U\\.\\s?K\\.|e\\.g\\.|i\\.e\\.|etc\\.|Inc\\.|Ltd\\.|Co\\.|Corp\\.|Jr\\.|Sr\\.|No\\.|St\\.|' +
    'approx\\.|vs\\.|Ph\\.\\s?D\\.|M\\.\\s?Sc\\.|B\\.\\s?Sc\\.|B\\.\\s?S\\.|M\\.\\s?S\\.|B\\.\\s?A\\.|M\\.\\s?A\\.|B\\.\\s?Eng\\.|' +
    'M\\.\\s?Eng\\.|Dr\\.|Mr\\.|Ms\\.|Mrs\\.)';
  const DOT = '․';

  // Sentences of a posting (redflags.split_sentences): every line split at sentence ends, bullet markers dropped.
  function splitSentences(text) {
    const out = [];
    for (let line of splitlines(truthy(text) ? pyStr(text) : '')) {
      line = strip(line.replace(R('^\\s*(?:[-*\\u2022\\u25cf\\u25aa\\u2013]|\\d+[.)])\\s+'), ''));
      if (!line) continue;
      line = sub(ABBREV, (m) => m.replace(/\./g, DOT), line, 'i');
      for (let part of line.split(R('(?<=[.!?])\\s+(?=[A-Z0-9"\'(\\u201c])'))) {
        part = strip(part.split(DOT).join('.'));
        if (part) out.push(part);
      }
    }
    return out;
  }

  const CL_NOT = "\\bno\\s+cover\\s+letters?\\b|\\bcover\\s+letters?\\s+(?:is\\s+|are\\s+)?(?:not|never)\\s+(?:required|needed|necessary|" +
    "accepted|considered|read|reviewed)\\b|\\b(?:do\\s+not|don'?t|no\\s+need\\s+to|please\\s+don'?t)\\s+(?:need\\s+to\\s+)?" +
    '(?:send|include|submit|attach|write|upload)\\s+(?:a\\s+|any\\s+)?cover\\s+letters?\\b|\\bskip\\s+the\\s+cover\\s+letter\\b|' +
    '\\bwithout\\s+a\\s+cover\\s+letter\\b';
  const CL_ASK = '\\b(?:include|attach|submit|send|provide|upload|along\\s+with|accompanied\\s+by|together\\s+with|with)\\b[^.]{0,60}' +
    '\\bcover\\s+letter\\b|\\bcover\\s+letter\\b[^.]{0,40}\\b(?:is\\s+)?(?:required|must|mandatory|should|is\\s+requested|' +
    'expected)\\b|\\b(?:resume|cv)\\s+(?:and|&|\\+)\\s+(?:a\\s+)?cover\\s+letter\\b|\\bletter\\s+of\\s+(?:interest|intent|' +
    'motivation)\\b';
  const CL_OPT = '\\bcover\\s+letters?\\s*(?:\\(optional\\)|(?:is|are)\\s+optional|optional)\\b|\\boptional(?:ly)?[^.]{0,30}cover\\s+letter\\b';

  function coverLetterRaw(p) {
    const sents = splitSentences(or(p.description, ''));
    const no = sents.find((s) => search(CL_NOT, s, 'i'));
    if (no !== undefined) return { status: 'not wanted', quote: cut(no, 240) };
    if (p.cover_letter_field === 'required') return { status: 'required', quote: '' };
    const opt = sents.find((s) => search(CL_OPT, s, 'i'));
    const ask = sents.find((s) => search(CL_ASK, s, 'i') && !search(CL_OPT, s, 'i') && !search('\\?\\s*$', s));
    if (ask !== undefined) return { status: 'asked', quote: cut(ask, 240) };
    if (p.cover_letter_field === 'optional') return { status: 'optional', quote: or(p.cover_letter_note, '') };
    if (opt !== undefined) return { status: 'optional', quote: cut(opt, 240) };
    if (truthy(p.form_published) || p.system === 'workday') return { status: 'none', quote: '' };
    return { status: 'unknown', quote: '' };
  }

  const FACTUAL = '\\b(?:name|e-?mail|phone|linkedin|github|website|portfolio|url|link|address|city|location|located|' +
    'relocat\\w*|salary|compensation|pay\\b|pronoun|hear\\s+about|how\\s+did\\s+you|referr\\w*|graduat\\w*|degree|gpa|' +
    'school|university|college|employer|company|job\\s+title|start\\s+date|notice\\s+period|availab\\w*|' +
    'citizenship|sponsor\\w*|authori[sz]\\w*|visa|gender|race|ethnic\\w*|veteran|disab\\w*|deadline|' +
    'resume|cv\\b|cover\\s+letter|transcript|pronunciation|preferred|languages?|country|state|province|' +
    'zip|postal|date\\s+of|when\\s+can|years\\s+of\\s+experience|consent|privacy|agree|acknowledge|' +
    'certify|recording|notetak\\w*|ai\\s+tool)\\b';
  const OPEN = '^(?:why|what|how|describe|tell|share|explain|please\\s+(?:describe|tell|share|explain|provide|give|write)|' +
    'give|in\\s+(?:\\d+|a\\s+few|one|two)|briefly|walk\\s+us|talk\\s+about|if\\s+you\\s+could|imagine)\\b|' +
    '\\b(?:words?\\s+or\\s+(?:less|fewer)|paragraphs?|in\\s+\\d+\\s+words|essay|motivat\\w*|interest\\w*\\s+in|' +
    'proud|accomplishment|challenge|example\\s+of|a\\s+time\\s+(?:when|you)|excite\\w*)\\b';

  // Open-ended questions that need a drafted answer (essays, "why us", "tell us about a project").
  function writtenQuestions(questions) {
    const out = [];
    for (const q of iter(or(questions, []))) {
      const label = or(get(q, 'label'), '');
      const t = get(q, 'type');
      if (['file', 'select', 'multi', 'yes/no'].includes(t)) continue;
      if (search('^(?:additional\\s+information|comments?|anything\\s+else)$', label, 'i')) continue;
      if (t === 'textarea' && !search(FACTUAL, label, 'i')) out.push(label);
      else if (search(OPEN, label, 'i') && (!search(FACTUAL, label, 'i') || search('\\bwhy\\b|\\bproud|\\bbuilt\\b|\\bproject', label, 'i'))) out.push(label);
    }
    return out;
  }

  function questionLine(q, maxOptions = 12) {
    const opts = or(get(q, 'options'), []);
    let extra = '';
    if (truthy(opts)) {
      const shown = opts.slice(0, maxOptions);
      extra = '; options: ' + shown.join(' | ') + (opts.length > maxOptions ? ` | ... (+${opts.length - maxOptions} more)` : '');
    }
    return `- [${truthy(get(q, 'required')) ? 'required' : 'optional'}] ${pyStr(get(q, 'label'))} (${pyStr(get(q, 'type'))}${extra})`;
  }

  // ---------- public shape (camelCase) ----------

  function toRaw(posting) {
    const p = posting || {};
    return {
      description: p.description, system: p.system,
      cover_letter_field: p.coverLetterField !== undefined ? p.coverLetterField : p.cover_letter_field,
      cover_letter_note: p.coverLetterNote !== undefined ? p.coverLetterNote : p.cover_letter_note,
      form_published: p.formPublished !== undefined ? p.formPublished : p.form_published,
    };
  }
  // { status: required|optional|asked|not wanted|none|unknown, quote }
  const coverLetter = (posting) => coverLetterRaw(toRaw(posting));

  function toPublic(p) {
    const cl = coverLetterRaw(p);
    return {
      url: p.url, system: p.system, company: p.company, role: p.role, location: p.location, deadline: p.deadline,
      pay: p.pay, posted: p.posted, description: p.description,
      questions: p.questions.map((q) => ({ label: q.label, required: q.required, type: q.type, options: q.options.slice() })),
      formPublished: p.form_published, coverLetterField: p.cover_letter_field, coverLetterNote: p.cover_letter_note,
      checkCompany: p.check_company, coverLetter: cl.status, coverLetterQuote: cl.quote,
    };
  }

  // Fill shared gaps (pay, deadline, staffing check) on a public posting; returns a new posting.
  function finish(posting) {
    const p = posting || {};
    const raw = {
      ...newPosting(p.url, p.system || 'other'), ...p,
      questions: Array.isArray(p.questions) ? p.questions : [],
      form_published: p.formPublished ?? p.form_published ?? false,
      cover_letter_field: p.coverLetterField !== undefined ? p.coverLetterField : (p.cover_letter_field ?? null),
      cover_letter_note: p.coverLetterNote ?? p.cover_letter_note ?? '',
      check_company: p.checkCompany ?? p.check_company ?? false,
    };
    return toPublic(finishRaw(raw));
  }

  const fromText = (text, url, { company = '', role = '' } = {}) => toPublic(finishRaw(fromTextRaw(text, url || '', company || '', role || '')));
  function parseJsonLd(html, url, system = 'other') {
    const p = parseJsonLdRaw(html, url, system);
    if (!p) return null;
    if (!truthy(p.company)) {
      p.company = companyFromUrl(url);
      p.check_company = true;
    }
    return toPublic(finishRaw(p));
  }
  const parseJobBank = (html, url) => toPublic(finishRaw(parseJobBankRaw(html, url)));

  // ---------- one entry point ----------

  const FETCHERS = {
    greenhouse: fetchGreenhouse, lever: fetchLever, ashby: fetchAshby, workday: fetchWorkday,
    smartrecruiters: fetchSmartRecruiters, oracle: fetchOracle, rippling: fetchRippling, jobbank: fetchJobBank,
  };
  const SUPPORTED_NAMES = 'Greenhouse, Lever, Ashby, Workday, SmartRecruiters, iCIMS, Oracle Recruiting Cloud, Rippling and Job Bank';

  // hint_for, in the app's words
  function hintFor(system, kind) {
    if (system === 'linkedin') {
      return "LinkedIn is never fetched. Paste the description, or find the same job on the company's own careers page or application system.";
    }
    if (kind === 'network') return 'No connection to this site. Open the posting in the browser and read it there.';
    if (kind === 'notfound') return 'The posting seems closed or moved. Open the link in the browser to check, or look on the company careers page.';
    if (kind === 'blocked') {
      return 'This link leads outside the job sites the app contacts, so it was not opened. Open the posting in the browser and ' +
        'read it there, paste the description, or use the browser extension on the posting page.';
    }
    return 'Open the posting in the browser and read it there, or paste the description.';
  }

  const CODES = { network: 'network', http: 'network', notfound: 'not_found', parse: 'parse', schema: 'parse', blocked: 'blocked', unsupported: 'unsupported' };
  function publicError(code, message, extra = {}) {
    const e = new Error(message);
    e.code = code;
    Object.assign(e, extra);
    return e;
  }
  function unsupported(system, url) {
    if (system === 'linkedin') return publicError('unsupported', hintFor('linkedin'), { system, kind: 'unsupported', detail: 'LinkedIn is not fetched' });
    return publicError('unsupported', `The app reads postings from ${SUPPORTED_NAMES} links. Paste the description, ` +
      'or use the browser extension on the posting page.', { system, kind: 'unsupported', detail: `not a supported job-site link: ${url}` });
  }
  function toPublicError(system, e) {
    if (e.kind === 'unsupported') {
      return publicError('unsupported', "This company page doesn't say which Greenhouse board the job is on. Open the job's own " +
        'Greenhouse link (job-boards.greenhouse.io/<company>/jobs/<id>) instead, or use the browser extension on this page.',
      { system, kind: 'unsupported', detail: 'could not tell which Greenhouse board this job belongs to' });
    }
    return publicError(CODES[e.kind] || 'parse', hintFor(system, e.kind), { system, kind: e.kind, status: e.status ?? null, detail: e.message });
  }
  const unexpected = (e) => new FetchError(`could not read this posting (${(e && e.name) || 'Error'}: ${(e && e.message) || e})`, 'parse');

  // Posting for a link, read through fetcher(url, { method, headers, body }) -> { status, url, headers, text }.
  // Throws Error with .code unsupported|not_found|blocked|network|parse and a friendly .message.
  // opts: { delayMs (pause between requests to one host, default 1000), retryDelayMs (before one retry on 429/5xx, default 2000) }
  async function fetchPosting(url, fetcher, opts = {}) {
    const link = typeof url === 'string' ? url.trim() : '';
    if (!/^https?:\/\//i.test(link)) throw publicError('unsupported', 'Not a web link. Paste the posting address (https://...).', { kind: 'unsupported', detail: `Not a web link: ${url}` });
    const [system, info] = classify(link);
    if (system === 'linkedin' || system === 'other') throw unsupported(system, link);
    const f = makeNet(fetcher, opts);
    const done = (p) => {
      try {
        p.system = system;
        return toPublic(finishRaw(p));
      } catch (e) {
        throw toPublicError(system, unexpected(e));
      }
    };
    let p;
    try {
      p = FETCHERS[system] ? await FETCHERS[system](link, info, f) : await fetchPage(link, info, f, system);
    } catch (e) {
      // unexpected data shape: report it, without the second chance (as in the Python version)
      if (!(e instanceof FetchError)) throw toPublicError(system, unexpected(e));
      // second chance: the page itself may carry JSON-LD (only on job-site addresses)
      if (FETCHERS[system] && (e.kind === 'parse' || e.kind === 'notfound') && system !== 'jobbank' && isAllowedUrl(link)) {
        let q = null;
        try {
          q = await fetchPage(link, info, f, system);
        } catch (e2) {
          if (!(e2 instanceof FetchError)) throw toPublicError(system, unexpected(e2));
        }
        if (q) return done(q);
      }
      throw toPublicError(system, e);
    }
    return done(p);
  }

  return {
    USER_AGENT, SYSTEMS, ALLOWED_HOSTS,
    detect, systemOf: (url) => classify(url)[0], isAllowedUrl, fetchPosting,
    fromText, parseJsonLd, parseJobBank, finish,
    cleanText, htmlToText, unescapeHtml, isoDate, payFromText, deadlineFromText, companyFromUrl,
    writtenQuestions, questionLine, coverLetter, splitSentences,
    _internal: { classify, leverForm, question, fromTextRaw, parseJsonLdRaw, parseJobBankRaw, finishRaw, coverLetterRaw, rx, urlsplit, parseQs, quote, hintFor },
  };
});
