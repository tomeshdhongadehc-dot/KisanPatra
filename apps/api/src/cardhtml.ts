// Card template (HTML/CSS) following docs/CARD_SPEC.md. Rendered by headless Chrome so Devanagari shapes correctly.
// Own branding only: no AgriStack / government marks.
export interface CardData {
  platformId: string; nameLocal: string; nameEn: string; dob: string; gender: string; mobile: string;
  trustLabelMr: string; trustLabelEn: string; issuedOn: string; version: number;
  addressLocal: string; addressEn: string; photoDataUrl: string | null; qrDataUrl: string;
  parcels: Array<{ survey: string; village: string; taluka: string; district: string }>; parcelCount: number;
}
import fs from "node:fs";
import path from "node:path";

// Bundled Noto fonts (SIL OFL 1.1) embedded as data URIs: Devanagari shaping and glyph coverage must not depend on the machine's fonts.
let fontCache: string | null = null;
function fontFaces(): string {
  if (fontCache) return fontCache;
  const dir = path.resolve(__dirname, "..", "assets", "fonts");
  const face = (family: string, file: string, weight: number) =>
    `@font-face{font-family:"${family}";font-weight:${weight};src:url(data:font/ttf;base64,${fs.readFileSync(path.join(dir, file)).toString("base64")}) format("truetype")}`;
  fontCache = [face("Noto Sans Devanagari", "NotoSansDevanagari-Regular.ttf", 400), face("Noto Sans Devanagari", "NotoSansDevanagari-Bold.ttf", 700), face("Noto Sans", "NotoSans-Regular.ttf", 400), face("Noto Sans", "NotoSans-Bold.ttf", 700)].join("\n");
  return fontCache;
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const GENDER_MR: Record<string, string> = { MALE: "पुरुष", FEMALE: "महिला", OTHER: "इतर" };

const CSS = `
@page { size: 85.6mm 54mm; margin: 0 }
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Noto Sans Devanagari","Noto Sans","Nirmala UI",sans-serif;font-weight:400;background:#fff;color:#111}
.card{width:85.6mm;height:54mm;position:relative;overflow:hidden;background:#f3f6f4;border:.3mm solid #1c3d2e;page-break-after:always}
.hdr{height:7.4mm;background:#14284b;color:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 2.2mm}
.hdr .logo{font-weight:700;font-size:2.6mm;letter-spacing:.2mm}
.hdr .title{font-size:3mm;font-weight:700}
.body{display:flex;padding:1.6mm 2.2mm;gap:2mm}
.photo{width:16mm;height:20mm;border:.25mm solid #888;background:#e3e3e3;object-fit:cover;flex:none}
.col{flex:1;min-width:0;font-size:2.35mm;line-height:1.28}
.nm-mr{font-size:3mm;font-weight:700}.nm-en{font-size:2.3mm;font-weight:600;margin-bottom:.6mm}
.k{color:#333}.v{font-weight:600}
.qr{width:24mm;height:24mm;flex:none} /* module size drives scannability: 24 mm decodes at 100 dpi+blur where 20 mm does not */
.ftr{position:absolute;left:0;right:0;bottom:7.2mm;height:5.2mm;background:#0f5a2b;color:#fff;display:flex;justify-content:space-between;align-items:center;padding:0 2.2mm;font-size:2.5mm;font-weight:700}
.disc{position:absolute;left:2.2mm;right:2.2mm;bottom:1mm;font-size:1.65mm;line-height:1.2;color:#333}
.trust{position:absolute;left:2.2mm;top:31.6mm;font-size:1.7mm;background:#fff;border:.2mm solid #0f5a2b;color:#0f5a2b;padding:.2mm 1mm;border-radius:1mm}
.panel{margin:1.6mm 2.2mm;border:.25mm solid #999;border-radius:1.6mm;padding:1.4mm 1.8mm;font-size:2.15mm;background:#fff;height:43mm}
.panel h4{font-size:2.3mm;margin:.6mm 0 .4mm}
table{width:100%;border-collapse:collapse;font-size:2mm}th{text-align:left;font-weight:600;color:#444}td{font-weight:600;padding:.2mm 0}
.warn{font-size:1.75mm;color:#7a2d00;margin-top:.8mm}
`;

function faces(d: CardData): { front: string; back: string } {
  const photo = d.photoDataUrl ? `<img class="photo" src="${d.photoDataUrl}">` : `<div class="photo"></div>`;
  const rows = d.parcels.map((p) => `<tr><td>${esc(p.survey)}</td><td>${esc(p.village)}</td><td>${esc(p.taluka)}</td><td>${esc(p.district)}</td></tr>`).join("");
  const more = d.parcelCount > d.parcels.length ? `<div class="warn">+${d.parcelCount - d.parcels.length} अधिक / more — पहा डिजिटल नोंद / see digital record</div>` : "";
  const front = `<div class="card" id="front">
  <div class="hdr"><span class="logo">AGRI·CARD</span><span class="title">शेतकरी ओळखपत्र / Farmer Identity Card</span></div>
  <div class="trust">${esc(d.trustLabelMr)} / ${esc(d.trustLabelEn)}</div>
  <div class="body">
    ${photo}
    <div class="col">
      <div class="nm-mr">नाव : ${esc(d.nameLocal)}</div>
      <div class="nm-en">${esc(d.nameEn)}</div>
      <div><span class="k">जन्म दिनांक / DOB : </span><span class="v">${esc(d.dob)}</span></div>
      <div><span class="k">लिंग / Gender : </span><span class="v">${esc(GENDER_MR[d.gender] ?? "")} / ${esc(d.gender[0] + d.gender.slice(1).toLowerCase())}</span></div>
      <div><span class="k">मोबाईल / Mobile : </span><span class="v">${esc(d.mobile)}</span></div>
    </div>
    <img class="qr" src="${d.qrDataUrl}">
  </div>
  <div class="ftr"><span>प्लॅटफॉर्म फार्मर आयडी / Platform Farmer ID</span><span>${esc(d.platformId)}</span></div>
  <div class="disc">हे कार्ड प्लॅटफॉर्मने तयार केलेले असून सरकारी ओळखपत्र नाही. Platform-generated card. Not a government identity document.</div>
</div>`;
  const back = `<div class="card" id="back">
  <div class="hdr"><span class="logo">AGRI·CARD</span><span class="title">${esc(d.platformId)} · v${d.version}</span></div>
  <div class="panel">
    <h4>संपूर्ण पत्ता / Address</h4>
    <div>${esc(d.addressLocal)}</div><div>${esc(d.addressEn)}</div>
    <h4>संबंधित जमीन / Associated land (not proof of ownership)</h4>
    <table><tr><th>गट/Survey No.</th><th>गाव/Village</th><th>तालुका</th><th>जिल्हा</th></tr>${rows}</table>${more}
    <div class="warn">जारी दिनांक / Issued: ${esc(d.issuedOn)} — QR स्कॅन करून तपासा / Scan QR to verify card status. Land shown is associated, not proof of ownership.</div>
  </div>
</div>`;
  return { front, back };
}

const page = (css: string, inner: string) => `<!doctype html><html><head><meta charset="utf-8"><style>${fontFaces()}
${CSS}
${css}</style></head><body>
${inner}
</body></html>`;

/** Single card, 85.6x54 mm, two pages (front, back): PVC printing and the on-screen PNG. */
export function cardHtml(d: CardData): string {
  const f = faces(d);
  return page("", f.front + "\n" + f.back);
}

/** A4 portrait sheet at true size: front and back with crop marks, a 50 mm scale bar and print instructions. */
export function sheetHtml(d: CardData): string {
  const f = faces(d);
  const css = `
@page { size: 210mm 297mm; margin: 0 }
body{width:210mm;height:297mm;position:relative}
.card{page-break-after:auto;border:none;position:absolute;left:0;top:0}
.slot{position:absolute;width:85.6mm;height:54mm}
.slot .lbl{position:absolute;left:8mm;top:-6.2mm;font-size:2.6mm;color:#555}
.mk{position:absolute;background:#000}
.h{height:.2mm;width:4mm}.v{width:.2mm;height:4mm}
.note{position:absolute;left:20mm;right:20mm;font-size:2.8mm;line-height:1.5;color:#222}
.bar{position:absolute;height:2mm;border:.25mm solid #000;border-top:none;border-bottom:none;background:linear-gradient(#000,#000) center/100% .25mm no-repeat}
`;
  const SLOTS = [{ x: 62.2, y: 30, label: "समोर / Front", html: f.front }, { x: 62.2, y: 110, label: "मागे / Back", html: f.back }];
  const marks = (x: number, y: number) => {
    const W = 85.6, H = 54, g = 1.5, L = 4, out: string[] = [];
    for (const [cx, cy] of [[x, y], [x + W, y], [x, y + H], [x + W, y + H]]) {
      const left = cx === x;
      const top = cy === y;
      out.push(`<div class="mk h" style="left:${left ? cx - g - L : cx + g}mm;top:${cy}mm"></div><div class="mk v" style="left:${cx}mm;top:${top ? cy - g - L : cy + g}mm"></div>`);
    }
    return out.join("");
  };
  const slots = SLOTS.map((s) => `<div class="slot" style="left:${s.x}mm;top:${s.y}mm"><div class="lbl">${s.label}</div>${s.html.replace('class="card"', 'class="card" style="position:relative"')}</div>${marks(s.x, s.y)}`).join("\n");
  const inner = `${slots}
<div class="bar" style="left:80mm;top:195mm;width:50mm"></div>
<div class="note" style="top:199mm;text-align:center">↑ ही रेषा ५० मिमी असावी / This bar must measure exactly 50 mm — otherwise print again at <b>100% / Actual size</b> (no “fit to page”).</div>
<div class="note" style="top:215mm">
 <b>छापणे / How to print</b><br>१. A4, 100% / Actual size, रंगीत. · 1. A4, 100% / Actual size, colour.<br>
 २. कोपऱ्यातील खुणांवर कापा; समोर व मागे पाठीला पाठ जोडा. · 2. Cut on the corner marks; fold or glue front and back together.<br>
 ३. QR स्कॅन होतो का तपासा. · 3. Check that the QR scans with a phone.<br>
 <span style="color:#7a2d00">हे कार्ड प्लॅटफॉर्मने तयार केलेले असून सरकारी ओळखपत्र किंवा जमीन मालकीचा पुरावा नाही. · Platform-generated; not a government ID or proof of land ownership.</span>
</div>`;
  return page(css, inner);
}
