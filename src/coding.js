// Coding Lab attempts (runs and submissions), stored in userData/coding.json.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const MAX = 2000;

function file() {
  return path.join(app.getPath('userData'), 'coding.json');
}

function listAttempts() {
  try {
    const list = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveAttempt(a) {
  const attempt = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    problemId: String(a.problemId || '').slice(0, 80),
    difficulty: ['easy', 'medium', 'hard'].includes(a.difficulty) ? a.difficulty : 'medium',
    language: ['python', 'javascript', 'sql'].includes(a.language) ? a.language : 'python',
    submitted: Boolean(a.submitted),
    passed: Number(a.passed) || 0,
    total: Number(a.total) || 0,
    hints: Number(a.hints) || 0,
    ms: Number(a.ms) || 0,
    at: Date.now(),
  };
  const list = [...listAttempts(), attempt].slice(-MAX);
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(list));
  return attempt;
}

function clearAttempts() {
  if (fs.existsSync(file())) fs.unlinkSync(file());
}

module.exports = { listAttempts, saveAttempt, clearAttempts };
