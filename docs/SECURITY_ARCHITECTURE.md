# Security Architecture & Threat Model — v0.1 (draft)

Status: draft, to be frozen before implementation. Source: `AgriStackCardPlan.txt` security discussion + AI provider analysis below.

## 1. Principles
Privacy by design · Zero trust · Least privilege · Defense in depth · Every uploaded PDF is untrusted · Our cards are never presented as official government credentials · Auditability without leaking personal data.

## 2. Security areas (12)
Authentication · Authorization (RBAC + record-level) · Document security · Data protection · AI security · QR security · Secrets · API security · Audit · Infrastructure · Monitoring · Recovery.
Detailed controls are in `AgriStackCardPlan.txt` sections 3–13 and are carried forward unchanged. Priorities: P0 (before any real data) / P1 (hardening) / P2 (advanced).

## 3. AI provider security (Gemini and alternatives)

### 3.1 Two separate risks
1. **API-key security** — protects against billing abuse and misuse.
2. **Data-exposure security** — every PDF sent to a cloud AI leaves our infrastructure. A perfectly protected key does not change this.

### 3.2 API-key rules (P0)
- Key lives only in backend env vars / secrets manager. Never in client code, never `NEXT_PUBLIC_*`, never committed (`.env` in `.gitignore`; secret scanning in CI).
- Only the backend calls the AI provider. Browser → Backend → Provider, never Browser → Provider.
- Restrict key to the required API; set quota + budget alerts; rotate regularly; separate dev/prod keys.
- Never log keys, prompts, or PDF contents.

### 3.3 Data-exposure rules by provider tier
| Tier | Data handling (verify current terms before use) | Allowed data |
|---|---|---|
| Gemini API free tier (AI Studio, no billing) | Inputs/outputs may be used to improve Google products; may be human-reviewed | **Synthetic or fully redacted data only** |
| Gemini API paid tier | Not used for training; limited retention for abuse monitoring | Real data only after legal/DPDP review + redaction |
| Vertex AI (Mumbai `asia-south1`) | Enterprise data governance, regional endpoint, IAM auth | Preferred for production real data |
| Local OCR (Tesseract / PaddleOCR) | Data never leaves our infrastructure | Real data, always allowed |

Provider terms change; re-verify at the time of each production decision. Not verified as of this draft.

### 3.4 Provider abstraction (design requirement)
`DocumentExtractor` interface with interchangeable adapters: `LocalOcrExtractor` (default), `GeminiExtractor`, `VertexExtractor`. Selection by config + per-document policy (e.g. `real_data=true` forbids non-approved providers). Switching providers must not touch card-generation code.

### 3.5 Pre-send controls
- Detect and mask Aadhaar numbers, bank/PAN fields, and photos before any external call unless the field is required.
- Send only the pages/regions needed.
- Native/local extraction first; external AI only for fields local OCR could not read with sufficient confidence.
- Prompt-injection defense: model may only emit a fixed JSON schema; no tools, no DB access; backend re-validates every field (formats, ranges, checksums); a human approves.

### 3.6 Development-data rule
The sample files supplied for this project (source PDF, reference card photo) contain **real-looking personal data** (names, mobile numbers, email, photograph, Aadhaar-related consent). Treat them as real:
- Never send them to the free Gemini tier or any cloud service.
- Never commit them to a public repository; `.gitignore` the sample folder.
- Create synthetic lookalike samples (fake names, numbers, generated face/photo) for tests and demos.

## 4. Open items
- Legal review under DPDP Act 2023 / Rules 2025 and CERT-In directions before real data.
- Multi-tenancy decision (design tenant isolation into the data model regardless).
- Retention policy for original PDFs (recommend configurable, default delete-after-approval).
- Who may upload (recommend authenticated staff only for Release 1).

## Implemented controls (status as built)
- **Authentication:** Argon2id passwords; server-side sessions (opaque cookie, SHA-256 stored, HttpOnly, SameSite=Lax, `Secure` in production); lockout after 6 failures (15 min) and per-IP+account rate limit; constant-time-ish unknown-user path.
- **Password policy and lifecycle:** >= 12 chars, 3 of 4 classes, common/identifier checks; admin-issued temporary passwords are shown once and force a change (restricted session until then); a password change, suspension, role change, password reset or MFA reset revokes sessions immediately.
- **Two-step sign-in:** TOTP (RFC 6238, verified against the RFC vectors) with +-1 step drift, replay rejection (last accepted step stored), 8 hashed one-time recovery codes; mandatory per role via `MFA_REQUIRED_ROLES`; TOTP secret encrypted with the field key; failed second factors count toward lockout.
- **Admin safeguards:** org-scoped queries; no self-demotion/self-lockout; SUPER_ADMIN untouchable by ADMIN; dashboard returns counts only; audit holds ids and roles, never emails, names, secrets or passwords.
- **Extraction isolation:** jobs run in a throwaway child process with a scrubbed environment (no DB URL, no keys; unit-tested), timeout, heap cap, 0700 temp dir deleted after each job; the API itself never parses an upload in `WORKER_MODE=external`.
- **Known limits:** no OS-level sandbox yet; in-memory rate limiting; no idle session timeout; no email/SMS recovery channel.

### QR token size (decision record)
Verification tokens are 128-bit random values (22 base64url chars), stored only as SHA-256, looked up behind a 30/min rate limit and revocable per card. 128 bits is far beyond brute force and above OWASP's 64-bit minimum for identifiers. It replaced 256 bits because the shorter URL gives a 33x33 instead of 37x37 QR: at the 24 mm card size the decode rate on a poor print (100 dpi + blur) went from about 60% to 100% over 25 random tokens measured through the real PDF path. Previously issued 43-character tokens remain valid.
