# Testing

## Commands

```bash
npm test
```

Runs all of the following.

```bash
npm run test:unit
```

192 `node:test` tests of `packages/core` (including job discovery: every source parsed from saved responses with every request checked against the allowlist, ranking, skip reasons, new-since-last-time and the digest, each compared with the Python's results; including the Autonomous Job Kit ports, each with a table of results the Python produced: the posting reader on every supported system's fixture with every request checked against the allowlist, scam warnings, the eligibility screen for Canada, the US and the UK, the fit score, and the fact checker; including the Autonomous Job Kit reader: a tracker.xlsx written by the kit's own tracker.py and an Excel-saved one, dates, statuses, the job folder's Markdown files, profile facts and what is never imported, matching, merging and the prompt block; including the live-answer rules that the prompt benchmark showed improve grounding; including meeting detection from Windows audio sessions, with a real run of the probe on Windows; including the Obsidian export: note names, properties, links, the transcripts option, and the writer's rules for edited, foreign and deleted notes; including calendar invites: folding, escaping, time zones with daylight saving, Windows and fixed-offset zones, meeting links, interview detection, job matching and the import plan; including lessons: metric suggestions, parsing the AI's reply, duplicates, which kept lessons reach a prompt), `src/meeting.js`, `src/exporter.js`, the browser bridge (job-page parsing, import validation, the native host spawned and spoken to in Chrome's length-prefixed format, launcher quoting, the extension's copy of the parser and its permissions) and the MCP server (started for real over stdio with the official SDK client against a fixture data folder; every tool called and checked as read-only), including the Coding Lab challenge library (every test case checked with reference solutions in real Pyodide, sql.js and Node): question matching and types, every speculation path, the echo filter, adaptive difficulty, coaching metrics, the prompt builders, and the meeting-detection parser (on output in the real `reg query` format).

```bash
npm run check
```

Syntax-checks every source file.

```bash
npm run test:extension
```

Runs the browser extension's checks (`tests/extension/check.js`): manifest and least-privilege rules, the Autofill rules, the service worker, and the Autonomous Job Kit's form fixtures (generic, Greenhouse, Lever, Workday) filled in headless Chrome or Edge (falls back to Electron with `--electron`).

```bash
npm run test:e2e
```

Runs the end-to-end suites. Each one starts the real Electron app in its own process with an isolated data folder, against a fake AI server.

## How the end-to-end suites work

Screen-sharing privacy coverage: `tests/unit/screen-privacy.test.js` tests native
state/readback, unsupported platforms, failures and boolean validation.
`window.js` additionally tests the Settings toggle, persistence, capture preview
invalidation, streaming during protection changes, and fresh-process startup
with privacy on and off (`privacy-restart.js`). Its Windows key-press checks need
the installed app closed to release the same global shortcuts. The suite's local
capture is not a Zoom/Teams/Meet test. Follow
[the manual meeting verification guide](SCREEN-SHARING-PRIVACY.md) on each OS.

`tests/e2e/run.js` starts each suite in its own Electron process and prints `PASS`/`FAIL` lines. It exits with code 1 if anything fails or times out.

Each suite:
- points `userData` at `tests/e2e/out/<suite>/userdata`, so your real data is never touched;
- starts a local HTTP server that imitates the Ollama `/api/chat` streaming API and answers according to the prompt;
- seeds old-format data (to test migrations), then drives the UI with `executeJavaScript` and takes screenshots into `tests/e2e/out/<suite>/`.

No real API key is used, and nothing is sent to any outside service.

| Suite | Covers |
|---|---|
| `phase1.js` (22 checks) | Moving an old job description into a job; Jobs list and editor; extracting, editing and saving Interview Brain facts without duplicates; that live answers include facts, job and grounding rule; the scenario prompt for mock interviews; scores split across stream chunks; delivery metrics; Progress totals, legacy scores, weakest skill, job filter; History detail; no horizontal overflow at 380 px; unit checks for `speechMetrics` and `splitScores` |
| `phase3.js` (24 checks) | Audio and video-capture services absent at idle; shared core loaded in the renderer; eager → draft → promotion with negative lead time; resumed speech cancels the draft upstream; a changed question gives a corrected answer; immediate start (no 700 ms wait); follow-up correction; manual mode; Flux and Nova-3 turn-event mapping; local engine reuses its early transcript, and drops it and re-transcribes when speech resumes; Ollama and Claude pre-warm; Claude SDK streaming through net.fetch; transcript and answer caps on screen; Flux setting |
| `phase3b.js` (16 checks) | Echo filter, whichever channel arrives first; STAR guidance and type label on behavioral answers; Shorter and Longer rewrites (previous answer and instruction sent; card replaced in place); panel rotation, adaptive and fixed difficulty, follow-up context; live practice meter; meeting prompt shown when idle and not during a session; meeting-detection setting |
| `codelab.js` (24 checks) | The real lab window with real Pyodide, sql.js and the JS sandbox: correct, wrong, exception and infinite-loop code in Python and JavaScript; hidden tests reveal pass/fail only; captured print output; restart after a timeout; network blocked for Python and JS code; SQL pass, fail and syntax errors; the `app://` allow-list and runner CSP; hint and review prompts; attempts recorded; Progress card |
| `echo.js` (11 checks) | Real AEC3 in the app's worker, fed in real time through the worklets on a simulated echo path: ≥ 15 dB of echo removed (measured 50–53), candidate voice within 6 dB (measured −0.5), frames processed, CPU per frame under 2 ms; Off setting and no-call-audio fall back to the raw mic; setting default; license notices generated |
| `career.js` (16 checks) | All career tools through the UI; keyword coverage and grounding in the prompt; match bars and keyword chips; PDF (`%PDF-`) and Word (read back with mammoth) exports; follow-up email from the last interview; research blocked politely without Claude; research against a fake Claude server (web search tool sent, `pause_turn` resumed, numbered citations and sources); links open outside the app; documents saved per job and deleted with the job |
| `phase4b.js` (15 checks) | Job contacts, deadline and follow-up saved; a due follow-up and a deadline within 24 h raise one in-app reminder each (with Open job) and don't repeat; list status labels; the prep plan prompt includes the saved company research and the plan is parsed into 3 typed questions; Mock practises the plan in order, graded as each question's type, with no AI call, then says it's finished; Next steps target the weakest skill; the question bank lists practised and planned questions with the best score, filters, and Practise opens the question in Mock; the MCP config in Settings points at this executable with `ELECTRON_RUN_AS_NODE` and an existing server file |
| `window.js` (30 checks) | Text size in compact view: the slider scales the compact transcript and answer, is saved, is applied again when settings load, stays between 80% and 160%, and leaves the full window alone. Also: The real window: default size, on top and opacity; opacity preview and save; always-on-top switch and pin, remembered; position and size remembered; compact view (size, corner, what's hidden, minimum size) and back to the same tab; all shortcuts registered; Ctrl+Shift+Y, U and H pressed through Windows (SendKeys); 50 ms timers at full speed while hidden; changing a shortcut, the new one working, Backspace turning one off, keys Windows refuses flagged; screen-sharing status and a real screen capture; an answer streaming completely while the window is put in compact view, faded, minimized, hidden and shown; idle and busy CPU and memory |
| `vault.js` (16 checks) | Obsidian export: off until a folder is chosen; first export into its own subfolder without touching other notes; job note properties and links; transcripts left out by default; Open in Obsidian link; automatic updates after a change; an edited note kept and reported; a deleted session's note removed; transcripts switch; auto-update off and Update now; Stop exporting; Delete everything keeps edited notes |
| `calendar.js` (18 checks) | An .ics file through the file picker: review order and suggested actions (cancelled → remove, match → set interview, interview → new job, other → skip); organizer and link shown; nothing changes before Import; the import sets the New York time correctly in UTC, link, stage, contacts without duplicates, notes; a new job; a cancelled interview removed; re-import adds nothing twice; dropping a file; refusing other files; Meeting link and Join in the editor and kept on save; day-before and 30-minute reminders with Join meeting, each once |
| `memory.js` (19 checks) | Lessons after a mock session: the prompt has the answers, scores and feedback and keeps the facts rule; a metric lesson plus AI lessons, a job lesson scoped to its job; dismiss, edit and keep; kept lessons in live answers, practice questions and grading; a job-only lesson left out for another job; nothing suggested twice; Profile → Memory lists, adds, rescopes and forgets; stopping a live session runs summary then lessons with a pace lesson; the two switches; clearing dismissed; a job's lessons deleted with it |
| `bridge.js` (24 checks) | Browser extension bridge: off by default; Turn on writes the launcher, manifest (only our extension ID) and a registry entry per browser under a throwaway key, at the browsers' real key paths spelled out (Google\Chrome, Microsoft\Edge, BraveSoftware\Brave-Browser, Chromium), and removes the misspelled keys versions before 0.18.1 left; ping and import through the real launcher the way Chrome starts it; another extension refused; the job saved with its URL and an import note, made active, banner with Open job; the same posting not added twice; bad inbox files dropped; the extension's page reader on a real page; the popup filled from JSON-LD, sending an edited job through the real launcher; the not-connected message; Turn off removes everything |
| `jobkit.js` (30 checks) | Autonomous Job Kit import from a copy of a real job-search folder (tracker made with the kit's tracker.py, real PDFs): review actions (update, new, skip), what was sent and the interview time shown, profile facts ticked or not, self-identification never offered; nothing changed before Import; the import sets stage, time, deadline, URL, description and notes, reads résumé and letter text from the PDFs, keeps answers, edits and gaps but not contact fields, adds only ticked facts; the folder is unchanged byte for byte; the live-answer prompt carries `<application_sent>`; What you sent in the editor and kept on save; re-import matches the linked job and keeps the user's stage; Settings status and switch; Remove; a tracker linking outside its folder; an unrelated folder |
| `jobcheck.js` (20 checks) | Fit, scam and eligibility chips in the jobs list (a short ordinary posting gets no scam chip); the job check card (score, parts, reasons, missing skills, the sentence that may rule you out) and its update while typing; Fill from link on a Greenhouse link with only allowed addresses contacted; another site never contacted; a redirect to an unknown address and a local address refused; Profile → Your job search loaded and saved, and the check following it; fact-check note absent on a grounded answer and listing an invented number and tool; the note on a tailored résumé with placeholders |
| `discover.js` (17 checks) | Find jobs now through the real app, answered from saved source responses: matches listed best first and marked New, every address on the discovery allowlist, failed sources reported, Remotive credited, the short-description warning left out; Add to Jobs creates a saved job and removes the match; Dismiss persists; a second search finds nothing new and doesn't offer jobs already in Jobs; following an employer; another link explained; the daily switch; the message without target roles |
| `phase2.js` (22 checks) | Inter font and SVG icons; old answer style becoming the active preset; built-in presets locked; custom preset saved and applied to the answer prompt (length, tone, format, language, instructions); translation shown and stored, and skipped when the line is already in the target language; consent dialog blocks Start until consent is ticked; notice acknowledged; WebM recording from a test tone; search with snippets; recording player in History; Markdown export; retention deleting old sessions; data flows and data info; export-all without secrets; light theme; deleting recordings and deleting everything |

## Not covered automatically

These need hardware or real accounts and are checked by hand:

- **Real provider calls:** Claude, OpenAI, Gemini, Deepgram (Claude is measured with `npm run bench:providers` and `npm run bench:jobkit`).
- **Live job sites:** the posting reader was checked by hand against a real Greenhouse and a real Lever posting on 16 November 2026; the suites use the kit's saved fixtures.
- **Real call audio:** system loopback during a Zoom, Meet or Teams call.
- **Local Whisper on real speech:** checked earlier against a recorded test question; not part of these suites.
- **The packaged installer:** install, launch, uninstall.
- **The extension in a real browser:** `node tests/manual/real-browser.js "<chrome.exe>"` with a Chromium build that allows extension debugging (Playwright's Chrome for Testing). It loads `extension/`, clicks the toolbar button on a local job page, and checks the popup read it, connected, and delivered the job. It registers the host under HKCU only while it runs.
- **Meeting apps:** `npx electron tests/manual/meeting-compat.js "<chrome.exe>"` uses a real Chrome tab (as Meet, Teams on the web and Zoom on the web do): the tab's microphone use must be detected, then its end, and system-audio capture must hear a tone it plays. Desktop Zoom and Teams use the same OS paths but need signed-in accounts, so they are checked by hand.
- **Claude Desktop with the MCP server:** the packaged server is checked with the SDK client after each build; connecting a real Claude Desktop is a manual step.

## Adding a test

Copy the `check(name, condition, detail)` pattern into the suite for the phase you are working on. Only remove an earlier check when the behaviour has deliberately changed. Every phase in the roadmap must keep all earlier checks passing.
