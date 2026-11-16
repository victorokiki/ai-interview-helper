// Warning signs that a job posting may be a scam, with the text that triggered each one.
// Port of the Autonomous Job Kit's lib/jobkit/redflags.py (MIT, same author).
//
//   redFlags(text, { url, company, role, system }) -> [{ flag, quote }]
//
// Each flag is a short plain-English label; the quote is the sentence (shortened) that matched, so the user
// can judge. The rules aim for few false alarms: reassurances such as "we never ask you to pay" or "no fees"
// do not flag, payroll lines like "paid by direct deposit" do not flag, and normal trade phrases like "must
// have a valid driver's licence" do not flag. A flag is a reason to look closer, not proof of fraud.
//
// Also exports splitSentences(text), used by eligibility.js, and pyRegex(), which compiles a Python-style
// pattern with Python's Unicode meaning of \b \w \W \d \s \S so both ports match the same text.
// Pure; loads as CommonJS or as a browser global (CoreRedFlags).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CoreRedFlags = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // ---- Python regex semantics ---------------------------------------------------------------------------------
  // Python's str patterns are Unicode-aware: \w is any letter/number/underscore, \b is a boundary between those
  // and anything else, \s is str.isspace(). JavaScript's are ASCII. pyRegex rewrites the escapes and adds the
  // u flag. Inline (?-i:...) groups and lookbehind are native in V8 (Node 24, Electron 44).
  const W = '\\p{L}\\p{N}_';
  const S = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
  const BOUNDARY = `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))`;

  function pyRegex(src, flags) {
    let out = '';
    let inClass = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') {
        const n = src[i + 1];
        i++;
        if (n === 'w') out += inClass ? W : `[${W}]`;
        else if (n === 'd') out += '\\p{Nd}';
        else if (n === 's') out += inClass ? S : `[${S}]`;
        else if (!inClass && n === 'W') out += `[^${W}]`;
        else if (!inClass && n === 'S') out += `[^${S}]`;
        else if (!inClass && n === 'b') out += BOUNDARY;
        else if (inClass && (n === 'W' || n === 'S' || n === 'b')) throw new Error(`pyRegex: \\${n} inside a class`);
        else out += c + n;
        continue;
      }
      if (c === '[' && !inClass) inClass = true;
      else if (c === ']' && inClass) inClass = false;
      out += c;
    }
    flags = flags || '';
    return new RegExp(out, flags.includes('u') ? flags : flags + 'u');
  }

  const WS_EDGE = pyRegex(String.raw`^\s+|\s+$`, 'g');
  const strip = (s) => s.replace(WS_EDGE, '');
  const rstrip = (s) => s.replace(pyRegex(String.raw`\s+$`), '');
  const collapse = (s) => strip(s.replace(pyRegex(String.raw`\s+`, 'g'), ' '));
  // str.splitlines(): every Unicode line break
  const LINES = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
  const splitlines = (s) => s.split(LINES);
  // Python counts code points; JS counts UTF-16 units. These keep lengths and slices in code points.
  const cps = (s) => Array.from(s);
  const cpSlice = (s, n) => (s.length <= n ? s : cps(s).slice(0, n).join(''));
  const cpIndex = (s, i) => cps(s.slice(0, i)).length;
  const words = (s) => s.split(pyRegex(String.raw`\s+`)).filter(Boolean).length;

  // ---- sentences ------------------------------------------------------------------------------------------------

  const ABBREV = pyRegex(String.raw`\b(?:U\.\s?S\.(?:\s?A\.)?|U\.\s?K\.|e\.g\.|i\.e\.|etc\.|Inc\.|Ltd\.|Co\.|Corp\.|Jr\.|Sr\.|No\.|St\.|` +
                         String.raw`approx\.|vs\.|Ph\.\s?D\.|M\.\s?Sc\.|B\.\s?Sc\.|B\.\s?S\.|M\.\s?S\.|B\.\s?A\.|M\.\s?A\.|B\.\s?Eng\.|` +
                         String.raw`M\.\s?Eng\.|Dr\.|Mr\.|Ms\.|Mrs\.)`, 'gi');
  const DOT = '\u2024';
  const BULLET = pyRegex(String.raw`^\s*(?:[-*\u2022\u25cf\u25aa\u2013]|\d+[.)])\s+`);
  const SENT_END = pyRegex(String.raw`(?<=[.!?])\s+(?=[A-Z0-9"'(\u201c])`);

  // Sentences of a posting: every line is split at sentence ends; bullet markers are dropped. Abbreviations
  // such as "U.S." or "Ph.D." don't end a sentence.
  function splitSentences(text) {
    const out = [];
    for (let line of splitlines(String(text || ''))) {
      line = strip(line.replace(BULLET, ''));
      if (!line) continue;
      line = line.replace(ABBREV, (m) => m.split('.').join(DOT));
      for (let part of line.split(SENT_END)) {
        part = strip(part.split(DOT).join('.'));
        if (part) out.push(part);
      }
    }
    return out;
  }

  function quote(sentence, match, width) {
    width = width || 170;
    const s = cps(collapse(sentence));
    if (s.length <= width) return s.join('');
    if (!match) return rstrip(s.slice(0, width - 3).join('')) + '...';
    // Python takes the match position in the original sentence and applies it to the collapsed one.
    const start0 = cpIndex(sentence, match.index);
    const end0 = cpIndex(sentence, match.index + match[0].length);
    const mid = Math.floor((start0 + end0) / 2);
    const start = Math.max(0, Math.min(mid - Math.floor(width / 2), s.length - width));
    const piece = strip(s.slice(start, start + width).join(''));
    return (start > 0 ? '...' : '') + piece + (start + width < s.length ? '...' : '');
  }

  // ---- rules ----------------------------------------------------------------------------------------------------

  // A sentence that reassures rather than demands ("we will never ask you to pay", "there is no fee").
  const REASSURE = pyRegex(
    String.raw`\b(never|no\s+(?:\w+\s+){0,2}(?:fees?|charges?|costs?|payments?)|not?\s+(?:be\s+)?(?:charged|required\s+to\s+pay|asked\s+to\s+pay)|` +
    String.raw`free\s+of\s+charge|at\s+no\s+(?:cost|charge)|without\s+(?:any\s+)?(?:cost|charge|fee)|do(?:es)?\s+not\s+(?:charge|ask|require)|` +
    String.raw`don'?t\s+(?:charge|ask)|will\s+not\s+(?:charge|ask)|won'?t\s+(?:charge|ask)|(?:we|company|employer)\s+(?:will\s+)?(?:cover|pay|pays|covers|reimburse\w*)|` +
    String.raw`reimburs\w*|paid\s+(?:for\s+)?by\s+(?:us|the\s+(?:company|employer))|company[- ]provided|provided\s+by\s+(?:us|the\s+company)|` +
    String.raw`scam|fraud\w*|phishing|beware|be\s+aware|legitimate\s+(?:recruiters?|employers?))\b`, 'i');

  const FEE = pyRegex(
    String.raw`\b(?:application|registration|processing|training|onboarding|starter|enrol(?:l)?ment|background[- ]check|screening|` +
    String.raw`equipment|kit|uniform|placement|admin(?:istration|istrative)?|certification|membership|visa\s+processing)\s+` +
    String.raw`(?:fees?|charges?|costs?|deposits?|payments?)\b`, 'i');
  const PAY_FOR = pyRegex(
    String.raw`\b(?:you|applicants?|candidates?|new\s+hires?)\s+(?:will\s+|must\s+|are\s+required\s+to\s+|need\s+to\s+|have\s+to\s+|should\s+)?` +
    String.raw`(?:pay|purchase|buy)\s+(?:a\s+|an\s+|the\s+|for\s+(?:the\s+|your\s+)?)?(?:\w+\s+){0,2}` +
    String.raw`(?:training|course|background\s+check|starter\s+kit|kit|equipment|software|license|certificate|application|registration|` +
    String.raw`materials|package)\b`, 'i');
  const REFUNDABLE = pyRegex(String.raw`\b(?:refundable|small)\s+(?:fee|deposit|payment)\b`, 'i');

  const CHEQUE = pyRegex(
    String.raw`(?:\b(?:cheque|check|money\s+order|funds|payment)s?\b[^.]{0,100}\b(?:equipment|supplies|workstation|home\s+office|` +
    String.raw`laptop|vendor|software|office\s+setup)\b|\b(?:equipment|supplies|workstation|home\s+office|laptop|vendor|software)\b` +
    String.raw`[^.]{0,100}\b(?:cheque|check|money\s+order)s?\b|\bdeposit\s+(?:the|a|this)\s+(?:cheque|check)\b|` +
    String.raw`\bmobile\s+deposit\b|\b(?:send|wire|transfer)\s+(?:back\s+)?(?:the\s+)?(?:remaining|remainder|balance|excess)\b)`, 'i');
  const PAYROLL = pyRegex(String.raw`\b(?:paycheck|paycheque|direct\s+deposit|payroll|background\s+check|reference\s+check|` +
                          String.raw`health\s+check|spell\s+check|check\s+in|check\s+out|double[- ]check)\b`, 'i');
  const CHEQUE_WORDS = pyRegex(String.raw`\b(cheque|money order|equipment|vendor|supplies)\b`, 'i');

  const APPS = String.raw`(?:telegram|whats\s?app|signal\s+(?:app|messenger)|(?-i:Signal)|google\s+hangouts|hangouts|wickr|kik|wechat|viber)`;
  const CHAT = pyRegex(
    String.raw`\b(?:contact|text|message|reach(?:\s+out\s+to)?|chat|interview(?:ed)?|add|send|dm|apply|connect|talk|speak)\b[^.]{0,40}?` +
    String.raw`\b(?:on|via|through|using|over|at|with)\s+` + APPS + String.raw`\b|\b` + APPS + String.raw`\s*(?:id|handle|username|number|no\.?|` +
    String.raw`chat|interview)?\s*[:@+]\s*\S|\b` + APPS + String.raw`\s+(?:interview|chat\s+interview|only)\b`, 'i');
  const CHAT_TECH = pyRegex(String.raw`\b(api|integrat\w*|bots?|sdk|platform|develop\w*|build\w*|experience\s+with)\b`, 'i');
  const CHAT_CONTACT = pyRegex(String.raw`\b(contact|text|message|reach|interview)\b`, 'i');

  const PERSONAL_MAIL = pyRegex(
    String.raw`\b([\w.+-]+)@(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|aol|icloud|me|proton(?:mail)?|gmx|mail|` +
    String.raw`yandex|zoho)\.(?:com|ca|co\.uk|me|ru|net|fr|de)\b`, 'gi');
  const RECRUIT_LOCAL = pyRegex(String.raw`(hr|recruit|career|hiring|jobs?|talent|staffing|onboard|personnel|employ|human)`, 'i');
  const BIG_SYSTEMS = ['greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'icims', 'oracle', 'rippling'];

  const CRYPTO = pyRegex(
    String.raw`\b(?:paid|payment|pay|salary|compensation|wages?|remuneration|reimburs\w*)\b[^.]{0,40}\b(?:in|via|with|through|using|by)\s+` +
    String.raw`(?:bitcoin|btc|crypto(?:currenc(?:y|ies))?|usdt|tether|ethereum|eth|gift\s?cards?|itunes\s+cards?|steam\s+cards?|` +
    String.raw`google\s+play\s+cards?|amazon\s+cards?)\b|\b(?:buy|purchase|send|load)\s+(?:\w+\s+){0,3}gift\s?cards?\b|` +
    String.raw`\bgift\s?cards?\b[^.]{0,40}\b(?:as\s+payment|for\s+payment|to\s+pay)\b`, 'i');

  const NO_INTERVIEW = pyRegex(
    String.raw`\bno\s+(?:(?:formal|prior|phone|face[- ]to[- ]face)\s+)?interviews?\s+(?:is\s+|are\s+)?(?:needed|required|necessary)\b|` +
    String.raw`\bwithout\s+(?:an?\s+|any\s+)?interviews?\b|\b(?:get|be|are|you(?:'ll| will)\s+be)\s+hired\s+(?:immediately|instantly|` +
    String.raw`on\s+the\s+spot|today|right\s+away)\b|\bhired\s+on\s+the\s+spot\b|\binstant(?:ly)?\s+hir(?:e|ed|ing)\b|` +
    String.raw`\bguaranteed\s+(?:job|position|hire|employment|placement)\b`, 'i');

  const ID_ASK = pyRegex(
    String.raw`(?-i:\bSINs?\b|\bSSNs?\b)|\b(?:social\s+insurance|social\s+security|national\s+insurance)\s+(?:number|no\.?|card)\b|` +
    String.raw`\bbank\s+(?:account|details|information|info|statement|login|card)\b|\b(?:routing|account|card)\s+number\b|` +
    String.raw`\b(?:driver'?s?|driving)\s+licen[cs]e\s+(?:number|copy|photo|scan|picture)\b|\bpassport\s+(?:number|copy|photo|scan|details)\b|` +
    String.raw`\b(?:copy|photo|scan|picture)\s+of\s+(?:your\s+)?(?:id|passport|driver'?s?\s+licen[cs]e|sin\s+card|ssn\s+card|` +
    String.raw`social\s+security\s+card|photo\s+id)\b|\bdate\s+of\s+birth\b`, 'i');
  const ID_VERB = pyRegex(String.raw`\b(?:send|provide|submit|include|email|e-mail|attach|text|forward|share|enter|fill\s+in|required\s+` +
                          String.raw`(?:with|along)|along\s+with|together\s+with|when\s+(?:you\s+)?apply(?:ing)?|with\s+your\s+(?:application|resume|cv))\b`, 'i');
  const AFTER_OFFER = pyRegex(String.raw`\b(?:after|upon|once|following)\s+(?:an?\s+|the\s+|a\s+conditional\s+|you\s+(?:accept|receive)\s+(?:an?\s+)?)?` +
                              String.raw`(?:offer|hire|hired|hiring|acceptance|onboarding|start(?:ing)?|employment\s+begins|first\s+day)\b|` +
                              String.raw`\bduring\s+onboarding\b|\bform\s+i-9\b|\bi-9\b|\bpayroll\s+setup\b`, 'i');

  const UNSKILLED = pyRegex(
    String.raw`\b(?:data\s+entry|typist|typing|envelope\s+stuff\w*|package\s+(?:handler|forward\w*|reship\w*|inspector)|reshipp\w*|` +
    String.raw`mystery\s+shopp\w*|product\s+tester|personal\s+assistant|virtual\s+assistant|admin(?:istrative)?\s+assistant|` +
    String.raw`office\s+assistant|clerical|copy\s+paste|form\s+filling|survey\s+taker|chat\s+(?:agent|moderator)|` +
    String.raw`payment\s+processor|shipping\s+(?:clerk|coordinator)|receptionist)\b`, 'i');
  const ENTRY = pyRegex(String.raw`\b(?:no\s+(?:prior\s+)?experience|entry[- ]level|training\s+(?:is\s+)?provided|beginners?\s+welcome|` +
                        String.raw`no\s+skills?\s+(?:needed|required)|anyone\s+can)\b`, 'i');
  const MONEY = pyRegex(
    String.raw`(?<cur>[$\u00a3\u20ac]|(?:CAD|USD|GBP|C\$|US\$)\s?)\s?(?<num>\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s?(?<k>[kK])?` +
    String.raw`(?:\s?(?:-|\u2013|to)\s?(?:[$\u00a3\u20ac]|CAD|USD|GBP)?\s?(?<num2>\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s?[kK]?)?` +
    String.raw`\s?(?:/|per|an|a|each)\s?(?<unit>hour|hr|h|day|week|wk|month)\b`, 'gi');
  const HOURS = { hour: 1, hr: 1, h: 1, day: 8, week: 40, wk: 40, month: 173 };

  const SUBSTANCE = pyRegex(String.raw`\b(?:responsib\w*|requir\w*|qualif\w*|experience|skills?|duties|tasks|you\s+will|what\s+you'?ll|` +
                            String.raw`about\s+(?:the|this)\s+(?:role|job|position)|education|degree)\b`, 'i');
  const WORD = pyRegex(String.raw`\w+`, 'g');

  const URGENT = pyRegex(
    String.raw`\b(?:respond|reply|apply|answer|confirm|get\s+back|contact\s+us|act|accept)\w*\b[^.]{0,40}\bwithin\s+(?:the\s+next\s+)?` +
    String.raw`(?:1|2|3|6|12|24|48|one|two|twelve|twenty[- ]four|forty[- ]eight)\s*(?:hours?|hrs?|h)\b|` +
    String.raw`\b(?:act|apply|respond)\s+(?:now|fast|quickly|immediately)\b(?![^.]{0,30}\b(?:to\s+be\s+considered\s+for\s+our\s+fall|program)\b)|` +
    String.raw`\blimited\s+(?:spots?|slots?|positions?|seats?)\s+(?:available|left|remaining)\b|\bonly\s+\d+\s+(?:spots?|slots?|positions?|seats?)` +
    String.raw`\s+(?:left|remaining|available)\b|\b(?:offer|opportunity)\s+(?:expires|ends|closes)\s+(?:today|tonight|in\s+24)\b|` +
    String.raw`\bdon'?t\s+miss\s+(?:out|this)\b|\btoday\s+only\b|\bfirst\s+come,?\s+first\s+serve`, 'i');

  function wagePerHour(m) {
    const g = m.groups;
    let num = parseFloat(g.num.replace(/,/g, ''));
    if (g.num2) num = Math.max(num, parseFloat(g.num2.replace(/,/g, '')));
    if (g.k) num *= 1000;
    return [num / HOURS[g.unit.toLowerCase()], strip(g.cur).toUpperCase()];
  }

  // List of { flag, quote } for a posting's text (description, plus title and location if you like).
  // `company` enables the personal-email check; `role` helps the pay check; `system` (greenhouse, lever, ...)
  // lets a personal email on a big application system count even without a recruiting-style address.
  // `url` is accepted for parity with the Python signature and is not used.
  function redFlags(text, opts) {
    const { company = null, role = null, system = null } = opts || {};
    text = String(text || '');
    const found = new Map();
    const add = (flag, sentence, match) => {
      if (!found.has(flag)) found.set(flag, quote(sentence, match));
    };

    const sentences = splitSentences(text);
    for (const s of sentences) {
      const reassure = REASSURE.test(s);
      let m;
      // 1. Paying to apply / train / get equipment
      m = FEE.exec(s) || PAY_FOR.exec(s) || REFUNDABLE.exec(s);
      if (m && !reassure) add('asks you to pay (fee, training, equipment or a check)', s, m);
      // 2. Cheques / deposits to buy equipment
      m = CHEQUE.exec(s);
      if (m && !reassure && !(PAYROLL.test(s) && !CHEQUE_WORDS.test(s))) add('cheque or deposit to buy equipment', s, m);
      // 3. Chat-app-only contact
      m = CHAT.exec(s);
      if (m && (!CHAT_TECH.test(s) || CHAT_CONTACT.test(s))) add('contact through a chat app (Telegram/WhatsApp/Signal/Hangouts)', s, m);
      // 5. Crypto or gift cards
      m = CRYPTO.exec(s);
      if (m && !reassure) add('payment in crypto or gift cards', s, m);
      // 6. No interview / instant hire
      m = NO_INTERVIEW.exec(s);
      if (m) add('no interview / hired immediately', s, m);
      // 7. ID or bank details before an offer
      m = ID_ASK.exec(s);
      if (m && ID_VERB.test(s) && !reassure && !AFTER_OFFER.test(s)) add('asks for SIN/SSN, bank or ID details before an offer', s, m);
      // 10. Pressure
      m = URGENT.exec(s);
      if (m) add('pressure to respond fast', s, m);
    }

    // 4. Personal email address for a named company
    for (const m of text.matchAll(PERSONAL_MAIL)) {
      const recruitingStyle = RECRUIT_LOCAL.test(m[1]);
      const bigSystem = BIG_SYSTEMS.includes(system || '');
      const sent = sentences.find((s) => s.includes(m[0])) || m[0];
      if (company && (recruitingStyle || bigSystem)) {
        add(`personal email address (${m[2].toLowerCase()}) used for ${company} recruiting`, sent);
        break;
      }
      if (!company && recruitingStyle) {
        add(`recruiting from a personal email address (${m[2].toLowerCase()})`, sent);
        break;
      }
    }

    // 8. Very high pay for unskilled entry-level work
    const title = String(role || '');
    const unskilled = UNSKILLED.test(title) || (!title && UNSKILLED.test(cpSlice(text, 400)));
    if (unskilled || (UNSKILLED.test(text) && ENTRY.test(text) && words(text) < 400)) {
      for (const s of sentences) {
        for (const m of s.matchAll(MONEY)) {
          const [wage, cur] = wagePerHour(m);
          const limit = cur === '\u00a3' || cur === 'GBP' ? 30 : 40;
          if (wage > limit) {
            add('pay far above normal for unskilled entry-level work', s, m);
            break;
          }
        }
        if ([...found.keys()].some((k) => k.startsWith('pay far above'))) break;
      }
    }

    // 9. Very short, vague description
    const count = (text.match(WORD) || []).length;
    if (strip(text) && (count < 60 || (count < 120 && !SUBSTANCE.test(text)))) {
      add('very short, vague description', `only ${count} words`);
    }

    return [...found].map(([flag, q]) => ({ flag, quote: q }));
  }

  return { redFlags, splitSentences, pyRegex, _internals: { quote, strip, collapse, cpSlice, splitlines } };
});
