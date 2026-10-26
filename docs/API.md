# HTTP API

Base URL: `http://127.0.0.1:3000/api`

The API is intended for the local dashboard. CORS only accepts the origins listed in
`FRONTEND_ORIGIN`. OpenRouter credentials never appear in any response.

## Errors

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed.",
    "details": [{ "path": "minScore", "message": "…", "code": "too_small" }],
    "requestId": "…"
  }
}
```

`400` validation, `404` missing record, `409` conflicting state, `429` rate limited,
`503` database unavailable. Request bodies are limited to 1 MB.

## Health

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | Process and database status |

## Documents

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/documents` | Inventory with type, profile, parse state and warnings |
| POST | `/documents/rescan` | Re-scan the read-only documents directory |
| GET | `/documents/:id/text` | Extracted text (explicit request only). PDF, DOCX and TXT are parsed; classification falls back to content when the filename is ambiguous. |
| PATCH | `/documents/:id/mapping` | `{ "docType": "cv"\|"cover_letter"\|"unknown", "profileKind": "full_stack"\|…\|"unassigned" }` |

## Profiles

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/profiles` | Three career profiles plus linked document metadata |
| POST | `/profiles` | Create a profile |
| GET | `/profiles/:id` | One profile |
| PATCH | `/profiles/:id` | Edit fields or approve (`status: "approved"`) |
| POST | `/profiles/:id/extract` | Extract skills/experience from the mapped CV (AI or heuristic) |

## Jobs

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/jobs/search` | Run discovery. Body: `{ "sources": ["arbeitnow"], "keywords": ["platform"], "maxJobs": 40 }` (all optional) |
| GET | `/jobs/sources` | Source configuration and readiness |
| GET | `/jobs` | Paginated, filtered list |
| GET | `/jobs/:id` | Job plus all profile matches |
| POST | `/jobs/:id/match` | Re-evaluate profiles. Body: `{ "profileIds": […], "profileKinds": […] }` |
| POST | `/jobs/:id/verify` | Re-check listing availability |
| POST | `/jobs/:id/age-check` | Recompute posting-age eligibility |
| POST | `/jobs/:id/classify-language` | Recompute the language classification from the stored text |
| PATCH | `/jobs/:id/state` | `{ "saved": true, "reviewed": true }` |

### `GET /jobs` query parameters

| Parameter | Meaning |
| --- | --- |
| `q` | Title, employer or location contains |
| `status` | `active` (default), `expired`, `unavailable`, `duplicate` |
| `source`, `employer`, `country` | Filters |
| `category` | `fullstack`, `backend`, `ai`, `devops_cloud`, `software` |
| `workArrangement` | `remote`, `hybrid`, `onsite`, `unknown` |
| `locationScope` | `germany`, `outside_germany_remote` |
| `remoteEligibleFromGermany` | `true` / `false` |
| `employmentType`, `seniority`, `minSalary` | Filters |
| `languageDecision` | `Eligible`, `Needs Review`, `Excluded` |
| `excludeGermanRequired` | `true` hides mandatory-German rows; omitted uses the saved setting |
| `englishRequired`, `germanOptional` | `true` filters |
| `ageEligibility` | `Eligible`, `Too Recent`, `unknown` review view, `Expired` |
| `postedWithinDays`, `postedAfter`, `postedBefore` | Date range, always clamped to the three-calendar-month floor |
| `minScore`, `maxScore`, `profileKind` | Match-score filters |
| `saved`, `reviewed`, `hasCoverLetter` | Personal state |
| `sort` | `newest` (default), `oldest`, `score`, `company`, `title` |
| `page`, `limit` | Pagination (`limit` max 100) |

Normal results exclude expired/unavailable rows, postings older than three calendar months
and rows without a verifiable posting date. `ageEligibility=Unknown` is the explicit review
view for the latter.

## Job cover letters and chat

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/jobs/:id/cover-letter/options` | Ranked CV/reference choices, recommendation and limitations |
| PATCH | `/jobs/:id/letter-preferences` | Remember `{ "cvProfileId": "…", "referenceProfileId": "…" }` |
| POST | `/jobs/:id/cover-letter` | Generate a new version (`profileId`, `referenceProfileId`, `instructions`) |
| GET | `/jobs/:id/cover-letters` | Versions for the job |
| PATCH | `/jobs/:id/cover-letters/:letterId` | Save an edit; keeps the generated text and a revision |
| GET | `/jobs/:id/cover-letters/:letterId/download?format=pdf\|docx` | Download |
| GET | `/jobs/:id/chat` | Latest conversation for this job only |
| POST | `/jobs/:id/chat` | Create a conversation |
| DELETE | `/jobs/:id/chat` | Clear this job's conversations |
| POST | `/jobs/:id/chat/messages` | `{ "content": "…", "sessionId": "…" }` → reply, sources, session |

A chat session is bound to exactly one job. Passing another job's session id is rejected.

## PhD opportunities

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/phd/search` | Run PhD discovery |
| GET | `/phd/sources` | Source status, including `simulated` |
| GET | `/phd/positions` | Paginated, filtered list |
| GET | `/phd/positions/:id` | Position plus profile matches |
| PATCH | `/phd/positions/:id/state` | `{ "saved": true, "reviewed": true }` |
| POST | `/phd/positions/:id/verify` | Re-read this position from the configured feed, refresh the deadline/closed status and `lastVerifiedAt`. Absence from the feed returns `unknown` and never closes the position. |
| POST | `/phd/positions/:id/match` | Re-evaluate profiles |
| GET | `/phd/positions/:id/cover-letter/options` | Ranked CV/reference choices |
| PATCH | `/phd/positions/:id/letter-preferences` | Remember the chosen pair |
| POST | `/phd/positions/:id/cover-letter` | Generate an academic letter version |
| GET | `/phd/positions/:id/cover-letters` | Versions |
| PATCH | `/phd/positions/:id/cover-letters/:letterId` | Save an edit |
| GET | `/phd/positions/:id/cover-letters/:letterId/download?format=pdf\|docx` | Download |
| GET/POST/DELETE | `/phd/positions/:id/chat` | Position-scoped conversation |
| POST | `/phd/positions/:id/chat/messages` | Ask a question about research fit |

### `GET /phd/positions` query parameters

| Parameter | Meaning |
| --- | --- |
| `q` | Title, institution, topic or location |
| `topic` | Research topic or title contains |
| `researchArea` | `ai`, `cybersecurity`, `software_engineering`, `data`; defaults to those four. `other` exists only for inspecting excluded rows. |
| `institution`, `country` | Filters |
| `deadlineStatus` | `open` (default), `unknown`, `expired`, `closed` |
| `deadlineWithinDays` | Closing window |
| `funded` | `true` (default) = explicit funding evidence only; `false` = review view for advertisements without funding evidence |
| `languageDecision` | `Eligible`, `Needs Review`, `Excluded`; German-mandatory excluded by default |
| `minScore`, `maxScore`, `profileKind` | Match filters |
| `saved`, `reviewed`, `hasCoverLetter` | Personal state |
| `sort` | `newest`, `oldest`, `score`, `deadline`, `institution`, `title` |

Only positions whose deadline is verified open (or explicitly rolling) appear by default.
Unknown deadlines are reachable only through `deadlineStatus=unknown`. PhD positions are never
filtered by posting age.

Discovery enforces three hard rules before a position is stored: the country must be in
Europe, Turkey, the USA or Canada; the research area must be AI, cybersecurity, software
engineering or data; and the advertisement must explicitly evidence funding (funded position,
salary, stipend, scholarship, doctoral contract, TV-L/E13 pay). Positions that state funding
must be secured by the applicant are labelled `not_funded`; silence is `unknown`. Neither is
listed by default.

## Matching

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/matches` | Stored job matches (filter by job/profile/score) |
| GET | `/matches/:id` | One match with its explanation |

## Dashboard

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/dashboard/summary` | Date-window job totals, high matches, open PhDs, approaching deadlines, last successful searches, source failures, recent runs, top matches |

## Search runs

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/search-runs` | Recent job and PhD runs with per-source counts and errors |
| GET | `/search-runs/:id` | One run |

## Settings and AI

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/settings` | Settings, source statuses, AI status (never the key) |
| PATCH | `/settings` | Partial update: `ai`, `search`, `phd`, `schedule`, `sources` |
| GET | `/ai/status` | Configured flag, model, limits, deterministic fallback |
| GET | `/ai/models` | Available OpenRouter models (`?force=true` refreshes) |
| POST | `/ai/test` | `{ "model": "…" }` connectivity check |

## Guarantees

- Posting-age, deadline, geography, language and duplicate rules are enforced server-side;
  UI filters cannot widen them.
- Match percentages come from the deterministic weighted models; the model may add
  explanations but cannot invent the percentage.
- Cover letters are generated from stored documents and validated before saving. Generation
  never creates or submits an application.
- Chat and letters are scoped to one job or one PhD position; stored transcripts never mix.
- No endpoint submits an application to an employer.
