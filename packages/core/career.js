// Career tools: keyword coverage, prompts for the resume check, tailored
// resume, cover letter, LinkedIn, follow-up email and company research, match
// score parsing, and citation assembly. Pure functions shared by every client.
// Loads as CommonJS or as a browser global (CoreCareer).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CoreCareer = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Words that appear in most job ads and say nothing about the role.
  const STOP = new Set(
    (
      'a an and are as at be by for from has have in is it of on or our that the their this to we will with you your ' +
      'about across all also any can do etc into its more must not other over per such than them they through use using ' +
      'within without who what when where which while work working team teams role roles job position candidate candidates ' +
      'experience experienced years year strong ability able skills skill knowledge understanding excellent good great ' +
      'including include includes required requirements preferred plus bonus responsibilities responsible help ensure ' +
      'company opportunity opportunities environment based new well best looking join us people part including key build ' +
      'building make making related relevant across like least highly level senior junior mid lead day days time'
    ).split(/\s+/),
  );

  function terms(text) {
    return (String(text || '').toLowerCase().match(/[a-z][a-z0-9+#./-]*[a-z0-9+#]|[a-z]/g) || [])
      .map((t) => t.replace(/[./-]+$/, ''))
      .filter((t) => t.length >= 2 && !STOP.has(t) && !/^\d/.test(t));
  }

  // Which of the job description's most telling terms appear in the resume
  // (and verified facts)? Terms count when they repeat, or when they look like
  // a skill or product name: capitalised mid-sentence (Kubernetes) or with
  // inner capitals (GitHub, CI/CD, AWS).
  function keywordCoverage(jobDescription, resumeText, { max = 30 } = {}) {
    const jd = String(jobDescription || '');
    const counts = new Map();
    const first = new Map();
    const notable = new Set();
    const re = /[A-Za-z][A-Za-z0-9+#./-]*[A-Za-z0-9+#]|[A-Za-z]/g;
    let m;
    let i = 0;
    while ((m = re.exec(jd))) {
      const raw = m[0].replace(/[./-]+$/, '');
      const t = raw.toLowerCase();
      if (t.length < 2 || STOP.has(t)) continue;
      counts.set(t, (counts.get(t) || 0) + 1);
      if (!first.has(t)) first.set(t, i++);
      const before = jd.slice(0, m.index).replace(/\s+$/, '');
      const sentenceStart = !before || /[.!?:;\n•\-–—]$/.test(before) || /\n\s*$/.test(jd.slice(0, m.index));
      if (/[A-Z]/.test(raw.slice(1)) || (/^[A-Z]/.test(raw) && !sentenceStart)) notable.add(t);
    }
    const ranked = [...counts.keys()]
      .filter((t) => counts.get(t) >= 2 || notable.has(t))
      .sort((a, b) => counts.get(b) - counts.get(a) || first.get(a) - first.get(b))
      .slice(0, max);
    const have = new Set(terms(resumeText));
    const list = ranked.map((term) => ({ term, inResume: have.has(term), count: counts.get(term) }));
    const found = list.filter((t) => t.inResume).length;
    return { terms: list, coverage: list.length ? Math.round((found / list.length) * 100) : null };
  }

  const TOOLS = {
    check: { label: 'Resume check', title: 'Resume check' },
    resume: { label: 'Tailored resume', title: 'Tailored resume' },
    cover: { label: 'Cover letter', title: 'Cover letter' },
    linkedin: { label: 'LinkedIn', title: 'LinkedIn headline and About' },
    followup: { label: 'Follow-up email', title: 'Follow-up email' },
    research: { label: 'Company research', title: 'Company research' },
    prep: { label: 'Prep plan', title: 'Interview prep plan' },
  };

  const PLAN_TYPES = ['behavioral', 'technical', 'system-design', 'coding', 'motivation', 'salary', 'product', 'data', 'recruiter', 'general'];

  const CAREER_ROLE = `You are an expert career coach and resume writer helping the candidate described below apply for the target job. Write in clear, natural, specific language; no clichés ("results-driven", "passionate", "synergy").
Hard rule: never invent employers, titles, dates, degrees, numbers, tools or achievements. Use only what is in <verified_facts>, <candidate_resume> and <candidate_notes>. Where a strong document would need a detail that isn't there, write a bracketed placeholder such as [add metric] or [add example] instead.`;

  // Instructions for each tool. `ctx` carries computed inputs.
  function careerPrompt(tool, ctx = {}) {
    switch (tool) {
      case 'check': {
        const kc = ctx.coverage;
        const kw = kc?.terms?.length
          ? `<keyword_coverage coverage="${kc.coverage}%">\nIn resume: ${kc.terms.filter((t) => t.inResume).map((t) => t.term).join(', ') || 'none'}\nMissing: ${kc.terms.filter((t) => !t.inResume).map((t) => t.term).join(', ') || 'none'}\n</keyword_coverage>`
          : '';
        return `${kw}

Assess how well the candidate's resume matches the job description.
The first line of your reply must be exactly this format, with whole numbers from 0 to 100:
MATCH overall=N skills=N experience=N impact=N
Then write Markdown with exactly these sections:
### Strengths for this role
### Gaps
(each missing requirement; say whether the verified facts show the candidate has it but the resume doesn't say so, or whether it's a real gap)
### Suggested rewrites
(3-6 resume bullets as "**Before:** ... → **After:** ...", using only verified facts; use [add metric] where a number is missing)
### Keywords to add
(only keywords the candidate can truthfully claim, from the missing list)`;
      }
      case 'resume':
        return `Rewrite the candidate's resume tailored to the job description. Keep every employer, title, date and degree exactly as in the resume; reorder and reword bullets to lead with what this job values; tighten wording; keep it to about one page.
Reply with the resume only, in Markdown: "# Full Name", one line of contact details copied from the resume, then "## Summary" (2-3 lines), "## Experience" (### Title — Company, dates; then bullets), "## Skills", "## Education". No commentary before or after.`;
      case 'cover':
        return `Write a cover letter for this job: 250-350 words, three or four short paragraphs, specific to the company and role, with two concrete examples from the verified facts that match the job's top requirements. Start with "Dear ${ctx.hiringManager || 'Hiring Manager'}," and end with "Sincerely," and the candidate's name from the resume. Plain text paragraphs; no subject line, no placeholders for the company's address.`;
      case 'linkedin':
        return `Write LinkedIn profile text aimed at roles like the target job. Markdown with exactly these sections:
## Headline
(one line, at most 220 characters)
## About
(first person, at most 1,800 characters, 3-4 short paragraphs, ending with what the candidate is looking for)
## Skills to feature
(8-12 skills the candidate can truthfully claim, comma-separated)`;
      case 'followup': {
        const s = ctx.session;
        const context = s
          ? `<last_interview date="${new Date(s.startedAt).toDateString()}">\n${s.summary ? `<summary>\n${s.summary}\n</summary>` : ''}${s.transcriptExcerpt ? `\n<transcript_excerpt>\n${s.transcriptExcerpt}\n</transcript_excerpt>` : ''}\n</last_interview>`
          : '<last_interview>No recorded interview for this job yet.</last_interview>';
        return `${context}

Write a short follow-up email the candidate can send after their interview: a subject line ("Subject: ..."), then 90-150 words. Thank them, refer to one specific topic from the interview (from the summary or transcript; if none is recorded, keep it general and add [mention a topic you discussed]), restate one way the candidate fits the role, and include anything the candidate promised to send. Sign with the candidate's name.`;
      }
      case 'research':
        return `Research ${ctx.company || 'the company'} for a candidate interviewing for ${ctx.role || 'this role'}${ctx.location ? ` in ${ctx.location}` : ''}. Use web search. Every fact about the company must come from a search result; if something can't be found, say "Not found" rather than guessing.
Markdown with exactly these sections:
## Company snapshot
(what they do, main products, size, notable news from the last 12 months)
## The role and team
## Interview process
(as reported by candidates or the company)
## Culture and values
## Compensation
(ranges for this role and location from cited sources only, with the source's date; "Not found" if there's no reliable source)
## Likely interview questions
## Smart questions to ask them`;
      case 'prep':
        return `${ctx.research ? `<company_research>\n${ctx.research}\n</company_research>\n\n` : ''}Build an interview prep plan for this job: compare the job description with the candidate's verified facts and resume${ctx.research ? ' and use the company research' : ''}.
Markdown with exactly these sections:
### Focus areas
(3-5 themes this interviewer is most likely to probe, and why)
### Gaps to prepare
(requirements the facts don't cover yet, and an honest way to address each)
### Stories to have ready
(3-5 specific stories from the verified facts, each mapped to the requirements it proves)
### Question plan
(exactly 10 numbered lines, most likely first, each in this format:
N. [type] The question as the interviewer would say it — why it's likely
where type is one of: ${PLAN_TYPES.join(', ')})`;
      default:
        throw new Error(`Unknown career tool: ${tool}`);
    }
  }

  // Parses "MATCH overall=72 skills=80 ..." from the first line.
  function splitMatch(text) {
    const t = String(text || '').replace(/^\s+/, '');
    const nl = t.indexOf('\n');
    const first = (nl === -1 ? t : t.slice(0, nl)).replace(/^[`*\s]+/, '');
    if (/^MATCH\b/i.test(first)) {
      if (nl === -1) return { match: null, body: '' };
      const match = {};
      for (const m of first.matchAll(/([a-z]+)\s*[=:]\s*(\d+)/gi)) match[m[1].toLowerCase()] = Math.max(0, Math.min(100, Number(m[2])));
      return { match: Object.keys(match).length ? match : null, body: t.slice(nl + 1).replace(/^\s+/, '') };
    }
    if (nl === -1 && 'MATCH'.startsWith(first.trim().toUpperCase())) return { match: null, body: '' };
    return { match: null, body: text };
  }

  // Claude web search answer → Markdown with numbered citation markers and a
  // de-duplicated source list. `blocks` are the response's content blocks.
  function citedMarkdown(blocks) {
    const sources = [];
    const indexOf = new Map();
    let md = '';
    for (const b of blocks || []) {
      if (b.type !== 'text') continue;
      md += b.text;
      const marks = [];
      for (const c of b.citations || []) {
        if (c.type !== 'web_search_result_location' || !c.url) continue;
        if (!indexOf.has(c.url)) {
          indexOf.set(c.url, sources.length + 1);
          sources.push({ n: sources.length + 1, url: c.url, title: c.title || c.url, citedText: c.cited_text || '' });
        }
        const n = indexOf.get(c.url);
        if (!marks.includes(n)) marks.push(n);
      }
      if (marks.length) md += marks.map((n) => ` [${n}]`).join('');
    }
    if (sources.length) md += `\n\n## Sources\n${sources.map((s) => `${s.n}. [${s.title.replace(/[[\]]/g, '')}](${s.url})`).join('\n')}`;
    return { markdown: md.trim(), sources };
  }

  // Reads the "Question plan" lines: "N. [type] Question — why".
  function parsePlan(text) {
    const section = String(text || '').split(/^###\s*Question plan\s*$/im)[1] ?? String(text || '');
    const plan = [];
    for (const line of section.split(/\r?\n/)) {
      const m = /^\s*\d+[.)]\s*\[([a-z-]+)\]\s*(.+?)\s*(?:[—–]|\s-\s)\s*(.+)$/i.exec(line) || /^\s*\d+[.)]\s*\[([a-z-]+)\]\s*(.+)$/i.exec(line);
      if (!m) continue;
      const type = m[1].toLowerCase();
      plan.push({ type: PLAN_TYPES.includes(type) ? type : 'general', question: m[2].trim(), why: (m[3] || '').trim() });
      if (plan.length === 15) break;
    }
    return plan;
  }

  return { PLAN_TYPES, parsePlan, TOOLS, CAREER_ROLE, careerPrompt, keywordCoverage, splitMatch, citedMarkdown, terms };
});
