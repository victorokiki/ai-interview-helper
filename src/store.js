// Local persistence: settings (API keys encrypted with the OS keychain via
// safeStorage) and saved interview sessions under the app's userData folder.
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const records = require('../packages/core/records');

const SECRET_FIELDS = ['anthropicKey', 'openaiKey', 'geminiKey', 'deepgramKey'];
// Keys that never leave the main process. The Deepgram key is the exception:
// the renderer needs it to open its socket.
const PRIVATE_KEYS = ['anthropicKey', 'openaiKey', 'geminiKey'];

const DEFAULTS = {
  provider: 'anthropic',
  anthropicKey: '',
  anthropicModel: 'claude-opus-5-5',
  openaiKey: '',
  openaiModel: 'gpt-5-mini',
  geminiKey: '',
  geminiModel: 'gemini-2.5-flash',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'gemma3',
  transcription: 'deepgram',
  deepgramKey: '',
  whisperModel: 'Xenova/whisper-base.en',
  autoSummary: true,
  resume: '',
  jobDescription: '',
  extraNotes: '',
  answerStyle: 'concise',
  autoAnswer: true,
  language: 'en',
  opacity: 0.96,
  activeJobId: null,
  activePresetId: null, // falls back to answerStyle, then 'concise'
  translateTo: '',
  theme: 'system',
  retentionDays: 0, // 0 = keep sessions forever
  recordingRetentionDays: 30,
  recordByDefault: false,
  liveNoticeAck: false,
  meetingDetection: true,
  echoCancellation: 'on',
  mockDifficulty: 'auto',
  mockPanel: false,
};

function dataDir() {
  return app.getPath('userData');
}

function configPath() {
  return path.join(dataDir(), 'config.json');
}

function sessionsDir() {
  const dir = path.join(dataDir(), 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function encrypt(value) {
  if (!value) return '';
  if (!safeStorage.isEncryptionAvailable()) return `plain:${value}`;
  return `enc:${safeStorage.encryptString(value).toString('base64')}`;
}

function decrypt(value) {
  if (!value) return '';
  if (value.startsWith('plain:')) return value.slice(6);
  if (value.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
    } catch {
      return '';
    }
  }
  return value;
}

function loadConfig() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    // first run or unreadable file: fall back to defaults
  }
  const config = { ...DEFAULTS, ...raw };
  for (const field of SECRET_FIELDS) config[field] = decrypt(config[field]);
  return config;
}

function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  const onDisk = { ...next };
  for (const field of SECRET_FIELDS) onDisk[field] = encrypt(next[field]);
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(onDisk, null, 2));
  return next;
}

// What the renderer is allowed to see: private keys are reported as set/unset only.
function publicConfig(config = loadConfig()) {
  const out = { ...config };
  for (const field of PRIVATE_KEYS) {
    out[`has${field[0].toUpperCase()}${field.slice(1)}`] = Boolean(config[field]);
    delete out[field];
  }
  return out;
}

function saveSession(session) {
  const file = path.join(sessionsDir(), `${session.id}.json`);
  fs.writeFileSync(file, JSON.stringify(session, null, 2));
  return session.id;
}

function listSessions() {
  return fs
    .readdirSync(sessionsDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sessionsDir(), f), 'utf8'));
        return {
          id: s.id,
          type: s.type,
          title: s.title,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          jobId: s.jobId || null,
          answerCount: (s.answers || []).length,
          hasSummary: Boolean(s.summary),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.startedAt - a.startedAt);
}

function readSessions() {
  return fs
    .readdirSync(sessionsDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(sessionsDir(), f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// Progress records and search live in packages/core/records.js (shared with
// the MCP server).
function analyticsRecords() {
  return records.analyticsRecords(readSessions());
}

function searchSessions(query) {
  return records.searchSessions(readSessions(), query);
}

function sessionMarkdown(s, jobName = '') {
  const lines = [`# ${s.title || 'Session'}`, ''];
  lines.push(`- Type: ${s.type === 'mock' ? 'Mock interview' : 'Live session'}`);
  lines.push(`- Started: ${new Date(s.startedAt).toLocaleString()}`);
  if (s.endedAt) lines.push(`- Ended: ${new Date(s.endedAt).toLocaleString()}`);
  if (jobName) lines.push(`- Job: ${jobName}`);
  if (s.speech) {
    lines.push(`- My delivery: ${s.speech.words} words${s.speech.wpm ? `, ${s.speech.wpm} words/min` : ''}, ${s.speech.fillers} filler words`);
  }
  if (s.summary) lines.push('', '## Summary', '', s.summary);
  if (s.transcript?.length) {
    lines.push('', '## Transcript', '');
    for (const l of s.transcript) lines.push(`**${l.speaker === 'me' ? 'Me' : 'Interviewer'}:** ${l.text}  `);
  }
  for (const a of s.answers || []) {
    lines.push('', `## ${a.kind === 'mock' ? 'Practice question' : a.kind === 'screenshot' ? 'Screenshot' : 'Question'}: ${a.question}`, '');
    if (a.myAnswer) lines.push('**My answer:**', '', a.myAnswer, '');
    if (a.scores) {
      lines.push(`**Scores:** ${Object.entries(a.scores).map(([k, v]) => `${k} ${v}`).join(', ')}`, '');
    }
    lines.push(a.answer || '');
  }
  return lines.join('\n');
}

// Deletes sessions that started more than `days` ago. Returns their ids.
function pruneSessions(days) {
  if (!days) return [];
  const cutoff = Date.now() - days * 86400000;
  const removed = [];
  for (const s of readSessions()) {
    if ((s.startedAt || 0) < cutoff) {
      deleteSession(s.id);
      removed.push(s.id);
    }
  }
  return removed;
}

function deleteAllSessions() {
  for (const f of fs.readdirSync(sessionsDir())) {
    if (f.endsWith('.json')) fs.unlinkSync(path.join(sessionsDir(), f));
  }
}

// Removes settings and API keys (back to first-run defaults).
function resetConfig() {
  if (fs.existsSync(configPath())) fs.unlinkSync(configPath());
}

function getSession(id) {
  const file = path.join(sessionsDir(), `${path.basename(id)}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function deleteSession(id) {
  const file = path.join(sessionsDir(), `${path.basename(id)}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

module.exports = {
  loadConfig,
  saveConfig,
  publicConfig,
  saveSession,
  listSessions,
  getSession,
  deleteSession,
  analyticsRecords,
  readSessions,
  searchSessions,
  sessionMarkdown,
  pruneSessions,
  deleteAllSessions,
  resetConfig,
  dataDir,
};
