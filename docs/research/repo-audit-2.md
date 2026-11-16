# Repository audit: DeepInterview and interview-copilot (2026-11-15)

Read from shallow clones of each repository. Nothing was installed or run.

## ngoanpv/DeepInterview

**What it is:** a voice mock interviewer that runs in the browser. It does not help during a real interview.

**License:** Apache-2.0.

**Activity:** 72 stars. Last commit on main was 2026-09-18; release v0.3.0. One main maintainer.

**Stack:** a pnpm/turbo monorepo.
- Next.js 16 / React 19 / Tailwind 4 web app.
- Python 3.11 FastAPI agent using LangGraph and LiveKit Agents.
- A LightRAG sidecar, which by default is just naive keyword search.
- Shared contracts written in TypeScript with Pydantic copies.

**Audio:** microphone only, sent over LiveKit WebRTC. There is no system-audio capture, and it needs a LiveKit server.
- Speech-to-text runs on the server: Deepgram Nova-3 (Nova-2 for some languages), Soniox, or local Whisper through an OpenAI-compatible server with Silero VAD.
- End of turn is detected semantically (LiveKit's MultilingualModel). The candidate can only interrupt after 3 or more words.

**AI:** Gemini, OpenAI or any OpenAI-compatible server.
- Structured output comes from a JSON schema placed in the prompt, then tolerant parsing and Pydantic checks.
- Preparation runs as a LangGraph chain: CV, job description, company research (Tavily/Exa), gap analysis, then a question plan built from `skills/*.md` question packs.
- The live prompt is kept small: a 120-word candidate summary plus the current question, moved along by tool calls.
- After the interview it scores each answer 0–5 against a rubric. An optional second pass rechecks weak scores more sceptically (`post/verifier.py`).
- Filler words are estimated by the model, not measured.

**Not finished:**
- Avatars and the prep coach are incomplete.
- Adaptive difficulty is a word-count heuristic and is off by default.
- Sessions are kept in memory unless Supabase is set up.

**Quality and security:** about 200 Python tests and about 74 TypeScript tests, with CI. The agent API is open by default (the internal API secret is optional).

**Worth learning from:**
- The rubric prompts and the second-pass score check.
- The question-bank format and content in `skills/`.
- The CV → job description → gap → question-plan chain.
- The tolerant JSON parser.

**Verdict:** not a foundation for us. It is a different kind of product: Python, LiveKit, browser only, no system audio. Its license is compatible with a closed-source product as long as we keep the LICENSE and NOTICE files.

## ukez15/interview-copilot

**What it is:** a live interview copilot. Its architecture is almost the same as ours.

**License:** MIT.

**Activity:** created 2026-10-16; 5 stars. Largely AI-generated.

**Stack:**
- Electron 44 with TypeScript.
- React 19, Radix, Tailwind 4 and Vite.
- A .NET 10 ASP.NET backend running as a second local process on 127.0.0.1:5480, using EF Core with SQLite and Whisper.net.
- A Manifest V3 browser extension.

**Audio:** the same approach as ours.
- System audio comes from `setDisplayMediaRequestHandler` with loopback audio; the microphone from `getUserMedia`.
- An AudioWorklet produces 16 kHz PCM16, which goes to the backend over a WebSocket.
- Speech-to-text is local Whisper small.en, run per segment and cut by an energy VAD. Deepgram is available but off by default and only returns final text.
- System audio works on Windows only.

**Question detection:** a heuristic, plus a keyword classifier that sorts questions into 8 types. A type the user pins is only overridden above 0.8 confidence.

**AI:** Ollama, Anthropic, OpenAI or Google.
- Prompts are built from length, framework, guidance for the question type, the user's prompt, document excerpts and the transcript.
- Answers can be regenerated or made shorter or longer.
- Document retrieval is plain keyword overlap.
- There is no verified-facts memory and no screenshot support.

**Practice scoring:** a single number pulled out with a regex.

**Quality:** strong. About 530 .NET tests and 333 TypeScript tests, a coverage gate, an SSRF guard on fetching job descriptions from a URL, and safeStorage for keys.

**Security problems:**
- Decrypted API keys are returned to the renderer.
- It trusts whatever answers on port 5480.
- The bearer token is passed in the query string.

**License catch:** its PDF export uses QuestPDF's Community license, which is free only below a revenue threshold.

**Worth learning from:**
- Detecting a meeting from the Windows microphone consent store (`meeting-detection.ts`).
- Classifying questions by type, pinning a type, and guidance for each type.
- Shorter, Longer and Regenerate rewrites.
- Importing a job description safely from a URL.
- Deepgram reconnect and drain handling.
- Its testing discipline.

**Verdict:** not a foundation for us. It is a parallel version of our own architecture, and we are ahead on retrieval, the Interview Brain, job workspaces, scoring, speech metrics and running Whisper in-process. MIT is compatible with a closed-source product; leave QuestPDF out.
