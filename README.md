# Interview Helper

A desktop AI interview copilot for Windows (Electron). While you're in a call, it listens to the interviewer and to you, and writes suggested answers in a small always-on-top window.

## Features

- **Live answers:** captures system audio (the interviewer on Zoom, Meet or Teams) and your microphone separately, transcribes both, and streams an answer when the interviewer asks a question.
- **Answers that start early:** a draft answer begins as soon as the interviewer has probably finished. It becomes the answer when the final question matches, and is replaced if the question changed or a follow-up sentence came in, so every answer is based on the full question. Deepgram Flux gives the fastest end-of-question detection; local Whisper transcribes after 300 ms of silence.
- **Your choice of AI:** Claude (Anthropic), OpenAI, Google Gemini, or **Ollama** running locally with no API key.
- **Your choice of transcription:** Deepgram Nova-3 (cloud, live words), Deepgram Flux (cloud, turn detection for the interviewer) or **Whisper on your own CPU** (offline, free, text appears after each sentence).
- **Reliability:** Deepgram reconnects automatically, capture restarts when a headset is plugged in or a device disappears, and you're warned if no call audio is heard for a minute.
- **Answer tools:** each answer is labelled with its question type (behavioral, technical, system design, coding, motivation, compensation) and structured for it. **Shorter / Longer / Regenerate** buttons rework any answer; Longer only adds details from your verified facts.
- **No headphones?** Echo cancellation (WebRTC AEC3, on this PC) removes the interviewer's voice that your speakers play into your mic, so it isn't transcribed or recorded as you. Measured: interviewer words leaking into your transcript fell from 10 to 0, and accuracy with headphones is unchanged. A text filter catches anything that slips through.
- **Meeting detection (Windows):** when Zoom, Teams, Meet in a browser and similar apps start using the mic, the app offers to start a session.
- **Coding Lab:** a separate window with a VS Code-style editor and 14 interview problems (algorithms in Python or JavaScript, plus SQL), with example and hidden tests. Code runs on your PC in a sandbox with no network access and a 5-second limit. AI hints come in 3 steps without giving away the solution, and reviews include Big-O complexity. Results appear in Progress.
- **Career tools (per job):** resume check with a match score and keyword coverage, a tailored resume and cover letter (export to PDF or Word), LinkedIn headline and About, a follow-up email based on your last interview, and company research with cited sources (Claude web search, including pay ranges when a source exists), and a **prep plan** (focus areas, gaps, stories, and 10 questions you can practise in Mock). Everything sticks to your verified facts; missing details become [placeholders].
- **Screenshot solver:** `Ctrl+Shift+S` captures the screen under your cursor (coding problems, assessment questions, slides) and the AI solves it.
- **Job workspaces:** one per company and role, with its own job description, notes, stage, interview date, contacts, apply-by deadline and follow-up reminder (shown in the app, and as a Windows notification when the window is hidden). Pick the active job from the bar under the tabs; live answers, practice questions and summaries use it, and sessions are filed under it.
- **Interview Brain:** the AI extracts short facts about you (roles, projects, metrics, skills, stories) from your resume and documents; you correct them or add your own. Answers and model answers must stick to these facts and your resume, and show a `[placeholder]` instead of inventing an achievement.
- **Mock interviews:** a single interviewer or a **panel of 4** (recruiter, hiring manager, technical lead, HR) who follow up on gaps in your last answer; **adaptive difficulty**; a live pace and filler meter while you speak; 8 practice types (general, behavioral, coding, system design, product case, data/ML, salary negotiation, recruiter screen) plus mixed, tailored to the active job and read aloud. You answer by voice or text and get scores for clarity, structure, specificity, relevance and depth, feedback, and a stronger model answer.
- **Speech coach:** pace (words per minute), filler words, restarts and answer length, measured from your recorded answers and from your side of live calls, with tips.
- **Progress:** average score and trend, per-skill averages with the skill to focus on next, scores by practice type, pace and filler rate, filterable by job, above the session history. **Next steps** suggest what to practise from your results, and the **question bank** lists every question you were asked or practised (rewordings merged) with your best score and a Practise button.
- **Floating copilot:** a compact always-on-top view with the latest question and answer, adjustable opacity and text size, and global shortcuts you can change (show/hide, minimize, compact, answer, screenshot). The window is visible in screen shares and recordings, and Settings says so plainly, with a preview of what others see.
- **Obsidian:** keep linked Markdown notes of your jobs, interviews, practice, career documents, lessons and question bank in your Obsidian vault, updated automatically. Notes you edit there are never overwritten.
- **Calendar invites:** import interview invites (.ics) from Google Calendar, Outlook or Apple Calendar, or drop them on the Jobs tab. Review what happens to each one, then the interview time, meeting link and interviewers go onto the right job. Reminders come the day before and 30 minutes before, with a Join meeting button.
- **Memory across sessions:** after each interview or practice session, the app suggests a few lessons (from your pace, fillers and scores, and from the AI), such as “use the payments outage story for failure questions”. The ones you keep, for all interviews or for one job, shape later answers, practice questions, feedback and prep plans. Manage them in Profile → Memory.
- **Autonomous Job Kit import:** bring in the applications you made with [Autonomous Job Kit](https://github.com/victorokiki/autonomous-job-kit). Each becomes a job with its posting, status, interview time and deadline, plus the résumé, cover letter and form answers you actually sent and the gaps the kit left off your résumé. Live answers, practice and prep plans then stay consistent with what the employer already has (same salary figure, same stories) and answer gaps honestly. Interview-relevant answers from your kit profile (salary, notice period, work authorization) can become Interview Brain facts; self-identification answers are never imported.
- **Job check (from Autonomous Job Kit):** paste a posting link and press **Fill from link** to read the company, role, description, pay and deadline from Greenhouse, Lever, Ashby, Workday, SmartRecruiters, iCIMS, Oracle, Rippling or Canada's Job Bank (the app contacts only those job sites). Every job then shows a **fit score** out of 100 with its reasons and the skills you're missing, **scam warning signs** with the sentence that triggered each, and an **eligibility check** against your work authorization (citizenship, sponsorship, clearance, degree level) for Canada, the US and the UK. Worked out on this PC; checks, not immigration advice.
- **New job matches (from Autonomous Job Kit):** **Find jobs now** in Jobs searches SimplifyJobs' internship and new-grad lists, Canada's Job Bank, Remotive and the employer boards you follow (Greenhouse, Lever, Ashby, SmartRecruiters, Workday), ranks everything with your fit score, and lists what's new since last time with **Add to Jobs**, **Open posting** and **Dismiss**. Optionally once a day while the app is open, with a notification. Requests carry only your search terms, country and board names.
- **Fact check:** under every live answer and on tailored résumés, cover letters, LinkedIn text and follow-up emails, the app lists numbers, tools and names that aren't in your résumé, facts or what you sent, and placeholders still to fill. Local, no AI call.
- **Browser extension (Jobs & Autofill):** on a job posting in Chrome, Edge or Brave, click the Interview Helper button to add the job (company, role, description, link) to Jobs. On an application form, **Fill this form** (or Alt+Shift+F) fills the standard fields from your autofill profile using Autonomous Job Kit's rules, and never submits, ticks consent boxes or touches ID, bank or date-of-birth questions. It reads or fills a page only when you click, and talks to the app through the browser's native messaging, so no network port is opened.
- **Use your data from Claude Desktop (MCP):** a local, read-only MCP server lets Claude and other assistants read your jobs, facts, kept lessons, progress, sessions, documents and question bank. Copy the config from Settings → Connect AI assistants (MCP).
- **Post-call summary:** when a session ends, you get an overview, the questions you were asked, what went well, what to improve, follow-ups, and a thank-you email draft. It is saved with the session; older sessions can be summarized from History.
- **Profile and documents:** your resume and notes go into every answer. Extra documents (project write-ups, past work, study notes as PDF/DOCX/TXT/MD) are searched locally, and the most relevant passages are added to each answer.
- **Session history:** live sessions and mock interviews are saved locally with transcript, answers, scores, delivery metrics and summary. Search across everything, and export any session to Markdown.
- **Answer presets:** length, tone, format (bullets, spoken answer or both), answer language and your own standing instructions. Four built-in presets plus your own; switch from the Live tab.
- **Live translation:** shows a translation under each interviewer line (Settings → Transcription).
- **Recording with consent:** turn on **Record** to save the call audio to your PC. Before each recorded call you confirm everyone has agreed, and recordings play back in History.
- **Privacy & data:** see where your data goes for your current settings, set how long sessions and recordings are kept, export everything, or delete recordings, sessions or all data.
- **Light and dark mode:** follows Windows, or pick one in Settings.

## Install

Run `dist\Interview Helper Setup 0.18.4.exe` (after building it, see below). The installer isn't code-signed, so Windows SmartScreen will warn the first time: choose **More info → Run anyway**.

## Setup

Open **Settings** and pick what to use. Each option needs:

| Choice | Needs |
|---|---|
| Claude | Anthropic key from <https://console.anthropic.com/> |
| OpenAI | OpenAI key from <https://platform.openai.com/api-keys> |
| Gemini | Gemini key from <https://aistudio.google.com/apikey> |
| Ollama (offline) | Install <https://ollama.com>, then `ollama pull gemma3`. Use a vision model (gemma3, qwen2.5vl, llava) if you want screenshots |
| Deepgram | Deepgram key from <https://console.deepgram.com/> (new accounts get free credit) |
| Whisper (offline) | Nothing. Press **Download now** once (about 75 MB); after that it works with no internet |

**Fully offline:** Ollama + Whisper. Nothing leaves your PC.

Then fill in **Profile** (resume, then **Extract from resume & documents** and check the facts) and add the role you're preparing for under **Jobs**. Keys are encrypted with Windows DPAPI (Electron `safeStorage`) and stored in `%APPDATA%\Interview Helper\config.json`. Jobs (`jobs.json`), Interview Brain facts (`facts.json`), sessions, documents and downloaded speech models live next to it. Upgrading from 0.2 moves the old profile job description into a first job automatically.

## Using it

1. Join your call, then press **Start session**. The chips should show `Interviewer: listening` and `Me: listening`.
2. With **Auto-answer** on, a question from the interviewer gets an answer once they stop talking. You can also:
   - press **Answer now** or `Ctrl+Shift+Enter` to answer the latest thing they said;
   - type your own question into the box and press Enter.
3. Press **Stop session** to end; the post-call summary appears at the top (turn this off in Settings), and your speaking pace and filler words are saved with the session.
4. `Ctrl+Shift+H` shows or hides the window, `Ctrl+Shift+U` minimizes or brings it back, and `Ctrl+Shift+Y` switches to the compact view. The pin button toggles always-on-top. Change any shortcut in Settings → Window and shortcuts.

Filler words are counted from Deepgram transcripts. Whisper usually leaves "um" and "uh" out, so with local transcription the filler count runs low.

**Use headphones.** System-audio loopback captures everything your PC plays, so with speakers your own voice can be transcribed as the interviewer.

## Browser extension

One extension adds jobs to the app and fills application forms. It never submits a form.

1. In the app: Settings → **Browser extension** → **Turn on**.
2. Press **Show extension folder**. In Chrome open `chrome://extensions` (Edge: `edge://extensions`), switch on **Developer mode**, choose **Load unpacked** and pick that folder. (Already installed? Press the reload icon on its card.)
3. **Add a job:** on a job posting, click the Interview Helper button in the toolbar, check the details and press **Add to Jobs**. If the page has a lot of other text, select the job description first.
4. **Fill an application form:** click the toolbar button and press **Edit autofill profile** once to import your Autonomous Job Kit `profile.json` (or type your answers) and, optionally, your résumé PDF. Then, on an application form, press **Fill this form** or `Alt+Shift+F`. Filled fields get a green outline and fields left for you an amber one. The extension never submits a form or clicks Next, never ticks consent or "I agree" boxes, never changes an answer that's already there, and never fills ID numbers, date of birth, bank, passport, religion, marital-status or criminal-record questions. Self-identification questions are filled only with answers you chose. Check every answer, then submit it yourself.

The extension reads or fills a page only when you click it or press the shortcut, and it can't read anything from the app. Your autofill profile and résumé stay in this browser (they're never sent to the app or anywhere else). If a company page shows its application form inside a frame from Greenhouse, Lever, Workday or another listed system, the extension asks once for permission to fill forms on that one site; you can remove it in the extension's details. Turning the setting off (or uninstalling the app) removes the connection to the app. Autofill rules come from Autonomous Job Kit (MIT).

## Autonomous Job Kit

1. Jobs → **Import from Job Kit** (or Settings → Autonomous Job Kit) and choose your job-search folder: the one with `tracker.xlsx` and `Applications/`.
2. Review the list: each application is matched to an existing job (by the kit's link, the posting address, or company and role), offered as a new job, or skipped (rows the kit skipped). Tick the profile answers you want as Interview Brain facts. Nothing changes until you press **Import**.
3. Open a job to see **What you sent**. Import again any time to pick up new applications, status changes and interview dates; a stage you changed yourself is kept unless the kit's status changed since the last import.

The folder is only read, never changed. Résumé and letter text is extracted on this PC (PDF or Word). What you sent is added to your prompts for that job, so it goes to your AI provider like your résumé does; turn it off in Settings → Autonomous Job Kit.

## Job check and fact check

- **Fill from link:** in a job, paste the posting link and press **Fill from link**. Supported: Greenhouse, Lever, Ashby, Workday, SmartRecruiters, iCIMS, Oracle Recruiting Cloud, Rippling and Canada's Job Bank. The app contacts only those sites' public job addresses (https, every redirect checked, no cookies or sign-in). For other sites, use the browser extension or paste the description.
- **Profile → Your job search:** your target roles, area, extra skills and work authorization. The fit score and eligibility check use them; importing from Autonomous Job Kit fills them from `search.json` and `profile.json`. They stay on this PC and are never sent to the AI.
- **Job check** (in each job and as chips in the list): fit score with title, skills, location, experience and recency parts; skills you lack (prepare an honest answer, never add them to your résumé); scam warning signs; sentences that may rule you out, with the rule. They're checks, not decisions or immigration advice.
- **New job matches:** Jobs → **New job matches** → **Find jobs now** (needs target roles in Profile → Your job search). Follow an employer by pasting any link to its Greenhouse, Lever, Ashby, SmartRecruiters or Workday board. Tick **Look for new jobs once a day** to search automatically while the app is open; you get a notification when there are new matches. Remote jobs from [Remotive](https://remotive.com) are credited in the list, and the app calls Remotive at most 4 times a day, as its terms ask.
- **Fact check:** a note under answers and career documents lists details not found in your résumé, Interview Brain facts or what you sent for the job. Check those before you say or send them.

## Use with Claude Desktop (MCP)

Settings → **Connect AI assistants (MCP)** shows a block like this; press **Copy** and paste it into Claude Desktop's `claude_desktop_config.json` (Settings → Developer → Edit Config), then restart Claude Desktop:

```json
{ "mcpServers": { "interview-helper": {
  "command": "C:\...\Interview Helper.exe",
  "args": ["C:\...\resources\app.asar\src\mcp\server.js"],
  "env": { "ELECTRON_RUN_AS_NODE": "1" } } } }
```

The server only reads files in `%APPDATA%\Interview Helper`; it can't change anything, and nothing leaves your PC except what your MCP client sends to its own AI provider.

## Documentation

- [docs/AUDIT.md](docs/AUDIT.md): comparison with 6 open-source copilots and a feature inventory against the product brief
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): current and target architecture, database schema, API contracts, folder structure
- [docs/ROADMAP.md](docs/ROADMAP.md): phases and progress, risks, operating costs
- [docs/TESTING.md](docs/TESTING.md): how the end-to-end tests work
- [docs/BENCHMARKS.md](docs/BENCHMARKS.md) and [docs/decisions/ADR-001](docs/decisions/ADR-001-rust-vs-typescript.md): measured latency and load, and why the stack is TypeScript-first with Rust only where it's needed

## Develop and build

```bash
npm install
npm start
```

```bash
npm run check
```

```bash
npm run test:e2e
```

```bash
npm run dist
```

`npm run dist` builds the installer into `dist\` with electron-builder.

## How it works

| Piece | File |
|---|---|
| Window, global shortcuts, screen capture, system-audio loopback, IPC | `src/main.js` |
| Prompts: live answers, screenshots, 8 practice types and scoring, summaries, fact extraction, file import | `src/ai.js` |
| Job workspaces (and the one-time move of the old job description), reminders | `src/jobs.js` |
| Obsidian / Markdown vault export: notes and links; safe writing (edited notes kept) | `packages/core/vault.js`, `src/vault.js` |
| Screenshot tour of every screen for UI review (`npx electron scripts/ui-tour.js dark`) | `scripts/ui-tour.js` |
| Calendar invite import: parsing, time zones, matching, review plan; applying it | `packages/core/ics.js`, `src/calendar.js` |
| Interview Brain facts | `src/brain.js` |
| Lessons from past sessions (memory): store; suggestions, duplicates, prompt block | `src/lessons.js`, `packages/core/lessons.js` |
| Claude / OpenAI / Gemini / Ollama streaming adapters | `src/providers.js` |
| Extra documents with local BM25 search | `src/docs.js` |
| Local Whisper (transformers.js + onnxruntime) in a utility process | `src/whisper-worker.js` |
| Encrypted settings, session files, Progress records, search, export, retention | `src/store.js` |
| Answer presets | `src/presets.js` |
| Session audio recordings | `src/recordings.js` |
| Presets, translation, consent and recording, privacy, theme screens | `src/renderer/controls.js` |
| Speech metrics, score parsing, Progress charts | `src/renderer/coach.js` |
| Echo cancellation (worklets + AEC3 worker) | `src/renderer/aec.js`, `aec-worker.js`, `pcm-worklet.js` |
| Career tools (prompts, keywords, citations, prep plan) | `packages/core/career.js` |
| Question bank; Progress records and search (shared with the MCP server) | `packages/core/bank.js`, `packages/core/records.js` |
| Read-only MCP server for Claude Desktop and other clients | `src/mcp/server.js` |
| Browser extension (popup, page reader) | `extension/` |
| Native messaging host, registration, inbox import | `src/bridge/` |
| Job-posting parser and import validation (shared with the extension) | `packages/core/jobpost.js` |
| Saved career documents; PDF/Word export | `src/artifacts.js`, `src/exporter.js` |
| Coding Lab window and `app://` protocol | `src/lab.js`, `src/renderer/codelab.*` |
| Sandboxed Python / JavaScript / SQL runners | `src/renderer/runners/` |
| Challenges and judges (shared) | `packages/core/challenges.json`, `judge.js`, `pyharness.js` |
| Jobs, Interview Brain and Progress screens | `src/renderer/workspace.js` |
| Deepgram socket and offline voice-activity splitting | `src/renderer/transcriber.js`, `src/renderer/pcm-worklet.js` |
| UI | `src/renderer/` |

With Claude, live answers use `effort: "low"` to keep latency short; screenshots, mock feedback and summaries use `medium`. Opus 5.5 and Sonnet 5.5 requests opt into server-side refusal fallbacks (`fallbacks: "default"`), and the profile block is prompt-cached. Ollama requests ask for a 16K context so the resume, job description and transcript fit.
