# Technical Architecture — Release 1 — v0.1 (draft)

Companion to `PRD.md`, `FUNCTIONAL_SCOPE.md`, `CARD_SPEC.md`, `SECURITY_ARCHITECTURE.md`. Schema: `../db/schema.prisma` (validated with Prisma 6).
Design goals: zero running cost now, production-shaped later, security-first, swappable providers, tenant-ready.

## 1. Style
Modular monolith plus a separate worker process. One backend codebase with strict module boundaries (can be split later); no microservices in Release 1.

```
 Browser (Next.js)  ──HTTPS──►  API (NestJS)  ──►  PostgreSQL
                                   │  ▲                 ▲
                                   │  └── job queue ────┤ (pg-boss, in Postgres)
                                   ▼                    │
                             Object storage         Worker (Node)
                             (private)              ├─ PDF/image prep (poppler)
                                                    ├─ Local OCR (Tesseract mar+hin+eng)
                                                    ├─ Extractor adapters (Gemini/Vertex, optional)
                                                    └─ Card renderer (Chromium → PNG/PDF)
 Phone scan ──► /verify/<token> (Next.js, public, rate-limited) ──► API
```

## 2. Repository layout (monorepo, pnpm workspaces)
```
apps/web        Next.js (App Router, TS) – staff UI + public verify page
apps/api        NestJS – REST, auth, RBAC, business logic
apps/worker     Node worker – processing + card rendering jobs
packages/shared Zod schemas, DTO types, i18n catalogs, field catalogue, validators
packages/extract Extractor interface + adapters + template definitions
packages/card   Card HTML/CSS templates, QR, render helpers
db/             Prisma schema + migrations + seed
docs/           planning docs
infra/          docker-compose (postgres, minio optional), Dockerfiles
```
Shared validation (Zod) is used by web (forms), api (DTOs) and worker (post-processing) so rules cannot drift.

## 3. Technology choices
| Concern | Choice | Why / zero-cost note |
|---|---|---|
| Web | Next.js + TypeScript, Tailwind, next-intl (mr/hi/en) | Server-side rendering for public verify page |
| API | NestJS (guards, interceptors, DTO validation) | Reusable auth/permission guards |
| DB | PostgreSQL 16 + Prisma | Local Docker now; free-tier managed DB later |
| Queue | **pg-boss** (Postgres-backed) | No Redis needed at launch; retries, delays, idempotency keys; swap to BullMQ/Redis if volume demands |
| Storage | `StorageService` interface: local filesystem driver (dev), S3-compatible driver (MinIO/R2/S3) | Keys are random; access only via API-issued short-lived signed URLs |
| PDF → images | poppler `pdftoppm` (or extract embedded image when page is a single raster, as in the sample form) | Runs in worker with timeout + memory cap |
| OCR | Tesseract 5 with `mar`, `hin`, `eng` traineddata; OpenCV-style preprocessing (deskew, threshold) via `sharp`/`jimp`-level ops or a small Python sidecar if needed | Free, local; real data never leaves host |
| Optional AI extraction | Gemini / Vertex adapters behind same interface | Only for synthetic/approved data per provider policy |
| Card render | HTML/CSS template → headless Chromium (Playwright) → PNG and PDF | Correct Devanagari shaping; one render path for all formats |
| QR | `qrcode` (SVG for print, PNG for screen) | |
| Auth | Server-managed sessions in Postgres, opaque cookie, Argon2id (`argon2`), TOTP MFA (`otplib`) | No JWT in localStorage |
| Crypto | AES-256-GCM envelope encryption helper; HMAC-SHA-256 blind indexes; keys from env now → KMS later | See §7 |
| Logging | pino, structured, redaction list; correlation ID per request | No PII in logs |
| Testing | Vitest/Jest unit, Supertest API, Playwright e2e, dedicated security suite, OCR benchmark harness | |
| CI | GitHub Actions: lint, typecheck, tests, `npm audit`, gitleaks, container scan | Free for public/private small use |

## 4. Module map (API)
| Module | Responsibility | Key collaborators |
|---|---|---|
| `auth` | login, sessions, MFA, reset, lockout | users, audit |
| `access` | RBAC permission guard, record-level policy (`can(user, action, resource)`) | all |
| `users` | user admin | access |
| `documents` | upload, validation, quarantine, signed URLs, dedupe, retention | storage, queue |
| `processing` (worker) | render, classify, extract, normalize, validate | extract pkg |
| `review` | extracted fields, revisions, mismatch flags | farmers |
| `farmers` | profile, identity/contact/address, linked IDs, search | crypto |
| `land` | parcels, cultivation rights | farmers |
| `trust` | state machine L0–L4, four-eyes rule | audit |
| `cards` | issue/version/revoke, render jobs, downloads | card pkg, storage |
| `verify` | public token lookup, rate limiting, minimal projection | cards |
| `audit` | append-only events, query for Auditor | — |
| `settings` | org settings, retention policies | — |
| `health` | liveness/readiness | — |

Rule: controllers never implement authorization themselves; they declare `@RequirePermission('document:upload')` and a resource loader; the guard enforces it.

## 5. Data model summary (see `schema.prisma`)
- **Tenancy:** `Organization`; `orgId` on all business tables.
- **Farmer core (split):** `Farmer` (platformId, trustLevel, status) → `FarmerIdentity`, `FarmerContact`, `FarmerAddress[]`, `LinkedExternalId[]`.
- **Land (independent):** `LandParcel` ⟷ `CultivationRight` ⟷ `Farmer`. Ownership and cultivation are separate; one parcel may relate to many farmers; areas stored by type.
- **Documents:** `SourceDocument` → `DocumentPage[]` → `ExtractionJob[]` → `ExtractedField[]` → `FieldRevision[]`. Each field keeps raw, normalized, final value, confidence, source page/region, review state.
- **Trust:** `ApprovalEvent` records every level transition with actor and checklist.
- **Cards:** `Card` (versioned, status) → `VerificationToken` (hash only) → `VerificationEvent`.
- **Cross-cutting:** `AuditEvent`, `OrgSetting`, `RetentionPolicy`, `Session`, `PasswordResetToken`.
- **Intentionally absent:** Aadhaar, bank, PAN, caste certificate, KCC columns.

### Platform ID
`FRM-` + 8 chars Crockford base32 from CSPRNG (≈40 bits) with uniqueness retry; includes check character. Non-sequential, safe in public URLs and on the card. Distinct from source Farmer ID (stored in `LinkedExternalId`, `verified=false`).

## 6. Key flows

### 6.1 Upload → review-ready
1. `POST /documents` (multipart, session + `document:upload`). Stream to quarantine key; enforce size cap while streaming.
2. Validate extension, MIME, `%PDF-` magic, page count (via `pdfinfo` in worker, not API process). Compute SHA-256; dedupe check within org.
3. Row `SourceDocument(status=QUARANTINED)`; enqueue `document.process` (idempotency key = documentId).
4. Worker: scan hook → render/extract pages to `DocumentPage` images → classify (title text via OCR: "Farmer Registration Form" + layout fingerprint) → pick template → skip consent pages → region OCR → post-process → validate → write `ExtractedField`s → `status=READY_FOR_REVIEW`.
5. Failures: bounded retries with backoff; terminal `FAILED` with safe reason; no partial farmer record.

### 6.2 Review → approval
Review UI loads page images (signed URLs) + fields. Edits create `FieldRevision`. Submit (L1) requires: all required fields confirmed, mismatch flags resolved, checkbox attestation. A different user with `VERIFIER` role moves L1→L2. Farmer + related rows are created/updated in one transaction on submit; platform ID assigned at first submit.

### 6.3 Card issue
On L2: `cards.issue` → new `Card(version n+1)`; previous ACTIVE card → SUPERSEDED and its tokens → SUPERSEDED; generate 32-byte token (CSPRNG), store SHA-256, build URL; enqueue `card.render` (Chromium; template snapshot saved in `snapshotJson`); outputs stored under random keys; status ACTIVE after render success.

### 6.4 Public verification
`GET /verify/:token` (Next.js server component → API `GET /public/verify/:token`): constant-time hash lookup; response is a fixed minimal projection (status, platformId, trustLevel, issueDate, issuer, reference, optional name per setting). Unknown/invalid tokens return the same generic not-found shape and timing class. Rate limit per IP/token via in-memory/Redis-less limiter (Postgres or in-process token bucket at first). Event row written with outcome only.

## 7. Cryptography and secrets
- **Field encryption:** AES-256-GCM with per-record random IV; data key wrapped by a master key (env `APP_MASTER_KEY` in dev; KMS-managed later). Fields: dob, mobile, email, address text, linked IDs, extracted values, MFA secret. Ciphertext format: `v1:<keyId>:<iv>:<tag>:<ct>` to allow key rotation.
- **Blind indexes:** HMAC-SHA-256 with a separate key for exact-match lookup (mobile, linked IDs). No wildcard search on encrypted fields; name search uses normalized non-encrypted name columns (accepted trade-off: names are Confidential, protected by access control and DB encryption at rest).
- **Passwords:** Argon2id. **Session cookies:** random 256-bit, only SHA-256 stored.
- **Secrets:** env vars from `.env` (git-ignored) in dev; secrets manager in prod; startup fails if required secrets missing or default.

## 8. Extraction subsystem design
```ts
interface DocumentExtractor {
  id: string; version: string;
  supports(doc: DocumentInfo): boolean;
  extract(input: { pages: PageImage[]; template?: TemplateDef; policy: ProviderPolicy }): Promise<ExtractionResult>;
}
type ExtractionResult = { fields: Array<{ key: string; raw: string; confidence?: number; page: number; box?: Box }>; warnings: string[] };
```
- **Template definition** (JSON, versioned): page roles, label anchors, field regions (relative coordinates), field type, language, validators. First template: `agristack-farmer-reg-form@1` built from the supplied sample (p1 fields, p2 land table with row detection, skip p3–p4).
- **Pipeline order:** preprocess → anchor-match labels (to tolerate small shifts) → crop field regions → OCR with language per field (Devanagari fields `mar+hin`, numeric fields `eng` with digit whitelist) → normalize → validate → cross-check.
- **Normalizers:** rejoin wrapped words using dictionary (state/district lists), strip trailing punctuation, `*`→null, dates, phones, decimal areas.
- **Cross-checks:** age vs DOB; name_en vs transliteration of name_local (soft warning only); header name vs land owner name (mismatch flag).
- **Provider policy gate:** `ProviderPolicy` decides which adapters may see a document (`real_data` flag, org setting, redaction applied). The worker refuses to call an external adapter if policy forbids.
- **Prompt-injection safety (AI adapters):** system prompt fixed; document content only as data; output validated against Zod schema; unknown keys dropped; no tools/functions exposed.
- **Benchmark harness:** `pnpm bench:extract` runs the pipeline over a folder of synthetic/redacted samples with ground-truth JSON and reports per-field exact-match and character error rate. Required before a template is declared "known".

## 9. Card rendering subsystem
- Template = HTML/CSS using CSS variables for sizes; inputs from `snapshotJson`; fonts embedded (Noto Sans Devanagari/Latin).
- Playwright Chromium in the worker (or a separate render container): `page.setContent` → screenshot PNG (300 dpi device scale) and `page.pdf` with exact mm sizes. A4 sheet = composite page with N copies + cut marks.
- Chromium is launched with sandbox flags, no network, only local fonts and in-memory content (prevents SSRF via template data); all data HTML-escaped.
- Deterministic output tested by visual regression (pixel-diff threshold) on synthetic samples.

## 10. Security architecture mapping
| Requirement (Security doc) | Where implemented |
|---|---|
| RBAC + record-level authz | `access` module guard + `can()` policies; Postgres row filters by `orgId` |
| Upload hardening | `documents` module + worker limits (timeouts, cgroup/ulimit, `pdfinfo` page cap) |
| Private storage | `StorageService` (no public bucket); signed URL TTL ≤ 5 min; access audited |
| Encryption | §7 |
| AI safety | §8 provider policy gate |
| QR token safety | hashed tokens, generic errors, rate limiting, revocation |
| Audit | `audit` interceptor on all mutating and sensitive read endpoints |
| API protection | helmet headers + CSP, CORS allowlist, CSRF token for cookie-auth mutations, request size limits, throttler |
| Secrets | env/secret manager, gitleaks in CI |
| Logs | pino redaction (`*.password`, `*.token`, `*Enc`, `authorization`, `cookie`), no bodies logged |

## 11. API surface (R1, REST/JSON, `/api/v1`)
```
POST   /auth/login | /auth/logout | /auth/mfa/verify | /auth/password/reset-request | /auth/password/reset
GET    /me
GET/POST/PATCH /users            (ADMIN)
POST   /documents                (OPERATOR+)        multipart
GET    /documents/:id            GET /documents/:id/pages/:n   (signed URL)
GET    /documents/:id/extraction (fields, flags)
PATCH  /extraction/fields/:id    (edit/confirm)
POST   /farmers                  (from approved extraction or manual)
GET    /farmers?query=...        GET /farmers/:id   PATCH /farmers/:id
POST   /farmers/:id/submit       (→L1)
POST   /farmers/:id/approve      (VERIFIER, ≠ submitter → L2)
POST   /farmers/:id/reverify     (→L4)
POST   /farmers/:id/parcels      PATCH/DELETE /farmers/:id/parcels/:rid
POST   /farmers/:id/cards        (issue)  GET /cards/:id/download?format=png|pvc|a4
POST   /cards/:id/revoke         (ADMIN)
GET    /public/verify/:token     (no auth, rate-limited)
GET    /audit                    (AUDITOR/ADMIN)
GET/PUT /settings                (ADMIN)
GET    /health/live | /health/ready
```
Conventions: DTO allowlists (no mass assignment), pagination caps, idempotency keys on POST that enqueue work, uniform error shape with correlation ID.

## 12. Environments and deployment
| Env | Setup |
|---|---|
| Dev | `docker compose up` (Postgres, optional MinIO); web/api/worker via pnpm; synthetic data only |
| Staging | Same images, synthetic data, seeded users |
| Prod | Private network for DB and workers; TLS termination; secrets manager; encrypted backups; daily restore test (later) |
Zero-cost path: local/dev now; when a demo is needed, host with free tiers using **synthetic data only**. Real farmer data requires a proper host (India region), legal review and backups first.

## 13. Non-functional targets
- Extraction: ≤ 30 s per 4-page form on a 4-core laptop; throughput 50–500 docs/day with 1–2 workers.
- API p95 < 300 ms (non-processing endpoints); verify page TTFB < 500 ms.
- Availability goal after launch: 99.5%. RPO ≤ 24 h, RTO ≤ 4 h initially.
- Accessibility: WCAG 2.1 AA for staff UI; large touch targets for field use.

## 14. Risks and open technical questions
1. **Tesseract accuracy on Devanagari handwriting-free printed text** is generally good but must be benchmarked on the sample font (Mukta/Tiro-like); fallback options: PaddleOCR (needs Python sidecar) or AI adapter on synthetic/approved data.
2. **Chromium in the worker** is heavy; alternative `pdf-lib` + pre-shaped text if resources are tight (shaping of Devanagari makes this unattractive).
3. **pg-boss vs Redis:** start with pg-boss; revisit at > ~5k docs/day.
4. **Name search without encryption** of names: acceptable? (decision needed; alternative is blind-index prefix tokens).
5. **PDF variability:** the sample is raster-only; other states may be vector/text — pipeline must try native text first, then OCR.
6. Hosting region/provider for production (India data residency).

## 15. Build order (proposed)
1. Repo scaffold, docker-compose, Prisma migrate, auth + RBAC + audit skeleton, CI, security test harness.
2. Upload pipeline + storage + queue + worker skeleton.
3. Template extractor for the known form + benchmark harness with synthetic samples.
4. Review UI + farmer/land persistence + trust workflow.
5. Card renderer + QR + verify page + revocation.
6. i18n polish, dashboard, hardening, security test suite complete.
