// Tests the Settings tab (menu order + hidden tabs). Usage: node settings_test.cjs <extDir> <outDir>
const { chromium, executablePath } = require("./browser.cjs");
const fs = require("fs");
const path = require("path");

const [, , extDir, outDir] = process.argv;
fs.mkdirSync(outDir, { recursive: true });
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) failures++; };

(async () => {
  const profile = fs.mkdtempSync(path.join(outDir, "profile-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: false, viewport: { width: 600, height: 600 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 600, height: 600 });
  const open = async () => { await popup.goto(`chrome-extension://${extId}/popup.html`); await popup.waitForTimeout(400); };
  const navIds = () => popup.$$eval(".nav button[data-page]", (bs) => bs.filter((b) => !b.hidden).map((b) => b.dataset.page));
  const store = () => sw.evaluate(() => chrome.storage.local.get(["nav_order", "nav_hidden"]));
  const activePage = () => popup.getAttribute(".nav button.active", "data-page");

  await open();
  const defaults = await navIds();
  check(defaults.length === 22 && defaults.at(-1) === "settings", `Settings is the last of ${defaults.length} nav buttons`);
  await popup.click('.nav button[data-page="settings"]');
  await popup.waitForSelector("#settingsList .set-row");
  check(await popup.locator(".set-row").count() === 21, "21 tabs listed");
  check((await popup.textContent("#settingsCount")) === "21 of 21 tabs in the menu", "counter 21 of 21");
  const labels = await popup.locator(".set-row .set-label").allTextContents();
  check(labels[0] === "🚮 Tabs" && labels.includes("📸 Screenshot") && labels.includes("🎯 Focus"), "labels come from the menu itself, newer tabs included");

  // Hide PiP
  await popup.locator('.set-row[data-id="pip"] .slider-sm').click();
  await popup.waitForTimeout(300);
  check(!(await navIds()).includes("pip"), "hiding PiP removes it from the menu");
  check(JSON.stringify((await store()).nav_hidden) === '["pip"]', "saved as nav_hidden");
  check((await popup.textContent("#settingsCount")) === "20 of 21 tabs in the menu" && await popup.locator('.set-row.hidden-tab[data-id="pip"]').count() === 1, "counter and row show it hidden");

  // Move Summarize up three places with ↑
  const before = (await navIds()).indexOf("summarize");
  for (let i = 0; i < 3; i++) { await popup.locator('.set-row[data-id="summarize"] button[data-move="-1"]').click(); await popup.waitForTimeout(150); }
  check((await navIds()).indexOf("summarize") === before - 3, "↑ moves Summarize up three places in the menu");
  check(await popup.locator('.set-row').first().locator('button[data-move="-1"]').isDisabled(), "first row's ↑ is disabled");

  // Drag JSON to the top (tall window so every row is on screen: no scrolling mid-drag)
  await popup.setViewportSize({ width: 600, height: 1100 });
  await popup.evaluate(() => { document.body.style.height = "1100px"; });
  await popup.waitForTimeout(200);
  await popup.locator('.set-row[data-id="jsonformat"] .grip').dragTo(popup.locator('.set-row[data-id="tabcleaner"]'), { targetPosition: { x: 20, y: 3 } });
  await popup.waitForTimeout(300);
  check((await navIds())[0] === "jsonformat", `drag and drop puts JSON first (menu starts ${(await navIds()).slice(0, 3).join(", ")})`);
  await popup.screenshot({ path: path.join(outDir, "settings.png") });
  await popup.setViewportSize({ width: 600, height: 600 });

  // Persist across reopening; last tab hidden -> first visible
  await sw.evaluate(() => chrome.storage.local.set({ last_tab: "pip" }));
  await open();
  const ids = await navIds();
  check(ids[0] === "jsonformat" && !ids.includes("pip") && ids.at(-1) === "settings", "order and hidden tab kept after reopening");
  check((await activePage()) === "jsonformat", `last tab was hidden: opens the first visible tab (${await activePage()})`);

  // Show all / Reset order
  await popup.click('.nav button[data-page="settings"]');
  await popup.waitForSelector(".set-row");
  await popup.click("#settingsShowAll");
  await popup.waitForTimeout(300);
  check((await navIds()).includes("pip") && (await popup.textContent("#settingsCount")) === "21 of 21 tabs in the menu", "Show all brings PiP back");
  await popup.click("#settingsReset");
  await popup.waitForTimeout(300);
  check(JSON.stringify(await navIds()) === JSON.stringify(defaults), "Reset order restores the default order");

  // An order saved before a tab existed (and with a tab that no longer exists)
  await sw.evaluate((d) => chrome.storage.local.set({ nav_order: ["jsonformat", "oldtab", ...d.filter((x) => x !== "jsonformat" && x !== "screenshot" && x !== "settings")] }), defaults);
  await open();
  const after = await navIds();
  check(after[0] === "jsonformat" && !after.includes("oldtab"), "saved order applied, unknown tab ignored");
  check(after.indexOf("screenshot") === after.indexOf("pip") + 1, "a tab missing from the saved order appears after its usual neighbour");

  // Clicking a tab still works after reordering
  await popup.click('.nav button[data-page="darkmode"]');
  check(await popup.locator("#page-darkmode").isVisible(), "tabs still open after reordering");

  await ctx.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
