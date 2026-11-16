// The copilot's prompts. Each task builds a provider-neutral request and
// streams it through providers.js (Claude, OpenAI, Gemini or local Ollama).
const fs = require('fs');
const path = require('path');
const { streamText, researchWithClaude } = require('./providers');
const career = require('../packages/core/career');
const docs = require('./docs');

const {
  LANGUAGE_NAMES,
  SCENARIOS,
  LIVE_ROLE,
  SCREEN_ROLE,
  MOCK_ROLE,
  SUMMARY_ROLE,
  styleGuide,
  profileSystem,
  formatTranscript,
  deliveryLine,
  TYPE_GUIDES,
  PANEL,
  DIFFICULTY,
  REWRITES,
} = require('../packages/core/prompts');
const { questionType } = require('../packages/core/question');

// Relevant passages from the user's extra documents, or '' when none match.
function excerpts(query) {
  const hits = docs.searchDocs(query);
  if (!hits.length) return '';
  return `<document_excerpts>\n${hits.map((h) => `<excerpt source="${h.name}">\n${h.text}\n</excerpt>`).join('\n')}\n</document_excerpts>`;
}

// rewrite: optional { mode: 'shorter' | 'longer' | 'regenerate', previous }
// from the Shorter / Longer / Regenerate buttons on an answer.
function answerQuestion({ config, question, transcript, rewrite }, onText, signal) {
  const style = styleGuide(config.preset);
  const recent = transcript?.length ? formatTranscript(transcript) : '';
  const guide = TYPE_GUIDES[questionType(question)];
  const redo = rewrite && REWRITES[rewrite.mode];
  const text = [
    excerpts(`${question}\n${formatTranscript(transcript || [], 4)}`),
    recent ? `<transcript>\n${recent}\n</transcript>` : '',
    `<question>\n${question}\n</question>`,
    guide,
    style,
    redo && rewrite.previous ? `<previous_answer>\n${rewrite.previous}\n</previous_answer>\n\n${redo}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return streamText(
    config,
    // Low effort keeps time-to-first-token short during a live conversation.
    { system: profileSystem(config, LIVE_ROLE), effort: 'low', parts: [{ type: 'text', text }] },
    onText,
    signal,
  );
}

function solveScreenshot({ config, imageBase64, hint }, onText, signal) {
  return streamText(
    config,
    {
      system: profileSystem(config, SCREEN_ROLE),
      effort: 'medium',
      parts: [
        { type: 'image', data: imageBase64 },
        { type: 'text', text: hint || 'Solve what is shown on this screen.' },
      ],
    },
    onText,
    signal,
  );
}

// persona: a PANEL id (panel interview); difficulty: easy | medium | hard;
// lastExchange: { question, answer } so a panelist can follow up on a gap.
async function nextMockQuestion({ config, kind, previous, persona, difficulty, lastExchange }, onText, signal) {
  const scenario = SCENARIOS[kind] || SCENARIOS.mixed;
  const panelist = PANEL.find((p) => p.id === persona);
  const asked = previous?.length
    ? `Questions already asked (do not repeat or closely paraphrase):\n${previous.map((q) => `- ${q}`).join('\n')}`
    : 'This is the first question.';
  const intro = panelist
    ? `This is a panel interview. You are the ${panelist.label}; your focus is ${panelist.focus}. Ask a question that fits your focus and `
    : 'Ask ';
  const followUp = lastExchange?.answer
    ? `<last_exchange>\nQ: ${lastExchange.question}\nA: ${lastExchange.answer}\n</last_exchange>\nIf that answer left an important gap (no result, vague ownership, missing trade-off), you may instead ask one short, pointed follow-up about it.`
    : '';
  const text = await streamText(
    config,
    {
      system: profileSystem(config, MOCK_ROLE),
      effort: 'low',
      parts: [
        {
          type: 'text',
          text: [
            `${intro}${panelist ? scenario.ask.replace(/^an? /, '') : scenario.ask}.`,
            DIFFICULTY[difficulty] || '',
            config.lessonsBlock ? "If one of the candidate's lessons fits this kind of question, ask something that lets them practise it." : '',
            followUp,
            asked, 'Reply with the question only, phrased exactly as you would say it aloud. No numbering, no quotes, no name.']
            .filter(Boolean)
            .join('\n'),
        },
      ],
    },
    onText,
    signal,
  );
  return text.trim();
}

// The first line carries machine-readable scores; the app strips it and
// shows bars instead (see splitScores in renderer/coach.js).
function gradeMockAnswer({ config, question, answer, kind, delivery }, onText, signal) {
  const scenario = SCENARIOS[kind] || SCENARIOS.mixed;
  const text = [
    `<interview_type>${scenario.label}</interview_type>`,
    `<question>\n${question}\n</question>`,
    `<candidate_answer>\n${answer || '(no answer given)'}\n</candidate_answer>`,
    delivery ? `<delivery_metrics>\n${delivery}\n</delivery_metrics>` : '',
    `Evaluate the answer. It is a speech transcript, so ignore punctuation; filler words are already counted in the delivery metrics. ${scenario.rubric}
Score each dimension from 1 to 10:
- clarity: easy to follow, plain language
- structure: logical order (for example STAR, or approach, then details, then trade-offs)
- specificity: concrete examples, names and numbers instead of generalities
- relevance: answers the question asked and connects to this role
- depth: role-level expertise and insight

The first line of your reply must be exactly this format, with whole numbers:
SCORES clarity=N structure=N specificity=N relevance=N depth=N overall=N

Then write Markdown with exactly these sections:
### What worked
### What to improve
(the 2-3 changes that matter most; if the delivery metrics show a problem, add one line about it${config.lessonsBlock ? '; if one of the lessons from past interviews applies to this answer, add one line saying whether the candidate applied it' : ''})
### Stronger answer
(about 120 words in the candidate's voice, using only the verified facts and resume; for coding or system design, outline the ideal approach instead)`,
  ]
    .filter(Boolean)
    .join('\n\n');
  return streamText(
    config,
    { system: profileSystem(config, MOCK_ROLE), effort: 'medium', parts: [{ type: 'text', text }] },
    onText,
    signal,
  );
}


function summarizeSession({ config, session }, onText, signal) {
  const transcript = formatTranscript(session.transcript || [], Infinity);
  const suggested = (session.answers || [])
    .map((a) => `- ${a.question}`)
    .join('\n');
  const text = [
    `<transcript>\n${transcript || '(no transcript)'}\n</transcript>`,
    suggested ? `<questions_the_copilot_answered>\n${suggested}\n</questions_the_copilot_answered>` : '',
    session.speech ? `<my_delivery_metrics>\n${deliveryLine(session.speech)}\n</my_delivery_metrics>` : '',
    `Write a post-interview summary in Markdown with exactly these sections:
## Overview
(2-3 sentences: what the interview covered and the overall impression)
## Questions asked
(each interviewer question, with one line on how I answered it)
## What went well
## What to improve
(include one line on delivery if the metrics show a problem)
## Follow-ups
(things I promised to send, topics to research, open questions about the role, next steps mentioned)
## Thank-you note
(a short, specific thank-you email draft that references something from the conversation)`,
  ]
    .filter(Boolean)
    .join('\n\n');
  return streamText(
    config,
    { system: profileSystem(config, SUMMARY_ROLE), effort: 'medium', parts: [{ type: 'text', text }] },
    onText,
    signal,
  );
}

// Up to 3 lessons from a finished session for the candidate to keep (memory
// across sessions). existing: lessons already kept, pending or dismissed, so
// the AI doesn't repeat them. Returns raw text; CoreLessons.parseLessons reads it.
function suggestLessons({ config, session, existing }, signal) {
  const mock = session.type === 'mock';
  const body = mock
    ? (session.answers || [])
        .filter((a) => a.kind === 'mock')
        .slice(-6)
        .map((a) => {
          const improve = /### What to improve\s*([\s\S]*?)(?:\n### |$)/.exec(a.answer || '')?.[1]?.trim() || '';
          const scores = a.scores ? Object.entries(a.scores).map(([k, v]) => `${k}=${v}`).join(' ') : 'not scored';
          return `<practice_answer type="${a.scenario || 'mixed'}">\nQuestion: ${a.question}\nMy answer: ${String(a.myAnswer || '').slice(0, 1500)}\nScores: ${scores}\nFeedback, what to improve: ${improve.slice(0, 800)}\n</practice_answer>`;
        })
        .join('\n')
    : [
        session.summary ? `<summary>\n${session.summary.slice(0, 6000)}\n</summary>` : '',
        `<transcript>\n${formatTranscript(session.transcript || [], 120).slice(-12000) || '(no transcript)'}\n</transcript>`,
        session.speech ? `<my_delivery_metrics>\n${deliveryLine(session.speech)}\n</my_delivery_metrics>` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
  const known = (existing || []).slice(-60).map((l) => `- ${l.text}`).join('\n');
  return streamText(
    config,
    {
      system: profileSystem(
        { ...config, lessonsBlock: '' },
        "You are an interview coach. From one session, you pick the few lessons that will most improve the candidate's next interview. You never suggest claiming anything that is not in the verified facts or resume.",
      ),
      effort: 'low',
      maxTokens: 1500,
      parts: [
        {
          type: 'text',
          text: [
            `<session type="${mock ? 'mock practice' : 'live interview'}">\n${body}\n</session>`,
            known ? `<lessons_already_known>\n${known}\n</lessons_already_known>` : '',
            `Suggest up to 3 lessons for the candidate's next interviews, based on what happened in this session. Each lesson is one actionable sentence of at most 25 words, specific enough to act on (name the topic, story or habit), for example a story to use for a kind of question, a point to lead with, a structure fix, or a delivery fix. A content lesson may only point to things in the verified facts or resume. Skip anything in lessons_already_known and anything generic. Use scope "job" when the lesson only matters for this company or role, otherwise "general". If nothing is worth keeping, reply [].
Reply with only a JSON array: [{"kind": "delivery" | "structure" | "content" | "story" | "company", "text": "...", "why": "<what in the session shows this, at most 20 words>", "scope": "general" | "job"}]`,
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
      ],
    },
    () => {},
    signal,
  );
}

// Pulls short, checkable facts out of the resume and documents for the
// Interview Brain. Returns [{category, text, source}].
async function extractFacts({ config, resume, documents }, signal) {
  const sources = [];
  if (resume) sources.push(`<source name="resume">\n${resume.slice(0, 30000)}\n</source>`);
  let budget = 40000;
  for (const d of documents || []) {
    if (budget <= 0) break;
    const text = d.text.slice(0, Math.min(budget, 15000));
    budget -= text.length;
    sources.push(`<source name="${d.name.replace(/"/g, "'")}">\n${text}\n</source>`);
  }
  if (!sources.length) throw new Error('Add your resume or some documents first.');
  const raw = await streamText(
    config,
    {
      system: "You extract verified career facts from a candidate's documents. You never infer, embellish or add anything that is not stated.",
      effort: 'medium',
      maxTokens: 8000,
      parts: [
        {
          type: 'text',
          text: `${sources.join('\n\n')}

List the facts about the candidate stated in these sources: roles and employers with dates, projects, measurable achievements, skills and tools, education and certifications, and stories that could answer behavioral questions.
Each fact must be self-contained (name the employer or project), at most 35 words, and keep exact numbers, dates and names. Up to 60 facts.
Reply with only a JSON array, no prose, where each item is {"category": "experience" | "project" | "achievement" | "skill" | "education" | "story" | "other", "text": "...", "source": "<source name>"}.`,
        },
      ],
    },
    () => {},
    signal,
  );
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end <= start) throw new Error('The AI did not return a list of facts. Try again.');
  let facts;
  try {
    facts = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('The AI returned the facts in an unreadable format. Try again.');
  }
  return Array.isArray(facts) ? facts.filter((f) => f && typeof f.text === 'string') : [];
}

// Translates one transcript line. Returns '' when it is already in the
// target language.
async function translateText({ config, text, to }, signal) {
  const language = LANGUAGE_NAMES[to];
  if (!language) throw new Error('Pick a language to translate into.');
  const out = await streamText(
    config,
    {
      system: `You translate interview transcript lines into ${language}. Reply with the translation only, keeping names and technical terms. If the line is already in ${language}, reply with exactly: SAME`,
      effort: 'low',
      maxTokens: 600,
      parts: [{ type: 'text', text }],
    },
    () => {},
    signal,
  );
  const result = out.trim();
  return result === 'SAME' ? '' : result;
}

async function pdfText(buffer) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return text.replace(/[ \t]+\n/g, '\n').trim();
}

// Plain text from a .pdf/.docx/.txt/.md file. Scanned PDFs have no text layer, so
// those go to Claude's PDF reader when Claude is the selected provider.
async function fileToText(file, config) {
  const lower = file.toLowerCase();
  if (lower.endsWith('.docx')) {
    const mammoth = require('mammoth');
    const { value } = await mammoth.extractRawText({ path: file });
    if (!value.trim()) throw new Error(`${path.basename(file)} has no readable text.`);
    return value.replace(/\n{3,}/g, '\n\n').trim();
  }
  if (!lower.endsWith('.pdf')) return fs.readFileSync(file, 'utf8');
  const buffer = fs.readFileSync(file);
  const text = await pdfText(buffer);
  if (text.length >= 200 || config.provider !== 'anthropic' || !config.anthropicKey) {
    if (!text) throw new Error(`${path.basename(file)} has no readable text (scanned PDF?). Paste the text instead.`);
    return text;
  }
  const transcribed = await streamText(config, {
    effort: 'low',
    parts: [
      { type: 'pdf', data: buffer.toString('base64') },
      { type: 'text', text: 'Transcribe this document to clean plain text. Keep every section, date, metric and skill. No commentary.' },
    ],
  });
  return transcribed.trim();
}

// Career tools (resume check, tailored resume, cover letter, LinkedIn,
// follow-up email). ctx: { coverage, session }.
function careerTool({ config, tool, ctx = {} }, onText, signal) {
  const text = career.careerPrompt(tool, { ...ctx, company: config.job?.company, role: config.job?.role });
  return streamText(
    config,
    { system: profileSystem(config, career.CAREER_ROLE), effort: 'medium', maxTokens: 8000, parts: [{ type: 'text', text }] },
    onText,
    signal,
  );
}

const RESEARCH_ROLE =
  'You are a careful research assistant preparing a job candidate for an interview at the company below. Search the web, prefer primary and recent sources, and cite a source for every fact about the company. Never guess figures.';

// Company research with Claude web search; returns { blocks, searchErrors }.
function researchCompany({ config }, onText, signal) {
  const job = config.job || {};
  return researchWithClaude(
    config,
    {
      system: profileSystem({ job }, RESEARCH_ROLE),
      text: career.careerPrompt('research', { company: job.company, role: job.role }),
      effort: 'medium',
    },
    onText,
    signal,
  );
}

module.exports = {
  suggestLessons,
  careerTool,
  researchCompany,
  answerQuestion,
  solveScreenshot,
  nextMockQuestion,
  gradeMockAnswer,
  summarizeSession,
  extractFacts,
  translateText,
  fileToText,
  LANGUAGE_NAMES,
  SCENARIOS,
};
