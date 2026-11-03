import sharp from "sharp";
import tpl from "../templates/agristack-farmer-reg-form.v1.json";
import { cropForOcr, ocr } from "./ocr";
import { deskewPage, inkRatio } from "./preprocess";
import * as N from "./normalize";
import { Box, ExtractionResult, ExtractedFieldOut, ExtractorOptions, PageImage } from "./types";

const scaleBox = (b: number[], sx: number, sy: number): Box => ({
  x: Math.round(b[0] * sx), y: Math.round(b[1] * sy), w: Math.round(b[2] * sx), h: Math.round(b[3] * sy),
});

function applyKind(kind: string, raw: string, lines: string[]): { value: string | null; error?: string } {
  switch (kind) {
    case "enrollment": return N.normEnrollment(raw);
    case "farmer_id": return N.normFarmerId(raw);
    case "gender": return N.normGender(raw);
    case "date": return N.normDate(raw);
    case "age": return N.normAge(raw);
    case "mobile": return N.normMobile(raw);
    case "email": return N.normEmail(raw);
    case "area": return N.normArea(raw);
    case "star": return { value: N.normStar(raw) };
    // Cell text wrapped inside a narrow column: a line break is not a space. Spaces inside one line are kept ("Mota Pimpri").
    case "wrapped": return lines.length > 1 ? { value: N.clean(lines.join("")) || null, error: "WRAPPED_CHECK" } : { value: N.normStar(raw) === null ? null : N.clean(raw) };
    case "survey": return { value: N.normStar(raw)?.replace(/\s+/g, "") ?? null };
    case "state": { const r = N.rejoinKnown(raw, N.STATES); return { value: r.value, error: r.matched ? undefined : "STATE_UNRECOGNISED" }; }
    case "district": { const r = N.rejoinKnown(raw, N.MAHARASHTRA_DISTRICTS); return { value: r.value, error: r.matched ? undefined : "DISTRICT_UNRECOGNISED" }; }
    default: return { value: N.normStar(raw) === null ? null : N.clean(raw) };
  }
}

const BLANK_INK = 0.0008; // a cell with <0.4% dark pixels is empty (printed form fields left blank)

async function readField(
  page: PageImage, key: string, box: Box, lang: string, kind: string, psm: 6 | 7,
  opts: ExtractorOptions, whitelist: string | undefined, pageNo: number,
): Promise<ExtractedFieldOut> {
  const img = await cropForOcr(page.png, box);
  if ((await inkRatio(img)) < BLANK_INK) return { key, raw: "", value: null, confidence: 1, page: pageNo, box, errors: [] }; // genuinely blank
  const r = await ocr(img, lang, psm, opts, whitelist);
  const lines = r.text.split(/\r?\n/).map((x) => N.clean(x)).filter(Boolean); // clean() also drops border slivers read as "|"
  const raw = lines.join(" ");
  const n = applyKind(kind, raw, lines);
  const errors = n.error ? [n.error] : [];
  // Tesseract's Marathi/Hindi output is not reliable enough to trust by confidence (e.g. चौक read as चोक at 0.95+): always send to a human.
  if (n.value && /mar|hin/.test(lang)) errors.push("LOCAL_TEXT_CHECK");
  return { key, raw, value: n.value, confidence: r.confidence, page: pageNo, box, errors };
}

/** y positions of long horizontal rules inside [x0,x1] (table borders). */
async function horizontalLines(png: Buffer, x0: number, x1: number): Promise<number[]> {
  const { data, info } = await sharp(png).grayscale().raw().toBuffer({ resolveWithObject: true });
  const ys: number[] = [];
  for (let y = 0; y < info.height; y++) {
    let dark = 0;
    for (let x = x0; x < x1; x++) if (data[y * info.width + x] < 175) dark++;
    if (dark / (x1 - x0) > 0.6) ys.push(y);
  }
  const groups: number[] = [];
  let start = -1, prev = -10;
  for (const y of ys) {
    if (y - prev > 3) { if (start >= 0) groups.push(Math.round((start + prev) / 2)); start = y; }
    prev = y;
  }
  if (start >= 0) groups.push(Math.round((start + prev) / 2));
  return groups;
}

export function classify(pages: PageImage[]): "AGRISTACK_FARMER_REG_FORM" | "UNKNOWN" {
  const landscape = pages.length >= 2 && pages.every((p) => p.width > p.height);
  return landscape && pages.length <= 6 ? "AGRISTACK_FARMER_REG_FORM" : "UNKNOWN";
}

export async function extractFarmerForm(pages: PageImage[], opts: ExtractorOptions): Promise<ExtractionResult> {
  const warnings: string[] = [];
  if (!pages[0]) throw new Error("NO_PAGES");
  const d1 = await deskewPage(pages[0]);
  const p1 = d1.page;
  if (d1.angle) warnings.push(`DESKEWED_P1_${d1.angle}`);
  const sx = p1.width / tpl.reference.width, sy = p1.height / tpl.reference.height;

  // Anchor check: the title must read "Farmer Registration Form", else the template does not apply.
  const title = await ocr(await cropForOcr(p1.png, scaleBox([300, 40, 680, 70], sx, sy), 2, 1), "eng", 7, opts);
  if (!/registration/i.test(title.text)) throw new Error("TEMPLATE_ANCHOR_MISMATCH");

  const fields: ExtractedFieldOut[] = [];
  for (const [key, f] of Object.entries(tpl.page1) as [string, any][]) {
    fields.push(await readField(p1, key, scaleBox(f.box, sx, sy), f.lang, f.kind, f.psm, opts, f.whitelist, 1));
  }

  // Photo crop (kept as an image; never OCR'd, never sent to any external service).
  const pb = scaleBox(tpl.photoBox, sx, sy);
  const photoJpeg = await sharp(p1.png).extract({ left: pb.x, top: pb.y, width: pb.w, height: pb.h }).jpeg({ quality: 92 }).toBuffer();

  // Land table on page 2
  const parcels: ExtractionResult["parcels"] = [];
  const d2 = pages[1] ? await deskewPage(pages[1]) : null;
  const p2 = d2?.page;
  if (d2?.angle) warnings.push(`DESKEWED_P2_${d2.angle}`);
  if (!p2) warnings.push("NO_LAND_PAGE");
  else {
    const xs = tpl.page2.tableX.map((x) => Math.round(x * sx));
    const lines = await horizontalLines(p2.png, xs[0] + 5, xs[xs.length - 1] - 5);
    // Anchor: the table's top rule sits near the page top. If it was not detected (blur / low resolution) the first line found is the
    // header bottom; insert a virtual top so rows are not shifted by one (a row shift would silently attach parcel N+1's data to parcel N).
    if (lines.length && lines[0] > 75 * sy) lines.unshift(Math.round(40 * sy));
    if (lines.length < 3) warnings.push("LAND_TABLE_NOT_FOUND");
    else {
      // lines[0] = header top, lines[1] = header bottom, further lines = row bottoms
      for (let i = 1; i < lines.length - 1; i++) {
        const top = lines[i], bottom = lines[i + 1];
        const rowFields: ExtractedFieldOut[] = [];
        for (let c = 0; c < tpl.page2.columns.length; c++) {
          const col = tpl.page2.columns[c] as any;
          const box: Box = { x: xs[c], y: top, w: xs[c + 1] - xs[c], h: bottom - top };
          rowFields.push(await readField(p2, `land[${i - 1}].${col.key}`, box, col.lang, col.kind, 6, opts, col.whitelist, 2));
        }
        parcels.push({ index: i - 1, fields: rowFields });
      }
    }
  }

  // Cross-field checks (flags only; nothing is auto-corrected)
  const get = (k: string) => fields.find((f) => f.key === k);
  const dob = get("dob"), age = get("age");
  if (dob?.value && age?.value) {
    const calc = new Date().getFullYear() - Number(dob.value.slice(0, 4));
    if (Math.abs(calc - Number(age.value)) > 2) age.errors.push("AGE_DOB_MISMATCH");
  }
  const farmerName = get("name_local")?.value;
  for (const p of parcels) {
    const ow = p.fields.find((f) => f.key.endsWith(".owner_name"));
    if (farmerName && ow?.value && ow.value !== farmerName) ow.errors.push("OWNER_NAME_DIFFERS_FROM_FARMER_NAME");
  }
  return { templateId: tpl.id, fields, parcels, photoJpeg, warnings };
}
