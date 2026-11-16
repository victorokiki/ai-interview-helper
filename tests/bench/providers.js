// Real-provider benchmark: speed, accuracy, reliability and cost, through the
// app's own code paths (src/ai.js → src/providers.js, net.fetch).
//
// Uses ONLY real services. A provider without credentials is reported as
// "skipped (no credentials)", never simulated. Local Whisper is real and
// always runs.
//
// Credentials (environment variables, never stored by this script):
//   ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, DEEPGRAM_API_KEY
// Models (optional): BENCH_MODELS="anthropic:claude-haiku-5-5,anthropic:claude-sonnet-5-5,openai:gpt-5-mini,gemini:gemini-2.5-flash"
// Runs per model (optional): BENCH_RUNS=6
// Judge (optional, needs ANTHROPIC_API_KEY): BENCH_JUDGE=claude-opus-5-5
// Question set (optional): BENCH_SET=tune (default; backend engineer, 6 questions)
//   or BENCH_SET=holdout (a different profile and questions, for checking that a
//   prompt change generalises instead of fitting the tuning set), or
//   BENCH_SET=fresh (a third profile, for a final check)
// Label for the report file (optional): BENCH_LABEL=baseline
// Skip speech-to-text (optional): BENCH_STT=0
// Compare prompts (optional): BENCH_PROMPTS=<path to another prompts.js>
//
// Usage: npx electron tests/bench/providers.js
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, 'out');
// One folder per run, so several runs can go at once.
const userData = path.join(out, `providers-userdata-${process.env.BENCH_SET || 'tune'}-${(process.env.BENCH_LABEL || 'default').replace(/[^a-z0-9-]/gi, '')}`);
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);

const KEYS = {
  anthropic: process.env.ANTHROPIC_API_KEY || '',
  openai: process.env.OPENAI_API_KEY || '',
  gemini: process.env.GEMINI_API_KEY || '',
  deepgram: process.env.DEEPGRAM_API_KEY || '',
};
const MODELS = (process.env.BENCH_MODELS || 'anthropic:claude-haiku-5-5,anthropic:claude-sonnet-5-5,anthropic:claude-opus-5-5,openai:gpt-5-mini,gemini:gemini-2.5-flash')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const [provider, ...rest] = s.split(':');
    return { provider, model: rest.join(':') };
  });
const RUNS = Number(process.env.BENCH_RUNS) || 6;
const JUDGE = process.env.BENCH_JUDGE || 'claude-opus-5-5';

// USD per million tokens, from docs/research/pricing-2026-11-15.md. OpenAI and
// Gemini prices were not researched; their cost is reported as unknown unless
// BENCH_PRICES='{"gpt-5-mini":[in,out],...}' is given.
const PRICES = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
  ...JSON.parse(process.env.BENCH_PRICES || '{}'),
};

const TUNE_PROFILE = {
  resume:
    'Jordan Lee. Senior Backend Engineer at Northwind Payments (2021–2025): led a team of 6 building the card authorization service in Go and Kafka; cut p99 checkout latency from 900 ms to 350 ms; ran on-call for 40 services. Software Engineer at Fabrikam Logistics (2018–2021): built route-optimization APIs in Python; migrated batch jobs to AWS Step Functions. BSc Computer Science, University of Leeds, 2018.',
  facts: [
    { category: 'experience', text: 'Senior Backend Engineer at Northwind Payments 2021–2025, led a team of 6' },
    { category: 'achievement', text: 'Cut p99 checkout latency at Northwind from 900 ms to 350 ms by moving fraud checks to async Kafka consumers' },
    { category: 'story', text: 'Disagreed with manager about a big-bang database migration; proposed a phased dual-write rollout that shipped with zero downtime' },
    { category: 'skill', text: 'Go, Kafka, PostgreSQL, Python, AWS' },
  ],
  job: { company: 'Contoso Cloud', role: 'Staff Backend Engineer', jobDescription: 'Design and operate high-throughput APIs (50k+ RPS), mentor engineers, own reliability and incident response. Go or Java, Kafka, distributed systems.' },
};
const TUNE_QUESTIONS = [
  'Tell me about yourself and why you are interested in this role.',
  'Describe a time you disagreed with your manager. What did you do?',
  'How would you design a rate limiter for a public API that handles fifty thousand requests per second?',
  'Tell me about a time you improved the performance of a system.',
  'What is the difference between a process and a thread, and when would you use each?',
  'How do you handle a production incident at 3 a.m.?',
];

// Held-out set: never used while tuning prompts.
const HOLDOUT_PROFILE = {
  resume:
    'Priya Shah. Product Manager at Lumen Health (2022–2025): owned the patient-booking app (1.2M monthly users); launched self-service rescheduling, which cut no-shows by 18%; ran weekly experiments with a team of 5 engineers and 1 designer. Associate Product Manager at Brightline Retail (2020–2022): shipped a loyalty-points feature in the mobile app; analysed checkout funnels in SQL and Amplitude. BA Economics, University of Toronto, 2020.',
  facts: [
    { category: 'experience', text: 'Product Manager at Lumen Health 2022–2025, owned the patient-booking app with 1.2M monthly users' },
    { category: 'achievement', text: 'Launched self-service rescheduling at Lumen Health; no-shows fell 18% in the first quarter' },
    { category: 'story', text: 'Killed a feature the CEO wanted after a two-week experiment showed it lowered booking completion by 4%; presented the data and proposed a smaller alternative' },
    { category: 'story', text: 'Missed a launch date at Brightline because of an unplanned payments dependency; now maps dependencies in week one of every project' },
    { category: 'skill', text: 'SQL, Amplitude, A/B testing, user interviews, roadmap prioritisation (RICE)' },
  ],
  job: { company: 'Northstar Travel', role: 'Senior Product Manager, Mobile', jobDescription: 'Own the mobile booking experience end to end, set the roadmap with engineering and design, run experiments, and grow conversion. 5+ years of product management, strong analytics.' },
};
const HOLDOUT_QUESTIONS = [
  'Walk me through your background and why Northstar.',
  'Tell me about a time you used data to change a stakeholder’s mind.',
  'How would you decide what to build next for our mobile app?',
  'Tell me about a project that did not go as planned.',
  'What is the difference between a north-star metric and a guardrail metric?',
  'How would you improve the checkout conversion of a travel booking app?',
];

// Second held-out set, added after the first one had been read during tuning.
const FRESH_PROFILE = {
  resume:
    'Marcus Okafor. Data Analyst at Greenfield Energy (2021–2025): built the weekly churn dashboard in SQL and Tableau used by 40 account managers; found that customers on paper billing churned at twice the rate, which led to an e-billing campaign; automated a 6-hour monthly report down to 20 minutes with Python. Junior Analyst at Harbor Insurance (2019–2021): cleaned claims data and wrote SQL for the fraud team. BSc Mathematics, University of Manchester, 2019.',
  facts: [
    { category: 'experience', text: 'Data Analyst at Greenfield Energy 2021–2025; weekly churn dashboard in SQL and Tableau used by 40 account managers' },
    { category: 'achievement', text: 'Found that paper-billing customers churned at twice the rate of e-billing customers; the finding started an e-billing campaign' },
    { category: 'achievement', text: 'Automated a monthly report with Python, from 6 hours to 20 minutes' },
    { category: 'story', text: 'A director challenged the churn numbers in a meeting; Marcus walked through the query live, found a duplicate-join bug, fixed it the same day and sent a corrected version' },
    { category: 'skill', text: 'SQL, Python (pandas), Tableau, A/B test analysis, Excel' },
  ],
  job: { company: 'Brightwave Telecom', role: 'Senior Data Analyst, Customer Insights', jobDescription: 'Analyse churn and retention, build self-serve dashboards for commercial teams, design and read A/B tests, and present insights to senior leaders. Strong SQL and Python; telecom or subscription experience a plus.' },
};
const FRESH_QUESTIONS = [
  'Tell me about yourself.',
  'Tell me about a time someone questioned your analysis.',
  'How would you find out why churn went up last month?',
  'Describe a time you made a process more efficient.',
  'What is the difference between correlation and causation, and why does it matter for an analyst?',
  'How would you explain a complex finding to a non-technical executive?',
];

const SET = ['holdout', 'fresh'].includes(process.env.BENCH_SET) ? process.env.BENCH_SET : 'tune';
const PROFILE = { tune: TUNE_PROFILE, holdout: HOLDOUT_PROFILE, fresh: FRESH_PROFILE }[SET];
const QUESTIONS = { tune: TUNE_QUESTIONS, holdout: HOLDOUT_QUESTIONS, fresh: FRESH_QUESTIONS }[SET];
const LABEL = (process.env.BENCH_LABEL || '').replace(/[^a-z0-9-]/gi, '');

const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null);

// Numbers and capitalized names in the answer that appear nowhere in the
// profile or question: a cheap automatic flag for invented details.
function ungrounded(answer, question) {
  const source = `${PROFILE.resume} ${PROFILE.facts.map((f) => f.text).join(' ')} ${PROFILE.job.company} ${PROFILE.job.role} ${PROFILE.job.jobDescription} ${question}`.toLowerCase();
  const numbers = (answer.match(/\b\d[\d,.]*\s?(%|ms|k|x)?/g) || []).map((n) => n.trim().toLowerCase());
  const names = (answer.match(/\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)+\b/g) || []).map((n) => n.toLowerCase());
  return [...new Set([...numbers, ...names])].filter((x) => x.length > 1 && !source.includes(x.replace(/,/g, '')));
}

function wer(ref, hyp) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
  const r = norm(ref);
  const h = norm(hyp);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    }
  }
  return r.length ? d[r.length][h.length] / r.length : 0;
}

function readWav(file) {
  const buf = fs.readFileSync(file);
  return new Int16Array(buf.buffer, buf.byteOffset + 44, (buf.length - 44) >> 1);
}

function fixtures() {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'manifest.json'), 'utf8').replace(/^﻿/, '');
  return JSON.parse(raw).map((f) => ({ ...f, path: path.join(__dirname, 'fixtures', f.file) }));
}

async function benchLLM(ai, providers, { provider, model }) {
  const key = KEYS[provider];
  if (!key) return { provider, model, skipped: 'no credentials' };
  const config = {
    provider,
    [`${provider}Key`]: key,
    [`${provider}Model`]: model,
    resume: PROFILE.resume,
    facts: PROFILE.facts,
    job: PROFILE.job,
    preset: { length: 'short', tone: 'confident', format: 'bullets-script' },
  };
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    const question = QUESTIONS[i % QUESTIONS.length];
    if (i === 1) await providers.prewarm(config); // first run is cold, the rest are warm
    const t0 = performance.now();
    let first = 0;
    try {
      const text = await ai.answerQuestion({ config, question, transcript: [] }, () => {
        if (!first) first = performance.now();
      });
      runs.push({ question, cold: i === 0, ttftMs: Math.round(first - t0), totalMs: Math.round(performance.now() - t0), chars: text.length, answer: text, ungrounded: ungrounded(text, question) });
    } catch (err) {
      runs.push({ question, cold: i === 0, error: err.message, status: err.status });
    }
  }
  const ok = runs.filter((r) => !r.error);
  const warm = ok.filter((r) => !r.cold);
  const outTokens = ok.reduce((n, r) => n + r.chars / 4, 0) / Math.max(1, ok.length);
  const inTokens = 1200; // approx. prompt size for this profile (estimate)
  const price = PRICES[model];
  return {
    provider,
    model,
    runs: runs.length,
    errors: runs.length - ok.length,
    coldTtftMs: ok.find((r) => r.cold)?.ttftMs ?? null,
    warmTtftMs: { p50: pct(warm.map((r) => r.ttftMs), 50), p95: pct(warm.map((r) => r.ttftMs), 95) },
    totalMs: { p50: pct(ok.map((r) => r.totalMs), 50) },
    outputTokensPerSecApprox: ok.length ? Math.round(ok.reduce((n, r) => n + r.chars / 4 / ((r.totalMs - r.ttftMs) / 1000 || 1), 0) / ok.length) : null,
    possibleInventedDetailsPerAnswer: ok.length ? +(ok.reduce((n, r) => n + r.ungrounded.length, 0) / ok.length).toFixed(2) : null,
    costPerAnswerUsdApprox: price ? +((inTokens * price[0] + outTokens * price[1]) / 1e6).toFixed(5) : 'unknown (price not configured)',
    samples: ok.slice(0, 2).map((r) => ({ question: r.question, answer: r.answer.slice(0, 600), ungrounded: r.ungrounded })),
    details: runs.map(({ answer, ...r }) => r),
    _answers: ok.map((r) => ({ question: r.question, answer: r.answer })),
  };
}

async function judge(ai, result) {
  if (!KEYS.anthropic || !result._answers?.length) return null;
  const config = { provider: 'anthropic', anthropicKey: KEYS.anthropic, anthropicModel: JUDGE };
  const scores = [];
  for (const { question, answer } of result._answers) {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) try {
      const { streamText } = require('../../src/providers');
      const text = await streamText(config, {
        system: 'You grade interview-copilot answers strictly. Reply with JSON only.',
        effort: 'medium',
        maxTokens: 2000,
        parts: [
          {
            type: 'text',
            text: `Candidate profile (the ONLY true facts):\n${PROFILE.resume}\n${PROFILE.facts.map((f) => `- ${f.text}`).join('\n')}\nTarget job: ${PROFILE.job.role} at ${PROFILE.job.company}: ${PROFILE.job.jobDescription}\n\nQuestion: ${question}\n\nAnswer to grade:\n${answer}\n\nScore 1-10 each: relevance (answers the question), specificity (concrete, uses the profile), grounding (10 = no invented employers, numbers or achievements), usefulness (a candidate could say this aloud). Then name the single biggest weakness in under 20 words. Reply exactly: {"relevance":N,"specificity":N,"grounding":N,"usefulness":N,"weakness":"..."}`,
          },
        ],
      });
      scores.push({ question, answer, ...JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
    }
    if (lastErr) scores.push({ question, answer, error: lastErr.message });
  }
  const good = scores.filter((s) => !s.error);
  const avg = (k) => (good.length ? +(good.reduce((n, s) => n + s[k], 0) / good.length).toFixed(2) : null);
  return { judge: JUDGE, n: good.length, relevance: avg('relevance'), specificity: avg('specificity'), grounding: avg('grounding'), usefulness: avg('usefulness'), note: 'LLM-as-judge; may favour its own model family', graded: scores };
}

// Streams a fixture to a Deepgram WebSocket at real-time pace and measures
// accuracy and how long the final transcript takes after the audio ends.
function benchDeepgram(kind, fixture) {
  return new Promise((resolve) => {
    const pcm = readWav(fixture.path);
    const params =
      kind === 'flux'
        ? 'model=flux-general-en&encoding=linear16&sample_rate=16000&eager_eot_threshold=0.5&eot_threshold=0.75&eot_timeout_ms=3000'
        : 'model=nova-3&encoding=linear16&sample_rate=16000&smart_format=true&punctuate=true&interim_results=true&endpointing=400&utterance_end_ms=1200';
    const url = `wss://api.deepgram.com/${kind === 'flux' ? 'v2' : 'v1'}/listen?${params}`;
    const ws = new WebSocket(url, ['token', KEYS.deepgram]); // same auth as the app
    ws.binaryType = 'arraybuffer';
    const chunk = kind === 'flux' ? 1280 : 1600;
    let audioEnd = 0;
    let eagerAt = 0;
    const parts = [];
    let finalText = '';
    const done = (extra) => {
      try {
        ws.close();
      } catch {}
      resolve({
        file: fixture.file,
        wer: +wer(fixture.text, finalText || parts.join(' ')).toFixed(3),
        finalAfterAudioMs: audioEnd && extra.finalAt ? Math.round(extra.finalAt - audioEnd) : null,
        eagerAfterAudioMs: audioEnd && eagerAt ? Math.round(eagerAt - audioEnd) : null,
        text: finalText || parts.join(' '),
        ...extra,
      });
    };
    const timeout = setTimeout(() => done({ error: 'timeout' }), 30000);
    ws.onerror = () => {
      clearTimeout(timeout);
      done({ error: 'connection failed (check DEEPGRAM_API_KEY; for Flux this also tests subprotocol auth on /v2)' });
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString());
      if (kind === 'flux' && msg.type === 'TurnInfo') {
        if (msg.event === 'EagerEndOfTurn' && !eagerAt) eagerAt = performance.now();
        if (msg.event === 'EndOfTurn') {
          finalText = msg.transcript;
          clearTimeout(timeout);
          done({ finalAt: performance.now() });
        }
      }
      if (kind === 'nova' && msg.type === 'Results' && msg.is_final) {
        const t = msg.channel?.alternatives?.[0]?.transcript;
        if (t) parts.push(t);
        if (msg.speech_final && audioEnd) {
          finalText = parts.join(' ');
          clearTimeout(timeout);
          done({ finalAt: performance.now() });
        }
      }
      if (msg.type === 'Error') {
        clearTimeout(timeout);
        done({ error: `${msg.code}: ${msg.description}` });
      }
    };
    ws.onopen = async () => {
      const start = performance.now();
      for (let i = 0, n = 0; i < pcm.length; i += chunk, n++) {
        const due = start + (n * chunk * 1000) / 16000;
        const wait = due - performance.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        ws.send(pcm.slice(i, i + chunk).buffer);
      }
      audioEnd = performance.now();
      // Keep sending silence so endpointing can fire, like a live call.
      const silence = new Int16Array(chunk);
      for (let k = 0; k < 40 && ws.readyState === 1; k++) {
        await new Promise((r) => setTimeout(r, (chunk * 1000) / 16000));
        ws.send(silence.buffer);
      }
    };
  });
}

async function benchWhisper() {
  const { pipeline, env } = require('@huggingface/transformers');
  const cache = process.env.MODEL_CACHE;
  if (!cache) return { skipped: 'set MODEL_CACHE to a folder with Xenova/whisper-base.en to include local Whisper' };
  env.cacheDir = cache;
  env.localModelPath = cache;
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  const asr = await pipeline('automatic-speech-recognition', 'Xenova/whisper-base.en', {
    dtype: 'q8',
    device: 'cpu',
    session_options: { enableCpuMemArena: false, intraOpNumThreads: 4, interOpNumThreads: 1 },
  });
  const rows = [];
  for (const f of fixtures()) {
    const audio = Float32Array.from(readWav(f.path), (v) => v / 32768);
    const t = performance.now();
    const text = (await asr(audio)).text.trim();
    rows.push({ file: f.file, wer: +wer(f.text, text).toFixed(3), transcribeMs: Math.round(performance.now() - t), audioS: +(audio.length / 16000).toFixed(1), text });
  }
  return { model: 'whisper-base.en q8 (CPU)', meanWer: +(rows.reduce((n, r) => n + r.wer, 0) / rows.length).toFixed(3), rows };
}

app.whenReady().then(async () => {
  // A/B prompt tests (optional): BENCH_PROMPTS=<path to another prompts.js>
  // replaces packages/core/prompts.js for this run only.
  if (process.env.BENCH_PROMPTS) {
    const real = require.resolve('../../packages/core/prompts');
    require.cache[real] = { id: real, filename: real, loaded: true, exports: require(path.resolve(process.env.BENCH_PROMPTS)) };
  }
  const ai = require('../../src/ai');
  const providers = require('../../src/providers');
  const report = {
    at: new Date().toISOString(),
    machine: `${require('os').cpus()[0].model} ×${require('os').cpus().length}`,
    set: SET,
    label: LABEL || undefined,
    note: 'Real services only. Synthetic (Windows TTS) voice for STT accuracy; real interviews will be harder.',
    llm: [],
    stt: {},
  };
  for (const target of MODELS) {
    const r = await benchLLM(ai, providers, target);
    if (!r.skipped) r.judge = await judge(ai, r);
    delete r._answers;
    report.llm.push(r);
    console.log('LLM', target.provider, target.model, r.skipped ? `skipped (${r.skipped})` : `ttft p50 ${r.warmTtftMs.p50} ms, errors ${r.errors}`);
  }
  if (process.env.BENCH_STT === '0') {
    report.stt = { skipped: 'BENCH_STT=0' };
  } else if (KEYS.deepgram) {
    for (const kind of ['nova', 'flux']) {
      const rows = [];
      for (const f of fixtures()) rows.push(await benchDeepgram(kind, f));
      const ok = rows.filter((r) => !r.error);
      report.stt[kind] = {
        meanWer: ok.length ? +(ok.reduce((n, r) => n + r.wer, 0) / ok.length).toFixed(3) : null,
        finalAfterAudioMsP50: pct(ok.map((r) => r.finalAfterAudioMs).filter((x) => x != null), 50),
        eagerAfterAudioMsP50: pct(ok.map((r) => r.eagerAfterAudioMs).filter((x) => x != null), 50),
        errors: rows.length - ok.length,
        rows,
      };
      console.log('STT', kind, JSON.stringify({ meanWer: report.stt[kind].meanWer, finalP50: report.stt[kind].finalAfterAudioMsP50, errors: report.stt[kind].errors }));
    }
  } else {
    report.stt.nova = { skipped: 'no credentials (DEEPGRAM_API_KEY)' };
    report.stt.flux = { skipped: 'no credentials (DEEPGRAM_API_KEY)' };
    console.log('STT deepgram skipped (no credentials)');
  }
  if (process.env.BENCH_STT !== '0') {
    try {
      report.stt.whisper = await benchWhisper();
      console.log('STT whisper', JSON.stringify({ meanWer: report.stt.whisper.meanWer, skipped: report.stt.whisper.skipped }));
    } catch (err) {
      report.stt.whisper = { error: err.message };
    }
  }
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `providers-${report.at.slice(0, 10)}${SET === 'tune' ? '' : `-${SET}`}${LABEL ? `-${LABEL}` : ''}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log('report:', file);
  app.exit(0);
});
