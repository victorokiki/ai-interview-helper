const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../packages/core/career');
const { toDocx } = require('../../src/exporter');

const JD =
  'Senior Backend Engineer. You will build high-throughput APIs in Go and Kafka. Experience with Kubernetes, AWS and PostgreSQL. Kafka streaming at scale; Go services; on-call for distributed systems. CI/CD with GitHub Actions. distributed systems design.';

test('keyword coverage finds repeated terms and product names, ignores filler', () => {
  const r = C.keywordCoverage(JD, 'Built Go services on Kafka and PostgreSQL; AWS migrations; set up CI/CD.');
  const t = Object.fromEntries(r.terms.map((x) => [x.term, x.inResume]));
  assert.equal(t.go, true);
  assert.equal(t.kafka, true);
  assert.equal(t['ci/cd'], true);
  assert.equal(t.kubernetes, false);
  assert.equal(t.distributed, false);
  assert.ok(!('experience' in t) && !('senior' in t) && !('with' in t));
  assert.equal(r.coverage, Math.round((r.terms.filter((x) => x.inResume).length / r.terms.length) * 100));
});

test('keyword coverage with no job description', () => {
  assert.deepEqual(C.keywordCoverage('', 'anything'), { terms: [], coverage: null });
});

test('match line is parsed and hidden while streaming', () => {
  assert.equal(C.splitMatch('MATC').body, '');
  const s = C.splitMatch('MATCH overall=72 skills=80 experience=70 impact=60\n### Strengths\n- x');
  assert.deepEqual(s.match, { overall: 72, skills: 80, experience: 70, impact: 60 });
  assert.equal(s.body, '### Strengths\n- x');
  assert.equal(C.splitMatch('No match line').match, null);
  assert.equal(C.splitMatch('MATCH overall=140\nx').match.overall, 100);
});

test('cited markdown numbers sources once and lists them', () => {
  const { markdown, sources } = C.citedMarkdown([
    { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'contoso' } },
    { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: 'https://a.com', title: 'A' }] },
    { type: 'text', text: 'Contoso builds cloud tools.', citations: [{ type: 'web_search_result_location', url: 'https://a.com', title: 'A', cited_text: 'x' }, { type: 'web_search_result_location', url: 'https://b.com', title: 'B [beta]' }] },
    { type: 'text', text: ' It was founded in 2010.', citations: [{ type: 'web_search_result_location', url: 'https://a.com', title: 'A' }] },
    { type: 'text', text: '\n\n## Compensation\nNot found.' },
  ]);
  assert.equal(sources.length, 2);
  assert.match(markdown, /cloud tools\. \[1\] \[2\] It was founded in 2010\. \[1\]/);
  assert.match(markdown, /## Sources\n1\. \[A\]\(https:\/\/a\.com\)\n2\. \[B beta\]\(https:\/\/b\.com\)$/);
});

test('every tool prompt exists; grounding rule forbids invented details', () => {
  for (const tool of Object.keys(C.TOOLS)) assert.ok(C.careerPrompt(tool, { company: 'Contoso', role: 'SRE' }).length > 100, tool);
  assert.match(C.CAREER_ROLE, /never invent employers, titles, dates/);
  assert.match(C.careerPrompt('check', { coverage: C.keywordCoverage(JD, 'Go') }), /keyword_coverage coverage="\d+%"/);
  assert.match(C.careerPrompt('research', { company: 'Contoso', role: 'SRE' }), /Research Contoso for a candidate interviewing for SRE/);
  assert.match(C.careerPrompt('followup', {}), /No recorded interview/);
  assert.throws(() => C.careerPrompt('nope'), /Unknown career tool/);
});

test('Word export keeps headings, bullets, bold and link text (read back with mammoth)', async () => {
  const buf = await toDocx('# Jordan Lee\n\n## Experience\n- Cut latency **60%** with [Kafka](https://kafka.apache.org)\n- Led a team of 6\n\n1. First step\n\nA *closing* paragraph\nover two lines.', 'Test');
  assert.equal(buf.slice(0, 2).toString(), 'PK');
  const mammoth = require('mammoth');
  const { value: html } = await mammoth.convertToHtml({ buffer: buf });
  assert.match(html, /<h1>Jordan Lee<\/h1>/);
  assert.match(html, /<h2>Experience<\/h2>/);
  assert.match(html, /<li>Cut latency <strong>60%<\/strong> with <a href="https:\/\/kafka\.apache\.org">Kafka<\/a><\/li>/);
  assert.match(html, /1\. First step/);
  assert.match(html, /A <em>closing<\/em> paragraph over two lines\./);
});
