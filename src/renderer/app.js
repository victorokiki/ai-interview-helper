/* global loadPlans, nextPlannedQuestion, createEchoCanceller, Transcriber, createTranscriber, marked, DOMPurify, Coach, CoreQuestion, CoreSpeculation, CoreEcho, CorePrompts, recordingAddStream, loadJobs, loadFacts, loadSearchForm, applyCopilotScale, loadProgress, refreshJobs, jobLabel,
   initControls, applyTheme, loadPresets, loadPrivacy, translateLine, confirmStart, startRecording, stopRecording, recordingCard */
const $ = (sel) => document.querySelector(sel);

const state = {
  config: null,
  // live session
  live: null,
  transcribers: {},
  pending: [], // interviewer utterances not yet answered
  autoTimer: null,
  liveAnswerId: null,
  // mock interview
  mock: null,
};

// ---------- helpers ----------

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function renderMarkdown(el, text) {
  el.innerHTML = DOMPurify.sanitize(marked.parse(text || ''));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// action: optional { label, onClick } shown as a button in the banner.
function banner(message, kind = 'warn', action = null) {
  const el = $('#banner');
  if (!message) {
    el.classList.add('hidden');
    return;
  }
  el.textContent = message;
  el.className = `banner ${kind === 'error' || kind === 'ok' ? kind : ''}`;
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'btn small';
    btn.textContent = action.label;
    btn.onclick = () => {
      banner('');
      action.onClick();
    };
    el.append(' ', btn);
  }
}

const PROVIDER_KEYS = {
  anthropic: ['Anthropic', 'hasAnthropicKey'],
  openai: ['OpenAI', 'hasOpenaiKey'],
  gemini: ['Gemini', 'hasGeminiKey'],
};

// Names of the API keys the current settings still need.
function missingKeys(c, { ai = true, speech = true } = {}) {
  const missing = [];
  const p = PROVIDER_KEYS[c.provider];
  if (ai && p && !c[p[1]]) missing.push(p[0]);
  if (speech && c.transcription !== 'local' && !c.deepgramKey) missing.push('Deepgram');
  return missing;
}

function missingMessage(missing) {
  const noun = missing.length > 1 ? 'API keys' : 'API key';
  return `Add your ${missing.join(' and ')} ${noun} in Settings (or pick the local options there).`;
}

function checkKeys() {
  const missing = missingKeys(state.config);
  banner(missing.length ? missingMessage(missing) : '');
}

// First use of local Whisper downloads the model; show progress meanwhile.
async function prepareLocalSpeech() {
  if (state.config.transcription !== 'local') return true;
  banner('Loading the local speech model…');
  try {
    await window.api.warmupWhisper();
    banner('');
    return true;
  } catch (err) {
    banner(err.message, 'error');
    return false;
  }
}

window.api.onWhisperProgress((p) => banner(`Downloading the local speech model… ${p}%`));

// ---------- streaming tasks (AI calls run in the main process) ----------

const tasks = new Map();

window.api.onChunk(({ id, text }) => tasks.get(id)?.onText(text));
window.api.onDone((payload) => {
  const task = tasks.get(payload.id);
  if (!task) return;
  tasks.delete(payload.id);
  task.onDone(payload);
});

function runTask(kind, payload, { onText = () => {}, onDone = () => {} } = {}) {
  const id = uid();
  tasks.set(id, { onText, onDone });
  window.api[kind]({ id, ...payload }).catch((err) => {
    tasks.delete(id);
    onDone({ id, error: err.message || String(err) });
  });
  return id;
}

// Renders a streaming answer card. Markdown is re-rendered at most once per frame.
// Adds "Not in your résumé or facts: …" under a finished text (answers and
// career documents). Quiet when everything checks out or there is nothing to
// check against.
async function factNote(container, text, { place = 'append' } = {}) {
  container.querySelector('.fact-note')?.remove();
  let r = null;
  try {
    r = await window.api.factCheck(text);
  } catch {
    return;
  }
  // The kit's placeholders (TODO, [Fill in: …]) plus this app's own style
  // ([add metric], [your example of …]); Markdown links are not placeholders.
  const own = text.match(/\[[a-z][^\]\n]{1,80}\](?!\()/g) || [];
  if (r) r.placeholders = [...new Set([...(r.placeholders || []), ...own])];
  if (!r || (r.ok && !r.placeholders.length)) return;
  const items = r.unsupported.filter((u) => u.kind !== 'contact').map((u) => u.text);
  const unique = [...new Set(items)].slice(0, 8);
  const parts = [];
  if (unique.length) parts.push(`<b>Not in your résumé or facts:</b> ${unique.map(escapeHtml).join(', ')}. Check before you say or send them.`);
  if (r.placeholders.length) parts.push(`${r.placeholders.length} placeholder${r.placeholders.length === 1 ? '' : 's'} to fill in.`);
  if (!parts.length) return;
  const note = document.createElement('p');
  note.className = 'fact-note';
  note.innerHTML = parts.join(' ');
  if (place === 'after-body') container.querySelector('.body')?.after(note);
  else container.append(note);
}

function createAnswerCard(container, { title, question, prepend = true, before = null }) {
  const card = document.createElement('article');
  card.className = 'card streaming';
  card.innerHTML = `
    <div class="label"><span>${escapeHtml(title)}</span>
      <span class="actions"><button data-act="copy">Copy</button><button data-act="stop">Stop</button></span></div>
    ${question ? `<div class="q">${escapeHtml(question)}</div>` : ''}
    <div class="md body"><span class="muted">Thinking…</span></div>`;
  if (before) container.insertBefore(card, before);
  else if (prepend) container.prepend(card);
  else container.append(card);

  const body = card.querySelector('.body');
  let text = '';
  let scheduled = false;
  let taskId = null;

  card.querySelector('[data-act="copy"]').onclick = () => navigator.clipboard.writeText(text);
  card.querySelector('[data-act="stop"]').onclick = () => taskId && window.api.cancel(taskId);

  return {
    card,
    bind(id) {
      taskId = id;
    },
    setTitle(t) {
      card.querySelector('.label > span').textContent = t;
    },
    setQuestion(q) {
      const el = card.querySelector('.q');
      if (el) el.textContent = q;
    },
    // Shorter / Longer / Regenerate under a finished answer, and the local
    // fact check (details not in the résumé, facts or what was sent).
    addRewrites(onRewrite) {
      factNote(card, text);
      const row = document.createElement('div');
      row.className = 'rewrite-actions';
      for (const [mode, label] of [
        ['shorter', 'Shorter'],
        ['longer', 'Longer'],
        ['regenerate', 'Regenerate'],
      ]) {
        const b = document.createElement('button');
        b.className = 'btn small';
        b.textContent = label;
        b.onclick = () => onRewrite(mode);
        row.append(b);
      }
      card.append(row);
    },
    get text() {
      return text;
    },
    append(delta) {
      text += delta;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        renderMarkdown(body, text);
      });
    },
    finish({ error, aborted }) {
      card.classList.remove('streaming');
      card.querySelector('[data-act="stop"]').remove();
      if (error) {
        card.classList.add('error');
        body.innerHTML = `<p>${escapeHtml(error)}</p>`;
      } else {
        renderMarkdown(body, text + (aborted ? '\n\n_(stopped)_' : ''));
      }
    },
  };
}

// ---------- tabs & window chrome ----------

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab.dataset.tab}`));
    if (tab.dataset.tab === 'history') loadProgress();
    if (tab.dataset.tab === 'jobs') loadJobs();
    if (tab.dataset.tab === 'mock') loadPlans();
    if (tab.dataset.tab === 'settings') {
      loadPrivacy();
      loadPresets();
    }
    if (tab.dataset.tab === 'profile') {
      loadDocs();
      loadFacts();
      loadLessons();
      loadSearchForm();
    }
  });
});

$('#minBtn').onclick = () => window.api.minimize();
$('#closeBtn').onclick = async () => {
  if (state.live) await stopLive();
  await saveMock();
  window.api.close();
};
$('#pinBtn').onclick = async () => {
  const pinned = await window.api.togglePin();
  $('#pinBtn').classList.toggle('active', pinned);
};

// Compact view: only the latest question and answer, in a small window.
let tabBeforeCompact = 'live';
function applyWindowState(s) {
  const was = document.body.classList.contains('compact');
  $('#pinBtn').classList.toggle('active', s.pinned);
  if ($('#alwaysOnTop')) $('#alwaysOnTop').checked = s.pinned;
  if ($('#compactToggle')) $('#compactToggle').checked = s.compact;
  $('#compactBtn').setAttribute('aria-pressed', String(s.compact));
  $('#compactBtn').title = s.compact ? 'Full view (Ctrl+Shift+Y)' : 'Compact view (Ctrl+Shift+Y)';
  if (s.compact === was) return;
  if (s.compact) {
    tabBeforeCompact = document.querySelector('.tab.active')?.dataset.tab || 'live';
    document.querySelector('.tab[data-tab="live"]').click();
  }
  document.body.classList.toggle('compact', s.compact);
  document.body.classList.remove('mode-fade');
  void document.body.offsetWidth; // restart the fade
  document.body.classList.add('mode-fade');
  if (!s.compact && tabBeforeCompact !== 'live') document.querySelector(`.tab[data-tab="${tabBeforeCompact}"]`)?.click();
}
$('#compactBtn').onclick = () => window.api.setCompact(!document.body.classList.contains('compact'));
window.api.onWindowState(applyWindowState);
window.api.windowState().then(applyWindowState);

// ---------- live session ----------

// Question detection lives in packages/core/question.js (shared with web/mobile).
const looksLikeQuestion = (text) => CoreQuestion.looksLikeQuestion(text);

// Rendered history is capped so hour-long sessions stay light; the full
// transcript and every answer are still kept in the session.
const MAX_TRANSCRIPT_LINES = 300;
const MAX_ANSWER_CARDS = 20;

function trimChildren(box, selector, max) {
  const items = box.querySelectorAll(selector);
  for (let i = 0; i < items.length - max; i++) items[i].remove();
}

function setChip(speaker, status) {
  const chip = speaker === 'me' ? $('#chipMe') : $('#chipInterviewer');
  const label = speaker === 'me' ? 'Me' : 'Interviewer';
  chip.textContent = `${label}: ${status}${speaker === 'me' && status === 'listening' && state.aec ? ' · echo cancelled' : ''}`;
  chip.className = `chip ${status === 'listening' ? 'on' : status.startsWith('disconnected') || status === 'error' ? 'err' : ''}`;
}

function addTranscriptLine(utt) {
  const box = $('#transcript');
  box.querySelector('.empty')?.remove();
  const p = document.createElement('p');
  p.className = `line ${utt.speaker === 'me' ? 'me' : 'them'}`;
  p.innerHTML = `<span class="who">${utt.speaker === 'me' ? 'Me' : 'Interviewer'}</span>${escapeHtml(utt.text)}`;
  box.insertBefore(p, box.querySelector('.line.interim'));
  trimChildren(box, '.line:not(.interim)', MAX_TRANSCRIPT_LINES);
  box.scrollTop = box.scrollHeight;
  return p;
}

function setInterim(speaker, text) {
  const box = $('#transcript');
  let el = box.querySelector(`.line.interim[data-speaker="${speaker}"]`);
  if (!text) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('p');
    el.className = `line interim ${speaker === 'me' ? 'me' : 'them'}`;
    el.dataset.speaker = speaker;
    box.append(el);
  }
  el.innerHTML = `<span class="who">${speaker === 'me' ? 'Me' : 'Interviewer'}</span>${escapeHtml(text)}`;
  box.scrollTop = box.scrollHeight;
}

// Transcript line element for each utterance (not saved with the session).
const lineOf = new WeakMap();
const ECHO_LOOKBACK_MS = 15000;

function recentUtterances(speaker) {
  const since = Date.now() - ECHO_LOOKBACK_MS;
  return state.live.transcript.filter((u) => u.speaker === speaker && u.t >= since);
}

// Without headphones the mic hears the interviewer too. Drop "Me" lines that
// are just the interviewer's words (packages/core/echo.js), whichever channel
// finishes first.
function dropEchoes(utt) {
  if (utt.speaker === 'me') {
    return recentUtterances('them').some((them) => CoreEcho.isEcho(utt, them));
  }
  for (const me of recentUtterances('me')) {
    if (!CoreEcho.isEcho(me, utt)) continue;
    state.live.transcript.splice(state.live.transcript.indexOf(me), 1);
    lineOf.get(me)?.remove();
    state.live.echoesRemoved = (state.live.echoesRemoved || 0) + 1;
  }
  return false;
}

function onUtterance(utt) {
  if (!state.live) return;
  if (dropEchoes(utt)) {
    state.live.echoesRemoved = (state.live.echoesRemoved || 0) + 1;
    return;
  }
  state.live.transcript.push(utt);
  const line = addTranscriptLine(utt);
  lineOf.set(utt, line);

  if (utt.speaker !== 'them') return;
  translateLine(line, utt);
  if ($('#autoAnswer').checked) state.spec.end(utt.text, utt.startedAt);
  else state.pending.push(utt.text);
}

// Early signals from the interviewer's transcriber (see transcriber.js).
function onTurn(event, text) {
  if (!state.live || !$('#autoAnswer').checked) return;
  if (event === 'eager') state.spec.eager(text);
  else if (event === 'resumed') state.spec.resumed();
}

// ---------- speculative answers (packages/core/speculation.js) ----------
// Each answer stream: { view, question, draft, corrected, startedAt,
// firstTokenAt, questionEndAt, done, text, cancelled }.
state.streams = new Map();

state.spec = new CoreSpeculation.SpeculationController({
  now: () => Date.now(),
  start: (question, { draft, corrected }) => startLiveAnswer(question, { draft, corrected }),
  cancel: (id, reason) => cancelLiveAnswer(id, reason),
  promote: (id, question) => promoteLiveAnswer(id, question),
});

function typeLabel(question) {
  return CorePrompts.TYPE_LABELS[CoreQuestion.questionType(question)] || '';
}

function answerTitle(entry) {
  if (entry.draft) return 'Draft answer';
  const type = typeLabel(entry.question);
  return [entry.corrected ? 'Answer · updated for the full question' : 'Answer', type].filter(Boolean).join(' · ');
}

// Rewrites a finished answer in place (new card at the same position).
function rewriteAnswer(oldView, question, mode) {
  const titles = { shorter: 'Shorter', longer: 'Longer', regenerate: 'New version' };
  const view = createAnswerCard($('#answers'), { title: `Answer · ${titles[mode]}`, question, before: oldView.card });
  oldView.card.remove();
  const id = runTask(
    'answer',
    { question, transcript: state.live?.transcript.slice(-40) || [], rewrite: { mode, previous: oldView.text } },
    {
      onText: (t) => view.append(t),
      onDone: (res) => {
        view.finish(res);
        if (!res.error) {
          view.addRewrites((m) => rewriteAnswer(view, question, m));
          if (state.live) {
            state.live.answers.push({ kind: 'answer', question, answer: view.text, rewrite: mode, t: Date.now() });
            saveLive();
          }
        }
      },
    },
  );
  view.bind(id);
}

function startLiveAnswer(question, { draft = false, corrected = false } = {}) {
  const view = createAnswerCard($('#answers'), { title: 'Answer', question });
  trimChildren($('#answers'), '.card', MAX_ANSWER_CARDS);
  const entry = { view, question, draft, corrected, startedAt: Date.now(), questionEndAt: draft ? null : Date.now(), firstTokenAt: 0, done: false, cancelled: false };
  if (draft) view.card.classList.add('draft');
  view.setTitle(answerTitle(entry));
  const transcript = state.live?.transcript.slice(-40) || [];
  const id = runTask(
    'answer',
    { question, transcript },
    {
      onText: (t) => {
        if (!entry.firstTokenAt) entry.firstTokenAt = Date.now();
        view.append(t);
      },
      onDone: (res) => {
        entry.done = true;
        if (entry.cancelled) return;
        view.finish(res);
        state.spec.finished(id);
        if (!res.error) view.addRewrites((mode) => rewriteAnswer(view, entry.question, mode));
        if (!res.error && !entry.draft) recordLiveAnswer(entry);
      },
    },
  );
  view.bind(id);
  state.streams.set(id, entry);
  return id;
}

function cancelLiveAnswer(id, reason) {
  const entry = state.streams.get(id);
  if (!entry) return;
  if (!entry.done) window.api.cancel(id);
  // Drafts and answers replaced by a corrected one disappear; an answer cut
  // short by a genuinely new question stays visible, marked as stopped.
  if (entry.draft || reason === 'follow-up' || reason === 'changed') {
    entry.cancelled = true;
    entry.view.card.remove();
    state.streams.delete(id);
  }
}

function promoteLiveAnswer(id, question) {
  const entry = state.streams.get(id);
  if (!entry) return;
  entry.draft = false;
  entry.question = question;
  entry.questionEndAt = Date.now();
  entry.speculative = true;
  entry.view.card.classList.remove('draft');
  entry.view.setTitle(answerTitle(entry));
  entry.view.setQuestion(question);
  if (entry.done) recordLiveAnswer(entry);
}

function recordLiveAnswer(entry) {
  if (!state.live || entry.recorded) return;
  entry.recorded = true;
  state.live.answers.push({
    kind: 'answer',
    question: entry.question,
    answer: entry.view.text,
    t: Date.now(),
    latency: {
      // Negative lead = the first words were on screen before the question was final.
      leadMs: entry.firstTokenAt ? entry.firstTokenAt - entry.questionEndAt : null,
      speculative: Boolean(entry.speculative),
      corrected: entry.corrected,
    },
  });
  saveLive();
}

// While a live session runs: keep the AI connection warm, keep local Whisper
// loaded, and warn if no call audio arrives (wrong output device, muted call).
function startLiveHelpers(themStream) {
  window.api.setLiveState(true);
  navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
  window.api.prewarm().then((r) => (state.live && (state.live.prewarm = r)));
  state.helperTimers = [setInterval(() => window.api.prewarm(), 30000)];
  if (state.config.transcription === 'local') state.helperTimers.push(setInterval(() => window.api.warmupWhisper().catch(() => {}), 3 * 60000));
  if (themStream) watchCallAudio(themStream);
}

function watchCallAudio(stream) {
  try {
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let quietSince = Date.now();
    let warned = false;
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      if (Math.sqrt(sum / buf.length) > 0.003) {
        quietSince = Date.now();
        if (warned) {
          warned = false;
          banner('');
        }
      } else if (!warned && Date.now() - quietSince > 60000) {
        warned = true;
        banner('No call audio heard for a minute. Is the call playing through a different output device, or muted?');
      }
    }, 1000);
    state.helperTimers.push(timer);
    state.audioWatch = ctx;
  } catch (err) {
    console.warn('Call-audio watchdog unavailable:', err.message);
  }
}

function stopLiveHelpers() {
  window.api.setLiveState(false);
  navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
  clearTimeout(deviceChangeTimer);
  (state.helperTimers || []).forEach(clearInterval);
  state.helperTimers = [];
  try {
    state.audioWatch?.close();
  } catch {}
  state.audioWatch = null;
}

// Restart one capture source (device unplugged, default device changed).
async function restartSource(speaker) {
  if (!state.live || state.restarting?.[speaker]) return;
  state.restarting = { ...state.restarting, [speaker]: true };
  try {
    state.transcribers[speaker]?.stop();
    state.rawStreams?.[speaker]?.getTracks().forEach((t) => t.stop());
    const capture = speaker === 'me' ? Transcriber.captureMicrophone : Transcriber.captureSystemAudio;
    const stream = await capture();
    state.rawStreams = { ...state.rawStreams, [speaker]: stream };
    if (speaker === 'them') {
      await startTranscriber('them', stream);
      if (state.recording) recordingAddStream(stream);
    }
    // The mic transcriber listens to the echo canceller, which needs both
    // streams: rebuild it whenever either one changes.
    if (speaker === 'me' || state.aec) {
      if (speaker === 'them') state.transcribers.me?.stop();
      const meStream = await micForTranscription(state.rawStreams.me, state.rawStreams.them);
      if (meStream) {
        await startTranscriber('me', meStream);
        if (state.recording) recordingAddStream(meStream);
      }
    }
    if (speaker === 'them') {
      try {
        state.audioWatch?.close();
      } catch {}
      watchCallAudio(stream);
    }
  } catch (err) {
    setChip(speaker, 'error');
    banner(`${speaker === 'me' ? 'Microphone' : 'System audio'}: ${err.message}`, 'error');
  } finally {
    state.restarting[speaker] = false;
  }
}

async function startTranscriber(speaker, stream) {
  const t = createTranscriber(state.config, transcriberOptions(speaker));
  state.transcribers[speaker] = t;
  await t.start(stream);
}

// Returns the stream the mic transcriber should use: the echo-cancelled mic
// when there is call audio to cancel and the setting is on, else the raw mic.
async function micForTranscription(mic, call) {
  state.aec?.stop();
  state.aec = null;
  if (!mic || !call || state.config.echoCancellation === 'off') return mic || null;
  try {
    state.aec = await createEchoCanceller(mic, call);
    return state.aec.stream;
  } catch (err) {
    console.warn('Echo cancellation unavailable:', err);
    banner(`Echo cancellation is unavailable (${err.message}); using the microphone directly.`);
    return mic;
  }
}

function transcriberOptions(speaker) {
  return {
    speaker,
    onInterim: (text) => setInterim(speaker, text),
    onUtterance,
    onTurn: speaker === 'them' ? onTurn : undefined,
    onStatus: (s) => {
      setChip(speaker, s);
      if (s === 'device lost') restartSource(speaker);
    },
    onError: (err) => banner(err.message, 'error'),
  };
}

// Headset plugged in or default device switched: follow the new defaults.
// Listening only during a session: subscribing starts Chromium's audio and
// video-capture services (~150 MB), which an idle window doesn't need.
let deviceChangeTimer = null;
function onDeviceChange() {
  if (!state.live) return;
  clearTimeout(deviceChangeTimer);
  deviceChangeTimer = setTimeout(() => {
    restartSource('me');
    restartSource('them');
  }, 1000);
}

async function startLive() {
  state.config = await window.api.getConfig();
  const missing = missingKeys(state.config);
  if (missing.length) {
    banner(missingMessage(missing), 'error');
    return;
  }
  const consent = await confirmStart($('#recordToggle').checked);
  if (!consent) return;
  if (!(await prepareLocalSpeech())) return;

  state.live = {
    id: uid(),
    type: 'live',
    jobId: state.config.activeJobId || null,
    title: '',
    startedAt: Date.now(),
    endedAt: null,
    transcript: [],
    answers: [],
    recorded: false,
  };
  state.pending = [];
  state.spec.reset();
  state.spec.stats = { drafts: 0, promoted: 0, cancelledDrafts: 0, corrections: 0, finals: 0 };
  $('#transcript').innerHTML = '<p class="empty">Listening…</p>';
  $('#answers').innerHTML = '';
  $('#startBtn').textContent = 'Stop session';
  $('#startBtn').classList.replace('primary', 'danger');
  $('#liveDot').classList.add('live');

  const sources = [
    { speaker: 'them', capture: Transcriber.captureSystemAudio },
    { speaker: 'me', capture: Transcriber.captureMicrophone },
  ];
  const errors = [];
  const raw = {};
  await Promise.all(
    sources.map(async ({ speaker, capture }) => {
      try {
        raw[speaker] = await capture();
      } catch (err) {
        setChip(speaker, 'error');
        errors.push(`${speaker === 'me' ? 'Microphone' : 'System audio'}: ${err.message}`);
      }
    }),
  );
  state.rawStreams = raw;
  // Without headphones the mic hears the call; the echo canceller removes it.
  const meStream = await micForTranscription(raw.me, raw.them);
  const ready = [
    ['them', raw.them],
    ['me', meStream],
  ].filter(([, s]) => s);
  await Promise.all(
    ready.map(async ([speaker, stream]) => {
      try {
        await startTranscriber(speaker, stream);
      } catch (err) {
        setChip(speaker, 'error');
        errors.push(`${speaker === 'me' ? 'Microphone' : 'System audio'}: ${err.message}`);
      }
    }),
  );
  banner(errors.length ? errors.join(' · ') : '', 'error');
  if (!Object.keys(state.transcribers).length) {
    await stopLive();
    return;
  }
  const streams = [raw.them, meStream].filter(Boolean);
  startLiveHelpers(raw.them);
  if (consent.record) {
    try {
      await startRecording(state.live.id, streams);
      state.live.recorded = true;
    } catch (err) {
      banner(`Recording could not start: ${err.message}`, 'error');
    }
  }
}

async function stopLive() {
  if (!state.live) return;
  const finished = state.live;
  clearTimeout(state.autoTimer);
  stopLiveHelpers();
  finished.speculation = { ...state.spec.stats };
  state.spec.reset();
  await stopRecording();
  Object.values(state.transcribers).forEach((t) => t.stop());
  state.transcribers = {};
  if (state.aec) {
    finished.echoCancellation = await state.aec.stats().catch(() => null);
    state.aec.stop();
    state.aec = null;
  }
  Object.values(state.rawStreams || {}).forEach((s) => s?.getTracks().forEach((t) => t.stop()));
  state.rawStreams = {};
  finished.endedAt = Date.now();
  const mine = finished.transcript.filter((u) => u.speaker === 'me');
  const speech = Coach.speechMetrics(
    mine.map((u) => u.text).join(' '),
    mine.reduce((a, u) => a + (u.dur || 0), 0),
  );
  if (speech.words >= 20) finished.speech = speech;
  await saveLive();
  state.live = null;
  // Summary first (when on), then lessons from the session, which can use it.
  const lessonsAfter = () => finished.transcript.length >= 4 && offerLessons(finished.id, $('#answers'), finished.jobId);
  if (state.config.autoSummary && finished.transcript.length >= 4) summarize(finished.id, $('#answers'), lessonsAfter);
  else lessonsAfter();
  $('#startBtn').textContent = 'Start session';
  $('#startBtn').classList.replace('danger', 'primary');
  $('#liveDot').classList.remove('live');
  setChip('them', 'off');
  setChip('me', 'off');
}

async function saveLive() {
  const s = state.live;
  if (!s || (!s.transcript.length && !s.answers.length)) return;
  s.title = s.title || s.answers[0]?.question?.slice(0, 80) || 'Live interview';
  await window.api.saveSession(s);
}

function lastInterviewerLine() {
  const lines = state.live?.transcript || [];
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].speaker === 'them') return lines[i].text;
  return '';
}

function answerPending() {
  clearTimeout(state.autoTimer);
  const question = [state.pending.join(' '), state.spec.takePending()].join(' ').trim() || lastInterviewerLine();
  state.pending = [];
  if (!question) {
    banner('No interviewer question captured yet. Type one below.');
    return;
  }
  answer(question);
}

function answer(question, title = 'Answer') {
  if (state.liveAnswerId) window.api.cancel(state.liveAnswerId);
  state.spec.reset(); // a manual answer replaces any automatic one
  const type = typeLabel(question);
  const view = createAnswerCard($('#answers'), { title: [title, type].filter(Boolean).join(' · '), question });
  const transcript = state.live?.transcript.slice(-40) || [];
  const id = runTask(
    'answer',
    { question, transcript },
    {
      onText: (t) => view.append(t),
      onDone: (res) => {
        view.finish(res);
        if (!res.error) view.addRewrites((mode) => rewriteAnswer(view, question, mode));
        if (state.liveAnswerId === id) state.liveAnswerId = null;
        if (!res.error && state.live) {
          state.live.answers.push({ kind: 'answer', question, answer: view.text, t: Date.now() });
          saveLive();
        }
      },
    },
  );
  state.liveAnswerId = id;
  view.bind(id);
}

function screenshotSolve() {
  const hint = $('#askInput').value.trim();
  $('#askInput').value = '';
  // Make sure the result is visible even if another tab is open.
  document.querySelector('.tab[data-tab="live"]').click();
  const view = createAnswerCard($('#answers'), { title: 'Screenshot', question: hint || 'Solve what is on screen' });
  const id = runTask(
    'screenshot',
    { hint },
    {
      onText: (t) => view.append(t),
      onDone: (res) => {
        view.finish(res);
        if (!res.error && state.live) {
          state.live.answers.push({ kind: 'screenshot', question: hint || '(screenshot)', answer: view.text, t: Date.now() });
          saveLive();
        }
      },
    },
  );
  view.bind(id);
}

// Streams a post-call summary for a saved session; main saves it on the session.
function summarize(sessionId, container, then = null) {
  const view = createAnswerCard(container, { title: 'Post-call summary' });
  view.card.classList.add('summary');
  const id = runTask('summary', { sessionId }, {
    onText: (t) => view.append(t),
    onDone: (res) => {
      view.finish(res);
      then?.();
    },
  });
  view.bind(id);
}

$('#startBtn').onclick = () => (state.live ? stopLive() : startLive());
$('#answerBtn').onclick = () => {
  const typed = $('#askInput').value.trim();
  $('#askInput').value = '';
  if (typed) answer(typed);
  else answerPending();
};
$('#shotBtn').onclick = screenshotSolve;
$('#askForm').onsubmit = (e) => {
  e.preventDefault();
  $('#answerBtn').click();
};
$('#autoAnswer').onchange = (e) => window.api.saveConfig({ autoAnswer: e.target.checked });

window.api.onShortcut((name) => {
  if (name === 'answer') $('#answerBtn').click();
  if (name === 'screenshot') screenshotSolve();
});

// ---------- mock interview ----------

$('#openLab').onclick = () => window.api.openLab().catch((err) => banner(err.message, 'error'));

function ensureMockSession() {
  if (!state.mock) {
    state.mock = {
      session: {
        id: uid(),
        type: 'mock',
        jobId: state.config?.activeJobId || null,
        title: '',
        startedAt: Date.now(),
        endedAt: null,
        transcript: [],
        answers: [],
      },
      question: '',
      kind: '',
      recorder: null,
      committed: '',
      speechSeconds: 0,
      persona: null,
      difficulty: 'medium',
      turn: 0,
    };
  }
  return state.mock;
}

// Each panelist gets a different voice (or pitch, if only one voice exists).
function speak(text, voiceIndex = 0) {
  if (!$('#mockSpeak').checked || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.02;
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
  if (voices.length) u.voice = voices[voiceIndex % voices.length];
  u.pitch = 1 + ((voiceIndex % 4) - 1.5) * 0.08;
  speechSynthesis.speak(u);
}

// Which panelist asks next, and how hard (adaptive from this session's scores).
function nextTurn(mock) {
  const panel = $('#mockPanel').value === 'panel' ? CorePrompts.PANEL : null;
  const persona = panel ? panel[mock.turn % panel.length] : null;
  const choice = $('#mockDifficulty').value;
  const recent = mock.session.answers.map((a) => Coach.overall(a.scores));
  const difficulty = choice === 'auto' ? Coach.nextDifficulty(mock.difficulty, recent) : choice;
  return { persona, difficulty, voice: panel ? mock.turn % panel.length : 0 };
}

function questionLabel(mock) {
  return ['Question', mock.persona?.label, mock.difficulty && mock.difficulty !== 'medium' ? mock.difficulty : ''].filter(Boolean).join(' · ');
}

// Live delivery meter while recording an answer.
function updateLiveMeter() {
  const mock = state.mock;
  const el = $('#mockLive');
  if (!mock?.recorder) {
    el.hidden = true;
    return;
  }
  const seconds = mock.recordedMs / 1000 + (Date.now() - mock.recordStartedAt) / 1000;
  const m = Coach.speechMetrics($('#mockAnswer').value, seconds);
  const tip =
    m.wpm && m.wpm > 170 ? 'Slow down a little' : m.fillers >= 3 && m.fillerRate > 3 ? 'Pause instead of filler words' : m.words > 330 ? 'Start wrapping up' : '';
  el.hidden = false;
  el.innerHTML = `<span><b>${m.wpm ?? '–'}</b> words/min</span><span><b>${m.fillers}</b> fillers</span><span><b>${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}</b></span>${tip ? `<span class="tip">${tip}</span>` : ''}`;
}

function stopMockRecording() {
  const mock = state.mock;
  if (!mock?.recorder) return;
  mock.recorder.stop();
  mock.recorder = null;
  mock.recordedMs = (mock.recordedMs || 0) + (Date.now() - (mock.recordStartedAt || Date.now()));
  clearInterval(mock.meterTimer);
  $('#mockRecordBtn').classList.remove('recording');
  $('#mockRecordBtn').textContent = 'Record answer';
}

$('#mockNextBtn').onclick = () => {
  const missing = state.config ? missingKeys(state.config, { speech: false }) : [];
  if (missing.length) banner(missingMessage(missing), 'error');
  const mock = ensureMockSession();
  stopMockRecording();
  mock.question = '';
  mock.kind = $('#mockKind').value;
  mock.committed = '';
  mock.speechSeconds = 0;
  mock.recordedMs = 0;
  const turn = nextTurn(mock);
  mock.persona = turn.persona;
  mock.difficulty = turn.difficulty;
  mock.voice = turn.voice;
  mock.turn++;
  $('#mockQuestionCard .label').textContent = questionLabel(mock);
  $('#mockLive').hidden = true;
  $('#mockAnswer').value = '';
  $('#mockFeedback').hidden = true;
  $('#mockRecordBtn').disabled = true;
  $('#mockSubmitBtn').disabled = true;
  $('#mockNextBtn').disabled = true;
  const qEl = $('#mockQuestion');
  qEl.classList.remove('muted');
  qEl.textContent = '…';
  // Questions from a job's prep plan (in order) or one picked from the bank.
  const planned = nextPlannedQuestion(mock);
  if (planned) {
    $('#mockNextBtn').disabled = false;
    if (planned.done) {
      qEl.textContent = planned.done;
      qEl.classList.add('muted');
      return;
    }
    mock.kind = planned.kind;
    mock.question = planned.question;
    qEl.textContent = planned.question;
    $('#mockQuestionCard .label').textContent = planned.label;
    $('#mockRecordBtn').disabled = false;
    $('#mockSubmitBtn').disabled = false;
    speak(mock.question, mock.voice);
    return;
  }
  let text = '';
  runTask(
    'mockQuestion',
    {
      kind: mock.kind,
      previous: mock.session.answers.map((a) => a.question),
      persona: mock.persona?.id,
      difficulty: mock.difficulty,
      lastExchange: (() => {
        const last = mock.session.answers[mock.session.answers.length - 1];
        return mock.persona && last ? { question: last.question, answer: last.myAnswer } : null;
      })(),
    },
    {
      onText: (t) => {
        text += t;
        qEl.textContent = text;
      },
      onDone: (res) => {
        $('#mockNextBtn').disabled = false;
        if (res.error) {
          qEl.textContent = res.error;
          qEl.classList.add('muted');
          return;
        }
        mock.question = (res.result || text).trim();
        qEl.textContent = mock.question;
        $('#mockRecordBtn').disabled = false;
        $('#mockSubmitBtn').disabled = false;
        speak(mock.question, mock.voice);
      },
    },
  );
};

$('#mockRecordBtn').onclick = async () => {
  const mock = ensureMockSession();
  if (mock.recorder) {
    stopMockRecording();
    return;
  }
  state.config = await window.api.getConfig();
  if (missingKeys(state.config, { ai: false }).length) {
    banner('Add a Deepgram API key in Settings to record answers (or switch to local Whisper, or just type).', 'error');
    return;
  }
  if (!(await prepareLocalSpeech())) return;
  speechSynthesis.cancel();
  mock.committed = $('#mockAnswer').value.trim();
  const t = createTranscriber(state.config, {
    speaker: 'me',
    onError: (err) => banner(err.message, 'error'),
    onInterim: (text) => {
      $('#mockAnswer').value = [mock.committed, text].filter(Boolean).join(' ');
      updateLiveMeter();
    },
    onUtterance: (utt) => {
      mock.speechSeconds += utt.dur || 0;
      mock.committed = [mock.committed, utt.text].filter(Boolean).join(' ');
      $('#mockAnswer').value = mock.committed;
      updateLiveMeter();
    },
  });
  try {
    await t.start(await Transcriber.captureMicrophone());
    mock.recorder = t;
    mock.recordStartedAt = Date.now();
    mock.meterTimer = setInterval(updateLiveMeter, 1000);
    $('#mockRecordBtn').classList.add('recording');
    $('#mockRecordBtn').textContent = 'Stop recording';
  } catch (err) {
    banner(`Microphone: ${err.message}`, 'error');
  }
};

$('#mockSubmitBtn').onclick = () => {
  const mock = state.mock;
  if (!mock?.question) return;
  stopMockRecording();
  const answerText = $('#mockAnswer').value.trim();
  const kind = mock.kind || $('#mockKind').value;
  const speech = Coach.speechMetrics(answerText, mock.speechSeconds);
  const fb = $('#mockFeedback');
  fb.hidden = false;
  fb.innerHTML = '<div class="score-slot"></div><div class="md"><span class="muted">Evaluating…</span></div>' + Coach.speechHtml(speech, kind);
  const scoreSlot = fb.querySelector('.score-slot');
  const body = fb.querySelector('.md');
  $('#mockSubmitBtn').disabled = true;
  let text = '';
  let shownScores = false;
  runTask(
    'mockGrade',
    { question: mock.question, answer: answerText, kind, delivery: speech.words ? Coach.deliverySummary(speech) : '' },
    {
      onText: (t) => {
        text += t;
        const { scores, body: md } = Coach.splitScores(text);
        if (scores && !shownScores) {
          scoreSlot.innerHTML = Coach.scoresHtml(scores);
          shownScores = true;
        }
        if (md) renderMarkdown(body, md);
      },
      onDone: (res) => {
        $('#mockSubmitBtn').disabled = false;
        if (res.error) {
          body.innerHTML = `<p>${escapeHtml(res.error)}</p>`;
          return;
        }
        const { scores, body: md } = Coach.splitScores(text);
        renderMarkdown(body, md);
        mock.session.answers.push({
          kind: 'mock',
          scenario: kind,
          persona: mock.persona?.id || null,
          difficulty: mock.difficulty,
          question: mock.question,
          myAnswer: answerText,
          answer: md,
          scores,
          speech: speech.words ? speech : null,
          t: Date.now(),
        });
        saveMock(false);
      },
    },
  );
};

async function saveMock(end = true) {
  const s = state.mock?.session;
  if (!s || !s.answers.length) return;
  if (end) s.endedAt = Date.now();
  const kinds = [...new Set(s.answers.map((a) => Coach.SCENARIOS[a.scenario] || a.scenario))];
  s.title = `Mock (${kinds.join(', ')}) — ${s.answers.length} question${s.answers.length > 1 ? 's' : ''}`;
  await window.api.saveSession(s);
}

$('#mockEndBtn').onclick = async () => {
  stopMockRecording();
  await saveMock();
  const ended = state.mock?.session;
  if (ended?.answers.length) offerLessons(ended.id, $('#mockLessons'), ended.jobId);
  state.mock = null;
  $('#mockQuestion').textContent = 'Session saved to History. Press “Next question” to start a new one.';
  $('#mockQuestion').classList.add('muted');
  $('#mockAnswer').value = '';
  $('#mockFeedback').hidden = true;
  $('#mockRecordBtn').disabled = true;
  $('#mockSubmitBtn').disabled = true;
};

// ---------- history ----------

async function loadHistory() {
  const list = $('#historyList');
  $('#historyDetail').hidden = true;
  $('#progress').hidden = false;
  $('#historyTitle').hidden = false;
  list.hidden = false;
  const filter = $('#progressJob').value;
  const query = $('#historySearch').value.trim();
  const hits = query ? new Map((await window.api.searchSessions(query)).map((h) => [h.id, h.snippet])) : null;
  const sessions = (await window.api.listSessions()).filter((s) => (!filter || s.jobId === filter) && (!hits || hits.has(s.id)));
  if (!sessions.length) {
    list.innerHTML = `<li class="muted" style="cursor:default">${query ? 'No sessions match your search.' : 'No sessions yet.'}</li>`;
    return;
  }
  list.innerHTML = '';
  for (const s of sessions) {
    const li = document.createElement('li');
    const job = !filter && s.jobId ? jobLabel(s.jobId) : '';
    li.innerHTML = `<div><div>${escapeHtml(s.title || 'Session')}</div>
      <div class="meta">${new Date(s.startedAt).toLocaleString()} · ${s.type === 'mock' ? 'Mock' : 'Live'} · ${s.answerCount} answers${s.hasSummary ? ' · summary' : ''}${job ? ` · ${escapeHtml(job)}` : ''}</div>
      ${hits ? `<div class="snippet">${escapeHtml(hits.get(s.id))}</div>` : ''}</div>`;
    li.onclick = () => showSession(s.id);
    list.append(li);
  }
}

async function showSession(id) {
  const s = await window.api.getSession(id);
  const detail = $('#historyDetail');
  $('#historyList').hidden = true;
  $('#progress').hidden = true;
  $('#historyTitle').hidden = true;
  detail.hidden = false;
  const job = s.jobId ? jobLabel(s.jobId) : '';
  detail.innerHTML = `
    <div class="toolbar">
      <button class="btn" id="histBack">← Back</button>
      ${s.type === 'live' && s.transcript?.length ? `<button class="btn" id="histSummary">${s.summary ? 'Regenerate summary' : 'Write summary'}</button>` : ''}
      <button class="btn" id="histExport">Export</button>
      <button class="btn ghost push-right" id="histDelete">Delete</button>
    </div>
    <div class="card"><div class="label">${escapeHtml(s.title || 'Session')}</div>
      <div class="meta muted">${new Date(s.startedAt).toLocaleString()}${job ? ` · ${escapeHtml(job)}` : ''}</div></div>
    <div id="histSummaryBox"></div>`;

  if (s.recorded) {
    const rec = await recordingCard(s);
    if (rec) detail.append(rec);
  }

  if (s.speech) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = Coach.speechHtml(s.speech, 'session').replace('<div class="label">Delivery</div>', '<div class="label">Your delivery</div>');
    detail.append(card);
  }

  if (s.summary) {
    const card = document.createElement('div');
    card.className = 'card summary';
    card.innerHTML =
      '<div class="label"><span>Post-call summary</span><span class="actions"><button data-act="copy">Copy</button></span></div><div class="md"></div>';
    renderMarkdown(card.querySelector('.md'), s.summary);
    card.querySelector('[data-act="copy"]').onclick = () => navigator.clipboard.writeText(s.summary);
    $('#histSummaryBox').append(card);
  }
  if ($('#histSummary')) {
    $('#histSummary').onclick = () => {
      $('#histSummaryBox').innerHTML = '';
      summarize(s.id, $('#histSummaryBox'));
    };
  }

  if (s.transcript?.length) {
    const t = document.createElement('div');
    t.className = 'card';
    t.innerHTML =
      '<div class="label">Transcript</div>' +
      s.transcript
        .map(
          (l) =>
            `<p class="line ${l.speaker === 'me' ? 'me' : 'them'}"><span class="who">${l.speaker === 'me' ? 'Me' : 'Interviewer'}</span>${escapeHtml(l.text)}${l.translation ? `<span class="translation">${escapeHtml(l.translation)}</span>` : ''}</p>`,
        )
        .join('');
    detail.append(t);
  }
  for (const a of s.answers || []) {
    const card = document.createElement('div');
    card.className = 'card';
    const label = a.kind === 'screenshot' ? 'Screenshot' : a.kind === 'mock' ? `Mock question${a.scenario ? ` · ${Coach.SCENARIOS[a.scenario] || a.scenario}` : ''}` : 'Answer';
    card.innerHTML = `<div class="label">${escapeHtml(label)}</div>
      <div class="q">${escapeHtml(a.question)}</div>
      ${a.myAnswer ? `<div class="label">Your answer</div><p>${escapeHtml(a.myAnswer)}</p>` : ''}
      ${a.scores ? Coach.scoresHtml(a.scores) : ''}
      ${a.myAnswer ? '<div class="label">Feedback</div>' : ''}
      <div class="md"></div>
      ${a.speech ? Coach.speechHtml(a.speech, a.scenario) : ''}`;
    renderMarkdown(card.querySelector('.md'), a.answer);
    detail.append(card);
  }
  $('#histBack').onclick = loadProgress;
  $('#histExport').onclick = async () => {
    const file = await window.api.exportSession(s.id);
    if (file) banner(`Exported to ${file}`);
  };
  $('#histDelete').onclick = async () => {
    if (!confirm('Delete this session' + (s.recorded ? ' and its recording' : '') + '?')) return;
    await window.api.deleteSession(s.id);
    if (s.recorded) await window.api.deleteRecording(s.id);
    loadProgress();
  };
}

$('#historyRefresh').onclick = () => loadProgress();
let searchTimer = null;
$('#historySearch').oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadHistory, 250);
};

// ---------- profile ----------

$('#importResume').onclick = async () => {
  const btn = $('#importResume');
  btn.disabled = true;
  btn.textContent = 'Importing…';
  try {
    const text = await window.api.importResume();
    if (text) $('#resume').value = text;
  } catch (err) {
    banner(`Resume import failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import PDF / DOCX / TXT';
  }
};

$('#saveProfile').onclick = async () => {
  state.config = await window.api.saveConfig({
    resume: $('#resume').value.trim(),
    extraNotes: $('#extraNotes').value.trim(),
  });
  flash($('#saveProfile'), 'Saved ✓');
};

async function loadDocs() {
  const list = $('#docList');
  const items = await window.api.listDocs();
  if (!items.length) {
    list.innerHTML = '<li class="muted">No documents yet.</li>';
    return;
  }
  list.innerHTML = '';
  for (const d of items) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="name" title="${escapeHtml(d.name)}">${escapeHtml(d.name)}</span>
      <span class="meta">${Math.max(1, Math.round(d.chars / 1000))}k chars</span>
      <button class="icon-btn" title="Remove">✕</button>`;
    li.querySelector('button').onclick = async () => {
      await window.api.deleteDoc(d.id);
      loadDocs();
    };
    list.append(li);
  }
}

$('#addDocs').onclick = async () => {
  const btn = $('#addDocs');
  btn.disabled = true;
  btn.textContent = 'Reading…';
  try {
    const { errors } = await window.api.addDocs();
    banner(errors.length ? `Some files were skipped: ${errors.join(' · ')}` : '', 'error');
  } catch (err) {
    banner(`Adding documents failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add PDF / DOCX / TXT / MD';
    loadDocs();
  }
};

// ---------- settings ----------

function flash(btn, label) {
  const original = btn.textContent;
  btn.textContent = label;
  setTimeout(() => (btn.textContent = original), 1400);
}

$('#opacity').oninput = (e) => {
  $('#opacityValue').textContent = `${Math.round(e.target.value * 100)}%`;
  window.api.previewOpacity(Number(e.target.value));
};

// Keys the main process keeps to itself: shown as saved/not set, sent only when typed.
const PRIVATE_KEYS = [
  ['anthropicKey', 'hasAnthropicKey', 'anthropicStatus'],
  ['openaiKey', 'hasOpenaiKey', 'openaiStatus'],
  ['geminiKey', 'hasGeminiKey', 'geminiStatus'],
];
const PLAIN_FIELDS = [
  'provider',
  'anthropicModel',
  'openaiModel',
  'geminiModel',
  'ollamaUrl',
  'ollamaModel',
  'transcription',
  'deepgramKey',
  'whisperModel',
  'language',
  'translateTo',
  'theme',
  'echoCancellation',
];

function showSettingGroups() {
  document.querySelectorAll('[data-provider]').forEach((el) => (el.hidden = el.dataset.provider !== $('#provider').value));
  document.querySelectorAll('[data-engine]').forEach((el) => (el.hidden = !el.dataset.engine.split(' ').includes($('#transcription').value)));
}
$('#provider').onchange = showSettingGroups;
$('#transcription').onchange = showSettingGroups;

$('#saveSettings').onclick = async () => {
  const patch = { opacity: Number($('#opacity').value), autoSummary: $('#autoSummary').checked, meetingDetection: $('#meetingDetection').checked };
  for (const field of PLAIN_FIELDS) patch[field] = $(`#${field}`).value.trim();
  for (const [field] of PRIVATE_KEYS) {
    const value = $(`#${field}`).value.trim();
    if (value) patch[field] = value;
  }
  state.config = await window.api.saveConfig(patch);
  fillSettings();
  applyTheme(state.config.theme);
  checkKeys();
  flash($('#saveSettings'), 'Saved ✓');
};

$('#downloadWhisper').onclick = async () => {
  const btn = $('#downloadWhisper');
  btn.disabled = true;
  state.config = await window.api.saveConfig({ whisperModel: $('#whisperModel').value, language: $('#language').value });
  if (await prepareLocalSpeech()) flash(btn, 'Ready ✓');
  btn.disabled = false;
};

function fillSettings() {
  const c = state.config;
  for (const [field, flag, status] of PRIVATE_KEYS) {
    $(`#${field}`).value = '';
    $(`#${status}`).textContent = c[flag] ? '(saved — leave blank to keep)' : '(not set)';
  }
  for (const field of PLAIN_FIELDS) $(`#${field}`).value = c[field] ?? '';
  $('#autoSummary').checked = c.autoSummary;
  $('#meetingDetection').checked = c.meetingDetection !== false;
  $('#opacity').value = c.opacity;
  $('#opacityValue').textContent = `${Math.round(c.opacity * 100)}%`;
  // Text size in compact view (controls.js loads after this file).
  if (typeof applyCopilotScale === 'function') applyCopilotScale(c.copilotScale ?? 1);
  showSettingGroups();
}

// ---------- boot ----------

(async function init() {
  state.config = await window.api.getConfig();
  $('#resume').value = state.config.resume || '';
  $('#extraNotes').value = state.config.extraNotes || '';
  $('#autoAnswer').checked = state.config.autoAnswer;
  fillSettings();
  checkKeys();
  // workspace.js loads after this file; wait until it has run.
  if (document.readyState === 'loading') await new Promise((r) => document.addEventListener('DOMContentLoaded', r));
  await refreshJobs();
  await initControls();
})();

// Offer a session when a call app starts using the microphone (Windows).
window.api.onMeetingDetected(({ app: name }) => {
  if (state.live) return;
  banner(`${name} is using your microphone. Start a live session?`, 'warn', {
    label: 'Start session',
    onClick: () => {
      document.querySelector('.tab[data-tab="live"]').click();
      startLive();
    },
  });
});
