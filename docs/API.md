# REST API

Base URL: `http://localhost:3000/api`

All responses are JSON unless noted. Errors use one envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed.",
    "details": [{ "path": "jobId", "message": "Expected a 24-character MongoDB id" }],
    "requestId": "…"
  }
}
```

Common status codes: `400` validation, `404` not found, `409` conflict / approval or
duplicate guard, `429` rate limit or AI rate limit, `503` AI not configured.

Authentication is intentionally omitted: the published port is bound to `127.0.0.1` and
the API is meant for a single local user. Inside the container the process listens on all
interfaces, so do not change the port mapping to expose it on your network.

## Health

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | MongoDB ping, documents readability, AI and source status |

`200` when MongoDB is reachable, `503` otherwise.

## Settings

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/settings` | Settings + source status + AI status |
| PATCH | `/settings` | Deep-merge validated, non-secret settings |

Example:

```http
PATCH /api/settings
Content-Type: application/json

{
  "ai": { "model": "google/gemini-2.5-flash" },
  "search": {
    "minRelevanceScore": 80,
    "maxJobsPerRun": 40,
    "freshnessDays": 365,
    "maxAgeMonths": 3,
    "excludeGermanRequired": true,
    "targetTitles": ["AI Engineer", "LLM Engineer", "Platform Engineer"]
  },
  "application": { "mode": "approval_required", "maxDailyApplications": 5 }
}
```

The API key is never returned by this endpoint.

## AI

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/ai/status` | Configured, base URL, selected model, limits |
| GET | `/ai/models?force=true` | OpenRouter model catalog (id, context, capabilities, pricing) |
| POST | `/ai/test` | One tiny chat completion; `{ "model": "…" }` optional |

When no API key is configured, AI endpoints report that honestly and the rest of the
application uses deterministic fallbacks.

## Career profiles

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/profiles` | Three seeded profiles with linked document metadata |
| POST | `/profiles` | Create a profile for a seed kind (fails if it exists) |
| GET | `/profiles/:id` | One profile |
| PATCH | `/profiles/:id` | Edit validated fields or set `status` to `draft` / `approved` |
| POST | `/profiles/:id/extract` | Extract structured facts from the mapped CV (AI or heuristic) |

Extraction always leaves the profile in `draft`, requiring human review.

## Documents

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/documents` | Document metadata, mapping and folder status (no full text) |
| POST | `/documents/rescan` | Scan the mounted folder; parse, hash, detect changes/removals |
| GET | `/documents/:id/text` | Extracted text for local preview |
| PATCH | `/documents/:id/mapping` | Assign `docType` and `profileKind` manually |

```http
PATCH /api/documents/665f.../mapping

{ "docType": "cv", "profileKind": "full_stack", "mappingReviewed": true }
```

There is no endpoint that accepts a filesystem path. Files are read only from
`DOCUMENTS_PATH`, must be `.pdf` or `.docx`, are size-limited, and symlinks are skipped.

## Jobs

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/jobs/search` | Run bounded discovery. Body: `{ "sources": ["arbeitnow"], "maxJobs": 20 }` |
| GET | `/jobs/sources` | Source configuration status |
| GET | `/jobs` | Paginated list. Each returned job carries a deterministic baseline `bestMatch` (backfilled without an AI call if missing). Discovery enforces the Germany/remote geography rule; each job exposes `remoteEligibleFromGermany` (true/false/null evidence). Query: `q`, `category` (`fullstack`/`backend`/`ai`/`devops_cloud`/`software`), `status` (default `active`; other values must be requested explicitly), `source`, `profileKind`, `minScore`, `maxScore`, `excludeGermanRequired`, `languageDecision`, `germanOptional`, `englishRequired`, `ageEligibility`, `postedAfter`, `postedBefore`, `postedWithinDays`, `workArrangement`, `country`, `locationScope`, `remoteEligibleFromGermany`, `minSalary`, `employer`, `seniority`, `employmentType`, `saved`, `reviewed`, `hasCoverLetter`, `sort` (`newest`/`oldest`/`score`/`company`/`title`), `page`, `limit` |
| GET | `/jobs/:id` | Job + all profile matches |
| POST | `/jobs/:id/match` | Hybrid evaluation. Body: `{ "profileKinds": ["full_stack"] }` |
| POST | `/jobs/:id/verify` | Best-effort availability check with evidence |
| PATCH | `/jobs/:id/state` | Personal state. Body: `{ "saved": true, "reviewed": true }` |
| GET | `/jobs/:id/cover-letter/options` | All three CVs and letters, the recommended CV/reference pair, selection rationale, limitations, and whether the description changed since the last letter |
| PATCH | `/jobs/:id/letter-preferences` | Remember this job's CV/reference choice. Body: `{ "cvProfileId": "…", "referenceProfileId": "…" }` |
| POST | `/jobs/:id/cover-letter` | Generate a new letter version. Body: `{ "profileId": "…", "referenceProfileId": "…", "instructions": "optional" }`. Creates no application and submits nothing. |
| GET | `/jobs/:id/cover-letters` | Letter versions, newest first. Optional `profileId` |
| PATCH | `/jobs/:id/cover-letters/:letterId` | Save edits. Body: `{ "letterText": "…" }` |
| GET | `/jobs/:id/cover-letters/:letterId/download?format=pdf\|docx` | Render a stored version |
| GET | `/jobs/:id/chat` | Latest stored conversation for this job, or `{ "session": null }` |
| POST | `/jobs/:id/chat` | Start a new empty conversation for this job |
| POST | `/jobs/:id/chat/messages` | Send a message. Body: `{ "content": "…", "sessionId": "optional" }`; returns `{ session, reply, model, sources }` |
| DELETE | `/jobs/:id/chat` | Clear this job's conversations. Returns `{ deleted }` |

`excludeGermanRequired=true` hides vacancies whose posting explicitly mandates German.
German-optional (`german_preferred`), explicitly not-required (`german_not_required`) and
unclassified (`unknown`) postings are kept. Discovery applies the same rule by default via
`search.excludeGermanRequired`; set it to `false` in Settings to store every vacancy.

Discovery keeps only vacancies posted less than `search.maxAgeMonths` calendar months ago
(default `3`). `search.freshnessDays` (default `365`) remains a hard retention cap when that
window is relaxed. A listing without a publication date is stored with
`postedAtUnknown: true`, but it is **excluded from normal results**. Pass
`ageEligibility=Unknown` to open the separate date-verification review list; those jobs can
never be prepared for an application until their original date is verified. Every
`postedAfter`, `postedBefore` or `postedWithinDays` filter is additionally clamped to the
three-month floor, so a broad or custom range cannot reveal an older vacancy.

### Posting age

Only postings less than **three calendar months** old are listed and may enter the
application workflow. The threshold is computed with calendar-month arithmetic (not 90 days):
on `2026-10-25` the cutoff is `2026-07-25`, so a job posted on `2026-07-25` is already three
calendar months old and is excluded, while a job posted on `2026-07-26` is still eligible.
Month-end dates are clamped consistently (`2026-05-31` + 3 months → `2026-08-31`). When a
source publishes a wall-clock date without a timezone, that calendar day is stored as
`postedLocalDate` and used for the threshold instead of the UTC day. PhD positions are not
subject to this rule; they stay listed until their application deadline passes.

Every job exposes `postedAt`, `firstSeenAt`, `lastSeenAt`, `ageEligibility` (`Eligible`,
`Unknown`, `Expired`), `eligibleAfter` (the cutoff date: postings must be after it) and
`ageCheckAt`. `Too Recent` remains in the enum only for records stored by older builds. A
missing or unverifiable publication date is never substituted with `firstSeenAt`: the job is
marked `Unknown` and shown only in the separate review view. `GET
/applications/:id/eligibility?verify=true` re-runs the full check immediately before the
assistant starts and returns every reason.

Each item returned by `GET /jobs` also carries the stored application for that vacancy:

```json
{
  "id": "…",
  "title": "Senior Full Stack Engineer",
  "postedAt": "2026-10-23T08:00:00.000Z",
  "application": { "id": "…", "status": "SUBMITTED", "appliedAt": "2026-10-24T10:12:00.000Z" }
}
```

Discovery returns a run summary:

```json
{
  "runId": "…",
  "status": "completed",
  "discovered": 70,
  "created": 14,
  "updated": 0,
  "duplicates": 1,
  "filteredOut": 18,
  "sources": [
    { "source": "arbeitnow", "status": "ok", "found": 60, "created": 9, "filtered": 13 }
  ]
}
```

## PhD opportunities

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/phd/search` | Run PhD discovery. No body. Returns per-source counts/errors |
| GET | `/phd/sources` | PhD source status (simulated / configured / enabled) |
| GET | `/phd/positions` | Paginated list. Positions without a stored match are scored deterministically on read, so every item carries a `bestMatch`. By default only active positions with verified open deadlines are returned. Query: `q`, `topic`, `researchArea` (`ai`/`cybersecurity`/`software_engineering`/`other`), `institution`, `country`, `languageDecision`, `deadlineStatus` (`open`/`unknown`/`expired`/`closed`; `open` includes rolling admissions stated by the source, while a missing deadline stays `unknown`), `deadlineWithinDays`, `status`, `saved`, `reviewed`, `hasCoverLetter`, `minScore`, `maxScore`, `profileKind`, `sort` (`newest`/`oldest`/`score`/`deadline`/`institution`/`title`), `page`, `limit` |
| GET | `/phd/positions/:id` | Position + all profile matches |
| PATCH | `/phd/positions/:id/state` | Body: `{ "saved": true, "reviewed": true }` |
| POST | `/phd/positions/:id/match` | Compute estimated profile matches. Optional `{ "profileIds": [...] }` or `{ "profileKinds": [...] }` |
| GET | `/phd/positions/:id/cover-letter/options` | CV/reference choices, recommendation, rationale, limitations, and description-change flag |
| PATCH | `/phd/positions/:id/letter-preferences` | Remember this position's CV/reference choice |
| POST | `/phd/positions/:id/cover-letter` | Generate academic letter. Body: `{ "profileId": "…", "referenceProfileId": "…", "instructions": "optional" }` |
| GET | `/phd/positions/:id/cover-letters` | Letter versions, newest first |
| PATCH | `/phd/positions/:id/cover-letters/:letterId` | Save edits |
| GET | `/phd/positions/:id/cover-letters/:letterId/download?format=pdf\|docx` | Render a stored version |
| GET | `/phd/positions/:id/chat` | Latest stored conversation for this position |
| POST | `/phd/positions/:id/chat` | Start a new empty conversation |
| POST | `/phd/positions/:id/chat/messages` | Send a message. Body: `{ "content": "…", "sessionId": "optional" }` |
| DELETE | `/phd/positions/:id/chat` | Clear this position's conversations |

PhD inclusion rules: Germany in any arrangement; outside Germany only remote positions that
explicitly state remote work from Germany is possible. Postings that mandate German are
filtered by default; ambiguous ones are stored as `Needs Review` with evidence. Scores are
estimated profile matches (topic 30, technical skills 25, research experience/publications
20, academic qualifications 15, methods 10, normalized over applicable categories), not
admission probabilities. A missing mandatory qualification caps and flags the result.

PhD positions are **not** subject to the three-month posting-age rule. Each stored position
records `applicationDeadline`, `deadlineTimezone`, `deadlineHasTime`, `deadlineStatus`
(`open`/`expired`/`unknown`/`closed`), `deadlineNote` and `lastVerifiedAt`, plus a
deterministic `researchArea` (`ai`, `cybersecurity`, `software_engineering`, `other`) with
the `researchAreaEvidence` that produced it. A date-only deadline remains open through the
end of that local calendar day; an explicit time is compared exactly. Expired and
closed/filled positions are excluded from normal results but remain inspectable with
`deadlineStatus=expired|closed`. Positions without a stated deadline are excluded from open
results and returned only with `deadlineStatus=unknown` for manual verification. Discovery
re-fetches enabled sources and refreshes `lastVerifiedAt`; it does not assume an unverified
deadline is still open.

`POST /phd/search` discovers only from enabled, configured sources. The bundled `phd_mock`
source is explicitly simulated (fixtures use `example.org`); real discovery requires
`PHD_FEED_URL` or a new adapter. Letters never create applications or submit anything.

### Document-grounded letters and per-target chat

Every letter endpoint reads all three CVs and all three existing cover letters. The server
ranks them against the specific posting (keyword overlap, title relevance, stored match
score), selects one CV and one writing reference, and sends only query-relevant excerpts from
the remaining documents. `cover-letter/options` exposes the ranking, rationale and any
limitations (missing CV text, unreadable letter, empty description) so the UI can show what
was actually used. The chosen pair is stored on the job/position (`letterPreferences`) and can
be overridden per target; each saved letter keeps its selected CV, reference letter document,
model, generated and edited text, version, and a content hash of the posting at generation
time. When the hash no longer matches, the API reports `jobChangedSinceLetter: true`. A user
edit appends the previous text to `revisions`, while `generatedText` retains the original
model/template output; regeneration creates the next numbered version.

Chat sessions live in one `ChatSession` collection keyed by `targetType` plus `job` or
`phdPosition`. A session id from another target is rejected; history, context snapshot and
model are stored with the session. Each request rebuilds grounded context from that target's
description, the candidate documents, the stored match explanation, the current letter and the
last few turns, and instructs the model to separate documented facts, inferences and unknowns
and to treat all document text as untrusted data. Chat is requested as readable prose (the
JSON-only rule applies to structured tasks such as matching and extraction). Detected
instructions inside a posting are ignored; the match evaluator flags them for manual review.
Model/rate-limit/context errors are returned as API errors; the OpenRouter key never leaves
the backend.

## Matches

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/matches` | Paginated matches. Query: `profileKind`, `profileId`, `jobId`, `minScore` |
| GET | `/matches/:id` | One match with populated job/profile |

Matches store both the final score and the deterministic/AI components, mandatory
requirements, evidence, model and prompt version.

## Applications

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/applications/prepare` | Create/reuse a draft. Body: `{ "jobId": "…", "profileId": "…" }` |
| GET | `/applications` | Paginated tracker. Query: `status`, `workflowStatus`, `ageEligibility`, `employer`, `jobTitle`, `languageDecision`, `profileId`, `profileKind`, `from`/`to` (posting-date range) |
| GET | `/applications/queue` | Eligible applications in the human-reviewed apply queue |
| GET | `/applications/:id/eligibility` | Re-check posting age, availability, language, match and duplicates (`?verify=true` re-checks the source) |
| GET | `/applications/:id/assistant` | Form completion summary, unanswered fields, review fields and errors |
| POST | `/applications/:id/assistant/start` | Queue the assistant. Refused unless every eligibility check passes |
| POST | `/applications/:id/assistant/pause\|resume\|stop` | Operator control |
| POST | `/applications/:id/confirm-outcome` | Record what actually happened in the browser |
| GET | `/applications/:id` | Full application with job, profile, match and letter |
| POST | `/applications/:id/approve` | Explicit approval: `{ "confirmed": true, "note": "…" }` |
| POST | `/applications/:id/submit` | Submit only if approval matches the current version |
| POST | `/applications/:id/confirm-manual` | User attests they completed the employer form |
| POST | `/applications/:id/cancel` | Withdraw locally |
| PATCH | `/applications/:id/cover-letter` | Save an edited letter (new version, approval invalidated) |
| POST | `/applications/:id/cover-letter/regenerate` | Regenerate with optional instructions |
| GET | `/applications/:id/cover-letter/versions` | Saved letter versions |
| GET | `/applications/:id/cover-letter/download?format=pdf\|docx` | Download current letter |
| POST | `/applications/:id/questions/answer` | Save one screening answer |
| GET | `/applications/export.csv` | CSV export with the same filters as the list |

### Approval invariant

The server refuses submission unless all of the following hold:

1. `status === "APPROVED"`.
2. `approval.applicationVersion === application.version`.
3. The CV content hash matches the approved hash.
4. The cover letter hash matches the approved hash.
5. Every required screening question is answered.
6. The confirmed-answers hash matches the approval record.
7. No other submitted application exists for the job, or for the same
   employer + normalized title. There is no time window: an application submitted months
   ago still blocks the role, even if the employer reposted it under a new listing.
8. The daily limit has not been reached.
9. The vacancy is still active after a fresh availability check.

Any edit to the letter, answers or document mapping increments the application version
and clears the approval record. Submission additionally requires a fresh eligibility check:
`ageEligibility === "Eligible"`, a verifiable posting date, an active listing, an
English-language decision of `Eligible` and a matching profile. The assistant is refused
otherwise.

### Workflow statuses and duplicate prevention

`workflow.status` tracks the human-in-the-loop queue: `DISCOVERED`, `NEEDS_REVIEW`,
`TOO_RECENT`, `EXPIRED`, `LANGUAGE_REVIEW`, `ELIGIBLE`, `READY_TO_APPLY`,
`ASSISTANT_RUNNING`, `AWAITING_REVIEW`, `NEEDS_INPUT`, `SUBMITTED`, `SUBMISSION_FAILED`,
`SKIPPED`, `APPLIED_MANUALLY`. The companion `status` field remains the local
approval/submission state machine. A form that was filled but not confirmed stays in
`AWAITING_REVIEW`; only an explicit user confirmation or a reliable submission outcome
moves it to `SUBMITTED`.

Before a record is created, or the assistant launched, the API looks for an existing
application by external job id, by normalized canonical URL, and by normalized
company + title (+ location). Duplicate creation is guarded by an atomic unique
`idempotencyKey` index plus a unique `(source, sourceJobId)` index on jobs. Records are
never deleted when a vacancy disappears: an existing record is shown with its status and
must be reviewed explicitly before an unfinished application can be restarted.

### Honest submission outcomes

- `SUBMITTED` with `submission.confirmed: true` requires a positive adapter outcome.
- Fictional `mock` jobs can return a **simulated** confirmation, which is stored with
  `simulated: true` and labelled in the UI.
- All real employers use the `manual` adapter: the API returns
  `NEEDS_MANUAL_ACTION` with the employer URL and instructions. It never claims to have
  submitted anything. You can record your own confirmation afterwards.

## Search runs

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/search-runs` | Paginated discovery history. Optional `kind=jobs\|phd` |
| GET | `/search-runs/:id` | Per-source counts, errors and duration |

## Dashboard

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/dashboard/summary` | Job totals, relevant count, application states, recent runs, AI flag |
