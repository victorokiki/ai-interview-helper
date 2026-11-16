// Autonomous Job Kit import (main process): reads the user's job-search
// folder (tracker.xlsx, Applications/, profile.json), builds the review list
// with packages/core/jobkit.js, and applies only what the user confirmed.
// Everything is read from this PC; resume and letter text is extracted
// locally (no AI call). Nothing in the job-search folder is ever changed.
const fs = require('fs');
const path = require('path');
const Kit = require('../packages/core/jobkit');
const jobs = require('./jobs');
const brain = require('./brain');

const MAX_TEXT_FILE = 1024 * 1024; // .md and .json files
const MAX_DOC_FILE = 15 * 1024 * 1024; // resume and letter PDF/DOCX
const MAX_XLSX = 20 * 1024 * 1024;
const MAX_APPS = 300;

let lastPlan = null; // the plan the user is reviewing; apply() only uses items from it

// A path inside root, or null (tracker links and file names must not lead
// outside the job-search folder).
function inside(root, rel) {
  if (!rel) return null;
  const full = path.resolve(root, String(rel));
  const r = path.resolve(root);
  return full === r || full.startsWith(r + path.sep) ? full : null;
}

function isFile(p, max) {
  try {
    const st = fs.lstatSync(p);
    return st.isFile() && st.size <= max;
  } catch {
    return false;
  }
}

function readText(p) {
  return p && isFile(p, MAX_TEXT_FILE) ? fs.readFileSync(p, 'utf8') : '';
}

async function trackerFiles(file) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const files = {};
  for (const name of Object.keys(zip.files)) {
    if (/\.(xml|rels)$/i.test(name) && !zip.files[name].dir) files[name] = await zip.file(name).async('string');
  }
  return files;
}

async function documentText(file) {
  if (!isFile(file, MAX_DOC_FILE)) return '';
  const lower = file.toLowerCase();
  if (lower.endsWith('.docx')) {
    const { value } = await require('mammoth').extractRawText({ path: file });
    return value.replace(/\n{3,}/g, '\n\n').trim();
  }
  if (lower.endsWith('.pdf')) {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(file)));
    const { text } = await extractText(pdf, { mergePages: true });
    return text.replace(/[ \t]+\n/g, '\n').trim();
  }
  if (/\.(md|txt)$/.test(lower)) return readText(file);
  return '';
}

// The resume (or letter) file in a job folder: the name the tracker or the
// record gives, else the likeliest PDF/DOCX by its name.
function pickFile(dir, names, test) {
  for (const n of names) {
    if (!n) continue;
    const p = inside(dir, path.basename(String(n)));
    if (p && isFile(p, MAX_DOC_FILE)) return p;
  }
  let list = [];
  try {
    list = fs.readdirSync(dir).filter((f) => /\.(pdf|docx)$/i.test(f) && test(f));
  } catch {
    return null;
  }
  list.sort((a, b) => Number(/\.docx$/i.test(a)) - Number(/\.docx$/i.test(b)) || a.localeCompare(b));
  return list.length ? path.join(dir, list[0]) : null;
}

const isLetter = (f) => /cover[\s_-]*letter|(^|[\s_-])letter([\s_.-]|$)/i.test(f);
const isResume = (f) => /resume|résumé|\bcv\b|_cv[._]/i.test(f) && !isLetter(f);

async function readApplication(root, dir, row, errors) {
  const name = path.basename(dir);
  const posting = Kit.parsePosting(readText(path.join(dir, 'job-posting.md')));
  const recordMd = readText(path.join(dir, 'application-record.md'));
  const pasteMd = readText(path.join(dir, 'answers-to-paste.md'));
  const record = recordMd ? Kit.parseRecord(recordMd) : null;
  const paste = pasteMd ? Kit.parseAnswersToPaste(pasteMd) : null;
  const changesMd = readText(path.join(dir, 'changes.md'));
  const changes = changesMd ? Kit.parseChanges(changesMd) : null;
  const resumePath = pickFile(dir, [row?.resume, record?.resumeFile], isResume);
  const letterPath = pickFile(dir, [record?.letterFile], isLetter);
  let resumeText = '';
  let letterText = '';
  try {
    resumeText = resumePath ? await documentText(resumePath) : '';
  } catch (err) {
    errors.push(`${name}: couldn't read ${path.basename(resumePath)} (${err.message})`);
  }
  try {
    letterText = letterPath && letterPath !== resumePath ? await documentText(letterPath) : '';
  } catch (err) {
    errors.push(`${name}: couldn't read ${path.basename(letterPath)} (${err.message})`);
  }
  if (resumePath && !resumeText) errors.push(`${name}: ${path.basename(resumePath)} has no readable text (scanned PDF?)`);
  const application = Kit.buildApplication({
    folder: path.relative(root, dir).split(path.sep).join('/'),
    record,
    paste,
    changes,
    resumeFile: resumePath ? path.basename(resumePath) : '',
    resumeText,
    letterFile: letterPath && letterText ? path.basename(letterPath) : '',
    letterText,
  });
  return { posting, record, application };
}

function toApp(root, row, folderRel, read) {
  const guess = Kit.folderGuess(folderRel ? path.basename(folderRel) : '');
  const p = read?.posting || {};
  const status = row ? Kit.canonicalStatus(row.status) || String(row.status || '') : '';
  const dates = row ? Kit.rowDates(row) : { interviewAt: null, interviewDay: '', applyBy: null, statusUpdated: '' };
  const deadline = !dates.applyBy && p.deadline ? Kit.parseWhen(p.deadline) : null;
  return {
    key: row?.id ? `row:${row.id}` : `folder:${folderRel}`,
    trackerId: row?.id ? String(row.id) : '',
    folder: folderRel || '',
    company: String(row?.company || p.company || guess.company || '').trim(),
    role: String(row?.role || p.role || guess.role || '').trim(),
    status,
    submitted: /submitted|sent/i.test(read?.record?.status || ''),
    statusUpdated: dates.statusUpdated,
    url: String(row?.posting_url || p.url || read?.application?.formLink || '').trim(),
    location: String(row?.location || p.location || '').trim(),
    pay: p.pay || '',
    description: p.description || '',
    interviewAt: dates.interviewAt,
    interviewDay: dates.interviewDay,
    applyBy: dates.applyBy || (deadline ? new Date(deadline.y, deadline.m - 1, deadline.d, 23, 59).getTime() : null),
    interviewStage: String(row?.interview_stage || '').trim(),
    nextStep: String(row?.next_step || '').trim(),
    gapsCell: String(row?.gaps || '').trim(),
    notesCell: String(row?.notes || '').trim(),
    application: read?.application || null,
  };
}

// Reads the folder and returns the review plan. Nothing is changed.
async function plan(folder) {
  const root = path.resolve(String(folder || ''));
  const errors = [];
  if (!folder || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { folder: root, items: [], facts: [], errors: ['That folder was not found.'], total: 0 };
  }
  // Rows from tracker.xlsx.
  let rows = [];
  const trackerPath = path.join(root, 'tracker.xlsx');
  const hasTracker = isFile(trackerPath, MAX_XLSX);
  if (hasTracker) {
    try {
      rows = Kit.parseTracker(await trackerFiles(trackerPath));
    } catch (err) {
      errors.push(`tracker.xlsx: ${err.message}${/locked|EBUSY/i.test(err.message) ? ' (close it in Excel and try again)' : ''}`);
    }
  }
  // Job folders under Applications/.
  const appsDir = path.join(root, 'Applications');
  let dirs = [];
  try {
    dirs = fs
      .readdirSync(appsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
      .map((d) => path.join(appsDir, d.name));
  } catch {
    dirs = [];
  }
  if (!hasTracker && !dirs.length) {
    return { folder: root, items: [], facts: [], errors: ['No tracker.xlsx or Applications folder here. Choose the job-search folder you opened Claude in for the job kit.'], total: 0 };
  }
  const apps = [];
  const used = new Set();
  for (const row of rows.slice(0, MAX_APPS)) {
    const dir = row.folder ? inside(root, row.folder) : null;
    if (row.folder && !dir) errors.push(`${row.company || row.id}: its folder link points outside the job-search folder, so it was not read.`);
    const read = dir && fs.existsSync(dir) ? await readApplication(root, dir, row, errors) : null;
    if (dir) used.add(path.resolve(dir));
    apps.push(toApp(root, row, dir ? path.relative(root, dir).split(path.sep).join('/') : '', read));
  }
  for (const dir of dirs) {
    if (used.has(path.resolve(dir)) || apps.length >= MAX_APPS) continue;
    const read = await readApplication(root, dir, null, errors);
    apps.push(toApp(root, null, path.relative(root, dir).split(path.sep).join('/'), read));
  }
  // Suggested facts from profile.json.
  let facts = [];
  let situation = null;
  const profileMd = readText(path.join(root, 'profile.json'));
  if (profileMd) {
    try {
      situation = Kit.cleanSituation(JSON.parse(profileMd));
      const known = new Set(brain.listFacts().map((f) => f.text.toLowerCase().replace(/\s+/g, ' ').trim()));
      facts = Kit.profileFacts(JSON.parse(profileMd)).filter((f) => !known.has(f.text.toLowerCase()));
    } catch (err) {
      errors.push(`profile.json: ${err.message}`);
    }
  }
  // Search settings (tracks, places, pathway) for the fit score.
  let search = null;
  const searchMd = readText(path.join(root, 'search.json'));
  if (searchMd) {
    try {
      search = Kit.cleanSearch(JSON.parse(searchMd));
    } catch (err) {
      errors.push(`search.json: ${err.message}`);
    }
  }
  const settings = search || situation ? { search, situation } : null;
  const items = Kit.planImport(apps, jobs.listJobs());
  lastPlan = { folder: root, items, facts, settings };
  return { folder: root, items, facts, settings, errors, total: apps.length, hasTracker };
}

// choices: [{ key, action: 'new'|'update'|'skip', jobId }]; factIndexes: the
// suggested facts the user ticked.
// useSettings: also take search.json and the work-authorization answers
// (returned as result.settings for the caller to save in the config).
function apply(choices, factIndexes = [], useSettings = false) {
  const result = { created: 0, updated: 0, facts: 0, jobIds: [], settings: null };
  if (!lastPlan) return result;
  for (const c of Array.isArray(choices) ? choices : []) {
    const item = lastPlan.items.find((i) => i.app.key === c?.key);
    if (!item || !['new', 'update'].includes(c.action)) continue;
    if (c.action === 'update') {
      const job = jobs.getJob(c.jobId);
      if (!job) continue;
      const saved = jobs.saveJob(Kit.mergeJob(job, item.app));
      result.updated++;
      result.jobIds.push(saved.id);
    } else {
      const saved = jobs.saveJob(Kit.mergeJob(null, item.app));
      result.created++;
      result.jobIds.push(saved.id);
    }
  }
  const picked = (Array.isArray(factIndexes) ? factIndexes : []).map((i) => lastPlan.facts[Number(i)]).filter(Boolean);
  if (picked.length) result.facts = brain.mergeFacts(picked.map(({ text, category, source }) => ({ text, category, source })));
  if (useSettings && lastPlan.settings) result.settings = lastPlan.settings;
  lastPlan = null;
  return result;
}

module.exports = { plan, apply, inside };
