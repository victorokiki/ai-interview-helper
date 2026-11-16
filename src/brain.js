// Interview Brain: short, verified facts about the candidate (roles, projects,
// metrics, skills, stories) that answers must stick to. Extracted by the AI
// from the resume and documents, then reviewed and edited by the user.
// Stored in userData/facts.json.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const CATEGORIES = ['experience', 'project', 'achievement', 'skill', 'education', 'story', 'other'];
const MAX_FACTS = 200;

function file() {
  return path.join(app.getPath('userData'), 'facts.json');
}

function listFacts() {
  try {
    const facts = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return Array.isArray(facts) ? facts : [];
  } catch {
    return [];
  }
}

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clean(fact) {
  const text = String(fact?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!text) return null;
  return {
    id: typeof fact.id === 'string' && fact.id ? fact.id : newId(),
    category: CATEGORIES.includes(fact.category) ? fact.category : 'other',
    text,
    source: String(fact.source ?? '').trim().slice(0, 120),
  };
}

// Replaces the whole list (the Profile editor saves everything at once).
function saveFacts(facts) {
  const out = (Array.isArray(facts) ? facts : []).map(clean).filter(Boolean).slice(0, MAX_FACTS);
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(out, null, 2));
  return out;
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Adds newly extracted facts, skipping ones already in the list.
function mergeFacts(incoming) {
  const current = listFacts();
  const seen = new Set(current.map((f) => norm(f.text)));
  let added = 0;
  for (const raw of incoming) {
    const fact = clean({ ...raw, id: undefined });
    if (!fact || seen.has(norm(fact.text))) continue;
    seen.add(norm(fact.text));
    current.push(fact);
    added++;
  }
  saveFacts(current);
  return added;
}

module.exports = { CATEGORIES, listFacts, saveFacts, mergeFacts };
