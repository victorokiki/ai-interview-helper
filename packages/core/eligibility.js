// Eligibility screen: does any sentence in a posting rule the user out (citizenship, visa, sponsorship,
// degree level)? Port of the Autonomous Job Kit's lib/jobkit/eligibility.py (MIT, same author).
//
//   screen(description, profile, { role, location, today }) ->
//     { screen: 'ok'|'check'|'skip', why: ['<sentence> -> <rule>'], check: ['<sentence>'], country, status }
//
// Principles
// - "skip" only when a sentence plainly rules this user out; "check" when a person should judge (vague, soft or
//   conditional wording, or the profile doesn't say enough); otherwise "ok". The sentences are always returned.
// - Sponsorship wording alone never skips a student below their final year (internships often need no
//   sponsorship, e.g. CPT in the US or a co-op work permit in Canada).
// - Alternatives such as "or authorized to work", "or legally entitled to work", "or eligible" never skip.
// - Equal-opportunity boilerplate ("without regard to citizenship status") is ignored.
// - Without a profile, restrictive sentences are "check", never "skip".
//
// Rules by country
// - US: F-1 / OPT / CPT excluded (user on F-1); US citizenship, permanent residence / green card, "US person"
//   (ITAR/EAR) or a security clearance required (user not a citizen / PR); graduate-students-only role (user is
//   an undergraduate).
// - Canada: Canadian citizens / permanent residents only (user is a temporary resident: study/work permit,
//   PGWP; "check" when the profile doesn't say).
// - UK: right to work in the UK / no visa sponsorship (user needs sponsorship: skip when explicit, else
//   check); "sponsorship available" is a note only.
//
// The user's status comes from the kit's profile.json fields: authCountry (or country), workAuthorized,
// workAuthDetails (their own words, e.g. "F-1 student, eligible for CPT", "Canadian citizen", "PGWP until
// 2027-05-01"), needsSponsorship, needsSponsorshipForInternship, education[0].degree / .endExact / .end,
// classStanding, expectedGraduation, enrolled.
// This is a screening aid, not legal or immigration advice.
// Pure; loads as CommonJS or as a browser global (CoreEligibility). Needs redflags.js (CoreRedFlags).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./redflags'));
  else root.CoreEligibility = factory(root.CoreRedFlags);
})(typeof self !== 'undefined' ? self : this, function (RedFlags) {
  const { splitSentences, pyRegex } = RedFlags;
  const { collapse, cpSlice } = RedFlags._internals;
  const rx = pyRegex;
  // userStatus builds some patterns on the fly; compile each once.
  const CACHE = new Map();
  const rxs = (src) => {
    let re = CACHE.get(src);
    if (!re) CACHE.set(src, (re = rx(src)));
    return re;
  };
  const R = String.raw;

  // ---- the user -------------------------------------------------------------------------------------------------

  const COUNTRY_WORDS = [
    ['US', R`\b(?:united\s+states|usa|u\.\s?s\.(?:\s?a\.)?|us|america|american)\b`],
    ['CA', R`\b(?:canada|canadian|ca)\b`],
    ['UK', R`\b(?:united\s+kingdom|uk|u\.\s?k\.|great\s+britain|britain|british|england|scotland|wales|gb)\b`],
  ];
  const COUNTRY_FULL = COUNTRY_WORDS.map(([code, pat]) => [code, rx(R`^\s*` + pat + R`\s*$`)]);
  const COUNTRY_ANY = COUNTRY_WORDS.map(([code, pat]) => [code, rx(pat)]);

  // 'US', 'CA', 'UK' or null from a country name or code.
  function countryCode(value) {
    const v = String(value || '').trim().toLowerCase();
    if (!v) return null;
    for (const [code, re] of COUNTRY_FULL) if (re.test(v)) return code;
    for (const [code, re] of COUNTRY_ANY) if (re.test(v)) return code;
    return null;
  }

  function yesNo(v) {
    const s = String(v != null ? v : '').trim().toLowerCase();
    if (['yes', 'y', 'true', '1'].includes(s)) return true;
    if (['no', 'n', 'false', '0'].includes(s)) return false;
    return null;
  }

  // Dates are whole days since 1970-01-01 (UTC), so comparisons and "+365 days" are plain arithmetic.
  function dayNumber(y, m, d) {
    if (!(y >= 1 && y <= 9999) || !(m >= 1 && m <= 12) || !(d >= 1)) return null;
    const back = new Date(0);
    back.setUTCFullYear(y, m - 1, d); // not Date.UTC, which reads years 0-99 as 1900-1999
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
    return Math.round(back.getTime() / 86400000);
  }
  function dayFromDate(date) {
    return dayNumber(date.getFullYear(), date.getMonth() + 1, date.getDate());
  }
  // The patterns Python's strptime accepts for %Y, %m and %d.
  const P_Y = '(\\d\\d\\d\\d)';
  const P_M = '(1[0-2]|0[1-9]|[1-9])';
  const P_D = '(3[01]|[12]\\d|0[1-9]|[1-9]| [1-9])';
  const YMD = new RegExp(`^${P_Y}-${P_M}-${P_D}$`, 'i');
  const YM = new RegExp(`^${P_Y}-${P_M}$`, 'i');
  const Y = new RegExp(`^${P_Y}$`, 'i');
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const MONTH_YEAR = rx(R`(january|february|march|april|may|june|july|august|september|october|november|december|` +
                        R`jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\w*\.?\s+(\d{4})`, 'i');

  function parseDate(v) {
    const s = String(v || '').trim();
    let m = YMD.exec(s.slice(0, 10));
    if (m) {
      const d = dayNumber(+m[1], +m[2], +m[3].trim());
      if (d != null) return d;
    }
    m = YM.exec(s.slice(0, 7));
    if (m) {
      const d = dayNumber(+m[1], +m[2], 1);
      if (d != null) return d;
    }
    m = Y.exec(s.slice(0, 4));
    if (m) {
      const d = dayNumber(+m[1], 1, 1);
      if (d != null) return d;
    }
    m = MONTH_YEAR.exec(s);
    if (m) {
      const d = dayNumber(+m[2], MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, 1);
      if (d != null) return d;
    }
    return null;
  }

  // `today`: a Date, 'YYYY-MM-DD', or nothing for the local date today.
  function todayNumber(today) {
    if (today instanceof Date && !isNaN(today)) return dayFromDate(today);
    if (typeof today === 'string' && today.trim()) {
      const d = parseDate(today);
      if (d != null) return d;
    }
    return dayFromDate(new Date());
  }

  const truthy = (v) => (Array.isArray(v) ? v.length > 0 : v && typeof v === 'object' ? Object.keys(v).length > 0 : !!v);
  const isDict = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

  const NAMED = [['US', R`(?:u\.?\s?s\.?|united states|american|us)`], ['CA', R`(?:canadian|canada)`],
                 ['UK', R`(?:british|uk|u\.k\.|united kingdom)`]];

  // What the screen needs to know about the user. Unknown facts stay null.
  function userStatus(profile, today) {
    const p = isDict(profile) ? profile : {};
    const now = todayNumber(today);
    const details = String(p.workAuthDetails || '');
    const d = details.toLowerCase();
    const auth = countryCode(p.authCountry) || countryCode(p.country);
    let citizen = new Set();
    let pr = new Set();
    const temp = new Set();

    const named = (kindPat) => {
      const found = new Set();
      for (const [code, pat] of NAMED) {
        if (rxs(pat + R`\s+` + kindPat).test(d) || rxs(kindPat + R`\s+(?:of\s+(?:the\s+)?)?` + pat).test(d)) found.add(code);
      }
      return found;
    };

    if (rxs(R`\bcitizen`).test(d) && !rxs(R`\bnot\s+a\s+citizen|\bnon[- ]citizen`).test(d)) {
      citizen = named('citizen');
      if (!citizen.size) citizen = new Set(auth ? [auth] : []);
    }
    if (rxs(R`permanent\s+resident|\bgreen\s+card|\bpr\b|indefinite\s+leave|\bilr\b|settled\s+status`).test(d)) {
      pr = named(R`permanent\s+resident`);
      if (!pr.size) pr = new Set(auth ? [auth] : []);
    }
    if (rxs(R`settled\s+status|indefinite\s+leave|\bilr\b`).test(d)) pr.add('UK');
    if (rxs(R`green\s+card`).test(d)) pr.add('US');
    const f1 = rxs(R`\bf-?1\b|\bopt\b|\bcpt\b|stem\s+opt`).test(d);
    if (f1) temp.add('US');
    if (rxs(R`study\s+permit|work\s+permit|\bpgwp\b|post[- ]graduat\w*\s+work|international\s+student|temporary\s+resident|` +
           R`\bvisa\b|\bh-?1b\b|\bj-?1\b|\btn\b|\biec\b|working\s+holiday|graduate\s+route|skilled\s+worker|student\s+route|` +
           R`\btier\s*[245]\b|\bbrp\b|co-?op\s+permit`).test(d) && !(citizen.size || pr.size)) {
      const c = auth || (f1 ? 'US' : null);
      if (c) temp.add(c);
    }

    const needs = yesNo(p.needsSponsorship);
    const needsIntern = yesNo(p.needsSponsorshipForInternship);
    const authorized = yesNo(p.workAuthorized);

    const edu = truthy(p.education) ? p.education : [{}];
    const edu0 = Array.isArray(edu) && edu.length && isDict(edu[0]) ? edu[0] : {};
    const degree = String(edu0.degree || '').toLowerCase();
    let level = null;
    if (rxs(R`ph\.?\s?d|doctor|doctoral|master|\bm\.?\s?sc\b|\bm\.?\s?s\b|\bmeng\b|\bm\.?\s?eng\b|\bmba\b|\bma\b|\bm\.?\s?a\.?\b|` +
           R`\bmasc\b|\bmfa\b|\bmph\b|\bllm\b|graduate\s+(?:diploma|certificate|degree)`).test(degree)) {
      level = 'graduate';
    } else if (rxs(R`bachelor|\bb\.?\s?sc\b|\bb\.?\s?s\b|\bb\.?\s?a\b|\bbeng\b|\bb\.?\s?eng\b|\bbcomm?\b|\bbba\b|\bbasc\b|` +
                  R`\bbfa\b|undergrad|associate|diploma|\bhnd\b|\bbtech\b|\bb\.?\s?tech\b|\bbcs\b|\bbmath\b|honours|honors`).test(degree)) {
      level = 'undergraduate';
    }

    const standing = String(p.classStanding || '').toLowerCase();
    const gradDate = parseDate(p.expectedGraduation) ?? parseDate(edu0.endExact) ?? parseDate(edu0.end);
    const enrolled = yesNo(p.enrolled);
    let student = !!enrolled || !!standing || (gradDate != null && gradDate >= now);
    if (enrolled === false) student = false;
    let finalYear = null;
    if (student) {
      if (rxs(R`final|senior|last\s+year|graduating|fourth|4th|fifth|5th|year\s*[45]\b`).test(standing)) finalYear = true;
      else if (gradDate != null) finalYear = gradDate <= now + 365;
      else if (rxs(R`first|second|third|freshman|sophomore|junior|1st|2nd|3rd|year\s*[123]\b`).test(standing)) finalYear = false;
    }
    return {
      authCountry: auth, citizenOf: [...citizen].sort(), prOf: [...pr].sort(), temporaryIn: [...temp].sort(),
      f1, workAuthorized: authorized, needsSponsorship: needs, needsSponsorshipInternship: needsIntern,
      degreeLevel: level, student, finalYear, details,
    };
  }

  // true/false/null: is the user a citizen of country c?
  function isCitizen(st, c) {
    if (st.citizenOf.includes(c)) return true;
    if (st.citizenOf.length || st.prOf.length || st.temporaryIn.includes(c) || (st.f1 && c === 'US')) return false;
    return null;
  }

  function isCitizenOrPr(st, c) {
    if (st.citizenOf.includes(c) || st.prOf.includes(c)) return true;
    if (st.citizenOf.length || st.prOf.length || st.temporaryIn.includes(c) || (st.f1 && c === 'US')) return false;
    return null;
  }

  // ---- posting text ---------------------------------------------------------------------------------------------

  const US = R`(?:(?-i:U\.?\s?S\.?(?:\s?A\.?)?)|United\s+States|American)`;
  const REQ = rx(R`\b(?:must|required|requires?|requirement|only|mandatory|need\s+to\s+be|needs\s+to\s+be|necessary|` +
                 R`eligib\w*|restricted|limited\s+to|open\s+to|will\s+be\s+considered|have\s+to\s+be|is\s+a\s+condition|` +
                 R`condition\s+of\s+employment|able\s+to\s+(?:obtain|maintain)|ability\s+to\s+(?:obtain|maintain)|obtain|` +
                 R`possess|hold|active|current)\b`, 'i');
  const EEO = rx(R`\b(?:equal\s+(?:employment\s+)?opportunit\w*|without\s+regard|regardless\s+of|irrespective\s+of|` +
                 R`protected\s+(?:veteran|characteristic|status|class)|discriminat\w*|national\s+origin|e-verify)\b`, 'i');
  const NOT_REQ = rx(R`\b(?:not|no)\b[^.]{0,25}\b(?:required|necessary|needed|a\s+requirement)\b|\bdoes\s+not\s+require\b`, 'i');
  const ALT = rx(R`\bor\b[^.;]{0,70}?\b(?:authori[sz]ed|(?<!clearance\s)eligible(?!\s+(?:to\s+obtain|for)\s+(?:an?\s+)?(?:\w+\s+)?clearance)|` +
                 R`entitled|legally|valid\s+work\s+(?:permit|visa|authori[sz]ation)|work\s+permit|right\s+to\s+work|` +
                 R`otherwise\s+(?:permitted|able|authori[sz]ed)|other\s+(?:work\s+)?authori[sz]ation|have\s+(?:the\s+)?(?:legal\s+)?right|` +
                 R`temporary\s+residen\w*|work\s+visa)\b`, 'i');
  const SOFT = rx(R`\b(?:prefer\w*|a\s+plus|nice\s+to\s+have|desir\w*|ideal(?:ly)?|advantage\w*|bonus|priority|` +
                  R`encouraged|asset)\b`, 'i');
  const COND = rx(R`\b(?:may|might|could|some\s+(?:positions|roles)|certain\s+(?:roles|positions|programs|projects)|` +
                  R`if\s+(?:required|applicable|needed|selected)|depending\s+on|where\s+applicable|potential(?:ly)?)\b`, 'i');

  const US_CIT = rx(US + R`\s*citizen(?:s|ship)?\b|\bcitizen(?:s|ship)?\s+of\s+the\s+` + US, 'i');
  const GREEN = rx(R`\bgreen\s+card\b|\blawful\s+permanent\s+residen\w*|` + US + R`\s+permanent\s+residen\w*`, 'i');
  const PR = rx(R`\bpermanent\s+residen\w*`, 'i');
  const US_PERSON = rx(US + R`\s*persons?\b|\bITAR\b|\bEAR\b(?!\w)|export[- ]control\w*|export\s+administration`, 'i');
  const PERSON_REQ = rx(R`\b(?:persons?|citizens?|permanent\s+residents?|green\s+card)\b`, 'i');
  const CLEAR = rx(R`\b(?:security|secret|top[- ]secret|ts/sci|ts|sci|public\s+trust|dod|government|federal)\s+clearance\b|` +
                   R`\bclearance\s+(?:is\s+)?required\b|\b(?:active|current)\s+(?:secret|ts/sci|top\s+secret)\b|` +
                   R`\bobtain\s+(?:and\s+maintain\s+)?(?:an?\s+)?(?:\w+\s+){0,2}clearance\b`, 'i');
  const CA_CLEAR = rx(R`\b(?:reliability\s+status|enhanced\s+reliability|government\s+of\s+canada|canadian\s+(?:security|government))\b`, 'i');
  const F1 = rx(R`(?-i:\bF-?1\b|\bOPT\b|\bCPT\b|\bJ-?1\b)|\bstudent\s+visas?\b|\bpractical\s+training\b`, 'gi');
  const F1_NEG_BEFORE = rx(R`\b(?:not|unable|cannot|can't|won't|will\s+not|do\s+not|does\s+not|don't|no|ineligible|` +
                           R`exclud\w*|not\s+eligible|not\s+accept\w*|not\s+consider\w*|not\s+(?:be\s+)?able|except)\b[^.]{0,70}$`, 'i');
  const F1_NEG_AFTER = rx(R`^[^.]{0,50}\b(?:are|is|will\s+be)\s+(?:not|ineligible)\b|^[^.]{0,30}\b(?:not\s+eligible|ineligible|` +
                          R`excluded|cannot\s+be\s+considered|will\s+not\s+be\s+considered)\b`, 'i');
  const F1_POS = rx(R`^[^.]{0,40}\b(?:welcome|encouraged|eligible\s+to\s+apply|can\s+apply|may\s+apply|are\s+eligible|accepted)\b`, 'i');
  const NO_CPT = rx(R`\bno\s+(?:CPT|OPT)`);
  const GRAD = rx(R`\b(?:pursuing|enrolled\s+in|working\s+towards?|candidate\s+for|student\s+in|studying\s+for)\s+(?:a\s+|an\s+|your\s+)?` +
                  R`(?:master'?s|masters|m\.?s\.?|m\.?sc\.?|graduate|ph\.?\s?d\.?|doctoral|doctorate|mba)\b|` +
                  R`\b(?:graduate|master'?s|ph\.?\s?d\.?|doctoral|mba)\s+students?\s+only\b|\bonly\s+(?:open\s+to\s+)?(?:current\s+)?` +
                  R`(?:graduate|master'?s|ph\.?\s?d\.?|doctoral|mba)\s+students\b|\bmust\s+be\s+(?:a\s+|an\s+)?(?:current\s+|currently\s+enrolled\s+)?` +
                  R`(?:graduate|master'?s|ph\.?\s?d\.?|doctoral|mba)\s+student`, 'i');
  const UNDERGRAD = rx(R`\b(?:bachelor'?s?|undergrad\w*|b\.?\s?sc?\b|b\.?\s?a\b|bs/ms|b\.?\s?eng|college\s+students?|` +
                       R`all\s+(?:degree\s+)?levels|any\s+level)`, 'i');
  const ENROLLED = rx(R`\b(?:currently|pursuing|enrolled)\b`, 'i');
  const SPONSOR_NO = rx(R`\b(?:not|unable\s+to|cannot|can't|won't|will\s+not|do\s+not|does\s+not|don't|no\s+longer|not\s+able\s+to|` +
                        R`not\s+in\s+a\s+position\s+to)\b[^.]{0,40}?\bsponsor\w*|\bno\s+(?:visa\s+|immigration\s+|work\s+permit\s+|` +
                        R`employment\s+)?sponsorship\b|\bsponsorship\s+(?:is\s+|will\s+)?not\s+(?:be\s+)?(?:available|provided|offered|` +
                        R`possible|supported)\b|\bwithout\s+(?:the\s+need\s+for\s+|requiring\s+|needing\s+|requiring\s+any\s+|any\s+)?` +
                        R`(?:(?:current|now|or|future|visa|employer|immigration|company|work\s+permit)\s+)*sponsorship\b|` +
                        R`\bnot\s+(?:offer|provide)\w*\s+(?:\w+\s+)?sponsorship\b`, 'i');
  const SPONSOR_Q = rx(R`\?\s*$|^\s*(?:will|do|are)\s+you\b`, 'i');
  const SPONSOR_YES = rx(R`\b(?:visa\s+|work\s+permit\s+|immigration\s+)?sponsorship\s+(?:is\s+|will\s+be\s+|may\s+be\s+)?` +
                         R`(?:available|offered|provided|possible|considered)\b|\b(?:we|company)\s+(?:can|will|do|are\s+able\s+to)\s+` +
                         R`(?:offer\s+)?sponsor\w*\b|\bopen\s+to\s+sponsor\w*|\bsponsors?\s+(?:skilled\s+worker\s+|work\s+)?visas\b|` +
                         R`\bsponsor\w*\s+(?:is\s+)?available\b`, 'i');
  const UK_RTW = rx(R`\bright\s+to\s+(?:live\s+and\s+)?work\s+in\s+(?:the\s+)?(?:UK|U\.K\.|United\s+Kingdom|Britain|Great\s+Britain)\b|` +
                    R`\b(?:UK|British)\s+right\s+to\s+work\b|\beligib\w*\s+to\s+work\s+in\s+the\s+(?:UK|United\s+Kingdom)\b`, 'i');
  const UK_EXPLICIT = rx(R`\b(?:already|existing|current(?:ly)?|full|unrestricted|without\s+restriction|indefinite|permanent)\b`, 'i');
  const CAN_CPR = rx(R`\bcanadian\s+citizen\w*[^.]{0,80}?permanent\s+residen\w*|\bpermanent\s+residen\w*[^.]{0,60}?canad\w*|` +
                     R`\bcitizens?\s+(?:and|or|/)\s+permanent\s+residents?\s+of\s+canada`, 'i');
  const CAN_CIT = rx(R`\bcanadian\s+citizen(?:s|ship)?\b|\bcitizens?\s+of\s+canada\b`, 'i');
  const CAN_ALT = rx(R`\b(?:legally\s+entitled|entitled\s+to\s+work|authori[sz]ed\s+to\s+work|valid\s+(?:canadian\s+)?work\s+permit|` +
                     R`temporary\s+residen\w*|eligible\s+to\s+work\s+in\s+canada|legally\s+eligible|work\s+permit\s+holders|` +
                     R`(?:persons|those|individuals|people)\s+(?:who\s+are\s+)?legally|with\s+or\s+without\s+a\s+valid)\b`, 'i');
  const CAN_APPLY = rx(R`apply\s+if\s+you\s+are|accepts?\s+applications\s+from`, 'i');
  const AUTH_REQ = rx(R`\b(?:legally\s+)?(?:authori[sz]ed|eligible|entitled|permitted)\s+to\s+work\s+in\s+(?:the\s+)?(?<c>` + US +
                      R`|US|Canada|UK|United\s+Kingdom)\b`, 'i');
  const GENERIC_CIT = rx(R`\b(?:must\s+be\s+an?\s+citizen|citizenship\s+(?:is\s+)?required|citizens\s+only|only\s+citizens)\b`, 'i');
  const INTERN = rx(R`\b(?:intern(?:ship)?s?|co-?op|placement\s+student|work\s+term|summer\s+student|student\s+(?:position|role|job))\b`, 'i');
  const MENTIONS_CA = rx(R`\bcanad`, 'i');
  const MENTIONS_UK = rx(R`\b(?:UK|U\.K\.|United Kingdom|Britain|British)\b`);
  const US_ANY = rx(US, 'i');

  const LOC_CA = rx(R`\bcanada\b|\b(?:ontario|quebec|qu\u00e9bec|british columbia|alberta|nova scotia|new brunswick|manitoba|` +
                    R`saskatchewan|newfoundland|prince edward island|yukon|nunavut|northwest territories)\b`, 'i');
  const LOC_CA_PROV = rx(R`,\s*(?:ON|BC|AB|QC|NS|NB|MB|SK|PE|PEI|NL|YT|NT|NU)\b`);
  const LOC_UK = rx(R`\b(?:united kingdom|england|scotland|wales|northern ireland|london|manchester|edinburgh|glasgow|` +
                    R`birmingham|leeds|bristol|cambridge,\s*uk|oxford)\b|\bUK\b|\bGB\b`, 'i');
  const LOC_LONDON_ON = rx(R`london,\s*on`, 'i');
  const LOC_US = rx(R`\b(?:united states|usa)\b|\bUS\b|,\s*[A-Z]{2}\b|\bremote\s*[-(]\s*us`);
  const TEXT_HITS = [['CA', rx(R`\bcanad\w*`, 'gi')], ['UK', rx(R`\b(?:united kingdom|UK)\b`, 'gi')],
                     ['US', rx(R`\b(?:U\.S\.|United States|USA)\b`, 'g')]];

  // 'US', 'CA', 'UK' or null, from the posting's location (then its text).
  function postingCountry(location, text) {
    const loc = String(location || '');
    if (LOC_CA.test(loc) || LOC_CA_PROV.test(loc)) return 'CA';
    if (LOC_UK.test(loc) && !LOC_LONDON_ON.test(loc)) return 'UK';
    if (LOC_US.test(loc)) return 'US';
    const t = cpSlice(String(text || ''), 3000);
    let best = null;
    let most = 0;
    for (const [code, re] of TEXT_HITS) {
      const n = (t.match(re) || []).length;
      if (n > most) { best = code; most = n; }
    }
    return best;
  }

  const ORDER = { skip: 0, check: 1, note: 2 };

  // Screen a posting against the user's status. See the header for the rules.
  function screen(text, profile, opts) {
    const { role = '', location = '', today = null } = opts || {};
    const st = userStatus(profile || {}, today);
    const hasProfile = truthy(profile);
    const where = postingCountry(location, text);
    const internship = INTERN.test(String(role || '')) || (!role && INTERN.test(cpSlice(String(text || ''), 500)));
    let needs = st.needsSponsorship;
    if (internship && st.needsSponsorshipInternship !== null) needs = st.needsSponsorshipInternship;
    const belowFinal = st.student && st.finalYear !== true;

    const results = []; // [level, sentence, rule]
    const add = (level, sentence, rule) => results.push([level, cpSlice(collapse(sentence), 300), rule]);

    // holds: does the user meet the requirement (true/false/null)?
    const decide = (holds, sentence, rule, soft, unknownNote) => {
      unknownNote = unknownNote || 'profile does not say';
      if (holds === true) return;
      if (soft || COND.test(sentence)) {
        add('check', sentence, rule + (holds === false ? ' (preferred or conditional)' : ` (${unknownNote})`));
      } else if (holds === false) {
        add('skip', sentence, rule);
      } else {
        add('check', sentence, `${rule} (${unknownNote})`);
      }
    };

    for (const s of splitSentences(text)) {
      if (EEO.test(s) || NOT_REQ.test(s)) continue;
      const soft = SOFT.test(s);
      const alt = ALT.test(s);
      const mentionsCa = MENTIONS_CA.test(s);
      const mentionsUk = MENTIONS_UK.test(s);
      const isQuestion = SPONSOR_Q.test(s);

      // --- US: F-1 / OPT / CPT excluded
      for (const m of s.matchAll(F1)) {
        const before = s.slice(0, m.index);
        const after = s.slice(m.index + m[0].length);
        if (F1_POS.test(after)) continue;
        if (F1_NEG_BEFORE.test(before) || F1_NEG_AFTER.test(after) || NO_CPT.test(s)) {
          if (st.f1) add('skip', s, 'excludes F-1 / OPT / CPT students and you are on F-1');
          else if (!st.details && hasProfile && needs !== false) add('check', s, 'excludes F-1 / OPT / CPT students (profile does not give your visa type)');
          else if (!hasProfile) add('check', s, 'excludes F-1 / OPT / CPT students');
          break;
        }
      }

      // --- US citizenship / green card / US person / clearance
      const usCtx = US_ANY.test(s) || (where === 'US' && !mentionsCa && !mentionsUk);
      const req = REQ.test(s) || soft;
      if (US_CIT.test(s) && req && !alt) {
        if (GREEN.test(s) || PR.test(s)) decide(isCitizenOrPr(st, 'US'), s, 'US citizenship or permanent residence required', soft);
        else decide(isCitizen(st, 'US'), s, 'US citizenship required', soft);
      } else if ((GREEN.test(s) || (PR.test(s) && usCtx && !mentionsCa)) && req && !alt && !CAN_CPR.test(s)) {
        decide(isCitizenOrPr(st, 'US'), s, 'US permanent residence (green card) required', soft);
      } else if (US_PERSON.test(s) && PERSON_REQ.test(s) && req && !alt) {
        decide(isCitizenOrPr(st, 'US'), s, '"US person" required (export control: ITAR/EAR)', soft);
      }
      if (CLEAR.test(s) && REQ.test(s) && !CA_CLEAR.test(s) && !mentionsCa &&
          (usCtx || where === null || where === 'US') && !mentionsUk) {
        const holds = isCitizen(st, 'US');
        if (holds === false && st.prOf.includes('US')) {
          add('check', s, 'security clearance required (clearances usually need US citizenship)');
        } else {
          decide(holds, s, 'security clearance required (needs US citizenship)', soft);
        }
      }
      if (GENERIC_CIT.test(s) && !US_CIT.test(s) && !CAN_CIT.test(s) && !alt && where) {
        decide(isCitizen(st, where), s, `${where} citizenship required`, soft);
      }

      // --- Graduate students only
      if (GRAD.test(s) && !UNDERGRAD.test(s) && (REQ.test(s) || ENROLLED.test(s))) {
        if (st.degreeLevel === 'undergraduate') {
          if (soft) add('check', s, 'graduate students preferred and you are an undergraduate');
          else add('skip', s, 'graduate students only and you are an undergraduate');
        } else if (st.degreeLevel === null && hasProfile) {
          add('check', s, 'graduate students only (profile does not give your degree)');
        }
      }

      // --- Canada: citizens / permanent residents only
      if ((CAN_CPR.test(s) || CAN_CIT.test(s)) && (REQ.test(s) || soft || CAN_APPLY.test(s)) && !CAN_ALT.test(s) && !alt) {
        const cpr = CAN_CPR.test(s);
        const holds = cpr ? isCitizenOrPr(st, 'CA') : isCitizen(st, 'CA');
        const rule = cpr ? 'Canadian citizens or permanent residents only' : 'Canadian citizenship required';
        if (holds === false && !st.temporaryIn.includes('CA') && st.authCountry !== null && st.authCountry !== 'CA') {
          decide(false, s, rule, soft);
        } else if (holds === false) {
          decide(false, s, rule + ' and you are a temporary resident', soft);
        } else {
          decide(holds, s, rule, soft);
        }
      }

      // --- Sponsorship (all countries) and UK right to work
      const ukRtw = UK_RTW.test(s);
      if (SPONSOR_NO.test(s) && !isQuestion) {
        const rule = 'no visa sponsorship';
        if (needs === false) {
          // fine
        } else if (needs === null) {
          add('check', s, rule + ' (profile does not say whether you need sponsorship)');
        } else if (belowFinal) {
          add('check', s, rule + ' (you are a student below your final year: sponsorship wording alone does not rule you out)');
        } else if (soft || COND.test(s)) {
          add('check', s, rule + ' (conditional wording)');
        } else {
          add('skip', s, rule + ' and you need sponsorship');
        }
      } else if (ukRtw && REQ.test(s) && !isQuestion) {
        const rule = 'right to work in the UK required';
        if (needs === false) {
          // fine
        } else if (needs === null) {
          add('check', s, rule + ' (profile does not say whether you need sponsorship)');
        } else if (belowFinal) {
          add('check', s, rule + ' (you are a student below your final year)');
        } else if (UK_EXPLICIT.test(s) && !soft) {
          add('skip', s, rule + ' (existing right, no sponsorship) and you need sponsorship');
        } else {
          add('check', s, rule + ' and you need sponsorship (not explicit that they will not sponsor)');
        }
      } else if (SPONSOR_YES.test(s) && !isQuestion) {
        add('note', s, 'sponsorship mentioned as available');
      }

      // --- Work authorization required and the user says they aren't authorized
      const m = AUTH_REQ.exec(s);
      if (m && st.workAuthorized === false && REQ.test(s) && !SPONSOR_NO.test(s)) {
        const c = countryCode(m.groups.c);
        if (c && (st.authCountry === null || st.authCountry === c)) {
          add('check', s, `must be authorized to work in ${c} and your profile says you are not`);
        }
      }
    }

    // one entry per sentence, strongest level wins
    const best = new Map();
    for (const [level, sentence, rule] of results) {
      if (!best.has(sentence) || ORDER[level] < ORDER[best.get(sentence)[0]]) best.set(sentence, [level, rule]);
    }
    const entries = [...best];
    const levels = entries.map(([, [lv]]) => lv);
    const verdict = levels.includes('skip') ? 'skip' : levels.includes('check') ? 'check' : 'ok';
    const why = entries.slice().sort((a, b) => ORDER[a[1][0]] - ORDER[b[1][0]])
      .filter(([, [lv]]) => lv === 'skip' || lv === 'check')
      .map(([s, [, r]]) => `${s} -> ${r}`);
    for (const [s, [lv, r]] of entries) if (lv === 'note') why.push(`${s} -> note: ${r}`);
    const check = entries.filter(([, [lv]]) => lv === 'check').map(([s]) => s);
    return { screen: verdict, why, check, country: where, status: st };
  }

  // One short line for a job list: the first skip (or check) rule.
  function shortReason(result) {
    for (const line of (result && result.why) || []) {
      const i = line.lastIndexOf(' -> ');
      if (i >= 0 && !line.slice(i + 4).startsWith('note:')) return line.slice(i + 4);
    }
    return '';
  }

  return { countryCode, userStatus, screen, postingCountry, shortReason, _internals: { parseDate, todayNumber } };
});
