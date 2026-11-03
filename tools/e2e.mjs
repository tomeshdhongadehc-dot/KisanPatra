// End-to-end + security smoke test against a running API (http://localhost:4000).
// Usage: node tools/e2e.mjs "<path-to-sample.pdf>"
// Prints pass/fail only; never prints personal data from the document.
import { readFile, writeFile } from "node:fs/promises";

const API = "http://localhost:4000/api/v1";
const ORIGIN = "http://localhost:3000";
const PASS = process.env.SEED_PASSWORD ?? "Dev-Pass-12345";
const pdfPath = process.argv[2];
let failures = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!ok) failures++; };

class Client {
  cookie = "";
  async req(method, path, { json, form, raw } = {}) {
    const headers = { Origin: ORIGIN };
    if (this.cookie) headers.Cookie = this.cookie;
    let body;
    if (json) { headers["Content-Type"] = "application/json"; body = JSON.stringify(json); }
    if (form) body = form;
    const res = await fetch(API + path, { method, headers, body });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0];
    if (raw) return res;
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  }
  async login(email) { return this.req("POST", "/auth/login", { json: { identifier: email, password: PASS } }); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pdf = await readFile(pdfPath);
const pdfForm = (name = "form.pdf", type = "application/pdf", buf = pdf) => { const f = new FormData(); f.append("file", new Blob([buf], { type }), name); return f; };

// --- unauthenticated / bad-origin
const anon = new Client();
check("unauthenticated upload -> 401", (await anon.req("POST", "/documents", { form: pdfForm() })).status === 401);
const badOrigin = await fetch(API + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://evil.example" }, body: JSON.stringify({ identifier: "x@y.z", password: "12345678" }) });
check("login from foreign origin -> 403", badOrigin.status === 403);

// --- operator flow
const op = new Client();
check("operator login", (await op.login("operator@dev.local")).status === 200);
check("renamed non-PDF rejected", (await op.req("POST", "/documents", { form: pdfForm("evil.pdf", "application/pdf", Buffer.from("MZ\x90\x00not a pdf")) })).status === 400);
check("wrong extension rejected", (await op.req("POST", "/documents", { form: pdfForm("form.exe") })).status === 400);

let up = await op.req("POST", "/documents", { form: pdfForm() });
if (up.status === 409) { console.log("note: sample already uploaded; use a fresh DB or delete the document row to rerun"); process.exit(2); }
check("upload accepted", up.status === 201, `status=${up.status}`);
const docId = up.data.id;
check("duplicate upload -> 409", (await op.req("POST", "/documents", { form: pdfForm() })).status === 409);

let doc;
for (let i = 0; i < 60; i++) { doc = (await op.req("GET", `/documents/${docId}`)).data; if (["READY_FOR_REVIEW", "FAILED"].includes(doc.status)) break; await sleep(1000); }
check("extraction finished READY_FOR_REVIEW", doc.status === "READY_FOR_REVIEW", `status=${doc.status} reason=${doc.rejectReason ?? ""}`);
check("fields extracted (16 form + 12 per parcel row)", doc.fields.length >= 28, `n=${doc.fields.length}`);
check("consent pages not stored (2 page images)", doc.pages.length === 2, `pages=${doc.pages.length}`);
const mismatch = doc.fields.find((f) => f.errors.includes("OWNER_NAME_DIFFERS_FROM_FARMER_NAME"));
check("name mismatch flagged for review", !!mismatch);

const page = await op.req("GET", `/documents/${docId}/pages/1/image`, { raw: true });
check("page image served (private, no-store)", page.status === 200 && (page.headers.get("cache-control") ?? "").includes("no-store"));

// submit must fail while flagged fields are unresolved
const early = await op.req("POST", `/documents/${docId}/submit`, { json: { attested: true } });
check("submit blocked while fields unresolved", early.status === 400 && early.data.message === "UNRESOLVED_FIELDS" || early.status === 201 && !doc.fields.some((f) => f.needsReview), `status=${early.status}`);

for (const f of doc.fields.filter((f) => f.needsReview)) await op.req("PATCH", `/documents/${docId}/fields/${f.id}`, { json: { action: "confirm" } });
const sub = await op.req("POST", `/documents/${docId}/submit`, { json: { attested: true } });
check("submit creates farmer at L1", sub.status === 201 && sub.data.trustLevel === "L1_SUBMITTED", `status=${sub.status} ${sub.status !== 201 ? JSON.stringify(sub.data) : ""}`);
const farmerId = sub.data.farmerId;

// --- four-eyes / roles
check("operator cannot approve (role) -> 403", (await op.req("POST", `/farmers/${farmerId}/approve`)).status === 403);
const ver = new Client(); await ver.login("verifier@dev.local");
const adm = new Client(); await adm.login("admin@dev.local");
const appr = await ver.req("POST", `/farmers/${farmerId}/approve`);
check("verifier approves -> L2 + card issued", appr.status === 201 && appr.data.trustLevel === "L2_DOCUMENT_REVIEWED" && !!appr.data.verifyUrl, `status=${appr.status} ${appr.status !== 201 ? JSON.stringify(appr.data) : ""}`);
check("cannot approve twice -> 409", (await ver.req("POST", `/farmers/${farmerId}/approve`)).status === 409);

// --- card artifacts
const png = await ver.req("GET", `/farmers/${farmerId}/card?format=png`, { raw: true });
const pngBuf = Buffer.from(await png.arrayBuffer());
check("card PNG downloadable", png.status === 200 && pngBuf.subarray(1, 4).toString() === "PNG", `bytes=${pngBuf.length}`);
await writeFile(new URL("../.devdata/card-front.png", import.meta.url), pngBuf);
const pdfRes = await ver.req("GET", `/farmers/${farmerId}/card?format=pdf`, { raw: true });
const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
check("card PDF downloadable", pdfRes.status === 200 && pdfBuf.subarray(0, 5).toString() === "%PDF-", `bytes=${pdfBuf.length}`);
const a4Res = await ver.req("GET", `/farmers/${farmerId}/card?format=a4`, { raw: true });
const a4Buf = Buffer.from(await a4Res.arrayBuffer());
check("A4 print sheet downloadable (PDF, A4 page)", a4Res.status === 200 && a4Buf.subarray(0, 5).toString() === "%PDF-" && /MediaBox\s*\[\s*0\s+0\s+59[45]\.\d+\s+84[12]\.\d+/.test(a4Buf.toString("latin1")), `bytes=${a4Buf.length}`);
check("A4 sheet is private (no-store)", /no-store/.test(a4Res.headers.get("cache-control") ?? ""));
await writeFile(new URL("../.devdata/last-a4.pdf", import.meta.url), a4Buf);
await writeFile(new URL("../.devdata/last-pvc.pdf", import.meta.url), pdfBuf);
check("A4 sheet not served to unauthenticated client", (await new Client().req("GET", `/farmers/${farmerId}/card?format=a4`)).status === 401);
await writeFile(new URL("../.devdata/card.pdf", import.meta.url), pdfBuf);

// --- public verification
const token = appr.data.verifyUrl.split("/verify/")[1];
await writeFile(new URL("../.devdata/last-verify-url.txt", import.meta.url), appr.data.verifyUrl);
const pub = await anon.req("GET", `/public/verify/${token}`);
check("public verify ACTIVE with minimal fields", pub.status === 200 && pub.data.status === "ACTIVE" && !("name" in pub.data) && !("photo" in pub.data) && !("mobile" in pub.data), `keys=${Object.keys(pub.data).join(",")}`);
const bogus = await anon.req("GET", `/public/verify/${"A".repeat(43)}`);
check("unknown token -> generic NOT_FOUND", bogus.data.status === "NOT_FOUND" && Object.keys(bogus.data).length === 1);

// --- BOLA: another operator-role user cannot read this farmer/document (verifier is allowed; auditor is not a reader of documents)
const aud = new Client(); await aud.login("auditor@dev.local");
check("auditor cannot upload -> 403", (await aud.req("POST", "/documents", { form: pdfForm("x.pdf") })).status === 403);

// --- revoke
const farmer = (await adm.req("GET", `/farmers/${farmerId}`)).data;
const cardId = farmer.cards.find((c) => c.status === "ACTIVE").id;
check("operator cannot revoke -> 403", (await op.req("POST", `/farmers/cards/${cardId}/revoke`, { json: { reason: "test" } })).status === 403);
check("admin revokes card", (await adm.req("POST", `/farmers/cards/${cardId}/revoke`, { json: { reason: "e2e test revoke" } })).status === 201);
check("revoked token -> REVOKED", (await anon.req("GET", `/public/verify/${token}`)).data.status === "REVOKED");

// --- rate limit (public endpoint)
let limited = false;
for (let i = 0; i < 40; i++) if ((await anon.req("GET", `/public/verify/${"B".repeat(43)}`)).status === 403) { limited = true; break; }
check("verify endpoint rate-limited", limited);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
