// Tests PR 2: the tab cleaner skips excluded tab groups. Usage: node groups_test.cjs <extDir> <outDir>
const { chromium, executablePath } = require("./browser.cjs");
const fs = require("fs");
const path = require("path");
const http = require("http");

const [, , extDir, outDir] = process.argv;
fs.mkdirSync(outDir, { recursive: true });
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) failures++; };
const server = http.createServer((q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(`<title>${q.url}</title>${q.url}`); });

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(outDir, "profile-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: false, viewport: { width: 900, height: 700 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;

  // Tabs: two in "Work", two in "Misc", one ungrouped
  const make = (names) => sw.evaluate(async ({ base, names }) => {
    const ids = {};
    for (const n of names) ids[n] = (await chrome.tabs.create({ url: `${base}/${n}`, active: false })).id;
    return ids;
  }, { base, names });
  const group = (ids, title, color) => sw.evaluate(async ({ ids, title, color }) => {
    const gid = await chrome.tabs.group({ tabIds: ids });
    await chrome.tabGroups.update(gid, { title, color });
    return gid;
  }, { ids, title, color });
  const alive = () => sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => new URL(t.url || t.pendingUrl || "about:blank").pathname.slice(1)));
  const runCleanup = async () => {
    await sw.evaluate(() => chrome.storage.local.set({ timeoutMin: 0.02 })); // 1.2 s
    await new Promise((r) => setTimeout(r, 2500));
    await sw.evaluate(() => chrome.alarms.create("tabCleanup", { when: Date.now() + 200 }));
    await new Promise((r) => setTimeout(r, 2500));
  };

  let ids = await make(["work1", "work2", "misc1", "misc2", "loose"]);
  await group([ids.work1, ids.work2], "Work", "blue");
  await group([ids.misc1, ids.misc2], "Misc", "red");

  // Popup UI: the groups are listed; exclude "Work"
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.click('button[data-page="tabcleaner"]');
  await popup.waitForSelector("#groupList .group-item");
  const titles = await popup.locator("#groupList .group-title").allTextContents();
  check(titles.includes("Work") && titles.includes("Misc"), `popup lists the groups (${titles.join(", ")})`);
  await popup.locator('#groupList input[data-title="Work"] + .slider').click();
  await popup.waitForTimeout(300);
  check(JSON.stringify((await sw.evaluate(() => chrome.storage.local.get("excludedGroupTitles"))).excludedGroupTitles) === '["Work"]', "Work saved as excluded");
  await popup.screenshot({ path: path.join(outDir, "groups-popup.png") });

  await runCleanup();
  let left = await alive();
  console.log("     tabs left:", left.join(", "));
  check(left.includes("work1") && left.includes("work2"), "tabs in the excluded Work group stay open");
  check(!left.includes("misc1") && !left.includes("misc2"), "tabs in the Misc group are closed");
  check(!left.includes("loose"), "ungrouped idle tab is closed");

  // Exclude all groups
  ids = await make(["misc3", "loose2"]);
  await group([ids.misc3], "Misc", "red");
  await popup.reload();
  await popup.click('button[data-page="tabcleaner"]');
  await popup.locator("#excludeAllGroups + .slider").click();
  await popup.waitForTimeout(300);
  check((await sw.evaluate(() => chrome.storage.local.get("excludeAllGroups"))).excludeAllGroups === true, "Exclude all tab groups saved");
  check(await popup.locator("#groupList.dimmed").count() === 1, "group list dimmed while all are excluded");
  await runCleanup();
  left = await alive();
  console.log("     tabs left:", left.join(", "));
  check(left.includes("misc3") && left.includes("work1"), "with Exclude all, every grouped tab stays");
  check(!left.includes("loose2"), "ungrouped idle tab still closed");

  await ctx.close(); server.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
