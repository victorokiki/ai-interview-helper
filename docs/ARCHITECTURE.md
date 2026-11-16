# Architecture

Last updated: 2026-11-15. This document covers the current architecture (v0.4.0) and the recommended target for the commercial platform.

## 1. Where we are

The app is a desktop program for Windows that runs entirely on your PC.

```
Electron main process (src/main.js)
├─ window, global shortcuts, screen capture, system-audio loopback
├─ AI calls: ai.js (prompts) → providers.js (Claude / OpenAI / Gemini / Ollama streaming)
├─ local data:
│    store.js        settings (keys encrypted with DPAPI), sessions
│    jobs.js         job workspaces
│    brain.js        Interview Brain facts
│    presets.js      answer presets
│    docs.js         documents + BM25 search
│    recordings.js   session audio
├─ utility process: whisper-worker.js (transformers.js + onnxruntime-node)
└─ IPC through preload.js (contextIsolation, sandbox, no Node in the renderer)

Renderer (src/renderer/)
├─ app.js        Live, Mock, History
├─ workspace.js  Jobs, Interview Brain, Progress
├─ controls.js   Presets, translation, consent + recording, privacy, theme
├─ coach.js      Speech metrics, score parsing, charts
└─ transcriber.js + pcm-worklet.js   Deepgram socket / local voice detection
```

All data sits under `%APPDATA%\Interview Helper` as JSON and WebM files. Users bring their own API keys, or run fully offline with Ollama and Whisper.

### Echo cancellation (v0.8)

```
call stream -> pcm-tap (10 ms) --MessagePort--> aec-worker (WebRTC AEC3, WASM) --MessagePort--> pcm-player -> cleaned mic MediaStream
mic stream  -> pcm-tap (10 ms) --MessagePort-->                                                     -> "Me" transcriber + recorder
```

The WASM bytes are sent from the main process over IPC (`aec:wasm`). Inaudible dither keeps near-silent audio out of the denormal range. If the canceller can't start, the raw mic is used and a banner says so.

### Coding Lab (v0.7)

```
Mock tab -> lab:open -> BrowserWindow (own renderer process)
   app://local/src/renderer/codelab.html   (src/lab.js protocol; allow-list + CSP per response)
     Monaco editor (workers same-origin via app://)
     WorkerRunner (time limit, terminate + restart)
        python-runner.mjs  Pyodide WASM + packages/core/pyharness.js
        js-runner.js       new Function in a Worker + packages/core/judge.js
        sql-runner.js      sql.js WASM, fresh DB per test + judge.js
   AI coach: ai:code (hint | review | explain) -> streams back to the lab window only
   Attempts: lab:saveAttempt -> userData/coding.json -> Progress card (aggregateCoding)
```

The runner workers have no network access (`connect-src 'self'` and no remote scripts). The lab page itself cannot evaluate strings or load remote code.

### Real-time answer pipeline (v0.5)

```
interviewer audio -> transcriber (Deepgram Flux | Nova-3 | local Whisper)
   onInterim(text)          live text on screen
   onTurn('eager', text)    probably finished -> SpeculationController.eager   -> start draft answer
   onTurn('resumed')        kept talking      -> SpeculationController.resumed -> cancel draft (stream aborted)
   onUtterance(final)       finished          -> SpeculationController.end:
                              same question            -> promote draft (keeps streaming)
                              changed                  -> cancel + corrected answer on the full question
                              follow-up within 2.5 s   -> corrected answer covering both
```

The controller (`packages/core/speculation.js`) is a pure state machine with no DOM or timers, so the web and mobile clients and the server can reuse it. Each recorded answer stores `latency.leadMs`: the time from the final question to the first word on screen, which is negative when the draft got there first.

## 2. Recommended target architecture

```
┌──────────────── clients ──────────────────────────────────────────────┐
│ Desktop (Electron)   Web (Next.js)   Extension (MV3)   Mobile (Expo)  │
│ uses packages/core + packages/ui                                      │
└────┬───────────────────┬──────────────────────────────────────────────┘
     │ HTTPS REST + SSE  │ (WebSocket only for sync and phone companion)
┌────▼───────────────────▼──────────────────────────────────────────────┐
│ apps/server: NestJS on Fastify (TypeScript)                           │
│ auth guard · RBAC · rate limits · usage metering · AI gateway (SSE)   │
│ STT token minting · Stripe webhooks · privacy export/delete           │
└────┬────────────┬───────────────┬─────────────────┬───────────────────┘
     │            │               │                 │
 Postgres +   Redis (Upstash)  Cloudflare R2     Providers: Anthropic,
 pgvector     cache, rate      (recordings,      OpenAI, Gemini,
 (Neon)       limits, BullMQ   documents,        Deepgram / AssemblyAI,
              jobs             encrypted)        Stripe
```

### Decisions and trade-offs

Rust-first or TypeScript-first was decided with measurements in [decisions/ADR-001](decisions/ADR-001-rust-vs-typescript.md): TypeScript-first, with Rust only for native modules a benchmark shows we need. The numbers are in [BENCHMARKS.md](BENCHMARKS.md).


| Decision | Choice | Why (evidence) | Trade-off |
|---|---|---|---|
| Desktop shell | **Stay on Electron** | System audio works through Chromium's loopback with no native code (`src/main.js`). The Tauri apps in the audit (NexQ) needed a large amount of Rust for WASAPI and Core Audio capture, and AnswerCue needed a Rust module even on Electron. In-process Whisper runs on onnxruntime-node in a utility process, which works today. | About a 150 MB installer and more RAM than Tauri. Acceptable for a desktop tool; revisit only if size becomes a sales blocker. |
| Native modules | **Rust via napi-rs, one module at a time, each justified by a benchmark** | Candidates: macOS system audio (Core Audio taps or ScreenCaptureKit), echo cancellation using the call audio as reference (WebRTC AEC3), faster local speech engines. Rust is memory-safe for code that handles raw audio buffers. | A Rust toolchain in CI. |
| macOS system audio | A native module later (ScreenCaptureKit) | Chromium loopback is Windows-only. NexQ and AnswerCue both needed native capture on macOS. | Extra platform code; macOS is Phase 6. |
| Backend language | **TypeScript (NestJS)**, not FastAPI | All our domain logic is JavaScript: prompts (`ai.js`), provider adapters, BM25, scoring and speech metrics. Moved into `packages/core`, the same code runs on desktop, server and web. We run no ML models on the server (everything is provider APIs), so Python's main advantage doesn't apply. | NestJS adds boilerplate; in return it gives modules, dependency injection, guards (RBAC) and testing patterns a growing team needs. Fastify alone is an option if the team stays at one or two people. |
| Database | Postgres + pgvector on Neon | One store for relational data and embeddings. Neon includes pgvector and has usage-based pricing (Launch plan, about $15/month typical). | Supabase bundles auth and storage at $25+/month; it's an alternative if we want its auth. |
| ORM and migrations | Drizzle ORM + drizzle-kit | Typed SQL, plain migration files, works well with pgvector. | Prisma is more popular but heavier, and its pgvector support is weaker. |
| Queues and cache | Redis (Upstash) + BullMQ | Summaries, fact extraction, company research, export and deletion jobs; rate limiting. | Pay-as-you-go Redis is cheap at this scale. |
| Real-time speech | **The client connects directly to Deepgram with a short-lived token** our server issues | Deepgram's `POST /v1/auth/grant` returns a JWT (30 s by default) usable for streaming. Audio never passes through our servers: lower latency, no bandwidth cost, simpler privacy story. AssemblyAI is the cheaper alternative ($0.15/hr). | We can't inspect the audio on the server, which is a feature. Metering uses usage reported by the client, checked against the provider's usage API. |
| AI calls | Through our server's AI gateway (SSE) on paid plans; straight from the desktop with the user's own keys on the free plan | The gateway holds the keys, meters tokens, enforces plan limits, and can fall back to another model. Keeping "bring your own key" + offline as a free tier is a privacy differentiator none of the competitors match. | An extra network hop on paid plans (about 20–50 ms). |
| Auth | Managed (Clerk or WorkOS) behind an `AuthProvider` interface; desktop signs in through the system browser (OAuth + PKCE, deep link back) | Avoids building password storage, MFA and SSO ourselves. Roles: `user`, `coach`, `org_admin`, `support`, `admin`. | A vendor dependency; the interface keeps it swappable. |
| Billing | Stripe Billing subscriptions + usage recorded with Billing Meters (`POST /v1/billing/meter_events`) | Stripe's documented path for usage billing. Stripe now recommends Metronome for new usage-based integrations; evaluate it once usage pricing is more than a cap. | Billing adds 0.7% on top of card fees. |
| File storage | Cloudflare R2, encrypted on the client before upload for recordings | No egress fees; $0.015 per GB-month. | — |
| Observability | Sentry (errors), OpenTelemetry traces, structured logs; latency inspector in the app (idea from NexQ's call log) | | — |
| CI/CD | GitHub Actions: lint, unit tests, Electron end-to-end harness (`tests/e2e`), signed Windows build (Azure Artifact Signing, $9.99/month), server deploy to Fly.io | Signing removes the SmartScreen warning. | Artifact Signing only covers certain countries (individual developers: US and Canada only); otherwise an EV certificate costs $149–349/year. |

## 3. Database schema (Postgres)

Every user-owned table has `user_id` and is protected by row-level security (`user_id = current_setting('app.user_id')::uuid`) as a second line of defence behind the API guards.

```sql
create extension if not exists vector;

create table users (
  id uuid primary key default gen_random_uuid(),
  auth_subject text unique not null,          -- id from the auth provider
  email citext unique not null,
  display_name text,
  role text not null default 'user' check (role in ('user','coach','org_admin','support','admin')),
  org_id uuid references organizations(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz                      -- soft delete, purged by the deletion job
);

create table organizations (id uuid primary key default gen_random_uuid(), name text not null, created_at timestamptz default now());

create table subscriptions (
  user_id uuid primary key references users(id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  plan text not null default 'free' check (plan in ('free','pro','team')),
  status text not null,                       -- Stripe status
  current_period_end timestamptz,
  updated_at timestamptz default now()
);

create table usage_events (                   -- source for metering and limits
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('stt_seconds','llm_input_tokens','llm_output_tokens','web_searches','code_runs')),
  quantity bigint not null,
  model text,
  session_id uuid,
  reported_to_stripe boolean default false,
  created_at timestamptz default now()
);
create index on usage_events (user_id, created_at);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  company text, role text,
  stage text not null default 'saved',
  interview_at timestamptz,
  job_description text, notes text,
  source_url text,                            -- browser extension import
  contacts jsonb default '[]',
  deadlines jsonb default '[]',
  created_at timestamptz default now(), updated_at timestamptz default now()
);

create table candidate_facts (                -- Interview Brain
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  category text not null,
  text text not null,
  source text,
  approved boolean not null default true,     -- only approved facts reach prompts
  embedding vector(1024),
  created_at timestamptz default now(), updated_at timestamptz default now()
);

create table documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null, mime text, object_key text, -- R2
  created_at timestamptz default now()
);
create table document_chunks (
  id bigserial primary key,
  document_id uuid not null references documents(id) on delete cascade,
  user_id uuid not null,
  ord int not null, text text not null,
  tsv tsvector generated always as (to_tsvector('english', text)) stored,
  embedding vector(1024)
);
create index on document_chunks using gin (tsv);
create index on document_chunks using hnsw (embedding vector_cosine_ops);

create table presets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null, length text, tone text, format text, language text, prompt text
);

create table sessions (
  id uuid primary key,                        -- generated on the client for offline-first sync
  user_id uuid not null references users(id) on delete cascade,
  job_id uuid references jobs(id) on delete set null,
  type text not null check (type in ('live','mock','panel','coding')),
  title text,
  started_at timestamptz not null, ended_at timestamptz,
  summary text, summary_at timestamptz,
  speech jsonb,                               -- {words, wpm, fillers, ...}
  recorded boolean default false,
  recording_consent_at timestamptz,           -- when the user confirmed consent
  updated_at timestamptz default now()
);
create table transcript_segments (
  id bigserial primary key,
  session_id uuid not null references sessions(id) on delete cascade,
  user_id uuid not null,
  speaker text not null check (speaker in ('me','them','ai')),
  text text not null, translation text,
  t timestamptz not null, dur_seconds real,
  tsv tsvector generated always as (to_tsvector('simple', text)) stored
);
create index on transcript_segments using gin (tsv);

create table answers (                        -- live answers, screenshots, practice attempts
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  user_id uuid not null,
  kind text not null check (kind in ('answer','screenshot','mock','coding')),
  scenario text, question text not null, my_answer text, answer text,
  scores jsonb,                               -- {clarity, structure, specificity, relevance, depth, overall}
  speech jsonb, t timestamptz not null
);

create table recordings (
  session_id uuid primary key references sessions(id) on delete cascade,
  user_id uuid not null, object_key text not null, bytes bigint,
  encrypted boolean not null default true, expires_at timestamptz
);

create table coding_problems (id uuid primary key default gen_random_uuid(), slug text unique, title text, difficulty text,
  languages text[], prompt_md text, starter jsonb, tests jsonb, tags text[]);
create table coding_submissions (id uuid primary key default gen_random_uuid(), user_id uuid not null references users(id) on delete cascade,
  problem_id uuid references coding_problems(id), language text, code text, passed int, total int, runtime_ms int,
  review jsonb, created_at timestamptz default now());

create table career_artifacts (               -- cover letters, LinkedIn rewrites, follow-ups, resume versions
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  job_id uuid references jobs(id) on delete set null,
  kind text not null, title text, content text, created_at timestamptz default now()
);

create table company_research (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  job_id uuid references jobs(id) on delete cascade,
  content_md text not null,
  sources jsonb not null,                     -- [{url, title, retrieved_at}] shown as citations
  created_at timestamptz default now()
);

create table privacy_settings (user_id uuid primary key references users(id) on delete cascade,
  retention_days int default 0, recording_retention_days int default 30, sync_recordings boolean default false);

create table audit_log (id bigserial primary key, actor_id uuid, user_id uuid, action text not null,
  target text, ip inet, at timestamptz default now());
```

## 4. API contracts (`/v1`, JSON, bearer JWT)

Errors follow `{ "error": { "code": "string", "message": "string" } }`. Streaming endpoints use Server-Sent Events: `event: delta` (`{text}`), `event: done` (`{usage}`), `event: error`.

| Method and path | Purpose | Body → Response |
|---|---|---|
| `GET /me` | Profile, plan, entitlements, usage this period | → `{user, plan, limits, usage}` |
| `DELETE /me` | Delete the account (queued job; data purged within 30 days) | → `202` |
| `GET/POST /jobs`, `PATCH/DELETE /jobs/:id` | Job workspaces | `Job` |
| `POST /jobs/import` | Import a job posting from a URL (SSRF-safe fetch + extraction) | `{url}` → `Job` |
| `GET/PUT /facts` | Interview Brain (replace all) | `Fact[]` |
| `POST /facts/extract` | Queue extraction from resume and documents | → `{jobId}`; results via `GET /tasks/:id` |
| `POST /documents` | Get a presigned upload URL, then chunk + embed | `{name, mime}` → `{id, uploadUrl}` |
| `GET/POST/PATCH/DELETE /presets` | Answer presets | `Preset` |
| `POST /stt/token` | Short-lived Deepgram/AssemblyAI token (checks plan minutes) | → `{provider, token, expiresAt}` |
| `POST /ai/answer` | **SSE.** Live answer | `{sessionId?, question, transcript[], presetId?, jobId?}` |
| `POST /ai/screenshot` | **SSE.** Vision solve | `{image (base64, ≤ 4 MB), hint?}` |
| `POST /ai/translate` | Translate one line | `{text, to}` → `{text}` |
| `POST /practice/question` | **SSE.** Next mock question (adaptive) | `{scenario, previous[], difficulty?}` |
| `POST /practice/grade` | **SSE.** Scores + feedback | `{question, answer, scenario, speech?}` |
| `PUT /sessions/:id` | Create or replace a session (offline-first sync, last write wins on `updated_at`) | `Session` |
| `POST /sessions/:id/segments` | Append transcript segments in batches | `Segment[]` |
| `GET /sessions?query=&jobId=&cursor=` | List and full-text search | → `{items, nextCursor}` |
| `POST /sessions/:id/summary` | **SSE.** Post-call summary | — |
| `POST /sessions/:id/recording` | Presigned upload for an encrypted recording | → `{uploadUrl}` |
| `GET /analytics/summary?jobId=` | Progress aggregates | → `{avgScore, trend, dims, byScenario, wpm, fillers}` |
| `POST /code/run` | **Not on the server:** code runs on the client in WASM. The server only stores submissions. | — |
| `POST /research/company` | Queue cited company research (Claude web search tool) | `{jobId}` → task |
| `POST /career/:kind` | **SSE.** Cover letter, LinkedIn, follow-up email, resume check | `{jobId?, input}` |
| `POST /billing/checkout`, `POST /billing/portal` | Stripe Checkout / Customer Portal sessions | → `{url}` |
| `POST /webhooks/stripe` | Subscription lifecycle (signature checked) | — |
| `POST /privacy/export` | Queue a full data export (zip in R2, emailed link) | → task |

### Event flow for a live session (paid plan)

1. The desktop calls `POST /stt/token` and opens two Deepgram sockets (mic and system audio) directly.
2. Final utterances are shown in the app and batched to `POST /sessions/:id/segments` every 10 s, or kept offline and synced later.
3. A detected question goes to `POST /ai/answer` (SSE). The gateway:
   - builds the prompt with `packages/core`;
   - streams from the provider;
   - writes `usage_events`;
   - enforces the plan's per-minute and monthly caps.
4. On stop, the client sends `PUT /sessions/:id`. The server queues `summary` and `analytics` jobs. A BullMQ worker writes the summary and pushes `session.updated` over the WebSocket to the web and mobile clients.

## 5. Folder structure

**Target.** We migrate to this at the start of Phase 5, without changing behaviour, verified by `tests/e2e`.

```
apps/
  desktop/      Electron: today's src/ (main, preload, renderer, whisper worker)
  web/          Next.js App Router: dashboard, practice, Coding Lab, career tools
  server/       NestJS: modules auth, jobs, facts, documents, sessions, ai, stt, billing, privacy, research
  extension/    MV3 job-posting import
  mobile/       Expo companion (Phase 6)
packages/
  core/         ✅ exists (v0.5): question.js, speculation.js, coaching.js, prompts.js (UMD: CommonJS + browser global). Still to move: provider adapters, BM25
  ui/           design tokens (from styles.css), shared components
  db/           Drizzle schema + migrations
  mcp/          MCP server exposing jobs, facts, sessions (read) and practice tools
docs/           AUDIT.md, ARCHITECTURE.md, ROADMAP.md, TESTING.md, research/
tests/e2e/      Electron end-to-end harness (fake AI server)
```

## 6. Security notes

**Already in place:**
- context isolation and sandbox, no Node in the renderer
- a strict CSP
- private keys never reach the renderer
- DPAPI-encrypted keys
- recording only after per-call consent
- no stealth features

**To add with the platform:**
- RLS and audit log
- encrypting recordings on the client
- rate limits per user and IP
- SSRF guard on URL imports
- signed updates
- dependency scanning in CI
- a threat model review before launch

Coding Lab code runs only in WASM or Web Workers on the client (Pyodide, sql.js, a sandboxed JS worker), never on our servers.
