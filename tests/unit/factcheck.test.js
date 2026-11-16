// Résumé fact-checker (port of the Autonomous Job Kit's lib/jobkit/bullets.py):
// bullet extraction, classification, fact checks, the answer-style cases the
// live copilot needs, and parity with the Python.
//
// Parity: the Python results for every case below are stored in
// tests/fixtures/jobkit/resume/parity-golden.json and always checked. With
// JOBKIT_PYTHON (a python executable) and JOBKIT_LIB (the kit's lib/ folder)
// set, the Python also runs live; FACTCHECK_WRITE_GOLDEN=1 rewrites the golden
// file from that run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const F = require('../../packages/core/factcheck');

const FIX = path.join(__dirname, '..', 'fixtures', 'jobkit', 'resume');
const read = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const MASTER = read('master.tex');
const TAILORED = read('tailored.tex');
const TODAY = '2026-11-16';

// ---------- ported from tests/test_resume_pipeline.py ----------

test('visible LaTeX text skips the preamble and spacing lengths', () => {
  const src = '\\documentclass[11pt]{article}\\usepackage[margin=0.6in]{geometry}\\begin{document}' +
    'Hello\\\\[2pt] world \\vspace{-3pt} 42 items\\end{document}';
  const vis = F.visibleSourceText(src);
  assert.match(vis, /42/);
  assert.doesNotMatch(vis, /11/);
  assert.doesNotMatch(vis, /2pt/);
});

test('master bullets and custom item macros', () => {
  const bs = F.texBullets(MASTER);
  assert.equal(bs.length, 12);
  assert.ok(bs.includes('Answered 30-40 customer emails a day in English and French.'));
  assert.ok(bs.every((b) => !b.includes('\\')));
  const src = '\\newcommand{\\resumeItem}[1]{\\item\\small{#1}}\n\\newcommand{\\resumeItemListStart}{\\begin{itemize}}\n' +
    '\\begin{document}\n\\resumeItemListStart\n\\resumeItem{Built a \\textbf{SQL} report for 3 teams}\n' +
    '\\resumeItem{Wrote tests in Python}\n\\resumeItemListEnd\n\\begin{itemize}\\item Plain item\n' +
    '\\end{itemize}\n\\end{document}';
  assert.deepEqual(F.texBullets(src), ['Built a SQL report for 3 teams', 'Wrote tests in Python', 'Plain item']);
  assert.deepEqual(F.extractBullets(src), F.texBullets(src));
});

test('plain-text bullets: bullet signs, wrapped lines, headings end a bullet', () => {
  const text = 'EXPERIENCE\n• Built a dashboard for 4 managers\n  that tracks delivery\n- Answered customer emails.\nSKILLS\n– Python';
  assert.deepEqual(F.plainBullets(text), ['Built a dashboard for 4 managers that tracks delivery', 'Answered customer emails.', 'Python']);
});

test('classification kinds on the tailored fixture', () => {
  const mb = F.texBullets(MASTER);
  const items = F.classify(mb, F.texBullets(TAILORED));
  const kinds = Object.fromEntries(items.map((i) => [i.text.slice(0, 20), i.kind]));
  assert.equal(kinds['Automated weekly shi'], 'reworded');
  assert.equal(kinds['Kept inventory count'], 'merged');
  assert.equal(kinds['Presented quarterly '], 'no_source');
  assert.equal(kinds['Built a Power BI das'], 'unchanged');
  assert.equal(kinds['Reduced duplicate cu'], 'reworded');   // a changed number is never "unchanged"
  assert.equal(items.find((i) => i.kind === 'merged').source.length, 2);
  // what compare_bullets.py reports from the same classification
  assert.equal(items.length, 11);
  assert.equal(items.filter((i) => i.kind === 'no_source').length, 1);
  const used = new Set(items.filter((i) => i.kind !== 'no_source').flatMap((i) => i.source));
  assert.ok(mb.filter((b) => !used.has(b)).includes('Relevant courses: Database Systems, Statistics for Business, Data Visualization.'));
  assert.equal(items.filter((i) => F.isSkillsLine(i.text)).length, 3);
  assert.deepEqual(F.classify([], ['Anything at all here']), [{ text: 'Anything at all here', kind: 'no_source', source: [], score: 0 }]);
});

test('similarity bounds', () => {
  assert.equal(F.similarity('Same text here', 'same text here!'), 1);
  assert.ok(F.similarity('Cooked pasta for a restaurant', 'Built SQL dashboards') < 0.4);
  assert.equal(F.similarity('', 'x'), 0);
});

test('fact check: the tailored fixture, then with allow', () => {
  const res = F.factCheck(MASTER, TAILORED, { resume: true, today: TODAY });
  assert.equal(res.ok, false);
  assert.deepEqual(res.newNumbers.map((n) => n.raw), ['25%']);
  assert.deepEqual(res.newTerms.map((t) => t.term), ['Tableau']);
  assert.deepEqual(res.missingContact, []);
  assert.deepEqual(res.counts, { newNumbers: 1, newTerms: 1, missingContact: 0, placeholders: 0 });
  const ok = F.factCheck(MASTER, TAILORED, { allow: ['Tableau', '25%'], today: TODAY });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.advice, 'Nothing new found.');
});

test('fact check: years, the current year and allow', () => {
  const cand = 'Data analyst since 2019, still in 2026. Grew sales 37% and saved $12k in 2017.';
  for (const today of [TODAY, new Date(2026, 10, 16)]) {
    const raws = F.factCheck(MASTER, cand, { today }).newNumbers.map((n) => n.raw);
    assert.ok(raws.includes('37%') && raws.includes('$12k') && raws.includes('2017'));
    assert.ok(!raws.includes('2019') && !raws.includes('2026'));
  }
  assert.ok(F.factCheck(MASTER, cand, { today: '2027-01-01' }).newNumbers.some((n) => n.raw === '2026'));
  const res = F.factCheck(MASTER, cand, { allow: ['37%', '2017'], today: TODAY });
  assert.deepEqual(res.newNumbers.map((n) => n.raw), ['$12k']);
});

test('fact check: money equivalents and known facts', () => {
  const res = F.factCheck('Managed a $1.2M budget and 120,000 rows.', 'Managed a 1,200,000 budget; 120k rows; 14 projects.',
    { known: ['{"yearsExperience": "14"}'], today: TODAY });
  assert.deepEqual(res.newNumbers, []);
  const without = F.factCheck('Managed a $1.2M budget and 120,000 rows.', 'Managed a 1,200,000 budget; 120k rows; 14 projects.', { today: TODAY });
  assert.deepEqual(without.newNumbers.map((n) => n.raw), ['14']);
});

test('fact check: placeholders and missing contact details', () => {
  const cand = 'Dear [Company] team, TODO: add <one thing you discussed>. XXX\nContact: alex.tremblay@example.com';
  const res = F.factCheck(MASTER, cand, { resume: true, today: TODAY });
  assert.equal(res.ok, false);
  for (const p of ['[Company]', 'TODO', '<one thing you discussed>', 'XXX']) assert.ok(res.placeholders.includes(p), p);
  assert.ok(res.missingContact.includes('9025550142'));
  assert.ok(res.missingContact.includes('linkedin.com/in/alex-tremblay-example'));
  assert.ok(!res.missingContact.includes('alex.tremblay@example.com'));
});

test('fact check: an unchanged copy passes; empty text is an error', () => {
  assert.equal(F.factCheck(MASTER, MASTER, { resume: true, today: TODAY }).ok, true);
  const empty = F.factCheck(MASTER, '  \n ', { today: TODAY });
  assert.equal(empty.ok, false);
  assert.ok(empty.error);
});

test('helpers: numbers, terms, contacts, placeholders', () => {
  assert.deepEqual(F.numbersIn('Saved $1.5M and 20% across 1,200 stores; call +1 (902) 555-0142').map((n) => [n.raw, n.value]),
    [['$1.5M', '1500000'], ['20%', '20'], ['1,200', '1200']]);
  // Terms are ASCII runs, as in the Python: "Zoë" is read as "Zo" (still found in a reference that says "Zoë").
  assert.deepEqual(F.termsInText('We moved to AWS. Then I wrote GraphQL APIs in Node.js with Zoë at Contoso.').map((t) => t.term),
    ['AWS', 'GraphQL', 'APIs', 'Node.js', 'Zo', 'Contoso']);
  assert.equal(F.factCheck('Worked with Zoë.', 'Paired with Zoë daily.', { today: TODAY }).ok, true);
  assert.deepEqual(F.contactsIn('a.b@x.com, github.com/abc, +1 902 555 0142'), { emails: ['a.b@x.com'], phones: ['9025550142'], links: ['github.com/abc'] });
  assert.deepEqual(F.placeholdersIn('Hi [Hiring Manager], lorem ipsum FIXME'), ['[Hiring Manager]', 'FIXME', 'lorem ipsum']);
});

// ---------- live answers (Markdown bullets + "Spoken answer") ----------

const BRAIN_MASTER = `Alex Morgan Tremblay
Data Engineer, Harbourline Logistics, Halifax (2023 - Present)
• Built Python and SQL pipelines feeding Power BI dashboards for 4 regional managers.
• Moved nightly batch jobs to streaming.`;
const BRAIN_FACTS = [
  'Led the Kafka migration at Harbourline that cut nightly batch time from 5 hours to 50 minutes.',
  'Wrote the Python consumers and the data quality checks for the migration.',
];
const answer = (result, spoken) => `- **Situation:** Nightly batch jobs at Harbourline took 5 hours.
- **Action:** I led the Kafka migration and wrote the Python consumers.
- **Result:** ${result}

**Spoken answer:** ${spoken}`;

test('answer: fully grounded, Markdown and "Spoken answer" raise no flags', () => {
  const text = answer('Batch time fell to 50 minutes.',
    'At Harbourline our nightly batch took 5 hours, so I led the Kafka migration and wrote the Python consumers. Batch time fell to 50 minutes.');
  const res = F.factCheck(BRAIN_MASTER, text, { known: BRAIN_FACTS, allow: ['Northwind Freight'], today: TODAY });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(F.summarize(res), { ok: true, unsupported: [], placeholders: [] });
  // Read as plain text (the Python's view), the Markdown labels would be flagged ("action" is a common word).
  const raw = F.factCheck(BRAIN_MASTER, text, { known: BRAIN_FACTS, today: TODAY, markdown: false });
  assert.deepEqual(raw.newTerms.map((t) => t.term), ['Situation', 'Result', 'Spoken']);
});

test('answer: an invented percentage is flagged', () => {
  const text = answer('Batch time fell by 35%.', 'I led the Kafka migration at Harbourline and batch time fell by 35%.');
  const res = F.factCheck(BRAIN_MASTER, text, { known: BRAIN_FACTS, today: TODAY });
  assert.deepEqual(res.newNumbers.map((n) => n.raw), ['35%']);
  assert.deepEqual(res.newTerms, []);
  const s = F.summarize(res);
  assert.equal(s.ok, false);
  assert.deepEqual(s.unsupported.map((u) => [u.kind, u.text]), [['number', '35%']]);
  assert.match(s.unsupported[0].context, /fell by 35%/);
});

test('answer: an invented tool is flagged', () => {
  const text = answer('Batch time fell to 50 minutes.',
    'I led the Kafka migration and deployed the Python consumers on Kubernetes, so batch time fell to 50 minutes.');
  const res = F.factCheck(BRAIN_MASTER, text, { known: BRAIN_FACTS, today: TODAY });
  assert.deepEqual(res.newNumbers, []);
  assert.deepEqual(res.newTerms.map((t) => t.term), ['Kubernetes']);
  assert.deepEqual(F.summarize(res).unsupported.map((u) => [u.kind, u.text]), [['term', 'Kubernetes']]);
});

test('summarize flattens numbers, terms and missing contacts', () => {
  const res = F.factCheck(MASTER, 'Dear [Company], I used Tableau to cut costs 25%.', { resume: true, today: TODAY });
  const s = F.summarize(res);
  assert.equal(s.ok, false);
  assert.deepEqual(s.unsupported.map((u) => u.kind), ['number', 'term', 'contact', 'contact', 'contact']);
  assert.deepEqual(s.placeholders, ['[Company]']);
  assert.deepEqual(F.summarize(null), { ok: false, unsupported: [], placeholders: [] });
  // TODO and XXX are terms to the Python too; summarize lists them once, as placeholders.
  const todo = F.summarize(F.factCheck('Built reports.', 'Built reports. TODO add XXX here.', { today: TODAY }));
  assert.deepEqual([todo.unsupported, todo.placeholders], [[], ['TODO', 'XXX']]);
});

test('Markdown stripping keeps the words and drops the markup', () => {
  assert.equal(F.stripMarkdown('## Title\n1. **Bold** and *em* with `code` and [a link](https://x.io)\n> quote\n---\n- [ ] task'),
    'Title\nBold and em with code and a link\nquote\n\ntask');
  assert.equal(F.stripMarkdown('snake_case_name and 2*3*4'), 'snake_case_name and 2*3*4');
});

// ---------- parity with the Python ----------

const PAIRS = {
  'invented number': ['Cut report time from 6 hours to 40 minutes for 4 managers.', 'Cut report time from 6 hours to 25 minutes for 4 managers and saved $30k.'],
  'invented tool': ['Built dashboards in Power BI and Excel for the sales team.', 'Built dashboards in Power BI and Looker for the sales team, modelled in dbt with PySpark.'],
  'changed title': ['Data Analyst, Harbourline Logistics, Halifax\nBuilt weekly reports for the operations team.', 'Senior Data Scientist, Harbourline Logistics, Halifax\nBuilt weekly reports for the operations team.'],
  'invented employer': ['Data Analyst at Harbourline Logistics in Halifax since 2024.', 'Data Analyst at Harbourline Logistics in Halifax since 2024, and before that an analyst at Contoso Pharmaceuticals.'],
  'fine reword': ['Answered 30-40 customer emails a day in English and French.', 'Handled 30 to 40 customer emails daily, in both English and French.'],
  placeholders: ['Built reports.', 'Dear [Hiring Manager], I am excited to join [Company] as a TODO. Lorem ipsum XXX <your strongest project>, see https://example.com/x.'],
  'unicode and tools': ['Worked with Zoë at Müller GmbH on Kafka 3.5.', 'Worked with Zoë and Jürgen at Müller GmbH on Kafka 3.6 and C++ / C# / Node.js, plus .NET and iOS.'],
  'sentence starts and acronyms': ['Used Python daily.', 'We used AWS. Then GraphQL helped; iOS apps too. Monday standups at Microsoft (with SQL) | Excel: Tableau.\n\nKafka streams.'],
  'markdown read raw': ['Led the Kafka migration and cut batch time to 50 minutes.', '- **Action:** I led the Kafka migration.\n1. Batch time fell to 50 minutes.\n\n**Spoken answer:** I led it.'],
  contacts: ['Alex Tremblay | alex@example.com | 902-555-0142 | linkedin.com/in/alex-t | github.com/alext', 'Alex Tremblay | alex@example.com | github.com/alext/'],
};

function cases() {
  const out = [];
  const fact = (name, master, candidate, opts = {}) => out.push({ type: 'fact', name, master, candidate, known: [], allow: [], resume: false, today: TODAY, ...opts });
  fact('fixture tailored', MASTER, TAILORED, { resume: true });
  fact('fixture tailored allow', MASTER, TAILORED, { allow: ['Tableau', '25%', 'Northwind Freight'] });
  fact('fixture clean copy', MASTER, MASTER, { resume: true });
  fact('fixture long', MASTER, read('long.tex'), { resume: true });
  fact('fixture broken', MASTER, read('broken.tex'));
  fact('fixture posting vs master + profile', MASTER, read('posting.md'), { known: [read('profile.json')], allow: ['Northwind Freight', 'Junior Data Analyst'] });
  fact('years and allow', MASTER, 'Data analyst since 2019, still in 2026. Grew sales 37% and saved $12k in 2017.', { allow: ['37%'] });
  fact('money and known', 'Managed a $1.2M budget and 120,000 rows.', 'Managed a 1,200,000 budget; 120k rows; 14 projects.', { known: ['{"yearsExperience": "14"}'] });
  fact('placeholders and contacts', MASTER, 'Dear [Company] team, TODO: add <one thing you discussed>. XXX\nContact: alex.tremblay@example.com', { resume: true });
  for (const [name, [m, c]] of Object.entries(PAIRS)) fact(name, m, c, { resume: name === 'contacts' });
  out.push({ type: 'classify', name: 'classify fixture', master: F.texBullets(MASTER), tailored: F.texBullets(TAILORED) });
  out.push({ type: 'classify', name: 'classify long', master: F.texBullets(MASTER), tailored: F.texBullets(read('long.tex')) });
  out.push({ type: 'classify', name: 'classify pairs', master: Object.values(PAIRS).map((p) => p[0]), tailored: Object.values(PAIRS).map((p) => p[1]) });
  for (const f of ['master.tex', 'tailored.tex', 'long.tex', 'broken.tex']) out.push({ type: 'tex_bullets', name: 'tex bullets ' + f, text: read(f) });
  out.push({ type: 'plain_bullets', name: 'plain bullets posting', text: read('posting.md') });
  out.push({ type: 'plain_bullets', name: 'plain bullets visible master', text: F.visibleSourceText(MASTER) });
  out.push({ type: 'plain_bullets', name: 'plain bullets answer', text: PAIRS['markdown read raw'][1] + '\n• Second point\n  wraps here\nUPPER LINE' });
  return out;
}

function jsResult(c) {
  if (c.type === 'fact') {
    const r = F.factCheck(c.master, c.candidate, { known: c.known, allow: c.allow, resume: c.resume, today: c.today, markdown: false });
    return { ok: r.ok, newNumbers: r.newNumbers, newTerms: r.newTerms, missingContact: r.missingContact, placeholders: r.placeholders };
  }
  if (c.type === 'classify') return F.classify(c.master, c.tailored);
  if (c.type === 'tex_bullets') return F.texBullets(c.text);
  return F.plainBullets(c.text);
}

const PY_HARNESS = String.raw`
import datetime as dt, json, os, sys, tempfile
sys.path.insert(0, sys.argv[1])
from jobkit import bullets
cases = json.loads(sys.stdin.buffer.read().decode('utf-8'))
tmp = tempfile.mkdtemp()
def write(name, text):
    p = os.path.join(tmp, name)
    with open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(text)
    return p
def ext(text):
    return 'tex' if ('\\documentclass' in text or '\\begin{document}' in text) else 'txt'
out = []
for n, c in enumerate(cases):
    t = c['type']
    if t == 'fact':
        m = write('%dm.%s' % (n, ext(c['master'])), c['master'])
        cd = write('%dc.%s' % (n, ext(c['candidate'])), c['candidate'])
        known = [write('%dk%d.txt' % (n, i), k) for i, k in enumerate(c['known'])]
        r, _ = bullets.fact_check(m, cd, known, c['allow'], c['resume'], dt.date.fromisoformat(c['today']))
        out.append({'ok': r['ok'], 'newNumbers': r['new_numbers'], 'newTerms': r['new_terms'],
                    'missingContact': r['missing_contact'], 'placeholders': r['placeholders']})
    elif t == 'classify':
        out.append(bullets.classify(c['master'], c['tailored']))
    elif t == 'tex_bullets':
        out.append(bullets.tex_bullets(c['text']))
    else:
        out.append(bullets.plain_bullets(c['text']))
sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode('utf-8'))
`;

const GOLDEN = path.join(FIX, 'parity-golden.json');
const sameNumbers = (x) => JSON.parse(JSON.stringify(x));   // 1.0 (Python) and 1 (JS) compare equal after JSON

test('parity with the Python fact_check, classify and bullet extraction', () => {
  const list = cases();
  let golden = null;
  const py = process.env.JOBKIT_PYTHON;
  const lib = process.env.JOBKIT_LIB;
  if (py && lib && fs.existsSync(py)) {
    const r = spawnSync(py, ['-I', '-c', PY_HARNESS, lib], { input: Buffer.from(JSON.stringify(list), 'utf8'), maxBuffer: 1 << 26 });
    assert.equal(r.status, 0, String(r.stderr));
    const live = JSON.parse(r.stdout.toString('utf8'));
    const named = Object.fromEntries(list.map((c, i) => [c.name, live[i]]));
    if (process.env.FACTCHECK_WRITE_GOLDEN === '1') fs.writeFileSync(GOLDEN, JSON.stringify(named, null, 1) + '\n');
    golden = named;
  }
  if (!golden) golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  let flagged = 0;
  for (const c of list) {
    assert.ok(c.name in golden, 'no Python result for ' + c.name);
    assert.deepEqual(sameNumbers(jsResult(c)), sameNumbers(golden[c.name]), c.name);
    if (c.type === 'fact' && !golden[c.name].ok) flagged++;
  }
  assert.ok(flagged >= 10);   // the cases exercise real findings, not only clean passes
  // Default mode (Markdown stripping on) changes nothing for inputs without Markdown...
  const facts = list.filter((x) => x.type === 'fact');
  const plain = facts.filter((x) => F.looksLikeTex(x.candidate) || F.stripMarkdown(x.candidate) === x.candidate);
  assert.ok(plain.length >= facts.length - 2);
  for (const c of plain) {
    const r = F.factCheck(c.master, c.candidate, { known: c.known, allow: c.allow, resume: c.resume, today: c.today });
    assert.deepEqual(sameNumbers({ ok: r.ok, newNumbers: r.newNumbers, newTerms: r.newTerms, missingContact: r.missingContact, placeholders: r.placeholders }),
      sameNumbers(golden[c.name]), 'default mode: ' + c.name);
  }
  // ...and for Markdown it only removes flags the markup caused ("- Company:" lines in the posting).
  for (const c of facts.filter((x) => !plain.includes(x))) {
    const r = F.factCheck(c.master, c.candidate, { known: c.known, allow: c.allow, resume: c.resume, today: c.today });
    const pyTerms = golden[c.name].newTerms.map((t) => t.term);
    assert.ok(r.newTerms.length < pyTerms.length, c.name);
    assert.ok(r.newTerms.every((t) => pyTerms.includes(t.term)), c.name);
    const pyValues = golden[c.name].newNumbers.map((n) => n.value);
    assert.ok(r.newNumbers.every((n) => pyValues.includes(n.value)), c.name);
  }
});
