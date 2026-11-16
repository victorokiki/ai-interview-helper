# Technical and feature audit

Last updated: 2026-11-15, with the app at v0.4.0.

The full notes for each repository are in [research/](research/):
- [repo-audit-1.md](research/repo-audit-1.md): NexQ and OpenCluely
- [repo-audit-2.md](research/repo-audit-2.md): DeepInterview and interview-copilot
- [repo-audit-3.md](research/repo-audit-3.md): ai-interview-helper and AnswerCue

Prices are in [research/pricing-2026-11-15.md](research/pricing-2026-11-15.md).

## 1. Repository comparison

All six projects were read from shallow clones on 2026-11-15. None was installed or run.

| | NexQ | OpenCluely | DeepInterview | interview-copilot | ai-interview-helper | AnswerCue | **Ours (v0.4.0)** |
|---|---|---|---|---|---|---|---|
| Kind of product | Live copilot | Screenshot solver | Web mock interviewer | Live copilot | Overlay | Live copilot (Natively fork) | Live copilot and prep |
| Shell | Tauri 2 + Rust | Electron 29 (end-of-life) | Next.js 16 + FastAPI | Electron 44 + .NET 10 | Electron 28 (end-of-life) | Electron 33 + Rust module | **Electron 44** |
| System audio | WASAPI / Core Audio taps (Rust) | None | None (mic over LiveKit) | Chromium loopback | None (needs Stereo Mix) | WASAPI / ScreenCaptureKit (Rust) | **Chromium loopback, no native code** |
| Speech to text | 11 engines, streaming | Python Whisper / Azure | Deepgram / Soniox / Whisper (on the server) | Local Whisper / Deepgram (final text only) | Batch Groq/OpenAI | Local Moonshine | **Deepgram streaming / in-process Whisper** |
| Question detection | Rules, well tested | None | Not applicable | Rules + 8-type classifier | None | Regex (auto-answer never fires) | Rules + waits for the interviewer to finish |
| AI providers | 9 + Claude CLI | Gemini only | Gemini / OpenAI / compatible | 4 | 7, no streaming | 3 working | **Claude / OpenAI / Gemini / Ollama, streaming** |
| Knowledge and RAG | FTS + embeddings (RRF) | None | Naive keyword search | Keyword overlap | Pasted resume | sqlite-vec | **BM25 + verified facts + job workspaces** |
| Mock interviews and scoring | No | No | **Yes: rubric + second-pass check** | One number from a regex | No | No | **8 types, 5 scored skills, speech metrics** |
| Stealth features | Yes | Yes, plus impersonating OS apps | No | Light | Yes | Yes, plus disguise modes | **None, by design** |
| Tests | ~490 | 0 | ~280 | ~860 | 0 | ~175 (CI runs 1) | 44 end-to-end checks |
| License | MIT | Unclear (Apache file, ISC, MIT badge) | Apache-2.0 | MIT (QuestPDF dependency is not free above a revenue cap) | MIT | **AGPL-3.0, can't use in closed source** | Proprietary (yours) |
| Activity | Very active | Stalled since Jul 2026 | Active | About 1 month old | Mostly marketing site | Stalled since Oct 2026 | Active |

### Recommendation on a foundation

**Keep our codebase as the foundation.** None of the six is a better base for a commercial product.

- **NexQ** is the most capable live copilot. Adopting it would mean rewriting in Rust and Tauri, and its loopback, speech and LLM layers took about 26,000 lines of Rust to build. We already capture system audio with roughly 20 lines of Electron code (`setDisplayMediaRequestHandler` with `audio: 'loopback'` in [src/main.js](../src/main.js)).
- **interview-copilot** is a parallel version of our own architecture. It adds a .NET process, which we don't need, and it has the security issues listed in its audit note.
- **DeepInterview** is a different product (a web mock interviewer on LiveKit and Python) with no system audio.
- **AnswerCue** is AGPL-3.0, and its upstream has since moved to a non-commercial license. **OpenCluely**'s license is ambiguous. **ai-interview-helper** is far less capable than ours.

**No code is copied from any of them.** These ideas are worth re-implementing in our own code:

| Idea | Seen in | Phase |
|---|---|---|
| Echo cancellation that uses the call audio as reference, so users without headphones don't get duplicate transcripts | NexQ `audio/echo_cancel.rs` | 3 |
| Starting an answer early on interim text and withdrawing it if the speaker continues | NexQ `autoAnswer.ts`, AnswerCue | 3 |
| Classifying question types, letting the user pin one, and giving guidance per type; Shorter / Longer / Regenerate | interview-copilot `QuestionClassifier.cs`, `AnswerPromptBuilder.cs` | 3 |
| Detecting a meeting from the Windows microphone consent store | interview-copilot `meeting-detection.ts` | 3 |
| A second, sceptical pass that rechecks weak scores | DeepInterview `post/verifier.py` | 3 |
| Question banks by role and level, with YAML front matter (the format only; the content is ours) | DeepInterview `skills/` | 4 |
| Prep chain: CV → job description → gap analysis → question plan | DeepInterview `prep/` | 4 |
| Importing a job posting from a URL safely (SSRF guard) | interview-copilot `SafeWebPageFetcher.cs` | 4 |
| Per-provider rules on what data may be sent | AnswerCue | 5 |
| Hybrid search (keyword + embeddings, merged by RRF) | NexQ `rag/search.rs` | 5 (with pgvector) |

**Things we deliberately leave out:**
- stealth features: capture exclusion, click-through, disguised process names
- reading keys back in the renderer
- trusting whatever answers on a fixed local port
- analytics or telemetry that turns on by default

## 2. Feature inventory against the brief

**Done** means it is implemented and covered by the end-to-end tests in `docs/TESTING.md`. **Partial** means part of it exists. **Missing** means not started. **Later** means it needs the cloud platform (Phase 5).

### Core interview copilot

| Feature | Status | Evidence / notes |
|---|---|---|
| Live microphone and system-audio transcription | Done | `src/renderer/transcriber.js`, `src/main.js` (loopback) |
| Automatic question detection | Done | `looksLikeQuestion` + `answerWhenQuiet` in `src/renderer/app.js` |
| Contextual answer suggestions | Done | `answerQuestion` in `src/ai.js` |
| Personalized with resume and job description | Done | `profileSystem` in `src/ai.js`, `src/jobs.js` |
| Recognizes follow-up questions | Done (v0.5) | A follow-up sentence within 2.5 s corrects the running answer (`packages/core/speculation.js`); the transcript gives context |
| Conversation context and memory | Partial | Memory within a session works. Memory across sessions is Phase 4. |
| Adjustable length and tone | Done (v0.4) | `src/presets.js`, `styleGuide` in `src/ai.js` |
| Manual and automatic modes | Done | Auto-answer toggle, Answer now, `Ctrl+Shift+Enter` |
| Streaming answers with low latency | Done | Streaming for every provider; `effort: low` for live answers |
| Multilingual transcription | Done | Deepgram `multi`, multilingual Whisper |
| Translation | Done (v0.4) | `translateText` in `src/ai.js`, `translateLine` in `src/renderer/controls.js` |
| Custom prompts and reusable presets | Done (v0.4) | Presets with your own instructions |
| Choice of AI model | Done | Settings → AI model |
| Session recording with explicit consent | Done (v0.4) | `src/recordings.js`; the consent dialog in `src/renderer/controls.js` |
| Transcripts and searchable history | Done (v0.4) | `searchSessions` in `src/store.js`; search box in Progress |
| Screen and document analysis with explicit permission | Done | Screenshots only happen when you trigger them (`Ctrl+Shift+S`) |
| Desktop interface | Done | Windows. macOS is untested and its loopback needs a native module. |
| Web interface | Later | Next.js app in Phase 5 |

### Mock interviews and coaching

| Feature | Status | Evidence / notes |
|---|---|---|
| Behavioral, technical, system design, data/SQL/ML, recruiter, product case, salary | Done | `SCENARIOS` in `src/ai.js` |
| Multi-agent panel interviews | Done (v0.6) | 4 panelists with their own focus, voice and follow-ups |
| Adaptive difficulty | Done (v0.6) | `nextDifficulty` in `packages/core/coaching.js` |
| Real-time speech coaching | Done (v0.6) | Live meter while recording, plus a full delivery report after each answer |
| Personalized feedback, scores, recommendations | Done | Scores 5 skills; feedback sticks to your facts |
| Progress tracking | Done | Progress tab |
| Replay and review of mock interviews | Partial | Live sessions can be replayed. Recording mock answers is Phase 3. |

### Technical interview tools (Coding Lab)

| Feature | Status |
|---|---|
| Monaco editor, Python/SQL/JS, safe code execution, automated tests, error explanations, complexity analysis, step-by-step hints, challenge library, SQL exercises, technical progress report | Done (v0.7): Coding Lab (`src/lab.js`, `src/renderer/codelab.js`, `src/renderer/runners/`) |
| System design diagram analysis; more languages | Missing (Phase 3d). Screenshots already handle diagrams. |

### Candidate intelligence and career tools

| Feature | Status | Evidence / notes |
|---|---|---|
| Resume parsing from PDF and DOCX | Done | `fileToText` in `src/ai.js` (unpdf, mammoth) |
| Extracting a candidate profile; personal knowledge base | Done | Interview Brain (`src/brain.js`), documents (`src/docs.js`) |
| Answers grounded in verified information | Done | The `GROUNDING` rule plus `<verified_facts>` |
| Job application tracker | Partial | Jobs have a stage and an interview date. Contacts, deadlines and follow-ups are Phase 4. |
| Follow-up email | Partial | A thank-you note is part of the post-call summary. A standalone generator is Phase 4. |
| Resume checker, tailored resume (PDF/DOCX), job-description matching, company research with sources (including cited pay ranges), cover letter, LinkedIn, follow-up email | Done (v0.9): career tools in Jobs (`packages/core/career.js`, `src/artifacts.js`, `src/exporter.js`) |
| Question bank, company-specific prep plan, career recommendations | Done (v0.10): prep plan feeding Mock, question bank and next steps in Progress (`packages/core/bank.js`, `coaching.js` `learningPath`) | |

### Beyond the competitors

| Feature | Status |
|---|---|
| AI Interview Brain | Done |
| Advanced performance analytics | Partial (Progress tab; deeper analysis in Phase 4) |
| Recording, replay and review | Partial (live sessions done) |
| User control over privacy, retention and deletion | Done (v0.4) |
| Specialized agents, live answer-quality feedback, learning pathways, cited company research, memory across sessions, browser extension, VS Code extension, MCP server, mobile companion | Partly done: cited company research (v0.9), learning path and read-only MCP server (v0.10), browser extension for job import (v0.11), memory across sessions as lessons you approve (v0.12). VS Code extension and mobile are still missing (Phases 5–6) |

### UI and UX

| Requirement | Status |
|---|---|
| Inter typeface | Done (v0.4); bundled locally (`@fontsource-variable/inter`, OFL) |
| Light and dark modes | Done (v0.4); follows Windows or set by hand |
| Consistent icons | Done (v0.4); inline SVG line icons |
| Keyboard focus states, reduced motion | Done (v0.4) |
| No horizontal scrolling | Done; tested on every tab at a 380 px window |
| A design system shared across desktop, web and mobile | Partial. CSS tokens are in place; a shared component package comes with the web app (Phase 5). |


## Final Round AI comparison (November 2026)

Read from finalroundai.com (home and pricing pages; there is no feature comparison table, only Free and Pro lists).

| Category | Final Round AI | Interview Helper (v0.15.0) | Status |
|---|---|---|---|
| General interview copilot | Live Interview CoPilot (Pro) | Live tab: transcription of both sides, question detection, early drafts with corrections, typed answers per question type | Exists |
| Mock interviews | Practice interviews, 8 scenarios | 8 practice types plus mixed, panel of 4, adaptive difficulty, voice or text, 5 scores, stronger answer, prep plan questions | Exists |
| Coding | Screen Help (auto-capture, "Solve screen") | Coding Lab (14 problems, sandboxed Python/JS/SQL, hints, reviews), screenshot solver (hotkey) | Exists; no automatic screen capture (deliberately manual) |
| System design | Recognised in live calls and practice | System design practice type, answer guide for the type, screenshot solve | Exists; no whiteboard |
| ChatGPT / Claude / Gemini | Not named | OpenAI, Anthropic (Claude), Google Gemini, Ollama (local) | Exists; Claude measured with real calls (0 errors in 90; warm first token 0.7–1.1 s typical), GPT and Gemini not yet measured |
| Zoom / Meet / Teams | Supported | System audio capture works with any app (verified: hears a browser tab's audio); meeting detection fixed for current Windows 11 (verified with a Chrome tab) | Exists; desktop Zoom/Teams calls not tested |
| Technical interview prep | Use-case pages | Coding Lab, technical practice, company research, prep plan, question bank, learning path | Exists |
| Interview reports | Automatic AI debrief | Post-call summary (what went well, what to improve, follow-ups, thank-you note), mock feedback, Progress | Exists |
| Question bank | Not named | Every question asked or practised, merged, best score, filter, Practise | Exists |
| Stealth Mode (hidden from screen sharing) | On by default | Not built, by product rule. Settings states the window is visible in shares and recordings and previews what others see | Declined |
| Spoken languages | 76 | Deepgram/Whisper languages plus live translation | Partial |
| HireVue / one-way, phone screens | Supported | Live tab works for any audio; no HireVue-specific flow | Partial |
