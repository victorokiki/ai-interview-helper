// Autonomous Job Kit bridge: reads the job-search folder that the kit keeps
// (tracker.xlsx, Applications/<date Company - Role>/ with job-posting.md,
// application-record.md, answers-to-paste.md, changes.md, profile.json) and
// turns it into Interview Helper jobs, "what you sent" records for live
// answers, and suggested Interview Brain facts.
// Pure (no file access): src/jobkit.js reads the files and passes text in.
// Loads as CommonJS or as a browser global (CoreJobKit).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CoreJobKit = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // ---------- tracker.xlsx (the kit's lib/jobkit/tracker.py layout) ----------

  // Header text → key, as tracker.py names them. Columns are found by header,
  // so a user who reorders or adds columns in Excel is still read correctly.
  const COLUMNS = [
    ['id', 'ID'], ['date_added', 'Date added'], ['company', 'Company'], ['role', 'Role'], ['term', 'Term'],
    ['location', 'Location'], ['deadline', 'Deadline'], ['status', 'Status'], ['status_updated', 'Status updated'],
    ['next_step', 'Next step'], ['interview_date', 'Interview date'], ['posting_url', 'Posting'],
    ['folder', 'Folder'], ['resume', 'Resume file'], ['gaps', 'Gaps'], ['notes', 'Notes'],
    ['interview_stage', 'Interview stage'], ['last_checked', 'Last checked'],
  ];
  const LINK_LABELS = { posting_url: 'Open posting', folder: 'Open folder' };

  const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  function decodeXml(s) {
    return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
      const k = e.toLowerCase();
      if (k === 'amp') return '&';
      if (k === 'lt') return '<';
      if (k === 'gt') return '>';
      if (k === 'quot') return '"';
      if (k === 'apos') return "'";
      const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    });
  }

  const attr = (tag, name) => {
    const m = new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${name}="([^"]*)"`).exec(tag);
    return m ? decodeXml(m[1]) : null;
  };

  // Text of every <t> inside a fragment (rich-text runs are joined).
  function allText(fragment) {
    let out = '';
    for (const m of fragment.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)) out += decodeXml(m[1]);
    return out;
  }

  function sharedStrings(xml) {
    if (!xml) return [];
    return [...xml.matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((m) => allText(m[1]));
  }

  // "AB12" → zero-based column 27.
  function colIndex(ref) {
    const letters = /^[A-Z]+/i.exec(ref || '')?.[0]?.toUpperCase() || '';
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  function relTargets(xml) {
    const out = {};
    for (const m of String(xml || '').matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?>/g)) {
      const id = attr(m[1], 'Id');
      if (id) out[id] = attr(m[1], 'Target') || '';
    }
    return out;
  }

  // A zip path for a relationship target, relative to the part that owns it.
  function resolvePart(base, target) {
    if (!target) return '';
    if (target.startsWith('/')) return target.slice(1);
    const parts = base.split('/').slice(0, -1);
    for (const seg of target.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg && seg !== '.') parts.push(seg);
    }
    return parts.join('/');
  }

  // Rows of one worksheet: [[cell values]], with hyperlink targets by cell ref.
  function readSheet(xml, strings, rels) {
    const rows = [];
    const data = /<(?:\w+:)?sheetData[^>]*>([\s\S]*?)<\/(?:\w+:)?sheetData>/.exec(xml)?.[1] || '';
    let rowNo = 0;
    for (const rm of data.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
      rowNo = Number(attr(rm[1], 'r')) || rowNo + 1;
      const cells = [];
      let col = -1;
      for (const cm of (rm[2] || '').matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        const ref = attr(cm[1], 'r');
        col = ref ? colIndex(ref) : col + 1;
        const type = attr(cm[1], 't') || 'n';
        const inner = cm[2] || '';
        const v = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1];
        let value = '';
        if (type === 'inlineStr') value = allText(inner);
        else if (type === 's') value = strings[Number(v)] ?? '';
        else if (type === 'str' || type === 'e') value = decodeXml(v ?? '');
        else if (type === 'b') value = v === '1';
        else if (v != null && v !== '') value = Number(v);
        cells[col] = value;
      }
      rows.push({ rowNo, cells });
    }
    const links = {};
    for (const hm of xml.matchAll(/<(?:\w+:)?hyperlink\b([^>]*)\/?>/g)) {
      const ref = attr(hm[1], 'ref');
      const id = attr(hm[1], 'id');
      const target = id ? rels[id] : null;
      if (ref && target) links[ref.toUpperCase()] = target;
    }
    return { rows, links };
  }

  const colName = (i) => {
    let s = '';
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  };

  function safeDecode(s) {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  }

  // files: { 'xl/workbook.xml': text, ... } (every XML part of the .xlsx).
  // Returns the application rows as tracker.py's rows() + read_links() would:
  // link columns hold their targets, the folder decoded.
  function parseTracker(files) {
    const wb = files['xl/workbook.xml'];
    if (!wb) throw new Error('This is not an Excel workbook (.xlsx).');
    const wbRels = relTargets(files['xl/_rels/workbook.xml.rels']);
    const sheets = [...wb.matchAll(/<(?:\w+:)?sheet\b([^>]*)\/?>/g)].map((m) => ({ name: attr(m[1], 'name') || '', rid: attr(m[1], 'id') }));
    if (!sheets.length) throw new Error('The workbook has no sheets.');
    const sheet = sheets.find((s) => norm(s.name) === 'applications') || sheets[0];
    const part = resolvePart('xl/workbook.xml', wbRels[sheet.rid] || 'worksheets/sheet1.xml');
    const xml = files[part];
    if (!xml) throw new Error('The Applications sheet could not be read.');
    const relPart = part.replace(/([^/]+)$/, '_rels/$1.rels');
    const strings = sharedStrings(files['xl/sharedStrings.xml']);
    const { rows, links } = readSheet(xml, strings, relTargets(files[relPart]));
    if (!rows.length) return [];
    const byHeader = {};
    for (const [key, header] of COLUMNS) byHeader[norm(header)] = key;
    for (const [key] of COLUMNS) byHeader[norm(key)] = key;
    const header = rows[0].cells.map((h) => byHeader[norm(h)] || null);
    if (!header.includes('company')) throw new Error('No "Company" column in the tracker.');
    const out = [];
    for (const { rowNo, cells } of rows.slice(1)) {
      const rec = {};
      header.forEach((key, i) => {
        if (!key || key in rec) return;
        const v = cells[i];
        rec[key] = typeof v === 'string' ? v.trim() : v ?? '';
        if (LINK_LABELS[key]) {
          const target = links[`${colName(i)}${rowNo}`];
          if (target) rec[key] = key === 'folder' ? safeDecode(target) : target;
          else if (rec[key] === LINK_LABELS[key]) rec[key] = '';
        }
      });
      if (Object.values(rec).some((v) => v !== '' && v != null)) out.push(rec);
    }
    return out;
  }

  // ---------- dates ----------

  // A date cell as { y, m, d, hh, mm, hasTime }: Excel serial day numbers
  // (with a fraction for the time) or text "YYYY-MM-DD[ HH:MM]".
  function parseWhen(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number' && v > 20000 && v < 80000) {
      const day = Math.floor(v);
      const minutes = Math.round((v - day) * 1440);
      const d = new Date(Date.UTC(1899, 11, 30) + day * 86400000);
      return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: Math.floor(minutes / 60), mm: minutes % 60, hasTime: minutes > 0 };
    }
    const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(String(v));
    if (!m) return null;
    return { y: +m[1], m: +m[2], d: +m[3], hh: m[4] ? +m[4] : 0, mm: m[5] ? +m[5] : 0, hasTime: Boolean(m[4]) };
  }

  // Local-time milliseconds (the kit writes dates in the user's own time).
  const toLocalMs = (w, hh = w.hh, mm = w.mm) => new Date(w.y, w.m - 1, w.d, hh, mm).getTime();
  const isoDay = (w) => `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;

  // ---------- statuses ----------

  const STATUSES = ['Ready to submit', 'Submitted', 'Online assessment', 'Interviewing', 'Offer', 'Accepted', 'Declined', 'Rejected', 'Withdrawn', 'Needs you', 'Skipped'];
  const ALIASES = {
    applied: 'Submitted', sent: 'Submitted', oa: 'Online assessment', assessment: 'Online assessment',
    interview: 'Interviewing', 'phone screen': 'Interviewing', hired: 'Accepted', 'offer accepted': 'Accepted',
    'not selected': 'Rejected', withdrew: 'Withdrawn', skip: 'Skipped', ready: 'Ready to submit', blocked: 'Needs you',
  };
  const STAGE_OF = {
    'Ready to submit': 'saved', 'Needs you': 'saved', Submitted: 'applied', 'Online assessment': 'screening',
    Interviewing: 'interviewing', Offer: 'offer', Accepted: 'offer', Declined: 'closed', Withdrawn: 'closed',
    Rejected: 'rejected', Skipped: 'closed',
  };
  const PIPELINE = ['saved', 'applied', 'screening', 'interviewing', 'offer'];

  function canonicalStatus(s) {
    const word = norm(String(s ?? '').split(':')[0]);
    if (!word) return '';
    const exact = STATUSES.find((st) => norm(st) === word);
    if (exact) return exact;
    if (ALIASES[word]) return ALIASES[word];
    const hits = STATUSES.filter((st) => norm(st).startsWith(word));
    return hits.length === 1 ? hits[0] : '';
  }

  // ---------- the job folder's Markdown files ----------

  // "## Heading" sections: { 'heading in lower case': body }.
  function sections(md) {
    const out = {};
    let key = '';
    for (const line of String(md || '').replace(/\r\n?/g, '\n').split('\n')) {
      const h = /^##\s+(.+?)\s*$/.exec(line);
      if (h) {
        key = h[1].toLowerCase();
        out[key] = '';
      } else if (key) out[key] += `${line}\n`;
      else out[''] = `${out[''] || ''}${line}\n`;
    }
    for (const k of Object.keys(out)) out[k] = out[k].trim();
    return out;
  }

  // "- Label: value" lines at the top of a file.
  function bulletFields(text) {
    const out = {};
    for (const m of String(text || '').matchAll(/^\s*-\s+([^:\n]{1,60}):\s*(.*)$/gm)) out[m[1].trim().toLowerCase()] = m[2].trim();
    return out;
  }

  const notStated = (v) => (!v || /^(not stated|none|unknown|n\/a)$/i.test(v.trim()) ? '' : v.trim());

  // job-posting.md, written by the kit's fetch_posting.py.
  function parsePosting(md) {
    const s = sections(md);
    const head = bulletFields(s['']);
    const title = /^#\s+(.+)$/m.exec(md || '')?.[1] || '';
    return {
      company: notStated(head.company),
      role: notStated(head.role),
      url: notStated(head.url),
      location: notStated(head.location),
      deadline: notStated(head.deadline),
      pay: notStated(head.pay),
      title: title.trim(),
      description: s.description || '',
      questions: s['application questions'] || '',
      redFlags: notStated(head['red flags']),
    };
  }

  // application-record.md: what was entered on the form (filling.md format).
  function parseRecord(md) {
    const s = sections(md);
    const head = bulletFields(s['']);
    const fields = [];
    for (const line of (s.fields || '').split('\n')) {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.length < 2 || /^-+$/.test(cells[0].replace(/:/g, '')) || /^field\b/i.test(cells[0])) continue;
      if (cells[0] && cells[1]) fields.push({ label: cells[0], value: cells[1] });
    }
    const answers = [];
    const written = s['written answers'] || '';
    for (const block of written.split(/^###\s+/m).slice(1)) {
      const [q, ...rest] = block.split('\n');
      // Markdown wraps long lines: join them, keep paragraph breaks.
      const answer = rest.join('\n').trim().replace(/([^\n])\n(?!\n)/g, '$1 ');
      if (q.trim() && answer) answers.push({ question: q.trim(), answer });
    }
    const listItems = (t) => String(t || '').split('\n').map((l) => l.replace(/^\s*-\s+/, '').trim()).filter(Boolean);
    return {
      formLink: head['form link'] || '',
      filledAt: head['date and time filled'] || '',
      resumeFile: (head['resume file'] || '').replace(/\s*\(.*\)\s*$/, '').trim(),
      letterFile: /^none$/i.test(head.letter || '') ? '' : (head.letter || '').trim(),
      status: head.status || '',
      fields,
      answers,
      changesBeforeSubmitting: listItems(s['changes before submitting']),
    };
  }

  // answers-to-paste.md (lean level). "yours" answers are left for the user.
  function parseAnswersToPaste(md) {
    const s = sections(md);
    const answers = [];
    for (const m of (s.answers || '').matchAll(/^\s*-\s+(.+?):\s+(.+)$/gm)) {
      if (/^yours\.?$/i.test(m[2].trim())) continue;
      answers.push({ question: m[1].trim(), answer: m[2].trim() });
    }
    return { link: /^Link:\s*(\S+)/m.exec(md || '')?.[1] || '', answers };
  }

  // changes.md: the gaps the tailored resume left out on purpose.
  function parseChanges(md) {
    const s = sections(md);
    const gaps = (s.gaps || '').split('\n').map((l) => l.replace(/^\s*-\s+/, '').trim()).filter(Boolean);
    const kw = /^\s*-\s*Gaps:\s*(.+)$/im.exec(s['ats keywords'] || '')?.[1] || '';
    return { gaps, keywordGaps: kw.trim() };
  }

  // "2026-11-02 Northwind Freight - Junior Data Analyst" → date, company, role.
  function folderGuess(name) {
    const m = /^(\d{4}-\d{2}-\d{2})\s+(.+?)\s+-\s+(.+)$/.exec(String(name || '').trim());
    return m ? { date: m[1], company: m[2], role: m[3] } : { date: '', company: String(name || '').trim(), role: '' };
  }

  // ---------- profile.json → suggested Interview Brain facts ----------

  // Self-identification and identity numbers are never imported, whatever
  // the user saved for application forms.
  const NEVER = /gender|race|ethnic|hispanic|latin|disab|veteran|pronoun|orientation|lgbt|transgender|sexual|\bage\b|years of age|birth|\bssn\b|social (security|insurance)|\bsin\b|passport|password|bank|credit card|religio|marital|criminal|convict|accommodat|medical|health/i;
  const INTERVIEW_RELEVANT = /salary|compensation|pay|notice|start|availab|relocat|sponsor|visa|authori[sz]|permit|citizen|remote|hybrid|on-?site|commute|travel|currently employed|clearance|overtime|shift|full-?time|part-?time/i;
  const PROFILE_FIELDS = [
    ['salary', 'Salary expectation', 'other'],
    ['availableFrom', 'Available to start', 'other'],
    ['startDate', 'Earliest start date', 'other'],
    ['workPreference', 'Work preference', 'other'],
    ['willingToRelocate', 'Willing to relocate', 'other'],
    ['needsSponsorship', 'Needs visa sponsorship', 'other'],
    ['workAuthDetails', 'Work authorization', 'other'],
    ['yearsExperience', 'Years of experience', 'experience'],
    ['employmentType', 'Looking for', 'other'],
    ['certifications', 'Certifications', 'education'],
    ['securityClearance', 'Security clearance', 'other'],
  ];

  const sentence = (label, value) => `${label}: ${String(value).replace(/\s+/g, ' ').trim()}`.slice(0, 400);
  const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // Saved answers are phrase matches for application forms, so many are
  // fragments ("currently employed by" [this company], "relocat") or the same
  // answer under several phrasings. As interview facts those mislead, so:
  // fragments ending in a preposition are dropped, a stem covered by a fuller
  // phrase with the same answer is dropped, and repeated longer answers (an
  // expiry date given for "work permit", "study permit" and "permit expiry")
  // are kept once. Short answers such as "Yes" are never merged.
  const FRAGMENT = /\b(by|at|with|for|to|of|in|from|on|about)$/i;
  const words = (s) => norm(s).replace(/\b(a|an|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const bareAnswer = (s) => words(String(s).replace(/^[A-Za-z][A-Za-z ]{0,24}:\s*/, ''));

  function profileFacts(profile) {
    if (!profile || typeof profile !== 'object') return [];
    const items = [];
    const saved = (Array.isArray(profile.savedAnswers) ? profile.savedAnswers : [])
      .map((a) => ({ match: String(a?.match ?? '').trim(), answer: String(a?.answer ?? '').trim() }))
      .filter((a) => a.match && a.answer && !NEVER.test(a.match) && !NEVER.test(a.answer) && !FRAGMENT.test(a.match));
    // A saved "years of experience" answer is more careful than the single number.
    const nuancedYears = saved.some((a) => /years of experience/i.test(a.match));
    for (const [key, label, category] of PROFILE_FIELDS) {
      const v = profile[key];
      if (v == null || v === '' || typeof v === 'object' || (key === 'yearsExperience' && nuancedYears)) continue;
      items.push({ label, answer: String(v), category, suggested: true });
    }
    for (const a of saved) {
      if (saved.some((b) => b !== a && b.match.length > a.match.length && words(b.match).includes(words(a.match)) && words(b.answer) === words(a.answer))) continue;
      items.push({ label: capital(a.match), answer: a.answer, category: /years of experience/i.test(a.match) ? 'experience' : 'other', suggested: INTERVIEW_RELEVANT.test(a.match) || /years of experience/i.test(a.match) });
    }
    const out = [];
    const byLabel = new Map();
    const longAnswers = [];
    for (const it of items) {
      const lk = words(it.label);
      const prev = byLabel.get(lk);
      if (prev) {
        // Same question twice: keep the fuller answer.
        if (it.answer.length > prev.answer.length) Object.assign(prev, it);
        continue;
      }
      const ba = bareAnswer(it.answer);
      if (ba.split(' ').length >= 3 && longAnswers.some((x) => x.startsWith(ba) || ba.startsWith(x))) continue;
      if (ba.split(' ').length >= 3) longAnswers.push(ba);
      byLabel.set(lk, it);
      out.push(it);
    }
    const seen = new Set();
    return out
      .map((it) => ({ text: sentence(it.label, it.answer), category: it.category, source: 'Job kit profile', suggested: it.suggested }))
      .filter((f) => {
        const k = norm(f.text);
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
  }

  // ---------- search settings and work authorization (for fit and eligibility) ----------

  const strList = (v, n = 60, len = 80) => (Array.isArray(v) ? v.map((s) => String(s ?? '').trim().slice(0, len)).filter(Boolean).slice(0, n) : []);

  // The parts of the kit's search.json the fit score reads, cleaned.
  function cleanSearch(s) {
    if (!s || typeof s !== 'object') return null;
    const tracks = {};
    if (s.tracks && typeof s.tracks === 'object') {
      for (const [name, t] of Object.entries(s.tracks).slice(0, 20)) {
        if (!t || typeof t !== 'object') continue;
        const titles = strList(t.titles, 40);
        if (titles.length) tracks[String(name).slice(0, 60)] = { priority: Math.max(0, Math.min(1, Number(t.priority ?? 1) || 0)), titles };
      }
    }
    const out = {
      country: String(s.country ?? '').trim().slice(0, 60),
      province: String(s.province ?? '').trim().slice(0, 60),
      state: String(s.state ?? '').trim().slice(0, 60),
      region: String(s.region ?? '').trim().slice(0, 60),
      local_places: strList(s.local_places, 40),
      tracks,
      // Not trimmed: the kit uses spaces on purpose ("staff ", "lead ") so
      // "Staffing" and "Leader" are not excluded.
      exclude_titles: Array.isArray(s.exclude_titles) ? s.exclude_titles.map((x) => String(x ?? '').slice(0, 80)).filter((x) => x.trim()).slice(0, 60) : [],
      extra_skills: strList(s.extra_skills, 100),
      pathway: s.pathway && typeof s.pathway === 'object' ? Object.fromEntries(Object.entries(s.pathway).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 20).map(([k, v]) => [String(k).slice(0, 40), typeof v === 'string' ? v.slice(0, 200) : v])) : { type: 'none' },
    };
    for (const k of ['province', 'state', 'region']) if (!out[k]) delete out[k];
    // Job discovery: employer boards to follow, Job Bank searches, Remotive
    // categories, and the score a match needs.
    if (s.employers && typeof s.employers === 'object') {
      const emp = {};
      for (const sys of ['greenhouse', 'lever', 'ashby', 'smartrecruiters']) {
        const list = strList(s.employers[sys], 100, 120);
        if (list.length) emp[sys] = list;
      }
      const wd = Array.isArray(s.employers.workday)
        ? s.employers.workday
            .filter((w) => w && typeof w === 'object')
            .slice(0, 50)
            .map((w) => Object.fromEntries(Object.entries(w).filter(([, v]) => typeof v === 'string').slice(0, 10).map(([k, v]) => [String(k).slice(0, 40), v.slice(0, 200)])))
            .filter((w) => Object.keys(w).length)
        : [];
      if (wd.length) emp.workday = wd;
      if (Object.keys(emp).length) out.employers = emp;
    }
    const jq = strList(s.jobbank_queries, 30);
    if (jq.length) out.jobbank_queries = jq;
    const rc = strList(s.remotive_categories, 20);
    if (rc.length) out.remotive_categories = rc;
    if (Number.isFinite(Number(s.min_score_to_queue)) && s.min_score_to_queue !== '' && s.min_score_to_queue != null) out.min_score_to_queue = Math.max(0, Math.min(100, Number(s.min_score_to_queue)));
    return out;
  }

  // Work-authorization answers the eligibility screen reads (kit profile.json
  // field names). Stays on this PC; never sent to the AI.
  const SITUATION_KEYS = ['authCountry', 'country', 'workAuthDetails', 'workAuthorized', 'needsSponsorship', 'needsSponsorshipForInternship', 'enrolled', 'classStanding', 'expectedGraduation', 'city', 'state', 'willingToRelocate'];
  function cleanSituation(p) {
    if (!p || typeof p !== 'object') return null;
    const out = {};
    for (const k of SITUATION_KEYS) {
      const v = p[k];
      if (typeof v === 'boolean') out[k] = v ? 'yes' : 'no';
      else if (v != null && String(v).trim()) out[k] = String(v).trim().slice(0, 200);
    }
    const edu = Array.isArray(p.education) ? p.education.slice(0, 3).map((e) => ({ degree: String(e?.degree ?? '').slice(0, 120), end: String(e?.end ?? '').slice(0, 40), endExact: String(e?.endExact ?? '').slice(0, 40) })).filter((e) => e.degree || e.end || e.endExact) : [];
    if (edu.length) out.education = edu;
    return Object.keys(out).length ? out : null;
  }

  // ---------- one application, as stored on the job ----------

  const MAX = { resume: 12000, letter: 5000, answer: 3000, answers: 30, fields: 40, gaps: 20 };
  // Contact details and self-identification are not repeated to the AI.
  const PERSONAL_FIELD = /name|e-?mail|phone|mobile|address|street|postal|zip|city|province|state\b|country|linkedin|github|website|portfolio|url|link|resume|cv\b|cover|transcript|attach|upload|file|signature/i;

  const clip = (s, n) => String(s ?? '').replace(/\r\n?/g, '\n').trim().slice(0, n);

  function buildApplication({ folder = '', record = null, paste = null, changes = null, resumeFile = '', resumeText = '', letterFile = '', letterText = '', importedAt = Date.now() } = {}) {
    const answers = [...(record?.answers || []), ...(paste?.answers || [])]
      .slice(0, MAX.answers)
      .map((a) => ({ question: clip(a.question, 500), answer: clip(a.answer, MAX.answer) }));
    const fields = (record?.fields || [])
      .filter((f) => !PERSONAL_FIELD.test(f.label) && !NEVER.test(f.label))
      .slice(0, MAX.fields)
      .map((f) => ({ label: clip(f.label, 200), value: clip(f.value, 500) }));
    return {
      source: 'jobkit',
      folder: clip(folder, 500),
      resumeFile: clip(resumeFile, 300),
      resumeText: clip(resumeText, MAX.resume),
      letterFile: clip(letterFile, 300),
      letterText: clip(letterText, MAX.letter),
      answers,
      fields,
      changesBeforeSubmitting: (record?.changesBeforeSubmitting || []).slice(0, 20).map((c) => clip(c, 500)),
      gaps: (changes?.gaps || []).slice(0, MAX.gaps).map((g) => clip(g, 400)),
      keywordGaps: clip(changes?.keywordGaps, 400),
      formLink: clip(record?.formLink || paste?.link || '', 2000),
      lean: Boolean(paste && !record),
      importedAt,
    };
  }

  function hasContent(app) {
    return Boolean(app && (app.resumeText || app.letterText || app.answers?.length || app.fields?.length || app.gaps?.length));
  }

  // Validates an application object coming back from the renderer or disk.
  function cleanApplication(app) {
    if (!app || typeof app !== 'object' || app.source !== 'jobkit') return null;
    const arr = (v, n, f) => (Array.isArray(v) ? v.slice(0, n).map(f).filter(Boolean) : []);
    return {
      source: 'jobkit',
      folder: clip(app.folder, 500),
      resumeFile: clip(app.resumeFile, 300),
      resumeText: clip(app.resumeText, MAX.resume),
      letterFile: clip(app.letterFile, 300),
      letterText: clip(app.letterText, MAX.letter),
      answers: arr(app.answers, MAX.answers, (a) => (a && a.question && a.answer ? { question: clip(a.question, 500), answer: clip(a.answer, MAX.answer) } : null)),
      fields: arr(app.fields, MAX.fields, (f) => (f && f.label && f.value ? { label: clip(f.label, 200), value: clip(f.value, 500) } : null)),
      changesBeforeSubmitting: arr(app.changesBeforeSubmitting, 20, (c) => clip(c, 500) || null),
      gaps: arr(app.gaps, MAX.gaps, (g) => clip(g, 400) || null),
      keywordGaps: clip(app.keywordGaps, 400),
      formLink: clip(app.formLink, 2000),
      lean: Boolean(app.lean),
      importedAt: Number(app.importedAt) || Date.now(),
    };
  }

  // The prompt block for live answers, practice and prep: what the employer
  // already has from the candidate, so answers stay consistent with it.
  function applicationBlock(app, job) {
    if (!hasContent(app)) return '';
    const who = [job?.company, job?.role].filter(Boolean).join(', ') || 'this employer';
    const parts = [
      `The candidate already sent this application to ${who} (imported from their Autonomous Job Kit folder${app.lean ? '; prepared answers they pasted into the form' : ''}). The interviewer may have it in front of them. Stay consistent with it: use the same numbers, titles, dates and stories, and the same salary, availability and other answers they gave on the form. Everything in it counts as the candidate's own verified material.`,
    ];
    if (app.resumeText) parts.push(`<resume_sent${app.resumeFile ? ` file="${app.resumeFile.replace(/"/g, '')}"` : ''}>\n${app.resumeText}\n</resume_sent>`);
    if (app.letterText) parts.push(`<cover_letter_sent>\n${app.letterText}\n</cover_letter_sent>`);
    const qa = [...app.fields.map((f) => `- ${f.label}: ${f.value}`), ...app.answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`)];
    if (qa.length) parts.push(`<form_answers_sent>\n${qa.join('\n')}\n</form_answers_sent>`);
    if (app.changesBeforeSubmitting?.length) parts.push(`<changed_before_submitting>\nThe candidate edited the form before sending; these edits are what the employer has:\n${app.changesBeforeSubmitting.map((c) => `- ${c}`).join('\n')}\n</changed_before_submitting>`);
    const gaps = [...(app.gaps || []), app.keywordGaps && `Keywords the candidate lacks: ${app.keywordGaps}`].filter(Boolean);
    if (gaps.length) parts.push(`<known_gaps>\nThe application left these requirements out because the candidate does not have them. If one comes up, answer honestly from the closest real experience; never claim it.\n${gaps.map((g) => `- ${g}`).join('\n')}\n</known_gaps>`);
    return `<application_sent>\n${parts.join('\n')}\n</application_sent>`;
  }

  // ---------- matching kit applications to jobs ----------

  const companyKey = (s) => norm(s).replace(/\b(inc|incorporated|ltd|limited|llc|corp|corporation|co|company|plc|gmbh|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
  function urlKey(u) {
    try {
      const x = new URL(String(u || ''));
      return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}`.toLowerCase();
    } catch {
      return '';
    }
  }

  function findMatch(app, jobs) {
    const byLink = jobs.find((j) => j.jobKit && ((app.trackerId && j.jobKit.id === app.trackerId) || (app.folder && j.jobKit.folder === app.folder)));
    if (byLink) return byLink;
    const uk = urlKey(app.url);
    const byUrl = uk && jobs.find((j) => urlKey(j.url) === uk);
    if (byUrl) return byUrl;
    const ck = companyKey(app.company);
    const rk = norm(app.role);
    return (ck && rk && jobs.find((j) => companyKey(j.company) === ck && norm(j.role) === rk)) || null;
  }

  // One review item per kit application: new job, update a job, or skip.
  // apps: [{ key, trackerId, folder, company, role, status, url, ... }]
  function planImport(apps, jobs) {
    return apps.map((app) => {
      const match = findMatch(app, jobs);
      let action = match ? 'update' : 'new';
      let reason = '';
      if (app.status === 'Skipped') {
        action = 'skip';
        reason = 'Skipped in the job kit';
      } else if (!app.company && !app.role) {
        action = 'skip';
        reason = 'No company or role';
      }
      return { app, action, jobId: match?.id || null, reason };
    });
  }

  function appendLines(existing, lines) {
    const have = String(existing || '');
    const lower = have.toLowerCase();
    const fresh = lines.filter((l) => l && !lower.includes(l.toLowerCase()));
    return fresh.length ? [have.trim(), ...fresh].filter(Boolean).join('\n') : have;
  }

  // Note lines for the job, from the tracker row.
  function noteLines(app) {
    const status = [app.status && `Job kit: ${app.status}${app.statusUpdated ? ` (${app.statusUpdated})` : ''}`, app.interviewStage && `stage: ${app.interviewStage}`, app.nextStep && `next step: ${app.nextStep}`].filter(Boolean).join(', ');
    return [status && `${status}.`, app.interviewDay && `Interview date in the job kit: ${app.interviewDay} (no time given).`, app.gapsCell && `Gaps noted by the job kit: ${app.gapsCell}`, app.notesCell && `Job kit notes: ${app.notesCell}`].filter(Boolean);
  }

  function description(app) {
    const head = [app.location && `Location: ${app.location}`, app.pay && `Pay: ${app.pay}`].filter(Boolean).join('\n');
    return [head, app.description].filter(Boolean).join('\n\n');
  }

  // The saveJob() input for an item: a new job, or an existing one updated
  // without overwriting what the user typed. The kit's status wins only when
  // it changed since the last import (or, the first time, when it is further
  // along than the job's stage or final).
  function mergeJob(existing, app, now = Date.now()) {
    const stage = STAGE_OF[app.status] || (app.submitted ? 'applied' : 'saved');
    const kit = { id: app.trackerId || '', folder: app.folder || '', status: app.status || '', interviewAt: app.interviewAt || null, importedAt: now };
    const base = {
      application: app.application && hasContent(app.application) ? app.application : null,
      jobKit: kit,
    };
    if (!existing) {
      return {
        ...base,
        company: app.company,
        role: app.role,
        stage,
        url: app.url,
        jobDescription: description(app),
        interviewAt: app.interviewAt || null,
        applyBy: app.applyBy || null,
        notes: noteLines(app).join('\n'),
      };
    }
    const before = existing.jobKit;
    let nextStage = existing.stage;
    if (app.status) {
      if (before) {
        if (before.status !== app.status) nextStage = stage;
      } else {
        const k = PIPELINE.indexOf(stage);
        const e = PIPELINE.indexOf(existing.stage);
        if (k === -1 || (e !== -1 && k > e)) nextStage = stage; // final in the kit, or further along
      }
    }
    const interviewChanged = Boolean(app.interviewAt) && (!existing.interviewAt || Boolean(before && before.interviewAt !== app.interviewAt));
    return {
      ...existing,
      ...base,
      company: existing.company || app.company,
      role: existing.role || app.role,
      stage: nextStage,
      url: existing.url || app.url,
      jobDescription: existing.jobDescription || description(app),
      interviewAt: interviewChanged ? app.interviewAt : existing.interviewAt,
      applyBy: existing.applyBy || app.applyBy || null,
      notes: appendLines(existing.notes, noteLines(app)),
      application: base.application || existing.application || null,
    };
  }

  // The tracker row's dates, as job fields.
  function rowDates(row) {
    const iv = parseWhen(row.interview_date);
    const dl = parseWhen(row.deadline);
    const su = parseWhen(row.status_updated);
    return {
      interviewAt: iv && iv.hasTime ? toLocalMs(iv) : null,
      interviewDay: iv && !iv.hasTime ? isoDay(iv) : '',
      applyBy: dl ? toLocalMs(dl, 23, 59) : null,
      statusUpdated: su ? isoDay(su) : '',
    };
  }

  return {
    COLUMNS,
    STATUSES,
    STAGE_OF,
    decodeXml,
    parseTracker,
    parseWhen,
    rowDates,
    canonicalStatus,
    sections,
    parsePosting,
    parseRecord,
    parseAnswersToPaste,
    parseChanges,
    folderGuess,
    profileFacts,
    cleanSearch,
    cleanSituation,
    SITUATION_KEYS,
    buildApplication,
    cleanApplication,
    hasContent,
    applicationBlock,
    planImport,
    mergeJob,
    urlKey,
    companyKey,
  };
});
