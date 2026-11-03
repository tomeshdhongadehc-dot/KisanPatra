// Admin / account-security test. Starts its own API (port 4000 must be free) with MFA required for the VERIFIER role.
// Creates throw-away users (unique emails); seeded dev users are not modified. Prints pass/fail only, never secrets.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";

const API = "http://localhost:4000/api/v1", ORIGIN = "http://localhost:3000", PASS = process.env.SEED_PASSWORD ?? "Dev-Pass-12345";
let failures = 0;
const check = (n, ok, x = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// independent TOTP implementation (RFC 6238) so the server's is cross-checked, not just self-consistent
const b32 = (s) => { const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits = 0, v = 0; const o = []; for (const c of s) { v = (v << 5) | A.indexOf(c); bits += 5; if (bits >= 8) { o.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(o); };
const code = (secret, stepOffset = 0) => { const m = Buffer.alloc(8); m.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + stepOffset)); const h = crypto.createHmac("sha1", b32(secret)).update(m).digest(); const o = h[19] & 15; return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, "0"); };

class Client {
  cookie = "";
  async req(method, p, json) {
    const headers = { Origin: ORIGIN }; if (this.cookie) headers.Cookie = this.cookie;
    let body; if (json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(json); }
    const res = await fetch(API + p, { method, headers, body });
    const set = res.headers.get("set-cookie"); if (set && /agri_session=[^;]+/.test(set)) this.cookie = set.split(";")[0];
    const t = await res.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: res.status, data };
  }
  login(identifier, password, extra = {}) { return this.req("POST", "/auth/login", { identifier, password, ...extra }); }
}
const msg = (r) => r.data?.message;

const api = spawn(process.execPath, ["--import", "tsx", "--env-file=../../.env", "src/main.ts"], { cwd: path.resolve("apps/api"), env: { ...process.env, WORKER_MODE: "external", MFA_REQUIRED_ROLES: "VERIFIER", LOGIN_RATE_MAX: "500" }, stdio: "ignore", windowsHide: true });
try {
  for (let i = 0; i < 40; i++) { try { await fetch(API + "/auth/me"); break; } catch { await sleep(500); } }
  const uniq = Date.now().toString(36);

  // ---- access control
  const anon = new Client(), op = new Client(), au = new Client(), ad = new Client();
  check("unauthenticated /admin/users -> 401", (await anon.req("GET", "/admin/users")).status === 401);
  await op.login("operator@dev.local", PASS); await au.login("auditor@dev.local", PASS);
  check("operator -> /admin/users 403", (await op.req("GET", "/admin/users")).status === 403);
  check("operator -> /admin/stats 403", (await op.req("GET", "/admin/stats")).status === 403);
  check("auditor can read stats", (await au.req("GET", "/admin/stats")).status === 200);
  check("auditor cannot list users", (await au.req("GET", "/admin/users")).status === 403);
  check("admin login", (await ad.login("admin@dev.local", PASS)).status === 200);

  // ---- create user
  const email = `qa.${uniq}@dev.local`;
  const bad = await ad.req("POST", "/admin/users", { email, displayName: "QA Verifier", role: "SUPER_ADMIN" });
  check("cannot assign SUPER_ADMIN", bad.status === 400);
  const created = await ad.req("POST", "/admin/users", { email, displayName: "QA Verifier", role: "VERIFIER" });
  check("admin creates user, temp password returned once", created.status === 201 && typeof created.data.tempPassword === "string" && created.data.tempPassword.length >= 16 && created.data.user.mustChangePassword === true);
  check("duplicate email -> 409", (await ad.req("POST", "/admin/users", { email, displayName: "Dup", role: "OPERATOR" })).status === 409);
  check("user list never exposes password hash or secrets", !/passwordHash|mfaSecret|argon2/.test(JSON.stringify((await ad.req("GET", "/admin/users")).data)));
  const uid = created.data.user.id, temp = created.data.tempPassword;

  // ---- first login with temp password: restricted session
  const u = new Client(), u2 = new Client();
  const l1 = await u.login(email, temp);
  check("temp password logs in, flagged must-change", l1.status === 200 && l1.data.mustChangePassword === true);
  check("restricted session: /auth/me allowed", (await u.req("GET", "/auth/me")).status === 200);
  const blocked = await u.req("GET", "/farmers");
  check("restricted session: other routes -> 403 PASSWORD_CHANGE_REQUIRED", blocked.status === 403 && msg(blocked) === "PASSWORD_CHANGE_REQUIRED");
  await u2.login(email, temp); // second concurrent session

  // ---- password policy + change
  const NEW = `Kisan-${uniq}-Card!9`;
  for (const [pw, want] of [["Short1!", "PASSWORD_TOO_SHORT"], ["Password-123456", "PASSWORD_TOO_COMMON"], ["alllowercaseletters", "PASSWORD_TOO_SIMPLE"], [`qa.${uniq}-Strong9!`, "PASSWORD_CONTAINS_IDENTIFIER"]]) {
    const r = await u.req("POST", "/auth/change-password", { current: temp, next: pw });
    check(`policy rejects ${want}`, r.status === 409 && msg(r) === want, `got ${r.status} ${msg(r)}`);
  }
  check("wrong current password -> 401", (await u.req("POST", "/auth/change-password", { current: "wrong-password-1", next: NEW })).status === 401);
  check("change password succeeds", (await u.req("POST", "/auth/change-password", { current: temp, next: NEW })).status === 204);
  check("other session of the same user is revoked", (await u2.req("GET", "/auth/me")).status === 401);
  check("current session survives", (await u.req("GET", "/auth/me")).status === 200);
  check("old (temp) password no longer works", (await new Client().login(email, temp)).status === 401);

  // ---- MFA mandatory for VERIFIER
  const need = await u.req("GET", "/farmers");
  check("VERIFIER without MFA -> 403 MFA_SETUP_REQUIRED", need.status === 403 && msg(need) === "MFA_SETUP_REQUIRED");
  const setup = await u.req("POST", "/auth/mfa/setup");
  check("MFA setup returns secret, otpauth URI and QR", setup.status === 201 && /^[A-Z2-7]{32}$/.test(setup.data.secret) && setup.data.otpauthUri.startsWith("otpauth://totp/") && setup.data.qr.startsWith("data:image/svg+xml"));
  const secret = setup.data.secret;
  check("enable with wrong code -> 401", (await u.req("POST", "/auth/mfa/enable", { code: code(secret) === "000000" ? "111111" : "000000" })).status === 401);
  const en = await u.req("POST", "/auth/mfa/enable", { code: code(secret) });
  check("enable with correct code returns 8 recovery codes", en.status === 201 && en.data.recoveryCodes?.length === 8);
  const recovery = en.data.recoveryCodes;
  check("after MFA enrolment the session works normally", (await u.req("GET", "/farmers")).status === 200);
  check("cannot disable MFA while policy requires it", (await u.req("POST", "/auth/mfa/disable", { password: NEW, totp: code(secret, 1) })).status === 403);

  // ---- login with MFA
  const m = new Client();
  const noCode = await m.login(email, NEW);
  check("login without code -> 401 MFA_REQUIRED, no session", noCode.status === 401 && msg(noCode) === "MFA_REQUIRED" && !m.cookie);
  check("login with wrong code -> 401", (await m.login(email, NEW, { totp: "000000" })).status === 401);
  const good = code(secret, 1); // enable consumed the current step; the next step's code is valid (+-1 drift window) and newer
  check("login with correct code", (await m.login(email, NEW, { totp: good })).status === 200);
  check("same code replayed -> rejected", (await new Client().login(email, NEW, { totp: good })).status === 401);
  const rc = new Client();
  check("recovery code works once", (await rc.login(email, NEW, { recoveryCode: recovery[0] })).status === 200);
  check("recovery code cannot be reused", (await new Client().login(email, NEW, { recoveryCode: recovery[0] })).status === 401);

  // ---- admin actions on the user
  const t = new Client(); await t.login(email, NEW, { recoveryCode: recovery[1] });
  check("admin suspends user", (await ad.req("PATCH", `/admin/users/${uid}`, { status: "SUSPENDED" })).status === 200);
  check("suspension kills live sessions at once", (await t.req("GET", "/auth/me")).status === 401);
  check("suspended user cannot log in", (await new Client().login(email, NEW, { recoveryCode: recovery[2] })).status === 401);
  check("admin reactivates user", (await ad.req("PATCH", `/admin/users/${uid}`, { status: "ACTIVE" })).status === 200);
  const me = (await ad.req("GET", "/auth/me")).data;
  check("admin cannot change own role/status", (await ad.req("PATCH", `/admin/users/${me.id}`, { role: "OPERATOR" })).status === 403);
  check("admin cannot reset own password via admin route", (await ad.req("POST", `/admin/users/${me.id}/reset-password`)).status === 403);

  const rp = await ad.req("POST", `/admin/users/${uid}/reset-password`);
  check("admin password reset returns new temp password", rp.status === 200 && rp.data.tempPassword?.length >= 16);
  check("old password rejected after reset", (await new Client().login(email, NEW, { recoveryCode: recovery[3] })).status === 401);
  const afterReset = new Client();
  check("temp password after reset requires MFA code", (await afterReset.login(email, rp.data.tempPassword)).status === 401);
  check("admin resets MFA (lost device)", (await ad.req("POST", `/admin/users/${uid}/reset-mfa`)).status === 204);
  const l2 = new Client(); const r2 = await l2.login(email, rp.data.tempPassword);
  check("after MFA reset: login needs no code, must change password again", r2.status === 200 && r2.data.mustChangePassword === true && r2.data.mfaSetupRequired === true);

  // ---- lockout and unlock
  const lockMail = `lock.${uniq}@dev.local`;
  const lu = await ad.req("POST", "/admin/users", { email: lockMail, displayName: "QA Lock", role: "OPERATOR" });
  for (let i = 0; i < 6; i++) await new Client().login(lockMail, "definitely-wrong-1");
  check("account locks after repeated failures (correct password refused)", (await new Client().login(lockMail, lu.data.tempPassword)).status === 401);
  check("admin unlocks", (await ad.req("POST", `/admin/users/${lu.data.user.id}/unlock`)).status === 204);
  check("unlocked user can log in", (await new Client().login(lockMail, lu.data.tempPassword)).status === 200);

  // ---- stats
  const st = await ad.req("GET", "/admin/stats");
  const flat = JSON.stringify(st.data);
  check("stats has the expected sections", ["documents", "farmersByTrust", "cards", "jobs", "oldestQueuedSeconds", "failedLast24h", "activeUsersByRole", "lockedUsers"].every((k) => k in st.data));
  check("stats contains counts only (no names, emails, ids)", !/@|[0-9a-f]{8}-[0-9a-f]{4}/.test(flat));
} finally { api.kill(); }
console.log(failures ? `\n${failures} FAILED` : "\nADMIN TESTS PASSED");
process.exit(failures ? 1 : 0);
