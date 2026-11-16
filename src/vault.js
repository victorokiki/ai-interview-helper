// Obsidian / Markdown folder export (main process). Writes the notes from
// packages/core/vault.js into <chosen folder>/<subfolder>/ and keeps a small
// manifest (.interview-helper.json) of what it wrote:
//   - a note the user edited (its contents no longer match what we wrote) is
//     never overwritten or deleted again;
//   - a file we didn't write is never touched, even if a note would go there;
//   - notes for things deleted in the app are removed, unless edited.
// Nothing is written outside the subfolder.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('../packages/core/vault');

const MANIFEST = '.interview-helper.json';
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

function readManifest(root) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8'));
    return m && typeof m.files === 'object' ? m : { files: {} };
  } catch {
    return { files: {} };
  }
}

function inside(root, rel) {
  const abs = path.resolve(root, rel);
  return abs.startsWith(path.resolve(root) + path.sep) ? abs : null;
}

// Writes the notes. Returns counts and the notes left alone.
function writeVault({ vaultPath, folder, data, transcripts }) {
  if (!vaultPath || !fs.existsSync(vaultPath) || !fs.statSync(vaultPath).isDirectory()) throw new Error('The vault folder is missing. Choose it again in Settings.');
  const sub = core.safeName(folder || 'Interview Helper', 60);
  const root = path.join(vaultPath, sub);
  fs.mkdirSync(root, { recursive: true });
  const manifest = readManifest(root);
  const next = {};
  const result = { written: 0, unchanged: 0, removed: 0, edited: [], foreign: [], folder: root, notes: 0 };

  const notes = core.buildVault(data, { folder: sub, transcripts });
  result.notes = notes.length;
  for (const note of notes) {
    const abs = inside(root, note.path);
    if (!abs) continue;
    const want = hash(note.content);
    const known = manifest.files[note.path];
    if (fs.existsSync(abs)) {
      const have = hash(fs.readFileSync(abs, 'utf8'));
      if (!known) {
        result.foreign.push(note.path);
        continue;
      }
      if (have !== known) {
        result.edited.push(note.path);
        continue; // edited in Obsidian: dropped from the manifest, never touched again
      }
      if (have === want) {
        next[note.path] = want;
        result.unchanged++;
        continue;
      }
    }
    // New, changed, or deleted in Obsidian (recreated): write it.
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, note.content);
    fs.renameSync(tmp, abs);
    next[note.path] = want;
    result.written++;
  }

  // Notes for things that no longer exist in the app.
  for (const [rel, known] of Object.entries(manifest.files)) {
    if (next[rel] || notes.some((n) => n.path === rel)) continue;
    const abs = inside(root, rel);
    if (!abs || !fs.existsSync(abs)) continue;
    if (hash(fs.readFileSync(abs, 'utf8')) === known) {
      fs.rmSync(abs);
      result.removed++;
      const dir = path.dirname(abs);
      if (dir !== root && fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
    } else result.edited.push(rel);
  }

  fs.writeFileSync(path.join(root, MANIFEST), JSON.stringify({ app: 'Interview Helper', note: 'Notes Interview Helper wrote, so it never overwrites your edits. Safe to delete.', files: next }, null, 2));
  result.at = Date.now();
  return result;
}

// Removes the notes we wrote that are unchanged (used by "Delete everything").
// Edited notes and anything else in the folder stay. Returns how many went.
function removeExport({ vaultPath, folder }) {
  if (!vaultPath) return 0;
  const root = path.join(vaultPath, core.safeName(folder || 'Interview Helper', 60));
  const manifest = readManifest(root);
  let removed = 0;
  for (const [rel, known] of Object.entries(manifest.files)) {
    const abs = inside(root, rel);
    if (abs && fs.existsSync(abs) && hash(fs.readFileSync(abs, 'utf8')) === known) {
      fs.rmSync(abs);
      removed++;
    }
  }
  fs.rmSync(path.join(root, MANIFEST), { force: true });
  for (const dir of ['Jobs', 'Sessions', 'Documents'].map((d) => path.join(root, d)).concat(root)) {
    if (fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
  }
  return removed;
}

function isObsidianVault(dir) {
  try {
    return fs.statSync(path.join(dir, '.obsidian')).isDirectory();
  } catch {
    return false;
  }
}

module.exports = { writeVault, removeExport, isObsidianVault, MANIFEST };
