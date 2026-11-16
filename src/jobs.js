// Job workspaces: one per company/role, each with its own job description,
// notes, stage and interview date. Stored in userData/jobs.json.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const JobKit = require('../packages/core/jobkit');

const STAGES = ['saved', 'applied', 'screening', 'interviewing', 'offer', 'rejected', 'closed'];

function file() {
  return path.join(app.getPath('userData'), 'jobs.json');
}

function listJobs() {
  try {
    const jobs = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return Array.isArray(jobs) ? jobs : [];
  } catch {
    return [];
  }
}

function write(jobs) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(jobs, null, 2));
}

function text(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

// The posting's address, kept only if it is a web page.
function webUrl(value) {
  const s = text(value, 2000);
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch {
    return '';
  }
}

function cleanKitLink(k) {
  if (!k || typeof k !== 'object') return null;
  return {
    id: text(k.id, 40),
    folder: text(k.folder, 500),
    status: text(k.status, 60),
    interviewAt: Number(k.interviewAt) || null,
    importedAt: Number(k.importedAt) || Date.now(),
  };
}

function getJob(id) {
  return id ? listJobs().find((j) => j.id === id) || null : null;
}

// Creates or updates a job and returns the saved record.
function saveJob(input) {
  const jobs = listJobs();
  const existing = jobs.find((j) => j.id === input.id);
  const job = {
    id: existing?.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    company: text(input.company, 200),
    role: text(input.role, 200),
    stage: STAGES.includes(input.stage) ? input.stage : 'saved',
    interviewAt: Number(input.interviewAt) || null,
    jobDescription: text(input.jobDescription, 60000),
    notes: text(input.notes, 20000),
    contacts: text(input.contacts, 4000),
    url: webUrl(input.url),
    interviewLink: webUrl(input.interviewLink),
    applyBy: Number(input.applyBy) || null,
    followUpAt: Number(input.followUpAt) || null,
    followUpNote: text(input.followUpNote, 300),
    // A reminder fires once; changing its date re-arms it.
    followUpNotifiedAt: existing && existing.followUpAt === (Number(input.followUpAt) || null) ? existing.followUpNotifiedAt || null : null,
    deadlineNotifiedAt: existing && existing.applyBy === (Number(input.applyBy) || null) ? existing.deadlineNotifiedAt || null : null,
    interviewNotifiedAt: existing && existing.interviewAt === (Number(input.interviewAt) || null) ? existing.interviewNotifiedAt || null : null,
    interviewSoonNotifiedAt: existing && existing.interviewAt === (Number(input.interviewAt) || null) ? existing.interviewSoonNotifiedAt || null : null,
    // What was sent to the employer and the link to the Autonomous Job Kit
    // row/folder. The job form doesn't send these, so they are kept unless
    // the caller passes them (null removes them).
    application: input.application !== undefined ? JobKit.cleanApplication(input.application) : existing?.application || null,
    jobKit: input.jobKit !== undefined ? cleanKitLink(input.jobKit) : existing?.jobKit || null,
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  write(existing ? jobs.map((j) => (j.id === job.id ? job : j)) : [...jobs, job]);
  return job;
}

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function dayWord(ms, now) {
  const days = Math.round((new Date(ms).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86400000);
  return days === 0 ? 'today' : days === 1 ? 'tomorrow' : new Date(ms).toLocaleDateString([], { weekday: 'long' });
}

// Reminders that are due now: follow-ups whose time has come, application
// deadlines within the next 24 hours, and interviews (the day before and 30
// minutes before). Each fires once.
function dueReminders(now = Date.now()) {
  const due = [];
  for (const j of listJobs()) {
    const name = [j.company, j.role].filter(Boolean).join(' — ') || 'a job';
    if (j.interviewAt && j.interviewAt > now) {
      const left = j.interviewAt - now;
      if (left <= 30 * 60 * 1000 && !j.interviewSoonNotifiedAt) {
        due.push({ jobId: j.id, kind: 'interviewSoon', text: `Your ${name} interview starts at ${clock(j.interviewAt)}.`, link: j.interviewLink || '' });
      } else if (left <= 24 * 3600 * 1000 && left > 30 * 60 * 1000 && !j.interviewNotifiedAt) {
        due.push({ jobId: j.id, kind: 'interview', text: `Interview with ${name} ${dayWord(j.interviewAt, now)} at ${clock(j.interviewAt)}. A quick practice round now helps.` });
      }
    }
    if (j.followUpAt && j.followUpAt <= now && !j.followUpNotifiedAt) {
      due.push({ jobId: j.id, kind: 'followUp', text: `Follow up on ${name}${j.followUpNote ? `: ${j.followUpNote}` : ''}` });
    }
    if (j.applyBy && j.applyBy - now <= 24 * 3600 * 1000 && j.applyBy > now - 24 * 3600 * 1000 && !j.deadlineNotifiedAt) {
      due.push({ jobId: j.id, kind: 'deadline', text: `Application for ${name} is due ${new Date(j.applyBy).toLocaleDateString()}` });
    }
  }
  return due;
}

const NOTIFIED = { deadline: ['deadlineNotifiedAt'], followUp: ['followUpNotifiedAt'], interview: ['interviewNotifiedAt'], interviewSoon: ['interviewSoonNotifiedAt', 'interviewNotifiedAt'] };
function markNotified(id, kind, at = Date.now()) {
  const fields = NOTIFIED[kind] || NOTIFIED.followUp;
  write(listJobs().map((j) => (j.id === id ? { ...j, ...Object.fromEntries(fields.map((f) => [f, at])) } : j)));
}

function deleteJob(id) {
  write(listJobs().filter((j) => j.id !== id));
}

// Before workspaces, the job description lived in the profile. Move it into
// a first job once, leaving the old value on disk untouched.
function migrate(store) {
  const config = store.loadConfig();
  if (config.jobsMigrated) return;
  if (config.jobDescription && !listJobs().length) {
    const job = saveJob({ role: 'My target role', stage: 'interviewing', jobDescription: config.jobDescription });
    store.saveConfig({ activeJobId: job.id });
  }
  store.saveConfig({ jobsMigrated: true });
}

module.exports = { STAGES, listJobs, getJob, saveJob, deleteJob, migrate, dueReminders, markNotified };
