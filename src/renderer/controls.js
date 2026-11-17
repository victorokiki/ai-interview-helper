/* global $, state, escapeHtml, banner, flash, importJobKit */
// Answer presets, live translation, consent + audio recording, history
// search helpers, privacy & data settings, and the light/dark theme.
// Loaded after app.js and uses its helpers.

const LANGUAGES = [
  ['en', 'English'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['pt', 'Portuguese'],
  ['it', 'Italian'],
  ['nl', 'Dutch'],
  ['hi', 'Hindi'],
  ['zh', 'Chinese (Simplified)'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['ar', 'Arabic'],
  ['ru', 'Russian'],
  ['tr', 'Turkish'],
];

const ctl = { presets: [], editing: null };

function addLanguageOptions(select) {
  for (const [code, name] of LANGUAGES) select.insertAdjacentHTML('beforeend', `<option value="${code}">${name}</option>`);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = ['light', 'dark'].includes(theme) ? theme : 'system';
}

// ---------- answer presets ----------

function activePresetId() {
  const c = state.config;
  const id = c.activePresetId || c.answerStyle || 'concise';
  return ctl.presets.some((p) => p.id === id) ? id : 'concise';
}

async function loadPresets(selectId) {
  ctl.presets = await window.api.listPresets();
  const options = ctl.presets
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}${p.builtIn ? '' : ' (mine)'}</option>`)
    .join('');
  $('#activePreset').innerHTML = ctl.presets.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
  $('#activePreset').value = activePresetId();
  $('#presetPick').innerHTML = options;
  editPreset(ctl.presets.find((p) => p.id === (selectId || activePresetId())) || ctl.presets[0]);
}

function editPreset(p) {
  ctl.editing = p;
  $('#presetPick').value = p.id;
  $('#presetName').value = p.name;
  $('#presetLength').value = p.length;
  $('#presetTone').value = p.tone;
  $('#presetFormat').value = p.format;
  $('#presetLanguage').value = p.language || '';
  $('#presetPrompt').value = p.prompt || '';
  const locked = Boolean(p.builtIn);
  for (const el of $('#presetForm').querySelectorAll('input, select, textarea')) el.disabled = locked;
  $('#presetSave').disabled = locked;
  $('#presetDelete').hidden = locked;
  $('#presetBuiltInNote').hidden = !locked;
  $('#presetUse').disabled = p.id === activePresetId();
  $('#presetUse').textContent = p.id === activePresetId() ? 'In use' : 'Use for answers';
}

async function usePreset(id) {
  state.config = await window.api.saveConfig({ activePresetId: id });
  $('#activePreset').value = id;
  if (ctl.editing) editPreset(ctl.editing);
}

$('#activePreset').onchange = (e) => usePreset(e.target.value);
$('#presetPick').onchange = (e) => editPreset(ctl.presets.find((p) => p.id === e.target.value));
$('#presetUse').onclick = () => usePreset(ctl.editing.id);

$('#presetNew').onclick = () => {
  editPreset({ id: null, name: 'My preset', length: 'medium', tone: 'confident', format: 'bullets-script', language: '', prompt: '' });
  $('#presetPick').value = '';
  $('#presetName').select();
};
$('#presetDuplicate').onclick = () => {
  const p = ctl.editing;
  editPreset({ ...p, id: null, builtIn: false, name: `${p.name} (copy)` });
  $('#presetPick').value = '';
  $('#presetName').select();
};

$('#presetForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const saved = await window.api.savePreset({
      id: ctl.editing?.id,
      name: $('#presetName').value,
      length: $('#presetLength').value,
      tone: $('#presetTone').value,
      format: $('#presetFormat').value,
      language: $('#presetLanguage').value,
      prompt: $('#presetPrompt').value,
    });
    await loadPresets(saved.id);
    flash($('#presetSave'), 'Saved ✓');
  } catch (err) {
    banner(err.message, 'error');
  }
};

$('#presetDelete').onclick = async () => {
  const p = ctl.editing;
  if (!p?.id || p.builtIn) return;
  if (!confirm(`Delete the preset “${p.name}”?`)) return;
  await window.api.deletePreset(p.id);
  state.config = await window.api.getConfig();
  await loadPresets();
};

// ---------- live translation ----------

// Adds a translation under an interviewer line (and keeps it on the utterance
// so History shows it too).
async function translateLine(el, utt) {
  const to = state.config.translateTo;
  if (!to) return;
  try {
    const text = await window.api.translate({ text: utt.text, to });
    if (!text) return;
    utt.translation = text;
    const div = document.createElement('div');
    div.className = 'translation';
    div.textContent = text;
    el.append(div);
  } catch (err) {
    banner(`Translation: ${err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 'error');
  }
}

// ---------- consent + recording ----------

// Asks before a live session when the notice hasn't been acknowledged yet or
// audio recording is requested. Resolves {record} or null if cancelled.
function confirmStart(wantRecord) {
  const c = state.config;
  if (c.liveNoticeAck && !wantRecord) return Promise.resolve({ record: false });
  const dlg = $('#startDialog');
  const sync = () => {
    $('#dlgConsentRow').hidden = !$('#dlgRecord').checked;
    $('#dlgStart').disabled = $('#dlgRecord').checked && !$('#dlgConsent').checked;
  };
  $('#dlgRecord').checked = wantRecord;
  $('#dlgConsent').checked = false;
  $('#dlgRecord').onchange = sync;
  $('#dlgConsent').onchange = sync;
  sync();
  return new Promise((resolve) => {
    dlg.onclose = async () => {
      if (dlg.returnValue !== 'start') return resolve(null);
      const record = $('#dlgRecord').checked && $('#dlgConsent').checked;
      if (!c.liveNoticeAck) state.config = await window.api.saveConfig({ liveNoticeAck: true });
      $('#recordToggle').checked = record;
      resolve({ record });
    };
    dlg.returnValue = '';
    dlg.showModal();
  });
}

// Mixes the call audio and microphone into one WebM/Opus file, streamed to
// disk every 4 seconds.
async function startRecording(sessionId, streams) {
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  let sources = 0;
  for (const s of streams) {
    if (s?.getAudioTracks().length) {
      ctx.createMediaStreamSource(s).connect(dest);
      sources++;
    }
  }
  if (!sources) {
    ctx.close();
    throw new Error('no audio to record');
  }
  await window.api.startRecording(sessionId);
  const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 48000 });
  let chain = Promise.resolve();
  rec.ondataavailable = (e) => {
    if (!e.data.size) return;
    chain = chain
      .then(async () => window.api.recordingChunk(sessionId, await e.data.arrayBuffer()))
      .catch((err) => banner(`Recording: ${err.message}`, 'error'));
  };
  const stopped = new Promise((resolve) => (rec.onstop = resolve));
  rec.start(4000);
  state.recording = { rec, ctx, dest, sessionId, stopped, flushed: () => chain };
  $('#chipRec').hidden = false;
}

// A capture source was restarted mid-session (device change): mix it in too.
function recordingAddStream(stream) {
  const r = state.recording;
  if (!r || !stream?.getAudioTracks().length) return;
  r.ctx.createMediaStreamSource(stream).connect(r.dest);
}

async function stopRecording() {
  const r = state.recording;
  if (!r) return false;
  state.recording = null;
  if (r.rec.state !== 'inactive') r.rec.stop();
  await r.stopped;
  await r.flushed();
  await window.api.stopRecording(r.sessionId);
  r.ctx.close();
  $('#chipRec').hidden = true;
  return true;
}

// Audio player for a saved recording in History.
async function recordingCard(session) {
  const buf = await window.api.getRecording(session.id);
  if (!buf) return null;
  const card = document.createElement('div');
  card.className = 'card';
  const url = URL.createObjectURL(new Blob([buf], { type: 'audio/webm' }));
  card.innerHTML = `<div class="label"><span>Recording</span><span class="actions"><button data-act="delete">Delete recording</button></span></div>
    <audio controls preload="metadata" src="${url}"></audio>`;
  card.querySelector('[data-act="delete"]').onclick = async () => {
    if (!confirm('Delete this recording? The transcript stays.')) return;
    await window.api.deleteRecording(session.id);
    URL.revokeObjectURL(url);
    card.remove();
  };
  return card;
}

// ---------- privacy & data ----------

const PROVIDER_NAMES = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI', gemini: 'Google Gemini', ollama: 'Ollama on this PC' };

function formatBytes(n) {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function loadMcpConfig() {
  const cfg = await window.api.mcpConfig();
  $('#mcpConfig').textContent = JSON.stringify(cfg, null, 2);
}
$('#copyMcp').onclick = () => {
  navigator.clipboard.writeText($('#mcpConfig').textContent);
  flash($('#copyMcp'), 'Copied ✓');
};

// Browser extension bridge.
function renderBridge(st) {
  const on = st.registered;
  $('#bridgeStatus').innerHTML = on
    ? `<span class="dot ok"></span> On for ${escapeHtml(st.browsers.join(', '))}. Extension ID <code>${escapeHtml(st.extensionId)}</code>.`
    : st.error
      ? `<span class="dot err"></span> ${escapeHtml(st.error)}`
      : '<span class="dot"></span> Off. The extension can’t reach the app until you turn this on.';
  $('#bridgeToggle').textContent = on ? 'Turn off' : 'Turn on';
  $('#bridgeToggle').dataset.on = on ? '1' : '';
}
async function loadBridge() {
  renderBridge(await window.api.bridgeStatus());
}
$('#bridgeToggle').onclick = async () => {
  const btn = $('#bridgeToggle');
  btn.disabled = true;
  try {
    const st = btn.dataset.on ? await window.api.bridgeDisable() : await window.api.bridgeEnable();
    if (!btn.dataset.on && !st.registered) st.error = 'No supported browser could be set up (Chrome, Edge, Brave or Chromium).';
    renderBridge(st);
  } finally {
    btn.disabled = false;
  }
};
$('#bridgeFolder').onclick = () => window.api.bridgeOpenFolder();

// Obsidian / Markdown vault export.
function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function renderVault(v) {
  const on = Boolean(v.path);
  let html = '<span class="dot"></span> Not set up. Choose your vault folder to start.';
  if (on && v.error) html = `<span class="dot err"></span> ${escapeHtml(v.error)}`;
  else if (on) {
    const where = `${v.obsidian ? 'Obsidian vault' : 'Folder'} <code>${escapeHtml(v.path)}</code>, in <b>${escapeHtml(v.folder)}</b>`;
    const last = v.last ? ` Updated ${timeAgo(v.last.at)}: ${v.last.notes} notes${v.last.written ? `, ${v.last.written} written` : ''}${v.last.removed ? `, ${v.last.removed} removed` : ''}.` : '';
    const left = v.last?.left?.length ? ` <span class="vault-left">${v.last.left.length} note${v.last.left.length === 1 ? '' : 's'} you edited (or that were already there) left alone.</span>` : '';
    html = `<span class="dot ok"></span> ${where}.${last}${left}`;
  }
  $('#vaultStatus').innerHTML = html;
  $('#vaultChoose').textContent = on ? 'Change folder…' : 'Choose vault folder…';
  for (const id of ['#vaultSync', '#vaultFolder', '#vaultStop']) $(id).hidden = !on;
  $('#vaultObsidian').hidden = !(on && v.obsidian);
  $('#vaultAuto').checked = v.auto;
  $('#vaultTranscripts').checked = v.transcripts;
  $('#vaultAuto').disabled = $('#vaultTranscripts').disabled = !on;
}
async function loadVault() {
  renderVault(await window.api.vaultStatus());
}
$('#vaultChoose').onclick = async () => renderVault(await window.api.vaultChoose());
$('#vaultSync').onclick = async () => {
  $('#vaultSync').disabled = true;
  renderVault(await window.api.vaultSync());
  $('#vaultSync').disabled = false;
  flash($('#vaultSync'), 'Updated ✓');
};
$('#vaultStop').onclick = async () => renderVault(await window.api.vaultStop());
$('#vaultFolder').onclick = () => window.api.vaultOpenFolder();
$('#vaultObsidian').onclick = () => window.api.vaultOpenObsidian();
$('#vaultAuto').onchange = async (e) => {
  state.config = await window.api.saveConfig({ vaultAuto: e.target.checked });
  loadVault();
};
$('#vaultTranscripts').onchange = async (e) => {
  state.config = await window.api.saveConfig({ vaultTranscripts: e.target.checked });
  renderVault(await window.api.vaultSync());
};
window.api.onVaultSynced((v) => renderVault(v));

// Autonomous Job Kit (the import itself is in workspace.js).
async function loadJobKitSettings() {
  const c = state.config;
  const linked = (await window.api.listJobs()).filter((j) => j.application).length;
  $('#jobkitStatus').innerHTML = c.jobKitFolder
    ? `Job-search folder <code>${escapeHtml(c.jobKitFolder)}</code>. ${linked} job${linked === 1 ? ' has' : 's have'} what you sent attached.`
    : 'No job-search folder chosen yet.';
  $('#useSentApplication').checked = c.useSentApplication !== false;
}
$('#jobkitImportSettings').onclick = () => importJobKit(false);
$('#useSentApplication').onchange = async (e) => {
  state.config = await window.api.saveConfig({ useSentApplication: e.target.checked });
};

// ---------- window and shortcuts ----------

const SHORTCUT_LABELS = { answer: 'Answer the latest question', screenshot: 'Screenshot and solve', toggle: 'Show or hide the window', minimize: 'Minimize or bring back', compact: 'Compact or full view' };
const IS_MAC = navigator.platform.toLowerCase().includes('mac');
const keyLabel = (acc) =>
  acc
    ? acc
        .split('+')
        .map((k) => (k === 'CommandOrControl' ? (IS_MAC ? '⌘' : 'Ctrl') : k === 'Alt' && IS_MAC ? '⌥' : k === 'Shift' && IS_MAC ? '⇧' : k))
        .map((k) => `<kbd>${escapeHtml(k)}</kbd>`)
        .join('+')
    : '<span class="muted">Off</span>';

// A key press → Electron accelerator ("CommandOrControl+Shift+K").
function accelerator(e) {
  const key = e.key.length === 1 ? e.key.toUpperCase() : { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Enter' }[e.key] || (/^F\d{1,2}$/.test(e.key) ? e.key : '');
  if (!key || ['CONTROL', 'SHIFT', 'ALT', 'META'].includes(key.toUpperCase())) return null;
  const mods = [(e.ctrlKey || e.metaKey) && 'CommandOrControl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
  if (!mods.length && !/^F\d/.test(key)) return null; // a plain letter would block typing everywhere
  if (e.code && /^Key[A-Z]$/.test(e.code)) return [...mods, e.code.slice(3)].join('+');
  if (e.code && /^Digit\d$/.test(e.code)) return [...mods, e.code.slice(5)].join('+');
  return [...mods, key].join('+');
}

function renderShortcuts({ status }) {
  const box = $('#shortcutList');
  box.innerHTML = Object.keys(SHORTCUT_LABELS)
    .map((name) => {
      const s = status[name] || { accelerator: '', ok: true };
      return `<div class="shortcut-row"><span>${SHORTCUT_LABELS[name]}</span><button type="button" class="shortcut-key${s.ok ? '' : ' taken'}" data-name="${name}" title="Click, then press new keys">${keyLabel(s.accelerator)}</button>${s.ok ? '' : '<span class="shortcut-warn">Windows didn’t accept these keys (reserved by the system or another app). Choose others.</span>'}</div>`;
    })
    .join('');
  box.querySelectorAll('.shortcut-key').forEach((btn) => {
    btn.onclick = () => {
      btn.classList.add('recording');
      btn.textContent = 'Press keys… (Esc to cancel)';
      const onKey = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') return done(null);
        if (e.key === 'Backspace' || e.key === 'Delete') return done('');
        const acc = accelerator(e);
        if (acc) done(acc);
      };
      const done = async (acc) => {
        window.removeEventListener('keydown', onKey, true);
        if (acc === null) return loadShortcuts();
        renderShortcuts(await window.api.setShortcut(btn.dataset.name, acc));
      };
      window.addEventListener('keydown', onKey, true);
    };
  });
}
async function loadShortcuts() {
  renderShortcuts(await window.api.getShortcuts());
}
$('#alwaysOnTop').onchange = async (e) => {
  const s = await window.api.windowState();
  if (s.pinned !== e.target.checked) window.api.togglePin();
};
$('#compactToggle').onchange = (e) => window.api.setCompact(e.target.checked);

// Text size in compact view: previews while dragging, saved on release.
function copilotScale(v) {
  const n = Math.min(1.6, Math.max(0.8, Number(v) || 1));
  return Math.round(n * 10) / 10;
}
function applyCopilotScale(v) {
  const n = copilotScale(v);
  document.documentElement.style.setProperty('--copilot-scale', String(n));
  $('#copilotScale').value = String(n);
  $('#copilotScaleValue').textContent = `${Math.round(n * 100)}%`;
  return n;
}
$('#copilotScale').oninput = (e) => applyCopilotScale(e.target.value);
$('#copilotScale').onchange = async (e) => {
  state.config = await window.api.saveConfig({ copilotScale: applyCopilotScale(e.target.value) });
};

// ---------- screen sharing preview ----------

function renderScreenPrivacy(s) {
  $('#screenSharePrivacy').checked = s.requested;
  // Allow switching off a preference carried from a supported OS.
  $('#screenSharePrivacy').disabled = !s.supported && !s.requested;
  const label = s.state === 'unsupported' ? 'Unsupported on this OS.'
    : s.state === 'failed' ? 'Protection could not be confirmed.'
    : s.enabled ? 'Native protection enabled — capture exclusion is not verified.'
    : 'Privacy mode off — this window can appear in captures.';
  $('#screenPrivacyStatus').textContent = `${label} Saved preference: ${s.requested ? 'on' : 'off'}. Electron reports: ${s.enabled ? 'enabled' : 'disabled'}.${s.error ? ` Error: ${s.error}` : ''}`;
  $('#screenPrivacyLimits').textContent = `${s.limitations} ${s.scope}`;
}

let sharePreviewGeneration = 0;
$('#screenSharePrivacy').onchange = async (e) => {
  const control = e.target;
  const enabled = control.checked;
  control.disabled = true;
  sharePreviewGeneration++;
  $('#sharePreviewBox').hidden = true;
  $('#sharePreviewBox').replaceChildren();
  try {
    renderScreenPrivacy(await window.api.setScreenPrivacy(enabled));
    state.config.screenSharePrivacy = enabled;
  } catch (err) {
    banner(`Privacy mode: ${err.message}`, 'error');
  } finally {
    control.disabled = false;
    renderScreenPrivacy(await window.api.screenPrivacyStatus());
  }
};

$('#sharePreview').onclick = async () => {
  const generation = ++sharePreviewGeneration;
  const btn = $('#sharePreview');
  const box = $('#sharePreviewBox');
  btn.disabled = true;
  btn.textContent = 'Capturing…';
  try {
    const r = await window.api.screenPreview();
    if (generation !== sharePreviewGeneration) return;
    renderScreenPrivacy(r.privacy);
    box.innerHTML = r.screens.length
      ? `<p class="hint">Local capture at ${escapeHtml(new Date(r.capturedAt).toLocaleTimeString())}. Native protection: ${r.privacy.enabled ? 'enabled' : 'disabled'}. This tests Electron's capture path only; Zoom, Teams and Google Meet may capture differently. Verify from another participant's view, including individual-window sharing.</p>${r.screens.map((s) => `<figure><img src="${s.image}" alt="Preview of ${escapeHtml(s.name)}"><figcaption>${escapeHtml(s.name)}</figcaption></figure>`).join('')}`
      : '<p class="hint">No screens could be captured. On macOS, allow Screen Recording for Interview Helper in System Settings → Privacy & Security.</p>';
    box.hidden = false;
  } catch (err) {
    if (generation !== sharePreviewGeneration) return;
    box.innerHTML = `<p class="hint">Couldn't capture the screen: ${escapeHtml(err.message)}</p>`;
    box.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test local screen capture';
  }
};

async function loadPrivacy() {
  renderScreenPrivacy(await window.api.screenPrivacyStatus());
  loadMcpConfig();
  loadShortcuts();
  loadVault();
  loadJobKitSettings();
  loadBridge();
  const c = state.config;
  const speech = c.transcription === 'local' ? 'Whisper on this PC (nothing leaves your computer)' : 'Deepgram (cloud)';
  const ai = PROVIDER_NAMES[c.provider] || c.provider;
  const aiNote = c.provider === 'ollama' ? 'nothing leaves your computer' : 'cloud';
  $('#dataFlows').innerHTML = `
    <div class="label">Where your data goes</div>
    <div class="flow"><span>Call audio and microphone</span><b>${escapeHtml(speech)}</b></div>
    <div class="flow"><span>Transcript, resume, job, facts, what you sent (Job Kit), screenshots</span><b>${escapeHtml(ai)}${c.provider === 'ollama' ? '' : ` (${aiNote})`}</b></div>
    <div class="flow"><span>Job search (Fill from link, New job matches)</span><b>Public job sites and lists only; carries search terms and board names, nothing about you</b></div>
    <div class="flow"><span>Sessions, recordings, documents, keys</span><b>This PC only</b></div>`;
  $('#recordByDefault').checked = Boolean(c.recordByDefault);
  $('#retentionDays').value = String(c.retentionDays || 0);
  $('#recordingRetentionDays').value = String(c.recordingRetentionDays ?? 30);
  const info = await window.api.dataInfo();
  $('#dataInfo').textContent = `${info.sessions} sessions, ${formatBytes(info.recordingsBytes)} of recordings, ${info.documents} documents, ${info.facts} facts and ${info.jobs} jobs stored in ${info.folder}`;
}

$('#savePrivacy').onclick = async () => {
  const days = Number($('#retentionDays').value);
  const recDays = Number($('#recordingRetentionDays').value);
  if (days && days < (state.config.retentionDays || Infinity) && !confirm(`Sessions older than ${days} days will be deleted now and from now on. Continue?`)) return;
  state.config = await window.api.saveConfig({ recordByDefault: $('#recordByDefault').checked, retentionDays: days, recordingRetentionDays: recDays });
  $('#recordToggle').checked = state.config.recordByDefault;
  await loadPrivacy();
  flash($('#savePrivacy'), 'Saved ✓');
};

$('#openDataFolder').onclick = () => window.api.openDataFolder();
$('#openLicenses').onclick = () => window.api.openLicenses().catch((err) => banner(err.message, 'error'));
$('#exportAll').onclick = async () => {
  const file = await window.api.exportAllData();
  if (file) banner(`Exported to ${file} (recordings and API keys are not included).`);
};

async function deleteData(scope, question) {
  if (!confirm(question)) return;
  await window.api.deleteData(scope);
  if (scope === 'everything') {
    location.reload();
    return;
  }
  await loadPrivacy();
  banner(scope === 'sessions' ? 'All sessions deleted.' : 'All recordings deleted.');
}
$('#deleteRecordings').onclick = () => deleteData('recordings', 'Delete all audio recordings? This cannot be undone.');
$('#deleteSessions').onclick = () => deleteData('sessions', 'Delete all sessions (transcripts, answers, scores, summaries)? This cannot be undone.');
$('#deleteEverything').onclick = () =>
  deleteData(
    'everything',
    'Delete everything: sessions, recordings, documents, Interview Brain facts, jobs, presets, settings and API keys? This cannot be undone. Downloaded speech models are kept.',
  );

// ---------- startup ----------

async function initControls() {
  addLanguageOptions($('#translateTo'));
  addLanguageOptions($('#presetLanguage'));
  $('#translateTo').value = state.config.translateTo || '';
  $('#recordToggle').checked = Boolean(state.config.recordByDefault);
  applyTheme(state.config.theme);
  await loadPresets();
}
