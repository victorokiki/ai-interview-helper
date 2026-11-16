// Prompt building blocks shared by every client (desktop today, server and
// web later): roles, grounding rule, profile/system prompt, practice
// scenarios, answer-preset style guide, transcript formatting.
// Pure functions; loads as CommonJS or as a browser global (CorePrompts).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CorePrompts = api;
})(typeof self !== 'undefined' ? self : this, function () {
const LANGUAGE_NAMES = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
  it: 'Italian',
  nl: 'Dutch',
  hi: 'Hindi',
  zh: 'Chinese (Simplified)',
  ja: 'Japanese',
  ko: 'Korean',
  ar: 'Arabic',
  ru: 'Russian',
  tr: 'Turkish',
};

const LENGTH_GUIDE = {
  short: { words: 60, bullets: 4 },
  medium: { words: 110, bullets: 5 },
  long: { words: 180, bullets: 6 },
};
const TONE_GUIDE = {
  confident: 'confident and direct',
  conversational: 'warm and conversational',
  formal: 'formal and precise',
  friendly: 'friendly and upbeat',
};

// Writing instructions for live answers from the active answer preset.
function styleGuide(preset) {
  const p = preset || { length: 'short', tone: 'confident', format: 'bullets-script' };
  const { words, bullets } = LENGTH_GUIDE[p.length] || LENGTH_GUIDE.short;
  const format = {
    'bullets-script': `Start with up to ${bullets} short bullet points the candidate can glance at, then a spoken answer of about ${words} words they can say out loud.`,
    script: `Write only a spoken answer of about ${words} words that the candidate can say out loud, no bullet points.`,
    bullets: `Bullet points only, no prose: at most ${bullets} bullets, each under 15 words.`,
  }[p.format] || '';
  const lines = [format, `Tone: ${TONE_GUIDE[p.tone] || TONE_GUIDE.confident}.`];
  lines.push(
    p.language && LANGUAGE_NAMES[p.language]
      ? `Write the answer in ${LANGUAGE_NAMES[p.language]}.`
      : 'Write the answer in the language the question was asked in.',
  );
  if (p.prompt) lines.push(`<user_instructions>\n${p.prompt}\n</user_instructions>`);
  return lines.join('\n');
}

const GROUNDING = `Ground every specific claim about the candidate (employers, titles, dates, metrics, projects, achievements, and what they did, why and with what result) in <verified_facts>, <candidate_resume> or <application_sent>. Use each fact as stated: do not stretch its scope or length of time, and do not add steps, causes or outcomes it does not contain. When no fact matches the question exactly, draw on the closest real experience honestly (for example, the systems they ran or the tools they used) instead of inventing a story. Only when nothing relevant exists, write one short bracketed placeholder such as [your example of leading a migration].`;

function formatDate(ms) {
  return new Date(ms).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

// Identical across calls in a session, so providers that cache prompts can.
// config.job and config.facts are added by main.js (active job workspace and
// Interview Brain).
function profileSystem(config, role) {
  const parts = [role];
  const job = config.job;
  const facts = config.facts || [];
  if (config.resume || facts.length || config.applicationBlock) parts.push(GROUNDING);
  if (config.resume) parts.push(`<candidate_resume>\n${config.resume}\n</candidate_resume>`);
  if (facts.length) {
    parts.push(`<verified_facts>\n${facts.slice(0, 120).map((f) => `- [${f.category}] ${f.text}`).join('\n')}\n</verified_facts>`);
  }
  if (job) {
    const header = [
      job.company && `Company: ${job.company}`,
      job.role && `Role: ${job.role}`,
      job.stage && `Stage: ${job.stage}`,
      job.interviewAt && `Interview: ${formatDate(job.interviewAt)}`,
    ].filter(Boolean);
    if (header.length) parts.push(`<target_job>\n${header.join('\n')}\n</target_job>`);
    if (job.jobDescription) parts.push(`<job_description>\n${job.jobDescription}\n</job_description>`);
    if (job.notes) parts.push(`<job_notes>\n${job.notes}\n</job_notes>`);
  }
  // What the candidate already sent this employer (Autonomous Job Kit),
  // prebuilt by CoreJobKit.applicationBlock.
  if (config.applicationBlock) parts.push(config.applicationBlock);
  if (config.extraNotes) parts.push(`<candidate_notes>\n${config.extraNotes}\n</candidate_notes>`);
  // Kept lessons from past sessions, prebuilt by CoreLessons.lessonsBlock.
  if (config.lessonsBlock) parts.push(config.lessonsBlock);
  return parts.join('\n\n');
}

// Practice scenarios: what to ask, and what the grader should look for.
const SCENARIOS = {
  general: {
    label: 'General',
    ask: 'a general interview question (background, motivation, strengths, weaknesses, or fit for this role)',
    rubric: 'Look for a clear, confident answer tied to this role.',
  },
  behavioral: {
    label: 'Behavioral',
    ask: 'a behavioral question that calls for one specific past example',
    rubric: "Look for a concrete situation, the candidate's own actions, and a measurable result (STAR).",
  },
  coding: {
    label: 'Coding',
    ask: 'a coding problem that can be answered out loud: state it clearly with one example input and output, at the level this role implies',
    rubric: 'The answer is spoken, so judge the approach, correctness, edge cases and stated time and space complexity, not syntax.',
  },
  'system-design': {
    label: 'System design',
    ask: "a system design question scoped to this role's seniority",
    rubric: 'Look for clarifying requirements, rough capacity estimates, core components, data model, trade-offs and bottlenecks.',
  },
  'product-case': {
    label: 'Product case',
    ask: 'a product sense or product case question (design, improve, prioritize or measure a product) relevant to the company or domain',
    rubric: 'Look for user segments, problem framing, prioritization, a concrete solution and success metrics.',
  },
  'data-ml': {
    label: 'Data / ML',
    ask: 'a data analysis, SQL, statistics or machine learning question suited to this role',
    rubric: 'Look for a correct method, stated assumptions, the right metrics and clear trade-offs.',
  },
  salary: {
    label: 'Salary negotiation',
    ask: 'one recruiter line from a compensation conversation (asking for expectations, presenting an offer, or pushing back), in character as the recruiter',
    rubric: 'Look for a researched range, not naming a number too early, asking about the full package, and a collaborative tone. Here "depth" means negotiating strength.',
  },
  recruiter: {
    label: 'Recruiter screen',
    ask: 'a recruiter phone-screen question (background summary, why this company, availability, work authorization, expectations, motivation)',
    rubric: 'Look for a concise, confident pitch that matches the role and stays consistent.',
  },
  mixed: {
    label: 'Mixed',
    ask: 'whatever question a real interviewer for this role would ask next, varying the type',
    rubric: 'Judge the answer against what that type of question calls for.',
  },
  // Older sessions used these.
  technical: { label: 'Technical', ask: 'a technical question relevant to the role', rubric: '' },
  'role-specific': { label: 'Role-specific', ask: 'a question about the responsibilities in the job description', rubric: '' },
};

const LIVE_ROLE = `You are a real-time interview copilot helping a job candidate during a live interview.
You receive a rolling transcript where "Interviewer" is the other party and "Me" is the candidate, plus the question to answer.
Answer in the first person as the candidate, using the verified facts, resume, notes and document excerpts when they are provided.
Make every answer specific to this candidate: name the real employer, system, tools and numbers from their profile that bear on the question. A generic answer that any candidate could give is a weak answer. Choose the facts that match what is being asked (a conversion question calls for conversion work, a performance question for performance work), and never imply experience at a scale or in an area the profile does not show.
When there are bullets and a spoken answer, the spoken answer must carry the key facts itself; the candidate may only say the spoken part.
For technical, system design and "how do you handle…" questions, give the correct general answer and tie it, in a sentence, to relevant real experience from the profile.
For "why this company / role" questions, link two or three concrete needs from the job description to the candidate's real experience. Say nothing about the company that the job description or notes do not support.
For coding or system design questions, outline the approach first, then give code or a design sketch, and state time/space complexity where relevant.
If the latest transcript is not actually a question (small talk, a statement), reply with a one-line suggested response.
Format in Markdown. Do not add preamble like "Here's an answer".`;

const SCREEN_ROLE = `You are an expert interview copilot. The user sends a screenshot from an interview (often a coding problem, a system design prompt, an online assessment question, or a slide).
Identify the task, then solve it. For coding problems: restate the problem in one line, explain the approach, give clean working code (in the language shown, otherwise Python), and state time and space complexity. For multiple choice, give the answer and a one-line reason.
Format in Markdown. Be direct.`;

const MOCK_ROLE = `You are an experienced hiring manager running a realistic mock interview for the candidate described below. Tailor questions to the job description and the candidate's background.`;

const SUMMARY_ROLE = `You are an interview coach reviewing the transcript of a job interview the candidate just finished. "Interviewer" is the other party and "Me" is the candidate. Be specific and honest, quote the transcript where useful, and keep it skimmable.`;

function formatTranscript(lines, maxLines = 40) {
  return lines
    .slice(-maxLines)
    .map((l) => `${l.speaker === 'me' ? 'Me' : 'Interviewer'}: ${l.text}`)
    .join('\n');
}

function deliveryLine(m) {
  return [
    `${m.words} words`,
    m.wpm ? `${m.wpm} words per minute` : '',
    `${m.fillers} filler words`,
    m.repeats ? `${m.repeats} repeated words` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

  // Structure that suits each question type (packages/core/question.js).
  const TYPE_GUIDES = {
    behavioral: 'Behavioral question: use STAR with ONE specific situation from the verified facts or resume: the situation in a sentence, what the candidate did, and the result, using only the actions and results the facts state.',
    technical: "Technical question: lead with a crisp, correct definition, then a concrete example (from the candidate's own work when the profile has one), then one trade-off or pitfall.",
    'system-design': 'System design question: clarify requirements and scale first, then the core components and data flow, then bottlenecks and trade-offs. Where it fits, mention a comparable system the candidate really built or ran.',
    coding: 'Coding question: state the approach in a sentence, give clean working code, then time and space complexity and edge cases.',
    motivation: "Motivation or background question: connect the candidate's real experience to two or three specific needs in the job description; specific, not a restatement of the job description.",
    salary: 'Compensation question: avoid naming a number first if possible; if pressed, give a researched range, mention the whole package, stay collaborative.',
    general: '',
  };

  const TYPE_LABELS = {
    behavioral: 'Behavioral',
    technical: 'Technical',
    'system-design': 'System design',
    coding: 'Coding',
    motivation: 'Motivation',
    salary: 'Compensation',
    general: '',
  };

  // Panel interview: each question comes from one of these interviewers.
  const PANEL = [
    { id: 'recruiter', label: 'Recruiter', focus: 'motivation, a background summary, logistics and fit' },
    { id: 'manager', label: 'Hiring manager', focus: 'impact, ownership, prioritisation and behavioral examples' },
    { id: 'tech', label: 'Technical lead', focus: 'technical depth, design and trade-offs for this role' },
    { id: 'hr', label: 'HR partner', focus: 'collaboration, conflict, values and growth' },
  ];

  const DIFFICULTY = {
    easy: 'Difficulty: easy. A common, friendly question; no trick follow-ups.',
    medium: 'Difficulty: medium. A realistic question for this level.',
    hard: 'Difficulty: hard. Senior-level depth: probe trade-offs, edge cases, failure modes and measurable impact.',
  };

  // Rewrites requested from an answer card.
  const REWRITES = {
    shorter: 'Rewrite the previous answer about half as long. Keep the strongest point and the spoken answer; drop the rest.',
    longer: 'Expand the previous answer: add one more concrete detail or example from the verified facts and about 50% more spoken text. Do not invent anything.',
    regenerate: 'Write a different, equally strong answer to the same question (a different example or angle where the facts allow).',
  };

  // ---- Coding Lab ----
  const CODE_ROLE =
    'You are a senior engineer coaching a candidate through a coding-interview problem. Be concise, precise and encouraging. Format in Markdown; use fenced code blocks only where asked.';

  function codeResultsText(results) {
    if (!results) return '';
    if (results.error) return `Error:\n${results.error}`;
    return (results.results || [])
      .map((r, i) => `Test ${i + 1}: ${r.ok ? 'passed' : 'FAILED'}${r.error ? `: ${r.error}` : ''}${!r.ok && r.got !== undefined && !r.hidden ? ` (got ${JSON.stringify(r.got)}, expected ${JSON.stringify(r.expected)})` : ''}`)
      .join('\n');
  }

  // mode: 'hint' | 'review' | 'explain'
  function codePrompt(mode, { problem, language, code, results, hintLevel = 1 }) {
    const base = [
      `<problem title="${String(problem.title).replace(/"/g, "'")}" difficulty="${problem.difficulty}">\n${problem.prompt}\n</problem>`,
      `<language>${language}</language>`,
      `<candidate_code>\n${code}\n</candidate_code>`,
      results ? `<test_results>\n${codeResultsText(results)}\n</test_results>` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const ask = {
      hint: `Give hint ${hintLevel} of 3, building on what the candidate's code already does. Level 1: a nudge toward the key idea or data structure, in one or two sentences. Level 2: the algorithm as plain numbered steps, no code. Level 3: short pseudocode. Never write the full solution in ${language}.`,
      review: `Review this solution like an interviewer would. Use exactly these sections:\n### Correctness\n(bugs and edge cases, referring to the test results)\n### Complexity\n(first line exactly "Time: O(...), Space: O(...)", then one line of justification for each)\n### Improvements\n(a cleaner or faster approach if one exists; show code only for the part that changes)\n### How to explain it\n(two or three sentences the candidate could say out loud)`,
      explain: `The code failed. In plain words, explain what went wrong, where (the line or test), and how to fix the idea. Do not rewrite the whole solution.`,
    }[mode];
    return `${base}\n\n${ask}`;
  }

  return {
    CODE_ROLE,
    codePrompt,
    TYPE_GUIDES,
    TYPE_LABELS,
    PANEL,
    DIFFICULTY,
    REWRITES,
    LANGUAGE_NAMES,
    SCENARIOS,
    GROUNDING,
    LIVE_ROLE,
    SCREEN_ROLE,
    MOCK_ROLE,
    SUMMARY_ROLE,
    styleGuide,
    profileSystem,
    formatTranscript,
    deliveryLine,
  };
});
