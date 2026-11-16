// Autonomous Job Kit bridge (packages/core/jobkit.js): the tracker.xlsx the
// kit's own tracker.py wrote, an Excel-saved variant, the job folder's
// Markdown files, profile facts, matching and merging, and the prompt block.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const K = require('../../packages/core/jobkit');
const P = require('../../packages/core/prompts');

const ROOT = path.join(__dirname, '..', 'fixtures', 'jobkit', 'job-search');
const NW = path.join(ROOT, 'Applications', '2026-11-02 Northwind Freight - Junior Data Analyst');
const BW = path.join(ROOT, 'Applications', '2026-11-05 Bluewater Bank - Reporting Analyst');
const read = (p) => fs.readFileSync(p, 'utf8');

async function xlsxFiles(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const files = {};
  for (const n of Object.keys(zip.files)) if (/\.(xml|rels)$/.test(n)) files[n] = await zip.file(n).async('string');
  return files;
}

test('reads the tracker.xlsx written by the kit (inline strings, absolute rel targets, link columns)', async () => {
  const rows = K.parseTracker(await xlsxFiles(path.join(ROOT, 'tracker.xlsx')));
  assert.equal(rows.length, 4);
  const [nw, bw, contoso, fab] = rows;
  assert.equal(nw.id, 'A0001');
  assert.equal(nw.company, 'Northwind Freight');
  assert.equal(nw.status, 'Interviewing');
  assert.equal(nw.interview_date, '2026-12-03 14:00');
  assert.equal(nw.posting_url, 'https://example.com/jobs/123');
  assert.equal(nw.folder, 'Applications/2026-11-02 Northwind Freight - Junior Data Analyst', 'folder link target is URL-decoded');
  assert.equal(typeof nw.deadline, 'number', 'date cells are Excel serial numbers');
  assert.equal(bw.folder, 'Applications/2026-11-05 Bluewater Bank - Reporting Analyst');
  assert.equal(contoso.folder, '', 'no link → empty, not the "Open folder" label');
  assert.equal(contoso.status, 'Skipped');
  assert.equal(fab.status, 'Rejected');
  assert.equal(fab.posting_url, 'https://jobs.lever.co/fabrikam/abc');
});

test('reads an Excel-saved tracker (shared strings, relative targets, reordered columns, entities)', () => {
  const files = {
    'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="Other" sheetId="2" r:id="rId9"/><sheet name="Applications" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId9" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>Company</t></si><si><t>Role</t></si><si><t>Status</t></si><si><t>Folder</t></si><si><r><t>Smith </t></r><r><t>&amp; Co</t></r></si><si><t>Analyst</t></si><si><t>oa</t></si><si><t>Open folder</t></si><si><t>Interview date</t></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet xmlns:r="r"><sheetData><row r="1"><c r="B1" t="s"><v>1</v></c><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>8</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" t="s"><v>5</v></c><c r="C2" t="s"><v>6</v></c><c r="D2" t="s"><v>7</v></c><c r="E2"><v>46359.5625</v></c></row><row r="3"/></sheetData>' +
      '<hyperlinks><hyperlink ref="D2" r:id="rId1"/></hyperlinks></worksheet>',
    'xl/worksheets/_rels/sheet1.xml.rels': '<Relationships><Relationship Id="rId1" Target="Applications/2026-11-20%20Smith%20%26%20Co%20-%20Analyst" TargetMode="External"/></Relationships>',
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData/></worksheet>',
  };
  const rows = K.parseTracker(files);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].company, 'Smith & Co');
  assert.equal(rows[0].role, 'Analyst');
  assert.equal(K.canonicalStatus(rows[0].status), 'Online assessment');
  assert.equal(rows[0].folder, 'Applications/2026-11-20 Smith & Co - Analyst');
  const w = K.parseWhen(rows[0].interview_date);
  assert.deepEqual([w.y, w.m, w.d, w.hh, w.mm, w.hasTime], [2026, 12, 3, 13, 30, true]);
  assert.throws(() => K.parseTracker({}), /not an Excel workbook/);
});

test('dates: serial days, text with and without a time, deadlines at end of day', () => {
  assert.deepEqual(K.parseWhen(46356), { y: 2026, m: 11, d: 30, hh: 0, mm: 0, hasTime: false });
  assert.equal(K.parseWhen('2026-12-03').hasTime, false);
  assert.equal(K.parseWhen('nope'), null);
  const d = K.rowDates({ interview_date: '2026-12-03 14:00', deadline: 46356, status_updated: 46342 });
  assert.equal(d.interviewAt, new Date(2026, 11, 3, 14, 0).getTime());
  assert.equal(d.applyBy, new Date(2026, 10, 30, 23, 59).getTime());
  assert.equal(d.statusUpdated, '2026-11-16');
  const dayOnly = K.rowDates({ interview_date: '2026-12-03' });
  assert.equal(dayOnly.interviewAt, null, 'a date without a time is not turned into a reminder');
  assert.equal(dayOnly.interviewDay, '2026-12-03');
});

test('statuses map to stages; forgiving words are understood', () => {
  assert.equal(K.canonicalStatus('applied'), 'Submitted');
  assert.equal(K.canonicalStatus('Needs you: login page'), 'Needs you');
  assert.equal(K.canonicalStatus('interv'), 'Interviewing');
  assert.equal(K.STAGE_OF.Submitted, 'applied');
  assert.equal(K.STAGE_OF['Online assessment'], 'screening');
  assert.equal(K.STAGE_OF.Withdrawn, 'closed');
});

test('job folder files: posting, record (fields, answers, edits), answers to paste, changes', () => {
  const posting = K.parsePosting(read(path.join(NW, 'job-posting.md')));
  assert.equal(posting.company, 'Northwind Freight');
  assert.equal(posting.deadline, '2026-11-30');
  assert.match(posting.description, /^We are looking for a junior data analyst/);
  assert.equal(K.parsePosting('- Pay: not stated\n').pay, '');
  const rec = K.parseRecord(read(path.join(NW, 'application-record.md')));
  assert.equal(rec.resumeFile, 'Alex_Tremblay_Resume_Northwind.pdf');
  assert.equal(rec.letterFile, 'Alex_Tremblay_Cover_Letter_Northwind.pdf');
  assert.equal(rec.fields.length, 5);
  assert.deepEqual(rec.fields[2], { label: 'Salary expectations', value: '$62,000' });
  assert.equal(rec.answers.length, 2);
  assert.equal(rec.answers[0].question, 'Why do you want to work at Northwind Freight?');
  assert.match(rec.answers[0].answer, /cut shipment reporting from 6 hours/, 'wrapped lines are joined');
  assert.deepEqual(rec.changesBeforeSubmitting, ['Changed the salary expectation from $60,000 to $62,000.']);
  const paste = K.parseAnswersToPaste(read(path.join(BW, 'answers-to-paste.md')));
  assert.equal(paste.link, 'https://boards.greenhouse.io/bluewater/jobs/4455');
  assert.deepEqual(paste.answers.map((a) => a.question), ['How did you hear about this job?', 'Notice period', 'What interests you about reporting at Bluewater Bank?'], '"yours" answers are left out');
  const changes = K.parseChanges(read(path.join(NW, 'changes.md')));
  assert.equal(changes.gaps.length, 2);
  assert.equal(changes.keywordGaps, 'Snowflake, dbt, Tableau');
  assert.deepEqual(K.folderGuess('2026-11-02 Northwind Freight - Junior Data Analyst'), { date: '2026-11-02', company: 'Northwind Freight', role: 'Junior Data Analyst' });
});

test('profile facts: interview answers suggested, self-identification never imported', () => {
  const profile = JSON.parse(read(path.join(ROOT, 'profile.json')));
  const facts = K.profileFacts(profile);
  const texts = facts.map((f) => f.text);
  assert.ok(texts.includes('Salary expectation: $60,000 to $65,000'));
  assert.ok(texts.includes('Notice period: Two weeks'));
  assert.ok(facts.find((f) => f.text === 'Notice period: Two weeks').suggested);
  assert.equal(facts.find((f) => f.text.startsWith('How did you hear')).suggested, false, 'form trivia is offered unticked');
  const all = texts.join(' | ');
  for (const bad of ['Woman', 'Test value', 'years of age', 'accommodations', 'alex.tremblay@example.com', 'Tremblay']) assert.ok(!all.includes(bad), `never imports: ${bad}`);
  assert.deepEqual(K.profileFacts(null), []);
  assert.deepEqual(K.profileFacts({ savedAnswers: [{ match: 'Gender', answer: 'x' }, { match: 'Visa', answer: 'I need a disability accommodation' }] }), []);
});

function northwindApp() {
  return K.buildApplication({
    folder: 'Applications/2026-11-02 Northwind Freight - Junior Data Analyst',
    record: K.parseRecord(read(path.join(NW, 'application-record.md'))),
    changes: K.parseChanges(read(path.join(NW, 'changes.md'))),
    resumeFile: 'Alex_Tremblay_Resume_Northwind.pdf',
    resumeText: 'Alex Morgan Tremblay\nCut weekly shipment reporting from 6 hours to 40 minutes',
    letterFile: 'Alex_Tremblay_Cover_Letter_Northwind.pdf',
    letterText: 'Dear Northwind Freight hiring team,',
    importedAt: 1,
  });
}

test('the application keeps what was sent but not contact details', () => {
  const app = northwindApp();
  assert.deepEqual(app.fields.map((f) => f.label), ['Salary expectations', 'Earliest start date', 'Are you legally entitled to work in Canada?']);
  assert.equal(app.answers.length, 2);
  assert.equal(app.gaps.length, 2);
  assert.equal(K.hasContent(app), true);
  assert.equal(K.hasContent(K.buildApplication({})), false);
  assert.deepEqual(K.cleanApplication(app), app);
  assert.equal(K.cleanApplication({ source: 'other', resumeText: 'x' }), null);
  assert.equal(K.cleanApplication({ ...app, resumeText: 'x'.repeat(50000) }).resumeText.length, 12000);
});

test('prompt block: consistency, edits, honest gaps; grounding names it', () => {
  const job = { company: 'Northwind Freight', role: 'Junior Data Analyst' };
  const block = K.applicationBlock(northwindApp(), job);
  assert.match(block, /^<application_sent>/);
  assert.match(block, /already sent this application to Northwind Freight, Junior Data Analyst/);
  assert.match(block, /Stay consistent with it/);
  assert.match(block, /<resume_sent file="Alex_Tremblay_Resume_Northwind.pdf">/);
  assert.match(block, /<cover_letter_sent>/);
  assert.match(block, /- Salary expectations: \$62,000/);
  assert.match(block, /Q: Why do you want to work at Northwind Freight\?/);
  assert.match(block, /<changed_before_submitting>[\s\S]*\$62,000/);
  assert.match(block, /<known_gaps>[\s\S]*never claim it[\s\S]*Snowflake and dbt/);
  assert.ok(!block.includes('alex.tremblay@example.com'));
  assert.equal(K.applicationBlock(null, job), '');
  assert.match(P.GROUNDING, /<verified_facts>, <candidate_resume> or <application_sent>/);
  const sys = P.profileSystem({ job, applicationBlock: block }, 'ROLE');
  assert.ok(sys.includes(P.GROUNDING), 'grounding applies when only the application is known');
  assert.ok(sys.indexOf('<target_job>') < sys.indexOf('<application_sent>\nThe candidate'));
  assert.ok(!P.profileSystem({ job }, 'ROLE').includes('<application_sent>'));
});

const kitApp = (over = {}) => ({ key: 'row:A0001', trackerId: 'A0001', folder: 'Applications/x', company: 'Northwind Freight', role: 'Junior Data Analyst', status: 'Interviewing', url: 'https://example.com/jobs/123', description: 'Build dashboards.', location: 'Halifax', pay: '$60k', interviewAt: 1000, applyBy: 2000, interviewStage: 'Technical round', nextStep: 'Prepare SQL', application: northwindApp(), ...over });

test('matching: job-kit link, then posting URL, then company and role; skipped rows', () => {
  const jobs = [
    { id: 'a', company: 'Northwind Freight Inc.', role: 'junior data analyst' },
    { id: 'b', company: 'Other', role: 'X', url: 'https://www.example.com/jobs/123/' },
    { id: 'c', company: 'Z', role: 'Z', jobKit: { id: 'A0001', folder: 'Applications/x' } },
  ];
  assert.equal(K.planImport([kitApp()], jobs)[0].jobId, 'c');
  assert.equal(K.planImport([kitApp({ trackerId: 'A9', folder: 'y' })], jobs)[0].jobId, 'b');
  const byName = K.planImport([kitApp({ trackerId: 'A9', folder: 'y', url: '' })], jobs)[0];
  assert.deepEqual([byName.action, byName.jobId], ['update', 'a']);
  const fresh = K.planImport([kitApp({ trackerId: 'A9', folder: 'y', url: '', company: 'New Co' })], jobs)[0];
  assert.deepEqual([fresh.action, fresh.jobId], ['new', null]);
  const skipped = K.planImport([kitApp({ status: 'Skipped' })], [])[0];
  assert.deepEqual([skipped.action, skipped.reason], ['skip', 'Skipped in the job kit']);
});

test('merging: a new job, then updates that keep what the user typed', () => {
  const created = K.mergeJob(null, kitApp(), 5);
  assert.equal(created.stage, 'interviewing');
  assert.equal(created.jobDescription, 'Location: Halifax\nPay: $60k\n\nBuild dashboards.');
  assert.match(created.notes, /^Job kit: Interviewing, stage: Technical round, next step: Prepare SQL\./);
  assert.deepEqual(created.jobKit, { id: 'A0001', folder: 'Applications/x', status: 'Interviewing', interviewAt: 1000, importedAt: 5 });
  assert.ok(created.application.resumeText);

  // First link to a job the user made: their text stays, the kit's further-along stage wins.
  const mine = { id: 'j1', company: 'Northwind', role: 'Analyst', stage: 'applied', notes: 'Referred by Kim.', jobDescription: 'Pasted by me', url: '', interviewAt: null };
  const linked = K.mergeJob(mine, kitApp());
  assert.deepEqual([linked.company, linked.role, linked.jobDescription], ['Northwind', 'Analyst', 'Pasted by me']);
  assert.equal(linked.stage, 'interviewing');
  assert.equal(linked.url, 'https://example.com/jobs/123');
  assert.equal(linked.interviewAt, 1000);
  assert.match(linked.notes, /^Referred by Kim\.\nJob kit: Interviewing/);
  // A behind-the-job kit stage doesn't move a job back.
  assert.equal(K.mergeJob({ ...mine, stage: 'offer' }, kitApp({ status: 'Submitted' })).stage, 'offer');
  // Final statuses always apply the first time.
  assert.equal(K.mergeJob(mine, kitApp({ status: 'Rejected' })).stage, 'rejected');

  // Later imports: the user's own stage stays unless the kit's status changed.
  const userMoved = { ...linked, stage: 'offer' };
  const again = K.mergeJob(userMoved, kitApp());
  assert.equal(again.stage, 'offer');
  assert.equal(again.notes, linked.notes, 'notes are not repeated');
  assert.equal(K.mergeJob(userMoved, kitApp({ status: 'Rejected' })).stage, 'rejected');
  // A changed interview time in the kit updates the job; an unchanged one keeps the user's edit.
  assert.equal(K.mergeJob({ ...linked, interviewAt: 777 }, kitApp()).interviewAt, 777);
  assert.equal(K.mergeJob({ ...linked, interviewAt: 777 }, kitApp({ interviewAt: 3000 })).interviewAt, 3000);
  // A folder that now has nothing keeps the application already attached.
  assert.ok(K.mergeJob(linked, kitApp({ application: K.buildApplication({}) })).application.resumeText);
});

test('search settings keep what fit and discovery read, including meaningful spaces', () => {
  const s = K.cleanSearch(JSON.parse(read(path.join(ROOT, 'search.json'))));
  assert.ok(s.exclude_titles.includes('staff ') && s.exclude_titles.includes('lead '), 'trailing spaces kept');
  assert.deepEqual(Object.keys(s.tracks), ['data', 'operations', 'support']);
  assert.equal(s.tracks.operations.priority, 0.7);
  assert.deepEqual(s.jobbank_queries, ['data analyst', 'business analyst', 'operations coordinator']);
  assert.deepEqual(s.remotive_categories, ['data']);
  assert.equal(s.min_score_to_queue, 55);
  assert.equal(s.employers, undefined, 'empty employer lists are dropped');
  const withBoards = K.cleanSearch({ employers: { greenhouse: ['stripe'], workday: [{ host: 'acme.wd5.myworkdayjobs.com', tenant: 'acme', site: 'External', bad: 3 }] } });
  assert.deepEqual(withBoards.employers, { greenhouse: ['stripe'], workday: [{ host: 'acme.wd5.myworkdayjobs.com', tenant: 'acme', site: 'External' }] });
  assert.equal(K.cleanSearch(null), null);
});

test('profile facts: form fragments, stems and repeated answers are not offered as facts', () => {
  const facts = K.profileFacts({
    yearsExperience: '3',
    savedAnswers: [
      { match: 'currently employed', answer: 'Yes' },
      { match: 'currently employed by', answer: 'No' },
      { match: 'currently employed at', answer: 'No' },
      { match: 'willing to relocate', answer: 'Yes, anywhere in Canada' },
      { match: 'relocat', answer: 'Yes, anywhere in Canada' },
      { match: 'permit expiry', answer: 'December 31, 2029' },
      { match: 'work permit', answer: 'Expiry date: December 31, 2029' },
      { match: 'earliest start date', answer: 'Two weeks after an offer' },
      { match: 'available to start', answer: 'Two weeks after an offer' },
      { match: 'overtime', answer: 'Yes' },
      { match: 'shift', answer: 'Yes' },
      { match: 'relatives employed', answer: 'No' },
      { match: 'years of experience in related field', answer: 'About 2 years mechanical; 5+ years part-time data analysis' },
    ],
  });
  const texts = facts.map((f) => f.text);
  const ticked = facts.filter((f) => f.suggested).map((f) => f.text);
  assert.ok(texts.includes('Currently employed: Yes'));
  assert.ok(!texts.some((t) => /Currently employed (by|at)/.test(t)), 'fragments ending in a preposition are dropped');
  assert.ok(!texts.some((t) => t.startsWith('Relocat:')), 'a stem covered by a fuller phrase is dropped');
  assert.equal(texts.filter((t) => /December 31, 2029/.test(t)).length, 1, 'the same date is kept once');
  assert.equal(texts.filter((t) => /Two weeks after an offer/.test(t)).length, 1, 'the same long answer is kept once');
  assert.ok(texts.includes('Overtime: Yes') && texts.includes('Shift: Yes'), 'short answers are never merged');
  assert.ok(!texts.some((t) => t.startsWith('Years of experience: 3')), 'the careful saved answer replaces the single number');
  assert.ok(ticked.some((t) => t.startsWith('Years of experience in related field:')));
  assert.ok(!ticked.includes('Relatives employed: No'), 'form trivia is not ticked');
});
