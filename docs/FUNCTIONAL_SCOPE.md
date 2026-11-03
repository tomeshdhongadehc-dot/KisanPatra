# Functional Scope — Release 1 (Identity Foundation) — v0.1 (draft)

Companion to `PRD.md` and `SECURITY_ARCHITECTURE.md`. Scope = Release 1 only. Release 2/3 items appear in §12 as "deferred".
Priority: **M** = must (MVP), **S** = should, **C** = could. Each feature has a business rule (BR) and acceptance criteria (AC).

## 1. Modules overview
| # | Module | Release 1 priority |
|---|---|---|
| M1 | Authentication & Access Control | M |
| M2 | Document Intake (upload + validation) | M |
| M3 | Document Processing (render, OCR, extraction) | M |
| M4 | Data Verification (review UI) | M |
| M5 | Farmer Records (profile, parcels) | M |
| M6 | Trust Levels & Approval Workflow | M |
| M7 | Card Generation | M |
| M8 | QR & Public Verification | M |
| M9 | Document Wallet | S |
| M10 | Admin & Settings | S |
| M11 | Audit & Monitoring | M |
| M12 | Localization (mr/hi/en) | M |
| M13 | Dashboard | S |

## 2. M1 — Authentication & Access Control
| ID | Feature | Pri |
|---|---|---|
| 1.1 | Email/mobile + password login, Argon2id hashing, server-managed session (HttpOnly, Secure, SameSite cookie) | M |
| 1.2 | Roles: Super Admin, Admin, Operator, Verifier, Viewer, Auditor | M |
| 1.3 | Permission guards + record-level checks on every API (no ad-hoc controller checks) | M |
| 1.4 | Login rate limiting, progressive delay, account lockout | M |
| 1.5 | MFA (TOTP) for Admin/Super Admin/Verifier | S |
| 1.6 | Password reset via single-use expiring token; session revocation on password change/suspension | M |
| 1.7 | User management (create, suspend, change role) by Admin | M |

**BR:** Knowing a record ID never grants access. Operators see only records they created or are assigned (unless Admin).
**AC:** Unauthenticated request → 401; wrong role → 403; accessing another operator's record → 403 and audited; 6 failed logins → lockout/delay; suspended user's live session is rejected on next request.

## 3. M2 — Document Intake
| ID | Feature | Pri |
|---|---|---|
| 2.1 | Upload single PDF (drag-drop / picker, mobile-friendly) | M |
| 2.2 | Validate extension, MIME, `%PDF` signature, size (configurable, default 15 MB), page count (default ≤ 10) | M |
| 2.3 | Random storage key; private storage; no public URLs; access via short-lived signed URL | M |
| 2.4 | SHA-256 duplicate detection → warn "document already uploaded" with link (permission permitting) | M |
| 2.5 | Quarantine status until validation passes; malware scan hook (pluggable, ClamAV later) | M/S |
| 2.6 | Upload status tracking (uploaded → validated → processing → ready for review → failed) | M |
| 2.7 | Image upload (JPG/PNG) as alternate source | C |

**BR:** Rejected files are deleted from quarantine; only metadata (reason, hash, time) retained.
**AC:** `.exe` renamed `.pdf` → rejected; corrupted PDF → safe failure message, no crash; oversize → rejected before full read; duplicate hash → flagged; anonymous upload → 401.

## 4. M3 — Document Processing
| ID | Feature | Pri |
|---|---|---|
| 3.1 | Render PDF pages to images in an isolated worker (timeout, memory limit) | M |
| 3.2 | Classify document type: "AgriStack Farmer Registration Form" (template) vs unknown | M |
| 3.3 | Skip non-data pages (consent pages) for the known template | M |
| 3.4 | Extractor interface with adapters: LocalOcr (default), Gemini, Vertex | M |
| 3.5 | Template extraction: crop known regions → OCR (Marathi/Hindi/English) → typed fields with confidence + page/region reference | M |
| 3.6 | Photo extraction: crop farmer photograph region as separate image | M |
| 3.7 | Post-processing: rejoin wrapped words, strip stray punctuation, normalize dates (dd/mm/yyyy), phone (10 digits), area (decimal ha), "*" → none | M |
| 3.8 | Validation rules (see §4.1) and cross-field consistency checks | M |
| 3.9 | Redaction: Aadhaar/bank/PAN never persisted or sent externally unless explicitly enabled | M |
| 3.10 | Provider policy: real-data documents cannot use non-approved external providers | M |
| 3.11 | Async job queue with retry, idempotency, and recoverable failures | M |
| 3.12 | Support levels: (a) known templates → full extraction + validation; (b) unfamiliar but readable layouts → generic OCR/AI extraction, mandatory manual review (external AI only under provider policy 3.10); (c) unreadable/encrypted/unsupported → clear rejection or manual-assistance path | S |
| 3.13 | Template-independent pipeline: identify type → detect language/layout → extract → store source page + evidence per field → validate → human review → keep original + extractor version | M |
| 3.14 | Benchmark set of redacted/synthetic documents from multiple states before declaring a template "known" | M |

### 4.1 Field catalogue and validation (Release 1, template "Farmer Registration Form")
| Field | Type / rule | Required for card |
|---|---|---|
| enrollment_number | pattern `\d+_\d+_\d+_\d+_\d+` | S |
| farmer_id (source) | 11 digits | M |
| name_en | letters/spaces, non-empty | M |
| name_local | Devanagari, non-empty | M |
| gender | Male/Female/Other | M |
| dob | valid date, age 0–120; age field must match DOB ±1 yr | M |
| mobile | 10 digits, starts 6–9 | M |
| email | RFC-valid | C |
| address_en / address_local | non-empty | M |
| farmer_type, occupation | free text from form | S |
| land_parcels[] | state, district, sub_district, village, `survey_identifier` {value, original_label e.g. "Gat No."/"S No."/"Survey No."}, sub_survey_no, owner_name, owner_type, share_type, relationship (owner/tenant/sharecropper/family/other), area_total_ha, area_owned_ha, area_leased_ha, area_cultivated_ha (each optional, separately labelled), supporting_doc_refs, verification status + source | S (landless/tenant farmers valid) |
| photo | image crop, min resolution | M |
| (excluded) bank, PAN, caste cert, KCC, disabilities, Aadhaar | not collected by default | — |

**BR:** AI/OCR output never becomes approved data automatically. Each field stores raw value, normalized value, confidence, source page/region, and extractor version.
**AC:** On the supplied sample (synthetic equivalent), all M-fields extracted and flagged-for-review where confidence < threshold; wrapped "YAVATM AL" → "YAVATMAL"; "1.200000," → 1.2; prompt-injection text in a PDF never alters output schema; killed worker → job resumes/retries without duplicate records.

## 5. M4 — Data Verification (Review UI)
| ID | Feature | Pri |
|---|---|---|
| 4.1 | Split view: page image with highlighted source region ↔ editable fields | M |
| 4.2 | Confidence badges; low-confidence and validation-failed fields forced to be confirmed | M |
| 4.3 | Cross-section mismatch flags (e.g. header name vs land owner name) with explicit "accept both / choose / edit" | M |
| 4.4 | Add/edit/remove land parcels | M |
| 4.5 | Change history per field (who, when, old → new) | M |
| 4.6 | Save draft & resume | M |
| 4.7 | Submit for approval | M |

**BR:** Transcription is exact — the system never auto-corrects names or "normalizes" spellings. Reviewer must tick "I verified against the document" before submit.
**AC:** Cannot submit with unresolved required-field errors; every edit is audited; mismatch flag blocks approval until resolved.

## 6. M5 — Farmer Records
Entities (separate tables): Person · ContactInfo · Address · LandParcel · CultivationRight (owner/tenant/etc.) · SourceDocument · ExtractedData · Card · VerificationToken · AuditEvent.
| ID | Feature | Pri |
|---|---|---|
| 5.1 | Create farmer record from approved extraction or manually | M |
| 5.2 | Search by name (mr/en), mobile, farmer ID, village; pagination | M |
| 5.3 | Record detail view with documents, cards, history | M |
| 5.4 | Platform Farmer ID generation (non-sequential public form, e.g. prefix + random base32), clearly distinct from source/official Farmer ID | M |
| 5.5 | Store source Farmer ID as "linked official ID (unverified)" until L3 | M |
| 5.6 | Soft-delete / archive with retention rules | S |
| 5.7 | Duplicate farmer detection (same source Farmer ID or mobile+DOB) | S |

**BR:** Landless farmer types are valid records (parcels optional). Deleting a farmer revokes their tokens.

## 7. M6 — Trust Levels & Approval
States: **L0 Draft → L1 Submitted → L2 Document reviewed → L3 Officially verified → L4 Reverification required.**
| Transition | Who | Rule |
|---|---|---|
| L0→L1 | Operator | Required fields complete |
| L1→L2 | Verifier (not the submitter) | Four-eyes principle; documented checklist |
| L2→L3 | System via authorized official-source integration only | **Not available in Release 1**; no manual override |
| any→L4 | Verifier/Admin/system | Reason required; card shows "reverification required" |
| L2/L3 → revoked | Admin | Reason required; QR immediately fails |

**AC:** Submitter cannot approve own record; L3 cannot be set via UI/API in R1; every transition audited.

## 8. M7 — Card Generation
| ID | Feature | Pri |
|---|---|---|
| 7.1 | Card layout per reference (see `CARD_SPEC.md`): title bar, photo, QR, name (mr + en), DOB, gender, mobile, platform ID footer bar; second panel: address (mr + en) and an "Associated land" summary | M |
| 7.2 | Generate PNG (screen), PVC print file (CR80 85.6×54 mm, front+back) and A4 sheet with cut guides; same data and QR in every format | M |
| 7.3 | Embedded Devanagari font; correct conjunct rendering | M |
| 7.4 | Mandatory disclaimer: "Platform-generated card. Not a government identity document." (mr + en) | M |
| 7.5 | Trust level shown (e.g. "Document reviewed") | M |
| 7.6 | Multiple parcels: card shows at most 2 parcel rows (survey/gat no., village, taluka, district); with more, show parcel count + "see digital record via QR (login required)". Never claims ownership (see 7.11) | M |
| 7.11 | Card is an identity card, not a land ownership certificate: land panel is titled "Associated land (not proof of ownership)" (mr + en); relationship (owner/tenant/etc.) shown only when recorded; areas printed only with their type label | M |
| 7.7 | Card versioning; regenerate on approved data change; old versions marked superseded | M |
| 7.8 | No AgriStack/government logo or emblem; platform's own branding | M |
| 7.9 | Aadhaar number never printed (masked option deferred pending legal decision) | M |
| 7.10 | Download access audited; watermark option for drafts | S |

**AC:** Card cannot be generated before L2; generated card matches approved data exactly; Marathi text visually correct; disclaimer always present; PDF prints at correct physical size.

## 9. M8 — QR & Public Verification
| ID | Feature | Pri |
|---|---|---|
| 8.1 | On card issuance, generate 128-bit random token (22 chars; was 256-bit, reduced for QR scan reliability, see SECURITY_ARCHITECTURE); store only its hash; QR encodes `https://<domain>/verify/<token>` | M |
| 8.2 | Public verification page (no login): status (active / revoked / expired / superseded / not found), platform Farmer ID, trust level, card issue date, issuing platform name, verification reference, last-verified timestamp | M |
| 8.3 | Public page shows minimal data only. **No photo, Aadhaar, phone, address, land, documents or family details.** Farmer name is off by default and may be enabled by Admin only where disclosure is justified. Photo verification is a future feature needing legal basis, consent and access control | M |
| 8.4 | Revoke / rotate token | M |
| 8.5 | Rate limiting, generic responses for invalid tokens (no enumeration) | M |
| 8.6 | Page clearly states: "Confirms this card exists in this platform's records; not government verification" | M |
| 8.7 | Verification event log (time, outcome; no IP stored beyond abuse window) | S |
| 8.8 | Signed offline-verifiable QR payload | Deferred |

**AC:** revoked token → "revoked"; random token → generic not-found; 100 rapid scans from one source → rate-limited; no personal data in URL or query string.

## 10. M9 — Document Wallet (Release 1 minimal)
Store original PDF (per retention policy), generated cards, and extracted source page images; per-document provenance label (`uploaded by operator`, `L2 reviewed`, never "government verified"); signed-URL download; access logged. Farmer-facing wallet UI and sharing deferred to Release 2.

## 11. M10–M13
**Document retention (decided):** originals are kept in encrypted private storage after approval (needed for re-verification, disputes, corrections, audit, reprocessing) under a configurable per-category policy: original PDF · extracted data (separate DB) · verification result (kept with audit history) · rejected/duplicate uploads (deleted per policy) · superseded documents (retained per policy) · expired/unnecessary documents (delete/archive). Includes secure-deletion workflow, retention-expiry job, access logs, backup expiry policy, and farmer-visible document history (R2). Aadhaar/sensitive documents are not collected unless necessary, and retention is disclosed in the privacy notice.
**M10 Admin & Settings:** user/role admin; QR public-field settings; retention policy settings; extractor/provider policy; confidence thresholds.
**M11 Audit:** append-only events (user, action, entity type + internal ID, outcome, timestamp, correlation ID); no PII/tokens/keys in logs; Auditor read-only view with filters; export.
**M12 Localization:** UI strings externalized; mr/hi/en; Indian date/number formats; Devanagari search normalization; language switch persisted per user.
**M13 Dashboard:** counts by status, processing failures, extraction correction rate, cards issued; operator work queue.

## 12. Out of scope for Release 1 (deferred)
Farmer self-service app/login · Android app · voice/AI assistant · scheme discovery · crop/weather/farm records · financial diary · marketplace · FPO network · official-registry (L3) integration · IVR · offline mode · multi-tenant UI (data model is tenant-ready) · bulk batch upload (could in R1.1).

## 13. Key workflows

**W1 — Assisted registration from PDF (primary):** Operator logs in → uploads PDF → validated/quarantined → worker renders pages → classify template → region OCR + normalize + validate → review UI → operator corrects/confirms → submit (L1) → Verifier reviews (L2) → platform ID + card + QR generated → operator downloads/prints → scans QR to confirm.

**W2 — Manual registration:** Operator enters fields in the same review form without source PDF (records marked "manual entry, no source document"); same L1→L2 flow.

**W3 — Correction after issue:** Edit approved record → requires permission + reason → record returns to L1/L4 per field sensitivity → new card version; previous QR shows "superseded/updated".

**W4 — Revocation:** Admin revokes → token invalidated → verification page shows revoked → audited.

## 14. Business-rule register (cross-cutting)
1. Exact transcription; no silent corrections.
2. AI/OCR proposes, humans approve; submitter ≠ approver.
3. L3 only via authorized official source.
4. Platform ID ≠ official Farmer ID; both labelled.
5. No Aadhaar/bank/PAN persistence by default.
6. No PII in QR, URLs, logs.
7. Every sensitive read/write audited.
8. Every card carries the disclaimer.
9. The card identifies a farmer; it is never a land ownership certificate. Listed parcels are "associated", with relationship stated where known; areas always carry their type label; shared/overlapping interests are never summed as separate holdings.
10. Use neutral regional terminology ("Survey / Gat No."); keep the original label from the source document.

## 15. Decisions (finalized)
| # | Decision | Final choice |
|---|---|---|
| 1 | Print size | Both: PVC CR80 (85.6×54 mm) and A4 sheet with cut guides; same data + QR |
| 2 | Multiple parcels | Card shows count/summary (max 2 rows); full parcel register digital only |
| 3 | Public photo | No; private by default |
| 4 | Original PDFs | Keep securely under configurable retention policy |
| 5 | Other PDF layouts | Yes: known templates full, unfamiliar layouts generic + manual review, unsupported rejected |
| 6 | Area / land number | Separate area types, labelled; neutral "Survey / Gat No." with original label preserved |
| + | Card ≠ ownership certificate | Mandatory (rule 9) |

**Note on item 2 vs the AgriStack reference card:** the reference card prints one parcel's district, taluka, village, gat no. and area. We keep that familiar panel but cap it at 2 rows, retitle it "Associated land (not proof of ownership)", and label any area by type. Sensitive detail beyond that stays in the digital record.

## 16. Remaining open questions
1. Masked Aadhaar on card, yes/no (currently no).
2. Farmer name on public verification page: default off — confirm.
3. Other state templates: which first, and sample PDFs.
4. Retention periods per category (needs legal input).
