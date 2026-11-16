// Audio recordings of live sessions (only when the user turns recording on
// and confirms consent). The renderer streams WebM/Opus chunks; they are
// appended to userData/recordings/<sessionId>.webm.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const open = new Map(); // sessionId -> write stream

function dir() {
  const d = path.join(app.getPath('userData'), 'recordings');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function fileFor(sessionId) {
  return path.join(dir(), `${path.basename(String(sessionId))}.webm`);
}

function start(sessionId) {
  stop(sessionId);
  open.set(sessionId, fs.createWriteStream(fileFor(sessionId)));
}

function append(sessionId, chunk) {
  const stream = open.get(sessionId);
  if (!stream) throw new Error('Recording is not running.');
  stream.write(Buffer.from(chunk));
}

function stop(sessionId) {
  const stream = open.get(sessionId);
  if (!stream) return Promise.resolve();
  open.delete(sessionId);
  return new Promise((resolve) => stream.end(resolve));
}

function exists(sessionId) {
  return fs.existsSync(fileFor(sessionId));
}

function read(sessionId) {
  return exists(sessionId) ? fs.readFileSync(fileFor(sessionId)) : null;
}

function remove(sessionId) {
  if (exists(sessionId)) fs.unlinkSync(fileFor(sessionId));
}

function removeAll() {
  for (const f of fs.readdirSync(dir())) {
    const id = f.replace(/\.webm$/, '');
    if (!open.has(id)) fs.unlinkSync(path.join(dir(), f));
  }
}

// Deletes recordings older than `days` (0 keeps them forever).
function prune(days) {
  if (!days) return 0;
  const cutoff = Date.now() - days * 86400000;
  let removed = 0;
  for (const f of fs.readdirSync(dir())) {
    const full = path.join(dir(), f);
    const id = f.replace(/\.webm$/, '');
    if (!open.has(id) && fs.statSync(full).mtimeMs < cutoff) {
      fs.unlinkSync(full);
      removed++;
    }
  }
  return removed;
}

function totalBytes() {
  return fs.readdirSync(dir()).reduce((n, f) => n + fs.statSync(path.join(dir(), f)).size, 0);
}

module.exports = { start, append, stop, exists, read, remove, removeAll, prune, totalBytes };
