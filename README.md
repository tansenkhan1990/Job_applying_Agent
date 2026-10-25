# Personal AI Job Search & Application Agent

A locally running, full-stack job-search assistant. It reads your three CVs and cover
letters, builds three career profiles, discovers vacancies in Germany and remote EU,
scores each vacancy against each profile with visible evidence, prepares a tailored
cover letter, and enforces explicit human approval before any submission.

React + TypeScript dashboard · Express + TypeScript API · MongoDB · Docker Compose ·
OpenRouter (optional, with deterministic fallbacks).

> **This project does not claim automatic submission to real employers.**
> It implements the complete preparation/approval workflow and real, documented job
> discovery. Real application channels require you to finish the employer's form in your
> browser and then confirm it yourself. Only clearly fictional mock vacancies can use the
> simulated submission adapter. See [Honest limitations](#honest-limitations).

---

## Contents

- [Status](#status)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Documents](#documents)
- [OpenRouter setup](#openrouter-setup)
- [Job sources](#job-sources)
- [Daily workflow](#daily-workflow)
- [Approval and duplicate safety](#approval-and-duplicate-safety)
- [Configuration](#configuration)
- [Commands](#commands)
- [API](#api)
- [Data model](#data-model)
- [Tests](#tests)
- [Docker details](#docker-details)
- [Troubleshooting](#troubleshooting)
- [Privacy and security](#privacy-and-security)
- [Honest limitations](#honest-limitations)
- [Project layout](#project-layout)

---

## Status

Implemented and verified on this machine:

| Area | Status |
| --- | --- |
| Docker Compose backend + MongoDB | ✅ `docker compose up --build` healthy |
| React dashboard (10 pages) | ✅ builds; dev server and optional nginx container verified |
| PDF/DOCX ingestion, hashing, change/removal detection, OCR flag | ✅ automated tests |
| Document → career-profile mapping (auto + manual) | ✅ automated tests |
| Three seeded career profiles and CV-based extraction | ✅ AI path + rule-based fallback |
| Arbeitnow integration | ✅ live: 60 raw listings in a 20-job run |
| Remotive integration | ✅ live: 10 raw listings in a 20-job run |
| Mock source for offline testing | ✅ 8 fictional listings |
| Normalization, dedupe, German requirement/optional detection and filtering | ✅ automated tests |
| Three-day freshness window for discovery (configurable 1–90 days) | ✅ automated tests |
| Permanent applied-job registry; never re-applies to a stored application | ✅ automated tests |
| Hybrid matching with explanations and mandatory-requirement review | ✅ automated tests |
| Tailored cover letters with grounding checks | ✅ AI + template fallback |
| Application preparation, review, approval, submission guards | ✅ integration tests |
| PDF/DOCX cover-letter export, CSV history export | ✅ end-to-end verified |
| Scheduler + worker with persisted locks | ✅ container starts; disabled by default |
| Real automatic ATS submission | ❌ intentionally not claimed; manual channel only |
| OCR of scanned PDFs | ❌ detected and flagged, not performed |

All 77 backend tests pass, and an end-to-end API run covered ingestion → extraction →
approval → mock submission → downloads → live discovery. Automated tests never contact
real employers and never call OpenRouter.

## Architecture

```text
Laptop
├── React + Vite frontend ............ http://localhost:5173
│      └── /api proxy ────────────────┐
├── Docker Compose                   │
│   ├── backend (Express) ............ http://127.0.0.1:3000
│   │      ├── OpenRouter API (optional AI)
│   │      ├── Arbeitnow / Remotive (live sources)
│   │      └── /app/documents (read-only mount)
│   ├── mongodb (internal network, loopback-only host port)
│   └── worker (optional profile; scheduler + matching)
└── ./documents
    ├── cvs/
    └── cover-letters/
```

Backend layers:

- `routes/` — HTTP validation, pagination, consistent errors.
- `services/documents` — safe scanning, parsing, hashing, mapping.
- `services/jobs` — adapters, normalization, filters, dedupe, discovery, verification.
- `services/matching` — deterministic scoring + AI evaluation + merge/caps.
- `services/ai` — OpenRouter client, retries, JSON validation, prompts, status.
- `services/coverLetters` — generation, grounding, PDF/DOCX rendering.
- `services/applications` — preparation, answers, approval, state machine, submission.
- `models/` — Mongoose schemas and indexes.

## Requirements

- Docker Desktop (or Docker Engine + Compose v2)
- Node.js **22.12+** for running the frontend on the host (Node 26 was used locally)
- About 2 GB free RAM for the containers
- Real CV/cover-letter files as text-based PDF or DOCX (OCR is not included)
- Optional: an OpenRouter API key

## Quick start

1. **Configure environment**

   ```bash
   cp .env.example .env
   # edit .env if you have an OPENROUTER_API_KEY
   ```

2. **Add your documents**

   ```text
   documents/cvs/full-stack-cv.pdf
   documents/cvs/ai-engineer-cv.pdf
   documents/cvs/devops-cloud-cv.pdf
   documents/cover-letters/full-stack-cover-letter.pdf
   documents/cover-letters/ai-engineer-cover-letter.pdf
   documents/cover-letters/devops-cloud-cover-letter.pdf
   ```

   Filenames are hints only — you can map any file to any profile in the UI.

3. **Start backend + MongoDB**

   ```bash
   docker compose up --build -d
   docker compose ps
   curl http://127.0.0.1:3000/api/health
   ```

4. **Start the React dashboard on the host**

   ```bash
   cd frontend
   npm install
   npm run dev
   ```

   Open <http://localhost:5173>.

5. **In the dashboard**
   1. **Documents** → confirm all six files are `processed` and mapped; press **Rescan**.
   2. **Profiles** → **Extract from CV**, review every field, then **Approve profile**.
   3. **Settings** → choose a model (optional), enable sources, review thresholds.
   4. **Jobs** → **Run discovery** → **Evaluate** a vacancy.
   5. Open a job → **Prepare application** → review letter and answers → **Approve**.
   6. **Submit application**. For real employers the result is `NEEDS_MANUAL_ACTION` with
      the employer URL; after you finish their form, record your confirmation.
   7. **Applications** → track states and export CSV.

Alternative production-style frontend container:

```bash
docker compose --profile frontend up --build -d
# dashboard: http://127.0.0.1:5173 (nginx proxies /api to the backend)
```

Enable the optional background worker:

```bash
docker compose --profile worker up -d worker
```

Scheduling stays disabled until you enable it in **Settings**; `runOnStartup` controls
whether the first run happens immediately or after one interval.

## Documents

- The folder is mounted **read-only** at `/app/documents`; files are never modified.
- Supported: `.pdf`, `.docx`. Maximum size: 10 MB (configurable).
- A **content hash** detects updates. Replacing a file triggers re-parsing; the document
  is marked changed and applications prepared against the old hash cannot be submitted.
- Removed files are marked `missing`, never deleted from MongoDB.
- Scanned PDFs with almost no extractable text are marked `needs_ocr` with instructions.
- Symlinks are ignored; only regular files under the configured root are read.
- Auto-mapping uses folder/filename hints (`cvs`, `cover-letters`, `full-stack`,
  `ai-engineer`, `devops-cloud`). Manual mappings win and survive rescans.
- One CV per profile is linked. Cover letter documents are attached as reference for
  tailored generation; they are never altered.
- Full extracted text is excluded from document list responses; the review screen loads
  it explicitly.

## OpenRouter setup

1. Create an API key at <https://openrouter.ai>.
2. Put it in `.env` (backend only):

   ```env
   OPENROUTER_API_KEY=sk-or-...
   OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
   OPENROUTER_MODEL=
   ```

3. Apply it with `docker compose up -d backend` (restart).
4. In **Settings → OpenRouter model**, press **Load models**, choose a model (or type any
   model ID manually), press **Test connection**, then **Save**.
5. Model changes take effect immediately; no frontend rebuild is needed.

Behaviour:

- All requests go through one backend service; the API key is never sent to React.
- Timeouts, bounded retries with exponential backoff, rate-limit handling, insufficient
  credits, invalid models, provider errors and invalid JSON are classified and surfaced.
- Structured outputs are validated with Zod; a second request may repair invalid output,
  after which the operation fails safely instead of using unvalidated data.
- JSON mode is used only when the model's reported capabilities indicate support. If the
  provider rejects it, the client retries without it. Tool calling is never assumed.
- Input length and output tokens are capped (`AI_MAX_INPUT_CHARS`, `OPENROUTER` settings).
- Job descriptions and web content are wrapped as untrusted data. Prompt-injection
  attempts are ignored and flagged on the match for manual review.
- **Without a key**, the app remains functional with deterministic fallbacks:
  rule-based scoring, keyword-based profile extraction and a clearly labelled template
  cover letter. No AI claims are fabricated.

## Job sources

| Source | Access | Behaviour | Notes |
| --- | --- | --- | --- |
| **Arbeitnow** | Free public API, no key | Up to 2 pages per run, title-relevance prefilter, original listing URL preserved | Terms ask for no abuse and a link back; the UI links to the original listing. <https://www.arbeitnow.com/blog/job-board-api> |
| **Remotive** | Free public API, no key | One bounded request per run, max 50 results, attribution label | Remote-only listings. <https://remotive.com/api/remote-jobs> |
| **Mock** | No network | 8 fictional vacancies covering strong/weak matches, internship, unpaid, expired, German-mandatory and US-only cases | Test only. Simulated submission is available **only** when enabled and only for mock jobs. |

Adapters implement a common interface (`searchJobs`, optional `getJobDetails`/`verifyJob`).
Discovery:

- **only stores vacancies posted within the freshness window — three days by default**
  (Settings → Freshness window, 1–90 days). Listings whose source provides no publication
  date are kept and flagged `posted_date_unknown` rather than silently assumed fresh;
- normalizes title, employer, location, work arrangement, language requirement, seniority;
- filters internships, unpaid roles, stale postings, out-of-scope locations and excluded
  keywords;
- **keeps only vacancies where German is not required or optional** by default: postings
  that explicitly mandate German are filtered out, while English-friendly
  (`english_ok`), German-optional (`german_preferred`), explicitly not-required
  (`german_not_required`, e.g. “German is not required”) and unclassified postings stay.
  A job is never excluded merely for mentioning German, and the filter can be turned off in
  Settings;
- deduplicates by `(source, sourceJobId)`, canonical URL and a normalized
  employer/title/location fingerprint;
- records discovery and last-verification timestamps and per-source errors;
- never invents listings and never bypasses CAPTCHAs or access controls.

Adding another permitted source: implement a `JobSourceAdapter`, register it in
`backend/src/services/jobs/adapters/index.ts`, expose an enable toggle, and add a fixture
test. Do not add scraping that violates a site's terms.

## Daily workflow

1. **Discover** — bounded search in enabled sources, limited to vacancies posted in the
   last three days by default. Each run is recorded with per-source counts and errors; only
   one run may execute at a time. The per-source split respects the overall `maxJobsPerRun`
   budget. Only vacancies where German is not required or optional are stored by default
   (Settings → **Only keep jobs where German is not required or optional**).

   Seeded profile skills are only search hints. Running **Extract from CV** replaces them
   with skills actually evidenced by that CV, so match scores cannot be inflated by
   technologies you do not have.
2. **Evaluate** — deterministic filters and scoring first, then optional AI evaluation.
   The final score blends both, but hard requirements cap it. Missing or unknown
   mandatory requirements force manual review. Scores are relevance explanations, not
   probabilities of being hired.
3. **Prepare** — only for an approved profile with a mapped CV. The app selects that
   profile's CV, generates a tailored letter from the CV, original letter, profile and
   job, extracts explicitly stated screening questions, and creates a
   `READY_FOR_REVIEW` application.
4. **Review** — edit/regenerate the letter (each save is a new version), answer every
   required question, check grounding warnings.
5. **Approve** — the backend records approval against that exact application version,
   CV hash, letter hash and confirmed-answers hash.
6. **Submit** — the backend re-validates everything and checks availability, duplicates
   and the daily limit. Real sites yield manual instructions; nothing is falsely reported
   as submitted.
7. **Track** — filter history, inspect evidence and export CSV.

## Approval and duplicate safety

The backend—not the frontend—enforces all of these:

- `READY_FOR_REVIEW → APPROVED → SUBMITTING → SUBMITTED` state machine with audit history.
- Submission rejected unless the approval version matches the current version.
- Any letter edit, answer edit or regeneration increments the version and clears approval.
- CV content-hash mismatch rejection (document replaced after preparation/approval).
- Cover-letter hash mismatch rejection.
- Duplicate protection by job and by normalized employer/title, with no expiry: a vacancy
  that was applied to is never applied to again, even after months or when the employer
  reposts the same role under a new listing. Each submitted application stores `appliedAt`,
  employer, title and URL, so the registry survives listing removal.
- Daily submission cap.
- Fresh availability check; unavailable vacancies block submission.
- Required unanswered screening questions block approval.
- Legal/sensitive declarations (visa, salary, clearance, criminal record, etc.) are never
  auto-answered; they require your explicit input.
- A submission already `SUBMITTING` cannot be retried blindly for 10 minutes.
- Duplicate HTTP submissions and repeated prepare calls return the existing record or a
  conflict instead of creating duplicates.

`APPROVAL_REQUIRED=false` does **not** unlock unattended submission in this build; the
backend logs a warning and still requires approval. Unattended mode is intentionally not
implemented because the repository has no verified per-site submission adapters.

## Configuration

Copy `.env.example` to `.env`. `.env` is git-ignored.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | Runtime mode |
| `PORT` | `3000` | API port |
| `MONGODB_URI` | `mongodb://mongodb:27017/job_agent` | **Compose overrides to the service name** |
| `OPENROUTER_API_KEY` | empty | Backend-only AI key |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenAI-compatible base |
| `OPENROUTER_MODEL` | empty | Initial model; Settings can override |
| `OPENROUTER_HTTP_REFERER` | `http://localhost:5173` | Attribution header |
| `OPENROUTER_APP_TITLE` | `Personal Job Agent` | Attribution header |
| `AI_TIMEOUT_MS` | `90000` | Per-request timeout |
| `AI_MAX_RETRIES` | `3` | Bounded retries (0–6) |
| `AI_MAX_OUTPUT_TOKENS` | `2000` | Hard output cap |
| `AI_MAX_INPUT_CHARS` | `24000` | Prompt size guard |
| `DOCUMENTS_PATH` | `/app/documents` | Read-only document root |
| `MAX_DOCUMENT_SIZE_MB` | `10` | Per-file size limit |
| `FRONTEND_ORIGIN` | `http://localhost:5173,http://127.0.0.1:5173` | Allowed CORS origins |
| `LOG_LEVEL` | `info` | Pino level |
| `SCHEDULER_ENABLED` | `false` | Enable scheduler inside the API process |
| `ENABLE_MOCK_SOURCE` | `true` | Allow the fictional source to be enabled |
| `ALLOW_MOCK_SUBMISSION` | `false` | Permit simulated submission for mock jobs only |
| `MONGO_HOST_PORT` | `127.0.0.1:27017` | Loopback-only MongoDB host binding |

Search, scoring, schedule, application mode and model are stored as non-secret settings
in MongoDB and edited in **Settings**. Secrets are never stored there.

Frontend: `VITE_API_BASE_URL` (default `/api`; Vite proxies to `http://localhost:3000`).
For a custom backend during development, set `VITE_PROXY_TARGET`.

## Commands

```bash
# Backend (from backend/)
npm run dev          # tsx watch
npm run build        # esbuild -> dist/
npm run start        # node dist/index.js
# Bare-metal backend needs: MONGODB_URI=mongodb://127.0.0.1:27017/job_agent \    #   DOCUMENTS_PATH=../documents npm start
npm run typecheck
npm test             # 77 tests, in-memory MongoDB, external APIs mocked

# Frontend (from frontend/)
npm run dev
npm run build
npm run typecheck

# Docker
docker compose up --build -d
docker compose logs -f backend
docker compose --profile worker up -d worker
docker compose --profile frontend up --build -d
docker compose exec mongodb mongosh job_agent
docker compose down            # keeps data
docker compose down -v         # DESTRUCTIVE: also deletes MongoDB data
```

## API

Full endpoint documentation with examples and the approval invariant:
[`docs/API.md`](docs/API.md).

Highlights:

```text
GET    /api/health
GET    /api/settings            PATCH  /api/settings
GET    /api/ai/status           GET    /api/ai/models       POST /api/ai/test
GET    /api/profiles            PATCH  /api/profiles/:id    POST /api/profiles/:id/extract
GET    /api/documents           POST   /api/documents/rescan
PATCH  /api/documents/:id/mapping
POST   /api/jobs/search         GET    /api/jobs            GET  /api/jobs/:id
POST   /api/jobs/:id/match      POST   /api/jobs/:id/verify
GET    /api/matches             GET    /api/matches/:id
POST   /api/applications/prepare
GET    /api/applications        GET    /api/applications/:id
POST   /api/applications/:id/approve | submit | cancel | confirm-manual
PATCH  /api/applications/:id/cover-letter
POST   /api/applications/:id/cover-letter/regenerate
GET    /api/applications/:id/cover-letter/download?format=pdf|docx
GET    /api/applications/export.csv
GET    /api/applications/queue  GET /api/applications/:id/eligibility
GET    /api/applications/:id/assistant
POST   /api/applications/:id/assistant/start|pause|resume|stop
POST   /api/applications/:id/confirm-outcome
GET    /api/search-runs         GET    /api/search-runs/:id
GET    /api/dashboard/summary
```

Every endpoint validates input with Zod. Errors share one envelope. There is no endpoint
for arbitrary filesystem reads, shell commands or unrestricted browser navigation.

## Data model

MongoDB collections (Mongoose):

- **CandidateProfile** — career path, titles, skills, experience, languages, work
  preferences, linked CV/letter, draft/approved status, extraction metadata.
- **Document** — relative path, type, profile mapping, hash, preview, full text (opt-in
  select), page/word counts, status, missing flag.
- **Job** — normalized listing, source ids, URLs, location, arrangement, language,
  seniority, fingerprint, freshness, merged sources, and the posting-age fields
  `postedAt` (original publication date), `firstSeenAt`, `lastSeenAt`, `ageEligibility`
  (`Eligible` / `Too Recent` / `Unknown` / `Expired`), `eligibleAfter` and `ageCheckAt`.
  Age is computed with calendar-month arithmetic, never `firstSeenAt` in place of a missing
  `postedAt`.
- **JobMatch** — profile-specific score, breakdown, matched/missing skills, strengths,
  concerns, requirements, review flags, model and prompt version.
- **CoverLetter** — immutable versions per job/profile/application with grounding result
  and content hash.
- **Application** — state machine history, selected documents and hashes, questions,
  approval record, submission evidence, `appliedAt`, idempotency and duplicate keys. Each
  record snapshots the job title/company/location, `postedAt` and `ageEligibility`, the
  language classification with evidence, the document filenames and profile, the match
  score/explanation, the description snapshot, discovery date, preparation/form-filled
  dates, submission confirmation, form completion summary, unanswered questions and
  validation errors, browser-automation status and the last error. `statusHistory` is
  append-only (previous/new status, timestamp, reason, source `AI`/`user`/`system`,
  reference). This is the durable applied-jobs registry: submitted applications are never
  deleted and block re-application forever, even if the source listing disappears.
- **SearchRun** — criteria snapshot, per-source counts/errors, duration, trigger.
- **AppSetting** — one validated document with non-secret settings plus scheduler lock.

Indexes include unique `(source, sourceJobId)`, canonical URL, job status/discovery date,
unique `(job, profile)` for matches, match score, application status/date, and
`(job, profile)` for applications.

## Tests

```bash
cd backend
npm test
```

Coverage:

- PDF/DOCX parsing, empty-PDF OCR detection, corrupt/unsupported files
- scanning, hashing, changed/missing documents, manual mapping precedence
- URL canonicalization, fingerprints, normalization
- German requirement detection (`german_required`, `german_preferred`,
  `german_not_required`) including negations and the German-optional discovery filter
- jobs API filter that hides German-mandatory vacancies from the default list
- freshness window (three-day default), unknown publication dates flagged
- internships/unpaid/expired/location/title filters
- dedupe by source id, canonical URL and batch duplicates
- mock discovery, search-run persistence, overlap rejection, repeat runs
- deterministic scoring, mandatory-requirement caps, AI schema validation
- cover-letter grounding (invented tech/number/placeholder detection)
- template generation and PDF/DOCX rendering
- OpenRouter 429 retry, 402/auth classification, timeout, JSON repair, validation failure
- state transitions and history
- HTTP integration: validation errors, health, profile seeding
- approval enforcement, stale approval, CV mutation, duplicate submission/title,
  manual-action flow, CSV export
- applied-job registry: a role applied to 100 days ago is still blocked when reposted,
  and the jobs list exposes the stored application for each vacancy
- posting age: exactly three calendar months is eligible, anything newer is `Too Recent`,
  month-end clamping, unknown dates never enter the workflow, an old but closed listing is
  `Expired`, and a reposted job is not treated as old from `firstSeenAt`
- application queue and assistant preflight: age, language, availability, duplicate and
  match gates; a filled-but-unconfirmed form stays `AWAITING_REVIEW`; a confirmed
  submission cannot be submitted again
- form-field mapping and screening-question extraction
- application history survives a database restart on the same data directory (the Docker
  named volume does the same across container recreations)

`mongodb-memory-server` downloads a MongoDB binary on first use. Tests mock all external
HTTP calls and never submit a real application.

## Docker details

- Backend image: multi-stage `node:22-alpine`, production dependencies only, non-root
  user, HTTP healthcheck, resource limits.
- MongoDB: `mongo:7`, named volume `job-agent-mongo-data`, healthcheck, loopback-only host
  port. It is never published on all interfaces.
- Backend connects to `mongodb://mongodb:27017/job_agent` inside the Compose network.
- Documents are mounted read-only; generated cover letters are streamed from memory.
- Worker shares the backend image, has no HTTP port, and disables the API healthcheck.
- Optional nginx frontend serves the SPA and proxies `/api` to the backend.
- Structured logs redact authorization headers, CV/job text, answers, tokens and keys.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `env file .env not found` | `cp .env.example .env` |
| Backend restarts | `docker compose logs backend`; check `MONGODB_URI` uses the service name, not localhost |
| `/api/health` is 503 | MongoDB not ready or not reachable; check `docker compose ps` |
| Documents `readable: false` | Ensure `./documents` exists and Docker Desktop has file-sharing access |
| Documents missing after copy | Press **Rescan documents** |
| `needs_ocr` | The PDF is a scan; OCR it and replace the file, then rescan |
| Profile cannot be approved / prepared | Check the CV is mapped and the profile is approved |
| “No job sources enabled” | Enable a source in **Settings**; ensure it is configured |
| Arbeitnow/Remotive error | Temporary network/rate limit; retry later, inspect the search run errors |
| AI `not_configured` | Add `OPENROUTER_API_KEY`, restart backend |
| AI `auth` / `invalid_model` | Check the key and model ID; use **Test connection** |
| AI `insufficient_credits` | Add credits on OpenRouter |
| AI `rate_limit` / timeout | Bounded retries already ran; wait or choose another model |
| CORS error | Add the exact browser origin (scheme + host + port) to `FRONTEND_ORIGIN` |
| Port already in use | Stop the other process or change the published port |
| Submit says approval required | Approve the current version; edits invalidate approval |
| Submit says CV/letter changed | Rescan/re-prepare and approve again |
| Submit says duplicate | A submitted application exists for that job or employer/title |
| Worker shows no healthy status | Expected — the worker has no HTTP listener and its healthcheck is disabled |
| Tests cannot download MongoDB | Allow network access, or set `MONGOMS_SYSTEM_BINARY` to a local `mongod` |

## Privacy and security

- `.env` is git-ignored; the API key lives only in the backend process.
- Document text is stored in MongoDB on your machine and is excluded from list responses.
- Logs redact document/job text, answers, tokens and authorization headers.
- External AI calls include CV excerpts, profile data, job descriptions and letter drafts.
  If that is unacceptable, leave `OPENROUTER_API_KEY` empty and use deterministic mode.
- Only supported files inside the configured folder are read; symlinks are skipped and
  arbitrary paths are not accepted.
- Helmet, restricted CORS, request-body limits, rate limiting and full Zod validation are
  enabled.
- Job text is untrusted input. System prompts explicitly forbid following embedded
  instructions; detected injection attempts cap the score and require review.
- No CAPTCHA bypass, anti-bot evasion, or access-control circumvention exists.
- The published API and MongoDB ports are bound to loopback. There is no user
authentication because this is a single-user local application; do not change the Compose
  port mappings to expose it to a network.

## Honest limitations

- **No real automatic application submission.** Employer ATS forms differ and frequently
  require logins or CAPTCHAs. The manual adapter is the only real-job channel and records
  an outcome only when you confirm it. Simulated submission is restricted to fictional
  mock vacancies and is labelled as simulated.
- **No OCR.** Scanned PDFs are detected and blocked for extraction.
- **Source search is API-limited.** Arbeitnow has no keyword parameter (we page and
  prefilter); Remotive returns remote roles only. Neither source is scraped.
- **AI is optional.** Deterministic scoring is transparent but less nuanced than a good
  model; the template letter must be personalised.
- **Matching cannot verify legal eligibility** (visa, work authorization, clearance). Such
  requirements remain unknown and force manual review.
- **Grounding checks are conservative heuristics**, not proof of truth. You are the final
  reviewer, and approval is mandatory.
- **Single-user/local.** No multi-user auth, email notifications, or cloud deployment.
- **Cover letters are rendered on download**, not stored as files.

## Project layout

```text
.
├── backend/
│   ├── src/
│   │   ├── config/          env + defaults
│   │   ├── models/          Mongoose schemas
│   │   ├── routes/          REST endpoints
│   │   ├── services/        AI, documents, jobs, matching, cover letters, applications
│   │   ├── middleware/      error handling
│   │   ├── utils/           logging, text, hash, concurrency
│   │   ├── app.ts           Express app
│   │   ├── index.ts         API entry
│   │   └── worker.ts        scheduler entry
│   ├── tests/               77 Vitest tests
│   ├── Dockerfile
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── api/             typed fetch client
│   │   ├── components/      layout, UI, toast, modal, match card
│   │   └── pages/           overview, jobs, job detail, profiles, documents,
│   │                        applications, application review, settings
│   ├── Dockerfile + nginx.conf
│   └── package.json
├── documents/               read-only user documents (git-ignored contents)
├── docs/API.md
├── docker-compose.yml
├── .env.example
└── README.md
```

---

Built for a single laptop. Review every generated document and every application before
approving it.
