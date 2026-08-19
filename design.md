# Design Notes — Compliance Audit Service

This document explains the major design decisions, tradeoffs, and scalability considerations behind the Compliance Audit Service.

---

## Table of Contents

1. [Assumptions Made](#1-assumptions-made)
2. [Schema and Data Model](#2-schema-and-data-model)
3. [Authentication and Authorization Model](#3-authentication-and-authorization-model)
4. [Concurrency Control](#4-concurrency-control)
5. [File Storage and Access Security](#5-file-storage-and-access-security)
6. [Asynchronous Side Effect Strategy and Failure Handling](#6-asynchronous-side-effect-strategy-and-failure-handling)
7. [Custom Business Rule](#7-custom-business-rule)
8. [Code Quality Practices](#8-code-quality-practices)
9. [Scaling and Observability](#9-scaling-and-observability)
10. [Evolving Spec Mentality](#10-evolving-spec-mentality)
11. [Extensions and Next Steps](#11-extensions-and-next-steps)

---

## 1. Assumptions Made

The problem statement is intentionally underspecified. The following assumptions were made and justify every non-obvious design choice.

| Assumption | Justification |
|---|---|
| **Domain is healthcare compliance** | DNV NIAHO and TJC are the two dominant US hospital accreditation standards. Choosing a real domain made business rules concrete and non-trivial. |
| **One audit per facility per period** | The `auditKey` (e.g. `FAC-001:2026-Q3`) serves as the natural business key. Duplicates are a data integrity error, not a conflict to resolve. |
| **Findings are embedded in the audit document** | Findings have no independent lifecycle outside an audit. Embedding avoids joins and keeps the aggregate consistent. |
| **Metrics are computed on-read, not stored** | Metric formulas are expected to evolve. Recomputing from the source data means no migration when the formula changes. See §10. |
| **HTTPS is enforced at the reverse-proxy layer** | The service itself runs HTTP; a TLS-terminating proxy (nginx, AWS ALB) sits in front. `helmet()` sets `Strict-Transport-Security` so browsers remember to upgrade future connections. |
| **Download tokens are bearer credentials** | A signed token is equivalent to a session cookie for a single resource. 300 s TTL balances usability (time to open the file) against risk (window of misuse). |
| **In-memory store is production-equivalent for tests** | The `InMemoryAuditRepository` implements the same `AuditRepository` interface as the Mongo driver. Tests run against it without a database. |
| **Background jobs are in-process for this scope** | A production system would use a durable queue (SQS, BullMQ with Redis). The in-process queue demonstrates the pattern (retry, backoff, dead-letter) without adding infrastructure. |

---

## 2. Schema and Data Model

### Document structure

The service uses a **document-oriented model** where a `ComplianceAudit` is the aggregate root and contains all child entities embedded.

```
ComplianceAudit
├── id                 UUID (server-generated)
├── auditKey           string  — unique business key (e.g. "FAC-001:2026-Q3")
├── title              string
├── status             enum: draft | in_review | submitted | closed
├── version            integer — monotonic counter for optimistic locking
├── metadata           object
│   ├── facilityName
│   ├── facilityId
│   ├── standard       e.g. "DNV NIAHO", "TJC"
│   ├── surveyorName
│   ├── region
│   └── tags           string[]
├── findings           Finding[]
│   ├── id, code, title, description
│   ├── severity       enum: informational | minor | major | critical
│   ├── status         enum: open | in_remediation | resolved | waived_risk
│   ├── standardClause e.g. "MM.03.01.01"
│   ├── assignedTo, dueDate, riskWeight
│   └── comments       Comment[]
├── attachments        Attachment[]  — references to storage layer
├── changeLog          ChangeLogEntry[]  — append-only mutation history
├── createdBy, createdAt, updatedAt
└── version
```

**Computed fields (never stored):**
```
AuditMetrics
├── totalFindings, findingsBySeverity, findingsByStatus
├── openFindings, overdueFindings
├── riskScore            weighted average, 0–100
├── accreditationReadiness  ready | at_risk | not_ready
├── trend                improving | stable | worsening
└── resolvedRatio        0.0–1.0
```

### Why embed vs. reference?

Findings and comments have no identity outside the audit. Embedding them in the same document ensures that a single read returns the complete aggregate, avoiding the N+1 problem that reference-based schemas introduce. Attachments store **only a reference** (storage key + metadata); the bytes live in the storage layer.

### MongoDB indexes

| Index | Fields | Purpose |
|---|---|---|
| Unique | `auditKey` | Enforce the one-audit-per-key invariant at the database level |
| Background | `status` | Fast filtering when a list endpoint is added |
| Background | `metadata.facilityId` | Fast lookup by facility |

---

## 3. Authentication and Authorization Model

### JWT Bearer (HS256)

Requests authenticate by presenting a JWT in the `Authorization: Bearer <token>` header. The token is verified against `JWT_SECRET`, `JWT_ISSUER`, and `JWT_AUDIENCE` to prevent token-stuffing attacks (a token issued for one service is rejected by another).

### Roles and permissions

| Role | Permissions |
|---|---|
| `user` | `audit:read`, `attachment:download` |
| `admin` | `audit:read`, `audit:create`, `audit:update`, `attachment:upload`, `attachment:download` |

Permissions are declared in a static `ROLE_PERMISSIONS` map (`src/domain/auth.ts`). The `can(user, permission)` helper is used throughout the codebase rather than direct role checks, so adding a third role requires only a single map entry.

### Why not RBAC middleware on the router?

Each route explicitly calls `authorize('permission:name')` middleware. This is intentional: it makes the required permission visible at the route definition, avoids hidden magic, and allows future per-resource ownership checks to be added at the handler level without touching a central policy engine.

### Transport security

The service runs over HTTP but sets `Strict-Transport-Security: max-age=31536000; includeSubDomains` via `helmet()`. The assumption is that a TLS-terminating reverse proxy (nginx, AWS ALB) sits in front. This is the standard production pattern; terminating TLS inside every Node.js process adds complexity with no meaningful security benefit when the proxy is trusted.

---

## 4. Concurrency Control

### Optimistic locking with `version`

Every `ComplianceAudit` document has an integer `version` field (starts at 1, incremented on every write). The PUT endpoint requires the caller to echo the current version in an `If-Match` header.

**Flow:**
1. Client reads audit at `version: 3`.
2. Client sends `PUT` with `If-Match: 3`.
3. Server attempts `findOneAndUpdate({ _id, version: 3 }, { $set: ..., $inc: { version: 1 } })`.
4. If no document matches (another writer already incremented), the server returns `409 VERSION_CONFLICT`.
5. Client re-fetches, merges, and retries.

**Why optimistic locking instead of pessimistic (locks)?**

Compliance audits are written infrequently relative to reads. Pessimistic locks would block concurrent readers for the duration of every write and add distributed-lock complexity (especially across multiple instances). Optimistic locking has zero read overhead and adds a single version field.

**In-memory fallback:** The `InMemoryAuditRepository` emulates the same check with a conditional map update inside a synchronous critical section. Since Node.js is single-threaded, no actual lock is needed — the check is atomic.

---

## 5. File Storage and Access Security

### Abstracted `StorageDriver` interface

```typescript
interface StorageDriver {
  put(key: string, stream: Readable, contentType: string, sizeBytes?: number): Promise<string>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}
```

Two implementations ship:
- **`LocalStorageDriver`** — writes to `./uploads/` using atomic rename (write to `.tmp`, then `mv`); enforces `SAFE_KEY_RE = /^[A-Za-z0-9._-]+$/` to prevent path traversal.
- **`S3StorageDriver`** — uses `@aws-sdk/client-s3`; passes `ContentLength` when known to avoid chunked-transfer overhead; supports `S3_ENDPOINT` for LocalStack / MinIO.

The service selects the driver at boot time based on `STORAGE_DRIVER` env var. Application code never imports a concrete driver directly.

### Upload security controls

| Control | Detail |
|---|---|
| MIME type allowlist | `application/pdf`, `image/png`, `image/jpeg`, `image/webp`, `text/plain`, `text/csv` |
| Size limit | 10 MB (configurable via `MAX_UPLOAD_BYTES`) — enforced by both multer and `attachmentService` |
| Filename sanitisation | Server generates the storage key (`<attachmentId>.<ext>`); client filename is stored as `originalFilename` for display only and never used in file system operations |
| Integrity | SHA-256 checksum computed on upload and stored; can be re-verified on download |
| Path traversal guard | `SAFE_KEY_RE` rejects keys containing `..`, `/`, or non-alphanumeric chars |

### Signed download tokens

Downloading requires a **short-lived signed token** rather than direct URL access. This means:
- Unauthenticated HTTP clients (e.g., a browser tab that has opened a download link) can retrieve the file without holding a JWT.
- The token is scoped to a specific `auditId` + `attachmentId` — it cannot be reused for a different file.
- Token format: `base64url(JSON payload) . HMAC-SHA256(payload)`.
- Verification uses `crypto.timingSafeEqual` with a length check to prevent timing-oracle and padding attacks.
- TTL default: 300 seconds (configurable).

### Malware scanning (production path)

This is not implemented but the integration point is clear: in `attachmentService.storeAttachment()`, after the file is persisted to the quarantine zone, enqueue an async `attachment.scan` job. The job calls a scanning API (ClamAV REST, AWS GuardDuty Malware Protection, or Trend Micro Cloud One). On a clean result, the attachment status transitions from `pending` to `available`. On detection, the file is deleted, the attachment record is flagged `infected`, and an alert is emitted. Download is blocked until status is `available`.

---

## 6. Asynchronous Side Effect Strategy and Failure Handling

### In-process job queue

The `JobQueue` class (`src/jobs/jobQueue.ts`) provides a lightweight, typed, in-process queue. It is designed to mirror the contract of a durable external queue (SQS, BullMQ) so the interface can be swapped with minimal code change.

### `audit.created` job

When `POST /audits` succeeds, the service enqueues an `audit.created` job with the new audit's ID. The job handler:
1. Loads the audit from the repository.
2. Computes metrics (risk score, open criticals).
3. Logs the risk assessment to the structured log.
4. **Auto-escalates** from `draft` → `in_review` if open or in-remediation critical findings exist (see §7).

### Retry and failure handling

```
attempt 1  → immediate
attempt 2  → 1 s delay
attempt 3  → 2 s delay
dead-letter → logged at ERROR level, payload preserved for manual replay
```

Delay formula: `min(2^(attempt-1) * BASE_DELAY_MS, MAX_DELAY_MS)` where `BASE_DELAY_MS = 1000` and `MAX_DELAY_MS = 60000`.

**Compensating marker:** If the job permanently fails, the audit remains in `draft` (no auto-escalation). This is the safe default for a compliance system — a draft audit does not hide critical findings; it merely means the automated pipeline did not run. An operator can reprocess by re-POSTing or triggering a manual review action.

### Production upgrade path

Replace `JobQueue` with:
- **AWS SQS + Lambda** — for serverless deployments
- **BullMQ (Redis)** — for persistent, distributed queues with priority and cron support
- **Temporal** — for long-running, stateful workflows

The `jobQueue.register(type, handler)` interface maps directly to a consumer registration pattern in any of the above.

---

## 7. Custom Business Rule

### Critical Finding Auto-Escalation

**Rule:** An audit that is created or transitions to `draft` status and contains one or more findings with `severity = critical` and `status ∈ {open, in_remediation}` must be automatically escalated to `in_review` by the background job within seconds.

**Rationale:** Healthcare accreditation bodies expect critical deficiencies to enter the review pipeline immediately. A `draft` audit is typically not visible to auditors or compliance officers; `in_review` is the first status that surfaces to those stakeholders. Requiring a human to manually promote a draft audit containing critical findings creates a regulatory window where the deficiency is known but not actioned.

**Impact on validation:** The rule is enforced post-create as a side effect, not as a pre-condition. This means the POST endpoint does not need to know the rule; the job handler owns it. This separation ensures the rule can be changed or replaced without touching the API layer.

**Impact on API behaviour:** The response to `POST /audits` will show `status: "draft"`. A client polling `GET /audits/:id` will see `status: "in_review"` once the background job completes (typically < 500 ms). This is intentional eventual consistency — the create operation is synchronous and fast; the side effect is asynchronous and observable.

**Impact on data modelling:** The `AuditStatus` enum includes `in_review`. The `ALLOWED_TRANSITIONS` map in `auditService` explicitly permits `draft → in_review` from both human (PUT) and system (job) actors.

### Accreditation Readiness Metric (secondary rule)

The `accreditationReadiness` field is derived from the risk score and open critical findings:

| Condition | Label |
|---|---|
| Any open critical finding | `not_ready` |
| Risk score < 30 and no open criticals | `ready` |
| Otherwise | `at_risk` |

Risk score is a weighted average of open finding `riskWeight` values, normalised to 0–100. Each finding's `riskWeight` (0–100) represents its estimated contribution to accreditation failure.

---

## 8. Code Quality Practices

### TypeScript strict mode

`tsconfig.json` enables `strict: true`, which activates `strictNullChecks`, `noImplicitAny`, `strictFunctionTypes`, and related checks. The only exception is `ignoreDeprecations: "6.0"` to suppress a TypeScript 5.x noise warning about `moduleResolution: "node"` that does not affect correctness.

### Runtime validation with Zod

All external inputs — request bodies, query parameters, environment variables — are parsed through Zod schemas before reaching business logic. `z.strict()` is applied to update schemas to reject unknown fields (a defence-in-depth measure against mass-assignment injection).

`boundedString(max)` is a shared helper that trims whitespace and enforces a maximum length, preventing both injection-via-length and storing untrimmed data.

### Linting

ESLint is configured with the TypeScript plugin. Rules include:
- `@typescript-eslint/no-explicit-any` — warn
- `@typescript-eslint/no-unused-vars` — error (underscore prefix allowed for intentional non-use)
- `no-console` — error (all output goes through pino)

### Testing philosophy

Tests are arranged in two suites:
- **Unit** (`tests/unit/`) — pure function tests with no I/O: metrics computation and download token lifecycle (issue, verify, expiry, tampering).
- **Integration** (`tests/integration/`) — full HTTP lifecycle via Supertest against the real Express app and in-memory repository. Tests cover auth enforcement, business invariants, optimistic concurrency, file upload, and download token flow.

No mocking of internal modules — tests exercise real implementations. The in-memory repository makes this fast (no network) and deterministic.

### Separation of concerns

```
routes/       ← HTTP parsing, status codes, headers
services/     ← business logic, orchestration
repositories/ ← persistence contract + implementations
storage/      ← file storage contract + implementations
jobs/         ← async side effects
domain/       ← types, enums, auth model (no dependencies)
middleware/   ← cross-cutting: auth, validation, error handling, logging
schemas/      ← Zod schemas shared by routes and services
utils/        ← clock, logger, error classes
```

Each layer depends only on layers below it. Routes never import repositories directly; services never import route-level types.

### Commit hygiene

Commits follow conventional commit format (`feat:`, `fix:`, `refactor:`, `test:`, `chore:`). Each commit represents a single logical change that compiles and passes tests.

---

## 9. Scaling and Observability

### Horizontal scaling

The application is stateless:
- No in-process session state — every request is authenticated independently via JWT.
- No in-process shared state between requests (job queue is per-instance, acceptable for async side effects that are idempotent).
- Persistence lives in MongoDB (shared across instances).
- File bytes live in S3 (shared across instances).

Running multiple instances behind a load balancer requires no sticky sessions.

### Data access

- MongoDB unique index on `auditKey` enforces the business key invariant atomically even under concurrent POST requests.
- `findOneAndUpdate` with version filter implements the optimistic lock in a single round-trip.
- Indexes on `status` and `facilityId` support future list/filter endpoints without schema changes.

### Observability

**Structured logging (pino):**
- Every log line is a JSON object with `level`, `time`, `requestId`, and context fields.
- `requestId` is either taken from the incoming `X-Request-Id` header or generated as a UUID and echoed back in the response header. This means a distributed tracing system (Datadog APM, AWS X-Ray, Jaeger) can correlate logs across services using the same `X-Request-Id`.
- Child loggers (`logger.child({ requestId, auditId })`) add fields automatically without repeating them at every call site.

**Error schema:**
Every error response has the shape:
```json
{
  "error": {
    "code": "MACHINE_READABLE_CODE",
    "message": "Human-readable description",
    "requestId": "uuid",
    "details": [{ "field": "...", "message": "..." }]
  }
}
```
Clients can pattern-match on `code` without parsing `message` text.

**Health endpoint:**
`GET /health` returns `200 { status: "ok", uptime: <seconds> }`. Used by load balancers and container orchestrators for liveness probes.

---

## 10. Evolving Spec Mentality

The design anticipates change in the following ways:

| Change | Effort |
|---|---|
| **New computed metric** | Add a field to `AuditMetrics` in `types.ts` and implement it in `metricsService.ts`. Zero changes to routes, schemas, or persistence. |
| **New `?include=` sub-field** | Add the field name to `INCLUDABLE_FIELDS` in `audit.schemas.ts` and one branch in `formatService.buildFullResponse()`. |
| **New output shape** | Add a new `view` param value and a new builder function in `formatService.ts`. Existing shapes are unaffected. |
| **New storage backend** | Implement the three-method `StorageDriver` interface and add a case to the driver factory in `src/index.ts`. |
| **New background job** | Call `jobQueue.register('type', handler)` at startup. |
| **New role or permission** | Add the role to `Role` enum and populate `ROLE_PERMISSIONS` map. |
| **New finding field** | Add to `Finding` in `types.ts`, add to Zod schema, and add a MongoDB migration script (additive, backward-compatible). |
| **Schema migration** | MongoDB's flexible schema means new optional fields require no migration. Required new fields need a one-time migration script; the repository layer isolates this. |

Metrics are intentionally not stored so that formula changes do not require backfilling existing documents — a key design decision for long-lived compliance records that must not be retroactively altered.

---

## 11. Extensions and Next Steps

| Item | Notes |
|---|---|
| **Durable job queue** | Replace `JobQueue` with BullMQ (Redis) or SQS for persistence across restarts |
| **Malware scanning** | See §5 — integration point is ready; add `attachment.scan` job type |
| **Rate limiting** | Add `express-rate-limit` per-IP and per-user to prevent credential stuffing on `/auth/login` |
| **Refresh tokens** | Issue short-lived access tokens (5 min) and longer-lived refresh tokens; rotate on use |
| **Audit list endpoint** | `GET /audits?status=&facilityId=&page=&size=` — repository interface has a `findAll(filter)` stub ready |
| **Webhook notifications** | Fire `audit.status_changed` events to registered endpoints on status transitions |
| **OpenAPI spec** | Generate from Zod schemas using `zod-openapi`; serve via Swagger UI at `/api/v1/docs` |
| **Metrics endpoint** | Expose Prometheus metrics (request count, latency histogram, job queue depth) at `/metrics` |
| **Multi-tenancy** | Add `organisationId` to the JWT and all repository queries for namespace isolation |
| **Read replicas** | Route `findById` / `findAll` to MongoDB secondaries; writes to primary only |
