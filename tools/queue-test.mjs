// Queue / worker isolation test. Starts its own API (WORKER_MODE=external, so the API never parses uploads) and workers.
// Requires port 4000 to be free and a fresh DB (truncate dev tables first). Usage: node tools/queue-test.mjs "<real-sample.pdf>"
// Prints pass/fail only; no document content.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const API = "http://localhost:4000/api/v1", ORIGIN = "http://localhost:3000", PASS = process.env.SEED_PASSWORD ?? "Dev-Pass-12345";
const apiDir = path.resolve("apps/api");
let failures = 0;
const check = (n, ok, x = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const launch = (file, env = {}) => spawn(process.execPath, ["--import", "tsx", "--env-file=../../.env", file], { cwd: apiDir, env: { ...process.env, ...env }, stdio: "ignore", windowsHide: true });
const kill = (c) => new Promise((r) => { if (!c || c.exitCode !== null) return r(); c.once("exit", r); c.kill(); setTimeout(r, 3000); });

let cookie = "";
async function req(method, p, { json, form } = {}) {
  const headers = { Origin: ORIGIN }; if (cookie) headers.Cookie = cookie;
  let body; if (json) { headers["Content-Type"] = "application/json"; body = JSON.stringify(json); } if (form) body = form;
  const res = await fetch(API + p, { method, headers, body }); const set = res.headers.get("set-cookie"); if (set) cookie = set.split(";")[0];
  const t = await res.text(); let data; try { data = JSON.parse(t); } catch { data = t; } return { status: res.status, data };
}
const upload = async (buf) => { const f = new FormData(); f.append("file", new Blob([buf], { type: "application/pdf" }), "f.pdf"); return req("POST", "/documents", { form: f }); };
const status = async (id) => (await req("GET", `/documents/${id}`)).data.status;
async function waitFor(id, want, ms) { const end = Date.now() + ms; let s; while (Date.now() < end) { s = await status(id); if (want.includes(s)) return s; await sleep(500); } return s; }

const real = await readFile(process.argv[2]);
const synth = (n) => readFile(`samples/synthetic/form-${String(n).padStart(2, "0")}.pdf`);

const api = launch("src/main.ts", { WORKER_MODE: "external" });
try {
  for (let i = 0; i < 30; i++) { try { if ((await fetch(API + "/auth/me")).status) break; } catch { await sleep(500); } }
  check("login", (await req("POST", "/auth/login", { json: { identifier: "operator@dev.local", password: PASS } })).status === 200);

  // 1. API in external mode must not process anything itself
  const a = (await upload(real)).data.id;
  await sleep(6000);
  check("external mode: API alone does not process (job waits in queue)", (await status(a)) === "VALIDATED");
  let worker = launch("src/worker.ts", { WORKER_MODE: "external" });
  check("worker picks up the waiting job -> READY_FOR_REVIEW", (await waitFor(a, ["READY_FOR_REVIEW", "FAILED"], 90000)) === "READY_FOR_REVIEW");

  // 2. hung/slow extraction is killed at the timeout, retried once, then failed
  await kill(worker);
  const b = (await upload(await synth(1))).data.id;
  worker = launch("src/worker.ts", { WORKER_MODE: "external", EXTRACTION_TIMEOUT_MS: "800" });
  check("timeout: child killed, job FAILED after retry", (await waitFor(b, ["FAILED", "READY_FOR_REVIEW"], 60000)) === "FAILED");

  // 3. garbage PDF fails cleanly and does not block the next job
  await kill(worker);
  const junk = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 37) % 256))]);
  const c = (await upload(junk)).data.id;
  const d = (await upload(await synth(2))).data.id;
  worker = launch("src/worker.ts", { WORKER_MODE: "external" });
  check("garbage PDF -> FAILED (no hang, no crash)", (await waitFor(c, ["FAILED", "READY_FOR_REVIEW"], 90000)) === "FAILED");
  check("next job still processed after a bad one", (await waitFor(d, ["READY_FOR_REVIEW", "FAILED"], 90000)) === "READY_FOR_REVIEW");

  // 4. a worker killed mid-job leaves a RUNNING row; a fresh worker must recover it
  await kill(worker);
  const e = (await upload(await synth(3))).data.id;
  worker = launch("src/worker.ts", { WORKER_MODE: "external" });
  await sleep(2500); await kill(worker); // dies while (probably) mid-extraction
  const mid = await status(e);
  worker = launch("src/worker.ts", { WORKER_MODE: "external", EXTRACTION_TIMEOUT_MS: "20000", STALE_JOB_MS: "25000" }); // orphaned RUNNING rows older than 25s are recovered
  check(`killed worker (state was ${mid}) -> job recovered and finished`, (await waitFor(e, ["READY_FOR_REVIEW"], 150000)) === "READY_FOR_REVIEW");
  await kill(worker);
} finally { await kill(api); }
console.log(failures ? `\n${failures} FAILED` : "\nQUEUE TESTS PASSED");
process.exit(failures ? 1 : 0);
