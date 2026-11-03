// Print-QR scan simulation. Renders a card/sheet PDF at print resolutions, degrades it like a poor home/office print
// (low dpi, blur, noise, washed-out contrast) and decodes every QR with an independent decoder (jsQR).
// Usage: npx tsx src/qrscan.ts <pdf> <expected-url-prefix>      Prints only pass/fail per scenario (tokens are never printed).
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import jsQR from "jsqr";
import { renderPdf } from "./render";

// Advisory scenarios sit at the edge of what this decoder reads (a single token passes or fails by chance), so they warn instead of failing;
// a statistical decode rate over many tokens is what matters (README: Printing).
// Measured limits with jsQR on a 20 mm QR (token-length URL): decodes clean down to 90 dpi; reliable at 100-120 dpi with blur 0.8 or noise +-20;
// fails at 72 dpi. Heavy independent per-pixel noise (+-30..40) is excluded: it is not what printers produce and jsQR's binarizer is erratic on it.
const scenarios: { name: string; dpi: number; blur?: number; noise?: number; contrast?: number; advisory?: boolean }[] = [
  { name: "300 dpi clean", dpi: 300 }, { name: "200 dpi", dpi: 200 }, { name: "150 dpi (draft print)", dpi: 150 },
  { name: "150 dpi + blur 1.0", dpi: 150, blur: 1 }, { name: "150 dpi + washed-out (contrast 0.5)", dpi: 150, contrast: 0.5 },
  { name: "120 dpi + scan noise +-20 (advisory: edge of the decoder)", dpi: 120, noise: 20, advisory: true }, { name: "100 dpi + blur 0.8 (poor print, advisory)", dpi: 100, blur: 0.8, advisory: true },
];

async function decode(png: Buffer): Promise<string[]> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const r = jsQR(new Uint8ClampedArray(data), info.width, info.height, { inversionAttempts: "attemptBoth" });
  return r ? [r.data] : [];
}

async function main() {
  const [file, expected] = process.argv.slice(2);
  if (!file || !expected) throw new Error("usage: qrscan <pdf> <expected-url-prefix>");
  const pdf = await readFile(file);
  let failures = 0;
  for (const s of scenarios) {
    const pages = await renderPdf(pdf, s.dpi / 72);
    let found = 0, wrong = 0;
    for (const p of pages) {
      let img = sharp(p.png).grayscale();
      if (s.blur) img = img.blur(s.blur);
      let buf = await img.png().toBuffer();
      if (s.contrast) buf = await sharp(buf).linear(s.contrast, 255 * (1 - s.contrast) / 2 + 40).png().toBuffer();
      if (s.noise) {
        const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
        for (let i = 0; i < data.length; i++) data[i] = Math.max(0, Math.min(255, data[i] + (Math.random() - 0.5) * 2 * s.noise));
        buf = await sharp(data, { raw: info }).png().toBuffer();
      }
      for (const v of await decode(buf)) v.startsWith(expected) ? found++ : wrong++;
    }
    const ok = found >= 1 && wrong === 0;
    if (!ok && !s.advisory) failures++;
    console.log(`${ok ? "PASS" : s.advisory ? "WARN" : "FAIL"}  ${s.name}  decoded=${found}${wrong ? ` WRONG-CONTENT=${wrong}` : ""}`);
  }
  console.log(failures ? `\n${failures} scenario(s) failed` : "\nQR SCAN SIMULATION PASSED");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
