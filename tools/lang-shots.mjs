// Screenshot a page in each language. Usage: node tools/lang-shots.mjs <path> <outPrefix> [email]
// With an email, signs in first (password from SEED_PASSWORD or the dev default).
import { createRequire } from "node:module";
const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const [path = "/login", prefix = "shot", email] = process.argv.slice(2);
const WEB = "http://localhost:3000";
const out = (n) => new URL(`../.devdata/${n}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
for (const lang of ["mr", "hi", "en"]) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  await ctx.addCookies([{ name: "lang", value: lang, url: WEB }]);
  const page = await ctx.newPage();
  if (email) {
    await page.goto(`${WEB}/login`);
    await page.locator('input[autocomplete="username"]').fill(email);
    await page.locator('input[type="password"]').fill(process.env.SEED_PASSWORD ?? "Dev-Pass-12345");
    await page.locator("form button").click();
    await page.waitForURL(`${WEB}/`);
  }
  await page.goto(WEB + path);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: out(`${prefix}-${lang}.png`), fullPage: true });
  console.log(`${lang}: <html lang="${await page.getAttribute("html", "lang")}"> title h1="${(await page.locator("h1").first().textContent())?.trim()}"`);
  await ctx.close();
}
await browser.close();
