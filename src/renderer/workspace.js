/* global $, state, escapeHtml, banner, flash, loadHistory, Coach, CoreCareer, CoreBank, CorePrompts, runTask, renderMarkdown, marked, DOMPurify, ensureMockSession, factNote, CoreFit, CoreRedFlags, CoreEligibility */
// Job workspaces, the Interview Brain editor and the Progress view.
// Loaded after app.js and uses its helpers.

const STAGE_LABELS = {
  saved: 'Saved',
  applied: 'Applied',
  screening: 'Screening',
  interviewing: 'Interviewing',
  offer: 'Offer',
  rejected: 'Rejected',
  closed: 'Closed',
};
const FACT_CATEGORIES = ['experience', 'project', 'achievement', 'skill', 'education', 'story', 'other'];

const work = { jobs: [], editing: null, facts: [], factsDirty: false };

function jobLabel(id) {
  const j = work.jobs.find((x) => x.id === id);
  if (!j) return '';
  return [j.company, j.role].filter(Boolean).join(' — ') || 'Untitled job';
}

function followUpLabel(ms) {
  if (!ms) return '';
  const days = Math.round((new Date(ms).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
  if (days < 0) return `Follow-up overdue (${-days} day${days === -1 ? '' : 's'})`;
  if (days === 0) return 'Follow up today';
  return `Follow up in ${days} day${days === 1 ? '' : 's'}`;
}

function whenLabel(ms) {
  if (!ms) return '';
  const days = Math.round((new Date(ms).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
  if (days === 0) return 'Interview today';
  if (days === 1) return 'Interview tomorrow';
  if (days > 1) return `Interview in ${days} days`;
  return `Interview was ${-days} day${days === -1 ? '' : 's'} ago`;
}

// ---------- job picker (shown under the tabs) ----------

function fillJobSelect(select, { allLabel, value }) {
  select.innerHTML =
    `<option value="">${allLabel}</option>` +
    work.jobs.map((j) => `<option value="${escapeHtml(j.id)}">${escapeHtml(jobLabel(j.id))}</option>`).join('');
  select.value = work.jobs.some((j) => j.id === value) ? value : '';
}

async function refreshJobs() {
  work.jobs = await window.api.listJobs();
  fillJobSelect($('#activeJob'), { allLabel: work.jobs.length ? 'No job selected' : 'No jobs yet: add one in Jobs', value: state.config.activeJobId });
  fillJobSelect($('#progressJob'), { allLabel: 'All jobs', value: $('#progressJob').value });
}

$('#activeJob').onchange = async (e) => {
  state.config = await window.api.setActiveJob(e.target.value || null);
  if ($('#tab-jobs').classList.contains('active')) loadJobs();
};

// ---------- Jobs tab ----------

async function loadJobs() {
  await refreshJobs();
  if (!work.factsDirty) work.facts = await window.api.listFacts(); // for the job check
  loadMatches();
  const records = await window.api.analytics();
  const sessions = await window.api.listSessions();
  const list = $('#jobList');
  $('#jobForm').hidden = true;
  $('#careerTools').hidden = true;
  list.hidden = false;
  if (!work.jobs.length) {
    list.innerHTML = '<li class="muted empty-job">No jobs yet. Add the role you are preparing for: its description and notes go into every answer and practice question.</li>';
    return;
  }
  const order = (j) => (j.id === state.config.activeJobId ? 0 : ['rejected', 'closed'].includes(j.stage) ? 2 : 1);
  const jobs = [...work.jobs].sort((a, b) => order(a) - order(b) || (a.interviewAt || Infinity) - (b.interviewAt || Infinity));
  list.innerHTML = '';
  for (const j of jobs) {
    const stats = Coach.aggregate(records.filter((r) => r.jobId === j.id));
    const count = sessions.filter((s) => s.jobId === j.id).length;
    const active = j.id === state.config.activeJobId;
    const li = document.createElement('li');
    li.className = active ? 'active' : '';
    li.innerHTML = `
      <div class="job-main">
        <div class="job-title">${escapeHtml(jobLabel(j.id))}</div>
        <div class="meta">${[whenLabel(j.interviewAt), followUpLabel(j.followUpAt), j.applyBy && j.applyBy > Date.now() - 86400000 ? `Apply by ${new Date(j.applyBy).toLocaleDateString()}` : '', `${count} session${count === 1 ? '' : 's'}`, stats.avgScore != null ? `avg score ${Coach.fmt(stats.avgScore)}` : '']
          .filter(Boolean)
          .map(escapeHtml)
          .join(' · ')}</div>
      </div>
      ${checkChips(j)}
      <span class="chip stage-${j.stage}">${STAGE_LABELS[j.stage] || j.stage}</span>
      ${active ? '<span class="chip on">Active</span>' : '<button class="btn small" data-act="use">Use</button>'}`;
    li.onclick = (e) => {
      if (e.target.dataset.act === 'use') {
        e.stopPropagation();
        window.api.setActiveJob(j.id).then((c) => {
          state.config = c;
          loadJobs();
        });
        return;
      }
      editJob(j);
    };
    list.append(li);
  }
}

function toLocalInput(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function editJob(job) {
  work.editing = job || null;
  $('#jobList').hidden = true;
  $('#jobForm').hidden = false;
  $('#jobCompany').value = job?.company || '';
  $('#jobRole').value = job?.role || '';
  $('#jobStage').value = job?.stage || 'saved';
  $('#jobDate').value = toLocalInput(job?.interviewAt);
  $('#jobDescription').value = job?.jobDescription || '';
  $('#jobNotes').value = job?.notes || '';
  $('#jobApplyBy').value = job?.applyBy ? toLocalInput(job.applyBy).slice(0, 10) : '';
  $('#jobFollowUp').value = toLocalInput(job?.followUpAt);
  $('#jobFollowUpNote').value = job?.followUpNote || '';
  $('#jobContacts').value = job?.contacts || '';
  $('#jobUrl').value = job?.url || '';
  $('#jobInterviewLink').value = job?.interviewLink || '';
  $('#joinMeeting').hidden = !job?.interviewLink;
  $('#openPosting').hidden = !job?.url;
  $('#deleteJob').hidden = !job;
  showSent(job);
  renderJobCheck();
  showCareer(job);
  $('#jobCompany').focus();
}

$('#newJob').onclick = () => editJob(null);
$('#cancelJob').onclick = () => loadJobs();

// ---------- Job check: fit score, scam warnings, eligibility ----------
// Rules ported from Autonomous Job Kit (packages/core/fit.js, redflags.js,
// eligibility.js). Worked out here from the job text, your résumé and facts,
// and Profile → Your job search; nothing is sent anywhere.

const descLine = (desc, label) => new RegExp(`^${label}:\\s*(.+)$`, 'im').exec(desc || '')?.[1]?.trim() || '';

function candidateText(job) {
  return [state.config.resume, job?.application?.resumeText, ...(work.facts || []).map((f) => f.text)].filter(Boolean).join('\n');
}

// { fit, flags, eligibility } for a job (or the job form's current values).
function jobCheck(job) {
  const description = job.jobDescription || '';
  if (!description.trim() && !job.role) return null;
  const posting = {
    role: job.role || '',
    company: job.company || '',
    url: job.url || '',
    description: [description, descLine(description, 'Pay') && `Pay: ${descLine(description, 'Pay')}`].filter(Boolean).join('\n'),
    location: descLine(description, 'Location'),
    posted: descLine(description, 'Posted'),
  };
  const search = state.config.jobSearch || {};
  const fit = CoreFit.score(posting, candidateText(job), search, { redFlags: CoreRedFlags.redFlags });
  // "Very short, vague description" is kept out of the scam warnings: here a
  // short description is usually a snippet the user pasted, not a scam sign.
  const all = CoreRedFlags.redFlags(description, { company: posting.company, role: posting.role });
  const isShort = (flag) => /very short, vague description/i.test(flag);
  const scams = all.filter((s) => !isShort(s.flag));
  const notes = all.filter((s) => isShort(s.flag)).map((s) => `${s.flag} (${s.quote}): paste the full posting for a better check`);
  const situation = state.config.workSituation || null;
  const eligibility = CoreEligibility.screen(description, situation, { role: posting.role, location: posting.location });
  return { fit, scams, notes, eligibility, hasSearch: Boolean(state.config.jobSearch), hasSituation: Boolean(situation) };
}

function checkChips(job) {
  let c;
  try {
    c = jobCheck(job);
  } catch {
    return '';
  }
  if (!c) return '';
  const chips = [`<span class="chip" title="${escapeHtml(c.fit.why)}">Fit ${c.fit.score}</span>`];
  if (c.scams.length) chips.push('<span class="chip warn" title="Possible scam warning signs: open the job to see why">Scam warning</span>');
  if (c.eligibility.screen === 'skip') chips.push('<span class="chip warn" title="A sentence in the posting may rule you out: open the job to see it">May rule you out</span>');
  return chips.join('');
}

function renderJobCheck() {
  const box = $('#jobCheck');
  const job = { role: $('#jobRole').value, company: $('#jobCompany').value, url: $('#jobUrl').value, jobDescription: $('#jobDescription').value, application: work.editing?.application };
  let c = null;
  try {
    c = jobCheck(job);
  } catch (err) {
    console.warn('Job check failed:', err.message);
  }
  box.hidden = !c;
  if (!c) return;
  const { fit, scams, eligibility } = c;
  const P = fit.parts;
  const part = (label, v, max) => `<div class="fit-part">${label} <b>${v}</b>/${max}</div>`;
  const list = (items) => (items.length ? `<ul>${items.join('')}</ul>` : '');
  const otherFlags = [...fit.flags.filter((f) => !/^scam warning:/i.test(f)), ...c.notes];
  const eligItems = [
    ...eligibility.why.map((w) => {
      const [sentence, rule] = w.split(' -> ');
      return `<li>${escapeHtml(rule || w)}<span class="quote">“${escapeHtml(sentence)}”</span></li>`;
    }),
    ...eligibility.check.map((s) => `<li>Check this sentence<span class="quote">“${escapeHtml(s)}”</span></li>`),
  ];
  const eligTitle = { skip: 'May rule you out', check: 'Worth checking', ok: 'No eligibility issues found' }[eligibility.screen];
  box.innerHTML = `
    <div class="label"><span>Job check</span></div>
    <div class="check-head"><span class="fit-score">${fit.score}<small class="muted">/100</small></span><span class="muted">${escapeHtml(fit.why)}</span></div>
    <div class="fit-parts">${part('Title', P.title, 30)}${part('Skills', P.skills, 30)}${part('Location', P.location, 12)}${part('Experience', P.experience, 20)}${part('Recency', P.recency, 8)}</div>
    ${c.hasSearch ? '' : '<p class="hint">Add your target roles and area in Profile → Your job search to score the title and location properly.</p>'}
    ${fit.gaps.length ? `<div class="label">Skills the posting asks for that aren't in your résumé</div><p>${fit.gaps.map(escapeHtml).join(', ')}. Never add them to your résumé; prepare an honest answer instead.</p>` : ''}
    ${scams.length ? `<div class="label">Possible scam warning signs</div>${list(scams.map((s) => `<li>${escapeHtml(s.flag)}<span class="quote">“${escapeHtml(s.quote)}”</span></li>`))}<p class="hint">A reason to look closer, not proof of fraud.</p>` : ''}
    ${otherFlags.length ? `<div class="label">Worth a look before applying</div>${list(otherFlags.map((f) => `<li>${escapeHtml(f)}</li>`))}` : ''}
    <div class="label">Eligibility: ${escapeHtml(eligTitle)}</div>
    ${list(eligItems)}
    ${c.hasSituation ? '' : '<p class="hint">Add your work authorization in Profile → Your job search, so restrictive sentences can be judged for you (until then they show as "check").</p>'}
    <p class="hint">Rules from Autonomous Job Kit, worked out on this PC. They're checks, not decisions or immigration advice: confirm on the official site.</p>`;
}

let jobCheckTimer = null;
for (const id of ['#jobRole', '#jobCompany', '#jobDescription']) {
  $(id).addEventListener('input', () => {
    clearTimeout(jobCheckTimer);
    jobCheckTimer = setTimeout(renderJobCheck, 400);
  });
}

// Profile → Your job search (config.jobSearch: the kit's search.json shape;
// config.workSituation: the kit's profile.json work-authorization fields).
function loadSearchForm() {
  const s = state.config.jobSearch || {};
  const w = state.config.workSituation || {};
  $('#searchCountry').value = ['Canada', 'United States', 'United Kingdom'].find((c) => CoreFit.countryCode(c) === CoreFit.countryCode(s.country || '') && s.country) || '';
  $('#searchRegion').value = s.province || s.state || s.region || '';
  $('#searchPlaces').value = (s.local_places || []).join(', ');
  $('#searchTracks').value = Object.values(s.tracks || {}).map((t) => (t.titles || []).join(', ')).join('\n');
  $('#searchSkills').value = (s.extra_skills || []).join(', ');
  $('#sitDetails').value = w.workAuthDetails || '';
  $('#sitAuthorized').value = ['yes', 'no'].includes(w.workAuthorized) ? w.workAuthorized : '';
  $('#sitSponsor').value = ['yes', 'no'].includes(w.needsSponsorship) ? w.needsSponsorship : '';
  $('#sitDegree').value = w.education?.[0]?.degree || '';
  $('#sitStanding').value = w.classStanding || '';
  $('#sitGraduation').value = w.expectedGraduation || '';
}

$('#saveSearch').onclick = async () => {
  const old = state.config.jobSearch || {};
  const country = $('#searchCountry').value;
  const code = CoreFit.countryCode(country);
  const region = $('#searchRegion').value.trim();
  const csv = (v) => v.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const oldTracks = Object.entries(old.tracks || {});
  const tracks = {};
  $('#searchTracks').value.split('\n').map(csv).filter((t) => t.length).forEach((titles, i) => {
    const [name, prev] = oldTracks[i] || [`roles ${i + 1}`, null];
    tracks[name] = { priority: prev?.priority ?? Math.max(0.4, 1 - i * 0.2), titles };
  });
  const search = { ...old, country, local_places: csv($('#searchPlaces').value), tracks, extra_skills: csv($('#searchSkills').value) };
  delete search.province;
  delete search.state;
  delete search.region;
  if (region) search[code === 'US' ? 'state' : code === 'GB' ? 'region' : 'province'] = region;
  const w = { ...(state.config.workSituation || {}) };
  const set = (k, v) => (v ? (w[k] = v) : delete w[k]);
  set('authCountry', country);
  set('workAuthDetails', $('#sitDetails').value.trim());
  set('workAuthorized', $('#sitAuthorized').value);
  set('needsSponsorship', $('#sitSponsor').value);
  set('classStanding', $('#sitStanding').value.trim());
  set('expectedGraduation', $('#sitGraduation').value.trim());
  const degree = $('#sitDegree').value.trim();
  if (degree) w.education = [{ ...(w.education?.[0] || {}), degree }, ...(w.education || []).slice(1)];
  else if (w.education?.[0]) w.education = [{ ...w.education[0], degree: '' }, ...w.education.slice(1)];
  state.config = await window.api.saveConfig({ jobSearch: search, workSituation: Object.keys(w).length ? w : null });
  flash($('#saveSearch'), 'Saved ✓');
};

// The job description text built from a posting read from its link.
function postingDescription(p) {
  const head = [p.location && `Location: ${p.location}`, p.pay && `Pay: ${p.pay}`, p.posted && `Posted: ${p.posted}`, p.deadline && `Apply by: ${p.deadline}`].filter(Boolean).join('\n');
  const questions = (p.questions || []).filter((q) => q.label && !/^(resume|cv|cover letter)\b/i.test(q.label)).map((q) => `- ${q.required ? '[required] ' : ''}${q.label}`);
  return [head, p.description, questions.length ? `Application questions:\n${questions.join('\n')}` : ''].filter(Boolean).join('\n\n');
}

// Fill from link: company, role, description, deadline. Empty fields are
// filled; a description you already typed is only replaced if you agree.
$('#fillFromLink').onclick = async () => {
  const url = $('#jobUrl').value.trim();
  if (!url) return banner('Paste the posting link first.', 'warn');
  const btn = $('#fillFromLink');
  btn.disabled = true;
  btn.textContent = 'Reading…';
  try {
    const r = await window.api.readPosting(url);
    if (r.error) return banner(r.error, r.code === 'blocked' || r.code === 'unsupported' ? 'warn' : 'error');
    const p = r.posting;
    if (!$('#jobCompany').value.trim() && p.company) $('#jobCompany').value = p.company;
    if (!$('#jobRole').value.trim() && p.role) $('#jobRole').value = p.role;
    const desc = postingDescription(p);
    if (desc && (!$('#jobDescription').value.trim() || confirm('Replace the job description you have with the one from the posting?'))) $('#jobDescription').value = desc;
    if (!$('#jobApplyBy').value && /^\d{4}-\d{2}-\d{2}$/.test(p.deadline || '')) $('#jobApplyBy').value = p.deadline;
    if (p.url && /^https:/.test(p.url)) $('#jobUrl').value = p.url;
    renderJobCheck();
    banner(`Read the ${p.system && p.system !== 'other' ? `${p.system[0].toUpperCase()}${p.system.slice(1)} ` : ''}posting${p.company ? ` from ${p.company}` : ''}. Check the details, then Save job.`, 'ok');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Fill from link';
  }
};

$('#jobForm').onsubmit = async (e) => {
  e.preventDefault();
  const date = $('#jobDate').value;
  const saved = await window.api.saveJob({
    id: work.editing?.id,
    company: $('#jobCompany').value,
    role: $('#jobRole').value,
    stage: $('#jobStage').value,
    interviewAt: date ? new Date(date).getTime() : null,
    jobDescription: $('#jobDescription').value,
    notes: $('#jobNotes').value,
    contacts: $('#jobContacts').value,
    url: $('#jobUrl').value,
    interviewLink: $('#jobInterviewLink').value,
    applyBy: $('#jobApplyBy').value ? new Date(`${$('#jobApplyBy').value}T23:59`).getTime() : null,
    followUpAt: $('#jobFollowUp').value ? new Date($('#jobFollowUp').value).getTime() : null,
    followUpNote: $('#jobFollowUpNote').value,
  });
  window.api.checkReminders();
  // A first job becomes the active one so it is used right away.
  if (!state.config.activeJobId) state.config = await window.api.setActiveJob(saved.id);
  loadJobs();
};

$('#deleteJob').onclick = async () => {
  const job = work.editing;
  if (!job) return;
  if (!confirm(`Delete “${jobLabel(job.id)}”? Its sessions stay in Progress.`)) return;
  await window.api.deleteJob(job.id);
  state.config = await window.api.getConfig();
  loadJobs();
};

// ---------- Memory: lessons from past sessions ----------

const LESSON_KINDS = { delivery: 'Delivery', structure: 'Structure', content: 'Content', story: 'Story', company: 'Company' };

function scopeOptions(selected) {
  const jobsHtml = work.jobs.map((j) => `<option value="${escapeHtml(j.id)}"${j.id === selected ? ' selected' : ''}>Only ${escapeHtml(jobLabel(j.id))}</option>`).join('');
  return `<option value=""${selected ? '' : ' selected'}>All interviews</option>${jobsHtml}`;
}

// One suggested lesson: editable text, where it applies, Keep / Dismiss.
function suggestionItem(lesson, onDecided) {
  const li = document.createElement('li');
  li.className = 'lesson suggested';
  li.dataset.id = lesson.id;
  li.innerHTML = `
    <span class="kind">${escapeHtml(LESSON_KINDS[lesson.kind] || lesson.kind)}</span>
    <textarea rows="2" aria-label="Lesson"></textarea>
    ${lesson.why ? `<div class="why">${escapeHtml(lesson.why)}</div>` : ''}
    <div class="lesson-actions">
      <select aria-label="Applies to">${scopeOptions(lesson.jobId)}</select>
      <button class="btn small primary" data-act="keep" type="button">Keep</button>
      <button class="btn small" data-act="dismiss" type="button">Dismiss</button>
    </div>`;
  li.querySelector('textarea').value = lesson.text;
  const decide = async (status) => {
    const saved = await window.api.updateLesson(lesson.id, { status, text: li.querySelector('textarea').value, jobId: li.querySelector('select').value || null });
    li.classList.add('decided');
    li.innerHTML = `<span class="muted">${status === 'approved' ? `Kept: ${escapeHtml(saved.text)}` : 'Dismissed. It won’t be suggested again.'}</span>`;
    onDecided?.();
  };
  li.querySelector('[data-act="keep"]').onclick = () => decide('approved');
  li.querySelector('[data-act="dismiss"]').onclick = () => decide('dismissed');
  return li;
}

// After a session: ask for suggestions and show them in a card.
async function offerLessons(sessionId, container, jobId) {
  if (state.config.suggestLessons === false) return;
  if (!work.jobs.length) work.jobs = await window.api.listJobs();
  const card = document.createElement('article');
  card.className = 'card lessons-card';
  card.innerHTML = '<div class="label"><span>Lessons to remember</span></div><div class="muted body">Looking for lessons from this session…</div>';
  container.prepend(card);
  const { added, aiError } = await window.api.suggestLessons(sessionId);
  const body = card.querySelector('.body');
  if (!added.length) {
    if (aiError) body.textContent = `No lessons suggested (${aiError}).`;
    else card.remove();
    return;
  }
  body.className = 'body';
  body.innerHTML = `<p class="hint">Keep the ones that are right for you; kept lessons shape later answers and practice${jobId ? '. Choose whether each applies to all interviews or only this job' : ''}. You can change them in Profile → Memory.</p>`;
  const ul = document.createElement('ul');
  ul.className = 'lesson-list';
  for (const l of added) ul.append(suggestionItem(l));
  body.append(ul);
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (aiError) body.insertAdjacentHTML('beforeend', `<p class="hint">The AI part didn't run: ${escapeHtml(aiError)}</p>`);
}

async function loadLessons() {
  if (!work.jobs.length) work.jobs = await window.api.listJobs();
  const all = await window.api.listLessons();
  $('#useLessons').checked = state.config.useLessons !== false;
  $('#suggestLessons').checked = state.config.suggestLessons !== false;
  $('#newLessonScope').innerHTML = scopeOptions(null);
  const pending = all.filter((l) => l.status === 'suggested');
  const kept = all.filter((l) => l.status === 'approved').sort((a, b) => (b.decidedAt || 0) - (a.decidedAt || 0));
  const dismissed = all.filter((l) => l.status === 'dismissed').length;

  const box = $('#lessonPending');
  box.innerHTML = '';
  if (pending.length) {
    box.innerHTML = `<div class="label">Waiting for you (${pending.length})</div>`;
    const ul = document.createElement('ul');
    ul.className = 'lesson-list';
    for (const l of pending) ul.append(suggestionItem(l, () => setTimeout(loadLessons, 600)));
    box.append(ul);
  }

  const list = $('#lessonList');
  list.innerHTML = kept.length ? '' : '<li class="muted">No kept lessons yet. Finish a practice session or an interview, or add one above.</li>';
  for (const l of kept) {
    const li = document.createElement('li');
    li.className = 'lesson';
    li.dataset.id = l.id;
    li.innerHTML = `
      <span class="kind">${escapeHtml(LESSON_KINDS[l.kind] || l.kind)}</span>
      <textarea rows="2" aria-label="Lesson"></textarea>
      <div class="lesson-actions">
        <select aria-label="Applies to">${scopeOptions(l.jobId)}</select>
        <button class="icon-btn" title="Forget this lesson" aria-label="Forget this lesson" type="button">✕</button>
      </div>`;
    const ta = li.querySelector('textarea');
    ta.value = l.text;
    ta.onchange = () => window.api.updateLesson(l.id, { text: ta.value });
    li.querySelector('select').onchange = (e) => window.api.updateLesson(l.id, { jobId: e.target.value || null });
    li.querySelector('button').onclick = async () => {
      await window.api.forgetLesson(l.id);
      loadLessons();
    };
    list.append(li);
  }
  const note = $('#lessonDismissed');
  note.innerHTML = dismissed ? `${dismissed} dismissed or forgotten lesson${dismissed === 1 ? '' : 's'} won’t be suggested again. <button class="btn small" id="clearDismissed" type="button">Clear this list</button>` : '';
  if (dismissed) {
    $('#clearDismissed').onclick = async () => {
      await window.api.clearDismissedLessons();
      loadLessons();
    };
  }
}

$('#useLessons').onchange = async (e) => (state.config = await window.api.saveConfig({ useLessons: e.target.checked }));
$('#suggestLessons').onchange = async (e) => (state.config = await window.api.saveConfig({ suggestLessons: e.target.checked }));
$('#addLessonForm').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('#newLesson').value.trim();
  if (!text) return;
  await window.api.addLesson({ text, kind: 'content', jobId: $('#newLessonScope').value || null });
  $('#newLesson').value = '';
  loadLessons();
};

// ---------- Interview Brain (Profile tab) ----------

async function loadFacts() {
  if (work.factsDirty) return; // keep unsaved edits when switching tabs
  work.facts = await window.api.listFacts();
  renderFacts();
}

function renderFacts() {
  const list = $('#factList');
  if (!work.facts.length) {
    list.innerHTML = '<li class="muted">No facts yet. Import your resume above, then press “Extract from resume & documents”.</li>';
    return;
  }
  list.innerHTML = '';
  work.facts.forEach((f, i) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <select aria-label="Category">${FACT_CATEGORIES.map((c) => `<option value="${c}"${c === f.category ? ' selected' : ''}>${c}</option>`).join('')}</select>
      <textarea rows="2" aria-label="Fact"></textarea>
      <button class="icon-btn" title="Remove fact" aria-label="Remove fact">✕</button>`;
    const textarea = li.querySelector('textarea');
    textarea.value = f.text;
    if (f.source) textarea.title = `From: ${f.source}`;
    li.querySelector('select').onchange = (e) => {
      work.facts[i].category = e.target.value;
      work.factsDirty = true;
    };
    textarea.oninput = (e) => {
      work.facts[i].text = e.target.value;
      work.factsDirty = true;
    };
    li.querySelector('button').onclick = () => {
      work.facts.splice(i, 1);
      work.factsDirty = true;
      renderFacts();
    };
    list.append(li);
  });
}

$('#addFact').onclick = () => {
  work.facts.unshift({ category: 'achievement', text: '', source: 'added by me' });
  work.factsDirty = true;
  renderFacts();
  $('#factList textarea')?.focus();
};

$('#saveFacts').onclick = async () => {
  work.facts = await window.api.saveFacts(work.facts);
  work.factsDirty = false;
  renderFacts();
  flash($('#saveFacts'), 'Saved ✓');
};

$('#extractFacts').onclick = async () => {
  const btn = $('#extractFacts');
  btn.disabled = true;
  btn.textContent = 'Reading your resume…';
  try {
    if (work.factsDirty) {
      work.facts = await window.api.saveFacts(work.facts);
      work.factsDirty = false;
    }
    // Extraction reads the saved resume, so save what is in the box first.
    state.config = await window.api.saveConfig({ resume: $('#resume').value.trim(), extraNotes: $('#extraNotes').value.trim() });
    const { added, found } = await window.api.extractFacts();
    const note = found ? `Found ${found} facts, ${added} new. Check them and fix anything that is wrong.` : 'No facts found in your resume or documents.';
    banner(note);
    setTimeout(() => $('#banner').textContent === note && banner(''), 8000);
    await loadFacts();
  } catch (err) {
    banner(`Extracting facts failed: ${err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Extract from resume & documents';
  }
};

// ---------- Progress tab ----------

async function loadProgress() {
  await refreshJobs();
  const filter = $('#progressJob').value;
  const records = (await window.api.analytics()).filter((r) => !filter || r.jobId === filter);
  const a = Coach.aggregate(records);
  const box = $('#progress');
  if (!records.length) {
    box.innerHTML = '<p class="hint">Practice in Mock and press “Get feedback” to start tracking scores. Live sessions add your speaking pace and filler words.</p>';
    await renderCodingCard();
    await renderGrowthCards(a);
    loadHistory();
    return;
  }
  const trend =
    a.trend == null ? '' : `<small class="${a.trend >= 0 ? 'up' : 'down'}">${a.trend >= 0 ? '▲' : '▼'} ${Coach.fmt(Math.abs(a.trend))} vs previous 5</small>`;
  const scenarioRows = a.byScenario
    .map((s) => `<div class="bar-row"><span class="bar-label">${escapeHtml(s.label)} <small>×${s.count}</small></span><span class="bar"><span style="width:${s.avg == null ? 0 : Math.round(s.avg * 10)}%"></span></span><span class="bar-value">${Coach.fmt(s.avg)}</span></div>`)
    .join('');
  box.innerHTML = `
    <div class="tiles">
      <div class="tile"><span class="tile-label">Practice answers</span><b>${a.practiceCount}</b><small>${a.liveCount} live session${a.liveCount === 1 ? '' : 's'}</small></div>
      <div class="tile"><span class="tile-label">Average score</span><b>${Coach.fmt(a.avgScore)}</b>${trend || '<small>out of 10</small>'}</div>
      <div class="tile"><span class="tile-label">Speaking pace</span><b>${a.avgWpm ?? '–'}</b><small>words/min (aim 130–160)</small></div>
      <div class="tile"><span class="tile-label">Filler words</span><b>${a.fillersPer100 == null ? '–' : Coach.fmt(a.fillersPer100)}</b><small>per 100 words</small></div>
    </div>
    <div class="card"><div class="label">Score trend</div>${Coach.sparkline(a.series)}</div>
    <div class="card"><div class="label"><span>Skills</span>${a.weakest ? `<span>Focus next: <b>${a.weakest.label}</b></span>` : ''}</div>
      ${Coach.DIMENSIONS.some(([k]) => a.dims[k] != null) ? Coach.DIMENSIONS.map(([k, l]) => Coach.bar(l, a.dims[k])).join('') : '<p class="hint">Per-skill scores appear after your next graded answer.</p>'}
    </div>
    <div class="card"><div class="label">By practice type</div>${scenarioRows || '<p class="hint">No practice yet.</p>'}</div>`;
  await renderCodingCard();
  await renderGrowthCards(a);
  loadHistory();
}

// Coding Lab card (shown even before any interview practice).
async function renderCodingCard() {
  const [attempts, challenges] = await Promise.all([window.api.labAttempts(), window.api.labChallenges()]);
  document.querySelector('#codingCard')?.remove();
  if (!attempts.length) return;
  const c = Coach.aggregateCoding(attempts, challenges);
  const card = document.createElement('div');
  card.className = 'card';
  card.id = 'codingCard';
  const diff = ['easy', 'medium', 'hard']
    .filter((d) => c.byDifficulty[d])
    .map((d) => {
      const { solved, total } = c.byDifficulty[d];
      const pct = Math.round((solved / total) * 100);
      return `<div class="bar-row"><span class="bar-label">${d[0].toUpperCase()}${d.slice(1)}</span><span class="bar"><span style="width:${pct}%"></span></span><span class="bar-value">${solved}/${total}</span></div>`;
    });
  card.innerHTML = `<div class="label"><span>Coding Lab</span><span>${c.solved}/${c.total} solved</span></div>
    <div class="stats coding-stats"><span><b>${c.submissions}</b> submissions</span><span><b>${c.passRate == null ? '–' : Math.round(c.passRate * 100) + '%'}</b> all tests passed</span><span><b>${c.firstTries}</b> solved first try</span>${c.hintsPerSolve == null ? '' : `<span><b>${Coach.fmt(c.hintsPerSolve)}</b> hints per solve</span>`}</div>
    ${diff.join('')}`;
  $('#progress').append(card);
}

$('#progressJob').onchange = () => loadProgress();

// ---------- Career tools (Jobs tab) ----------

const careerUi = { job: null, running: null };

function showCareer(job) {
  const box = $('#careerTools');
  box.hidden = !job?.id;
  careerUi.job = job || null;
  if (!job?.id) return;
  $('#careerOutput').hidden = true;
  const research = box.querySelector('[data-tool="research"]');
  research.title = state.config.provider === 'anthropic' ? 'Claude web search with cited sources, including pay ranges' : 'Needs Claude (Anthropic) as the AI provider: it uses Claude web search with cited sources';
  loadCareerList();
}

async function loadCareerList() {
  const list = $('#careerList');
  const items = await window.api.careerList(careerUi.job.id);
  if (!items.length) {
    list.innerHTML = '<li class="muted">Nothing saved yet.</li>';
    return;
  }
  list.innerHTML = '';
  for (const a of items) {
    const li = document.createElement('li');
    li.className = 'clickable';
    li.innerHTML = `<span class="name">${escapeHtml(a.title)}</span><span class="meta">${new Date(a.createdAt).toLocaleDateString()}</span>`;
    li.onclick = () => {
      renderArtifact(a);
      $('#careerOutput').scrollIntoView({ block: 'start' });
    };
    list.append(li);
  }
}

function pctBar(label, v) {
  return `<div class="bar-row"><span class="bar-label">${label}</span><span class="bar"><span style="width:${v ?? 0}%"></span></span><span class="bar-value">${v == null ? '–' : `${v}%`}</span></div>`;
}

function matchHtml(match, coverage) {
  if (!match) return '';
  return `<div class="scores"><div class="score-big"><span>${match.overall ?? '–'}</span><small>% match</small></div><div class="score-bars">
    ${pctBar('Skills', match.skills)}${pctBar('Experience', match.experience)}${pctBar('Impact', match.impact)}${coverage != null ? pctBar('Keywords', coverage) : ''}</div></div>`;
}

function keywordHtml(cov) {
  if (!cov?.terms?.length) return '';
  return `<div class="keywords"><div class="label">Job description keywords · ${cov.coverage}% in your resume</div>${cov.terms
    .map((t) => `<span class="kw ${t.inResume ? 'yes' : 'no'}" title="${t.inResume ? 'In your resume' : 'Missing from your resume'}">${escapeHtml(t.term)}</span>`)
    .join('')}</div>`;
}

function renderArtifact(a, coverage) {
  const box = $('#careerOutput');
  box.hidden = false;
  box.classList.remove('streaming');
  box.innerHTML = `<div class="label"><span>${escapeHtml(a.title)}</span><span class="actions">
      <button data-act="copy">Copy</button><button data-act="pdf">PDF</button><button data-act="docx">Word</button><button data-act="delete">Delete</button></span></div>
    ${matchHtml(a.match, a.coverage)}${keywordHtml(coverage)}<div class="md body"></div>
    <p class="hint">Saved ${new Date(a.createdAt).toLocaleString()}${a.sources?.length ? ` · ${a.sources.length} sources` : ''}</p>`;
  renderMarkdown(box.querySelector('.body'), a.content);
  if (['resume', 'cover', 'linkedin', 'followup'].includes(a.kind)) factNote(box, a.content, { place: 'after-body' });
  box.querySelector('[data-act="copy"]').onclick = () => {
    navigator.clipboard.writeText(a.content);
    flash(box.querySelector('[data-act="copy"]'), 'Copied');
  };
  for (const format of ['pdf', 'docx']) {
    box.querySelector(`[data-act="${format}"]`).onclick = async () => {
      try {
        const file = await window.api.careerExport({ id: a.id, format, html: DOMPurify.sanitize(marked.parse(a.content)) });
        if (file) banner(`Exported to ${file}`);
      } catch (err) {
        banner(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
      }
    };
  }
  box.querySelector('[data-act="delete"]').onclick = async () => {
    if (!confirm(`Delete “${a.title}”?`)) return;
    await window.api.careerDelete(a.id);
    box.hidden = true;
    loadCareerList();
  };
}

function runCareer(tool) {
  const job = careerUi.job;
  if (!job?.id || careerUi.running) return;
  const box = $('#careerOutput');
  box.hidden = false;
  box.classList.add('streaming');
  box.innerHTML = `<div class="label"><span>${escapeHtml(CoreCareer.TOOLS[tool].title)} · writing…</span><span class="actions"><button data-act="stop">Stop</button></span></div><div class="md body"><span class="muted">${tool === 'research' ? 'Searching the web…' : 'Thinking…'}</span></div>`;
  box.scrollIntoView({ block: 'start' }); // the result sits below the job form
  const body = box.querySelector('.body');
  const buttons = document.querySelectorAll('#careerTools [data-tool]');
  buttons.forEach((b) => (b.disabled = true));
  let text = '';
  let scheduled = false;
  const id = runTask(
    'careerRun',
    { tool, jobId: job.id },
    {
      onText: (t) => {
        text += t;
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          renderMarkdown(body, tool === 'check' ? CoreCareer.splitMatch(text).body : text);
        });
      },
      onDone: (res) => {
        careerUi.running = null;
        buttons.forEach((b) => (b.disabled = false));
        box.classList.remove('streaming');
        if (res.error || res.aborted) {
          box.innerHTML = `<p>${escapeHtml(res.error || 'Stopped.')}</p>`;
          return;
        }
        const out = JSON.parse(res.result || '{}');
        renderArtifact(out.artifact, out.coverage);
        if (out.searchErrors?.length) banner(`Some web searches failed (${[...new Set(out.searchErrors)].join(', ')}); the report uses the searches that worked.`);
        loadCareerList();
      },
    },
  );
  careerUi.running = id;
  box.querySelector('[data-act="stop"]').onclick = () => window.api.cancel(id);
}

document.querySelectorAll('#careerTools [data-tool]').forEach((b) => {
  b.onclick = () => runCareer(b.dataset.tool);
});

// Follow-up and deadline reminders from the main process.
$('#joinMeeting').onclick = (e) => {
  e.preventDefault();
  if (work.editing?.interviewLink) window.open(work.editing.interviewLink);
};

// ---------- Calendar invites ----------

const cal = { items: [] };

function eventWhen(e) {
  if (e.allDay) return `${new Date(e.start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} (all day)`;
  return new Date(e.start).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function showCalendarPlan(plan) {
  if (!plan) return;
  const box = $('#calendarReview');
  cal.items = plan.items;
  if (!plan.items.length) {
    box.hidden = true;
    banner(plan.errors[0] || (plan.total ? 'No upcoming or recent events in that file.' : 'No events found in that file.'), plan.errors.length ? 'error' : 'warn');
    return;
  }
  const hidden = plan.total - plan.items.length;
  $('#calendarHint').textContent = `Choose what to do with each event. Nothing changes until you press Import.${hidden > 0 ? ` ${hidden} older or extra event${hidden === 1 ? ' is' : 's are'} not shown.` : ''}${plan.errors.length ? ` Couldn't read: ${plan.errors.join('; ')}` : ''}`;
  const list = $('#calendarList');
  list.innerHTML = '';
  plan.items.forEach((item, i) => {
    const e = item.event;
    const li = document.createElement('li');
    li.dataset.i = i;
    const jobOpts = work.jobs.map((j) => `<option value="update:${escapeHtml(j.id)}"${item.action === 'update' && item.jobId === j.id ? ' selected' : ''}>Set as the interview for ${escapeHtml(jobLabel(j.id))}</option>`).join('');
    const clearOpt = item.jobId ? `<option value="clear:${escapeHtml(item.jobId)}"${item.action === 'clear' ? ' selected' : ''}>Remove this interview from ${escapeHtml(jobLabel(item.jobId))}</option>` : '';
    const who = e.organizer ? e.organizer.name || e.organizer.email : '';
    let host = '';
    try {
      host = e.link ? new URL(e.link).hostname.replace(/^www\./, '') : '';
    } catch {
      host = '';
    }
    li.innerHTML = `
      <div class="cal-title">${e.cancelled ? '<span class="chip">Cancelled</span> ' : ''}${escapeHtml(e.title)}</div>
      <div class="meta">${escapeHtml([eventWhen(e) + (e.approximateTime ? ' (check the time: its time zone was unclear)' : ''), who && `from ${who}`, host && `${host} link`, e.recurring ? 'repeats' : ''].filter(Boolean).join(' · '))}</div>
      <select aria-label="What to do with this event">
        ${e.cancelled ? clearOpt : jobOpts}
        ${e.cancelled ? '' : `<option value="new"${item.action === 'new' ? ' selected' : ''}>Add as a new job</option>`}
        <option value="skip"${item.action === 'skip' ? ' selected' : ''}>Skip</option>
      </select>
      <div class="cal-new grid-2" hidden>
        <label class="field"><span>Company</span><input type="text" data-f="company" autocomplete="off" /></label>
        <label class="field"><span>Role</span><input type="text" data-f="role" autocomplete="off" /></label>
      </div>`;
    li.querySelector('[data-f="company"]').value = item.guess.company;
    li.querySelector('[data-f="role"]').value = item.guess.role;
    const sel = li.querySelector('select');
    const sync = () => (li.querySelector('.cal-new').hidden = sel.value !== 'new');
    sel.onchange = sync;
    sync();
    list.append(li);
  });
  box.hidden = false;
  box.scrollIntoView({ block: 'nearest' });
}

async function importInvites(plan) {
  document.querySelector('.tab[data-tab="jobs"]').click();
  if (!work.jobs.length) await refreshJobs();
  showCalendarPlan(plan);
}

$('#importInvite').onclick = async () => importInvites(await window.api.calendarPick());
$('#calendarCancel').onclick = () => ($('#calendarReview').hidden = true);
$('#calendarApply').onclick = async () => {
  const choices = [...$('#calendarList').children].map((li) => {
    const item = cal.items[Number(li.dataset.i)];
    const [action, jobId] = li.querySelector('select').value.split(':');
    return { event: item.event, action, jobId: jobId || null, company: li.querySelector('[data-f="company"]').value, role: li.querySelector('[data-f="role"]').value };
  });
  const r = await window.api.calendarApply(choices.filter((c) => c.action !== 'skip'));
  $('#calendarReview').hidden = true;
  const parts = [r.updated && `updated ${r.updated} job${r.updated === 1 ? '' : 's'}`, r.created && `added ${r.created} new job${r.created === 1 ? '' : 's'}`, r.cleared && `removed ${r.cleared} cancelled interview${r.cleared === 1 ? '' : 's'}`].filter(Boolean);
  banner(parts.length ? `Calendar import: ${parts.join(', ')}.` : 'Nothing imported.', parts.length ? 'ok' : 'warn');
  state.config = await window.api.getConfig();
  loadJobs();
};

// Drop .ics files anywhere on the Jobs tab.
const jobsTab = $('#tab-jobs');
jobsTab.addEventListener('dragover', (e) => {
  if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) {
    e.preventDefault();
    jobsTab.classList.add('dropping');
  }
});
jobsTab.addEventListener('dragleave', () => jobsTab.classList.remove('dropping'));
jobsTab.addEventListener('drop', async (e) => {
  e.preventDefault();
  jobsTab.classList.remove('dropping');
  const files = [...(e.dataTransfer?.files || [])].filter((f) => /\.(ics|ical|ifb)$/i.test(f.name) || f.type === 'text/calendar');
  if (!files.length) return banner('Drop a calendar invite (.ics file).', 'warn');
  const texts = await Promise.all(files.slice(0, 10).map((f) => (f.size > 5 * 1024 * 1024 ? '' : f.text())));
  importInvites(await window.api.calendarParseText(texts.filter(Boolean).join('\n')));
});

// ---------- New job matches (job discovery) ----------

function renderMatches(st) {
  if (!st) return;
  const list = $('#matchList');
  const fresh = st.matches.filter((m) => m.fresh).length;
  $('#matchesSummary').textContent = st.running
    ? 'searching…'
    : st.lastRun
      ? `${st.matches.length} match${st.matches.length === 1 ? '' : 'es'}${fresh ? `, ${fresh} new` : ''} · last searched ${new Date(st.lastRun).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
      : 'not searched yet';
  $('#discoverDaily').checked = Boolean(state.config.discoverDaily);
  $('#remotiveCredit').hidden = !st.remotive;
  list.innerHTML = '';
  if (st.lastRun && !st.matches.length) list.innerHTML = '<li class="muted">No matches right now. Try more target roles in Profile → Your job search, or follow an employer below.</li>';
  for (const m of st.matches) {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="cal-title">${m.fresh ? '<span class="chip on">New</span> ' : ''}${escapeHtml([m.title, m.company].filter(Boolean).join(' — '))}</div>
      <div class="meta">${escapeHtml([`Fit ${m.score}`, m.location, m.posted && `posted ${m.posted}`, m.source, m.why].filter(Boolean).join(' · '))}</div>
      ${m.flags?.length ? `<div class="meta">⚠ ${escapeHtml(m.flags.slice(0, 2).join(' · ').slice(0, 300))}</div>` : ''}
      <div class="match-actions">
        <button class="btn small primary" data-act="add" type="button">Add to Jobs</button>
        <button class="btn small" data-act="open" type="button">Open posting</button>
        <button class="btn small ghost" data-act="dismiss" type="button">Dismiss</button>
      </div>`;
    li.querySelector('[data-act="open"]').onclick = () => m.url && window.open(m.url);
    li.querySelector('[data-act="dismiss"]').onclick = async () => renderMatches(await window.api.discoverDismiss(m.key));
    li.querySelector('[data-act="add"]').onclick = async () => {
      const r = await window.api.discoverAdd(m.key);
      if (!r) return;
      banner(`Added ${[m.title, m.company].filter(Boolean).join(' at ')} to Jobs.`, 'ok');
      state.config = await window.api.getConfig();
      await loadJobs();
      renderMatches(r.status);
    };
    list.append(li);
  }
  if (st.errors?.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = `Some sources didn't answer: ${st.errors.slice(0, 4).map((e) => `${e.source} (${e.message})`).join('; ')}`.slice(0, 400);
    list.append(li);
  }
}

async function loadMatches() {
  renderMatches(await window.api.discoverStatus());
}

$('#discoverRun').onclick = async () => {
  const btn = $('#discoverRun');
  btn.disabled = true;
  btn.textContent = 'Searching…';
  $('#matchesBox').open = true;
  $('#matchesSummary').textContent = 'searching… (this can take a minute)';
  try {
    const st = await window.api.discoverRun();
    if (st.error) banner(st.error, 'warn');
    else banner(st.newCount ? `${st.newCount} new job match${st.newCount === 1 ? '' : 'es'}.` : 'No new matches since the last search.', st.newCount ? 'ok' : 'warn');
    renderMatches(st);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Find jobs now';
  }
};
$('#discoverDaily').onchange = async (e) => (state.config = await window.api.saveConfig({ discoverDaily: e.target.checked }));
$('#employerAdd').onclick = async () => {
  const url = $('#employerUrl').value.trim();
  if (!url) return;
  const r = await window.api.discoverAddEmployer(url);
  if (r.error) return banner(r.error, 'warn');
  $('#employerUrl').value = '';
  state.config = await window.api.getConfig();
  banner(r.added ? `Following ${r.name} (${r.system}). It's included the next time jobs are searched.` : `You already follow ${r.name}.`, 'ok');
};
$('#remotiveLink').onclick = (e) => {
  e.preventDefault();
  window.open('https://remotive.com');
};
window.api.onDiscoverDone(({ newCount, background }) => {
  if ($('#tab-jobs').classList.contains('active')) loadMatches();
  if (background && newCount) banner(`${newCount} new job match${newCount === 1 ? '' : 'es'} today. See Jobs → New job matches.`, 'ok');
});
window.api.onDiscoverOpen(() => {
  document.querySelector('.tab[data-tab="jobs"]').click();
  $('#matchesBox').open = true;
});

// ---------- Autonomous Job Kit ----------

const kit = { items: [], facts: [] };
const KIT_STAGE = { 'Ready to submit': 'saved', 'Needs you': 'saved', Submitted: 'applied', 'Online assessment': 'screening', Interviewing: 'interviewing', Offer: 'offer', Accepted: 'offer', Declined: 'closed', Withdrawn: 'closed', Rejected: 'rejected', Skipped: 'closed' };

function sentCounts(app) {
  if (!app) return '';
  const n = app.answers?.length || 0;
  return [app.resumeText && 'résumé', app.letterText && 'cover letter', n && `${n} written answer${n === 1 ? '' : 's'}`, app.fields?.length && `${app.fields.length} form field${app.fields.length === 1 ? '' : 's'}`, app.gaps?.length && `${app.gaps.length} gap${app.gaps.length === 1 ? '' : 's'}`].filter(Boolean).join(', ');
}

function showJobKitPlan(plan) {
  if (!plan) return;
  const box = $('#jobkitReview');
  kit.items = plan.items;
  kit.facts = plan.facts || [];
  if (!plan.items.length && !kit.facts.length) {
    box.hidden = true;
    banner(plan.errors[0] || 'No applications found in that folder.', plan.errors.length ? 'error' : 'warn');
    return;
  }
  const where = `Folder: ${plan.folder}${plan.hasTracker ? '' : ' (no tracker.xlsx: read from the Applications folder)'}.`;
  $('#jobkitHint').textContent = `${where} Choose what to do with each application. Nothing changes until you press Import, and nothing in the folder is changed.${plan.errors.length ? ` Couldn't read: ${plan.errors.join('; ')}` : ''}`;
  const list = $('#jobkitList');
  list.innerHTML = '';
  plan.items.forEach((item, i) => {
    const a = item.app;
    const li = document.createElement('li');
    li.dataset.i = i;
    const jobOpts = work.jobs.map((j) => `<option value="update:${escapeHtml(j.id)}"${item.action === 'update' && item.jobId === j.id ? ' selected' : ''}>Update ${escapeHtml(jobLabel(j.id))}</option>`).join('');
    const stage = KIT_STAGE[a.status] || (a.submitted ? 'applied' : 'saved');
    const when = a.interviewAt ? `interview ${new Date(a.interviewAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : a.interviewDay ? `interview ${a.interviewDay}` : '';
    const sent = sentCounts(a.application);
    li.innerHTML = `
      <div class="cal-title">${escapeHtml([a.company, a.role].filter(Boolean).join(' — ') || a.folder || 'Untitled')}</div>
      <div class="meta">${escapeHtml([a.status ? `${a.status} → ${STAGE_LABELS[stage]}` : '', when, sent ? `sent: ${sent}` : 'no files sent yet', item.reason].filter(Boolean).join(' · '))}</div>
      <select aria-label="What to do with this application">
        <option value="new"${item.action === 'new' ? ' selected' : ''}>Add as a new job</option>
        ${jobOpts}
        <option value="skip"${item.action === 'skip' ? ' selected' : ''}>Skip</option>
      </select>`;
    list.append(li);
  });
  const facts = $('#jobkitFacts');
  facts.innerHTML = '';
  kit.facts.forEach((f, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<label class="toggle"><input type="checkbox" data-fact="${i}"${f.suggested ? ' checked' : ''} /> <span></span></label>`;
    li.querySelector('span').textContent = f.text;
    facts.append(li);
  });
  $('#jobkitFactsBox').hidden = !kit.facts.length;
  const s = plan.settings;
  $('#jobkitSettingsRow').hidden = !s;
  if (s) {
    const what = [s.search && 'search.json (target roles, places, immigration route)', s.situation && 'your work-authorization answers'].filter(Boolean).join(' and ');
    $('#jobkitSettingsText').textContent = `Use ${what} for fit scores and eligibility checks. Worked out on this PC, never sent to the AI.${state.config.jobSearch || state.config.workSituation ? ' Replaces the ones saved now.' : ''}`;
    $('#jobkitSettings').checked = !(state.config.jobSearch || state.config.workSituation);
  }
  box.hidden = false;
  box.scrollIntoView({ block: 'nearest' });
}

async function importJobKit(choose = false) {
  document.querySelector('.tab[data-tab="jobs"]').click();
  if (!work.jobs.length) await refreshJobs();
  const plan = await window.api.jobKitPlan(choose);
  state.config = await window.api.getConfig();
  showJobKitPlan(plan);
}

$('#importJobKit').onclick = () => importJobKit(false);
$('#jobkitChange').onclick = () => importJobKit(true);
$('#jobkitCancel').onclick = () => ($('#jobkitReview').hidden = true);
$('#jobkitApply').onclick = async () => {
  const choices = [...$('#jobkitList').children].map((li) => {
    const item = kit.items[Number(li.dataset.i)];
    const [action, jobId] = li.querySelector('select').value.split(':');
    return { key: item.app.key, action, jobId: jobId || null };
  });
  const facts = [...$('#jobkitFacts').querySelectorAll('input:checked')].map((c) => Number(c.dataset.fact));
  const useSettings = !$('#jobkitSettingsRow').hidden && $('#jobkitSettings').checked;
  const r = await window.api.jobKitApply(choices.filter((c) => c.action !== 'skip'), facts, useSettings);
  $('#jobkitReview').hidden = true;
  const parts = [r.created && `added ${r.created} job${r.created === 1 ? '' : 's'}`, r.updated && `updated ${r.updated}`, r.facts && `${r.facts} fact${r.facts === 1 ? '' : 's'} added to Interview Brain`, r.settings && 'search settings and work authorization saved'].filter(Boolean);
  banner(parts.length ? `Job Kit import: ${parts.join(', ')}.` : 'Nothing imported.', parts.length ? 'ok' : 'warn');
  state.config = await window.api.getConfig();
  loadJobs();
  if (r.facts) loadFacts();
};

// "What you sent" in the job editor (read-only; refreshed by importing again).
function showSent(job) {
  const app = job?.application;
  const box = $('#sentBox');
  box.hidden = !app;
  if (!app) return;
  box.open = false;
  $('#sentSummary').textContent = sentCounts(app);
  const off = state.config.useSentApplication === false;
  $('#sentHint').textContent = `Imported from Autonomous Job Kit (${app.folder || 'job folder'}) on ${new Date(app.importedAt).toLocaleDateString()}. ${off ? 'Not used in answers: turned off in Settings → Autonomous Job Kit.' : 'Live answers, practice and prep for this job stay consistent with it.'} Import again to refresh it.`;
  const section = (title, body) => (body ? `<div class="label">${escapeHtml(title)}</div>${body}` : '');
  const pre = (t) => `<pre class="sent-text">${escapeHtml(t)}</pre>`;
  $('#sentBody').innerHTML = [
    section(`Résumé${app.resumeFile ? ` (${app.resumeFile})` : ''}`, app.resumeText && pre(app.resumeText)),
    section(`Cover letter${app.letterFile ? ` (${app.letterFile})` : ''}`, app.letterText && pre(app.letterText)),
    section('Form answers', [...(app.fields || []).map((f) => `<p><b>${escapeHtml(f.label)}</b>: ${escapeHtml(f.value)}</p>`), ...(app.answers || []).map((a) => `<p><b>${escapeHtml(a.question)}</b><br>${escapeHtml(a.answer)}</p>`)].join('')),
    section('Changed before submitting', (app.changesBeforeSubmitting || []).map((c) => `<p>${escapeHtml(c)}</p>`).join('')),
    section('Gaps left off the résumé', [...(app.gaps || []), app.keywordGaps && `Keywords: ${app.keywordGaps}`].filter(Boolean).map((g) => `<p>${escapeHtml(g)}</p>`).join('')),
  ].join('');
}

$('#sentRemove').onclick = async () => {
  const job = work.editing;
  if (!job || !confirm('Remove what you sent from this job? Answers will no longer use it. Your job-search folder is not changed, and importing again brings it back.')) return;
  const saved = await window.api.clearApplication(job.id);
  work.editing = saved;
  showSent(saved);
  refreshJobs();
};

// Opens the posting in the browser (main only opens http/https links).
$('#openPosting').onclick = (e) => {
  e.preventDefault();
  if (work.editing?.url) window.open(work.editing.url);
};

async function openJob(jobId) {
  document.querySelector('.tab[data-tab="jobs"]').click();
  await loadJobs();
  const job = work.jobs.find((j) => j.id === jobId);
  if (job) editJob(job);
}

// Jobs sent from the browser extension.
window.api.onJobImported(async (r) => {
  state.config = await window.api.getConfig();
  if (!$('#jobForm').hidden && work.editing?.id === r.jobId) return banner(r.text, 'ok');
  if ($('#jobForm').hidden && document.querySelector('.tab[data-tab="jobs"]').classList.contains('active')) loadJobs();
  banner(r.text, 'ok', { label: 'Open job', onClick: () => openJob(r.jobId) });
});
window.api.onJobOpen((r) => openJob(r.jobId));

window.api.onReminder((r) => {
  if (r.kind === 'interviewSoon' && r.link) return banner(r.text, 'warn', { label: 'Join meeting', onClick: () => window.open(r.link) });
  banner(r.text, 'warn', {
    label: 'Open job',
    onClick: async () => {
      document.querySelector('.tab[data-tab="jobs"]').click();
      await loadJobs();
      const job = work.jobs.find((j) => j.id === r.jobId);
      if (job) editJob(job);
    },
  });
});

// ---------- Prep plans in Mock ----------

state.plans = [];

async function loadPlans() {
  state.plans = await window.api.careerPlans();
  const sel = $('#mockSource');
  const keep = sel.value;
  const single = state.singleQuestion ? '<option value="single">This question (from your bank)</option>' : '';
  sel.innerHTML =
    '<option value="ai">AI questions</option>' +
    single +
    state.plans.map((p) => `<option value="plan:${escapeHtml(p.id)}">${escapeHtml(p.title.replace('Interview prep plan', 'Prep plan'))} (${p.plan.length})</option>`).join('');
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : 'ai';
}

// The next question from the selected plan or the bank pick; null for AI.
function nextPlannedQuestion(mock) {
  const source = $('#mockSource').value;
  if (source === 'single' && state.singleQuestion) {
    const q = state.singleQuestion;
    state.singleQuestion = null;
    loadPlans().then(() => ($('#mockSource').value = 'ai'));
    return { question: q.question, kind: CoreBank.TYPE_TO_SCENARIO[q.type] || 'mixed', label: `Question · ${CorePrompts.TYPE_LABELS[q.type] || 'From your bank'} · from your bank` };
  }
  if (!source.startsWith('plan:')) return null;
  const plan = state.plans.find((p) => `plan:${p.id}` === source);
  if (!plan) return null;
  mock.planPos = mock.planPos || {};
  const i = mock.planPos[plan.id] || 0;
  if (i >= plan.plan.length) return { done: 'You have practised every question in this plan. Switch to AI questions, or make a new prep plan in Jobs.' };
  mock.planPos[plan.id] = i + 1;
  const item = plan.plan[i];
  return { question: item.question, kind: CoreBank.TYPE_TO_SCENARIO[item.type] || 'mixed', label: `Plan question ${i + 1} of ${plan.plan.length} · ${item.type}` };
}

// ---------- Next steps + question bank (Progress) ----------

function practise(scenario, question) {
  document.querySelector('.tab[data-tab="mock"]').click();
  setTimeout(async () => {
    if (question) {
      state.singleQuestion = question;
      await loadPlans();
      $('#mockSource').value = 'single';
    } else {
      $('#mockSource').value = 'ai';
      if ([...$('#mockKind').options].some((o) => o.value === scenario)) $('#mockKind').value = scenario;
    }
    $('#mockNextBtn').click();
  }, 50);
}

async function renderGrowthCards(agg) {
  document.querySelector('#nextSteps')?.remove();
  document.querySelector('#bankCard')?.remove();
  const [attempts, challenges, bank] = await Promise.all([window.api.labAttempts(), window.api.labChallenges(), window.api.questionBank()]);
  const coding = attempts.length ? Coach.aggregateCoding(attempts, challenges) : null;
  const steps = Coach.learningPath(agg, coding);
  if (steps.length) {
    const card = document.createElement('div');
    card.className = 'card';
    card.id = 'nextSteps';
    card.innerHTML = `<div class="label">Next steps</div>${steps
      .map(
        (s, i) => `<div class="step"><div><b>${escapeHtml(s.title)}</b><div class="hint">${escapeHtml(s.detail)}</div></div>${
          s.action ? `<button class="btn small" data-step="${i}">${s.action.type === 'lab' ? 'Open Coding Lab' : 'Practise'}</button>` : ''
        }</div>`,
      )
      .join('')}`;
    card.querySelectorAll('[data-step]').forEach((b) => {
      const s = steps[Number(b.dataset.step)];
      b.onclick = () => (s.action.type === 'lab' ? window.api.openLab() : practise(s.action.scenario));
    });
    $('#progress').prepend(card);
  }
  if (!bank.length) return;
  const card = document.createElement('div');
  card.className = 'card';
  card.id = 'bankCard';
  card.innerHTML = `<div class="label"><span>Question bank</span><span>${bank.length} question${bank.length === 1 ? '' : 's'}</span></div>
    <input type="search" id="bankFilter" placeholder="Filter questions…" aria-label="Filter questions" />
    <ul class="bank-list" id="bankList"></ul>`;
  $('#progress').append(card);
  const render = () => {
    const f = $('#bankFilter').value.trim().toLowerCase();
    const items = bank.filter((q) => !f || q.question.toLowerCase().includes(f)).slice(0, 40);
    $('#bankList').innerHTML = items
      .map(
        (q, i) => `<li><div class="bank-q">${escapeHtml(q.question)}</div><div class="bank-meta">${
          CorePrompts.TYPE_LABELS[q.type] ? `<span class="chip">${CorePrompts.TYPE_LABELS[q.type]}</span>` : ''
        }${q.times ? `<span>asked ${q.times}×</span>` : '<span>planned</span>'}${q.bestScore != null ? `<span>best ${Coach.fmt(q.bestScore)}</span>` : ''}<button class="btn small" data-q="${i}">Practise</button></div></li>`,
      )
      .join('') || '<li class="muted">No matching questions.</li>';
    $('#bankList').querySelectorAll('[data-q]').forEach((b) => {
      const q = items[Number(b.dataset.q)];
      b.onclick = () => practise(null, q);
    });
  };
  $('#bankFilter').oninput = render;
  render();
}
