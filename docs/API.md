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
  "search": { "minRelevanceScore": 80, "maxJobsPerRun": 40 },
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
| GET | `/jobs` | Paginated list. Query: `q`, `status`, `source`, `profileKind`, `minScore`, `page`, `limit` |
| GET | `/jobs/:id` | Job + all profile matches |
| POST | `/jobs/:id/match` | Hybrid evaluation. Body: `{ "profileKinds": ["full_stack"] }` |
| POST | `/jobs/:id/verify` | Best-effort availability check with evidence |

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
| GET | `/applications` | Paginated tracker. Query: `status`, `employer`, `profileId`, `profileKind` |
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
   employer + normalized title.
8. The daily limit has not been reached.
9. The vacancy is still active after a fresh availability check.

Any edit to the letter, answers or document mapping increments the application version
and clears the approval record.

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
| GET | `/search-runs` | Paginated discovery history |
| GET | `/search-runs/:id` | Per-source counts, errors and duration |

## Dashboard

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/dashboard/summary` | Job totals, relevant count, application states, recent runs, AI flag |
