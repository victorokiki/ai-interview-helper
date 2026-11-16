// Lessons from past sessions (memory across sessions). Suggested after a
// session, then kept, edited or dismissed by the user. Only kept lessons reach
// the prompts. Dismissed ones are remembered so they aren't suggested again.
// Stored in userData/lessons.json.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const core = require('../packages/core/lessons');

const MAX = 300;

function file() {
  return path.join(app.getPath('userData'), 'lessons.json');
}

function listLessons() {
  try {
    const list = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(list) {
  // Oldest dismissed records go first when the list is full.
  let out = list;
  while (out.length > MAX) {
    const i = out.findIndex((l) => l.status === 'dismissed');
    out = i >= 0 ? out.filter((_, k) => k !== i) : out.slice(1);
  }
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(out, null, 2));
  return out;
}

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// Adds the candidates that aren't duplicates; returns the new suggestions.
function addSuggestions(candidates, { sessionId = null, jobId = null } = {}) {
  const list = listLessons();
  const fresh = core.freshSuggestions(candidates, list).map((c) => ({
    id: newId(),
    text: c.text,
    kind: c.kind,
    why: c.why || '',
    source: c.source,
    jobId: c.scope === 'job' && jobId ? jobId : null,
    sessionId,
    status: 'suggested',
    createdAt: Date.now(),
    decidedAt: null,
  }));
  write([...list, ...fresh]);
  return fresh;
}

// Keep, dismiss or edit a lesson. patch: { status?, text?, kind?, jobId? }
function updateLesson(id, patch = {}) {
  let saved = null;
  const list = listLessons().map((l) => {
    if (l.id !== id) return l;
    const text = typeof patch.text === 'string' ? patch.text.replace(/\s+/g, ' ').trim().slice(0, core.MAX_TEXT) : l.text;
    saved = {
      ...l,
      text: text || l.text,
      kind: core.KINDS.includes(patch.kind) ? patch.kind : l.kind,
      jobId: patch.jobId === undefined ? l.jobId : patch.jobId || null,
      status: ['suggested', 'approved', 'dismissed'].includes(patch.status) ? patch.status : l.status,
    };
    if (patch.status && patch.status !== l.status) saved.decidedAt = Date.now();
    return saved;
  });
  write(list);
  return saved;
}

// A lesson the user writes themselves is kept right away.
function addLesson({ text, kind, jobId }) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, core.MAX_TEXT);
  if (!clean) return null;
  const lesson = { id: newId(), text: clean, kind: core.KINDS.includes(kind) ? kind : 'content', why: '', source: 'me', jobId: jobId || null, sessionId: null, status: 'approved', createdAt: Date.now(), decidedAt: Date.now() };
  write([lesson, ...listLessons()]);
  return lesson;
}

// Forgetting a kept lesson keeps it as dismissed, so it isn't suggested again.
function forgetLesson(id) {
  return updateLesson(id, { status: 'dismissed' });
}

function deleteLesson(id) {
  write(listLessons().filter((l) => l.id !== id));
}

// Drops the record of dismissed suggestions (they may then come back).
function clearDismissed() {
  write(listLessons().filter((l) => l.status !== 'dismissed'));
}

// Job-specific lessons go with their job.
function deleteForJob(jobId) {
  write(listLessons().filter((l) => l.jobId !== jobId));
}

function clearLessons() {
  write([]);
}

function forPrompt(jobId) {
  return core.applicable(listLessons(), jobId);
}

module.exports = { listLessons, addSuggestions, updateLesson, addLesson, forgetLesson, clearDismissed, deleteLesson, deleteForJob, clearLessons, forPrompt };
