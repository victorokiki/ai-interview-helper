// Obsidian (or any Markdown folder) export: turns the user's jobs, sessions,
// career documents, lessons, facts and question bank into linked Markdown
// notes with properties (YAML front matter). Pure: returns [{ path, content }]
// with paths relative to the export folder; src/vault.js writes them.
// Loads as CommonJS or as a browser global (CoreVault).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CoreVault = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

  // A file name that is valid on Windows, macOS and Linux and in Obsidian links.
  function safeName(s, max = 80) {
    let n = String(s || '')
      .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
      .replace(/[. ]+$/g, '')
      .trim();
    if (!n) n = 'Untitled';
    if (RESERVED.test(n)) n += '_';
    return n;
  }

  const pad = (n) => String(n).padStart(2, '0');
  function day(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function stamp(ms) {
    const d = new Date(ms);
    return `${day(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  // Obsidian reads YYYY-MM-DDTHH:mm as a date-and-time property.
  const propTime = (ms) => stamp(ms).replace(' ', 'T');

  function yaml(props) {
    const lines = ['---'];
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
      if (Array.isArray(v)) lines.push(`${k}:`, ...v.map((x) => `  - ${JSON.stringify(String(x))}`));
      else if (typeof v === 'number' || typeof v === 'boolean') lines.push(`${k}: ${v}`);
      else lines.push(`${k}: ${JSON.stringify(String(v))}`);
    }
    lines.push('---');
    return lines.join('\n');
  }

  const NOTICE = '> [!info] Written by Interview Helper\n> If you edit this note, the app stops updating it, so your changes are safe. Put your own notes in a separate note and link to it.';

  // A note from blocks (front matter, headings, paragraphs, lists), one blank
  // line between each, so Markdown never runs two blocks together.
  const note = (blocks) => blocks.filter((b) => b != null && b !== false && b !== '').join('\n\n').replace(/\n{3,}/g, '\n\n') + '\n';

  const jobName = (j) => [j.company, j.role].filter(Boolean).join(' — ') || 'Untitled job';
  const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  const KIND_LABEL = { check: 'Resume check', resume: 'Tailored resume', cover: 'Cover letter', linkedin: 'LinkedIn', followup: 'Follow-up email', research: 'Company research', prep: 'Prep plan' };

  // data: { jobs, sessions, artifacts, lessons, facts, bank, now }
  // opts: { folder: 'Interview Helper', transcripts: false }
  function buildVault(data, opts = {}) {
    const folder = String(opts.folder || 'Interview Helper').replace(/^\/+|\/+$/g, '');
    const now = data.now || Date.now();
    const jobs = [...(data.jobs || [])].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id)));
    const sessions = [...(data.sessions || [])].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0) || String(a.id).localeCompare(String(b.id)));
    const artifacts = [...(data.artifacts || [])].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id)));
    const kept = (data.lessons || []).filter((l) => l.status === 'approved');
    const files = [];
    const taken = new Set();

    // Unique path per item (case-insensitive, as on Windows and macOS).
    function claim(dir, base) {
      let name = `${dir}/${base}.md`;
      for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${dir}/${base} (${i}).md`;
      taken.add(name.toLowerCase());
      return name;
    }
    const link = (p, alias) => `[[${folder}/${p.replace(/\.md$/, '')}|${String(alias).replace(/[|\]\[]/g, ' ').replace(/\s+/g, ' ').trim()}]]`;

    const jobPath = new Map(jobs.map((j) => [j.id, claim('Jobs', safeName(jobName(j)))]));
    const sessionPath = new Map(sessions.map((s) => [s.id, claim('Sessions', `${day(s.startedAt || now)} ${pad(new Date(s.startedAt || now).getHours())}${pad(new Date(s.startedAt || now).getMinutes())} ${safeName(s.title || (s.type === 'mock' ? 'Mock interview' : 'Live interview'), 60)}`)]));
    const docPath = new Map(artifacts.map((a) => [a.id, claim('Documents', `${safeName(a.title || KIND_LABEL[a.kind] || 'Document', 70)} ${day(a.createdAt || now)}`)]));
    const jobLink = (id) => (jobPath.has(id) ? link(jobPath.get(id), jobName(jobs.find((j) => j.id === id))) : '');
    const sessionScore = (s) => avg((s.answers || []).map((a) => a.scores?.overall).filter((v) => typeof v === 'number'));

    // Jobs
    for (const j of jobs) {
      const own = sessions.filter((s) => s.jobId === j.id);
      const docs = artifacts.filter((a) => a.jobId === j.id);
      const lessons = kept.filter((l) => l.jobId === j.id);
      const scores = own.flatMap((s) => (s.answers || []).map((a) => a.scores?.overall)).filter((v) => typeof v === 'number');
      const facts = [
        j.stage && `**Stage:** ${j.stage[0].toUpperCase()}${j.stage.slice(1)}`,
        j.interviewAt && `**Interview:** ${stamp(j.interviewAt)}`,
        j.interviewLink && `[Join meeting](${j.interviewLink})`,
        j.url && `[Job posting](${j.url})`,
        j.applyBy && `**Apply by:** ${day(j.applyBy)}`,
        j.followUpAt && `**Follow up:** ${stamp(j.followUpAt)}${j.followUpNote ? ` (${j.followUpNote})` : ''}`,
      ].filter(Boolean);
      const body = note([
        yaml({ tags: ['interview-helper', 'job'], company: j.company, role: j.role, stage: j.stage, interview: j.interviewAt ? propTime(j.interviewAt) : null, apply_by: j.applyBy ? day(j.applyBy) : null, follow_up: j.followUpAt ? propTime(j.followUpAt) : null, posting: j.url, meeting: j.interviewLink, sessions: own.length, average_score: avg(scores) }),
        `# ${jobName(j)}`,
        NOTICE,
        facts.join(' · '),
        j.contacts && `## Contacts\n\n${j.contacts.split('\n').filter(Boolean).map((c) => `- ${c}`).join('\n')}`,
        j.notes && `## Notes\n\n${j.notes}`,
        lessons.length && `## Lessons for this job\n\n${lessons.map((l) => `- ${l.text}`).join('\n')}`,
        own.length && `## Practice and interviews\n\n${own.slice().reverse().map((s) => `- ${link(sessionPath.get(s.id), s.title || 'Session')} · ${day(s.startedAt)}${sessionScore(s) != null ? ` · score ${sessionScore(s)}` : ''}`).join('\n')}`,
        docs.length && `## Documents\n\n${docs.map((a) => `- ${link(docPath.get(a.id), a.title || KIND_LABEL[a.kind])}`).join('\n')}`,
        j.jobDescription && `## Job description\n\n${j.jobDescription}`,
      ]);
      files.push({ path: jobPath.get(j.id), content: body });
    }

    // Sessions
    for (const s of sessions) {
      const score = sessionScore(s);
      const parts = [
        yaml({ tags: ['interview-helper', 'session', s.type === 'mock' ? 'mock' : 'live'], date: propTime(s.startedAt || now), type: s.type === 'mock' ? 'Mock interview' : 'Live interview', job: jobLink(s.jobId), questions: (s.answers || []).length, score, words_per_minute: s.speech?.wpm, filler_words: s.speech?.fillers }),
        '',
        `# ${s.title || 'Session'}`,
        '',
        NOTICE,
        '',
        [`**${s.type === 'mock' ? 'Mock interview' : 'Live interview'}** · ${stamp(s.startedAt || now)}`, s.jobId && jobLink(s.jobId) && `for ${jobLink(s.jobId)}`, s.speech && `${s.speech.wpm || '?'} words/min, ${s.speech.fillers} filler words`].filter(Boolean).join(' · '),
      ];
      if (s.summary) parts.push('', '## Summary', '', s.summary.replace(/^## /gm, '### '));
      for (const a of s.answers || []) {
        parts.push('', `## ${a.kind === 'mock' ? 'Practice question' : a.kind === 'screenshot' ? 'Screenshot' : 'Question'}: ${a.question || ''}`);
        if (a.myAnswer) parts.push('', '**My answer:**', '', a.myAnswer);
        if (a.scores) parts.push('', `**Scores:** ${Object.entries(a.scores).map(([k, v]) => `${k} ${v}`).join(', ')}`);
        if (a.answer) parts.push('', String(a.answer).replace(/^### /gm, '#### '));
      }
      if (s.transcript?.length) {
        if (opts.transcripts) parts.push('', '## Transcript', '', ...s.transcript.map((l) => `**${l.speaker === 'me' ? 'Me' : 'Interviewer'}:** ${l.text}  `));
        else parts.push('', `*Transcript (${s.transcript.length} lines) not exported. Turn on “Include full transcripts” in Interview Helper → Settings → Obsidian.*`);
      }
      files.push({ path: sessionPath.get(s.id), content: parts.join('\n') + '\n' });
    }

    // Career documents
    for (const a of artifacts) {
      const sources = (a.sources || []).map((src) => `${src.n}. [${(src.title || src.url).replace(/[[\]]/g, '')}](${src.url})`);
      files.push({
        path: docPath.get(a.id),
        content: note([
          yaml({ tags: ['interview-helper', 'document', a.kind], kind: KIND_LABEL[a.kind] || a.kind, job: jobLink(a.jobId), created: propTime(a.createdAt || now), match: a.match?.overall }),
          `# ${a.title || KIND_LABEL[a.kind] || 'Document'}`,
          NOTICE,
          a.jobId && jobLink(a.jobId) && `For ${jobLink(a.jobId)} · ${day(a.createdAt || now)}`,
          a.content,
          sources.length && `## Sources\n\n${sources.join('\n')}`,
        ]),
      });
    }

    // Lessons, facts, question bank, home
    const general = kept.filter((l) => !l.jobId);
    const byJob = jobs.map((j) => [j, kept.filter((l) => l.jobId === j.id)]).filter(([, ls]) => ls.length);
    files.push({
      path: 'Lessons.md',
      content: note([
        yaml({ tags: ['interview-helper', 'lessons'], lessons: kept.length }),
        '# Lessons from past interviews',
        NOTICE,
        !kept.length && 'No kept lessons yet.',
        general.length && `## All interviews\n\n${general.map((l) => `- **${l.kind}:** ${l.text}`).join('\n')}`,
        ...byJob.map(([j, ls]) => `## ${jobLink(j.id)}\n\n${ls.map((l) => `- **${l.kind}:** ${l.text}`).join('\n')}`),
      ]),
    });

    const groups = {};
    for (const f of data.facts || []) (groups[f.category || 'other'] ||= []).push(f.text);
    files.push({
      path: 'Interview Brain.md',
      content: note([
        yaml({ tags: ['interview-helper', 'facts'], facts: (data.facts || []).length }),
        '# Interview Brain',
        NOTICE,
        'Verified facts about me that answers stick to.',
        ...Object.entries(groups).map(([k, v]) => `## ${k[0].toUpperCase()}${k.slice(1)}\n\n${v.map((t) => `- ${t}`).join('\n')}`),
      ]),
    });

    const bank = data.bank || [];
    files.push({
      path: 'Question bank.md',
      content: note([
        yaml({ tags: ['interview-helper', 'questions'], questions: bank.length }),
        '# Question bank',
        NOTICE,
        bank.length
          ? ['| Question | Type | Asked | Best score |', '|---|---|---|---|', ...bank.map((q) => `| ${String(q.question).replace(/\|/g, '\\|').replace(/\n/g, ' ')} | ${q.type || ''} | ${q.times || 0} | ${q.bestScore ?? ''} |`)].join('\n')
          : 'No questions yet.',
      ]),
    });

    const upcoming = jobs.filter((j) => j.interviewAt && j.interviewAt > now).sort((a, b) => a.interviewAt - b.interviewAt);
    files.push({
      path: 'Interview Helper.md',
      content: note([
        yaml({ tags: ['interview-helper'], jobs: jobs.length, sessions: sessions.length }),
        '# Interview Helper',
        NOTICE,
        upcoming.length && `## Upcoming interviews\n\n${upcoming.map((j) => `- ${stamp(j.interviewAt)} · ${jobLink(j.id)}${j.interviewLink ? ` · [Join](${j.interviewLink})` : ''}`).join('\n')}`,
        `## Jobs\n\n${jobs.length ? jobs.map((j) => `- ${jobLink(j.id)} · ${j.stage || ''}`).join('\n') : 'No jobs yet.'}`,
        `## Recent sessions\n\n${sessions.length ? sessions.slice(-10).reverse().map((s) => `- ${link(sessionPath.get(s.id), s.title || 'Session')} · ${day(s.startedAt)}`).join('\n') : 'No sessions yet.'}`,
        `## More\n\n- ${link('Lessons.md', 'Lessons from past interviews')}\n- ${link('Interview Brain.md', 'Interview Brain')}\n- ${link('Question bank.md', 'Question bank')}`,
      ]),
    });

    return files;
  }

  return { buildVault, safeName, yaml };
});
