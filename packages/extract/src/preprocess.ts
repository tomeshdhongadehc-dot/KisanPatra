import sharp from "sharp";
import { Box, PageImage } from "./types";

/** Row-profile sharpness of a rotated copy: sum of squared per-row ink sums (peaks when rules/text lines are level).
 *  Ink is weighted (not thresholded) so thin, anti-aliased table rules still count. */
async function levelScore(raw: Buffer, w: number, h: number, angle: number): Promise<number> {
  const { data, info } = await sharp(raw, { raw: { width: w, height: h, channels: 1 } })
    .rotate(angle, { background: "#000000" }).raw().toBuffer({ resolveWithObject: true });
  let score = 0;
  for (let y = 0; y < info.height; y++) {
    let t = 0;
    const row = y * info.width;
    for (let x = 0; x < info.width; x++) t += data[row + x];
    score += (t / 255) * (t / 255);
  }
  return score;
}

/** Estimate page skew in degrees (the angle that sharpens the row profile, in sharp's rotate() convention).
 *  Works on the ink bounding box only, so mostly-white pages (a small table on A4) are not diluted. Coarse-to-fine search. */
export async function estimateSkew(png: Buffer, maxDeg = 3): Promise<number> {
  const g = await sharp(png).grayscale().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = g.info;
  let minx = W, maxx = -1, miny = H, maxy = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (g.data[y * W + x] < 200) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
  if (maxx - minx < 200 || maxy - miny < 40) return 0; // (almost) blank page
  const crop = await sharp(png).grayscale().extract({ left: minx, top: miny, width: maxx - minx + 1, height: maxy - miny + 1 })
    .negate().resize({ width: 1400, withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = crop.info;
  let best = 0, bestScore = await levelScore(crop.data, w, h, 0);
  for (let a = -maxDeg; a <= maxDeg + 1e-9; a += 0.25) {
    const s = await levelScore(crop.data, w, h, a);
    if (s > bestScore) { bestScore = s; best = a; }
  }
  const center = best;
  for (let a = center - 0.25; a <= center + 0.25 + 1e-9; a += 0.05) {
    const s = await levelScore(crop.data, w, h, a);
    if (s > bestScore) { bestScore = s; best = a; }
  }
  return Math.round(best * 100) / 100;
}

/** Level a page (same output size, white fill). Pages already level (|angle| < 0.15°) are returned untouched. */
export async function deskewPage(p: PageImage): Promise<{ page: PageImage; angle: number }> {
  const angle = await estimateSkew(p.png);
  if (Math.abs(angle) < 0.15) return { page: p, angle: 0 };
  const rotated = await sharp(p.png).rotate(angle, { background: "#ffffff" }).toBuffer({ resolveWithObject: true });
  const left = Math.max(0, Math.floor((rotated.info.width - p.width) / 2)), top = Math.max(0, Math.floor((rotated.info.height - p.height) / 2));
  const png = await sharp(rotated.data).extract({ left, top, width: p.width, height: p.height }).png().toBuffer();
  return { page: { ...p, png }, angle };
}

/** Fraction of dark pixels in a (prepared, grayscale-able) crop. Used to recognise truly blank cells. */
export async function inkRatio(img: Buffer): Promise<number> {
  const { data } = await sharp(img).grayscale().raw().toBuffer({ resolveWithObject: true });
  let ink = 0;
  for (let i = 0; i < data.length; i++) if (data[i] < 150) ink++;
  return ink / Math.max(1, data.length);
}

export type { Box };
