// Calendar invite import (main process): reads .ics files the user picks or
// drops, builds the review list (packages/core/ics.js), and applies the
// choices the user confirmed to their jobs. Nothing is changed before that.
const fs = require('fs');
const ics = require('../packages/core/ics');
const jobs = require('./jobs');

const MAX_BYTES = 5 * 1024 * 1024;

function readFiles(paths) {
  const events = [];
  const errors = [];
  for (const p of paths) {
    try {
      if (fs.statSync(p).size > MAX_BYTES) throw new Error('larger than 5 MB');
      events.push(...ics.parseIcs(fs.readFileSync(p, 'utf8')).events);
    } catch (err) {
      errors.push(`${require('path').basename(p)}: ${err.message}`);
    }
  }
  return { events, errors };
}

function plan(events, errors = []) {
  const items = ics.planImport(events, jobs.listJobs());
  return { items, errors, total: events.length };
}

function planFromText(text) {
  if (typeof text !== 'string' || text.length > MAX_BYTES) return { items: [], errors: ['The file is empty or larger than 5 MB.'], total: 0 };
  const { events } = ics.parseIcs(text);
  return plan(events, events.length ? [] : ['No events found in that file.']);
}

function planFromFiles(paths) {
  const { events, errors } = readFiles(paths);
  if (!events.length && !errors.length) errors.push('No events found in that file.');
  return plan(events, errors);
}

const when = (e) => new Date(e.start).toLocaleString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function noteLine(e, prefix = 'Calendar') {
  return `${prefix}: ${e.title} (${when(e)}${e.location && !/^https?:/.test(e.location) ? `, ${e.location}` : ''})`;
}

function appendLines(existing, lines) {
  const have = String(existing || '');
  const lower = have.toLowerCase();
  const fresh = lines.filter((l) => l && !lower.includes(l.toLowerCase()) && !lower.includes((l.split(', ').pop() || '').toLowerCase()));
  return fresh.length ? [have.trim(), ...fresh].filter(Boolean).join('\n') : have;
}

// choices: [{ event, action: 'update'|'new'|'clear'|'skip', jobId, company, role }]
function apply(choices) {
  const result = { updated: 0, created: 0, cleared: 0, jobIds: [] };
  for (const c of Array.isArray(choices) ? choices : []) {
    const e = c?.event;
    if (!e || typeof e.start !== 'number' || !Number.isFinite(e.start)) continue;
    const link = typeof e.link === 'string' ? e.link : '';
    const contacts = ics.contactLines(e);
    if (c.action === 'update') {
      const job = jobs.getJob(c.jobId);
      if (!job) continue;
      const saved = jobs.saveJob({
        ...job,
        interviewAt: e.start,
        interviewLink: link || job.interviewLink,
        stage: ['saved', 'applied'].includes(job.stage) ? 'interviewing' : job.stage,
        contacts: appendLines(job.contacts, contacts),
        notes: appendLines(job.notes, [noteLine(e)]),
      });
      result.updated++;
      result.jobIds.push(saved.id);
    } else if (c.action === 'new') {
      const saved = jobs.saveJob({
        company: String(c.company || '').trim() || ics.guessJob(e).company,
        role: String(c.role || '').trim(),
        stage: 'interviewing',
        interviewAt: e.start,
        interviewLink: link,
        contacts: contacts.join('\n'),
        notes: noteLine(e),
      });
      result.created++;
      result.jobIds.push(saved.id);
    } else if (c.action === 'clear') {
      const job = jobs.getJob(c.jobId);
      if (!job) continue;
      jobs.saveJob({ ...job, interviewAt: job.interviewAt === e.start ? null : job.interviewAt, interviewLink: job.interviewAt === e.start ? '' : job.interviewLink, notes: appendLines(job.notes, [noteLine(e, 'Cancelled')]) });
      result.cleared++;
      result.jobIds.push(job.id);
    }
  }
  return result;
}

module.exports = { planFromText, planFromFiles, apply };
