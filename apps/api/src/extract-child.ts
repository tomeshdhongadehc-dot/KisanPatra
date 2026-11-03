// Sandboxed extraction child. Spawned per job by the queue with a scrubbed environment:
// it has NO database access, NO encryption keys and NO network use. Input: <dir>/in.pdf. Output: <dir>/out/*.
// Exit 0 = ok. Exit 2 = deterministic failure (code in out/error.txt; retrying will not help). Anything else = crash/timeout (retryable).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractFarmerForm, renderPdf, classify } from "@agri/extract";

const SKIP_PAGES = new Set([3, 4]); // Aadhaar consent pages: never written out

async function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error("NO_DIR");
  const out = path.join(dir, "out");
  await mkdir(out, { recursive: true });
  try {
    const pages = await renderPdf(await readFile(path.join(dir, "in.pdf")));
    if (classify(pages) !== "AGRISTACK_FARMER_REG_FORM") throw new Error("UNSUPPORTED_LAYOUT");
    const res = await extractFarmerForm(pages, {
      tesseractBin: process.env.TESSERACT_BIN ?? "tesseract",
      tessdataDir: process.env.TESSDATA_DIR ?? "./tessdata",
    });
    const pageMeta: { pageNo: number; width: number; height: number; file: string }[] = [];
    for (const p of pages) {
      if (SKIP_PAGES.has(p.pageNo)) continue;
      const file = `page-${p.pageNo}.png`;
      await writeFile(path.join(out, file), p.png);
      pageMeta.push({ pageNo: p.pageNo, width: p.width, height: p.height, file });
    }
    if (res.photoJpeg) await writeFile(path.join(out, "photo.jpg"), res.photoJpeg);
    await writeFile(path.join(out, "result.json"), JSON.stringify({ templateId: res.templateId, fields: res.fields, parcels: res.parcels, warnings: res.warnings, pageCount: pages.length, pages: pageMeta, hasPhoto: !!res.photoJpeg }));
  } catch (e: any) {
    const code = /^[A-Z_]{3,40}$/.test(String(e?.message)) ? String(e.message) : "EXTRACTION_ERROR"; // codes only, never document content
    await writeFile(path.join(out, "error.txt"), code);
    process.exit(2);
  }
}
main().catch(() => process.exit(1));
