// Extra documents (project write-ups, notes, study guides) the copilot can
// draw on. Stored as plain text under userData/documents and searched locally
// with BM25, so retrieval needs no API and works offline.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const CHUNK_CHARS = 1200;
const STOPWORDS = new Set(
  'a an and are as at be but by can did do does for from had has have how i if in into is it its me my of on or our so that the their them then there these they this to was we were what when where which who why will with would you your'.split(
    ' ',
  ),
);

let index = null; // rebuilt lazily after any change

function docsDir() {
  const dir = path.join(app.getPath('userData'), 'documents');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readAll() {
  return fs
    .readdirSync(docsDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(docsDir(), f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function listDocs() {
  return readAll()
    .map(({ id, name, addedAt, text }) => ({ id, name, addedAt, chars: text.length }))
    .sort((a, b) => b.addedAt - a.addedAt);
}

function addDoc(name, text) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(path.join(docsDir(), `${id}.json`), JSON.stringify({ id, name, addedAt: Date.now(), text }));
  index = null;
  return id;
}

function deleteDoc(id) {
  const file = path.join(docsDir(), `${path.basename(id)}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  index = null;
}

function tokenize(text) {
  return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}+#.-]*/gu) || [])
    .map((t) => t.replace(/[.-]+$/, ''))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

// Paragraph-aligned chunks of about CHUNK_CHARS.
function chunk(text) {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const p of paragraphs) {
    if (current && current.length + p.length > CHUNK_CHARS) {
      chunks.push(current);
      current = '';
    }
    if (p.length > CHUNK_CHARS) {
      for (let i = 0; i < p.length; i += CHUNK_CHARS) chunks.push(p.slice(i, i + CHUNK_CHARS));
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function buildIndex() {
  const chunks = [];
  for (const doc of readAll()) {
    for (const text of chunk(doc.text)) {
      const terms = tokenize(text);
      const tf = new Map();
      for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
      chunks.push({ name: doc.name, text, tf, length: terms.length });
    }
  }
  const df = new Map();
  for (const c of chunks) for (const t of c.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const avgLength = chunks.reduce((sum, c) => sum + c.length, 0) / (chunks.length || 1);
  return { chunks, df, avgLength };
}

// Top BM25 matches for the query, within a character budget.
function searchDocs(query, { limit = 5, maxChars = 5000 } = {}) {
  index ||= buildIndex();
  const { chunks, df, avgLength } = index;
  if (!chunks.length) return [];
  const k1 = 1.2;
  const b = 0.75;
  const terms = [...new Set(tokenize(query))];
  const scored = chunks
    .map((c) => {
      let score = 0;
      for (const t of terms) {
        const f = c.tf.get(t);
        if (!f) continue;
        const idf = Math.log(1 + (chunks.length - df.get(t) + 0.5) / (df.get(t) + 0.5));
        score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * c.length) / avgLength));
      }
      return { name: c.name, text: c.text, score };
    })
    .filter((c) => c.score > 0)
    .sort((x, y) => y.score - x.score);

  const picked = [];
  let used = 0;
  for (const c of scored) {
    if (picked.length >= limit || used + c.text.length > maxChars) break;
    picked.push(c);
    used += c.text.length;
  }
  return picked;
}

module.exports = { listDocs, readAll, addDoc, deleteDoc, searchDocs, chunk };
