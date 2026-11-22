// Tests PR 3's Focus Blocker in the loaded extension, following the PR's own test plan.
// Usage: node focus_test.cjs <extensionDir> <outDir>
const { chromium, executablePath } = require("./browser.cjs");
const fs = require("fs");
const path = require("path");

const [, , extDir, outDir] = process.argv;
fs.mkdirSync(outDir, { recursive: true });
let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures++;
};
const consoleErrors = [];
// Styled switches hide the real checkbox; click the visible slider next to it like a person would
async function setSwitch(page, inputSel, on) {
  const input = page.locator(inputSel);
  if ((await input.isChecked()) !== on) await input.locator("xpath=following-sibling::span").click();
  await page.waitForTimeout(300);
  if ((await input.isChecked()) !== on) throw new Error(`switch ${inputSel} did not change`);
}

(async () => {
  const profile = fs.mkdtempSync(path.join(outDir, "profile-"));
  const launch = () => chromium.launchPersistentContext(profile, {
    executablePath,
    headless: false,
    viewport: { width: 1000, height: 700 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  let ctx = await launch();
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;

  const popup = await ctx.newPage();
  popup.on("console", (m) => m.type() === "error" && consoleErrors.push(`popup: ${m.text()}`));
  popup.on("pageerror", (e) => consoleErrors.push(`popup: ${e.message}`));
  await popup.setViewportSize({ width: 600, height: 600 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  check(await popup.locator('button[data-page="focus"]').count() === 1, "Focus tab in the nav");
  check(await popup.locator('button[data-page="summarize"]').count() === 1, "Summarize tab still in the nav");
  await popup.click('button[data-page="focus"]');
  await popup.waitForSelector("#page-focus", { state: "visible" });
  check(await popup.locator(".focus-chip").count() === 8, "8 quick-add chips");
  check((await popup.textContent("#focusList")).includes("No sites blocked yet"), "empty list message");

  // Add x.com via chip, reddit via URL normalisation
  await popup.click('.focus-chip[data-host="x.com"]');
  await popup.waitForSelector('.focus-item:has-text("x.com")');
  check(await popup.locator('.focus-chip.added[data-host="x.com"]').count() === 1, "x.com chip greyed out after adding");
  await popup.fill("#focusHostInput", "https://www.reddit.com/r/foo");
  await popup.press("#focusHostInput", "Enter");
  await popup.waitForSelector('.focus-item .host:text-is("reddit.com")');
  check(true, "https://www.reddit.com/r/foo normalised to reddit.com");
  await popup.fill("#focusHostInput", "reddit.com");
  await popup.click("#focusAddBtn");
  await popup.waitForTimeout(300);
  check(await popup.locator(".focus-item").count() === 2, "duplicate not added");
  await setSwitch(popup, "#focusEnabled", true);
  await popup.screenshot({ path: path.join(outDir, "1-focus-tab.png") });

  // Visit blocked sites
  const tab = await ctx.newPage();
  tab.on("console", (m) => m.type() === "error" && consoleErrors.push(`tab: ${m.text()}`));
  const visit = async (url) => {
    await tab.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await tab.waitForTimeout(2500);
    return tab.url();
  };
  const blockedUrl = (u) => u.startsWith(`chrome-extension://${extId}/blocked.html`);

  let u = await visit("https://x.com/");
  check(blockedUrl(u), `x.com redirects to the block page (${u.slice(0, 80)})`);
  const shown = await tab.textContent("#host").catch(() => null);
  check(shown === "x.com", `block page names the site (shows "${shown}")`);
  const title = await tab.title().catch(() => "");
  check(title.includes("x.com"), `block page title names the site ("${title}")`);
  await tab.screenshot({ path: path.join(outDir, "2-blocked-page.png") });

  u = await visit("https://mobile.x.com/");
  check(blockedUrl(u), "mobile.x.com also blocked (suffix match)");
  u = await visit("https://www.reddit.com/");
  check(blockedUrl(u), "www.reddit.com blocked");
  u = await visit("https://en.wikipedia.org/wiki/Focus");
  check(u.includes("wikipedia.org"), "unlisted site loads normally");

  // iframe to a blocked host must not redirect the top tab
  await visit("https://example.com/");
  const frameNav = tab.waitForEvent("framenavigated", { predicate: (f) => f !== tab.mainFrame(), timeout: 15000 }).then(() => true, () => false);
  await tab.evaluate(() => { const f = document.createElement("iframe"); f.src = "https://x.com/"; document.body.appendChild(f); });
  check(await frameNav, "iframe to x.com actually started loading (test is meaningful)");
  await tab.waitForTimeout(2500);
  check(!blockedUrl(tab.url()), "iframe to x.com does not redirect the tab");

  // Per-site switch off
  await setSwitch(popup, '.focus-item:has-text("x.com") input[data-toggle]', false);
  u = await visit("https://x.com/");
  check(!blockedUrl(u), "x.com loads with its switch off");
  u = await visit("https://www.reddit.com/");
  check(blockedUrl(u), "reddit.com still blocked");

  // Master toggle off
  await setSwitch(popup, "#focusEnabled", false);
  u = await visit("https://www.reddit.com/");
  check(!blockedUrl(u), "focus mode off: reddit.com loads");
  await setSwitch(popup, "#focusEnabled", true);

  // Persistence across a browser restart
  await ctx.close();
  ctx = await launch();
  [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const p2 = await ctx.newPage();
  await p2.goto(`chrome-extension://${extId}/popup.html`);
  await p2.click('button[data-page="focus"]');
  await p2.waitForTimeout(400);
  check(await p2.isChecked("#focusEnabled"), "after restart: focus mode still on");
  check(await p2.locator(".focus-item").count() === 2, "after restart: both sites kept");
  check(!(await p2.isChecked('.focus-item:has-text("x.com") input[data-toggle]')), "after restart: x.com switch still off");

  await ctx.close();
  if (consoleErrors.length) console.log("console errors:\n  " + consoleErrors.join("\n  "));
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
