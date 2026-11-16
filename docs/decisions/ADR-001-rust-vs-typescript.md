# ADR-001: Rust-first or TypeScript-first

**Status:** accepted 2026-11-15. You chose TypeScript and Electron; Rust only for native components where a benchmark shows a meaningful gain.
**Evidence:** [BENCHMARKS.md](../BENCHMARKS.md), [AUDIT.md](../AUDIT.md), [research/](../research/)

## Context

A suggested stack proposed:
- **Desktop:** Tauri 2 + Rust
- **Backend:** Rust + Axum/Tokio
- **Mobile:** React Native (or Tauri mobile)
- **Web:** Next.js
- **AI:** Python or TypeScript

It said to "choose the simplest architecture that satisfies the measured performance requirements" and to benchmark end-to-end latency, not Rust's raw speed.

## Requirements, with numbers

1. **Live latency.** The answer should start appearing within about 1.5 s of the interviewer finishing. That is a product target, not a measurement yet.
2. **Concurrency.**
   - 1,000 monthly active users × 3 hours a month works out to about 4 live sessions at once on average. Peaks are around 40, assuming a 10× peak.
   - At 50,000 users, peaks reach about 2,000 answers streaming at once.
3. **Audio never passes through our servers.** Clients stream straight to Deepgram or AssemblyAI with short-lived tokens. The backend only relays text: it waits on the network rather than doing heavy computing.
4. **Several AI providers** (Claude, OpenAI, Gemini, Ollama), with no lock-in.
5. **One shared set of logic** (prompts, scoring, speech metrics, search) on desktop, web and server.

## What we measured

| Question | Result |
|---|---|
| How much of the live delay is our code? | **About 3 ms** typical (2 ms to build and send the request, 1 ms from first byte to screen); 13 ms worst case. Redrawing never goes over 10.1 ms per frame. |
| Where does the delay actually come from? | **Waiting and the network:** the 700 ms follow-up wait, Deepgram's 400 ms endpointing, and the provider's time to first token. With local Whisper, 1.4 s of transcription. A faster language wouldn't change any of these. |
| Can a TypeScript-style backend handle the load? | **Yes.** One Node process relays 1,000 answers streaming at once, adding 26 ms typical and 61 ms worst-case before the first word, on 64% of one core and 141 MB of memory. At 2,000 it maxes out one core; the fix is a second process. |
| Is the audio pipeline CPU-bound? | **No.** Voice detection takes 12.6 µs per 100 ms of audio. |
| Was there a real performance problem? | **Yes:** Whisper's memory (1.7 GB) and load time (13.8 s). Both were **ONNX Runtime settings, not the language**. Fixed in TypeScript: 845 MB, 3.9 s, and 18% faster. |

## Comparison

| | Rust-first (Tauri + Axum) | TypeScript-first (Electron + Node, Rust where it is needed) |
|---|---|---|
| Live latency | No measurable gain: our code is about 3 ms of a 1–3 s total | Same |
| Server cost | Probably handles several times more streams per core (not measured here). At 50k users that saves maybe one $4–13/month instance. | 1–2 small instances up to about 50k users |
| Desktop size and memory | Smaller installer, no bundled Chromium (about 200 MB less baseline memory) | About a 150 MB installer and 338 MB idle |
| System audio on Windows | Needs a native plugin (e.g. `tauri-plugin-system-audio`, WASAPI loopback) | Already works, with about 20 lines of Electron code |
| System audio on macOS | Native code (Core Audio taps) | Native code too: a small napi-rs Rust or Swift module |
| AI SDKs | No official Anthropic SDK for Rust (official ones: Python, TypeScript, C#, Go, Java, PHP, Ruby). We'd keep hand-written HTTP clients for each provider in Rust. | Official TypeScript SDKs; our adapters already exist |
| Shared logic | Prompts, scoring and search would exist in Rust (server and desktop) and in TypeScript (web), or need to be compiled to WASM | One `packages/core` used everywhere |
| Effort to get there | Rewrite about 2,400 lines of working, tested app code plus the native audio. Slower iteration; a smaller hiring pool. | Keep building on v0.4.0 |
| Memory safety | Strong for native code | JS is memory-safe; the native parts (Chromium, onnxruntime) are maintained by others; our own native modules would be in Rust |
| Mobile | Tauri mobile is younger. **A phone can't run the live copilot either way:** Android blocks third-party capture of voice-call audio, and we know of no iOS API that allows it. | Expo / React Native for a practice and review companion |

## Decision

Go **TypeScript-first, and add Rust only where a benchmark shows we need it.**

1. **Desktop: stay on Electron.** It is the simplest option that meets the measured needs. Revisit Tauri only if installer size or memory becomes a real sales problem. The renderer is ordinary web code, so it would carry over.
2. **Backend: TypeScript (NestJS on Fastify)**, as in [ARCHITECTURE.md](../ARCHITECTURE.md). Axum isn't justified: the measured gateway overhead is well under the latency budget at 25× our expected peak for 1,000 users.
3. **Rust for specific native modules** (napi-rs), each added when its phase arrives and only if it beats the TypeScript or WASM alternative on a benchmark:
   - macOS system-audio capture (Phase 6)
   - echo cancellation using the call audio as reference, if a WASM build of WebRTC AEC3 can't keep up (Phase 3)
   - local speech engines faster than Whisper, if testing shows a gain
4. **No Python service** for now. We don't train or host models; every AI call goes to a provider API. Revisit if that changes.
5. **Mobile: Expo**, as a companion app (practice, review, viewing answers), not a live copilot.

## When to revisit

Change course if any of these are measured:
- The gateway's p95 added time to first token goes over 100 ms at real peak load on 2 instances.
- Server compute exceeds 15% of the cost per user.
- Desktop memory or installer size shows up in support tickets or lost trials.
- A native audio feature needs more than a contained module.

## What would actually make it faster

Ordered by expected gain. Each is scheduled in the roadmap.

1. **Start answering earlier.** Shorten the 700 ms follow-up wait when Deepgram has already marked the end of speech, or start a draft on interim text and withdraw it if the speaker carries on (Phase 3).
2. **Pick the live model for speed:** Haiku 5.5 or Sonnet 5.5 with low effort for live answers, keeping stronger models for feedback. Measure each provider's time to first token with real keys.
3. **Keep prompts cached** (already on for Claude) and small.
4. **Local Whisper** is already tuned (memory halved, about 18% faster). Compare Moonshine as a faster local engine.

## Sources

- Anthropic SDK list: [platform.claude.com/docs/en/cli-sdks-libraries/overview](https://platform.claude.com/docs/en/cli-sdks-libraries/overview)
- Android playback capture rules (only media, game and unknown usages can be captured): [developer.android.com: AudioPlaybackCaptureConfiguration](https://developer.android.com/reference/kotlin/android/media/AudioPlaybackCaptureConfiguration)
- Tauri system audio plugin (WASAPI loopback in Rust): [docs.rs/tauri-plugin-system-audio](https://docs.rs/tauri-plugin-system-audio)
- Deepgram short-lived tokens, and prices: [research/pricing-2026-11-15.md](../research/pricing-2026-11-15.md)
