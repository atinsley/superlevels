// Tests the cookie editor filter. Usage: node cookie_test.cjs <extDir> <outDir>
const { chromium, executablePath } = require("./browser.cjs");
const fs = require("fs");
const path = require("path");
const http = require("http");

const [, , extDir, outDir] = process.argv;
fs.mkdirSync(outDir, { recursive: true });
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) failures++; };
const server = http.createServer((q, r) => {
  r.writeHead(200, { "content-type": "text/html" });
  r.end(`<title>cookies</title><script>["session_a","session_b","track_x","track_y","keep"].forEach(n => document.cookie = n + "=v_" + n + "; path=/; max-age=3600");</script>ok`);
});

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const site = `http://127.0.0.1:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(outDir, "profile-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: false, viewport: { width: 900, height: 700 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;
  const page = await ctx.newPage();
  await page.goto(site);
  const other = await ctx.newPage();
  await other.goto("https://example.com/");
  let targetUrl = site;
  const popup = await ctx.newPage();
  await popup.exposeBinding("__target", () => targetUrl);
  await popup.addInitScript(() => {
    const real = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (q) => {
      if (!(q && q.active && q.currentWindow)) return real(q);
      const u = await window.__target();
      return (await real({})).filter((t) => t.url === u);
    };
  });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.click('button[data-page="cookies"]');
  await popup.waitForSelector(".cookie-item");
  const names = () => popup.locator(".cookie-item .cookie-name, .cookie-item .name").allTextContents();
  const jarNames = async () => (await sw.evaluate((u) => chrome.cookies.getAll({ url: u }), site)).map((c) => c.name).sort();

  check((await popup.textContent("#cookieCount")).trim() === "5", "5 cookies, no filter");
  check(await popup.locator("#btnClearCookieFilter").isHidden() && await popup.locator("#btnDeleteFiltered").isHidden() && await popup.locator("#btnDeleteAll").isVisible(), "no filter: Delete All shown, Delete Filtered and × hidden");

  await popup.fill("#cookieFilter", "TRACK");
  check((await popup.textContent("#cookieCount")).trim() === "2 of 5", `filter is case-insensitive: count "${(await popup.textContent("#cookieCount")).trim()}"`);
  check(await popup.locator(".cookie-item").count() === 2, "2 rows shown");
  check(await popup.locator("#btnDeleteAll").isHidden() && await popup.locator("#btnDeleteFiltered").isVisible() && await popup.locator("#btnClearCookieFilter").isVisible(), "filter on: Delete Filtered and × shown, Delete All hidden");
  await popup.screenshot({ path: path.join(outDir, "filter.png") });

  // Delete the FIRST visible row (track_x). Index bug would delete session_a instead.
  const firstRowText = await popup.locator(".cookie-item").first().textContent();
  await popup.locator(".cookie-item").first().locator(".cookie-del").click();
  await popup.waitForTimeout(500);
  let jar = await jarNames();
  check(firstRowText.includes("track_x"), "first filtered row is track_x");
  check(!jar.includes("track_x") && jar.includes("session_a"), `row delete removes the cookie shown, not another one (left: ${jar.join(", ")})`);
  check((await popup.inputValue("#cookieFilter")) === "TRACK" && (await popup.textContent("#cookieCount")).trim() === "1 of 4", "filter kept after a single delete");

  await popup.fill("#cookieFilter", "nothing-matches");
  check((await popup.textContent("#cookieList")).includes("No cookies match"), "no-match message");

  await popup.fill("#cookieFilter", "session");
  await popup.click("#btnDeleteFiltered");
  await popup.waitForTimeout(500);
  jar = await jarNames();
  check(JSON.stringify(jar) === JSON.stringify(["keep", "track_y"]), `Delete Filtered removes only matches (left: ${jar.join(", ")})`);
  check((await popup.inputValue("#cookieFilter")) === "" && (await popup.textContent("#cookieCount")).trim() === "2", "filter cleared afterwards, count 2");

  await popup.fill("#cookieFilter", "keep");
  await popup.click("#btnClearCookieFilter");
  check((await popup.inputValue("#cookieFilter")) === "" && await popup.locator(".cookie-item").count() === 2, "× clears the filter");

  await popup.fill("#cookieFilter", "keep");
  targetUrl = "https://example.com/";
  await popup.click("#btnRefresh");
  await popup.waitForTimeout(400);
  check((await popup.inputValue("#cookieFilter")) === "", "switching to another site clears the filter");

  await ctx.close(); server.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
