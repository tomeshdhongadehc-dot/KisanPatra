# Farmer Card Specification — v0.1 (draft)

Based on the supplied reference photo of an AgriStack-style Marathi card ("शेती परिचय पत्र") and the decisions in `FUNCTIONAL_SCOPE.md` §15. We replicate the *information layout*, not government branding.

## 1. What we take from the reference
| Element | Reference card | Our card |
|---|---|---|
| Header bar | Dark navy, logo left, white Marathi title "शेती परिचय पत्र" right | Navy bar, **our own platform logo**, title "शेतकरी ओळखपत्र / Farmer Identity Card" (final wording TBD) — no AgriStack logo/emblem |
| Photo | Left, portrait, framed; wheat emblem below | Left portrait frame; neutral wheat/leaf icon of our own design |
| Name | "नाव : <Marathi>" + English name beneath | Same, Marathi + English |
| Details | DOB, Gender, Mobile, Aadhaar No. (bilingual labels "मराठी / English") | DOB, Gender, Mobile; **Aadhaar omitted** |
| QR | Top right | Top right; encodes `https://<domain>/verify/<token>` only |
| Footer bar | Green bar: "फार्मर आयडी" + 11-digit ID, white text | Green bar: "प्लॅटफॉर्म फार्मर आयडी / Platform Farmer ID" + platform ID (e.g. `FRM-XXXXXX`) |
| Second panel | Rounded bordered box: address (mr + en), land details table (District, Taluka, Village, Gat No., Area ha) | Address (mr + en) + "Associated land" panel (max 2 rows: Survey/Gat No., Village, Taluka, District) or parcel count |
| Disclaimer | Bottom note: personal use only, not a government identity document | Mandatory, mr + en, expanded: "Platform-generated card. Not a government identity document. Land shown is associated, not proof of ownership." |

## 2. Additions we make
- Trust-level label (e.g. "Document reviewed") — reference has none.
- Issue date and card version.
- Source Farmer ID (official, unverified) shown on back/digital only, labelled "Linked ID (not verified by platform)".
- Optional "DRAFT" watermark before approval.

## 3. Formats
| Format | Size | Notes |
|---|---|---|
| Screen PNG | 1011×638 px @300 dpi (CR80 landscape) per side | Download/share |
| PVC print PDF | 85.6×54 mm, 3 mm bleed, front + back, 300+ dpi | For card printers |
| A4 sheet PDF | Cards at true size with cut guides; 1 or multiple per sheet | Home/service-centre printing |
All formats identical in data and QR. QR 24 mm square (vector SVG, so it is crisp at any print DPI), quiet zone 4 modules, error correction level M (higher levels make the code denser and scan worse at this size). Measured: at 100 dpi + blur a 20 mm QR decoded 0/60 times, 24 mm decoded 60/60. Verify scan success at print size with `packages/extract/src/qrscan.ts`.

## 4. Typography and i18n
- Noto Sans Devanagari (+ Noto Sans for Latin) embedded; verify conjuncts (क्ष, ज्ञ, र्‍) render correctly.
- Bilingual label format "मराठी / English" as in reference. Hindi/English variants share the same template.
- Dates dd-mm-yyyy; numbers in Western digits on card (reference uses them), Devanagari digits optional per language setting.

## 5. Data shown vs not shown
**On card (physical, held by farmer):** photo, name (mr/en), DOB, gender, mobile, platform ID, QR, address, associated land summary, trust level, issue date.
**Never on card:** Aadhaar, bank, PAN, caste, full parcel list, documents.
**Public QR page:** status, platform ID, trust level, issue date, issuer, reference. No photo (decided).

## 6. Generation rules
1. Only from approved data at L2 or above.
2. Rendered server-side from a versioned template; same code path for all formats.
3. Text overflow rules: names up to 2 lines, auto-shrink to a minimum size then flag for manual layout review; long addresses truncated with "…" only on card, never in data.
4. Cards are immutable; data changes create a new version and supersede the old one.

## 7. Acceptance tests
- Visual regression on synthetic sample: Marathi name, long name, 1/2/5 parcels, missing photo, missing email.
- QR scans on phone from the printed PVC and A4 outputs.
- Disclaimer present on every output.
- No AgriStack/government marks in any asset (automated asset check).

## 8. Open items
- Final title wording and our logo/colours (reference palette: navy header, green footer).
- Whether the reference's farmer-ID field label should be adapted to avoid any resemblance to official issuance.
- Back-side layout for PVC (reference shows a single sheet-style card, not a two-sided card).
