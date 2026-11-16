// Job fit score: how well a posting fits the user, 0-100, with the reasons
// behind the number. A faithful port of the Autonomous Job Kit's
// internship-application/scripts/rank_jobs.py (MIT, same author): same
// weights, vocabulary, regexes and edge cases, checked against the Python by
// tests/unit/fit.test.js.
//
//   title       0-30  the title matches one of the user's tracks (search.tracks), weighted by that track's priority
//   skills      0-30  the share of the posting's tools and skills that also appear in the master resume
//   location    0-12  near home (local_places) > same province/state/region > remote in the country > elsewhere in it
//   experience  0-20  years of experience the posting asks for (2 or fewer is full marks, more than 5 is none)
//   recency     0-8   newer postings first
//
// Flags are sentences worth a look before applying (citizenship, clearance,
// P.Eng., co-op only, French, pathway checks...); they never change the score.
//
// Pure (no file or network access). The UK sponsor register and the scam
// checks that the Python loads itself are passed in through score()'s options.
// Loads as CommonJS or as a browser global (CoreFit).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CoreFit = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // ---------- Python regex semantics ----------
  // Python's str patterns are Unicode-aware: \w is any letter, number or "_",
  // \d any decimal digit, \s includes \x1c-\x1f and \x85, and \b uses that \w.
  // JS's are ASCII, so py() rewrites them and adds the u flag (which also makes
  // counts like [^.]{0,80} count code points, as Python does).
  const W = '\\p{L}\\p{N}_';
  const WS = '\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
  const BOUNDARY = `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))`;
  function py(src, flags = '') {
    let out = '';
    let inClass = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') {
        const n = src[++i];
        if (n === 'b' && !inClass) out += BOUNDARY;
        else if (n === 'w') out += inClass ? W : `[${W}]`;
        else if (n === 's') out += inClass ? WS : `[${WS}]`;
        else if (n === 'd') out += '\\p{Nd}';
        else out += '\\' + n;
        continue;
      }
      if (c === '[' && !inClass) inClass = true;
      else if (c === ']' && inClass) inClass = false;
      out += c;
    }
    return new RegExp(out, flags + 'u');
  }
  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const WS_EDGE = new RegExp(`^[${WS}]+|[${WS}]+$`, 'gu');
  const pyStrip = (s) => String(s).replace(WS_EDGE, '');
  const WS_RUN = new RegExp(`[${WS}]+`, 'gu');
  const collapse = (s) => String(s).replace(WS_RUN, ' ');

  // Any Unicode decimal digit to ASCII, as Python's int() and float() read them.
  // Nd digits come in runs of 0-9, so a digit's value is its place in its run.
  const ND = /\p{Nd}/u;
  function asciiDigits(s) {
    return String(s).replace(/\p{Nd}/gu, (ch) => {
      let cp = ch.codePointAt(0);
      if (cp >= 48 && cp <= 57) return ch;
      let run = 0;
      while (ND.test(String.fromCodePoint(cp - 1))) { cp--; run++; }
      return String(run % 10);
    });
  }

  // Python's round(): halves go to the even neighbour (22.5 -> 22, 7.5 -> 8).
  function pyRound(x) {
    const f = Math.floor(x);
    const d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
  }

  // Python's int() of a JSON value (int('45000'), int(45000.9) -> 45000); null when it would raise.
  function pyInt(v) {
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
    if (typeof v === 'string') {
      const s = asciiDigits(pyStrip(v));
      return /^[+-]?\d+(?:_\d+)*$/.test(s) ? parseInt(s.replace(/_/g, ''), 10) : null;
    }
    return null;
  }

  const withCommas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  // Slices by code point, as Python indexes strings (JS indexes UTF-16 units).
  const cpBefore = (s, end, n) => Array.from(s.slice(Math.max(0, end - 2 * n - 2), end)).slice(-n).join('');
  const cpAfter = (s, start, n) => Array.from(s.slice(start, start + 2 * n)).slice(0, n).join('');

  // ---------- html.unescape ----------
  // Python's html.unescape with a subset of the HTML5 table: all 106 legacy
  // names (which also match without ";", like "&amp" or "&copy2026") and the
  // common punctuation, currency and symbol names.
  const LEGACY = {};
  'Aacute=c1 aacute=e1 Acirc=c2 acirc=e2 acute=b4 AElig=c6 aelig=e6 Agrave=c0 agrave=e0 AMP=26 amp=26 Aring=c5 aring=e5 Atilde=c3 atilde=e3 Auml=c4 auml=e4 brvbar=a6 Ccedil=c7 ccedil=e7 cedil=b8 cent=a2 COPY=a9 copy=a9 curren=a4 deg=b0 divide=f7 Eacute=c9 eacute=e9 Ecirc=ca ecirc=ea Egrave=c8 egrave=e8 ETH=d0 eth=f0 Euml=cb euml=eb frac12=bd frac14=bc frac34=be GT=3e gt=3e Iacute=cd iacute=ed Icirc=ce icirc=ee iexcl=a1 Igrave=cc igrave=ec iquest=bf Iuml=cf iuml=ef laquo=ab LT=3c lt=3c macr=af micro=b5 middot=b7 nbsp=a0 not=ac Ntilde=d1 ntilde=f1 Oacute=d3 oacute=f3 Ocirc=d4 ocirc=f4 Ograve=d2 ograve=f2 ordf=aa ordm=ba Oslash=d8 oslash=f8 Otilde=d5 otilde=f5 Ouml=d6 ouml=f6 para=b6 plusmn=b1 pound=a3 QUOT=22 quot=22 raquo=bb REG=ae reg=ae sect=a7 shy=ad sup1=b9 sup2=b2 sup3=b3 szlig=df THORN=de thorn=fe times=d7 Uacute=da uacute=fa Ucirc=db ucirc=fb Ugrave=d9 ugrave=f9 uml=a8 Uuml=dc uuml=fc Yacute=dd yacute=fd yen=a5 yuml=ff'
    .split(' ').forEach((p) => { const [k, v] = p.split('='); LEGACY[k] = String.fromCodePoint(parseInt(v, 16)); });
  const SEMI = {}; // names that only work with ";"
  'af=2061 angst=c5 ap=2248 approx=2248 asymp=2248 backprime=2035 bdquo=201e bigstar=2605 bprime=2035 bsemi=204f bull=2022 bullet=2022 caret=2041 Cedilla=b8 CenterDot=b7 centerdot=b7 check=2713 checkmark=2713 circ=2c6 circledR=ae cross=2717 Dagger=2021 dagger=2020 darr=2193 dash=2010 ddagger=2021 die=a8 div=f7 Dot=a8 DoubleDot=a8 DownArrow=2193 downarrow=2193 emsp13=2004 emsp14=2005 emsp=2003 ensp=2002 euro=20ac fnof=192 frasl=2044 ge=2265 geq=2265 hairsp=200a half=bd harr=2194 hellip=2026 horbar=2015 hybull=2043 hyphen=2010 ic=2063 infin=221e it=2062 larr=2190 ldquo=201c ldquor=201e le=2264 LeftArrow=2190 leftarrow=2190 leq=2264 lrm=200e lsaquo=2039 lsquo=2018 lsquor=201a mdash=2014 minus=2212 mldr=2026 ndash=2013 ne=2260 nldr=2025 NoBreak=2060 NotEqual=2260 numero=2116 numsp=2007 OElig=152 oelig=153 oline=203e OverBar=203e permil=2030 pertenk=2031 PlusMinus=b1 pm=b1 Prime=2033 prime=2032 puncsp=2008 qprime=2057 rarr=2192 rdquo=201d rdquor=201d rlm=200f rsaquo=203a rsquo=2019 rsquor=2019 sbquo=201a Scaron=160 scaron=161 slarr=2190 squarf=25aa squf=25aa srarr=2192 starf=2605 strns=af thinsp=2009 ThinSpace=2009 thkap=2248 tilde=2dc tprime=2034 TRADE=2122 trade=2122 uarr=2191 UpArrow=2191 uparrow=2191 Verbar=2016 Vert=2016 Yuml=178 zwj=200d zwnj=200c apos=27 Tab=9 NewLine=a'
    .split(' ').forEach((p) => { const [k, v] = p.split('='); SEMI[k] = String.fromCodePoint(parseInt(v, 16)); });
  const INVALID_CHARREFS = {};
  '0=fffd d=d 80=20ac 81=81 82=201a 83=192 84=201e 85=2026 86=2020 87=2021 88=2c6 89=2030 8a=160 8b=2039 8c=152 8d=8d 8e=17d 8f=8f 90=90 91=2018 92=2019 93=201c 94=201d 95=2022 96=2013 97=2014 98=2dc 99=2122 9a=161 9b=203a 9c=153 9d=9d 9e=17e 9f=178'
    .split(' ').forEach((p) => { const [k, v] = p.split('='); INVALID_CHARREFS[parseInt(k, 16)] = String.fromCodePoint(parseInt(v, 16)); });
  const invalidCodepoint = (n) => (n >= 0x1 && n <= 0x8) || n === 0xb || (n >= 0xe && n <= 0x1f) || (n >= 0x7f && n <= 0x9f)
    || (n >= 0xfdd0 && n <= 0xfdef) || (n & 0xfffe) === 0xfffe;
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const CHARREF = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/gu;
  function unescapeHtml(s) {
    if (!s.includes('&')) return s;
    return s.replace(CHARREF, (all, ref) => {
      if (ref[0] === '#') {
        const num = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2).replace(/;$/, ''), 16) : parseInt(ref.slice(1).replace(/;$/, ''), 10);
        if (has(INVALID_CHARREFS, num)) return INVALID_CHARREFS[num];
        if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return '�';
        if (invalidCodepoint(num)) return '';
        return String.fromCodePoint(num);
      }
      if (ref.endsWith(';')) {
        const base = ref.slice(0, -1);
        if (has(LEGACY, base)) return LEGACY[base];
        if (has(SEMI, base)) return SEMI[base];
      } else if (has(LEGACY, ref)) return LEGACY[ref];
      const cps = Array.from(ref);
      for (let x = cps.length - 1; x > 1; x--) {
        const name = cps.slice(0, x).join('');
        if (has(LEGACY, name)) return LEGACY[name] + cps.slice(x).join('');
      }
      return '&' + ref;
    });
  }

  /** Plain lower-case text from HTML, LaTeX or markdown (rank_jobs.text_of). */
  function textOf(s) {
    s = unescapeHtml(unescapeHtml(String(s || '')));
    s = s.replace(/<[^>]+>/g, ' ');
    s = s.replace(/\\[a-zA-Z]+\*?/g, ' ').split('\\&').join('&').split('\\%').join('%');
    return collapse(s).toLowerCase();
  }

  // ---------- vocabulary ----------
  const VOCAB = Object.freeze([
    // engineering and energy
    'mechanical engineering', 'energy modelling', 'energy modeling', 'building energy modelling', 'building energy modeling',
    'designbuilder', 'energyplus', 'openstudio', 'wufi', 'retscreen', 'homer', 'pvsyst', 'helioscope', 'ies ve', 'hvac', 'ashrae',
    'bcbc', 'vbbl', 'step code', 'building science', 'building envelope', 'thermodynamics', 'heat transfer', 'fluid mechanics',
    'cfd', 'fea', 'ansys', 'autocad', 'solidworks', 'revit', 'inventor', 'matlab', 'simulink', 'solar', 'photovoltaic', 'pv',
    'battery', 'batteries', 'energy storage', 'bess', 'grid', 'distributed energy', 'der', 'microgrid', 'ieee 2030.5', 'modbus',
    'scada', 'plc', 'iot', 'inverter', 'renewable energy', 'renewables', 'wind', 'hydro', 'hydrogen', 'electrification',
    'heat pump', 'energy efficiency', 'energy audit', 'energy management', 'iso 50001', 'sustainability', 'ghg', 'carbon',
    'emissions', 'decarbonization', 'lca', 'life cycle assessment', 'esg', 'commissioning', 'preventive maintenance',
    'maintenance', 'troubleshooting', 'p.eng', 'eit', 'egbc', 'technical reporting', 'feasibility',
    // data and software
    'python', 'sql', 'excel', 'power bi', 'tableau', 'looker', 'pandas', 'numpy', 'matplotlib', 'scikit-learn', 'tensorflow',
    'pytorch', 'machine learning', 'deep learning', 'statistics', 'statistical analysis', 'data analysis', 'data analytics',
    'data cleaning', 'data validation', 'data quality', 'data governance', 'data modeling', 'data modelling', 'etl',
    'data pipelines', 'data warehouse', 'snowflake', 'dbt', 'airflow', 'spark', 'aws', 'azure', 'gcp', 'docker', 'kubernetes',
    'git', 'github', 'javascript', 'typescript', 'node.js', 'react', 'flask', 'django', 'fastapi', 'rest api', 'rest apis',
    'api', 'apis', 'java', 'c++', 'c#', 'linux', 'bash', 'sqlite', 'postgresql', 'mysql', 'mongodb', 'pytest', 'unit testing',
    'automation', 'web scraping', 'vba', 'macros', 'google sheets', 'power query', 'dax', 'kpi', 'kpis', 'dashboards',
    'dashboard', 'business intelligence', 'reporting',
    // business, governance and operations
    'governance', 'compliance', 'risk management', 'risk register', 'internal controls', 'internal audit', 'audit', 'cobit',
    'coso', 'iso 27001', 'policy', 'records management', 'regulatory', 'confidential', 'project management', 'agile', 'scrum',
    'stakeholder', 'process improvement', 'documentation', 'microsoft office', 'word', 'sharepoint', 'confluence', 'jira',
    'salesforce', 'hubspot', 'zendesk', 'servicenow', 'freshdesk', 'crm', 'sap', 'erp', 'data entry', 'customer service',
    'customer support', 'technical support', 'pos', 'inventory', 'logistics', 'shipping',
  ]);
  // Words too ambiguous to count as skills on their own in a posting ("word" as in "word of mouth")
  const WEAK = new Set(['word', 'api', 'apis', 'pos', 'policy', 'documentation', 'grid', 'wind', 'hydro', 'reporting', 'maintenance', 'audit']);
  const VARIANTS = [['energy modeling', 'energy modelling'], ['building energy modeling', 'building energy modelling'],
    ['data modelling', 'data modeling'], ['rest apis', 'rest api'], ['apis', 'api'], ['kpis', 'kpi'],
    ['dashboards', 'dashboard'], ['batteries', 'battery'], ['renewables', 'renewable energy']];

  const wholeWordCache = new Map();
  function wholeWord(phrase) {
    let rx = wholeWordCache.get(phrase);
    if (!rx) {
      rx = new RegExp('(?<![a-z0-9])' + escapeRe(phrase) + '(?![a-z0-9])', 'u');
      if (wholeWordCache.size > 2000) wholeWordCache.clear();
      wholeWordCache.set(phrase, rx);
    }
    return rx;
  }

  // search.json "extra_skills" as the kit's load_search() adds them to VOCAB.
  function extraSkills(list) {
    const out = [];
    for (const t0 of Array.isArray(list) ? list : []) {
      const t = pyStrip(String(t0)).toLowerCase();
      if (t && !VOCAB.includes(t) && !out.includes(t)) out.push(t);
    }
    return out;
  }

  /** Skills from VOCAB (plus extra skills) found in the text, spelling variants counted once. Returns a Set.
   *  The text is lower-cased first (the Python callers always pass text_of() output, which already is). */
  function termsIn(text, extra = []) {
    const low = String(text ?? '').toLowerCase();
    const found = new Set();
    for (const t of VOCAB.concat(extraSkills(extra))) if (wholeWord(t).test(low)) found.add(t);
    for (const [a, b] of VARIANTS) {
      if (found.has(a)) { found.delete(a); found.add(b); }
    }
    return found;
  }

  /** phrase appears in text as whole words ("der" doesn't match "order", "eit" doesn't match "reit"). */
  function wordsIn(phrase, text) {
    const p = pyStrip(phrase);
    return Boolean(p) && wholeWord(p).test(String(text));
  }

  const normTitle = (title) => collapse(String(title || '').toLowerCase());

  /** The best track for a job title: { track, priority } ({ track: null, priority: 0 } when none fits). */
  function bestTrack(title, search) {
    const t = normTitle(title);
    let best = { track: null, priority: 0 };
    const tracks = (search && search.tracks) || {};
    for (const [name, tr0] of Object.entries(tracks)) {
      const tr = tr0 || {};
      const prio = tr.priority === undefined ? 0.5 : tr.priority;
      const titles = Array.isArray(tr.titles) ? tr.titles : [];
      if (titles.some((k) => wordsIn(String(k).toLowerCase(), t)) && prio > best.priority) {
        best = { track: name, priority: Number(prio) };
      }
    }
    return best;
  }

  /** The search.exclude_titles word found in the title ("senior", "manager"...), or null. */
  function excluded(title, search) {
    const t = normTitle(title);
    const words = (search && Array.isArray(search.exclude_titles)) ? search.exclude_titles : [];
    const hit = words.find((w) => wordsIn(String(w).toLowerCase().replace(/\.+$/, ''), t));
    return hit === undefined ? null : hit;
  }

  // ---------- location ----------
  const CANADA = py(String.raw`\bcanada\b|\bcanadian\b|\b(ontario|quebec|québec|british columbia|alberta|manitoba|saskatchewan|nova scotia|` +
    String.raw`new brunswick|newfoundland|prince edward island|yukon|nunavut|northwest territories)\b|` +
    String.raw`[,(]\s*(on|bc|qc|ab|mb|sk|ns|nb|nl|pe|yt|nu|nt)\b\)?|\b(toronto|vancouver|montreal|montréal|ottawa|` +
    String.raw`calgary|edmonton|waterloo|burnaby|surrey|winnipeg|halifax|mississauga|markham|kelowna|kitchener|` +
    String.raw`victoria, bc|richmond, bc|regina|saskatoon|quebec city|gatineau)\b`, 'i');
  const US_STATE = py(String.raw`,\s*(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|` +
    String.raw`OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b`);
  const ELSEWHERE = py(String.raw`\b(united states|usa|u\.s\.|uk|united kingdom|england|ireland|germany|france|netherlands|spain|portugal|` +
    String.raw`poland|india|china|japan|singapore|australia|mexico|brazil|colombia|argentina|chile|costa rica|` +
    String.raw`philippines|israel|emea|apac|latam|europe|london|dublin|berlin|amsterdam|paris|bangalore|bengaluru|` +
    String.raw`sydney|tokyo|new york|san francisco|seattle|austin|chicago|boston)\b`, 'i');
  const PROVINCE_NAMES = { on: 'ontario', qc: 'quebec', bc: 'british columbia', ab: 'alberta', mb: 'manitoba',
    sk: 'saskatchewan', ns: 'nova scotia', nb: 'new brunswick', nl: 'newfoundland',
    pe: 'prince edward island', yt: 'yukon', nu: 'nunavut', nt: 'northwest territories' };
  const US_STATE_NAMES = py(String.raw`\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|` +
    String.raw`idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|` +
    String.raw`minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|` +
    String.raw`new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|` +
    String.raw`south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|` +
    String.raw`wisconsin|wyoming|district of columbia)\b`, 'i');
  const USA = py(String.raw`\b(united states|usa|u\.s\.a?\.?|us only|us-remote|remote,? us\b|san francisco|new york|seattle|austin|chicago|` +
    String.raw`boston|los angeles|atlanta|denver|dallas|houston|miami|philadelphia|washington,? d\.?c\.?|bay area)\b`, 'i');
  const UK = py(String.raw`\b(united kingdom|uk|u\.k\.|great britain|britain|england|scotland|wales|northern ireland|london|manchester|` +
    String.raw`birmingham|leeds|glasgow|edinburgh|bristol|cardiff|belfast|liverpool|newcastle|sheffield|nottingham|` +
    String.raw`cambridge|oxford|reading|milton keynes|leicester|southampton|brighton|aberdeen|coventry)\b`, 'i');
  const US_STATE_CODES = {};
  'al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy dc'
    .split(' ').forEach((c, i) => {
      US_STATE_CODES[c] = ['alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida', 'georgia',
        'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland',
        'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire',
        'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania',
        'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington',
        'west virginia', 'wisconsin', 'wyoming', 'district of columbia'][i];
    });
  const COUNTRIES = {
    CA: { name: 'Canada' },
    US: { name: 'the US' },
    GB: { name: 'the UK' },
  };
  const COUNTRY_ALIASES = { canada: 'CA', ca: 'CA', 'united states': 'US', usa: 'US', us: 'US', 'u.s.': 'US', america: 'US',
    'united kingdom': 'GB', uk: 'GB', gb: 'GB', 'great britain': 'GB', britain: 'GB', england: 'GB',
    scotland: 'GB', wales: 'GB', 'northern ireland': 'GB' };

  /** search.country as CA, US or GB (default CA, the kit's original setting). */
  function countryCode(search) {
    const key = pyStrip(String((search && search.country) || 'Canada')).toLowerCase();
    return has(COUNTRY_ALIASES, key) ? COUNTRY_ALIASES[key] : 'CA';
  }

  function inCountry(code, loc) {
    loc = String(loc);
    const low = loc.toLowerCase();
    const canada = CANADA.test(low);
    const us = US_STATE.test(loc) || US_STATE_NAMES.test(low) || USA.test(low);
    if (code === 'CA') return canada && !(us && !canada);
    if (code === 'US') {
      // ", CA" is California here; a Canadian province or "Canada" alone isn't the US
      return us && !(canada && !(US_STATE.test(loc) || USA.test(low)));
    }
    if (code === 'GB') return UK.test(loc);
    return false;
  }

  const REMOTE = py(String.raw`\b(remote|anywhere|work from home|telework|home[- ]based)\b`);
  const REMOTE_OTHER = py(String.raw`\bremote\s*[-–:,]\s*\w`);
  const PLACE_SPLIT = py(String.raw`[;|]|\s/\s`, 'g');
  const RANKS = { local: 5, region: 4, 'remote-country': 3, country: 2, remote: 1 };

  function onePlace(loc, search) {
    const low = loc.toLowerCase();
    const code = countryCode(search);
    const region = pyStrip(String(search.province || search.state || search.region || '').toLowerCase());
    const inside = inCountry(code, loc);
    const remote = REMOTE.test(low);
    const locals = Array.isArray(search.local_places) ? search.local_places : [];
    if (inside && locals.some((p) => new RegExp('(?<![a-z])' + escapeRe(p) + '(?![a-z])(?! hill)', 'u').test(low))) return 'local';
    if (inside && region) {
      const names = { CA: PROVINCE_NAMES, US: US_STATE_CODES }[code] || {};
      const name = has(names, region) ? names[region] : '';
      const regionLen = Array.from(region).length;
      if ((regionLen <= 3 && py(String.raw`[,(]\s*` + escapeRe(region) + String.raw`\b`).test(low))
        || (name && low.includes(name)) || (regionLen > 3 && low.includes(region))) return 'region';
    }
    if (inside) return remote ? 'remote-country' : 'country';
    if (remote && !ELSEWHERE.test(low) && !REMOTE_OTHER.test(low)) return 'remote'; // "Remote" with no country
    return null;
  }

  /** local, region, remote-country, country, remote, or null when it isn't in the search country (or doesn't say).
   *  A location listing several places counts by its best one ("Remote, Canada; Remote, United States"). */
  function placeFit(location, search) {
    search = search || {};
    const loc = String(location ?? '');
    let places = loc.split(PLACE_SPLIT).filter((p) => pyStrip(p));
    if (!places.length) places = [loc];
    let best = null;
    for (const p of places) {
      const r = onePlace(p, search);
      if (r && (best === null || RANKS[r] > RANKS[best])) best = r;
    }
    return best;
  }

  // ---------- pay, experience, flags ----------
  const NOC = py(String.raw`\bnoc\b(?:\s*2021)?[^0-9]{0,25}(\d{5})\b`, 'i');
  const MONEY = py(String.raw`(?:£|\$|us\$|c\$|cad\s?|gbp\s?|usd\s?)\s?(\d{1,3}(?:,\d{3})+|\d{2,3}(?:\.\d)?\s?k|\d{4,6})(?!\d)`, 'gi');
  const PER_TIME = py(String.raw`^\s*(/|per|an|a)\s*(hour|hr|h\b|day|week|month)`);

  /** The highest yearly amount the text names ("£38,000 - £45,000" -> 45000), or null. Hourly pay is skipped. */
  function salaryMax(text) {
    text = String(text ?? '');
    const vals = [];
    for (const m of text.matchAll(MONEY)) {
      const after = cpAfter(text, m.index + m[0].length, 25).toLowerCase();
      if (PER_TIME.test(after)) continue;
      const raw = asciiDigits(m[1].toLowerCase().split(',').join('').split(' ').join(''));
      const v = raw.endsWith('k') ? parseFloat(raw.slice(0, -1)) * 1000 : parseFloat(raw);
      if (v >= 10000 && v <= 1000000) vals.push(Math.trunc(v));
    }
    return vals.length ? Math.max(...vals) : null;
  }

  const SENIOR_YEARS = py(String.raw`(\d{1,2})\s*\+?\s*(?:-|–|to)?\s*(?:\d{1,2}\s*)?(?:\+\s*)?years?(?:'|’)?\s+(?:of\s+)?` +
    String.raw`(?:[a-z/&,-]+\s+){0,6}?(?:experience|exp\b)`, 'gi');
  const DATES = py(String.raw`\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b`, 'g');

  /** The fewest years of experience the text asks for (up to 20), or null. */
  function yearsRequired(text) {
    // Dates ("Posted: 2026-09-01") would otherwise lend their last digits to "8+ years" and read as "01 ... years"
    text = String(text ?? 'None').replace(DATES, ' ');
    const nums = [];
    for (const m of text.matchAll(SENIOR_YEARS)) {
      const n = parseInt(asciiDigits(m[1]), 10);
      if (n <= 20) nums.push(n);
    }
    return nums.length ? Math.min(...nums) : null;
  }

  const ENTRY = py(String.raw`\b(new grad|new graduate|recent graduate|entry[- ]level|junior|jr\.?|graduate engineer|engineer in training|` +
    String.raw`eit\b|intern|internship|co-?op|student|trainee|associate|level i\b|level 1\b)`, 'i');
  const FLAGS = [
    ['citizenship or permanent residence', py(String.raw`\b(canadian citizens?(hip)?|permanent residen\w*)\b[^.]{0,80}\b(required|must|only|eligible)\b|` +
      String.raw`\b(must|required to) be (a )?(canadian citizen|permanent resident)`, 'i')],
    ['U.S. work authorization', py(String.raw`\b(us|u\.s\.|united states) (citizen\w*|work authori[sz]ation|persons?)\b`, 'i')],
    ['no visa sponsorship', py(String.raw`\b(unable|not able|cannot|can't|do not|don't|will not|won't|not)\b[^.]{0,30}\b(offer|provide|sponsor)\w*\b[^.]{0,30}\b(sponsor\w*|visas?|work permits?)\b|` +
      String.raw`\bno (visa )?sponsorship\b|\bsponsorship (is )?not (available|offered|provided)\b`, 'i')],
    ['visa sponsorship mentioned', py(String.raw`\b(visa|skilled worker|h-?1b|work permit|lmia) sponsorship (is )?(available|offered|provided|considered)\b|` +
      String.raw`\b(we|will|can) (offer|provide|consider) (visa )?sponsorship\b|\bcertificate of sponsorship\b`, 'i')],
    ['UK right to work', py(String.raw`\bright to work in the (uk|united kingdom)\b`, 'i')],
    ['security clearance', py(String.raw`\b(secret|reliability|enhanced reliability|security) (clearance|status|screening)\b`, 'i')],
    ['P.Eng. required', py(String.raw`\bp\.? ?eng\.?\b[^.]{0,60}\b(required|must|designation)\b|\b(registered|licensed) professional engineer\b`, 'i')],
    ['co-op or student only', py(String.raw`\b(must be|currently) (enrolled|registered)\b|\bco-?op (program|students?|term|placement)\b|` +
      String.raw`\breturning to (full-time )?(school|studies)\b`, 'i')],
    ['French required', py(String.raw`\b(bilingual|french)\b[^.]{0,40}\b(required|must|essential|an asset)\b`, 'i')],
    ["driver's licence", py(String.raw`\bdriver'?s licen[cs]e\b|\bclass 5\b`, 'i')],
    // Users aiming for permanent residence often need a permanent full-time role; a temporary one is worth a look first.
    ['temporary or contract', py(String.raw`\b(temporary|fixed[- ]term|term position|\d{1,2}[- ]month (contract|term)|contract (role|position)|` +
      String.raw`maternity leave|parental leave|seasonal)\b`, 'i')],
  ];
  const COOP_TITLE = py(String.raw`\bco-?op\b`, 'i');
  const PART_TIME = py(String.raw`\bpart[- ]time\b`);
  const FULL_TIME = py(String.raw`\bfull[- ]time\b`);

  // ---------- UK sponsor register (sponsor_check.py's norm() and check()) ----------
  const SPONSOR_SUFFIX = py(String.raw`\b(the|ltd|limited|plc|llp|lp|llc|inc|incorporated|corp|corporation|company|co|group|holdings|` +
    String.raw`uk|u k|gb|international|services|t a|trading as)\b`, 'g');
  /** A company name as the register is keyed: lower case, no punctuation, no Ltd/PLC/Group/UK/The... */
  function sponsorNorm(name) {
    const s = String(name || '').toLowerCase().split('&').join(' and ').replace(/[^a-z0-9]+/g, ' ');
    return pyStrip(collapse(s.replace(SPONSOR_SUFFIX, ' ')));
  }
  /** register: Map or object { normalizedName: [{ name, town, route, rating }] } -> { company, status, entries }. */
  function sponsorCheck(company, register) {
    const key = sponsorNorm(company);
    const items = register instanceof Map ? [...register.entries()] : Object.entries(register || {});
    if (!key) return { company, status: 'not found', entries: [] };
    const hit = items.find(([k]) => k === key);
    if (hit) return { company, status: 'listed', entries: (hit[1] || []).slice(0, 5) };
    if (Array.from(key).length >= 4) {
      const near = [];
      for (const [k, v] of items) if (k.startsWith(key + ' ') || key.startsWith(k + ' ')) near.push(...(v || []));
      if (near.length) return { company, status: 'possible', entries: near.slice(0, 5) };
    }
    return { company, status: 'not found', entries: [] };
  }
  const NO_REGISTER = 'no sponsor register loaded';
  // options.sponsors -> a check result, or a string saying why the register couldn't be checked.
  function checkSponsor(company, sponsors) {
    if (sponsors === undefined || sponsors === null) return NO_REGISTER;
    if (typeof sponsors === 'string') return sponsors;
    if (typeof sponsors === 'function') {
      const r = sponsors(company);
      if (r && typeof r === 'object') return { company, status: r.status || 'not found', entries: r.entries || [], noRoutes: !r.entries };
      return { company, status: r ? 'listed' : 'not found', entries: [], noRoutes: true };
    }
    if (sponsors instanceof Set) {
      const reg = new Map([...sponsors].map((k) => [k, [{ name: k, route: '' }]]));
      return { ...sponsorCheck(company, reg), noRoutes: true }; // a Set knows names only, not routes
    }
    return sponsorCheck(company, sponsors);
  }

  /** Flags for the user's immigration pathway (search.pathway). Checks only: never change the score or decide eligibility. */
  function pathwayFlags(posting, desc, search, options = {}) {
    search = search || {};
    const pw = (search.pathway && typeof search.pathway === 'object') ? search.pathway : {};
    const kind = String(pw.type || '').toLowerCase();
    if (!kind || kind === 'none') return [];
    const out = [];
    const code = countryCode(search);
    // NOC 2021: the second digit of the five-digit code is the TEER (21231 -> TEER 1). Job Bank postings print the code.
    const m = desc.match(NOC);
    const noc = m ? asciiDigits(m[1]) : null;
    if (m && code === 'CA') {
      const teer = parseInt(noc[1], 10);
      const ok = teer <= 3;
      const note = ok || !kind.startsWith('ca-cec') ? '' : '; CEC counts TEER 0-3 work only';
      out.push(`pathway: NOC ${m[1]} is TEER ${teer}${note} (from the posting; confirm on the NOC site)`);
    } else if (code === 'CA' && kind.startsWith('ca-')) {
      out.push('pathway: no NOC code in the posting; Claude gives the likely NOC and TEER at the checkpoint (confirm on the NOC site)');
    }
    if (code === 'CA' && kind.startsWith('ca-') && PART_TIME.test(desc) && !FULL_TIME.test(desc)) {
      out.push('pathway: part-time; programs count hours, so check how this adds up for you');
    }
    if (pw.requireSponsor || kind === 'uk-skilled-worker' || kind === 'us-h1b') {
      if (code === 'GB' && posting.company) {
        const company = posting.company;
        const r = checkSponsor(company, options.sponsors);
        if (typeof r !== 'string') {
          const routes = [...new Set(r.entries.map((e) => (e && e.route) || ''))].sort().slice(0, 3);
          if (r.status === 'listed') {
            out.push(`pathway: ${company} is on the UK sponsor register` + (r.noRoutes ? '' : ` (${routes.join(', ')})`));
          } else if (r.status === 'possible') {
            out.push(`pathway: a similar name is on the UK sponsor register (${r.entries[0].name}): check it is this employer`);
          } else {
            out.push(`pathway: ${company} not found on the UK sponsor register (it may sponsor under another legal name: check)`);
          }
        } else {
          out.push(`pathway: couldn't check the UK sponsor register (${r})`);
        }
      }
    }
    const lowPay = pyInt(pw.minSalary || 0) || 0;
    const top = salaryMax(desc);
    if (lowPay && top && top < lowPay) {
      out.push(`pathway: posted pay tops out at ${withCommas(top)}, below your minimum of ${withCommas(lowPay)} (search.json pathway.minSalary)`);
    } else if (lowPay && !top && kind === 'uk-skilled-worker') {
      out.push('pathway: no yearly salary in the posting; Skilled Worker needs the salary to meet the thresholds: ask or check');
    }
    const codes = (Array.isArray(pw.eligibleCodes) ? pw.eligibleCodes : []).map(String);
    if (codes.length && m && !codes.includes(m[1])) out.push(`pathway: NOC ${m[1]} is not in your eligibleCodes list`);
    return out;
  }

  // ---------- dates (Python's date.fromisoformat, C implementation) ----------
  const isLeap = (y) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const DIM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  function daysFromCivil(y, m, d) { // days since 1970-01-01, proleptic Gregorian
    y -= m <= 2 ? 1 : 0;
    const era = Math.floor(y / 400);
    const yoe = y - era * 400;
    const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
  }
  function utf8Length(s) {
    let n = 0;
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (c >= 0xd800 && c <= 0xdfff) return -1; // lone surrogate: Python can't encode it
      n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    }
    return n;
  }
  /** Days since 1970-01-01 for an ISO date string, or null where Python's date.fromisoformat raises. */
  function isoDay(s) {
    const len = utf8Length(s);
    if (len !== 7 && len !== 8 && len !== 10) return null;
    let p = 0;
    const digits = (n) => {
      let v = 0;
      for (let i = 0; i < n; i++) {
        const c = s.charCodeAt(p);
        if (!(c >= 48 && c <= 57)) return null;
        v = v * 10 + (c - 48);
        p++;
      }
      return v;
    };
    const year = digits(4);
    if (year === null) return null;
    const sep = s[p] === '-';
    if (sep) p++;
    if (s[p] === 'W') {
      p++;
      const week = digits(2);
      if (week === null) return null;
      let day = 1;
      if (p < len) {
        if (sep && s[p++] !== '-') return null;
        day = digits(1);
        if (day === null) return null;
      }
      if (year < 1 || year > 9999) return null;
      const jan1 = daysFromCivil(year, 1, 1);
      if (week <= 0 || week >= 53) {
        const firstWeekday = ((jan1 + 3) % 7 + 7) % 7; // Monday 0; 1970-01-01 was a Thursday
        if (!(week === 53 && (firstWeekday === 3 || (firstWeekday === 2 && isLeap(year))))) return null;
      }
      if (day <= 0 || day >= 8) return null;
      const jan1Weekday = ((jan1 + 3) % 7 + 7) % 7;
      let week1Monday = jan1 - jan1Weekday;
      if (jan1Weekday > 3) week1Monday += 7;
      const out = week1Monday + (week - 1) * 7 + day - 1;
      const max = daysFromCivil(9999, 12, 31);
      const min = daysFromCivil(1, 1, 1);
      return out < min || out > max ? null : out;
    }
    const month = digits(2);
    if (month === null) return null;
    if (sep && s[p++] !== '-') return null;
    const day = digits(2);
    if (day === null) return null;
    if (year < 1 || year > 9999 || month < 1 || month > 12) return null;
    const dim = month === 2 && isLeap(year) ? 29 : DIM[month - 1];
    if (day < 1 || day > dim) return null;
    return daysFromCivil(year, month, day);
  }
  function todayDay(today) {
    if (today instanceof Date) return daysFromCivil(today.getFullYear(), today.getMonth() + 1, today.getDate());
    if (typeof today === 'string') {
      const d = isoDay(Array.from(today).slice(0, 10).join(''));
      if (d === null) throw new Error(`fit.score: today must be an ISO date, got ${JSON.stringify(today)}`);
      return d;
    }
    return todayDay(new Date());
  }

  // ---------- the score ----------
  const LOCATION_POINTS = { local: 12, region: 10, 'remote-country': 9, country: 5, remote: 4 };

  /**
   * posting: { role (or title), description (HTML or plain), location, posted (YYYY-MM-DD), company, url, pay }
   * master:  the master resume as plain text (or LaTeX/HTML)
   * search:  the kit's search.json object ({} works: no tracks gives 0 title points)
   * options: { today: 'YYYY-MM-DD' | Date, sponsors: register | Set | (name) => boolean | 'reason', redFlags: (text, { url, company, role }) => [{ flag, quote }] }
   */
  function score(posting, master, search, options = {}) {
    posting = posting || {};
    search = search || {};
    const today = todayDay(options.today);
    const title = posting.title || posting.role || '';
    const desc = textOf(posting.description || '');
    const full = textOf(title) + ' ' + desc;
    const parts = {};
    const reasons = [];

    const { track, priority } = bestTrack(title, search);
    parts.title = track ? pyRound(30 * priority) : 0;
    reasons.push(track ? `title fits ${track}` : 'title outside your tracks');

    const extra = search.extra_skills;
    const masterTerms = termsIn(textOf(master), extra);
    const postTerms = termsIn(full, extra);
    const strong = [...postTerms].filter((t) => !WEAK.has(t));
    const matched = strong.filter((t) => masterTerms.has(t)).sort();
    const gaps = strong.filter((t) => !masterTerms.has(t)).sort();
    if (strong.length >= 3) {
      const share = matched.length / (strong.length + 1.5); // "3 of 3" is weaker evidence than "12 of 13"
      parts.skills = pyRound(30 * Math.min(1.0, share * 1.2));
      reasons.push(`${matched.length} of ${strong.length} skills match`);
    } else {
      parts.skills = 13; // no description, or too little to judge
      reasons.push('skills unknown (short or no description)');
    }

    const fit = placeFit(posting.location || '', search);
    parts.location = fit ? LOCATION_POINTS[fit] : 0;
    const cname = COUNTRIES[countryCode(search)].name;
    reasons.push({ local: 'near home', region: 'in your province or region', 'remote-country': `remote in ${cname}`,
      country: `elsewhere in ${cname}`, remote: 'remote (country unclear)' }[fit] || `outside ${cname}`);

    const yrs = yearsRequired(desc);
    if (yrs === null) {
      parts.experience = ENTRY.test(String(title)) ? 20 : 14;
    } else {
      parts.experience = yrs <= 2 ? 20 : yrs === 3 ? 15 : yrs === 4 ? 8 : yrs === 5 ? 4 : 0;
      reasons.push(`asks for ${yrs}+ years`);
    }

    const posted = isoDay(Array.from(String(posting.posted ?? '')).slice(0, 10).join(''));
    if (posted === null) parts.recency = 3;
    else {
      const age = today - posted;
      parts.recency = age <= 3 ? 8 : age <= 7 ? 6 : age <= 14 ? 4 : age <= 30 ? 2 : 0;
    }

    const flags = [];
    if (COOP_TITLE.test(String(title))) { // co-op roles usually require enrolment in a school co-op program
      flags.push('co-op or student only: "co-op" in the title; usually needs enrolment in a school co-op program');
    }
    for (const [name, rx] of FLAGS) {
      if (flags.length && name === 'co-op or student only' && flags[0].startsWith(name)) continue;
      const m = rx.exec(desc);
      if (m) {
        const s = pyStrip(cpBefore(desc, m.index, 80) + m[0] + cpAfter(desc, m.index + m[0].length, 80));
        flags.push(`${name}: "...${s}..."`);
      }
    }
    flags.push(...pathwayFlags(posting, desc, search, options));
    if (typeof options.redFlags === 'function') { // scam warning signs; they don't change the score
      for (const r of options.redFlags(posting.description || '', { url: posting.url, company: posting.company, role: title }) || []) {
        flags.push(`scam warning: ${r.flag}: "${r.quote}"`);
      }
    }
    return {
      score: parts.title + parts.skills + parts.location + parts.experience + parts.recency,
      parts, track, place: fit, yearsRequired: yrs, matchedSkills: matched, gaps, flags,
      why: reasons.join('; '), reasons,
    };
  }

  return {
    score, termsIn, VOCAB, WEAK, yearsRequired, placeFit, salaryMax, bestTrack, excluded, textOf, wordsIn,
    countryCode, inCountry, pathwayFlags, sponsorNorm, sponsorCheck, COUNTRIES, NO_REGISTER,
    _internals: { py, pyRound, pyInt, isoDay, unescapeHtml, asciiDigits },
  };
});
