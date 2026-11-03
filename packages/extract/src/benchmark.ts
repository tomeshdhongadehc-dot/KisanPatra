// Benchmark: run the extractor over a folder of PDFs with ground truth and report accuracy + review safety.
// Usage: pnpm --filter @agri/extract benchmark -- <dir-with-truth.json> [--out <dir>] [--only form-03,form-04]
// Key safety metric = SILENT ERRORS: wrong values that would NOT be flagged for human review (conf >= threshold and no validation error).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { renderPdf } from "./render";
import { extractFarmerForm } from "./extractor";

const REVIEW_CONF = Number(process.env.REVIEW_CONFIDENCE ?? 0.9); // must match the API default

type Truth = Record<string, { variant: string; parcels: number; fields: Record<string, string | null> }>;
interface Row { form: string; variant: string; key: string; group: string; expected: string | null; got: string | null; exact: boolean; cer: number; flagged: boolean; conf: number | null; errors: string[]; raw: string }

function lev(a: string, b: string) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}
const cer = (e: string | null, g: string | null) => { const a = e ?? "", b = g ?? ""; return a.length === 0 && b.length === 0 ? 0 : lev(a, b) / Math.max(a.length, b.length, 1); };
const group = (k: string) => (k.startsWith("land[") ? "land." + k.replace(/^land\[\d+\]\./, "") : k);
const pct = (n: number, d: number) => (d ? ((100 * n) / d).toFixed(1) + "%" : "-");

async function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith("--"))!;
  const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1] : path.join(dir, "..", "..", ".devdata", "bench");
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
  const truth: Truth = JSON.parse(await readFile(path.join(dir, "truth.json"), "utf8"));
  const opts = { tesseractBin: process.env.TESSERACT_BIN ?? "C:/Program Files/Tesseract-OCR/tesseract.exe", tessdataDir: process.env.TESSDATA_DIR ?? path.resolve(__dirname, "../../../tessdata") };

  const rows: Row[] = [];
  const forms: { form: string; variant: string; ms: number; parcelsExpected: number; parcelsGot: number; failed?: string }[] = [];
  for (const [id, t] of Object.entries(truth)) {
    if (only && !only.includes(id)) continue;
    const t0 = Date.now();
    try {
      const pages = await renderPdf(await readFile(path.join(dir, `${id}.pdf`)));
      const res = await extractFarmerForm(pages, opts);
      const got = new Map(res.fields.concat(res.parcels.flatMap((p) => p.fields)).map((f) => [f.key, f]));
      for (const [key, expected] of Object.entries(t.fields)) {
        const f = got.get(key);
        const value = f?.value ?? null;
        const flagged = !f || f.errors.length > 0 || (f.confidence ?? 0) < REVIEW_CONF;
        rows.push({ form: id, variant: t.variant, key, group: group(key), expected, got: value, exact: (expected ?? null) === value, cer: cer(expected, value), flagged, conf: f?.confidence ?? null, errors: f?.errors ?? ["MISSING_FIELD"], raw: f?.raw ?? "" });
      }
      forms.push({ form: id, variant: t.variant, ms: Date.now() - t0, parcelsExpected: t.parcels, parcelsGot: res.parcels.length });
    } catch (e: any) {
      forms.push({ form: id, variant: t.variant, ms: Date.now() - t0, parcelsExpected: t.parcels, parcelsGot: 0, failed: String(e?.message ?? e) });
    }
    process.stdout.write(`${id} ${t.variant.padEnd(6)} ${((Date.now() - t0) / 1000).toFixed(1)}s ${forms[forms.length - 1].failed ?? ""}\n`);
  }

  const agg = (rs: Row[]) => {
    const n = rs.length, ok = rs.filter((r) => r.exact).length;
    const wrong = rs.filter((r) => !r.exact), silent = wrong.filter((r) => !r.flagged);
    return { n, exact: ok, exactPct: pct(ok, n), cer: n ? +(rs.reduce((a, r) => a + r.cer, 0) / n).toFixed(4) : 0, flagged: rs.filter((r) => r.flagged).length, flaggedPct: pct(rs.filter((r) => r.flagged).length, n), wrong: wrong.length, silent: silent.length, caughtPct: pct(wrong.length - silent.length, wrong.length), unneededFlags: rs.filter((r) => r.flagged && r.exact).length };
  };
  const by = (f: (r: Row) => string) => { const m = new Map<string, Row[]>(); rows.forEach((r) => m.set(f(r), [...(m.get(f(r)) ?? []), r])); return [...m].map(([k, v]) => ({ k, ...agg(v) })).sort((a, b) => a.exact / a.n - b.exact / b.n); };

  const overall = agg(rows), perField = by((r) => r.group), perVariant = by((r) => r.variant);
  const silentList = rows.filter((r) => !r.exact && !r.flagged);
  const wrongList = rows.filter((r) => !r.exact);
  const rowMismatch = forms.filter((f) => !f.failed && f.parcelsExpected !== f.parcelsGot);

  const L: string[] = [];
  L.push(`# Extraction benchmark (${forms.length} forms, ${rows.length} fields, review threshold ${REVIEW_CONF})`, "");
  L.push(`- Exact match: **${overall.exactPct}** (${overall.exact}/${overall.n}); mean CER ${overall.cer}`);
  L.push(`- Wrong values: ${overall.wrong}; caught by review flag: ${overall.caughtPct}; **SILENT errors: ${overall.silent}**`);
  L.push(`- Review burden: ${overall.flaggedPct} of fields flagged; ${overall.unneededFlags} flags were on correct values`);
  L.push(`- Forms failed to process: ${forms.filter((f) => f.failed).length}; parcel-row count mismatches: ${rowMismatch.length}; mean time ${(forms.reduce((a, f) => a + f.ms, 0) / Math.max(forms.length, 1) / 1000).toFixed(1)}s/form`, "");
  const tbl = (title: string, rs: ReturnType<typeof by>) => { L.push(`## ${title}`, "| group | n | exact | CER | wrong | silent | flagged |", "|---|---|---|---|---|---|---|"); rs.forEach((r) => L.push(`| ${r.k} | ${r.n} | ${r.exactPct} | ${r.cer} | ${r.wrong} | ${r.silent} | ${r.flaggedPct} |`)); L.push(""); };
  tbl("By variant", perVariant); tbl("By field (worst first)", perField);
  // Calibration: how often is a value wrong within each OCR-confidence band (rows without validation errors only)?
  const bands: [string, number, number][] = [["<0.50", -1, 0.5], ["0.50-0.70", 0.5, 0.7], ["0.70-0.80", 0.7, 0.8], ["0.80-0.90", 0.8, 0.9], ["0.90-0.95", 0.9, 0.95], ["0.95-0.98", 0.95, 0.98], [">=0.98", 0.98, 2]];
  L.push("## Confidence calibration (rows with no validation error)", "| conf band | n | wrong | wrong % |", "|---|---|---|---|");
  for (const [name, lo, hi] of bands) { const rs = rows.filter((r) => r.errors.length === 0 && (r.conf ?? -1) >= lo && (r.conf ?? -1) < hi && r.conf !== null); L.push(`| ${name} | ${rs.length} | ${rs.filter((r) => !r.exact).length} | ${pct(rs.filter((r) => !r.exact).length, rs.length)} |`); }
  L.push("");
  // Why are CORRECT values flagged? (guides where the review burden can safely shrink)
  const reason = (r: Row) => (r.errors.length ? r.errors.join("+") : "low-conf");
  const why = new Map<string, Map<string, number>>();
  rows.filter((r) => r.flagged && r.exact).forEach((r) => { const m = why.get(r.group) ?? new Map(); m.set(reason(r), (m.get(reason(r)) ?? 0) + 1); why.set(r.group, m); });
  L.push("## Why correct values were flagged (per field)", "| field | flagged-but-correct | reasons |", "|---|---|---|");
  [...why].sort((x, y) => [...y[1].values()].reduce((a, b) => a + b, 0) - [...x[1].values()].reduce((a, b) => a + b, 0))
    .forEach(([k, m]) => L.push(`| ${k} | ${[...m.values()].reduce((a, b) => a + b, 0)} | ${[...m].map(([r, n]) => `${r}:${n}`).join(", ")} |`));
  L.push("");
  // Threshold sweep: what would a lower confidence threshold cost? (rows with no validation error only; errors always flag)
  L.push("## Confidence threshold sweep (validation errors always flag)", "| threshold | flagged % | silent errors |", "|---|---|---|");
  for (const th of [0.95, 0.93, 0.9, 0.85, 0.8]) {
    const fl = rows.filter((r) => r.errors.length > 0 || (r.conf ?? 0) < th), sil = rows.filter((r) => !r.exact && !(r.errors.length > 0 || (r.conf ?? 0) < th));
    L.push(`| ${th} | ${pct(fl.length, rows.length)} | ${sil.length} |`);
  }
  L.push("");
  if (forms.some((f) => f.failed)) { L.push("## Failed forms", ...forms.filter((f) => f.failed).map((f) => `- ${f.form} (${f.variant}): ${f.failed}`), ""); }
  if (rowMismatch.length) { L.push("## Parcel row count mismatches", ...rowMismatch.map((f) => `- ${f.form} (${f.variant}): expected ${f.parcelsExpected}, got ${f.parcelsGot}`), ""); }
  const show = (r: Row) => `- ${r.form} [${r.variant}] ${r.key}: expected \`${r.expected}\` got \`${r.got}\` (raw \`${r.raw}\`, conf ${r.conf}, ${r.flagged ? "FLAGGED " + r.errors.join(",") : "NOT FLAGGED"})`;
  L.push(`## SILENT errors (${silentList.length})`, ...silentList.slice(0, 80).map(show), "");
  L.push(`## All wrong values (${wrongList.length}, first 120)`, ...wrongList.slice(0, 120).map(show), "");

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "report.md"), L.join("\n"));
  await writeFile(path.join(outDir, "report.json"), JSON.stringify({ overall, perVariant, perField, forms, silent: silentList }, null, 1));
  console.log("\n" + L.slice(0, 6).join("\n"));
  console.log(`\nreport: ${path.join(outDir, "report.md")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
