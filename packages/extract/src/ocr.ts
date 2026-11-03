import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { Box, ExtractorOptions } from "./types";

const execFileAsync = promisify(execFile);

export interface OcrResult { text: string; confidence: number | null }

export async function cropForOcr(page: Buffer, box: Box, inset = 3, upscale = 2): Promise<Buffer> {
  return sharp(page)
    .extract({ left: Math.max(0, box.x + inset), top: Math.max(0, box.y + inset), width: Math.max(1, box.w - 2 * inset), height: Math.max(1, box.h - 2 * inset) })
    .grayscale().normalise().resize({ width: Math.round((box.w - 2 * inset) * upscale), kernel: "lanczos3" })
    .extend({ top: 12, bottom: 12, left: 12, right: 12, background: "#ffffff" })
    .png().toBuffer();
}

/** OCR one prepared image via the Tesseract CLI (local; data never leaves the machine). */
export async function ocr(img: Buffer, lang: string, psm: 6 | 7, opts: ExtractorOptions, whitelist?: string): Promise<OcrResult> {
  const dir = await mkdtemp(join(tmpdir(), "agri-ocr-"));
  try {
    const file = join(dir, "in.png");
    await writeFile(file, img);
    const args = [file, "stdout", "--tessdata-dir", opts.tessdataDir, "-l", lang, "--psm", String(psm)];
    if (whitelist) args.push("-c", `tessedit_char_whitelist=${whitelist}`);
    args.push("tsv");
    const { stdout } = await execFileAsync(opts.tesseractBin, args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    const words: string[] = [];
    const confs: number[] = [];
    let lastLine = "";
    for (const line of stdout.split(/\r?\n/).slice(1)) {
      const c = line.split("\t");
      if (c.length < 12 || c[0] !== "5") continue;
      const text = c[11].trim();
      if (!text) continue;
      const lineKey = `${c[2]}-${c[3]}-${c[4]}`;
      if (lastLine && lineKey !== lastLine) words.push("\n");
      lastLine = lineKey;
      words.push(text);
      const conf = Number(c[10]);
      if (conf >= 0) confs.push(conf);
    }
    const text = words.join(" ").replace(/ ?\n ?/g, "\n").trim();
    return { text, confidence: confs.length ? Math.round(confs.reduce((a, b) => a + b, 0) / confs.length) / 100 : null };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
