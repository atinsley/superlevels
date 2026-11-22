// Tests per-site exclusions for the cookie banner dismisser. Usage: node nocookie_test.cjs <extDir> <outDir>
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
  r.end(`<!doctype html><title>${q.headers.host}</title><body><h1>${q.headers.host}</h1><div id="cookie-banner" style="padding:20px;background:#fc0">We use cookies</div></body>`);
});

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const P = server.address().port;
  const url = (h) => `http://${h}:${P}/`;
  const profile = fs.mkdtempSync(path.join(outDir, "profile-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: false, viewport: { width: 900, height: 700 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;

  const bannerShown = async (p) => { await p.waitForTimeout(600); return p.locator("#cookie-banner").isVisible(); };
  const visit = async (h) => { const p = await ctx.newPage(); await p.goto(url(h)); return p; };

  const www = await visit("www.shop.localhost");
  check(!(await bannerShown(www)), "banner hidden by default on www.shop.localhost");

  let target = url("www.shop.localhost");
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
  await popup.click('button[data-page="nocookie"]');
  await popup.waitForFunction(() => document.getElementById("nocookieHost").textContent.length > 0);
  check((await popup.textContent("#nocookieHost")) === "shop.localhost", `site shown without www: "${await popup.textContent("#nocookieHost")}"`);
  check(await popup.locator("#nocookieExclHeader").isHidden(), "no list yet");
  await popup.click("#nocookieExcludeBtn");
  await popup.waitForFunction(() => /Dismiss here again/.test(document.getElementById("nocookieExcludeBtn").textContent));
  check(JSON.stringify((await sw.evaluate(() => chrome.storage.local.get("nocookie_exclusions"))).nocookie_exclusions) === '["shop.localhost"]', "saved as shop.localhost");
  check(await bannerShown(www), "banner comes back right away on the open page");
  check(/Reload the page/.test(await popup.textContent("#nocookieSiteNote")), "note about already-accepted banners");
  check(await popup.locator("#nocookieExclList .item").count() === 1 && await popup.locator("#nocookieExclHeader").isVisible(), "site listed under 'Switched off on'");
  await popup.screenshot({ path: path.join(outDir, "nocookie-popup.png") });

  check(await bannerShown(await visit("shop.localhost")), "bare shop.localhost also excluded");
  check(await bannerShown(await visit("deep.shop.localhost")), "subdomain deep.shop.localhost also excluded");
  const other = await visit("other.localhost");
  check(!(await bannerShown(other)), "other.localhost still dismissed");

  // Global switch still works on its own
  target = url("other.localhost");
  await popup.reload();
  await popup.click('button[data-page="nocookie"]');
  await popup.locator("#nocookieToggle + .big-slider").click();
  check(await bannerShown(other), "global switch off: banner shows on other.localhost too");
  await popup.locator("#nocookieToggle + .big-slider").click();
  check(!(await bannerShown(other)), "global switch on again: dismissed again");

  // Remove from the list
  await popup.locator('#nocookieExclList button[data-nchost="shop.localhost"]').click();
  await popup.waitForTimeout(300);
  check(((await sw.evaluate(() => chrome.storage.local.get("nocookie_exclusions"))).nocookie_exclusions || []).length === 0, "× removes the site");
  await www.reload();
  check(!(await bannerShown(www)), "after removing, banner dismissed again on reload");

  // Non-web tab: no site box
  target = `chrome-extension://${extId}/popup.html`;
  await popup.reload();
  await popup.click('button[data-page="nocookie"]');
  await popup.waitForTimeout(300);
  check(await popup.locator("#nocookieSite").isHidden(), "no site box on a non-web tab");

  await ctx.close(); server.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
