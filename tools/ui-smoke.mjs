// Browser smoke test through the real UI (headless Chrome). Needs API :4000 and web :3000 running and a clean DB (no prior upload of the sample).
// Usage: node tools/ui-smoke.mjs "<sample.pdf>"
import { createRequire } from "node:module";
const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { chromium } = require("playwright-core");

const WEB = "http://localhost:3000", PASS = process.env.SEED_PASSWORD ?? "Dev-Pass-12345";
const pdf = process.argv[2];
const out = (n) => new URL(`../.devdata/${n}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
let fails = 0; const check = (n, ok, x = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n} ${x}`); if (!ok) fails++; };

const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
async function signIn(email) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies([{ name: "lang", value: "en", url: WEB }]);
  const page = await ctx.newPage();
  await page.goto(`${WEB}/login`);
  await page.getByLabel("Email or mobile").fill(email);
  await page.getByLabel("Password").fill(PASS);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${WEB}/`);
  return page;
}

const op = await signIn("operator@dev.local");
check("operator signs in", (await op.textContent("h1")).includes("Dev Operator"));
await op.setInputFiles('input[type="file"]', pdf);
await op.getByRole("button", { name: /Upload/ }).click();
await op.waitForURL(/\/documents\//);
await op.getByRole("heading", { name: "Review extracted details" }).waitFor({ timeout: 90000 });
check("review page loaded after extraction", true);
check("submit disabled before review", await op.getByRole("button", { name: /Submit for verification/ }).isDisabled());
await op.screenshot({ path: out("ui-review-en.png"), fullPage: true });

// --- language switching on the review page (labels, order, errors, statuses)
const labelsOf = async () => (await op.locator(".field .k").allTextContents()).map((x) => x.trim());
check("review fields follow form order (enrollment first)", (await labelsOf())[0].startsWith("Enrollment number"));
await op.locator(".langswitch select").selectOption("mr");
await op.getByRole("heading", { name: "वाचलेली माहिती तपासा" }).waitFor();
check("Marathi review page: heading + first label + <html lang>", (await labelsOf())[0].startsWith("नोंदणी क्रमांक") && (await op.getAttribute("html", "lang")) === "mr");
check("Marathi mismatch warning shown", (await op.locator(".err").allTextContents()).some((x) => x.includes("जमीन नोंदीतील मालकाचे नाव")));
await op.screenshot({ path: out("ui-review-mr.png"), fullPage: true });
await op.locator(".langswitch select").selectOption("hi");
await op.getByRole("heading", { name: "पढ़ी गई जानकारी जाँचें" }).waitFor();
check("Hindi review page", (await labelsOf())[0].startsWith("पंजीकरण संख्या"));
await op.screenshot({ path: out("ui-review-hi.png"), fullPage: true });
await op.locator(".langswitch select").selectOption("en");
await op.getByRole("heading", { name: "Review extracted details" }).waitFor();
check("language choice persists in cookie across reload", await (async () => { await op.locator(".langswitch select").selectOption("hi"); await op.reload(); await op.getByRole("heading", { name: "पढ़ी गई जानकारी जाँचें" }).waitFor(); await op.locator(".langswitch select").selectOption("en"); await op.getByRole("heading", { name: "Review extracted details" }).waitFor(); return true; })());

// confirm every flagged field
for (let guard = 0; guard < 40; guard++) {
  const flagged = op.locator(".field.flag").first();
  if (!(await flagged.count())) break;
  await flagged.getByRole("button", { name: /Confirm|Save edit/ }).click();
  await op.waitForTimeout(400);
}
check("no flagged fields remain", (await op.locator(".field.flag").count()) === 0);
await op.getByLabel(/I verified these details/).check();
await op.getByRole("button", { name: /Submit for verification/ }).click();
await op.waitForURL(/\/farmers\//);
const farmerUrl = op.url();
await op.getByText(/L1 Submitted/).first().waitFor({ timeout: 15000 }); check("farmer created at L1", true);
check("operator sees no approve button", (await op.getByRole("button", { name: /Approve/ }).count()) === 0);

const ver = await signIn("verifier@dev.local");
await ver.goto(farmerUrl);
await ver.getByRole("button", { name: /Approve \(L2\)/ }).click();
await ver.getByAltText("Farmer card front").waitFor({ timeout: 60000 });
check("card shown after approval", true);
await ver.screenshot({ path: out("ui-farmer-en.png"), fullPage: true });
for (const [code, heading, cardWord] of [["mr", "कार्ड", "शेतकरी कार्डाची पुढील बाजू"], ["hi", "कार्ड", "किसान कार्ड का अगला भाग"]]) {
  await ver.locator(".langswitch select").selectOption(code);
  await ver.getByAltText(cardWord).waitFor({ timeout: 15000 });
  check(`${code} farmer page localised (card alt text, trust badge)`, (await ver.textContent("body")).includes(code === "mr" ? "L2 कागदपत्रे तपासली" : "L2 दस्तावेज़ जाँचे गए"));
  await ver.screenshot({ path: out(`ui-farmer-${code}.png`), fullPage: true });
}
// public verify page, server-rendered, per language (unknown token -> localised generic message)
const pub = await browser.newContext();
for (const [code, msg] of [["mr", "जुळणारे कार्ड सापडले नाही"], ["hi", "कोई मेल खाता कार्ड नहीं मिला"], ["en", "No matching card found"]]) {
  await pub.addCookies([{ name: "lang", value: code, url: WEB }]);
  const pg = await pub.newPage();
  await pg.goto(`${WEB}/verify/${"A".repeat(43)}`);
  check(`public verify page in ${code}`, (await pg.textContent("body")).includes(msg) && (await pg.getAttribute("html", "lang")) === code);
  await pg.close();
}
const accept = await browser.newContext({ locale: "hi-IN", extraHTTPHeaders: { "Accept-Language": "hi-IN,hi;q=0.9" } });
const apg = await accept.newPage(); await apg.goto(`${WEB}/verify/${"A".repeat(43)}`);
check("no cookie: Accept-Language hi is honoured", (await apg.getAttribute("html", "lang")) === "hi");
await browser.close();
console.log(fails ? `${fails} FAILED` : "UI SMOKE PASSED");
process.exit(fails ? 1 : 0);
