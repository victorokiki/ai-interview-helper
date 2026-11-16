# Repository audit: ai-interview-helper and AnswerCue (2026-11-15)

I read shallow clones of both repositories. Nothing was installed or run.

## pyk-boo/ai-interview-helper

**What it is:** a small overlay that answers interview questions from voice or a screenshot.

**License:** MIT.

**Activity:** 19 stars. Releases v2.0.0 and v2.0.1 came out 2026-10-15, and most work since then has gone into the marketing site.

**Stack:** Electron 28, which is end-of-life. The whole app is 3 files: `main.js`, `preload.js` and a 1,800-line `index.html`. There are no runtime dependencies.

**Audio:**
- Microphone only, through `getUserMedia`.
- To hear the other side, users have to install Stereo Mix, VB-Cable or BlackHole themselves.
- Each clip is recorded and sent in one batch to Groq Whisper, falling back to OpenAI Whisper and then Gemini. Nothing streams.
- There is no question detection.

**AI:**
- Seven providers, called with raw `fetch` from the window, with no streaming.
- If a provider returns a rate-limit error (429) or an empty answer, it moves to the next one.
- Context is the pasted resume plus the last 6 turns.
- Screenshots are sent to models that can read images.

**Claimed but not reachable:** the advertised auto-answer and speaker separation exist in code, but nothing in the interface calls them.

**Stealth (we will not copy this):**
- hides its window from screen capture (`setContentProtection`)
- a panic-quit key
- a disguised app name ("DOM Host")

**Security problems:**
- API keys stored in plain text in `localStorage`
- the Gemini key passed in the URL
- direct calls to the Claude API from the browser
- no CSP
- `stop.vbs` kills every Node process on the machine

**Worth learning from:** the provider-fallback loop and how it adjusts the message format for each provider.

**Verdict:** far less capable than our app. Not a foundation.

## FarzamHejaziK/AnswerCue

**What it is:** a fork of Natively (natively-cluely-ai-assistant).

**License:** AGPL-3.0. This can't go into a closed-source product. Upstream Natively moved to a non-commercial license on 2026-06-01, so merging newer upstream code would also bring in a ban on commercial use.

**Activity:** 22 stars. Release v2.8.1 came out 2026-10-04.

**Stack:**
- Electron 33, React 19, TypeScript, Vite.
- A native module written in Rust for audio capture and voice detection.
- Local storage and search: better-sqlite3 and sqlite-vec.
- Supporting libraries: keytar, transformers.js, tesseract.js (text from images) and mammoth (Word files).
- About 65,000 lines of code, with single files over 5,000 lines.

**Audio:**
- System audio is captured natively: WASAPI loopback on Windows (default playback device only), CoreAudio or ScreenCaptureKit on macOS.
- The microphone uses cpal.
- Speech-to-text is local Moonshine, running in a worker thread, with partial results every 750 ms.
- Classes for cloud speech services are imported but never used.

**Not working:**
- The speculative answering never fires, because it needs confidence of at least 0.75 and Moonshine always reports 0.7.
- The automatic trigger planner is never called, so in practice answers are manual.

**AI:**
- OpenAI, Gemini and Claude, streamed, with prompt caching.
- Separate rules for each provider about what data it may receive.
- Context blocks are tagged with how much they can be trusted.
- Screenshots and images go through a chain of fallbacks, with Tesseract to read text from images.

**Leftover upstream code:**
- Google Analytics turns on unconditionally.
- It sends an install ping to a natively.workers.dev address.
- It calls Natively's pricing and paid backend.
- It checks Gumroad licenses using a hardware fingerprint.

**Stealth (we will not copy this):**
- an "undetectable" mode
- disguise modes that pretend to be Terminal, Task Manager or Activity Monitor
- a global keyboard tap
- click-through windows

**Worth learning from (rewrite from scratch, never copy):**
- keeping the microphone and call audio as separate channels to tell speakers apart
- Moonshine as a faster local speech model
- answering early from partial transcripts, then checking the draft against the final transcript
- per-provider data-scope policies
- trust-tagged context blocks

**Verdict:** not a foundation, both because of its license and because of the leftover code above. Read it for ideas only.
