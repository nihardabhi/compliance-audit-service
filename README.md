# Compliance Audit Service

A production-quality REST API for managing healthcare compliance audits. Built with **Node.js + TypeScript**, supporting MongoDB persistence, S3 file storage, JWT authentication, async background jobs, and structured observability.

---

## Table of Contents

- [Tech Stack & Justification](#tech-stack--justification)
- [Prerequisites](#prerequisites)
- [Setup & Run](#setup--run)
  - [Local Development](#local-development)
  - [Docker](#docker)
- [Environment Variables](#environment-variables)
- [Authentication](#authentication)
- [API Reference](#api-reference)
  - [POST /api/v1/auth/login](#post-apiv1authlogin)
  - [POST /api/v1/audits](#post-apiv1audits)
  - [GET /api/v1/audits/:id](#get-apiv1auditsid)
  - [PUT /api/v1/audits/:id](#put-apiv1auditsid)
  - [POST /api/v1/audits/:id/attachment](#post-apiv1auditsidattachment)
  - [GET /api/v1/audits/:id/attachment/:attachmentId/token](#get-apiv1auditsidattachmentattachmentidtoken)
  - [GET /api/v1/audits/:id/attachment/:attachmentId (download)](#get-apiv1auditsidattachmentattachmentid-download)
  - [GET /health](#get-health)
- [Custom Business Rule](#custom-business-rule)
- [Running Tests](#running-tests)

---

## Tech Stack & Justification

| Layer | Choice | Reason |
|---|---|---|
| Runtime | Node.js 20 + TypeScript 5 | Requirement; strong ecosystem for I/O-heavy services |
| Framework | Express 5 | Mature, minimal, familiar to most reviewers; v5 adds native async error propagation |
| Validation | Zod v4 | Single source of truth for runtime validation **and** TypeScript types; `z.strict()` blocks unknown fields |
| Auth | jsonwebtoken (HS256) | Simple, auditable, no external auth server needed for this scope |
| Persistence | MongoDB (native driver) | Document-oriented model maps directly to the nested-document schema; no ORM overhead |
| File storage | Local disk / AWS S3 (pluggable) | `StorageDriver` interface makes swapping trivial; local disk sufficient for dev/test |
| Logging | pino | Fastest structured JSON logger in the Node ecosystem; `child()` binds requestId per request |
| Testing | Vitest + Supertest | Fast, ESM-compatible; Supertest exercises the full HTTP stack |
| Containerisation | Docker + docker-compose | Reproducible environment; mongo:7 service included |

---

## Prerequisites

- Node.js ≥ 20
- npm ≥ 9
- Docker + Docker Compose (optional, for containerised run)
- MongoDB 7 (optional — service falls back to in-memory store if `MONGODB_URI` is not set)

---

## Setup & Run

### Local Development

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — at minimum set JWT_SECRET and DOWNLOAD_TOKEN_SECRET

# 3. Start the server (ts-node-dev watch mode)
npm run dev
# → listening on http://localhost:4000
```

### Docker

```bash
# Build and start API + MongoDB
docker-compose up --build

# API available at http://localhost:3000
# MongoDB available at mongodb://localhost:27017
```

To stop:
```bash
docker-compose down
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | no | `3000` | HTTP port |
| `NODE_ENV` | no | `development` | `development` \| `test` \| `production` |
| `JWT_SECRET` | **yes** | — | HS256 signing secret (min 16 chars) |
| `JWT_ISSUER` | no | `compliance-audit-service` | JWT `iss` claim |
| `JWT_AUDIENCE` | no | `medlaunch-clients` | JWT `aud` claim |
| `JWT_EXPIRES_IN` | no | `3600` | Token TTL in seconds |
| `DOWNLOAD_TOKEN_SECRET` | **yes** | — | HMAC secret for download tokens (min 16 chars) |
| `DOWNLOAD_TOKEN_TTL_SECONDS` | no | `300` | Download token expiry in seconds |
| `STORAGE_DRIVER` | no | `local` | `local` \| `s3` |
| `STORAGE_LOCAL_DIR` | no | `./uploads` | Local upload directory |
| `MAX_UPLOAD_BYTES` | no | `10485760` | Max file size (bytes) |
| `S3_BUCKET` | if `STORAGE_DRIVER=s3` | — | S3 bucket name |
| `S3_REGION` | no | `us-east-1` | AWS region |
| `S3_ENDPOINT` | no | — | Custom endpoint (LocalStack / MinIO) |
| `MONGODB_URI` | no | — | MongoDB connection string; omit to use in-memory store |
| `MONGODB_DB` | no | `compliance-audit` | MongoDB database name |
| `LOG_LEVEL` | no | `info` | `fatal`\|`error`\|`warn`\|`info`\|`debug`\|`trace` |
| `CORS_ORIGIN` | no | `*` | CORS allowed origin |

---

## Authentication

The service uses **JWT Bearer tokens** (HS256). Obtain a token via the login endpoint, then pass it as `Authorization: Bearer <token>` on every subsequent request.

### Test credentials

| Username | Password | Role | Permissions |
|---|---|---|---|
| `admin` | `admin123` | admin | read, create, update audits; upload & download attachments |
| `user` | `user123` | user | read audits; download attachments |

> **Note:** These credentials are hardcoded for demo purposes. In production replace with a proper identity provider.

---

## API Reference

All endpoints are prefixed with `/api/v1`. Replace `http://localhost:4000` with your host.

---

### POST /api/v1/auth/login

Obtain a JWT.

```bash
curl -s -X POST http://localhost:4000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}' | jq .
```

**Response 200**
```json
{
  "token": "eyJhbGci...",
  "expiresIn": 3600,
  "user": { "sub": "admin", "name": "Admin User", "roles": ["admin"] }
}
```

---

### POST /api/v1/audits

Create a new compliance audit. Requires `admin` role. Returns `201 Created` with a `Location` header. Triggers an async background job (risk assessment + auto-escalation).

```bash
TOKEN="<admin-jwt>"

curl -s -X POST http://localhost:4000/api/v1/audits \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "auditKey": "FAC-001:2026-Q3",
    "title": "Q3 DNV Compliance Audit — Facility 001",
    "metadata": {
      "facilityName": "Sunrise Medical Center",
      "facilityId": "FAC-001",
      "standard": "DNV NIAHO",
      "surveyorName": "Jane Smith",
      "region": "Northeast",
      "tags": ["q3", "annual"]
    },
    "findings": [
      {
        "code": "F-001",
        "title": "Missing fire-door inspection log",
        "description": "No log found for the past 12 months.",
        "severity": "critical",
        "status": "open",
        "standardClause": "MM.03.01.01",
        "assignedTo": "facilities-team",
        "dueDate": "2026-09-30",
        "riskWeight": 85
      }
    ]
  }' | jq .
```

**Response 201**
```json
{
  "id": "01926ab3-...",
  "auditKey": "FAC-001:2026-Q3",
  "title": "Q3 DNV Compliance Audit — Facility 001",
  "status": "draft",
  "version": 1,
  ...
}
```

**Business invariant:** `auditKey` must be globally unique. Duplicate keys return `409 CONFLICT`.

---

### GET /api/v1/audits/:id

Retrieve a single audit. Requires `user` or `admin` role.

**Query parameters**

| Parameter | Description | Example |
|---|---|---|
| `view` | `full` (default) or `summary` (flat compact shape) | `?view=summary` |
| `include` | Comma-separated list of sub-fields to embed | `?include=findings,metrics,attachments,comments,changeLog` |
| `page` | Page number for findings (default `1`) | `?page=2` |
| `size` | Page size for findings (default `20`, max `100`) | `?size=10` |
| `severity` | Filter findings by severity | `?severity=critical` |
| `findingStatus` | Filter findings by status | `?findingStatus=open` |
| `sort` | Sort findings | `?sort=severity:desc` or `dueDate:asc` or `createdAt:desc` |

```bash
# Full hierarchical view with findings, metrics, and change log
curl -s "http://localhost:4000/api/v1/audits/<id>?include=findings,metrics,changeLog&severity=critical&sort=dueDate:asc" \
  -H "Authorization: Bearer $TOKEN" | jq .

# Compact summary view (flat scalars only)
curl -s "http://localhost:4000/api/v1/audits/<id>?view=summary" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

**Response 200 — full view (excerpt)**
```json
{
  "id": "01926ab3-...",
  "auditKey": "FAC-001:2026-Q3",
  "title": "Q3 DNV Compliance Audit — Facility 001",
  "status": "in_review",
  "version": 2,
  "metrics": {
    "totalFindings": 1,
    "riskScore": 85,
    "accreditationReadiness": "not_ready",
    "trend": "stable",
    "openFindings": 1,
    "overdueFindings": 0,
    "resolvedRatio": 0
  },
  "findings": {
    "items": [ { "code": "F-001", ... } ],
    "pagination": { "page": 1, "size": 20, "total": 1, "totalPages": 1 }
  },
  "changeLog": []
}
```

---

### PUT /api/v1/audits/:id

Update an audit (full or partial). Requires `admin` role.

**Optimistic concurrency:** Pass the current `version` in the `If-Match` header. Mismatched version returns `409 VERSION_CONFLICT`.

```bash
# Partial update — change status and add a finding
curl -s -X PUT http://localhost:4000/api/v1/audits/<id> \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "If-Match: 1" \
  -d '{
    "status": "submitted",
    "findings": [
      {
        "code": "F-001",
        "title": "Missing fire-door inspection log",
        "description": "No log found for the past 12 months.",
        "severity": "critical",
        "status": "in_remediation",
        "standardClause": "MM.03.01.01",
        "assignedTo": "facilities-team",
        "dueDate": "2026-09-30",
        "riskWeight": 85
      }
    ]
  }' | jq .
```

**Business invariants enforced:**
- Closed audits cannot be edited (`423 AUDIT_CLOSED`)
- Invalid status transitions are rejected (`422 INVALID_STATUS_TRANSITION`)
- Every PUT appends a `changeLog` entry with who changed what and when

---

### POST /api/v1/audits/:id/attachment

Upload a file tied to an audit. Requires `admin` role. Multipart form upload.

**Restrictions:** max 10 MB; allowed types: `application/pdf`, `image/png`, `image/jpeg`, `image/webp`, `text/plain`, `text/csv`.

```bash
curl -s -X POST http://localhost:4000/api/v1/audits/<id>/attachment \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/path/to/report.pdf" | jq .
```

**Response 201**
```json
{
  "id": "att_01926b...",
  "filename": "att_01926b....pdf",
  "originalFilename": "report.pdf",
  "contentType": "application/pdf",
  "sizeBytes": 204800,
  "checksumSha256": "a3f9...",
  "uploadedAt": "2026-08-19T12:00:00.000Z"
}
```

---

### GET /api/v1/audits/:id/attachment/:attachmentId/token

Issue a short-lived signed download token. Requires `user` or `admin` role.

```bash
curl -s "http://localhost:4000/api/v1/audits/<id>/attachment/<attachmentId>/token" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

**Response 200**
```json
{
  "downloadToken": "eyJ...abc123",
  "tokenExpiresInSeconds": 300,
  "downloadUrl": "/api/v1/audits/<id>/attachment/<attachmentId>?token=eyJ...abc123"
}
```

---

### GET /api/v1/audits/:id/attachment/:attachmentId (download)

Redeem a signed download token. **No JWT required** — the signed token is the credential.

```bash
# Use the downloadUrl from the token endpoint
curl -s "http://localhost:4000/api/v1/audits/<id>/attachment/<attachmentId>?token=<signed-token>" \
  -o downloaded-report.pdf
```

Token properties: HMAC-SHA256 signed, scoped to a specific `auditId` + `attachmentId`, expires after 300 seconds (configurable), verified with `crypto.timingSafeEqual`.

---

### GET /health

Liveness probe. Returns `200 OK` with `{ "status": "ok", "uptime": <seconds> }`. No authentication required.

```bash
curl http://localhost:4000/health
```

---

## Custom Business Rule

### Critical Finding Escalation

**Rule:** When a new audit is created with one or more open or in-remediation **critical** findings, the system automatically escalates the audit from `draft` → `in_review` within seconds via a background job.

**Rationale:** In healthcare compliance (DNV NIAHO, TJC), critical findings represent immediate patient-safety risk. Leaving them in `draft` — where they are not yet visible to review-team dashboards — creates a regulatory blind spot. The auto-escalation ensures critical deficiencies surface immediately to the review pipeline without requiring a separate human action.

**Impact:**
- **Validation:** No additional validation needed; escalation is a post-create side effect, not a pre-condition.
- **API behaviour:** The POST response returns `status: "draft"`. A subsequent GET may return `status: "in_review"` once the background job completes (eventual consistency, typically < 1 second).
- **Data modelling:** The `status` field supports the `in_review` state; no schema change required. The `changeLog` field records the escalation as a system-authored entry.
- **Job failure handling:** If the job fails it is retried with exponential backoff (1 s → 2 s → 4 s → 60 s cap). After 3 attempts it is dead-lettered and logged at `error` level for manual intervention.

**Accreditation Readiness metric** (secondary rule): derived from the risk score and open criticals:
- `not_ready` — any open critical finding exists
- `ready` — risk score < 30 and no open criticals
- `at_risk` — otherwise

---

## Running Tests

```bash
# Run all tests (unit + integration)
npm test

# Watch mode
npm run test:watch
```

19 tests covering: metrics computation, download token issue/verify/expiry/tampering, and full HTTP lifecycle for all four endpoints.
