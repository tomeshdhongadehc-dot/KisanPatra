# KisanPatra — platform-generated farmer identity cards

Upload a farmer registration PDF → local OCR extraction → human review → verifier approval → bilingual card with QR → public verification page.
Cards are **platform-generated, not government credentials**. See `docs/` for the PRD, functional scope, card spec, security architecture and technical architecture.

## Layout
```
apps/api        NestJS API (auth, documents, review, farmers, cards, public verify)
apps/web        Next.js UI (login, upload, review, farmer/card, /verify/[token])
packages/extract  PDF render + template OCR extractor (Tesseract CLI, local)
db/schema.prisma  PostgreSQL schema
tools/            e2e.mjs (API + security smoke), ui-smoke.mjs (browser)
tessdata/         Tesseract eng/mar/hin models (not committed)
docs/             planning documents
```

## Dev setup (Windows, zero cost, all local)
Prereqs: Node 22+, pnpm, Tesseract 5 (`C:\Program Files\Tesseract-OCR`), Chrome, PostgreSQL binaries.
1. `pnpm install` then `pnpm approve-builds --all` (once).
2. Copy `.env.example` → `.env` (dev values only). DB is a private Postgres (`.devdata/pg`), separate from any system Postgres. Use a free port: 5433 by default; on this machine WSL (`wslrelay.exe`) can occupy 5433, in which case use **5434** and set it in `DATABASE_URL`.
   Start it (match the port in `DATABASE_URL`): `pg_ctl -D .devdata/pg -o "-p 5434" -l .devdata/pg.log start`
3. Schema: `pnpm exec prisma generate --schema db/schema.prisma` and `pnpm exec prisma db push --schema db/schema.prisma`
4. Seed dev users: `cd apps/api && SEED_PASSWORD=<pick one> pnpm seed` (admin/operator/verifier/auditor `@dev.local`)
5. Run: `cd apps/api && pnpm start` and `cd apps/web && pnpm dev` → http://localhost:3000
6. Tests (clean DB first): `node tools/e2e.mjs "<sample.pdf>"` and `node tools/ui-smoke.mjs "<sample.pdf>"`
   i18n catalog check: `cd apps/api && npx tsx ../../tools/i18n-check.ts`
   Extraction only: `pnpm --filter @agri/extract bench -- "<sample.pdf>"`

## Accounts, admin and two-step sign-in
- Roles: ADMIN manages users; AUDITOR can read dashboard counts; OPERATOR/VERIFIER do the card workflow. Admin console at `/admin`, own account at `/account`.
- New users and admin password resets get a **temporary password shown once**; the session is restricted to the account page until it is changed (policy: >= 12 chars, 3 of 4 character classes, no common words, not containing the email name). A password change signs out all the user's other sessions.
- Two-step sign-in = TOTP authenticator app (RFC 6238, no dependency, replay-protected) + 8 one-time recovery codes (stored hashed). `MFA_REQUIRED_ROLES=ADMIN,VERIFIER` makes it mandatory in production (empty in dev). Lost phone: recovery code, or an admin resets the user's 2-step.
- Admins cannot change their own role/status or reset their own login through the admin API, and cannot touch SUPER_ADMIN. Suspending a user or changing a role revokes their sessions immediately. Audit entries hold ids and roles only.
- Env: `MFA_REQUIRED_ROLES`, `LOGIN_RATE_MAX` (10 per 15 min per IP+account), `REVIEW_CONFIDENCE` (0.90).
- Security audit: `node tools/security-test.mjs` (own API + 2 workers, synthetic forms, port 4000 free) checks record isolation between operators, four-eyes, upload limits, CSRF on every mutating route, headers/cookies/error hygiene, injection and mass-assignment, public-verify leakage and enumeration, no plaintext personal data in the database dump, audit log hygiene, encrypted files, and that two workers never process a document twice.
- Tests: `tools/admin-test.mjs` (API, starts its own server), `tools/admin-ui-smoke.mjs` (browser), `apps/api/src/totp.test.ts` (RFC vectors).

## Printing
Every approval issues three files, stored privately: card PNG, PVC PDF (85.6x54 mm, 2 pages) and an **A4 print sheet** (`GET /farmers/:id/card?format=a4`): front and back at true size, crop marks, a 50 mm scale bar to detect "fit to page" printing, bilingual print instructions. The sheet is rendered at issue time because the QR token exists in plaintext only then.
- Fonts: Noto Sans + Noto Sans Devanagari (SIL OFL 1.1) are bundled in `apps/api/assets/fonts` and embedded in the HTML, so Marathi/Hindi shaping never depends on the machine.
- QR: vector SVG, 24 mm, error correction M, 128-bit token (22 chars, 33x33 modules). Module size decides scannability and it is a cliff, not a slope: 20 mm QR decoded 0/60 at 100 dpi + blur, 24 mm decoded 60/60 (image-level test). Through the real PDF path over 25 random tokens, 256-bit tokens (37x37) decoded the poor-print case (100 dpi + blur 0.8) only ~60-64% of the time; 128-bit tokens decode it 100% (decision record in docs/SECURITY_ARCHITECTURE.md). Higher error-correction levels scan worse at this size.
- `cd packages/extract && npx tsx src/qrscan.ts <pdf> <url-prefix>` renders a PDF at 300/200/150/120/100 dpi with blur/noise/washed-out toner and decodes it with an independent decoder. `tools/e2e.mjs` writes `.devdata/last-a4.pdf` and `last-pvc.pdf` for it.
- **Not a substitute for a real phone test**: print the A4 sheet on a normal printer and scan it with 2-3 different phones (an older Android, an iPhone, the camera app and a QR app) before rollout.

## Extraction worker and queue
Uploads only create a `QUEUED` ExtractionJob row. A worker claims jobs from Postgres (`FOR UPDATE SKIP LOCKED`) and runs each one in a throwaway child process (`apps/api/src/extract-child.ts`) that has **no DB credentials and no keys** (`childEnv()`, covered by `queue.test.ts`), a hard timeout and a heap cap. The PDF copy and page images live in a 0700 temp dir that is deleted after every job.
- Dev default `WORKER_MODE=inline`: the API runs the loop itself. Production: `WORKER_MODE=external` on the API and `pnpm --filter @agri/api worker` as a separate process, so the API never parses uploads.
- Retries: crash/timeout is retried once; deterministic failures (unsupported layout) fail at once. Jobs orphaned by a dead worker are re-queued after `STALE_JOB_MS` (never shorter than the job timeout).
- Env: `WORKER_CONCURRENCY` (1), `EXTRACTION_TIMEOUT_MS` (120000), `EXTRACTION_CHILD_MEM_MB` (1536), `STALE_JOB_MS`.
- `node tools/queue-test.mjs "<sample.pdf>"` (needs port 4000 free, fresh DB) checks: API alone does not process, timeout kill, garbage PDF, worker crash recovery.
- Known gap: no OS-level sandbox (container/seccomp/cgroup CPU limits) yet; the child isolation is process + env + timeout + heap cap. Windows dev has no memory cgroup.

## Extraction benchmark
`node tools/bench/generate.mjs 36 7` builds synthetic forms (fabricated people, real form layout, scan degradations: clean/jpeg/skew/lowres/noisy) with ground truth in `samples/synthetic/`.
`cd packages/extract && npx tsx src/benchmark.ts <abs-path>/samples/synthetic --out <abs-path>/.devdata/bench` writes `report.md` / `report.json`: exact-match and CER per field and variant, review-flag rate, confidence calibration, and **silent errors** (wrong but not flagged for review; target 0).
Last result (36 forms, 1,464 fields): **96.7% exact**, mean CER 0.021, **0 silent errors**, 30% of fields flagged for review. Weakest fields: `address_local` (Devanagari spelling slips, always flagged), `caste_category` / `farmer_type` / `land.sub_survey_no` on the noisy and low-resolution variants (cell read as empty, flagged).
Mechanical corrections (all flagged for the reviewer, raw OCR text always kept, so nothing is corrected silently): near-miss caste category / farmer type snapped to the closed list (`SNAPPED_TO_LIST`, never for ambiguous or 2-letter values); junk in the sub-survey cell dropped (`SUB_SURVEY_UNREADABLE`); enrollment number regrouped to 2/3/4/6/6 digits when exactly 21 digits were read (`AUTO_REGROUPED`); a Marathi/Hindi name word split or off by one letter is repaired from the same name printed elsewhere on the form, with 2+ witnesses needed for a letter change (`NAME_RECONCILED`, `packages/extract/src/names.ts`). Unit tests: `pnpm --filter @agri/extract test`.
Limits: synthetic forms test content and scan quality, not layout drift between real form versions; add real redacted forms as they become available.

## Languages
Marathi (default), Hindi, English. Catalogs: `apps/web/app/i18n/messages.ts` (add a language = add one catalog + entry in `LANGS`). Choice is stored in a `lang` cookie (falls back to Accept-Language). Public verify page is server-rendered in the same language. Card artwork is bilingual mr/en by design.

## Data safety
Sample PDFs/photos contain real personal data: they are git-ignored, processed locally only, and must never be sent to a cloud AI on the free tier. Use synthetic documents for demos and tests.

## Known gaps (tracked for next steps)
- Isolation is process + scrubbed env + timeout + heap cap only; no container/seccomp/cgroup sandbox for the extraction child yet (deployment step).
- Only the AgriStack Farmer Registration Form template; fixed-region OCR (anchor check on title only). No generic fallback yet.
- Marathi/Hindi wording is machine-drafted and needs native-speaker review (UI strings and the printed instructions).
- Rate limiting is in-memory and per IP (shared-IP offices may be throttled; resets on restart); sessions have no idle timeout; no malware scanning hook; storage is local disk, not encrypted at rest (field-level encryption only).
- No email/SMS: password recovery is admin-issued temporary passwords (shown once) and MFA recovery is recovery codes or an admin reset. Add a self-service reset when a mail/SMS provider exists.
- OCR accuracy and the review threshold (0.90) are calibrated on synthetic forms plus one real sample; recalibrate on real redacted forms from other districts/states. QR scan is simulated with an independent decoder, not yet confirmed on physical phones from a physical print.
