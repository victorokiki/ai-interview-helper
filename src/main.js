const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  desktopCapturer,
  dialog,
  screen,
  session,
  utilityProcess,
  nativeTheme,
  shell,
} = require('electron');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const screenPrivacy = require('./screen-privacy').createScreenPrivacy();
const ai = require('./ai');
const docs = require('./docs');
const jobs = require('./jobs');
const brain = require('./brain');
const presets = require('./presets');
const recordings = require('./recordings');
const meeting = require('./meeting');
const lab = require('./lab');
const coding = require('./coding');
const artifacts = require('./artifacts');
const lessons = require('./lessons');
const calendar = require('./calendar');
const vault = require('./vault');
const CoreLessons = require('../packages/core/lessons');
const CoreJobKit = require('../packages/core/jobkit');
const jobkit = require('./jobkit');
const postings = require('./postings');
const discover = require('./discover');
const CoreDiscover = require('../packages/core/discover');
const CoreFactCheck = require('../packages/core/factcheck');
const { createBridge } = require('./bridge');
const exporter = require('./exporter');
const career = require('../packages/core/career');
const bank = require('../packages/core/bank');
const CHALLENGES = require('../packages/core/challenges.json');
const { CODE_ROLE, codePrompt } = require('../packages/core/prompts');

// app:// must be registered before the app is ready.
lab.registerScheme();
const { PROVIDERS, prewarm, streamText } = require('./providers');

let win = null;
// In-flight AI streams, keyed by the renderer's request id, so a new
// question can cancel an answer that is still streaming.
const inflight = new Map();

// ---------- window: size, position, compact view, always on top ----------

const NORMAL_MIN = [380, 420];
const COMPACT_MIN = [300, 180];
const COMPACT_SIZE = { width: 360, height: 320 };

// Saved bounds are used only if they are still on a connected display.
function onScreen(b) {
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y) || !(b.width > 0) || !(b.height > 0)) return null;
  const area = screen.getDisplayMatching(b).workArea;
  const visible = Math.min(b.x + b.width, area.x + area.width) - Math.max(b.x, area.x) > 80 && Math.min(b.y + b.height, area.y + area.height) - Math.max(b.y, area.y) > 40;
  return visible ? b : null;
}

let boundsTimer = null;
function rememberBounds() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    store.saveConfig({ [compact ? 'compactBounds' : 'windowBounds']: win.getBounds() });
  }, 400);
}

let compact = false;
// Compact view: a small floating copilot with the latest question and answer.
function setCompact(on) {
  if (!win || on === compact) return compact;
  const c = store.loadConfig();
  if (on) {
    const b = win.getBounds();
    store.saveConfig({ windowBounds: b });
    compact = true;
    win.setMinimumSize(...COMPACT_MIN);
    const saved = onScreen(c.compactBounds);
    win.setBounds(saved || { x: b.x + b.width - COMPACT_SIZE.width, y: b.y, ...COMPACT_SIZE });
  } else {
    if (!win.isMinimized()) store.saveConfig({ compactBounds: win.getBounds() });
    compact = false;
    const saved = onScreen(c.windowBounds);
    win.setMinimumSize(...NORMAL_MIN);
    if (saved) win.setBounds(saved);
    else win.setSize(480, 760);
  }
  store.saveConfig({ compact });
  send('window:state', windowState());
  return compact;
}

function windowState() {
  return { compact, pinned: Boolean(win?.isAlwaysOnTop()), opacity: win ? win.getOpacity() : 1 };
}

// Minimize, or bring back if minimized or hidden (without stealing focus).
function toggleMinimize() {
  if (!win) return;
  if (win.isMinimized() || !win.isVisible()) {
    win.showInactive();
    if (win.isMinimized()) win.restore();
  } else win.minimize();
}

function createWindow() {
  const config = store.loadConfig();
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  compact = Boolean(config.compact);
  const saved = onScreen(compact ? config.compactBounds : config.windowBounds);
  const start = saved || (compact ? { x: width - COMPACT_SIZE.width - 20, y: 40, ...COMPACT_SIZE } : { x: width - 500, y: 40, width: 480, height: 760 });

  win = new BrowserWindow({
    show: false, // Apply saved capture protection before first display.
    ...start,
    minWidth: (compact ? COMPACT_MIN : NORMAL_MIN)[0],
    minHeight: (compact ? COMPACT_MIN : NORMAL_MIN)[1],
    frame: false,
    alwaysOnTop: config.alwaysOnTop !== false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f6f7f9',
    opacity: config.opacity,
    title: 'Interview Helper',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep timers at full speed while the window is hidden or minimized
      // during a call (Chromium otherwise slows them to once a second, which
      // delays auto-answer and speech timing).
      backgroundThrottling: false,
    },
  });

  screenPrivacy.apply(win, config.screenSharePrivacy === true);
  win.once('ready-to-show', () => win?.show());
  if (config.alwaysOnTop !== false) win.setAlwaysOnTop(true, 'floating');
  win.on('move', rememberBounds);
  win.on('resize', rememberBounds);
  // Links (e.g. research sources) open in the default browser; the app window
  // itself never navigates away.
  const openOutside = (url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      openOutside(url);
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
  win.on('closed', () => {
    win = null;
  });
}

// getDisplayMedia() in the renderer resolves here. Handing back the primary
// screen with 'loopback' audio gives us the system output (Zoom, Meet, Teams)
// without a picker; the renderer drops the video track immediately.
function setupSystemAudioCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      callback({ video: sources[0], audio: 'loopback' });
    },
    { useSystemPicker: false },
  );
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Global shortcuts, configurable in Settings. Defaults avoid the shortcuts
// Zoom, Meet and Teams use for mute, camera, sharing and raising a hand.
const SHORTCUT_DEFAULTS = {
  answer: 'CommandOrControl+Shift+Enter',
  screenshot: 'CommandOrControl+Shift+S',
  toggle: 'CommandOrControl+Shift+H',
  minimize: 'CommandOrControl+Shift+U',
  compact: 'CommandOrControl+Shift+Y',
};
const SHORTCUT_ACTIONS = {
  answer: () => send('shortcut', 'answer'),
  screenshot: () => send('shortcut', 'screenshot'),
  toggle: () => {
    if (!win) return;
    if (win.isVisible() && !win.isMinimized()) win.hide();
    else {
      win.showInactive();
      if (win.isMinimized()) win.restore();
    }
  },
  minimize: () => toggleMinimize(),
  compact: () => setCompact(!compact),
};
let shortcutStatus = {};

function shortcutMap() {
  return { ...SHORTCUT_DEFAULTS, ...(store.loadConfig().shortcuts || {}) };
}

// (Re)registers every shortcut; records which ones another app already holds.
function registerShortcuts() {
  globalShortcut.unregisterAll();
  shortcutStatus = {};
  for (const [name, accelerator] of Object.entries(shortcutMap())) {
    if (!accelerator || !SHORTCUT_ACTIONS[name]) {
      shortcutStatus[name] = { accelerator: '', ok: true };
      continue;
    }
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, SHORTCUT_ACTIONS[name]);
    } catch {
      ok = false;
    }
    if (!ok) console.warn(`Could not register shortcut ${accelerator} (in use by another app)`);
    shortcutStatus[name] = { accelerator, ok };
  }
  return shortcutStatus;
}

async function captureScreen() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { width, height } = display.size;
  const scale = display.scaleFactor;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
  });
  const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
  let image = source.thumbnail;
  // Keep the long edge within what the vision model uses without downscaling.
  const size = image.getSize();
  const maxEdge = 1920;
  if (Math.max(size.width, size.height) > maxEdge) {
    const ratio = maxEdge / Math.max(size.width, size.height);
    image = image.resize({ width: Math.round(size.width * ratio), height: Math.round(size.height * ratio) });
  }
  return image.toPNG().toString('base64');
}

// Runs one streaming AI task and forwards text deltas to the window that
// asked (the main window by default, or the Coding Lab).
function streamTask(id, task, target = null) {
  const controller = new AbortController();
  inflight.set(id, controller);
  const out = (channel, payload) => {
    if (target) {
      if (!target.isDestroyed()) target.send(channel, payload);
    } else send(channel, payload);
  };
  const onText = (text) => out('ai:chunk', { id, text });
  task(onText, controller.signal)
    .then((result) => out('ai:done', { id, result: typeof result === 'string' ? result : undefined }))
    .catch((err) => {
      if (controller.signal.aborted) out('ai:done', { id, aborted: true });
      else out('ai:done', { id, error: friendlyError(err) });
    })
    .finally(() => {
      inflight.delete(id);
      scheduleVaultSync(); // summaries and career documents are saved by these tasks
    });
  return { id };
}

function friendlyError(err) {
  const status = err?.status;
  const name = PROVIDERS[err?.provider || store.loadConfig().provider]?.label || 'The AI provider';
  if (status === 401 || status === 403) return `${name} rejected the API key. Check it in Settings.`;
  if (status === 404 && err?.provider) return `${name}: ${err.message} (check the model name in Settings)`;
  if (status === 429) return `Rate limited by ${name}. Wait a moment and try again.`;
  if (status === 529 || status >= 500) return `${name} is temporarily unavailable. Try again.`;
  return err?.message || String(err);
}

// Settings plus the active job workspace and Interview Brain facts: what the
// prompts in ai.js read.
function aiContext() {
  const config = store.loadConfig();
  const job = jobs.getJob(config.activeJobId);
  return {
    ...config,
    job,
    applicationBlock: config.useSentApplication === false ? '' : CoreJobKit.applicationBlock(job?.application, job),
    facts: brain.listFacts(),
    preset: presets.getPreset(config.activePresetId || config.answerStyle),
    lessonsBlock: config.useLessons === false ? '' : CoreLessons.lessonsBlock(lessons.forPrompt(config.activeJobId)),
  };
}

function applyTheme(theme) {
  nativeTheme.themeSource = ['light', 'dark'].includes(theme) ? theme : 'system';
  win?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f6f7f9');
}

// Applies the retention settings: old sessions (and their recordings) and old
// recordings are deleted.
function applyRetention() {
  const config = store.loadConfig();
  for (const id of store.pruneSessions(Number(config.retentionDays) || 0)) recordings.remove(id);
  recordings.prune(Number(config.recordingRetentionDays) || 0);
}

function jobName(id) {
  const j = jobs.getJob(id);
  return j ? [j.company, j.role].filter(Boolean).join(' — ') : '';
}

// ---------- local Whisper (utility process) ----------

let whisper = null;
const whisperPending = new Map();
let whisperSeq = 0;
let whisperLastUse = 0;
// The loaded model holds ~0.85 GB; free it after 10 idle minutes. The renderer
// pings warmup every few minutes during a live session to keep it loaded.
const WHISPER_IDLE_MS = 10 * 60 * 1000;
setInterval(() => {
  if (whisper && !whisperPending.size && Date.now() - whisperLastUse > WHISPER_IDLE_MS) {
    whisper.kill();
    whisper = null;
  }
}, 60 * 1000).unref?.();

function whisperProcess() {
  if (whisper) return whisper;
  whisper = utilityProcess.fork(path.join(__dirname, 'whisper-worker.js'), [], { serviceName: 'Whisper' });
  whisper.on('message', (msg) => {
    if (msg.type === 'progress') {
      send('whisper:progress', msg.progress);
      return;
    }
    const pending = whisperPending.get(msg.id);
    if (!pending) return;
    whisperPending.delete(msg.id);
    if (msg.type === 'error') pending.reject(new Error(`Local transcription: ${msg.error}`));
    else pending.resolve(msg.text ?? true);
  });
  whisper.on('exit', () => {
    whisper = null;
    for (const p of whisperPending.values()) p.reject(new Error('Local transcription stopped unexpectedly.'));
    whisperPending.clear();
  });
  return whisper;
}

function whisperRequest(type, extra = {}) {
  whisperLastUse = Date.now();
  const config = store.loadConfig();
  const id = ++whisperSeq;
  return new Promise((resolve, reject) => {
    whisperPending.set(id, { resolve, reject });
    whisperProcess().postMessage({
      type,
      id,
      model: config.whisperModel,
      language: config.language,
      cacheDir: path.join(app.getPath('userData'), 'models'),
      ...extra,
    });
  });
}

function registerIpc() {
  ipcMain.handle('config:get', () => store.publicConfig());
  ipcMain.handle('config:save', (_e, patch) => {
    if ('screenSharePrivacy' in patch && typeof patch.screenSharePrivacy !== 'boolean') throw new TypeError('Privacy mode must be a boolean.');
    const next = store.saveConfig(patch);
    if ('screenSharePrivacy' in patch) screenPrivacy.apply(win, next.screenSharePrivacy);
    if (typeof patch.opacity === 'number' && win) win.setOpacity(patch.opacity);
    if ('theme' in patch) applyTheme(next.theme);
    if ('retentionDays' in patch || 'recordingRetentionDays' in patch) applyRetention();
    return store.publicConfig(next);
  });

  ipcMain.handle('ai:answer', (_e, { id, question, transcript, rewrite }) =>
    streamTask(id, (onText, signal) =>
      ai.answerQuestion({ config: aiContext(), question, transcript, rewrite }, onText, signal),
    ),
  );

  ipcMain.handle('ai:screenshot', async (_e, { id, hint }) => {
    const wasVisible = win?.isVisible();
    // Hide our own window so it is not in the capture.
    if (wasVisible) win.hide();
    await new Promise((r) => setTimeout(r, 180));
    let imageBase64;
    try {
      imageBase64 = await captureScreen();
    } finally {
      if (wasVisible) win.showInactive();
    }
    return streamTask(id, (onText, signal) =>
      ai.solveScreenshot({ config: aiContext(), imageBase64, hint }, onText, signal),
    );
  });

  ipcMain.handle('ai:mockQuestion', (_e, { id, kind, previous, persona, difficulty, lastExchange }) =>
    streamTask(id, (onText, signal) =>
      ai.nextMockQuestion({ config: aiContext(), kind, previous, persona, difficulty, lastExchange }, onText, signal),
    ),
  );

  ipcMain.handle('ai:mockGrade', (_e, { id, question, answer, kind, delivery }) =>
    streamTask(id, (onText, signal) =>
      ai.gradeMockAnswer({ config: aiContext(), question, answer, kind, delivery }, onText, signal),
    ),
  );

  // Summarizes a saved session and stores the summary on it.
  ipcMain.handle('ai:summary', (_e, { id, sessionId }) =>
    streamTask(id, async (onText, signal) => {
      const s = store.getSession(sessionId);
      const summary = await ai.summarizeSession({ config: aiContext(), session: s }, onText, signal);
      store.saveSession({ ...store.getSession(sessionId), summary, summaryAt: Date.now() });
      return summary;
    }),
  );

  // Memory across sessions: suggest lessons from a finished session (metrics
  // first, then the AI), and let the user keep, edit, dismiss or delete them.
  ipcMain.handle('lessons:list', () => lessons.listLessons());
  ipcMain.handle('lessons:suggest', async (_e, sessionId) => {
    const config = store.loadConfig();
    const s = store.getSession(sessionId);
    if (!s || config.suggestLessons === false) return { added: [], aiError: null };
    const candidates = CoreLessons.metricLessons(s);
    let aiError = null;
    try {
      const raw = await ai.suggestLessons({ config: aiContext(), session: s, existing: lessons.listLessons() });
      candidates.push(...CoreLessons.parseLessons(raw));
    } catch (err) {
      aiError = friendlyError(err);
    }
    const added = lessons.addSuggestions(candidates, { sessionId, jobId: s.jobId || null });
    return { added, aiError };
  });
  ipcMain.handle('lessons:update', (_e, { id, patch }) => lessons.updateLesson(id, patch));
  ipcMain.handle('lessons:add', (_e, lesson) => lessons.addLesson(lesson || {}));
  ipcMain.handle('lessons:forget', (_e, id) => lessons.forgetLesson(id));
  ipcMain.handle('lessons:clearDismissed', () => lessons.clearDismissed());

  // Obsidian / Markdown vault export.
  ipcMain.handle('vault:status', () => vaultStatus());
  ipcMain.handle('vault:choose', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { title: 'Choose your Obsidian vault (or any folder)', properties: ['openDirectory', 'createDirectory'] });
    if (canceled || !filePaths[0]) return vaultStatus();
    store.saveConfig({ vaultPath: filePaths[0], vaultError: '' });
    try {
      syncVault();
    } catch {
      // The error is in the status.
    }
    return vaultStatus();
  });
  ipcMain.handle('vault:sync', () => {
    try {
      syncVault();
    } catch {
      // The error is in the status.
    }
    return vaultStatus();
  });
  ipcMain.handle('vault:stop', () => {
    store.saveConfig({ vaultPath: '', vaultLast: null, vaultError: '' });
    return vaultStatus();
  });
  ipcMain.handle('vault:openFolder', () => {
    const s = vaultStatus();
    return s.path ? shell.openPath(path.join(s.path, require('../packages/core/vault').safeName(s.folder, 60))) : '';
  });
  ipcMain.handle('vault:openObsidian', () => {
    const s = vaultStatus();
    if (!s.path || !s.obsidian) return false;
    const home = path.join(s.path, require('../packages/core/vault').safeName(s.folder, 60), 'Interview Helper.md');
    shell.openExternal(`obsidian://open?path=${encodeURIComponent(home)}`);
    return true;
  });

  ipcMain.handle('ai:prewarm', () => prewarm(store.loadConfig()));

  // Echo cancellation: the AEC3 WebAssembly bytes for the renderer's worker
  // (passed in directly, so the worker needs no file access).
  ipcMain.handle('aec:wasm', () => fs.readFileSync(require.resolve('@ennuicastr/webrtcaec3.js/dist/webrtcaec3-0.3.0.wasm')));

  // Third-party licenses shipped with the app (generated by scripts/notices.js).
  ipcMain.handle('app:licenses', async () => {
    const file = app.isPackaged ? path.join(process.resourcesPath, 'THIRD_PARTY_NOTICES.txt') : path.join(__dirname, '..', 'build', 'THIRD_PARTY_NOTICES.txt');
    if (!fs.existsSync(file)) throw new Error('License notices are generated by npm run notices.');
    const err = await shell.openPath(file);
    if (err) throw new Error(err);
  });

  // Career tools: each run is saved as a document for its job.
  ipcMain.handle('career:run', (_e, { id, tool, jobId }) => {
    const job = jobs.getJob(jobId);
    if (!job) throw new Error('Save the job first.');
    if (!career.TOOLS[tool]) throw new Error('Unknown career tool.');
    const config = { ...aiContext(), job };
    if (tool !== 'research' && !config.resume && !config.facts.length) throw new Error('Add your resume in Profile first.');
    if (['check', 'resume', 'cover'].includes(tool) && !job.jobDescription) throw new Error('Paste the job description into this job first.');
    if (tool === 'research' && !job.company) throw new Error('Add the company name to this job first.');
    const title = `${career.TOOLS[tool].title}${job.company ? ` · ${job.company}` : ''}`;
    return streamTask(id, async (onText, signal) => {
      if (tool === 'research') {
        const { blocks, searchErrors } = await ai.researchCompany({ config }, onText, signal);
        const { markdown, sources } = career.citedMarkdown(blocks);
        const artifact = artifacts.saveArtifact({ jobId, kind: tool, title, content: markdown, sources });
        return JSON.stringify({ artifact, searchErrors });
      }
      const ctx = {};
      if (tool === 'prep') {
        const research = artifacts.listArtifacts(jobId).find((a) => a.kind === 'research');
        if (research) ctx.research = research.content.slice(0, 8000);
      }
      if (tool === 'check') {
        ctx.coverage = career.keywordCoverage(job.jobDescription, `${config.resume}\n${config.facts.map((f) => f.text).join('\n')}`);
      }
      if (tool === 'followup') {
        const last = store
          .readSessions()
          .filter((s) => s.jobId === jobId && s.type === 'live')
          .sort((a, b) => b.startedAt - a.startedAt)[0];
        if (last) {
          const excerpt = (last.transcript || []).slice(-30).map((l) => `${l.speaker === 'me' ? 'Me' : 'Interviewer'}: ${l.text}`).join('\n');
          ctx.session = { startedAt: last.startedAt, summary: last.summary || '', transcriptExcerpt: excerpt };
        }
      }
      const text = await ai.careerTool({ config, tool, ctx }, onText, signal);
      const { match, body } = tool === 'check' ? career.splitMatch(text) : { match: undefined, body: text };
      const plan = tool === 'prep' ? career.parsePlan(text) : undefined;
      const artifact = artifacts.saveArtifact({ jobId, kind: tool, title, content: body, match, coverage: ctx.coverage?.coverage, plan });
      return JSON.stringify({ artifact, coverage: ctx.coverage });
    });
  });
  ipcMain.handle('career:list', (_e, jobId) => artifacts.listArtifacts(jobId));
  // Latest prep plan per job, for Mock.
  ipcMain.handle('career:plans', () => {
    const seen = new Set();
    return artifacts
      .listArtifacts()
      .filter((a) => a.kind === 'prep' && a.plan?.length && !seen.has(a.jobId) && seen.add(a.jobId))
      .map((a) => ({ id: a.id, jobId: a.jobId, title: a.title, plan: a.plan, createdAt: a.createdAt }));
  });
  ipcMain.handle('bank:get', () => bank.questionBank(store.readSessions(), artifacts.listArtifacts().filter((a) => a.kind === 'prep')));
  ipcMain.handle('career:delete', (_e, id) => artifacts.deleteArtifact(id));
  ipcMain.handle('career:export', async (_e, { id, format, html }) => {
    const a = artifacts.readAll().find((x) => x.id === id);
    if (!a || !['pdf', 'docx'].includes(format)) throw new Error('Nothing to export.');
    const name = a.title.replace(/\s*·\s*/g, ' - ').replace(/[^\w\- ]+/g, '').trim().slice(0, 80) || 'document';
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export document',
      defaultPath: `${name}.${format}`,
      filters: [format === 'pdf' ? { name: 'PDF', extensions: ['pdf'] } : { name: 'Word document', extensions: ['docx'] }],
    });
    if (canceled || !filePath) return null;
    const data = format === 'pdf' ? await exporter.toPdf(String(html || '')) : await exporter.toDocx(a.content, a.title);
    fs.writeFileSync(filePath, data);
    return filePath;
  });

  // Coding Lab
  ipcMain.handle('lab:open', () => {
    lab.openLab(path.join(__dirname, 'preload.js'));
  });
  ipcMain.handle('lab:challenges', () => CHALLENGES);
  ipcMain.handle('lab:saveAttempt', (_e, a) => coding.saveAttempt(a || {}));
  ipcMain.handle('lab:attempts', () => coding.listAttempts());
  ipcMain.handle('ai:code', (e, { id, mode, problemId, language, code, results, hintLevel }) => {
    const problem = CHALLENGES.find((c) => c.id === problemId);
    if (!problem || !['hint', 'review', 'explain'].includes(mode)) throw new Error('Unknown problem or request.');
    return streamTask(
      id,
      (onText, signal) =>
        streamText(
          aiContext(),
          { system: CODE_ROLE, effort: mode === 'hint' ? 'low' : 'medium', maxTokens: 4000, parts: [{ type: 'text', text: codePrompt(mode, { problem, language, code: String(code).slice(0, 20000), results, hintLevel }) }] },
          onText,
          signal,
        ),
      e.sender,
    );
  });
  ipcMain.handle('reminders:check', () => checkReminders());
  // How an MCP client (e.g. Claude Desktop) starts the read-only server: this
  // app's executable run as Node, pointed at src/mcp/server.js.
  ipcMain.handle('mcp:config', () => {
    const script = app.isPackaged ? path.join(process.resourcesPath, 'app.asar', 'src', 'mcp', 'server.js') : path.join(__dirname, 'mcp', 'server.js');
    return { mcpServers: { 'interview-helper': { command: process.execPath, args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } } } };
  });
  // Browser extension bridge (off until the user turns it on).
  ipcMain.handle('bridge:status', () => bridge.status());
  ipcMain.handle('bridge:enable', async () => {
    const r = await bridge.register();
    if (r.ok) store.saveConfig({ browserBridge: true });
    return { ...r, ...(await bridge.status()) };
  });
  ipcMain.handle('bridge:disable', async () => {
    await bridge.unregister();
    store.saveConfig({ browserBridge: false });
    return bridge.status();
  });
  ipcMain.handle('bridge:openFolder', async () => shell.openPath((await bridge.status()).extensionFolder));
  ipcMain.handle('live:state', (_e, active) => {
    liveActive = Boolean(active);
  });

  ipcMain.handle('ai:cancel', (_e, id) => {
    inflight.get(id)?.abort();
  });

  ipcMain.handle('resume:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Import resume',
      properties: ['openFile'],
      filters: [{ name: 'Resume', extensions: ['pdf', 'docx', 'txt', 'md'] }],
    });
    if (canceled || !filePaths[0]) return null;
    return ai.fileToText(filePaths[0], store.loadConfig());
  });

  ipcMain.handle('docs:list', () => docs.listDocs());
  ipcMain.handle('docs:delete', (_e, id) => docs.deleteDoc(id));
  ipcMain.handle('docs:add', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Add documents',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Documents', extensions: ['pdf', 'docx', 'txt', 'md'] }],
    });
    if (canceled) return { added: 0, errors: [] };
    const config = store.loadConfig();
    const errors = [];
    let added = 0;
    for (const file of filePaths) {
      try {
        const text = await ai.fileToText(file, config);
        if (!text.trim()) throw new Error('no text found');
        docs.addDoc(path.basename(file), text);
        added++;
      } catch (err) {
        errors.push(`${path.basename(file)}: ${err.message}`);
      }
    }
    return { added, errors };
  });

  ipcMain.handle('jobs:list', () => jobs.listJobs());
  ipcMain.handle('jobs:save', (_e, job) => jobs.saveJob(job || {}));
  // Calendar invites: pick or drop .ics files, review, then apply.
  ipcMain.handle('calendar:pick', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Import calendar invites',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Calendar invites', extensions: ['ics', 'ical', 'ifb'] }],
    });
    if (canceled || !filePaths.length) return null;
    return calendar.planFromFiles(filePaths);
  });
  ipcMain.handle('calendar:parseText', (_e, text) => calendar.planFromText(text));
  ipcMain.handle('calendar:apply', (_e, choices) => {
    const result = calendar.apply(choices);
    checkReminders();
    return result;
  });
  // Autonomous Job Kit: read the job-search folder, review, then apply.
  ipcMain.handle('jobkit:plan', async (_e, { choose } = {}) => {
    let folder = store.loadConfig().jobKitFolder;
    if (choose || !folder) {
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: 'Choose your job-search folder (the one with tracker.xlsx and Applications)',
        defaultPath: folder || app.getPath('documents'),
        properties: ['openDirectory'],
      });
      if (canceled || !filePaths.length) return null;
      folder = filePaths[0];
    }
    const result = await jobkit.plan(folder);
    if (result.total || result.facts.length) store.saveConfig({ jobKitFolder: result.folder });
    return result;
  });
  ipcMain.handle('jobkit:apply', (_e, { choices, facts, useSettings } = {}) => {
    const result = jobkit.apply(choices, facts, Boolean(useSettings));
    if (result.settings) {
      const patch = {};
      if (result.settings.search) patch.jobSearch = result.settings.search;
      if (result.settings.situation) patch.workSituation = result.settings.situation;
      store.saveConfig(patch);
    }
    if (!store.loadConfig().activeJobId && result.jobIds.length) store.saveConfig({ activeJobId: result.jobIds[0] });
    checkReminders();
    return result;
  });
  // Fact check (packages/core/factcheck.js, from Autonomous Job Kit): numbers,
  // tools and names in a generated text that aren't in the résumé, facts or
  // what was sent for the active job. Local; no AI call.
  ipcMain.handle('factcheck:text', (_e, text) => {
    if (typeof text !== 'string' || !text.trim()) return null;
    const c = aiContext();
    const app = c.job?.application;
    const master = [c.resume, app?.resumeText].filter(Boolean).join('\n\n');
    const known = [
      ...c.facts.map((f) => f.text),
      app?.letterText,
      ...(app?.answers || []).map((a) => `${a.question} ${a.answer}`),
      ...(app?.fields || []).map((f) => `${f.label}: ${f.value}`),
      c.extraNotes,
    ].filter(Boolean);
    if (!master && !known.length) return null; // nothing to check against
    const allow = [c.job?.company, c.job?.role].filter(Boolean);
    return CoreFactCheck.summarize(CoreFactCheck.factCheck(master, text.slice(0, 200000), { known, allow }));
  });
  // Job discovery (src/discover.js): new postings from public sources, ranked.
  ipcMain.handle('discover:status', () => discover.status());
  ipcMain.handle('discover:run', () => runDiscovery());
  ipcMain.handle('discover:dismiss', (_e, key) => {
    discover.hide(key, 'dismissed');
    return discover.status();
  });
  ipcMain.handle('discover:add', (_e, key) => {
    const m = discover.get(key);
    if (!m) return null;
    const head = [m.location && `Location: ${m.location}`, m.posted && `Posted: ${m.posted}`, `Found by job discovery (${m.source}).`].filter(Boolean).join('\n');
    const job = jobs.saveJob({ company: m.company, role: m.title, url: m.url, stage: 'saved', jobDescription: [head, m.description].filter(Boolean).join('\n\n') });
    discover.hide(key, 'added');
    if (!store.loadConfig().activeJobId) store.saveConfig({ activeJobId: job.id });
    return { job, status: discover.status() };
  });
  ipcMain.handle('discover:addEmployer', (_e, url) => {
    const parsed = CoreDiscover.parseEmployerUrl(String(url || ''));
    if (!parsed) return { error: 'Paste a link to a Greenhouse, Lever, Ashby, SmartRecruiters or Workday job board or job.' };
    const { search, added } = CoreDiscover.addEmployer(store.loadConfig().jobSearch || {}, parsed);
    store.saveConfig({ jobSearch: CoreJobKit.cleanSearch(search) });
    return { added, system: parsed.system, name: typeof parsed.entry === 'string' ? parsed.entry : parsed.entry.company || parsed.entry.tenant };
  });
  // Read a posting from its link (known job sites only; see src/postings.js).
  ipcMain.handle('postings:read', (_e, url) => postings.readPosting(url));
  ipcMain.handle('jobs:clearApplication', (_e, id) => {
    const job = jobs.getJob(id);
    return job ? jobs.saveJob({ ...job, application: null }) : null;
  });
  ipcMain.handle('jobs:delete', (_e, id) => {
    jobs.deleteJob(id);
    artifacts.deleteForJob(id);
    lessons.deleteForJob(id);
    if (store.loadConfig().activeJobId === id) store.saveConfig({ activeJobId: null });
  });
  ipcMain.handle('jobs:setActive', (_e, id) => store.publicConfig(store.saveConfig({ activeJobId: jobs.getJob(id)?.id || null })));

  ipcMain.handle('brain:list', () => brain.listFacts());
  ipcMain.handle('brain:save', (_e, facts) => brain.saveFacts(facts));
  ipcMain.handle('brain:extract', async () => {
    const config = store.loadConfig();
    try {
      const facts = await ai.extractFacts({ config, resume: config.resume, documents: docs.readAll() });
      return { added: brain.mergeFacts(facts), found: facts.length };
    } catch (err) {
      throw new Error(friendlyError(err));
    }
  });

  ipcMain.handle('analytics:get', () => store.analyticsRecords());

  ipcMain.handle('presets:list', () => presets.listPresets());
  ipcMain.handle('presets:save', (_e, preset) => presets.savePreset(preset || {}));
  ipcMain.handle('presets:delete', (_e, id) => {
    presets.deletePreset(id);
    if (store.loadConfig().activePresetId === id) store.saveConfig({ activePresetId: 'concise' });
  });

  ipcMain.handle('ai:translate', async (_e, { text, to }) => {
    try {
      return await ai.translateText({ config: store.loadConfig(), text, to });
    } catch (err) {
      throw new Error(friendlyError(err));
    }
  });

  ipcMain.handle('recording:start', (_e, id) => recordings.start(id));
  ipcMain.handle('recording:chunk', (_e, { id, chunk }) => recordings.append(id, chunk));
  ipcMain.handle('recording:stop', (_e, id) => recordings.stop(id));
  ipcMain.handle('recording:get', (_e, id) => recordings.read(id));
  ipcMain.handle('recording:delete', (_e, id) => recordings.remove(id));

  ipcMain.handle('sessions:search', (_e, query) => store.searchSessions(query));
  ipcMain.handle('sessions:export', async (_e, id) => {
    const s = store.getSession(id);
    const safe = (s.title || 'session').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'session';
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export session',
      defaultPath: `${safe}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, store.sessionMarkdown(s, jobName(s.jobId)));
    return filePath;
  });

  // Privacy & data
  ipcMain.handle('data:info', () => ({
    folder: store.dataDir(),
    sessions: store.listSessions().length,
    recordingsBytes: recordings.totalBytes(),
    documents: docs.listDocs().length,
    facts: brain.listFacts().length,
    jobs: jobs.listJobs().length,
  }));
  ipcMain.handle('data:openFolder', () => shell.openPath(store.dataDir()));
  ipcMain.handle('data:exportAll', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export all my data',
      defaultPath: `interview-helper-export-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return null;
    const bundle = {
      exportedAt: new Date().toISOString(),
      app: `Interview Helper ${app.getVersion()}`,
      settings: store.publicConfig(),
      jobs: jobs.listJobs(),
      facts: brain.listFacts(),
      lessons: lessons.listLessons(),
      presets: presets.customPresets(),
      careerDocuments: artifacts.readAll(),
      documents: docs.readAll(),
      sessions: store.readSessions(),
    };
    delete bundle.settings.deepgramKey; // never export secrets
    fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2));
    return filePath;
  });
  ipcMain.handle('data:delete', (_e, scope) => {
    if (scope === 'recordings' || scope === 'everything') recordings.removeAll();
    if (scope === 'sessions' || scope === 'everything') store.deleteAllSessions();
    if (scope === 'everything') {
      const c = store.loadConfig();
      try {
        vault.removeExport({ vaultPath: c.vaultPath, folder: c.vaultFolder });
      } catch (err) {
        console.warn('Could not remove vault notes:', err.message);
      }
      coding.clearAttempts();
      discover.clear();
      artifacts.clearArtifacts();
      for (const d of docs.listDocs()) docs.deleteDoc(d.id);
      brain.saveFacts([]);
      lessons.clearLessons();
      for (const j of jobs.listJobs()) jobs.deleteJob(j.id);
      for (const p of presets.customPresets()) presets.deletePreset(p.id);
      store.resetConfig();
      store.saveConfig({ jobsMigrated: true });
      applyTheme('system');
    }
    return true;
  });

  ipcMain.handle('whisper:warmup', () => whisperRequest('warmup'));
  ipcMain.handle('whisper:transcribe', (_e, audio) => whisperRequest('transcribe', { audio }));

  ipcMain.handle('sessions:save', (_e, s) => store.saveSession(s));
  ipcMain.handle('sessions:list', () => store.listSessions());
  ipcMain.handle('sessions:get', (_e, id) => store.getSession(id));
  ipcMain.handle('sessions:delete', (_e, id) => store.deleteSession(id));

  ipcMain.handle('window:minimize', () => win?.minimize());
  ipcMain.handle('window:close', () => win?.close());
  ipcMain.handle('window:togglePin', () => {
    if (!win) return false;
    const next = !win.isAlwaysOnTop();
    win.setAlwaysOnTop(next, 'floating');
    store.saveConfig({ alwaysOnTop: next });
    send('window:state', windowState());
    return next;
  });
  ipcMain.handle('window:state', () => windowState());
  ipcMain.handle('window:setCompact', (_e, on) => setCompact(Boolean(on)));
  // Live preview while the slider moves; Save settings stores it.
  ipcMain.handle('window:previewOpacity', (_e, value) => {
    const v = Math.min(1, Math.max(0.4, Number(value) || 1));
    win?.setOpacity(v);
    return v;
  });
  ipcMain.handle('shortcuts:get', () => ({ defaults: SHORTCUT_DEFAULTS, status: shortcutStatus }));
  ipcMain.handle('shortcuts:set', (_e, { name, accelerator }) => {
    if (!SHORTCUT_DEFAULTS[name]) return { status: shortcutStatus };
    const shortcuts = { ...(store.loadConfig().shortcuts || {}), [name]: typeof accelerator === 'string' ? accelerator.slice(0, 60) : SHORTCUT_DEFAULTS[name] };
    store.saveConfig({ shortcuts });
    return { status: registerShortcuts() };
  });
  ipcMain.handle('screen:privacyStatus', () => screenPrivacy.status(win));
  ipcMain.handle('screen:setPrivacy', (_e, enabled) => {
    if (typeof enabled !== 'boolean') throw new TypeError('Privacy mode must be a boolean.');
    store.saveConfig({ screenSharePrivacy: enabled });
    return screenPrivacy.apply(win, enabled);
  });
  // Local capture diagnostic only; meeting apps may use different capture APIs.
  ipcMain.handle('screen:preview', async () => {
    // Windows exclusion takes effect on desktop composition, not synchronously.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 640, height: 400 } });
    return { screens: sources.map((s) => ({ name: s.name, image: s.thumbnail.toDataURL() })), privacy: screenPrivacy.status(win), platform: process.platform, capturedAt: Date.now() };
  });
}

let liveActive = false;

// ---------- Obsidian / Markdown vault export ----------

function vaultData() {
  const sessions = store.readSessions();
  const docs = artifacts.readAll();
  return {
    jobs: jobs.listJobs(),
    sessions,
    artifacts: docs,
    lessons: lessons.listLessons(),
    facts: brain.listFacts(),
    bank: bank.questionBank(sessions, docs.filter((a) => a.kind === 'prep')),
    now: Date.now(),
  };
}

function vaultStatus() {
  const c = store.loadConfig();
  return {
    path: c.vaultPath || '',
    folder: c.vaultFolder || 'Interview Helper',
    obsidian: c.vaultPath ? vault.isObsidianVault(c.vaultPath) : false,
    auto: c.vaultAuto !== false,
    transcripts: Boolean(c.vaultTranscripts),
    last: c.vaultLast || null,
    error: c.vaultError || '',
  };
}

function syncVault() {
  const c = store.loadConfig();
  if (!c.vaultPath) return null;
  try {
    const r = vault.writeVault({ vaultPath: c.vaultPath, folder: c.vaultFolder || 'Interview Helper', data: vaultData(), transcripts: Boolean(c.vaultTranscripts) });
    const last = { at: r.at, notes: r.notes, written: r.written, removed: r.removed, left: [...r.edited, ...r.foreign] };
    store.saveConfig({ vaultLast: last, vaultError: '' });
    send('vault:synced', vaultStatus());
    return { ...last, folder: r.folder };
  } catch (err) {
    store.saveConfig({ vaultError: err.message });
    send('vault:synced', vaultStatus());
    throw err;
  }
}

// Changes to jobs, sessions, documents, lessons or facts update the vault a
// few seconds later (when auto-update is on).
let vaultTimer = null;
function scheduleVaultSync() {
  const c = store.loadConfig();
  if (!c.vaultPath || c.vaultAuto === false) return;
  clearTimeout(vaultTimer);
  vaultTimer = setTimeout(() => {
    try {
      syncVault();
    } catch (err) {
      console.warn('Vault export failed:', err.message);
    }
  }, Number(process.env.INTERVIEW_HELPER_VAULT_DELAY) || 3000);
}
const VAULT_CHANNELS = new Set(['sessions:save', 'sessions:delete', 'jobs:save', 'jobs:delete', 'brain:save', 'brain:extract', 'lessons:suggest', 'lessons:update', 'lessons:add', 'lessons:forget', 'lessons:clearDismissed', 'career:delete', 'calendar:apply', 'jobkit:apply', 'jobs:clearApplication', 'data:delete']);

// A job sent from the browser extension (already validated twice). The same
// posting address is never added twice.
let bridge = null;
function importFromBrowser(job) {
  const existing = job.url ? jobs.listJobs().find((j) => j.url === job.url) : null;
  const name = (j) => [j.company, j.role].filter(Boolean).join(' — ') || 'The job';
  let saved = existing;
  if (!existing) {
    let site = '';
    try {
      site = new URL(job.url).hostname.replace(/^www\./, '');
    } catch {
      site = 'your browser';
    }
    saved = jobs.saveJob({ company: job.company, role: job.role, jobDescription: job.description, url: job.url, stage: 'saved', notes: `Imported from ${site || 'your browser'} on ${new Date().toLocaleDateString()}.` });
    if (!store.loadConfig().activeJobId) store.saveConfig({ activeJobId: saved.id });
  }
  if (!existing) scheduleVaultSync();
  const text = existing ? `${name(saved)} is already in Jobs.` : `Added ${name(saved)} to Jobs from your browser.`;
  send('job:imported', { jobId: saved.id, duplicate: Boolean(existing), text });
  if (win && (!win.isVisible() || win.isMinimized() || !win.isFocused())) {
    const { Notification } = require('electron');
    if (Notification.isSupported()) {
      const n = new Notification({ title: 'Interview Helper', body: text });
      n.on('click', () => {
        win?.show();
        send('job:open', { jobId: saved.id });
      });
      n.show();
    }
  }
}

// Job reminders (follow-ups, deadlines): checked every minute and after a job
// is saved. An OS notification appears when the window isn't in view.
// Runs discovery with the saved search, résumé and facts. Returns the status
// (or { error }). New matches raise a banner, and a notification when hidden.
async function runDiscovery({ background = false } = {}) {
  const c = store.loadConfig();
  if (!c.jobSearch || !Object.keys(c.jobSearch.tracks || {}).length) return { ...discover.status(), error: 'Add your target roles in Profile → Your job search first, so new jobs can be matched to you.' };
  const master = [c.resume, ...brain.listFacts().map((f) => f.text)].filter(Boolean).join('\n');
  try {
    const st = await discover.run({ search: c.jobSearch, master, jobs: jobs.listJobs() });
    send('discover:done', { newCount: st.newCount, background });
    if (background && st.newCount && win && (!win.isVisible() || win.isMinimized())) {
      const { Notification } = require('electron');
      if (Notification.isSupported()) {
        const n = new Notification({ title: 'Interview Helper', body: `${st.newCount} new job match${st.newCount === 1 ? '' : 'es'} today.` });
        n.on('click', () => {
          win?.show();
          send('discover:open', {});
        });
        n.show();
      }
    }
    return st;
  } catch (err) {
    return { ...discover.status(), error: err.message || String(err) };
  }
}

// Daily discovery, only when turned on (it contacts public job sources).
function maybeDailyDiscovery() {
  const c = store.loadConfig();
  if (c.discoverDaily && c.jobSearch && discover.dueForDailyRun()) runDiscovery({ background: true }).catch(() => {});
}

function checkReminders() {
  const due = jobs.dueReminders();
  for (const r of due) {
    jobs.markNotified(r.jobId, r.kind);
    send('reminder', r);
    if (win && (!win.isVisible() || win.isMinimized())) {
      const { Notification } = require('electron');
      if (Notification.isSupported()) {
        const n = new Notification({ title: 'Interview Helper', body: r.text });
        n.on('click', () => win?.showInactive());
        n.show();
      }
    }
  }
  return due;
}

// Offer a session when a call app starts using the microphone (Windows).
function startMeetingWatch() {
  meeting.watch(
    ({ app: name }) => {
      if (liveActive || !win) return;
      send('meeting:detected', { app: name });
      if (!win.isVisible() || win.isMinimized()) {
        const { Notification } = require('electron');
        if (Notification.isSupported()) {
          const n = new Notification({ title: 'Interview Helper', body: `${name} is using your microphone. Start a session?` });
          n.on('click', () => win?.showInactive());
          n.show();
        }
      }
    },
    { enabled: () => !liveActive && store.loadConfig().meetingDetection !== false },
  );
}

app.whenReady().then(() => {
  lab.handleProtocol();
  jobs.migrate(store);
  applyTheme(store.loadConfig().theme);
  try {
    applyRetention();
  } catch (err) {
    console.warn('Retention cleanup failed:', err.message);
  }
  setupSystemAudioCapture();
  bridge = createBridge({ app, onImport: importFromBrowser });
  // Handlers that change exported data update the vault afterwards.
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, fn) =>
    handle(channel, VAULT_CHANNELS.has(channel) ? async (...args) => {
      const r = await fn(...args);
      scheduleVaultSync();
      return r;
    } : fn);
  registerIpc();
  ipcMain.handle = handle;
  if (store.loadConfig().vaultPath) setTimeout(scheduleVaultSync, 8000);
  createWindow();
  bridge.watch();
  // Re-register on start so the launcher follows the app if it was moved or updated.
  if (store.loadConfig().browserBridge) bridge.register().catch((err) => console.warn('Browser bridge:', err.message));
  registerShortcuts();
  startMeetingWatch();
  setTimeout(checkReminders, 5000);
  setInterval(checkReminders, 60 * 1000).unref?.();
  setTimeout(maybeDailyDiscovery, 90 * 1000);
  setInterval(maybeDailyDiscovery, 60 * 60 * 1000).unref?.();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  whisper?.kill();
  meeting.stopProbe();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
