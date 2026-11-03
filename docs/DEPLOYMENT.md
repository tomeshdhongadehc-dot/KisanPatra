# Deployment checklist (production)

Status: the application slice is built and tested in dev. This lists what must be set or done before real farmer data is handled. Items marked **[you]** need a decision or an action outside the code.

## 1. Secrets and configuration (never commit; use a secret manager)
| Variable | Production value |
|---|---|
| `APP_MASTER_KEY`, `APP_BLIND_INDEX_KEY` | New random 32+ byte values (not the `dev-only…` placeholders; the API refuses `dev-only` values when `NODE_ENV=production`). Back them up: losing the master key makes stored data and files unreadable. |
| `DATABASE_URL` | Managed Postgres, TLS required, least-privilege app role. |
| `NODE_ENV` | `production` (enables `Secure` cookies). |
| `WEB_ORIGIN`, `PUBLIC_BASE_URL` | Your real HTTPS origin. The QR encodes `PUBLIC_BASE_URL/verify/<token>`; changing the domain later breaks every printed card, so choose a permanent short domain. |
| `MFA_REQUIRED_ROLES` | `ADMIN,VERIFIER` (at least). |
| `WORKER_MODE` | `external` on the API; run the worker as a separate process. |
| `REVIEW_CONFIDENCE` | `0.90`, then recalibrate on real redacted forms (`tools/bench`). |
| `LOGIN_RATE_MAX` | Leave default (10 per 15 min per IP+account). |
| `STORAGE_DIR` | Persistent volume; backed up together with the database. |

Do not seed the dev users (`seed.ts`, password `Dev-Pass-12345`) in production. Create the first ADMIN through a one-off script, then sign in, set a new password and enrol MFA.

## 2. Network
- HTTPS only (TLS terminated at a reverse proxy); HSTS on. Set Express `trust proxy` to the proxy so rate limits use the real client IP (currently `false`).
- Only the web app is public. The API, worker and Postgres are on a private network. The web app proxies `/api/v1/*`.

## 3. Isolation of extraction **[you]**
The extraction child already runs with a scrubbed environment, a timeout and a heap cap. For real data also run the worker in a container (or VM) with: no network egress, read-only root filesystem, a small writable tmpfs for job directories, CPU and memory cgroup limits, non-root user, seccomp/AppArmor default profile. This is the main gap left in the isolation design.

## 4. Data protection
- Retention: set the `RetentionPolicy` for source PDFs and page images; schedule the purge job (not built yet).
- Backups: encrypted, tested restore; keep key backups separate from data backups.
- Logs: the API logs ids and codes only. Keep it that way; do not add request-body logging.
- Rotate `APP_MASTER_KEY` only with a re-encryption job (not built yet; field and file formats carry a version prefix `v1:` / `AGR1` to allow it).

## 5. Before the first real card
1. Print the A4 sheet and scan it with at least three phones (older Android, newer Android, iPhone; camera app and a QR app). Confirm the 50 mm scale bar measures 50 mm.
2. Have a Marathi and a Hindi speaker review every UI string and the printed instructions (`apps/web/app/i18n/messages.ts`, `apps/api/src/cardhtml.ts`).
3. Run the benchmark on real redacted forms from your districts; recheck zero silent errors at the chosen threshold.
4. Confirm the legal wording on the card and verify page with whoever is accountable for the programme: it is a platform-generated card, not a government ID, and not proof of land ownership.
5. Run the full regression: `e2e.mjs`, `ui-smoke.mjs`, `admin-ui-smoke.mjs`, `admin-test.mjs`, `queue-test.mjs`, unit tests.

## 6. Known gaps that remain
No OS-level extraction sandbox yet (section 3). In-memory rate limiting (per process, resets on restart; use a shared store if more than one API instance). No idle session timeout. No email/SMS channel, so password recovery is admin-issued. No retention purge job or key-rotation job. OCR accuracy is calibrated on synthetic forms plus one real sample.
