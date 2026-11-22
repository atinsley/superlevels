// Tests dark mode Off / On / Auto (follow system). Usage: node dark_test.cjs <extDir> <outDir>
const { chromium, executablePath } = require("./browser.cjs");
const fs = require("fs");
const path = require("path");
const http = require("http");

const [, , extDir, outDir] = process.argv;
fs.mkdirSync(outDir, { recursive: true });
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) failures++; };
const server = http.createServer((q, r) => {
  const dark = q.headers.host.startsWith("night.");
  r.writeHead(200, { "content-type": "text/html" });
  r.end(`<!doctype html><title>${q.headers.host}</title><body style="background:${dark ? "#111" : "#fff"};color:${dark ? "#eee" : "#111"}"><h1>${q.headers.host}</h1><p>Text</p></body>`);
});

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const P = server.address().port;
  const url = (h) => `http://${h}:${P}/`;
  const profile = fs.mkdtempSync(path.join(outDir, "profile-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: false, viewport: { width: 900, height: 700 }, colorScheme: "light",
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;
  const isDark = async (p) => { await p.waitForTimeout(500); return p.evaluate(() => document.documentElement.classList.contains("superlevels-dark")); };
  const store = () => sw.evaluate(() => chrome.storage.local.get(null));

  let target = url("day.localhost");
  const page = await ctx.newPage();
  await page.goto(target);
  const popup = await ctx.newPage();
  await popup.exposeBinding("__target", () => target);
  await popup.addInitScript(() => {
    const real = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (q) => {
      if (!(q && q.active && q.currentWindow)) return real(q);
      const u = await window.__target();
      return (await real({})).filter((t) => t.url === u);
    };
  });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.click('button[data-page="darkmode"]');
  await popup.waitForTimeout(300);
  const mode = (m) => popup.click(`#darkModePill button[data-mode="${m}"]`);
  const active = () => popup.getAttribute("#darkModePill button.active", "data-mode");

  check((await active()) === "off" && (await popup.textContent("#darkStatus")) === "OFF", "starts Off");
  await mode("on");
  check(await isDark(page) && (await store())["darkmode_day.localhost"] === true, "On: page goes dark, stored as true (same as before)");
  await mode("off");
  check(!(await isDark(page)) && (await store())["darkmode_day.localhost"] === false, "Off: page back to normal, stored as false");

  await mode("system");
  check((await store())["darkmode_day.localhost"] === "system", "Auto stored as \"system\"");
  check(!(await isDark(page)), "Auto with a light system: page stays light");
  check((await popup.textContent("#darkStatus")) === "AUTO · light now", `status "${await popup.textContent("#darkStatus")}"`);
  await page.emulateMedia({ colorScheme: "dark" });
  check(await isDark(page), "system switches to dark: page goes dark live");
  await page.emulateMedia({ colorScheme: "light" });
  check(!(await isDark(page)), "system back to light: page back to light live");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  check(await isDark(page), "Auto + dark system on reload: dark from the start");
  await popup.emulateMedia({ colorScheme: "dark" });
  await popup.reload();
  await popup.click('button[data-page="darkmode"]');
  await popup.waitForTimeout(300);
  check((await active()) === "system" && (await popup.textContent("#darkStatus")) === "AUTO · dark now", "popup reopens on Auto, says dark now");
  await popup.screenshot({ path: path.join(outDir, "dark-auto.png") });

  // A page that is already dark is not inverted in Auto either
  const night = await ctx.newPage();
  await night.emulateMedia({ colorScheme: "dark" });
  target = url("night.localhost");
  await night.goto(target);
  await popup.reload();
  await popup.click('button[data-page="darkmode"]');
  await popup.waitForTimeout(300);
  await mode("system");
  check(!(await isDark(night)) && (await store())["darkmode_pageIsDark_night.localhost"] === true, "Auto on an already-dark page: left alone and remembered");

  // All sites: Auto, clears per-site leftovers
  await popup.click("#scopeGlobal");
  await mode("system");
  const s = await store();
  check(s.darkmode_global === "system" && s["darkmode_day.localhost"] === undefined, "All sites + Auto: stored globally, per-site leftovers cleared");
  const third = await ctx.newPage();
  await third.emulateMedia({ colorScheme: "dark" });
  await third.goto(url("third.localhost"));
  check(await isDark(third), "a new site follows the global Auto (dark system)");
  await third.emulateMedia({ colorScheme: "light" });
  check(!(await isDark(third)), "…and turns light with the system");

  // Old stored value true still works
  await sw.evaluate(() => chrome.storage.local.set({ darkmode_global: true }));
  const legacy = await ctx.newPage();
  await legacy.goto(url("legacy.localhost"));
  check(await isDark(legacy), "an existing setting of true still turns pages dark");

  await ctx.close(); server.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
