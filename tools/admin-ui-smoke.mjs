// Browser test of the admin console, forced password change and two-step sign-in, through the real UI (headless Chrome).
// Needs API :4000 (default env) and web :3000 running. Creates one throw-away user per run. Prints pass/fail only.
import crypto from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { chromium } = require("playwright-core");

const WEB = "http://localhost:3000", PASS = process.env.SEED_PASSWORD ?? "Dev-Pass-12345";
let fails = 0; const check = (n, ok, x = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n} ${x}`); if (!ok) fails++; };
const b32 = (s) => { const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits = 0, v = 0; const o = []; for (const c of s) { v = (v << 5) | A.indexOf(c); bits += 5; if (bits >= 8) { o.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(o); };
const totp = (secret, off = 0) => { const m = Buffer.alloc(8); m.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + off)); const h = crypto.createHmac("sha1", b32(secret)).update(m).digest(); const o = h[19] & 15; return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, "0"); };

const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const fresh = async (lang = "en") => { const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); await ctx.addCookies([{ name: "lang", value: lang, url: WEB }]); return ctx.newPage(); };
async function login(page, email, password) {
  await page.goto(`${WEB}/login`);
  await page.getByLabel("Email or mobile").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

const uniq = Date.now().toString(36), email = `ui.${uniq}@dev.local`, NEW = `Kisan-${uniq}-Card!9`;

// 1. admin console
const ad = await fresh();
await login(ad, "admin@dev.local", PASS);
await ad.waitForURL(`${WEB}/`);
await ad.getByRole("link", { name: "Admin" }).waitFor({ timeout: 15000 });
check("admin sees Admin link in header", true);
await ad.getByRole("link", { name: "Admin" }).click();
await ad.getByRole("heading", { name: "Administration" }).waitFor();
await ad.getByRole("heading", { name: "Overview" }).waitFor({ timeout: 15000 });
check("stats section rendered", true);
await ad.locator('input[name="email"]').fill(email);
await ad.locator('input[name="displayName"]').fill("UI QA User");
await ad.locator('select[name="role"]').selectOption("OPERATOR");
await ad.getByRole("button", { name: "Create" }).click();
await ad.getByTestId("temp-password").waitFor();
const temp = (await ad.getByTestId("temp-password").textContent()).trim();
check("temp password shown once after create", /^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/.test(temp));
await ad.reload(); await ad.getByRole("heading", { name: "Users", level: 2 }).waitFor();
check("temp password gone after reload (not retrievable)", (await ad.getByTestId("temp-password").count()) === 0);
check("new user listed", await ad.getByText(email).isVisible());
// two-click confirm, no browser dialogs
const row = ad.locator("tr", { hasText: email });
await row.getByRole("button", { name: "Suspend" }).click();
check("first click only arms the action", await row.getByRole("button", { name: "Are you sure?" }).isVisible() && (await row.textContent()).includes("Active"));
await row.getByRole("button", { name: "Are you sure?" }).click();
await ad.locator("tr", { hasText: email }).getByText("Suspended").waitFor();
check("second click suspends", true);
await ad.locator("tr", { hasText: email }).getByRole("button", { name: "Activate" }).click();
await ad.locator("tr", { hasText: email }).getByRole("button", { name: "Are you sure?" }).click();
await ad.locator("tr", { hasText: email }).getByText("Active").waitFor();
check("reactivated", true);
check("admin's own row has no action buttons", (await ad.locator("tr", { hasText: "admin@dev.local" }).getByRole("button").count()) === 0);

// 2. operator cannot reach admin data
const opPage = await fresh();
await login(opPage, "operator@dev.local", PASS); await opPage.waitForURL(`${WEB}/`);
check("operator has no Admin link", (await opPage.getByRole("link", { name: "Admin" }).count()) === 0);
await opPage.goto(`${WEB}/admin`); await opPage.waitForTimeout(1500);
check("operator on /admin sees no users or stats", (await opPage.locator("table").count()) === 0);

// 3. new user: forced password change
const u = await fresh();
await login(u, email, temp);
await u.waitForURL(`${WEB}/account`);
await u.getByText("You are using a temporary password").waitFor({ timeout: 15000 });
check("temp-password login lands on /account", true);
await u.goto(`${WEB}/`); await u.waitForURL(`${WEB}/account`, { timeout: 15000 });
check("other pages bounce back to /account until changed", true);
await u.locator('input[name="current"]').fill(temp);
await u.locator('input[name="next"]').fill("short");
await u.getByRole("button", { name: "Save password" }).click();
check("browser blocks too-short password (min length)", (await u.getByText("Password changed").count()) === 0);
await u.locator('input[name="next"]').fill("Password-123456");
await u.getByRole("button", { name: "Save password" }).click();
await u.getByText("too common").waitFor();
check("policy message shown for a common password", true);
await u.locator('input[name="next"]').fill(NEW);
await u.getByRole("button", { name: "Save password" }).click();
await u.waitForURL(`${WEB}/`, { timeout: 20000 });
check("after change, user reaches home", true);

// 4. enrol two-step
await u.goto(`${WEB}/account`);
await u.getByRole("button", { name: "Set up" }).click();
await u.locator("code").first().waitFor();
const secret = (await u.locator("code").first().textContent()).trim();
check("secret + QR shown", /^[A-Z2-7]{32}$/.test(secret) && await u.locator('img[alt="QR"]').isVisible());
await u.locator('input[name="code"]').fill("000000");
await u.getByRole("button", { name: "Turn on" }).click();
await u.getByText("not valid").waitFor();
check("wrong code rejected", true);
await u.locator('input[name="code"]').fill(totp(secret));
await u.getByRole("button", { name: "Turn on" }).click();
await u.getByRole("heading", { name: "Recovery codes" }).waitFor();
const codes = (await u.locator("pre").textContent()).trim().split("\n");
check("8 recovery codes shown once", codes.length === 8 && codes.every((c) => /^[0-9a-f]{5}-[0-9a-f]{5}$/.test(c)));
check("account now says ON", await u.getByText("Two-step sign-in is ON").isVisible());

// 5. sign in with two-step
const m = await fresh();
await login(m, email, NEW);
await m.locator('input[name="totp"]').waitFor();
check("password alone is not enough: code field appears", true);
await m.locator('input[name="totp"]').fill("000000");
await m.getByRole("button", { name: "Sign in" }).click();
await m.getByRole("alert").waitFor();
check("wrong code -> generic error, still on login", m.url().endsWith("/login"));
await m.locator('input[name="totp"]').fill(totp(secret, 1));
await m.getByRole("button", { name: "Sign in" }).click();
await m.waitForURL(`${WEB}/`);
check("correct code signs in", true);
const r = await fresh();
await login(r, email, NEW);
await r.getByRole("link", { name: "Use a recovery code instead" }).click();
await r.locator('input[name="recovery"]').fill(codes[0]);
await r.getByRole("button", { name: "Sign in" }).click();
await r.waitForURL(`${WEB}/`);
check("recovery code signs in", true);

// 6. language
const mr = await fresh("mr");
await mr.goto(`${WEB}/login`);
await mr.getByLabel("ईमेल किंवा मोबाईल").fill("admin@dev.local");
await mr.getByLabel("पासवर्ड").fill(PASS);
await mr.getByRole("button", { name: "लॉगिन करा" }).click();
await mr.waitForURL(`${WEB}/`);
await mr.goto(`${WEB}/admin`);
await mr.getByRole("heading", { name: "प्रशासन" }).waitFor({ timeout: 15000 });
await mr.getByRole("heading", { name: "आढावा" }).waitFor({ timeout: 15000 });
check("admin console localised (Marathi)", true);

await browser.close();
console.log(fails ? `\n${fails} FAILED` : "\nADMIN UI SMOKE PASSED");
process.exit(fails ? 1 : 0);
