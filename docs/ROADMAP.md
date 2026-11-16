# Roadmap and progress

Last updated: 2026-11-16.

Status marks: ✅ done and tested · 🟡 partly done · ⬜ not started.

Each phase ships an installer and keeps all earlier end-to-end tests passing.

## Phase 1: Preparation core (v0.3.0) ✅

- ✅ Job workspaces: company, role, stage, interview date, job description, notes, active job
- ✅ Interview Brain: extract facts from resume and documents, edit them, answers stick to them
- ✅ 8 practice types with scores for 5 skills and a debrief
- ✅ Speech coach: pace, filler words, restarts, length
- ✅ Progress analytics, filterable by job
- ✅ Import resumes and documents from DOCX

## Phase 2: Copilot completeness and trust (v0.4.0) ✅

- ✅ Answer presets: length, tone, format, answer language, your own instructions (built-in presets plus your own)
- ✅ Live translation of the interviewer
- ✅ Session recording with a consent dialog for each call; playback in History
- ✅ History search, with snippets
- ✅ Export a session to Markdown
- ✅ Privacy & data:
  - ✅ shows where your data goes
  - ✅ retention for sessions and recordings
  - ✅ export everything
  - ✅ delete recordings, sessions, or everything
- ✅ Design refresh:
  - ✅ Inter font
  - ✅ light and dark themes
  - ✅ SVG icons
  - ✅ focus states and reduced motion
  - ✅ no horizontal scroll at 380 px
- ✅ Planning docs: audit, architecture, roadmap, tests
- ✅ Rust-first vs TypeScript-first decision based on measurements ([ADR-001](decisions/ADR-001-rust-vs-typescript.md), [BENCHMARKS.md](BENCHMARKS.md))
- ✅ Whisper tuning (v0.4.1): memory 1.7 GB → 845 MB, load 13.8 s → 3.9 s, about 18% faster transcription

## Phase 3: Real-time performance and technical practice

### 3a. Live performance (v0.5.0) ✅ (numbers in [BENCHMARKS.md](BENCHMARKS.md))

- ✅ Speculative answers with corrections (`packages/core/speculation.js`):
  - a draft starts on an early end-of-question signal;
  - it is promoted when the final question matches;
  - it is replaced when the question changed or the interviewer kept talking;
  - a follow-up sentence corrects the answer.
- ✅ The fixed 700 ms auto-answer wait is gone. The request starts 3 ms after the final transcript (it was 718 ms).
- ✅ Early signals from every speech engine:
  - **Deepgram Flux:** EagerEndOfTurn and TurnResumed.
  - **Deepgram Nova-3:** a final segment ending in "?".
  - **Local Whisper:** 300 ms of silence, with that transcript reused as the final one. The question is ready about 1.4 s sooner (2.85 s → 1.49 s).
- ✅ Deepgram Flux added as an engine for the interviewer's channel. Message handling is tested; the live connection is ⬜ unverified until a real key is used.
- ✅ Connection pre-warm at session start and every 30 s. Claude moved to Chromium's network stack. Real saving: 45–101 ms per AI provider.
- ✅ Whisper loads from cache first: 13.8 s → 0.68 s. Unloaded after 10 idle minutes.
- ✅ Reliability:
  - Deepgram reconnects automatically (3 attempts);
  - capture restarts when a device is lost or the default device changes;
  - a warning appears when no call audio is heard for 60 s.
- ✅ Resource use:
  - on-screen transcript capped at 300 lines and answers at 20 cards (everything is still saved);
  - the idle window no longer starts the audio and video-capture services (487 → 334 MB).
- 🟡 macOS: Electron 44 captures system audio through Apple's CoreAudio Tap by default, so no native code is needed. Permission entries and a dmg target were added. ⬜ Not yet built or tested on a Mac.
- ✅ Shared `packages/core` (question detection, speculation, coaching metrics, prompts) used by the desktop app and ready for the server, web and mobile apps.
- ✅ Real-provider benchmark (`npm run bench:providers`). ✅ Run against Claude Haiku, Sonnet and Opus 5.5 on 16 November 2026 (see BENCHMARKS.md). ⬜ GPT, Gemini and Deepgram not run yet: need those keys.
- ✅ Tests: 19 unit tests and 68 end-to-end checks (Phase 3 suite: 24).

### 3b. Interview tools (v0.6.0) ✅

- ✅ **Echo filter** for setups without headphones (`packages/core/echo.js`). A "Me" line is dropped when it overlaps in time with the interviewer and at least 70% of its words are the interviewer's. It works whichever channel arrives first. Repeating the question back later, or answering over the interviewer, is kept.
  - ⬜ Real acoustic echo cancellation (WebRTC AEC3 in WASM; Rust only if benchmarks require it) is still open.
- ✅ **Question types** (behavioral, technical, system design, coding, motivation, compensation), with matching structure guidance in the prompt and a label on the answer.
- ✅ **Shorter / Longer / Regenerate** on every finished answer. The rewrite replaces the card in place, and Longer may only add details from the verified facts.
- ✅ **Panel interviews:** Recruiter, Hiring manager, Technical lead and HR partner take turns, each with their own focus and voice. The next panelist sees the last exchange and may ask a pointed follow-up.
- ✅ **Adaptive difficulty:** two scores of 8+ step up, two of 5 or less step down; or set Easy / Medium / Hard.
- ✅ **Live practice meter:** words per minute, filler words, elapsed time and a tip while you record.
- ✅ **Meeting detection on Windows:** a call app (Zoom, Teams, Webex, Slack, Discord, browsers…) starting to use the mic prompts "Start session". A Windows notification appears when the app is hidden. Can be turned off in Settings.
- ✅ Tests: 27 unit tests and 84 end-to-end checks (new Phase 3b suite: 16).

### 3c. Coding Lab (v0.7.0) ✅

- ✅ Opens in its own resizable window from Mock. It's a separate process, so a runaway program can't freeze the live copilot.
- ✅ Monaco editor (MIT) with Python, JavaScript and SQL syntax.
- ✅ **Sandboxed execution, on this PC only:**
  - Python runs in Pyodide (MPL-2.0, used unmodified), JavaScript in a Web Worker, SQL in sql.js (MIT, a fresh database per test).
  - Workers are served through `app://` with a Content-Security-Policy that blocks all network access.
  - Programs have a 5 s time limit, and the runner restarts after a timeout.
  - Only an allow-list of the app's files can be served.
- ✅ **14 challenges:** 10 algorithm problems in Python and JavaScript, plus 4 SQL. Each has visible and hidden tests, and the judge handles exact and order-insensitive comparisons. Every expected answer is verified by reference solutions in real Pyodide, sql.js and Node (`tests/unit/challenges.test.js`).
- ✅ **AI coach:**
  - hints in 3 steps that never give the full solution;
  - an interviewer-style review (correctness, a "Time: O(...), Space: O(...)" line, improvements, how to explain it);
  - "Explain the error / failure".
- ✅ Progress card: solved per difficulty, submissions, pass rate, solved first try, hints per solve.
- ✅ Tests: 32 unit tests and 108 end-to-end checks (new Coding Lab suite: 24).

### 3d. Echo cancellation (v0.8.0) ✅

- ✅ **WebRTC AEC3** (BSD-3-Clause, via `@ennuicastr/webrtcaec3.js`, WebAssembly) removes the call audio from the microphone before transcription and recording.
- ✅ **Runs off the UI thread:** frames go from the audio worklets to a worker and back over MessagePorts. The cleaned mic is an ordinary stream, so every speech engine and the recorder work unchanged.
- ✅ **Measured before enabling:**
  - your transcript's error rate when taking turns falls from 75% to 8%;
  - when both talk at once, from 73% to 36%;
  - leaked interviewer words fall to 0;
  - no change with headphones.
  - It's on by default (Settings → Transcription), and the v0.6 text filter remains as a second layer.
- ✅ Rebuilt automatically when a device changes. CPU stats are saved with each session.
- ✅ Open-source license notices for all 85 shipped packages are generated at build time (`npm run notices`) and can be opened from Settings → Privacy & data.
- ✅ Tests: 32 unit tests and 119 end-to-end checks (new echo suite: 11).

### 3e. Next ⬜

| Item | Notes |
|---|---|
| ◐ Run the real-provider benchmark | Claude done (16 Nov 2026); GPT, Gemini and Deepgram need keys |
| ⬜ Real-room echo test | The AEC numbers use a simulated room; confirm on laptop speakers in a real call |
| ⬜ More Coding Lab challenges; hard tier; more languages | |
| ⬜ System design diagram review | |
| ⬜ Replay of mock answers; second, sceptical pass on low scores | |
| ⬜ macOS build and test on a Mac | |

## Phase 4: Career intelligence (desktop, BYOK)

### 4a. Career tools per job (v0.9.0) ✅

- ✅ **Resume check:**
  - a match score (overall, skills, experience, impact);
  - keyword coverage, worked out on this PC from the job description against your resume and facts, with present and missing chips;
  - gaps, plus before → after rewrites based only on your verified facts.
- ✅ **Tailored resume and cover letter:** employers, titles, dates and degrees are kept exactly as written, and any missing metric becomes an [add metric] placeholder.
- ✅ **LinkedIn headline, About section and skills.**
- ✅ **Follow-up email** built from the last recorded interview for that job (summary plus transcript excerpt).
- ✅ **Company research with citations:**
  - Claude's web search tool (`web_search_20250305`), $10 per 1,000 searches;
  - numbered citations and a source list;
  - compensation only from cited sources, otherwise "Not found";
  - resumes after `pause_turn`, and search errors are reported.
  - Claude only; other providers get a clear message.
- ✅ **Documents** are saved per job and can be copied, exported to **PDF** (Chromium print, JavaScript off) or **Word** (`docx`, MIT), or deleted.
- ✅ Documents are deleted with their job, included in "Export all my data", and removed by "Delete everything".
- ✅ Links in documents open in the browser; the app window can't be navigated away.
- ✅ Tests: 38 unit tests and 135 end-to-end checks (new Career suite: 16, including a fake Claude server speaking the real streaming format with web search, citations and `pause_turn`).

### 4b. Tracker, prep plan, question bank, MCP ✅ (v0.10.0)

- ✅ **Job tracker:** contacts, an apply-by deadline, a follow-up date and note per job. Due follow-ups and deadlines within 24 hours show a banner in the app (with Open job), and a Windows notification only when the window is hidden. Each reminder fires once; changing the date re-arms it. The jobs list shows "Follow-up overdue", "Follow up today" and "Apply by".
- ✅ **Company prep plan:** a 7th career tool turns the job description, your facts and the latest company research into focus areas, gaps, stories to have ready and a 10-question plan. In Mock, **Questions from → this plan** practises those questions in order, graded as their type, without an AI call to pick the question.
- ✅ **Question bank:** every question you were asked live or practised, merged when worded differently, with how often and your best score, plus planned questions not yet practised. Filter it, and **Practise** opens a question in Mock.
- ✅ **Learning path:** Progress shows up to 4 next steps from your weakest skill, practice types, pace and fillers, and Coding Lab results, each with a button that starts the right practice.
- ✅ **Local MCP server** (`src/mcp/server.js`, official SDK): 8 read-only tools (jobs, one job with its documents, Interview Brain, progress with next steps, search sessions, one session, one document, question bank) over stdio. Settings shows the config to paste into Claude Desktop or another MCP client; the app's own executable runs it as Node, so nothing extra is installed. It reads files on this PC only and never writes.
- ✅ Shared code moved into `packages/core/` (`records.js`, `bank.js`) so the app and the MCP server compute the same numbers.
- ✅ Tests: 43 unit tests (including one that starts the real MCP server with the SDK client) and 150 end-to-end checks (new Phase 4b suite: 15).

### 4c. Browser extension ✅ (v0.11.0; Autofill added in v0.18.0, see 4j)

- ✅ **Chrome / Edge / Brave extension** (`extension/`, Manifest V3): on a job posting, click its toolbar button, check company, role and description, and press **Add to Jobs**. It fills these from the page's schema.org `JobPosting` data when there is some (most career sites and applicant-tracking systems), from your selection if you selected the description, otherwise from the title, the address (Greenhouse, Lever, Ashby, Workable, Workday) and the main page text.
- ✅ **Least privilege:** permissions are `activeTab`, `scripting` and `nativeMessaging` only, with no host permissions, so it reads a page only when you click, and can't read anything from the app.
- ✅ **No network port.** It talks to the app through the browser's native messaging. The browser starts a small host (`src/bridge/host.js`, run by the app's own executable) only for our extension's ID (fixed by the key in its manifest). The host accepts two messages (ping and import), validates the job, and writes it to an inbox folder. The app validates it again, adds it to Jobs (the same posting address never twice), shows a banner with **Open job**, and a notification if the window is in the background. The app never fetches the posting itself, so there's no server-side request to guard against.
- ✅ **Off by default.** Settings → Browser extension → **Turn on** registers the host for Chrome, Edge, Brave and Chromium (per user, no admin rights); **Turn off** and the uninstaller remove it. It re-registers on start so it follows the app when it's updated or moved.
- ✅ Jobs keep their posting URL, with an **Open** link.
- ✅ Tests: 50 unit tests (parser, validation, the host's wire protocol, launcher quoting) and 172 end-to-end checks (new Bridge suite: 22, through the real launcher, under a throwaway registry key). A manual script (`tests/manual/real-browser.js`) runs the extension in a real Chrome for Testing: the toolbar click reads the page, the popup connects, and the job reaches the inbox (all passed on Chrome 153).
- ⬜ Publish to the Chrome Web Store and Edge Add-ons (needs your developer accounts; until then it's loaded unpacked from the folder Settings shows). Firefox needs a separate manifest and registry key.

### 4d. Memory across sessions ✅ (v0.12.0)

- ✅ **Lessons suggested after every session:** when a live session stops (after its summary) or a mock session ends, a **Lessons to remember** card offers up to a few lessons. Some come from the numbers alone (pace over 170 or under 105 words a minute, 4+ fillers per 100 words, the weakest practice score at 5.5 or below), with no AI call. Up to 3 come from the AI, which sees the summary or transcript (or the practice answers, scores and feedback), your facts, and what you already know, and may only point to things in your facts or resume.
- ✅ **You decide:** edit the wording, choose **All interviews** or **Only <job>**, then **Keep** or **Dismiss**. Dismissed and forgotten lessons aren't suggested again (near-duplicates are caught too); you can clear that list.
- ✅ **Kept lessons are used** in live answers, practice questions (the interviewer may test a lesson), feedback (one line on whether you applied a relevant lesson) and career tools such as the prep plan. Up to 8 per prompt: this job's first, then general ones, newest first. A job's lessons are deleted with the job.
- ✅ **Profile → Memory:** pending suggestions, kept lessons (edit, change where they apply, forget), your own lessons, and switches for "Use kept lessons" and "Suggest lessons after each session". Lessons are included in "Export all my data" and removed by "Delete everything".
- ✅ The MCP server gained `get_lessons` (kept lessons only; pending suggestions are just counted).
- ✅ Tests: 54 unit tests and 191 end-to-end checks (new Memory suite: 19, including the real stop-live → summary → lessons chain).

### 4e. Calendar invites ✅ (v0.13.0)

- ✅ **Import invites (.ics):** Jobs → **Import invite (.ics)**, or drop invite files on the Jobs tab. Works with invites from Google Calendar, Outlook/Exchange (Windows time zone names), Apple Calendar and scheduling tools; times are converted correctly across time zones and daylight saving, and a time whose zone is unclear is flagged "check the time".
- ✅ **Review before anything changes:** each recent or upcoming event gets a suggested action you can change: set it as the interview for a matching job (matched by company name in the title or description, or the organizer's and attendees' email domain), add it as a new job (company and role guessed, editable), remove a cancelled interview from its job, or skip (meetings that don't look like interviews).
- ✅ **What an import sets:** interview date, meeting link (Zoom, Teams, Meet, Webex and others), stage Saved/Applied → Interviewing, new contacts from the invite, and a note with the title and time. Importing the same invite again doesn't repeat notes or contacts.
- ✅ **Interview reminders:** the day before ("A quick practice round now helps") and 30 minutes before, with **Join meeting**. Shown in the app, and as a notification when the window is in the background. Each fires once; changing the time re-arms them.
- ✅ Jobs have a **Meeting link** field with **Join**.
- ✅ Tests: 58 unit tests and 209 end-to-end checks (new Calendar suite: 18).
- ⬜ Google Calendar and Microsoft 365 connectors (automatic sync). They need an OAuth app registered with Google and Microsoft under your accounts, so they belong with Phase 5.

### 4f. Obsidian export ✅ (v0.14.0)

- ✅ **Settings → Obsidian:** choose your vault (or any folder). The app writes linked Markdown notes into an `Interview Helper` subfolder: a home note, one note per job, session and career document, plus Lessons, Interview Brain and Question bank. Notes have Obsidian properties (front matter) and `[[links]]` between jobs, sessions and documents.
- ✅ **Kept up to date** a few seconds after changes in the app (sessions, jobs, documents, lessons, facts, browser and calendar imports), or with **Update now**. Unchanged notes aren't rewritten.
- ✅ **Your edits are safe:** a manifest records what the app wrote. A note you edit is never overwritten or deleted again, and a file that was already there is never touched. Notes for things deleted in the app are removed unless edited. Nothing is written outside the subfolder.
- ✅ Full call transcripts only when you turn them on; summaries, answers and feedback are always included. **Open in Obsidian** uses an `obsidian://` link. **Stop exporting** leaves the notes; **Delete everything** removes the unchanged notes the app wrote.
- ✅ Tests: 60 unit tests and 225 end-to-end checks (new Vault suite: 16). Not checked inside the Obsidian app itself; notes are standard Markdown with front matter.

### 4g. Floating window, shortcuts, screen-sharing honesty, meeting detection fix ✅ (v0.15.0)

- ✅ **Compact view:** a 360 × 320 floating copilot (resizable down to 300 × 180) with the latest transcript line and answer; title-bar button, Settings switch, or Ctrl+Shift+Y. It opens at the same top-right corner and returns to the full window and the tab you were on.
- ✅ **Window:** position and size remembered per view (only restored if still on a connected screen); always-on-top remembered; the opacity slider now previews live.
- ✅ **Global shortcuts** are configurable (click, press keys; Backspace turns one off): answer, screenshot, show/hide, minimize/restore (new, Ctrl+Shift+U), compact (new). Keys Windows refuses are flagged. Defaults avoid Zoom/Meet/Teams mute, camera, share and raise-hand keys. Windows doesn't report keys another app already uses (tested: both apps register), and Settings says so.
- ✅ **Fixed:** timers slowed to once a second while the window was hidden or minimized (measured 1,000 ms for a 50 ms timer), delaying auto-answer and speech timing during calls. Background throttling is now off for the main window (measured ≤ 150 ms).
- ✅ **Screen sharing, stated plainly:** Settings shows that the window is visible in screen shares and recordings and that content protection is not used, reminds you to follow interviewer and assessment rules, and previews what a full-screen share shows (real capture). The app does not hide itself from screen sharing (no `setContentProtection`), by product rule.
- ✅ **Fixed meeting detection on current Windows 11:** the consent store is no longer updated live (entries are `PersistedInDatabase`; measured on build 26300), so detection never fired. It now also asks the Windows audio session API which processes have a microphone stream open (one small PowerShell process, ~1 ms per check, ~79 MB while detection is on and no session runs), with the registry kept for older Windows.
- ✅ Tests: 62 unit tests and 251 end-to-end checks (new Window suite: 26, with real Windows key presses). `tests/manual/meeting-compat.js` passed with real Chrome: a tab using the microphone is detected and its end noticed, and system-audio capture hears a tone the tab plays (439 Hz).
- ⬜ Not tested: desktop Zoom and Teams calls (need signed-in accounts), and anything on macOS.

### Real-provider benchmark and answer prompt ✅ (v0.15.1)

- ✅ **First real-provider runs:** Claude Haiku, Sonnet and Opus 5.5 through the app's own code, 30 answers each, 0 errors. Opus stays the default (best grounding, steadiest speed). See BENCHMARKS.md.
- ✅ **Live-answer prompt:** more specific and better grounded. Grounding improved on all three test profiles (by about 2.5 standard errors on the two not used for tuning), specificity rose slightly, and "[placeholder]" gaps no longer appear in the spoken answer. Relevance dipped slightly on two profiles.
- ✅ The benchmark saves every answer with the grader's reasons, has three test profiles, and can compare prompt versions (`BENCH_SET`, `BENCH_PROMPTS`).
- ✅ Tests: 63 unit tests and 251 end-to-end checks.

### 4h. Autonomous Job Kit import ✅ (v0.16.0)

- ✅ **Reads the kit's job-search folder:** `tracker.xlsx` (the layout the kit's `tracker.py` writes, and the same file after Excel saves it), `Applications/<date Company - Role>/` with `job-posting.md`, `application-record.md`, `answers-to-paste.md` (lean level), `changes.md`, the résumé and cover-letter PDF or Word files, and `profile.json`. Text is extracted on this PC; no AI call.
- ✅ **Review before anything changes:** each application is matched (kit link → posting address → company and role) or offered as a new job; skipped rows are skipped. Statuses map to stages; interview times, deadlines, posting, description, next step and interview stage come across; the user's own text is never overwritten, and on later imports their stage is kept unless the kit's status changed.
- ✅ **What you sent, used in answers:** résumé, cover letter, form answers (contact fields left out), edits made before submitting, and known gaps are attached to the job and added to live answers, practice, grading and prep for that job as `<application_sent>`, with a rule to stay consistent with it and to answer gaps honestly. Shown read-only in the job editor (**What you sent**, with Remove), switch in Settings, included in the MCP `get_job` tool.
- ✅ **Profile facts:** interview-relevant answers from `profile.json` (salary, notice, start date, work authorization, relocation) are offered ticked as Interview Brain facts; form trivia unticked; self-identification, age, accommodations and ID numbers are never offered.
- ✅ **Safety:** the folder is never written; tracker folder links that lead outside the job-search folder are refused; file sizes are capped.
- ✅ **Measured with Claude Opus 5.5** (6 questions × with/without, Opus judge): consistency with what was sent 7.67 → 9.5 out of 10, contradictions 1 → 0 (the salary answer gave the profile's range instead of the $62,000 on the form), no claimed gaps in either arm, time to first word unchanged. See BENCHMARKS.md.
- ✅ Tests: 73 unit tests and 281 end-to-end checks (new Job Kit suite: 30, against a fixture made with the kit's own tracker script and real PDFs).

### 4i. Job check and fact check from Autonomous Job Kit ✅ (v0.17.0)

Step 2 of combining the two projects: the kit's rule-based Python ported to plain JavaScript in `packages/core` (no Python bundled, per ADR-001), each checked against the Python on the same inputs.

- ✅ **Posting reader** (`postings.js`, from `postings.py`): Greenhouse (including embed and `gh_jid` links), Lever, Ashby, Workday, SmartRecruiters, iCIMS, Oracle Recruiting Cloud, Rippling, Job Bank. **Fill from link** in the job editor. The main process (`src/postings.js`) is the only network path: https, an allowlist of job-site hosts, every redirect re-checked, no cookies, 15 s timeout, 5 MB cap, Job Bank paced to one request per 5 s. Other sites are explained, never contacted. Parity: 396 of 397 field comparisons identical on the kit's fixtures (the one difference is an error message's wording); 3,747 fuzz comparisons identical. Checked live against a real Greenhouse and a real Lever posting.
- ✅ **Scam warnings** (`redflags.js`) and **eligibility screen** (`eligibility.js`): 405 of 405 Python/JS comparisons identical (Canada, US, UK rules; student and "or authorized to work" exceptions; EEO text ignored). The kit's "very short description" flag is shown as a note, not a scam warning, because pasted snippets are short.
- ✅ **Fit score** (`fit.js`, from `rank_jobs.py`): 0 to 100 from title, skills, location, experience and recency, with reasons, missing skills and pathway flags; identical to the Python on 23 full postings and 126 helper cases. The UK sponsor-register check needs the gov.uk download and is left out (the flag says it couldn't be checked).
- ✅ **Fact checker** (`factcheck.js`, from `bullets.py`): identical findings to the Python on 29 cases; Markdown is stripped first so answers' bold labels and bullets don't create false flags. Shown under live answers and on tailored résumés, cover letters, LinkedIn text and follow-up emails.
- ✅ **Profile → Your job search** (target roles, area, extra skills, work authorization), filled by the Job Kit import from `search.json` and `profile.json` when ticked. Stays on this PC.
- ✅ Tests: 164 unit tests (91 new, ported from the kit's tests plus parity tables) and 302 end-to-end checks (new Job check suite: 20).

### 4j. One extension and job discovery from Autonomous Job Kit ✅ (v0.18.0)

Step 3 of combining the two projects.

- ✅ **One browser extension, "Interview Helper: Jobs & Autofill" (1.1.0, same ID):** Add to Jobs as before, plus the kit's Autofill: **Fill this form** in the popup or `Alt+Shift+F`. Its profile editor imports the kit's `profile.json` (and an optional résumé PDF) and keeps it in the browser. Never submits or clicks Next, never ticks consent boxes, never fills ID, date of birth, bank, passport, religion, marital or criminal-record questions, never overwrites an answer, self-ID only from answers the user chose. Still no always-on content scripts and no required host permissions: permissions are `activeTab`, `scripting`, `nativeMessaging`, `storage`; forms embedded in a frame from a listed application system ask once for that one site (`optional_host_permissions`). The kit's on-page button was dropped because it needs always-on scripts.
- ✅ **New job matches** (`packages/core/discover.js`, from `find_jobs.py`, `find_internships.py`, `job_digest.py`): SimplifyJobs internship and new-grad lists, Job Bank, Remotive and followed Greenhouse, Lever, Ashby, SmartRecruiters and Workday boards; ranked with the fit score (descriptions read for the best 15); new since the last search; Add to Jobs, Open posting, Dismiss; follow an employer from any board link; optional daily search with a notification. Its own allowlist (the job sites plus exact SimplifyJobs file paths, Remotive's API path and Ashby's posting API), 40 MB cap for the large lists, Remotive at most 4 calls a day. Parity with the Python: identical requests, records, skip counts, scores, order and digest on the fixtures, and 9,081 records plus 1,800 ranked jobs identical on full real responses. Checked live (3,278 real postings in 2.5 s).
- ✅ The kit's MIT licence ships with the extension and is listed in the open-source notices.
- ✅ Tests: 192 unit tests, 130 extension checks (`npm run test:extension`: the kit's fixtures for generic, Greenhouse, Lever and Workday forms in headless Chrome, plus manifest and service-worker checks) and 319 end-to-end checks (new Discovery suite: 17).

- ✅ **Fix (v0.18.1):** on Windows, Turn on registered the bridge under misspelled registry keys (`Software\GoogleChrome`, `Software\MicrosoftEdge`, `Software\BraveSoftwareBrave-Browser`; a JavaScript string dropped the backslash), so Chrome, Edge and Brave couldn't reach the app; only Chromium worked. The tests compared the app with itself and missed it. Fixed, the misspelled keys are removed on Turn on, Turn off and uninstall, and the tests now check the real paths spelled out.

- ✅ **Fix (v0.18.2):** the Job Kit import no longer offers form fragments as Interview Brain facts. Saved answers ending in a preposition ("currently employed by" [this company]), stems covered by a fuller phrase ("relocat"), and the same long answer under several phrasings (an expiry date for "work permit", "study permit" and "permit expiry") are kept out or kept once; a careful saved "years of experience" answer replaces the single number; only "currently employed" counts as interview-relevant. Found while loading a real profile.

- ✅ **Dropdowns (v0.18.3):** every dropdown (29 in the main window, 2 in the Coding Lab) uses Chromium's customizable select: a themed open list with rounded hover rows, a checkmark on the current choice, group headings, a scrolling height limit and a minimum width; the closed box has a chevron that turns when open, hover and focus states, and long names end in "…". Checked in both themes.

- ✅ **Compact view text size (v0.18.4):** Settings → Window and shortcuts → Text size in compact view (80% to 160%) scales the compact window's answer and transcript as a whole, previews while dragging, is saved on release and applied at start; the full window is unaffected. Window suite: 30 checks. The window stays visible in screen shares (no content protection), by product rule.

### 4k. Next ⬜

- The UK sponsor-register check (needs the gov.uk register download and caching).
- A Chrome Web Store listing for the extension (needs a developer account).

- ◐ Real-provider benchmark: Claude done; GPT, Gemini and Deepgram need keys. A real company research run and a prep plan are still to measure

## Phase 5: Commercial platform ⬜

**Needs your decisions first:** hosting account, Stripe account, auth vendor, signing certificate, company entity.

- ⬜ Monorepo migration (`apps/`, `packages/`) without changing behaviour
- ⬜ Server:
  - ⬜ NestJS, Postgres/pgvector, Redis/BullMQ, R2
  - ⬜ auth with RBAC
  - ⬜ AI gateway with metering
  - ⬜ short-lived speech-to-text tokens
- ⬜ Sync between desktop and cloud, offline first; recordings encrypted on the client
- ⬜ Next.js web app: dashboard, practice in the browser, Coding Lab, career tools, analytics
- ⬜ Stripe plans with Billing Meters; customer portal
- ⬜ Release pipeline:
  - ⬜ signed installer
  - ⬜ auto-update
  - ⬜ CI (lint, unit, end-to-end)
  - ⬜ Sentry and OpenTelemetry
- ⬜ Admin: users, plans, refunds, abuse limits

## Phase 6: Reach ⬜

- ⬜ Mobile companion (Expo): review sessions, practise by voice, see live answers on your phone
- ⬜ VS Code extension for coding-interview practice
- ⬜ macOS build with ScreenCaptureKit system audio
- ⬜ Team and coach plans (organizations, shared question banks)

## Dependencies

- Phase 4's company research needs a provider with web search (Claude). Other providers get it once the gateway routes those calls.
- Phase 5 comes before Phase 6 (mobile and web need the server).
- The Coding Lab (Phase 3) runs entirely on the client, so the server is not needed for it.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Interview rules and ethics: copilots are banned in many interviews | Reputation, platform bans | Lead with practice and coaching. Disclosure in the start dialog. No stealth features. Marketing says "use where allowed". |
| Recording-consent laws (two-party consent states, GDPR) | Legal | Consent for each call, off by default, retention controls, data export and deletion. Legal review before launch. |
| System audio is Windows-only through Chromium | macOS users get mic only | Native ScreenCaptureKit module in Phase 6 |
| Provider price changes (Deepgram's current prices are promotional) | Margin | Switch speech provider (AssemblyAI is cheaper); per-plan minute caps; cache prompts |
| LLM latency during live calls | Usefulness | Low effort plus streaming; start on interim text (Phase 3); a fast model for live, a stronger one for feedback |
| Data breach once the cloud exists | Severe | RLS, encryption, recordings encrypted on the client, least-privilege keys, audit log, pen test before launch |
| Untrusted code in the Coding Lab | Security | WASM and Workers on the client only, no network, time limits |
| License contamination | Legal | Nothing copied from the audited repos; dependency license check in CI (AGPL banned) |
| Unsigned installer (SmartScreen warning) | Fewer installs | Azure Artifact Signing or an EV certificate before public launch |
| Scope: this brief is a multi-year product | Delivery | Ship by phase; every phase is usable on its own |

## Estimated operating costs

Prices are from [research/pricing-2026-11-15.md](research/pricing-2026-11-15.md).

### Per active user, per month

Assumptions: about 3 hours of live or practice audio, about 100 AI answers or grades (4k tokens in, of which 3k cached system prompt; 400 tokens out). Both channels (you and the interviewer) are transcribed.

| Item | Low | High |
|---|---|---|
| Speech to text: 3 h × 2 channels | $0.90 (AssemblyAI $0.15/hr) | $2.77 (Deepgram Nova-3 at the normal $0.0077/min) |
| LLM | $0.06 (Haiku 5.5) | $1.26 (Opus 5.5, cached) |
| Sonnet 5.5 as the middle option | about $0.63 (cached) | |
| **Total variable** | **about $1–4 per user** | |

### Fixed costs before scale

| Item | Per month |
|---|---|
| Neon Postgres | about $15 |
| Fly.io (2 small instances) | about $15–25 |
| Upstash Redis | $0–10 |
| Cloudflare R2 | under $5 |
| Azure Artifact Signing | $9.99 |
| Sentry (free tier) | $0 |
| **Total** | **about $50–70** |

### Payments

Stripe takes 2.9% + 30¢ per payment, plus 0.7% for Billing.

### At 1,000 active users

About $1,000–4,000 a month in variable costs plus about $70 fixed. At a $20–30 monthly price, the gross margin is roughly 75–95% after Stripe fees. The low end is $20 plans whose users pick the most expensive model and transcribe both channels.

The free tier, where users bring their own keys or run offline, costs us nothing to serve.
