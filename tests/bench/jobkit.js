// Real-provider check of the Autonomous Job Kit import: does attaching what
// the candidate sent (résumé, letter, form answers, edits, gaps) make live
// answers consistent with it? Same questions, two arms: without and with the
// <application_sent> block, both through the app's own code (src/jobkit.js
// reads the fixture folder; src/ai.js answers). A Claude judge scores each
// answer against what was actually sent.
//
//   ANTHROPIC_API_KEY=... npx electron tests/bench/jobkit.js
//   BENCH_MODEL (default claude-opus-5-5), BENCH_JUDGE (default claude-opus-5-5)
//
// Writes tests/bench/out/jobkit-<date>.json. Costs roughly $1 with Opus.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.BENCH_MODEL || 'claude-opus-5-5';
const JUDGE = process.env.BENCH_JUDGE || 'claude-opus-5-5';
const FOLDER = path.join(__dirname, '..', 'fixtures', 'jobkit', 'job-search');
const out = path.join(__dirname, 'out');
app.setPath('userData', path.join(out, 'jobkit-userdata'));

// The candidate's general (master) résumé and profile facts, as the app has them.
const RESUME = `Alex Morgan Tremblay, Halifax, NS
Data Analyst, Harbourline Logistics (Jun 2024 to Present)
- Cut weekly shipment reporting from 6 hours to 40 minutes by automating data pulls with Python and SQL.
- Reduced duplicate customer records by 18% by writing validation rules for a 120,000-row CRM migration.
Operations Assistant, Bluenose Outfitters (Sep 2022 to May 2024)
- Reconciled point-of-sale and stock counts for 900+ products each month.
Bachelor of Commerce, Business Analytics, Atlantic Coast University (2019 to 2023)
Skills: Python, SQL, Excel, Power BI, Git, Salesforce`;

const QUESTIONS = [
  'What are your salary expectations?',
  'Why do you want to work at Northwind Freight?',
  'Tell me about a time you improved data quality.',
  'Have you worked with Snowflake or dbt?',
  'When could you start?',
  'Walk me through your resume.',
];

async function judge(providers, context, sentSummary, question, answer) {
  const config = { provider: 'anthropic', anthropicKey: KEY, anthropicModel: JUDGE };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await providers.streamText(config, {
        system: 'You grade interview-copilot answers strictly. Reply with JSON only.',
        effort: 'medium',
        maxTokens: 2000,
        parts: [
          {
            type: 'text',
            text: `The candidate's true facts:\n${RESUME}\n${context.facts}\n\nThe job posting (true facts about the role and employer):\n${context.jobDescription}\n\nWhat the candidate already SENT this employer (the interviewer has it):\n${sentSummary}\n\nQuestion: ${question}\n\nAnswer to grade:\n${answer}\n\nScore 1-10 each:\n- consistency: 10 = matches what was sent wherever it overlaps (same salary figure, start date, stories, numbers, wording of their reasons); 1 = contradicts it. If the question doesn't touch what was sent, score how well it avoids contradicting it.\n- grounding: 10 = no invented employers, numbers, tools or achievements.\n- usefulness: a candidate could say this aloud and it helps them.\nAlso: "contradicts" = true if anything contradicts what was sent; "claimsGap" = true if it claims experience with Snowflake, dbt or Tableau. Then the single biggest weakness in under 20 words.\nReply exactly: {"consistency":N,"grounding":N,"usefulness":N,"contradicts":bool,"claimsGap":bool,"weakness":"..."}`,
          },
        ],
      });
      return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    } catch (err) {
      if (attempt) return { error: err.message };
    }
  }
  return null;
}

const mean = (xs) => (xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : null);

app.whenReady().then(async () => {
  if (!KEY) {
    console.log('Set ANTHROPIC_API_KEY to run this benchmark.');
    return app.exit(0);
  }
  const jobkit = require('../../src/jobkit');
  const Kit = require('../../packages/core/jobkit');
  const ai = require('../../src/ai');
  const providers = require('../../src/providers');
  const plan = await jobkit.plan(FOLDER);
  const nw = plan.items.find((i) => i.app.company === 'Northwind Freight').app;
  const job = Kit.mergeJob(null, nw);
  const facts = Kit.profileFacts(JSON.parse(fs.readFileSync(path.join(FOLDER, 'profile.json'), 'utf8')))
    .filter((f) => f.suggested)
    .map((f) => ({ category: f.category, text: f.text }));
  const block = Kit.applicationBlock(job.application, job);
  const base = {
    provider: 'anthropic',
    anthropicKey: KEY,
    anthropicModel: MODEL,
    resume: RESUME,
    facts,
    job,
    preset: { length: 'short', tone: 'confident', format: 'bullets-script' },
  };
  // The judge sees everything the answers may use. (In the 16 Nov 2026 run it
  // lacked the posting and facts, so its grounding scores were too harsh.)
  const judgeContext = { facts: facts.map((f) => `- ${f.text}`).join('\n'), jobDescription: job.jobDescription };
  const arms = { without: { ...base, applicationBlock: '' }, with: { ...base, applicationBlock: block } };
  const results = { without: [], with: [] };
  await providers.prewarm(base);
  for (const question of QUESTIONS) {
    for (const [arm, config] of Object.entries(arms)) {
      const t0 = performance.now();
      let first = 0;
      const answer = await ai.answerQuestion({ config, question, transcript: [] }, () => {
        if (!first) first = performance.now();
      });
      const ttftMs = Math.round(first - t0);
      const score = await judge(providers, judgeContext, block, question, answer);
      results[arm].push({ question, ttftMs, words: answer.split(/\s+/).length, answer, ...score });
      console.log(`${arm.padEnd(7)} ${question.slice(0, 40).padEnd(40)} ${JSON.stringify(score && { c: score.consistency, g: score.grounding, u: score.usefulness, x: score.contradicts, gap: score.claimsGap })}`);
    }
  }
  const summary = Object.fromEntries(
    Object.entries(results).map(([arm, rows]) => {
      const ok = rows.filter((r) => !r.error);
      return [arm, {
        consistency: mean(ok.map((r) => r.consistency)),
        grounding: mean(ok.map((r) => r.grounding)),
        usefulness: mean(ok.map((r) => r.usefulness)),
        contradictions: ok.filter((r) => r.contradicts).length,
        claimedGaps: ok.filter((r) => r.claimsGap).length,
        ttftMsMedian: ok.map((r) => r.ttftMs).sort((a, b) => a - b)[Math.floor(ok.length / 2)],
        words: mean(ok.map((r) => r.words)),
        judged: ok.length,
      }];
    }),
  );
  console.log(JSON.stringify(summary, null, 2));
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `jobkit-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(file, JSON.stringify({ model: MODEL, judge: JUDGE, date: new Date().toISOString(), blockChars: block.length, summary, results }, null, 2));
  console.log('wrote', path.relative(process.cwd(), file));
  app.exit(0);
});
