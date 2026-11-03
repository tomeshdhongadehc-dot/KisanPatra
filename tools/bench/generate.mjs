// Synthetic "Farmer Registration Form" generator with ground truth, for benchmarking extraction.
// Reproduces the REAL form's layout coordinates (taken from the supplied sample) but fills it with fabricated people.
// It therefore tests content variation (names, scripts, multi-parcel tables, wrapping) and scan degradation,
// NOT layout drift between real-world form versions. Real redacted forms are still needed for that.
// Usage: node tools/bench/generate.mjs [count=36] [seed=7]   -> samples/synthetic/{form-XX.pdf, truth.json}
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const reqApi = createRequire(path.join(root, "apps/api/package.json"));
const reqExt = createRequire(path.join(root, "packages/extract/package.json"));
const { chromium } = reqApi("playwright-core");
const sharp = reqExt("sharp");

const COUNT = Number(process.argv[2] ?? 36), SEED = Number(process.argv[3] ?? 7);
const OUT = path.join(root, "samples/synthetic");
const W = 1286, H = 909, SCALE = 2668 / W;

// ---------- deterministic RNG ----------
let s = SEED >>> 0;
const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

// ---------- data pools (fabricated) ----------
const MALE = [["Ramesh", "रमेश"], ["Suresh", "सुरेश"], ["Ganesh", "गणेश"], ["Prakash", "प्रकाश"], ["Vijay", "विजय"], ["Sanjay", "संजय"], ["Anil", "अनिल"], ["Dinesh", "दिनेश"], ["Mahesh", "महेश"], ["Santosh", "संतोष"], ["Arun", "अरुण"], ["Shankar", "शंकर"], ["Nitin", "नितीन"], ["Rahul", "राहुल"], ["Bhaskar", "भास्कर"]];
const FEMALE = [["Sunita", "सुनीता"], ["Anita", "अनिता"], ["Vandana", "वंदना"], ["Rekha", "रेखा"], ["Kavita", "कविता"], ["Laxmi", "लक्ष्मी"], ["Shobha", "शोभा"], ["Pratibha", "प्रतिभा"]];
const SUR = [["Patil", "पाटील"], ["Pawar", "पवार"], ["Jadhav", "जाधव"], ["Shinde", "शिंदे"], ["Kale", "काळे"], ["Deshmukh", "देशमुख"], ["Gaikwad", "गायकवाड"], ["Chavan", "चव्हाण"], ["More", "मोरे"], ["Bhosale", "भोसले"], ["Wankhede", "वानखेडे"], ["Rathod", "राठोड"], ["Pathan", "पठाण"], ["Sheikh", "शेख"], ["Meshram", "मेश्राम"]];
const DISTRICTS = ["YAVATMAL", "AMRAVATI", "NAGPUR", "WARDHA", "CHANDRAPUR", "AKOLA", "BULDHANA", "NASHIK", "PUNE", "SATARA", "LATUR", "NANDED", "JALGAON", "AHMEDNAGAR", "SOLAPUR"];
const TALUKAS = ["Arni", "Pusad", "Digras", "Umarkhed", "Wani", "Kelapur", "Ralegaon", "Babhulgaon", "Mahagaon", "Daryapur", "Morshi", "Katol"];
const VILLAGES = ["Borgaon", "Nandgaon", "Wadgaon", "Kharda", "Pimpalgaon", "Sonala", "Kopargaon", "Ambegaon", "Rajura", "Malkapur", "Dhamangaon", "Lonar", "Mohadi", "Shivni", "Ghatanji", "Nava Gaon", "Mota Pimpri", "Lahan Wadgaon"];
const LANDMARK = [["Near Shiv Mandir", "शिव मंदिर के पास"], ["Behind Gram Panchayat", "ग्राम पंचायत के पीछे"], ["Near Bus Stand", "बस स्टैंड के पास"], ["Main Road", "मुख्य रस्ता"], ["Near Zilla Parishad School", "जिल्हा परिषद शाळेजवळ"], ["Opposite Water Tank", "पाण्याच्या टाकीसमोर"]];
const PLACE = [["Shivaji Nagar", "शिवाजी नगर"], ["Ambedkar Nagar", "आंबेडकर नगर"], ["Gandhi Chowk", "गांधी चौक"], ["Tilak Nagar", "टिळक नगर"], ["Rajiv Gandhi Colony", "राजीव गांधी कॉलनी"], ["Station Road", "स्टेशन रोड"]];
const CASTE = ["General", "OBC", "SC", "ST", "VJNT"];
const OCC = ["AgricultureLand owning Farmer", "Agriculture Tenant Farmer", "Agriculture Farmer"];

// ---------- record generator ----------
function makePerson() {
  const female = rnd() < 0.3;
  const [fe, fm] = pick(female ? FEMALE : MALE), [me, mm] = pick(MALE), [se, sm] = pick(SUR);
  const [fe2, fm2] = pick(MALE);
  const y = int(1950, 2003), mo = int(1, 12), d = int(1, 28);
  const dobShown = `${String(d).padStart(2, "0")}/${String(mo).padStart(2, "0")}/${y}`;
  const age = 2026 - y; // forms in the wild carry an age computed at generation time; the extractor only flags >2y disagreement
  const [lm, lml] = pick(LANDMARK), [pl, pll] = pick(PLACE), hn = int(1, 240);
  const mobile = `${pick([6, 7, 8, 9])}${String(int(0, 999999999)).padStart(9, "0")}`;
  const email = rnd() < 0.8 ? `${fe}.${se}${int(1, 99)}@${pick(["gmail.com", "yahoo.in", "outlook.com"])}`.toLowerCase() : "";
  const tenant = rnd() < 0.15;
  const nParcels = pick([1, 1, 1, 1, 2, 2, 3, 4, 5]);
  const district = pick(DISTRICTS);
  const parcels = Array.from({ length: nParcels }, (_, i) => {
    const sameOwner = rnd() < 0.7;
    const ownerLocal = sameOwner ? `${fm} ${mm} ${sm}` : `${fm} ${sm}`;
    return {
      state: "MAHARASHTRA", district, sub_district: pick(TALUKAS), village: pick(VILLAGES), survey_no: String(int(1, 999)),
      sub_survey_no: rnd() < 0.7 ? null : String(int(1, 9)), owner_name: ownerLocal, identifier_name: `${mm} ${sm}`,
      owner_type: pick(["Single", "Single", "Joint"]), share_type: pick(["Single", "Single", "Joint"]),
      area_total: (rnd() * 9 + 0.1).toFixed(6), area_assigned: null,
    };
  });
  parcels.forEach((p) => { p.area_assigned = p.area_total; });
  return {
    enrollment_number: `27_${int(100, 999)}_${int(1000, 9999)}_${int(100000, 999999)}_${String(int(1, 999999)).padStart(6, "0")}`,
    farmer_id: String(int(10000000000, 99999999999)),
    name_en: `${fe} ${me} ${se}`, name_local: `${fm} ${mm} ${sm}`, gender: female ? "FEMALE" : "MALE", genderShown: female ? "Female" : "Male",
    caste_category: pick(CASTE), dob: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`, dobShown, age: String(age),
    identifier_name_en: `${fe2} ${se}`, identifier_name_local: `${fm2} ${sm}`,
    mobile, email: email || null, address_en: `${hn} ,${lm} ,${pl}`, address_local: `${hn}, ${lml}, ${pll}`,
    farmer_type: tenant ? "Tenant" : "Owner", occupation: tenant ? OCC[1] : pick([OCC[0], OCC[0], OCC[2]]), parcels,
  };
}

// ---------- HTML for each page (absolute layout in the real form's coordinate space) ----------
const FONT = `font-family:"Roboto","Segoe UI",Arial,"Nirmala UI","Mangal",sans-serif`;
const CSS = `*{margin:0;padding:0;box-sizing:border-box}html,body{width:${W}px;height:${H}px;background:#fff}body{position:relative;${FONT};font-size:15px;color:#555}
.a{position:absolute;white-space:nowrap}.l{font-weight:700;color:#222}.bar{position:absolute;left:74px;width:1138px;height:30px;background:#4a4a4a;color:#fff;font-weight:700;font-size:17px;text-align:center;line-height:30px}
.c{position:absolute;border:1.5px solid #222;height:30px}.t{font-size:30px;font-weight:700;color:#444;text-align:center;width:${W}px;top:50px;position:absolute}
table{position:absolute;left:75px;top:40px;border-collapse:collapse;table-layout:fixed;font-size:14px}td,th{border:1.5px solid #222;padding:6px 8px;word-break:break-all;vertical-align:top;color:#555;line-height:1.35}th{color:#222;font-weight:700;text-align:left;height:65px}
.d{font-size:14.5px;line-height:1.5;color:#444;position:absolute;left:74px;width:1130px}`;

function cell(x, y, w, h = 30) { return `<div class="c" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px"></div>`; }
function lab(x, y, t, cls = "l") { return `<div class="a ${cls}" style="left:${x}px;top:${y}px;line-height:30px">${t}</div>`; }
function val(x, y, t) { return t ? `<div class="a" style="left:${x}px;top:${y}px;line-height:30px">${t}</div>` : ""; }
const esc = (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;");

function page1(r, photoUrl) {
  let h = `<div class="t">Farmer Registration Form</div><div class="a" style="left:74px;top:101px;width:1138px;height:1.5px;background:#222"></div>`;
  h += `<div class="a l" style="left:74px;top:113px">Farmer enrollment number:</div><div class="a" style="left:74px;top:144px">${esc(r.enrollment_number)}</div>`;
  h += `<div class="a l" style="left:74px;top:166px">Farmer ID:</div><div class="a" style="left:74px;top:197px">${r.farmer_id}</div>`;
  h += `<div class="a l" style="right:${W - 1212}px;top:113px">Farmer Photograph</div><img src="${photoUrl}" style="position:absolute;left:1135px;top:141px;width:77px;height:97px;object-fit:cover">`;
  h += `<div class="bar" style="top:243px">Farmer Details</div>`;
  h += cell(74, 279, 619) + cell(693, 279, 519) + cell(74, 308, 231) + cell(305, 308, 388) + cell(693, 308, 375) + cell(1068, 308, 144) + cell(74, 338, 619) + cell(693, 338, 519);
  h += lab(83, 279, "Farmer Name as per Aadhaar in English") + val(366, 279, esc(r.name_en)) + lab(702, 279, "Farmer’s Name in Local Language") + val(945, 279, esc(r.name_local));
  h += lab(83, 308, "Gender") + val(143, 308, r.genderShown) + lab(314, 308, "Caste Category") + val(430, 308, r.caste_category) + lab(702, 308, "Date of Birth") + val(799, 308, r.dobShown) + lab(1077, 308, "Age") + val(1119, 308, r.age);
  h += lab(83, 338, "Identifier Name In English") + val(272, 338, esc(r.identifier_name_en)) + lab(702, 338, "Identifier Name in Local Language") + val(949, 338, esc(r.identifier_name_local));
  h += `<div class="bar" style="top:384px">Contact Details</div>` + cell(74, 420, 478) + cell(552, 420, 660);
  h += lab(83, 420, "Mobile Number") + val(199, 420, r.mobile) + lab(561, 420, "Email Address") + val(671, 420, esc(r.email ?? ""));
  h += `<div class="bar" style="top:465px">Farmer Bank &amp; Additional Details</div>`;
  const left = ["Farmer Caste Certificate Number/ID", "Minority Religion", "Kisan Credit Card Amount", "Bank Name", "IFSC Code"], right = ["Farmer Pan Number", "Kisan Credit Card Number (KCC)", "Kisan Credit Card Bank Name", "Bank Branch Code", "Bank Account Number"];
  left.forEach((t, i) => { const y = 501 + i * 30; h += cell(74, y, 595) + cell(669, y, 543) + lab(83, y, t) + lab(678, y, right[i]); });
  h += cell(74, 651, 1138) + lab(83, 651, "Farmer Disabilities");
  h += `<div class="bar" style="top:697px">Farmer Residential Details</div>` + cell(74, 733, 561) + cell(635, 733, 577);
  h += lab(83, 733, "Address In English") + val(222, 733, esc(r.address_en)) + lab(644, 733, "Address In Local Language") + val(840, 733, esc(r.address_local));
  h += cell(74, 778, 453) + cell(527, 778, 685) + lab(83, 778, "Farmer type") + val(176, 778, r.farmer_type) + lab(536, 778, "Occupations") + val(632, 778, esc(r.occupation));
  h += `<div class="bar" style="top:823px">Land Ownership Details</div>`;
  return h;
}

const TX = [75, 174, 255, 340, 414, 468, 526, 614, 728, 810, 904, 1050, 1211];
function page2(r) {
  const hdr = ["State/UT", "District", "Sub District", "Village", "S No.", "S/S no.", "Owner Name", "Identifier name &amp; Type", "Owner Type", "Owner Share Type", "Extent Total Area ( Default Hectare Unit, )", "Extent Assigned Area ( Default Hectare Unit, )"];
  const cols = TX.slice(1).map((x, i) => `<col style="width:${x - TX[i]}px">`).join("");
  const rows = r.parcels.map((p) => `<tr>${[p.state, p.district, p.sub_district, p.village, p.survey_no, p.sub_survey_no ?? "*", p.owner_name, p.identifier_name, p.owner_type, p.share_type, `${p.area_total},`, `${p.area_assigned},`].map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`).join("");
  const tableH = 65 + r.parcels.length * 56;
  return `<table style="width:${TX[12] - TX[0]}px"><colgroup>${cols}</colgroup><tr>${hdr.map((x) => `<th>${x}</th>`).join("")}</tr>${rows}</table>` +
    `<div class="a" style="left:0;width:${W}px;text-align:center;top:${40 + tableH + 14}px;text-decoration:underline;font-size:17px;color:#555">Annexure</div>`;
}
const CONSENT = ["Consent by Farmer", "Consent as per the provisions under Section 7 of the Aadhaar Act, 2016 for creation of Farmers’ Registry under AgriStack in Maharashtra", "I agree to share my identity information along with my Aadhaar number with the Central and State Governments for the purpose of e-KYC or ‘Yes’/‘No’ authentication with the Unique Identification Authority of India.", "शेतकऱ्याचे सहमतीपत्र", "महाराष्ट्रात अग्रीस्टॅक अंतर्गत शेतकरी माहिती संच निर्मितीसाठी आधार कायदा, 2016 च्या कलम 7 अंतर्गत तरतुदींनुसार सहमती"];
const page3 = () => CONSENT.map((t, i) => `<div class="d" style="top:${30 + i * 70}px">${t}</div>`).join("");
const page4 = (r) => `<div class="d" style="top:30px">माझ्या आधारशी संबंधित सहमती आणि संकलनाचा उद्देश मला स्थानिक भाषेत समजावून सांगितला गेला आहे.</div><div class="a l" style="left:74px;top:290px;font-size:16px">Date: <span style="font-weight:400">26/01/2025</span></div><div class="a l" style="right:70px;top:270px;font-size:16px">Farmer Name</div><div class="a" style="right:70px;top:310px;font-size:15px">${esc(r.name_en)}</div>`;

// ---------- degradations applied to the page raster (what a scan/screenshot pipeline would produce) ----------
async function degrade(png, variant) {
  let img = sharp(png);
  if (variant === "clean") return png;
  if (variant === "jpeg") return img.blur(0.7).jpeg({ quality: 50 }).toBuffer();
  if (variant === "skew") return img.rotate((rnd() < 0.5 ? -1 : 1) * (0.3 + rnd() * 0.4), { background: "#ffffff" }).jpeg({ quality: 80 }).toBuffer();
  if (variant === "lowres") { const m = await img.metadata(); return sharp(await img.resize(Math.round(m.width * 0.55)).jpeg({ quality: 75 }).toBuffer()).toBuffer(); }
  if (variant === "noisy") {
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i++) { const n = (rnd() + rnd() + rnd() - 1.5) * 38; data[i] = Math.max(0, Math.min(255, data[i] + n)); }
    return sharp(data, { raw: info }).blur(0.5).jpeg({ quality: 70 }).toBuffer();
  }
  return png;
}
const VARIANTS = ["clean", "clean", "clean", "jpeg", "skew", "lowres", "noisy"];

function avatar() {
  const bg = pick(["#d9d9d9", "#cfd8dc", "#e0d7c8"]), skin = pick(["#c68642", "#8d5524", "#e0ac69", "#a1665e"]);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="77" height="97"><rect width="77" height="97" fill="${bg}"/><ellipse cx="38" cy="38" rx="17" ry="21" fill="${skin}"/><path d="M5 97 Q38 50 72 97Z" fill="${pick(["#fff", "#37474f", "#455a64"])}"/></svg>`;
  return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
}

// ---------- main ----------
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE });
const truth = {};
for (let n = 1; n <= COUNT; n++) {
  const r = makePerson(), variant = VARIANTS[(n - 1) % VARIANTS.length], id = `form-${String(n).padStart(2, "0")}`;
  const htmls = [page1(r, avatar()), page2(r), page3(), page4(r)];
  const imgs = [];
  for (const body of htmls) {
    const pg = await ctx.newPage();
    await pg.setContent(`<!doctype html><meta charset="utf-8"><style>${CSS}</style><body>${body}</body>`);
    imgs.push(await degrade(await pg.screenshot({ type: "png" }), variant));
    await pg.close();
  }
  const mime = (b) => (b[0] === 0x89 ? "png" : "jpeg");
  const pdfPage = await ctx.newPage();
  await pdfPage.setContent(`<!doctype html><style>@page{size:297mm 210mm;margin:0}*{margin:0}img{display:block;width:297mm;height:210mm;page-break-after:always}</style>${imgs.map((b) => `<img src="data:image/${mime(b)};base64,${b.toString("base64")}">`).join("")}`);
  await pdfPage.pdf({ path: path.join(OUT, `${id}.pdf`), width: "297mm", height: "210mm", printBackground: true, preferCSSPageSize: true });
  await pdfPage.close();
  const t = {
    enrollment_number: r.enrollment_number, farmer_id: r.farmer_id, name_en: r.name_en, name_local: r.name_local, gender: r.gender, caste_category: r.caste_category,
    dob: r.dob, age: r.age, identifier_name_en: r.identifier_name_en, identifier_name_local: r.identifier_name_local, mobile: r.mobile, email: r.email,
    address_en: r.address_en, address_local: r.address_local, farmer_type: r.farmer_type, occupation: r.occupation,
  };
  r.parcels.forEach((p, i) => Object.assign(t, {
    [`land[${i}].state`]: p.state, [`land[${i}].district`]: p.district, [`land[${i}].sub_district`]: p.sub_district, [`land[${i}].village`]: p.village,
    [`land[${i}].survey_no`]: p.survey_no, [`land[${i}].sub_survey_no`]: p.sub_survey_no, [`land[${i}].owner_name`]: p.owner_name, [`land[${i}].identifier_name`]: p.identifier_name,
    [`land[${i}].owner_type`]: p.owner_type, [`land[${i}].share_type`]: p.share_type, [`land[${i}].area_total_ha`]: String(Number(p.area_total)), [`land[${i}].area_assigned_ha`]: String(Number(p.area_assigned)),
  }));
  truth[id] = { variant, parcels: r.parcels.length, fields: t };
  process.stdout.write(`${id} ${variant} parcels=${r.parcels.length}\n`);
}
await writeFile(path.join(OUT, "truth.json"), JSON.stringify(truth, null, 1));
await browser.close();
console.log(`generated ${COUNT} forms in ${OUT}`);
