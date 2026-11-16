# Repository audit: NexQ and OpenCluely (2026-11-15)

I read shallow clones of both repositories. Nothing was installed or run.

## naxhq/NexQ

**What it is:** a meeting assistant and interview copilot for Windows, with a macOS beta.

**License:** MIT, copyright Vahid Alizadeh. Keep the copyright notice in any code you copy, and don't reuse the "NexQ" name.

**Activity:** 129 stars. Release v2.37.0 shipped 2026-11-10. Very active, with CI and signed updates.

**Stack:** Tauri 2 with a Rust backend (about 26k lines) and a React 18 / TypeScript / zustand front end.
- Audio and speech: cpal, whisper-rs, ort (ONNX), sonora (WebRTC echo cancellation).
- Storage: rusqlite with full-text search.
- System access: the `windows` crate (WASAPI, SAPI, Credential Manager).

**Audio:**
- On Windows, call audio is captured through WASAPI loopback (cpal); on macOS, through Core Audio Process Taps. There is no Linux path.
- **Echo cancellation:** it uses the call audio as a reference to remove it from the microphone (`audio/echo_cancel.rs`). This fixes duplicated transcripts when the user has no headphones. We don't have this.
- **Speech-to-text:** 11 engines.
  - Streaming cloud: Deepgram (interim results, diarization, keyterms), Deepgram Flux turn detection, Cartesia.
  - Batch cloud: Groq, OpenAI and Azure.
  - Local: whisper.cpp, Parakeet/ORT streaming, sherpa-onnx, SAPI.
  - In the browser: Web Speech.
- **Early answers:** turn signals from the provider (eager end, resumed, end) start an auto-answer early and withdraw it if the speaker carries on (`src/lib/autoAnswer.ts`).
- **Question detection:** rule-based heuristics for English, Chinese and Japanese, well covered by tests (`intelligence/question_detector.rs`). The question-detection prompt each scenario lets you edit is stored but never used.

**AI:**
- Providers: Ollama, LM Studio, OpenAI, Anthropic, Groq, Gemini (with context caching), OpenRouter, any custom endpoint, plus a "Claude subscription" mode that drives the local `claude` CLI. Check Anthropic's terms before adopting that.
- Each action (Assist, What to Say, Shorten, Follow-Up, Recap, Ask) has its own editable prompt, and there are scenario templates.
- Document search is hybrid: full-text search plus Ollama embeddings, merged with reciprocal rank fusion (`rag/search.rs`).
- It has no structured job description or candidate memory, and no screenshot/vision support.

**Extra features:**
- offline OPUS-MT translation
- meeting detection
- recording with playback
- a call log with a prompt and latency inspector
- "Ask a past meeting"

**Stealth features (we will not copy these):** it hides its window from screen capture (`WDA_EXCLUDEFROMCAPTURE` / `NSWindowSharingNone`), removes itself from the taskbar, and has a stealth cursor.

**Quality and security:**
- About 416 Rust tests and 71 TypeScript test files.
- Keys are kept in the operating system's credential store.
- Weak spots: Tauri is configured with `"csp": null`, `withGlobalTauri` and the shell capability, and some files are very large.

**Worth learning from (as design ideas, not code):**
- echo cancellation using the call audio as reference
- early answers driven by turn detection, with withdraw rules
- the question-detection heuristics
- merging interim and final transcripts (`segment_accumulator.rs`, `word_diff.rs`)
- the call-log inspector
- hybrid reciprocal-rank-fusion search

**Verdict:** the strongest reference of the six repos. It is not a foundation for us, because adopting it would mean rewriting everything in Tauri and Rust.

## TechyCSR/OpenCluely

**What it is:** a screenshot-to-Gemini helper for coding interviews.

**Activity:** 1,190 stars. The last real commit was 2026-07-29. One maintainer and no tests.

**Stack:**
- Electron 29, which is end-of-life.
- Plain JavaScript and HTML in a few files of 1,600–2,000 lines each.
- Speech: a Python openai-whisper worker that is pip-installed at runtime, or the Azure Speech SDK.

**Audio:**
- Microphone only. There is no system-audio capture, so the interviewer is only heard through the speakers.
- An energy-based voice detector with an adaptive noise floor, plus a filter for Whisper's made-up text.
- No question detection: every utterance is sent to Gemini.

**AI:**
- Gemini only, streamed, with retry and fallback to other models.
- Screenshots can be cropped to an area.
- No resume or job-description context.

**Claims that don't hold up:**
- "Auto-hide when screen sharing" doesn't work.
- "Gemini reads the audio" is misleading: only transcribed text is sent.

**Stealth and impersonation (we will not copy these):**
- `setContentProtection`
- click-through windows
- disguises itself as "Terminal", "Activity Monitor" or "System Settings", with fake names and icons

**Security problems:**
- no CSP
- DevTools left on in production builds
- unsanitized markdown written into `innerHTML`
- API keys in a plaintext `.env` file
- unsigned builds

**License:** unclear. The LICENSE file is Apache-2.0 with a blank copyright line, `package.json` says ISC, and the README badge says MIT. The name also borrows "Cluely", another company's product name.

**Verdict:** not a foundation. Its voice detection and Whisper filter are the only ideas of interest. Don't copy any code until the author settles the license.
