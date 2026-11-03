// Usage: pnpm --filter @agri/extract bench -- <pdf> [--save-photo out.jpg]
// Runs the local-OCR pipeline on one PDF and prints the extracted fields. Output contains personal data: do not paste/commit it.
import { readFile, writeFile } from "node:fs/promises";
import { renderPdf } from "./render";
import { extractFarmerForm } from "./extractor";

async function main() {
  const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!file) throw new Error("pass a PDF path");
  const opts = {
    tesseractBin: process.env.TESSERACT_BIN ?? "C:/Program Files/Tesseract-OCR/tesseract.exe",
    tessdataDir: process.env.TESSDATA_DIR ?? "../../tessdata",
  };
  const t0 = Date.now();
  const pages = await renderPdf(await readFile(file));
  const res = await extractFarmerForm(pages, opts);
  for (const f of res.fields) console.log(`${f.key.padEnd(24)} ${String(f.value).padEnd(40)} conf=${f.confidence} ${f.errors.join(",")}  [raw: ${f.raw}]`);
  for (const p of res.parcels) for (const f of p.fields) console.log(`${f.key.padEnd(34)} ${String(f.value).padEnd(24)} conf=${f.confidence} ${f.errors.join(",")}  [raw: ${f.raw}]`);
  console.log("warnings:", res.warnings, `time=${Date.now() - t0}ms`);
  const i = process.argv.indexOf("--save-photo");
  if (i > 0 && res.photoJpeg) await writeFile(process.argv[i + 1], res.photoJpeg);
}
main().catch((e) => { console.error(e); process.exit(1); });
