// Tests that website lists are put in alphabetical order when you leave them.
// Usage: node sort_test.cjs <extDir> <outDir>
const { chromium, executablePath } = require("./browser.cjs");
const fs = require("fs");
const path = require("path");

const [, , extDir, outDir] = process.argv;
fs.mkdirSync(outDir, { recursive: true });
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) failures++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const profile = fs.mkdtempSync(path.join(outDir, "profile-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath, headless: false, viewport: { width: 600, height: 600 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;
  const get = (k) => sw.evaluate((k) => chrome.storage.local.get(k).then((d) => d[k]), k);
  const popup = await ctx.newPage();
  const open = async () => { await popup.goto(`chrome-extension://${extId}/popup.html`); await popup.waitForTimeout(500); };
  const go = async (id) => { await popup.click(`.nav button[data-page="${id}"]`); await popup.waitForTimeout(400); };
  await open();

  // ── No paywall (text box) ──
  await go("archive");
  const shown = (await popup.inputValue("#archiveSites")).split("\n");
  check(same(shown, [...shown].sort((a, b) => a.localeCompare(b))), "built-in list is shown in alphabetical order");
  check((await get("archive_sites")) === undefined, "built-in list is not saved (future additions still arrive)");

  await popup.fill("#archiveSites", "zeta.com\nalpha.com\nhttps://www.Mid.com/some/article\nalpha.com");
  await popup.click("#archiveStatus"); // click somewhere else on the page
  await popup.waitForTimeout(500);
  check((await popup.inputValue("#archiveSites")) === "alpha.com\nmid.com\nzeta.com", `clicking out sorts the box, tidies it and drops the duplicate: "${(await popup.inputValue("#archiveSites")).replace(/\n/g, " | ")}"`);
  check(same(await get("archive_sites"), ["alpha.com", "mid.com", "zeta.com"]), "sorted list saved");

  await popup.fill("#archiveSites", "bravo.com\nalpha.com");
  await go("focus"); // straight to another section, no pause
  check(same(await get("archive_sites"), ["alpha.com", "bravo.com"]), "switching sections right after typing saves it sorted");
  await go("archive");
  check((await popup.inputValue("#archiveSites")) === "alpha.com\nbravo.com", "coming back shows it sorted");

  await popup.fill("#archiveSites", "");
  await go("tabcleaner");
  check(same(await get("archive_sites"), []), "emptying the box and leaving straight away keeps it empty");

  // ── Tab cleaner exclusions ──
  for (const h of ["zeta.com", "alpha.com", "middle.com", "Beta.com"]) {
    await popup.fill("#hostInput", h);
    await popup.press("#hostInput", "Enter");
  }
  await popup.locator('#list input[data-sub="middle.com"]').click(); // -> exact:middle.com
  await popup.waitForTimeout(300);
  const typedOrder = await popup.locator("#list .exc-host").allTextContents();
  check(same(typedOrder, ["zeta.com", "alpha.com", "middle.com", "beta.com"]), "new hosts stay in the order added while you work");
  await go("darkmode");
  check(same(await get("exclusions"), ["alpha.com", "beta.com", "exact:middle.com", "zeta.com"]), "leaving Tabs sorts the saved list (exact: marker ignored for order)");
  await go("tabcleaner");
  check(same(await popup.locator("#list .exc-host").allTextContents(), ["alpha.com", "beta.com", "middle.com", "zeta.com"]), "Tabs list shown sorted when you come back");
  check(!(await popup.isChecked('#list input[data-sub="exact:middle.com"]')), "middle.com keeps its subdomains switch off");

  // ── Focus Blocker ──
  await go("focus");
  for (const h of ["x.com", "reddit.com", "youtube.com"]) await popup.click(`.focus-chip[data-host="${h}"]`);
  await popup.fill("#focusHostInput", "Apple.com");
  await popup.press("#focusHostInput", "Enter");
  await popup.waitForTimeout(300);
  await popup.locator('.focus-item:has-text("reddit.com") .slider-sm').click();
  await popup.waitForTimeout(300);
  await go("cookies");
  const focus = await get("focus_sites");
  check(same(focus.map((s) => s.host), ["apple.com", "reddit.com", "x.com", "youtube.com"]), `leaving Focus sorts its sites (${focus.map((s) => s.host).join(", ")})`);
  check(focus.find((s) => s.host === "reddit.com").on === false && focus.find((s) => s.host === "x.com").on === true, "each site keeps its on/off switch");
  await go("focus");
  check(same(await popup.locator(".focus-item .host").allTextContents(), ["apple.com", "reddit.com", "x.com", "youtube.com"]), "Focus list shown sorted when you come back");

  // ── Lists left unsorted (popup closed mid-edit) are sorted when the popup opens ──
  await sw.evaluate(() => chrome.storage.local.set({
    exclusions: ["zz.com", "aa.com"],
    nocookie_exclusions: ["zeta.localhost", "Alpha.localhost", "mid.localhost"],
  }));
  await open();
  check(same(await get("exclusions"), ["aa.com", "zz.com"]), "opening the popup sorts the Tabs list");
  check(same(await get("nocookie_exclusions"), ["Alpha.localhost", "mid.localhost", "zeta.localhost"]), "opening the popup sorts the Cookies=OK list (case-insensitive)");
  await go("nocookie");
  check(same(await popup.locator("#nocookieExclList .item span").allTextContents(), ["Alpha.localhost", "mid.localhost", "zeta.localhost"]), "Cookies=OK list shown sorted");
  await popup.screenshot({ path: path.join(outDir, "sorted.png") });

  await ctx.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
