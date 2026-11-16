// Answer presets: how live answers are written (length, tone, format,
// language, extra instructions). Built-in presets are read-only; the user's
// own presets live in userData/presets.json.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const LENGTHS = ['short', 'medium', 'long'];
const TONES = ['confident', 'conversational', 'formal', 'friendly'];
const FORMATS = ['bullets-script', 'script', 'bullets'];

// The first three ids match the old "answerStyle" setting values, so an
// existing choice carries over.
const BUILT_IN = [
  { id: 'concise', name: 'Concise', length: 'short', tone: 'confident', format: 'bullets-script', language: '', prompt: '' },
  {
    id: 'detailed',
    name: 'Detailed (STAR)',
    length: 'long',
    tone: 'conversational',
    format: 'bullets-script',
    language: '',
    prompt: 'Use the STAR structure (situation, task, action, result) for behavioral questions.',
  },
  { id: 'bullets', name: 'Bullets only', length: 'short', tone: 'confident', format: 'bullets', language: '', prompt: '' },
  {
    id: 'technical',
    name: 'Technical deep-dive',
    length: 'long',
    tone: 'formal',
    format: 'bullets-script',
    language: '',
    prompt: 'Go deep on technical reasoning: trade-offs, complexity, edge cases and alternatives.',
  },
].map((p) => ({ ...p, builtIn: true }));

function file() {
  return path.join(app.getPath('userData'), 'presets.json');
}

function customPresets() {
  try {
    const list = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function listPresets() {
  return [...BUILT_IN, ...customPresets()];
}

function getPreset(id) {
  const all = listPresets();
  return all.find((p) => p.id === id) || all[0];
}

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function savePreset(input) {
  if (BUILT_IN.some((p) => p.id === input.id)) throw new Error('Built-in presets cannot be changed. Duplicate it first.');
  const list = customPresets();
  const existing = list.find((p) => p.id === input.id);
  const preset = {
    id: existing?.id || `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: String(input.name || 'My preset').trim().slice(0, 60) || 'My preset',
    length: pick(input.length, LENGTHS, 'medium'),
    tone: pick(input.tone, TONES, 'confident'),
    format: pick(input.format, FORMATS, 'bullets-script'),
    language: String(input.language || '').slice(0, 20),
    prompt: String(input.prompt || '').trim().slice(0, 4000),
    builtIn: false,
  };
  const next = existing ? list.map((p) => (p.id === preset.id ? preset : p)) : [...list, preset];
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(next, null, 2));
  return preset;
}

function deletePreset(id) {
  const list = customPresets().filter((p) => p.id !== id);
  fs.writeFileSync(file(), JSON.stringify(list, null, 2));
}

module.exports = { LENGTHS, TONES, FORMATS, listPresets, getPreset, savePreset, deletePreset, customPresets };
