# Personal AI Job Search & PhD Discovery Agent

A locally hosted dashboard that discovers professional jobs and doctoral positions, scores
them against your own CVs with a documented deterministic model, and drafts tailored cover
letters you can edit, version and download.

**It never submits an application.** It has no browser automation, no employer form filling
and no submission state machine. You decide where to apply and send the application yourself.

---

## What it does

| Area | Status |
| --- | --- |
| Three career profiles (Full Stack, AI Engineer, DevOps/Cloud) built from your PDF/DOCX CVs | ✅ tested |
| Professional job discovery with posting-date, geography and language enforcement | ✅ tested |
| Transparent CV match score (35/25/15/10/10/5 weights) with matched/missing skills | ✅ tested |
| Filters for category, date, company, arrangement, language, score, saved state | ✅ tested |
| Per-job AI chat with job-scoped history | ✅ tested |
| Job cover letters: generate, edit, regenerate, version, copy, download PDF/DOCX | ✅ tested |
| Fully funded PhD discovery in AI, cybersecurity, software engineering and data (Europe, Turkey, USA, Canada, Malaysia) | ✅ tested (simulated + configured feed) |
| PhD deadline eligibility (open / expired / unknown / closed / rolling) | ✅ tested |
| PhD research-area and profile match scoring (30/25/20/15/10 weights) | ✅ tested |
| Per-PhD chat and academic cover letters | ✅ tested |
| MongoDB persistence across restarts (named Docker volume) | ✅ tested |
| OpenRouter credentials backend-only | ✅ tested |
| Automatic application submission | ❌ intentionally absent |

Tests use deterministic fixtures and mocked AI responses. No test contacts a real employer,
university or the OpenRouter API.

## Architecture

```text
Laptop
├── React + Vite dashboard ............ http://localhost:5173
│      └── /api proxy ─────────────────┐
├── Docker Compose                    │
│   ├── backend (Express, TS) ......... http://127.0.0.1:3000
│   │      ├── OpenRouter API (optional AI)
│   │      ├── Arbeitnow / Remotive (public job APIs)
│   │      ├── Configured PhD JSON feed (optional)
│   │      └── /app/documents (read-only mount)
│   ├── mongodb (internal network, loopback-only host port)
│   └── worker (optional profile; scheduled discovery)
└── ./documents
    ├── cvs/                (3 CVs)
    └── cover-letters/      (3 reference letters)
```

Backend layers:

- `routes/` — HTTP validation with Zod, pagination, consistent JSON errors.
- `services/documents` — safe scanning, PDF/DOCX parsing, hashing, profile mapping.
- `services/jobs` — adapters, normalization, eligibility filters, dedupe, discovery, verification.
- `services/matching` — deterministic scoring plus optional AI review and caps.
- `services/phd` — PhD adapters, normalization, deadline metadata, scoring, academic letters.
- `services/ai` — OpenRouter client, retries, validated JSON, prompts, document ranking, chat.
- `services/coverLetters` — generation, grounding checks, PDF/DOCX rendering, version history.
- `models/` — Mongoose schemas and indexes.

## Requirements

- Docker Desktop (or Docker Engine + Compose v2)
- Node.js 22.12+ for the host frontend
- Text-based PDF or DOCX documents (scanned PDFs are detected, not OCR'd)
- Optional: an OpenRouter API key

## Quick start

1. **Configure environment**

   ```bash
   cp .env.example .env
   # optional: add OPENROUTER_API_KEY and a model
   ```

   `.env` is git-ignored and is never modified by the app.

2. **Add your documents**

   ```text
   documents/cvs/AI_Engineer_CV.pdf
   documents/cvs/Senior_Full_Stack_Developer_CV.pdf
   documents/cvs/DevOps_Cloud_Engineer_CV.pdf
   documents/cover-letters/AI_Engineer_Cover_Letter.pdf
   documents/cover-letters/Senior_Full_Stack_Developer_Cover_Letter.pdf
   documents/cover-letters/DevOps_Cloud_Engineer_Cover_Letter.pdf
   ```

   Filenames are hints only; every file can be remapped in **Documents**.

3. **Start MongoDB and the backend**

   ```bash
   docker compose up --build -d
   docker compose ps
   curl http://127.0.0.1:3000/api/health
   ```

   The documents folder is mounted read-only at `/app/documents`, and MongoDB data lives in
   the named volume `job-agent-mongo-data`.

4. **Start the dashboard on the host**

   ```bash
   cd frontend
   npm ci
   npm run dev
   ```

   Open <http://localhost:5173>.

5. **In the dashboard**
   1. **Documents** → confirm all six files are parsed and mapped to the right profile.
   2. **Profiles** → **Extract from CV**, review the skills/experience, then **Approve**.
   3. **Settings** → choose a model (optional), enable sources, set titles and filters.
   4. **Jobs** → **Run discovery** → filter, sort, save and review.
   5. Open a job → read the match explanation → **Generate cover letter** → edit, version,
      copy or download. **Ask about this job** keeps a conversation only for that job.
   6. **PhD Opportunities** → enable a source → **Search PhD positions** → filter by area,
      arrangement (on-site, hybrid or remote), deadline, funding, institution or score →
      **Verify deadline** (re-reads the configured source) → generate an academic letter and
      chat about fit.

Optional production-style frontend container:

```bash
docker compose --profile frontend up --build -d
```

Optional scheduled worker:

```bash
docker compose --profile worker up -d worker
```

Scheduling stays off until enabled in **Settings**.

## Documents

- Mounted read-only; files are never modified.
- Supported: `.pdf`, `.docx`, `.txt`. Maximum 10 MB per file (configurable).
- Classification uses the filename when it is unambiguous and falls back to the document's
  own text (`curriculum vitae`, `professional experience`, cover-letter greetings, etc.).
- A content hash detects replacements and re-parses changed files.
- Removed files are marked `missing`, never deleted from MongoDB.
- Scanned PDFs with almost no text are marked `needs_ocr`.
- Symlinks are ignored; only regular files under the configured root are read.
- Cover letters are writing references only; they are never altered.

## Sources

| Source | Access | What it provides |
| --- | --- | --- |
| **Arbeitnow** | Public API | Live jobs, mostly Germany |
| **Remotive** | Public API | Live remote jobs |
| **Configured PhD feed** | `PHD_FEED_URL` (permitted JSON) | PhD positions with deadline fields |
| **Simulated fixtures** | No network, opt-in | Clearly labelled fictional rows for exercising the pipeline |

The simulated job source is off by default (`ENABLE_MOCK_SOURCE=false`). The simulated PhD
source is on by default, because the PhD workspace has no live source until `PHD_FEED_URL` is
set; it can be switched off in the PhD page. Every simulated row is marked **Simulated fixture**
or **simulated** and uses `example.com`/`example.org` links, so it is never presented as a live
opportunity.

There is no HTML scraper, CAPTCHA bypass or authenticated scraping. A failing source never
deletes stored rows; the error is shown per source and on the overview page.

## Match scoring

### Professional jobs

`backend/src/services/matching/scoring.ts`:

| Category | Weight |
| --- | --- |
| Required technical skills | 35 |
| Relevant professional experience | 25 |
| Responsibilities and role alignment | 15 |
| Preferred skills | 10 |
| Seniority | 10 |
| Education / qualifications | 5 |

Weights are normalized over the categories that apply, so a posting without a stated
education requirement does not silently lose 5 points. The result is an **estimated profile
match**, not a probability of an interview. Location, working arrangement, language and
posting date are hard filters and are never compensated for by a high score.

Every listed job is scored automatically (deterministic) when the list or detail is opened,
so no displayed job lacks an explanation. An optional **Evaluate** action adds an AI review
layer; deterministic hard requirements still cap the final score and can force review.

### PhD positions

`backend/src/services/phd/scoring.ts`:

| Category | Weight |
| --- | --- |
| Research-topic alignment | 30 |
| Technical skills | 25 |
| Research experience and publications | 20 |
| Academic qualifications | 15 |
| Required methods and tools | 10 |

A missing mandatory qualification (for example a required master's degree) caps the score
at 60 and is highlighted even when the overall percentage is high. This is an estimated
profile match, not an admission probability.

## Date, location and language rules

### Professional jobs

- Only postings inside the last **three calendar months** appear in normal results.
  Calendar-month arithmetic is used, not 90 days.
- Supported UI ranges: 24 hours, 7, 14, 30 days, 3 months, custom range. Every range is
  clamped by the backend to the three-month floor, so a broader selection cannot reveal an
  older job.
- Unknown/unverifiable posting dates are excluded from normal results and are reachable only
  through the `ageEligibility=Unknown` review view.
- Expired, unavailable and duplicate listings are excluded from normal results.
- Within Germany: remote, hybrid and on-site roles are all allowed.
- Outside Germany: remote only, and the listing must permit work from Germany. A remote role
  restricted to another region is rejected; an ambiguous one is kept but flagged.
- English-sufficiency is required. German-mandatory postings are excluded by default;
  German-optional/preferred or unclear postings remain (unclear ones need review).
- All of these rules are enforced in the API, not just in the UI.

### PhD positions

- Deadline, not posting age, is the rule. A position posted six months ago remains visible
  while its verified deadline is in the future.
- A date-only deadline stays open through the end of that day in the institution's timezone;
  an explicit timestamp is compared exactly.
- Expired and closed/filled positions are excluded from normal results.
- Unknown deadlines are **not** assumed open: they appear only in the separate
  **Deadline needs verification** group.
- Only positions in **Europe, Turkey, the USA, Canada and Malaysia** are stored. Anything
  elsewhere is dropped at discovery, whatever the work arrangement.
- Only positions whose advertisement **explicitly evidences funding** (funded position,
  salary, stipend, scholarship, doctoral contract, TV-L/E13 pay) are stored. A position that
  says funding must be secured by the applicant, or says nothing, is excluded; the
  `funded=false` review view exposes those rows without listing them by default.
- Only research areas **AI, cybersecurity, software engineering and data** are in scope.
  Advertisements classified as any other research area are dropped.
- Rolling admission is treated as open only when the advertisement says so.

## Cover letters and chat

- Every job and PhD position has its own chat, stored with that target. Transcripts never mix.
- Chat context includes the full description, the ranked CVs, the existing reference
  letters, the stored match analysis and the conversation history.
- **Generate cover letter** uses all three CVs and all three existing letters: the most
  relevant CV is the factual source, the most relevant letter is the style reference, and
  query-relevant excerpts from the others supply supporting evidence.
- Generated text is checked for unsupported numbers/terms before it is saved.
- Drafts are editable, regenerate as new versions, and download as PDF or DOCX.
- Nothing is ever submitted, and generating a letter has no side effect on any application.

## Configuration

Copy `.env.example` to `.env`. Never commit `.env`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | Runtime mode |
| `PORT` | `3000` | API port |
| `MONGODB_URI` | `mongodb://mongodb:27017/job_agent` | Compose overrides with the service name |
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
| `PHD_FEED_URL` | empty | Permitted JSON feed of PhD positions; empty disables that source |
| `PHD_FEED_LABEL` | `Configured PhD feed` | Display label for the feed |
| `FRONTEND_ORIGIN` | `http://localhost:5173` | Allowed CORS origins (comma-separated) |
| `LOG_LEVEL` | `info` | pino log level |
| `SCHEDULER_ENABLED` | `false` | In-process scheduler (the worker profile is preferred) |
| `ENABLE_MOCK_SOURCE` | `false` | Enable clearly labelled local fixtures |
| `MONGO_HOST_PORT` | `127.0.0.1:27017` | Loopback-only MongoDB port |

Search settings, model choice, source toggles and filters are stored in MongoDB and edited in
**Settings**. `OPENROUTER_MODEL` is only the initial value.

## OpenRouter setup

1. Create a key at <https://openrouter.ai>.
2. Put it in `.env` as `OPENROUTER_API_KEY` (backend only; it is never sent to the browser).
3. Restart the backend: `docker compose up -d backend`.
4. **Settings → OpenRouter model** → load models (or type an ID) → **Test connection** → **Save**.

Without a key, extraction, scoring and letters fall back to deterministic templates and the
UI says so. Timeouts, rate limits, invalid model names and malformed JSON are surfaced, never
silently invented.

## Persistence and data model

MongoDB collections: `candidateprofiles`, `documents`, `coverletters`, `jobs`,
`phdpositions`, `jobmatches`, `phdmatches`, `searchruns`, `appsettings`.

- Unique index on `(source, sourceJobId)` for jobs and PhD positions.
- Job matches are unique per `(job, profile)`; PhD matches per `(position, profile)`.
- Indexes support status, posting date, deadline, research area, score and saved filters.
- Saved state, letters, chat sessions and settings all survive container restarts because
  `/data/db` is on the named volume.

## Tests and verification

```bash
cd backend
npm ci
npx tsc --noEmit
npm test                      # vitest, in-memory MongoDB, no external calls

cd ../frontend
npm ci
npm test                      # vitest: filter/sort query builders
npm run build                 # tsc --noEmit && vite build
```

Covered by automated tests: PDF/DOCX/TXT parsing, content-based document classification,
profile extraction, source normalization, geography and language classification,
calendar-month date rules, unknown dates, deduplication, deterministic job and PhD scoring,
PhD deadline logic and re-verification, chat isolation, letter generation/versioning,
MongoDB restart persistence, API validation, secret redaction, dashboard totals, funding and
language filters, simulated-fixture labelling, and frontend filter/sort query construction.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Backend unhealthy | `docker compose logs backend`; check `MONGODB_URI` and the health endpoint |
| Documents missing | Confirm `./documents` exists and contains PDF/DOCX files; press **Rescan** |
| PDF has no text | It is probably scanned; OCR is not included |
| "No job sources are enabled" | Enable at least one source in **Settings** |
| No PhD results | Enable the simulated source in the PhD page, or set `PHD_FEED_URL` to a permitted feed. An empty store is seeded automatically at startup; results are on-site, hybrid and remote positions in Europe, Turkey, the USA, Canada and Malaysia whose deadline has not passed |
| AI actions return a model error | Set `OPENROUTER_API_KEY`, choose a model in Settings, press **Test connection** |
| Frontend cannot reach the API | Run Vite on the host (`npm run dev`), or use the `frontend` Compose profile |

## Adding job sources and keywords

**Keywords and titles** are configured in **Settings → Search**:

- `targetTitles` adds extra job titles on top of the three profile title lists.
- `includeKeywords` narrows discovery to specific terms; `excludeKeywords` removes
  unwanted roles.
- Source toggles enable or disable Arbeitnow, Remotive, the simulated source and each PhD
  source.

**A new permitted job source:**

1. Add `backend/src/services/jobs/adapters/<source>.ts` implementing `JobSourceAdapter`
   (`searchJobs` returning `JobListing[]`). Use a documented public API or feed; do not
   scrape against a site's terms, bypass CAPTCHAs or use authenticated pages.
2. Register it in `backend/src/services/jobs/adapters/index.ts`.
3. Add its id to the source map in `defaultSettings()` and to the Settings UI toggles.
4. Add a fixture-based normalization test and a filter test; never call the live API in
   tests.

A new PhD source follows the same pattern under
`backend/src/services/phd/adapters/`, with deadline fields preserved exactly as the source
publishes them.

## Limitations (honest list)

- **PhD discovery needs a source.** The only real PhD adapter is a configured JSON feed; no
  university career page is scraped. The built-in PhD fixtures are simulated and off by
  default.
- **Live AI calls are not part of the test suite.** Tests inject deterministic or mocked
  responses; a configured OpenRouter key is exercised only by using the app.
- **Location and language classification are heuristic.** Country detection uses a curated
  list of German cities and federal states, the common `München`/`Muenchen` spellings, and
  patterns for foreign cities. A vacancy in a small town whose location omits the country can
  still be dropped as "location unknown" rather than guessed. Every row shows the evidence used
  and flags ambiguous cases for review.
- **No auto-submission, no OCR, no CAPTCHA bypass.** These are deliberate.
- **PhD deadline verification only works for the configured feed.** University career pages
  are not scraped; without `PHD_FEED_URL` the Verify action returns “unknown” rather than a
  guessed status.
- The German-language and posting-date rules are enforced on list, detail and discovery. If
  you explicitly request `languageDecision=Excluded` or the unknown-date review view, those
  rows are shown for inspection only.
