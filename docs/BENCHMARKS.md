# Benchmarks

Measured on 2026-11-15 on an Intel Core i9-13900H (20 threads), Windows 11, Electron 44.10.1, Node 24.19, over a home internet connection.

**What counts as a production number.** Rows marked *real* used real engines or real provider servers. Rows marked *local pipeline* used a fake AI server that answers instantly, so they measure only our own code. No row uses mocked results as provider performance.

## Commands

| Command | What it measures |
|---|---|
| `npm run bench:latency` | Desktop pipeline, local Whisper and early end-of-question detection. Set `MODEL_CACHE=<models folder>` to reuse a downloaded model. |
| `npm run bench:network` | Real cold vs warm connection time to each provider. No keys needed. |
| `npm run bench:providers` | Real Claude, GPT, Gemini and Deepgram: speed, accuracy, reliability, cost. Needs keys, see section 5. |
| `npm run bench:gateway` | Server-side streaming load test. |
| `node tests/bench/whisper-memory.js default` / `tuned` | ONNX Runtime settings for Whisper. |

## 1. Phase 3 results (v0.5.0 against v0.4.x)

| Measurement | v0.4 | v0.5 | Kind |
|---|---|---|---|
| Interviewer finishes (final transcript) → answer request sent | 718 ms (fixed 700 ms wait) | **3 ms** p50, 5 ms p95 | local pipeline |
| Speech ends → question text ready, local Whisper | ~2,850 ms (0.7 s silence + 1.45 s transcription + 0.7 s wait) | **~1,490 ms** (0.3 s silence + transcription; reused as the final transcript) | real (Whisper) |
| Early text matched the final question (no correction needed) | — | 3 of 3 runs | real (Whisper) |
| Whisper model load, cached | 13.8 s | **0.68 s** | real |
| Whisper process memory | ~1,700 MB | ~845 MB, and freed after 10 idle minutes | real |
| Idle app memory | 338 MB | 334 MB (an early v0.5 build used 487 MB; fixed, see below) | real |
| First request after pre-warm, saved per provider | — | Claude 93 ms, OpenAI 45 ms, Gemini 101 ms, Deepgram 229 ms | real network |

**The idle-memory regression.** A build during Phase 3 subscribed to device-change events at startup. That launched Chromium's Audio Service and Video Capture processes (about 150 MB) in an idle window. It now subscribes only during a live session, and `tests/e2e/phase3.js` checks that those services are absent at idle.

### Phase 3b (v0.6.0): cost of the new features (real)

| Feature | Cost |
|---|---|
| Echo filter (mic copies of the interviewer) | 2.3 µs per utterance |
| Meeting detection: registry query every 5 s (Windows) | 37 ms wall time (54 ms p95); 14 ms of CPU per poll, about 0.3% of one core; no extra processes kept running |
| Idle memory with meeting detection on | 339 MB (v0.5: 334 MB) |
| Question-type detection | under 1 µs (regex) |

### Echo cancellation (v0.8.0): real WebRTC AEC3 + real Whisper (`npm run bench:echo`, `tests/e2e/echo.js`)

The echo path is simulated: speakers to mic with the direct sound after 30 ms and reflections up to 200 ms, the echo about as loud as the candidate, plus low noise. Voices are synthetic TTS. The engines are real.

**Transcription of the candidate's mic (Whisper base.en):**

| Situation | Without AEC | With AEC |
|---|---|---|
| Echo only | interviewer transcribed as "Me" | 31.9 dB of echo removed |
| Taking turns: word error rate (the interviewer's question counts as wrong words) | 75% | **8%** (the remainder is "60%" written vs "sixty percent" spoken) |
| Taking turns: interviewer words leaking into "Me" | 10 | **0** |
| Both talking at once: word error rate | 73% | **36%** |
| Both talking at once: leaked interviewer words | 2 | **0** |
| No echo (headphones): word error rate | 0% | **0%** (level −0.4 dB) |

**Inside the app, in real time (`tests/e2e/echo.js`):**
- Through the worklet → worker → worklet pipeline, echo is reduced by **50–53 dB**, and the candidate's own voice level changes by only −0.2 to −0.5 dB.
- CPU: about **1.0 ms per 10 ms frame** on a background worker thread (≈10% of one core; 0 on the UI thread).
- The same library takes 0.35 ms per frame in Node. Part of the gap was denormal floats in near-silent audio, fixed with inaudible dither: 3.5 ms → 1.0 ms. The rest is most likely the worker being scheduled on this CPU's efficiency cores.

### Coding Lab (v0.7.0, real engines, from `tests/e2e/codelab.js`)

| Measurement | Result |
|---|---|
| Click "Open Coding Lab" → editor and problems ready | 357 ms |
| Python (Pyodide) first load | 1.2 s |
| Python run after load (Two Sum, 4 tests) | 7 ms |
| Reload after a runaway program is stopped | 1.0 s |
| Infinite loop stopped (Python and JavaScript) | at the 5 s limit |
| SQL run (2 tests, fresh database each) | 29 ms |
| Memory with the lab open | 699 MB total; 393 MB after closing it |
| Idle memory (lab never opened) | 339 MB, unchanged |

## 2. Desktop pipeline (`tests/bench/latency.js`)

Profile: a 3,000-word resume, a job description, 60 Interview Brain facts and 30 documents searched with BM25. The fake AI server answers instantly.

| Stage | p50 | p95 | Max |
|---|---|---|---|
| Click → request reaches the provider (prompt build, BM25, IPC, HTTP) | 2 ms | 3 ms | 8 ms |
| Provider's first byte → first word painted | 1 ms | 3 ms | 4 ms |
| Final interviewer utterance → request reaches the provider (auto-answer) | 3 ms | 5 ms | 5 ms |
| Markdown re-render per frame, 600-token answer | 2.1 ms | 6.0 ms | 8.8 ms |

Other measurements:
- Long tasks over 50 ms while streaming: **0**.
- Voice-activity detection: 12.6 µs per 100 ms audio frame.
- Question detection: 0.19 µs per utterance.

### Early end-of-question detection with real local Whisper

A 6.1 s spoken question was fed in real time, 100 ms frames, followed by 1.5 s of silence.

| Run | Early signal after speech end | Final transcript after speech end | Early text = final question |
|---|---|---|---|
| 1 | 1,509 ms | 1,509 ms | yes |
| 2 | 1,511 ms | 1,511 ms | yes |
| 3 | 1,439 ms | 1,439 ms | yes |

The final transcript arrives at the same moment because it reuses the early transcript: only silence followed, so nothing was transcribed twice.

In each run the comma pause in the middle of the question produced one early signal that was correctly withdrawn when speech resumed.

### Local Whisper accuracy (real, `tests/bench/providers.js`)

Six spoken questions in a synthetic Windows TTS voice. Real interviews will be harder.

| Model | Mean word error rate | Transcription time (4–6.4 s clips) |
|---|---|---|
| whisper-base.en q8, CPU | **2.8%** | 1.0–1.4 s |

The only errors were in one clip: "rate-lometer" for "rate limiter", and "50,000" for "fifty thousand". The second is a formatting difference counted as an error.

### Whisper memory settings (`whisper-memory.js`)

| Setting | Peak memory | Transcription |
|---|---|---|
| Default | 1,270 MB | 1.63 s |
| Memory pool off, 4 threads (shipped) | **426 MB** | **1.34 s** |

## 3. Real network: what pre-warming saves (`tests/bench/network.js`)

10 samples per provider. Unauthenticated requests, so nothing is billed. "Cold" uses a new connection (DNS, TCP and TLS); "warm" reuses one.

| Provider | Cold p50 | Warm p50 | Saved |
|---|---|---|---|
| Anthropic | 187 ms | 94 ms | 93 ms |
| OpenAI | 191 ms | 146 ms | 45 ms |
| Gemini | 192 ms | 91 ms | 101 ms |
| Deepgram | 377 ms | 147 ms | 229 ms |

The app pre-warms the selected AI provider when a session starts and every 30 s during it. Claude now goes through Chromium's network stack like the other providers, so it shares that warm connection.

## 4. Server-side streaming gateway (`tests/bench/gateway.js`)

One Node process: checks a token, builds a prompt of about 4,000 tokens, relays SSE, and meters tokens.

| Streams at once | Added time to first token, p50 / p95 | CPU (one core) | Memory |
|---|---|---|---|
| 100 | 25 / 56 ms | 21% | 68 MB |
| 1,000 | 26 / 61 ms | 64% | 141 MB |
| 2,000 | 59 / 312 ms | 95% (saturated; add a second process) | 232 MB |

## 5. Real providers

### Real runs: Claude (16 November 2026)

Real Anthropic API through the app's own code (`src/ai.js` → `src/providers.js`), from this Windows PC. Answer preset: short, confident, bullets plus script. Six interview questions (introduction, conflict, rate-limiter design, performance story, process vs thread, incident response), cycled 5 times: **30 answers per model**, 90 in total, each graded by Claude Opus 5.5. The first request is cold; the rest are warm (after pre-warming). OpenAI, Gemini and Deepgram were not run (no keys).

| Model | Warm first token p50 / p90 / p95 | Slowest | Full answer p50 | Errors | Cost per answer (approx.) |
|---|---|---|---|---|---|
| Claude Haiku 5.5 | 1,141 / 2,702 / 2,885 ms | 3.0 s | 2.7 s | 0 / 30 | $0.0002 |
| Claude Sonnet 5.5 | **655** / 1,530 / 3,731 ms | 4.2 s | 3.0 s | 0 / 30 | $0.0045 |
| Claude Opus 5.5 (app default) | 784 / 1,942 / **2,054 ms** | 2.2 s | 3.4 s | 0 / 30 | $0.0085 |

Quality, graded by Claude Opus 5.5 (1–10, average of 30 answers; the judge may favour its own model family):

| Model | Relevance | Specificity | Grounding (no invented facts) | Usefulness |
|---|---|---|---|---|
| Haiku 5.5 | 9.07 | 6.80 | 8.87 | 7.77 |
| Sonnet 5.5 | 9.17 | 6.90 | 9.17 | 8.20 |
| Opus 5.5 | 9.07 | 6.90 | **9.43** | 8.13 |

Conclusions:
- **Opus 5.5 stays the default.** It is the least likely to invent facts and has the most predictable speed (never slower than 2.2 s to the first word in 30 tries). Sonnet's typical first word is about 0.13 s sooner but its slowest 5% took up to 4.2 s.
- **Sonnet 5.5 is a good cheaper choice:** quality within about 0.3 points of Opus on every score, at a little over half the cost.
- **Haiku 5.5 is the weakest** on usefulness and grounding and was not faster here; it is only worth choosing for cost.
- Specificity was the lowest score for every model (about 6.9). The prompt change below addresses it.
- The 6-answer run earlier the same day suggested Sonnet was much faster than Opus (590 vs 1,357 ms). With 30 answers the gap is 655 vs 784 ms: the small run overstated it.
- The automatic "possible invented details" count overstates the problem (it flags the word-count label, list numbers and general facts such as HTTP status 429). Use the judge's grounding score instead.
- Costs use an estimated 1,200 input tokens per answer and output length from characters ÷ 4.

Raw results: `tests/bench/out/providers-2026-11-16-n30.json` (and the 6-answer run, `providers-2026-11-16-n6.json`).

### Answer prompt: more specific and better grounded (16 November 2026)

The grader was changed to also name each answer's biggest weakness. With the original prompt, the recurring ones were:
- technical and "how do you handle…" answers were textbook-generic, never tied to the candidate's real work;
- "[your example]" placeholders sat in the middle of the spoken answer;
- facts were stretched (a process credited with a result the profile doesn't attribute to it, longer experience than stated, invented recovery steps);
- the weakest fact was picked (no-shows cited for a conversion question);
- "why this company" restated the job description.

Changes (`packages/core/prompts.js`):
- the grounding rule now covers actions, causes and outcomes, says to use each fact as stated, and to draw on the closest real experience before writing a placeholder;
- the live role asks for the candidate's real employer, systems, tools and numbers, ties technical answers to real experience, links "why us" to concrete job needs without unsupported claims about the company, picks the facts that match the question, never implies unshown scale, and puts key facts in the spoken part;
- the behavioral, technical, system-design and motivation guides were adjusted to match.

Method: Claude Opus 5.5 (the default), short preset, 18 answers per prompt per profile, graded by Opus. Three profiles:
- the original backend engineer ("tune", used to find the problems);
- a product manager ("holdout"; its weaknesses were read after the first revision, so it is only partly unseen);
- a data analyst ("fresh"; added after the last change was written, never used for tuning).

| Profile | Prompt | Relevance | Specificity | Grounding | Usefulness | Placeholders in 18 answers |
|---|---|---|---|---|---|---|
| Backend (tune) | before | 8.94 | 6.17 ±0.35 | 9.11 ±0.25 | 7.61 | 3 |
| | **after** | 8.61 | **6.94** ±0.34 | **9.39** ±0.14 | 7.61 | 0 |
| Product (holdout) | before | 8.78 | 7.33 ±0.18 | 8.78 ±0.19 | 7.56 | 3 |
| | **after** | 8.56 | 7.44 ±0.22 | **9.39** ±0.14 | 7.83 | 0 |
| Data analyst (fresh) | before | 8.89 | 7.89 ±0.18 | 8.61 ±0.23 | 8.00 | 0 |
| | **after** | 8.94 | 8.22 ±0.25 | **9.33** ±0.18 | 8.00 | 0 |

(± is the standard error of the mean.)

Result:
- **Grounding** (fewer invented or stretched facts) improved on all three profiles: +0.28, +0.61 and +0.72. On the two profiles not used for tuning this is about 2.5 standard errors, a clear gain.
- **Specificity** rose on all three (+0.77, +0.11, +0.33). The direction is consistent, but each gain alone is within about 1.6 standard errors.
- **Placeholders** left in the spoken answer: 6 in 54 answers before, 0 after.
- **Relevance** fell slightly on two profiles (−0.33, −0.22) and rose on one (+0.05). This is the cost to watch; the tie-in sentence occasionally pulls an answer off the question.
- Answer length grew by 5–19 words on average; time to first word did not change measurably.
- Much of the remaining specificity criticism asks for details the test profiles do not contain (how a manager was persuaded, a specific incident). The app should not invent those, so specificity has a ceiling set by what the user puts in their profile.

An intermediate version (without the "matching facts", "unshown scale" and "spoken part" rules) scored between the two on every profile.

Raw results: `tests/bench/out/providers-2026-11-16-*{baseline,specific,v1,v2}.json` ("specific" and "v1" are the intermediate version).

### Autonomous Job Kit: answers consistent with what was sent (16 November 2026)

`npm run bench:jobkit` (`tests/bench/jobkit.js`) reads the Job Kit test folder through the app's own importer, then asks Claude Opus 5.5 six interview questions for the Northwind job twice: without and with the `<application_sent>` block (résumé, cover letter, form answers, an edit made before submitting, known gaps). Same résumé, facts and job in both arms. A Claude Opus 5.5 judge scored each answer against what was sent.

| Without → with | Result |
|---|---|
| Consistency with what was sent (1–10) | 7.67 → **9.5** |
| Answers contradicting what was sent | 1 → **0** |
| Answers claiming a gap (Snowflake, dbt, Tableau) | 0 → 0 |
| Median time to first word | 2.04 s → 1.99 s |
| Average words | 118 → 114 |

- **Salary:** without the block, the answer gave the profile's $60,000–$65,000 range. The form had been edited to $62,000 before submitting, and with the block the answer said "On my application I put $62,000". This was the one contradiction (consistency 3 → 9).
- **"Why Northwind":** with the block, the answer reused the reasons from the written answer the employer has (7 → 10).
- **Gap question:** both arms answered honestly; with the block the answer used the kit's suggested framing (PostgreSQL, learning dbt).
- **Caveats:** one run of 6 questions per arm, so treat the sizes as indicative. In this run the judge was not given the job posting or the profile facts, so it wrongly marked real details (the posted pay range, hybrid work, citizenship) as invented in both arms. Grounding scores from this run are not reported for that reason; the script now gives the judge both. About $1 of API usage.

Raw results: `tests/bench/out/jobkit-2026-11-16.json`.

### How to run

`npm run bench:providers` sends real requests through the app's own code. It skips any provider without a key and never simulates one.

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` | AI providers |
| `DEEPGRAM_API_KEY` | Deepgram Nova-3 and Flux |
| `BENCH_MODELS` (optional) | Default: `anthropic:claude-haiku-5-5,anthropic:claude-sonnet-5-5,anthropic:claude-opus-5-5,openai:gpt-5-mini,gemini:gemini-2.5-flash` |
| `BENCH_RUNS` (optional) | Default 6 runs per model |
| `BENCH_JUDGE` (optional) | Default `claude-opus-5-5` |
| `MODEL_CACHE` (optional) | Folder with a downloaded Whisper model, to include local Whisper |
| `BENCH_SET` (optional) | `tune` (default), `holdout` or `fresh`: which test profile and questions to use |
| `BENCH_PROMPTS` (optional) | Path to another `prompts.js`, to compare prompt versions in one go |
| `BENCH_LABEL` (optional) | Added to the report file name |
| `BENCH_STT` (optional) | `0` skips speech-to-text |

What it reports:

**AI models:**
- time to first token, cold and warm
- total time
- approximate output speed
- error rate
- possible invented details per answer (numbers or names not in the profile)
- approximate cost per answer (Claude prices from the research file; OpenAI and Gemini only if you set `BENCH_PRICES`)
- optional judge scores for relevance, specificity, grounding and usefulness, with a note that the judge may favour its own model family

**Speech to text:**
- word error rate
- time to final transcript after the audio ends
- for Flux, time to the early end-of-turn signal

The Flux run also confirms whether the browser-style login that the app uses for `/v2/listen` works. Deepgram's documentation doesn't state it.

Results are saved to `tests/bench/out/providers-<date>.json`.
