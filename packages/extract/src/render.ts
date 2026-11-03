import sharp from "sharp";
import { PageImage } from "./types";

export const MAX_PAGES = 10;

/** Render PDF pages to PNG. Throws on corrupt/encrypted input. Callers must run this in an isolated worker with time/memory limits. */
export async function renderPdf(pdf: Buffer, scale = 2.4): Promise<PageImage[]> {
  const mupdf: any = await import("mupdf"); // ESM-only package, loaded dynamically
  if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("NOT_A_PDF");
  const doc = mupdf.Document.openDocument(pdf, "application/pdf");
  if (doc.needsPassword()) throw new Error("ENCRYPTED_PDF");
  const count = doc.countPages();
  if (count > MAX_PAGES) throw new Error("TOO_MANY_PAGES");
  const out: PageImage[] = [];
  for (let i = 0; i < count; i++) {
    const page = doc.loadPage(i);
    const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
    const png = Buffer.from(pix.asPNG());
    const meta = await sharp(png).metadata();
    out.push({ pageNo: i + 1, png, width: meta.width!, height: meta.height! });
  }
  return out;
}
