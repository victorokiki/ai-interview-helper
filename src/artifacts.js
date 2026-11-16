// Career documents generated per job (resume checks, tailored resumes, cover
// letters, LinkedIn text, follow-up emails, company research), stored in
// userData/artifacts.json.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const KINDS = ['check', 'resume', 'cover', 'linkedin', 'followup', 'research', 'prep'];

function file() {
  return path.join(app.getPath('userData'), 'artifacts.json');
}

function readAll() {
  try {
    const list = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeAll(list) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(list, null, 2));
}

function listArtifacts(jobId) {
  return readAll()
    .filter((a) => !jobId || a.jobId === jobId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function saveArtifact(input) {
  if (!KINDS.includes(input.kind)) throw new Error('Unknown document type.');
  const list = readAll();
  const existing = list.find((a) => a.id === input.id);
  const artifact = {
    id: existing?.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    jobId: String(input.jobId || ''),
    kind: input.kind,
    title: String(input.title || '').slice(0, 200),
    content: String(input.content || '').slice(0, 200000),
    sources: Array.isArray(input.sources) ? input.sources.slice(0, 60).map((s) => ({ n: s.n, url: String(s.url).slice(0, 2000), title: String(s.title || '').slice(0, 300) })) : undefined,
    match: input.match && typeof input.match === 'object' ? input.match : undefined,
    coverage: typeof input.coverage === 'number' ? input.coverage : undefined,
    plan: Array.isArray(input.plan) ? input.plan.slice(0, 15).map((p) => ({ type: String(p.type).slice(0, 20), question: String(p.question).slice(0, 500), why: String(p.why || '').slice(0, 300) })) : undefined,
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  writeAll(existing ? list.map((a) => (a.id === artifact.id ? artifact : a)) : [...list, artifact]);
  return artifact;
}

function deleteArtifact(id) {
  writeAll(readAll().filter((a) => a.id !== id));
}

function deleteForJob(jobId) {
  writeAll(readAll().filter((a) => a.jobId !== jobId));
}

function clearArtifacts() {
  if (fs.existsSync(file())) fs.unlinkSync(file());
}

module.exports = { KINDS, listArtifacts, saveArtifact, deleteArtifact, deleteForJob, clearArtifacts, readAll };
