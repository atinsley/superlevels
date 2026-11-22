// Tests the tab cleaner "subdomains" switch. Usage: node exact_test.cjs <extDir> <outDir>
const { chromium, executablePath } = require("./browser.cjs");
const fs = require("fs");
const path = require("path");
const http = require("http");

const [, , extDir, outDir] = process.argv;
fs.mkdirSync(outDir, { recursive: true });
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) failures++; };
const server = http.createServer((q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(`<title>${q.headers.host}${q.url}</title>ok`); });

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const P = server.address().port;
  const profile = fs.mkdtempSync(path.join(outDir, "profile-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: false, viewport: { width: 900, height: 700 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;

  const open = (urls) => sw.evaluate(async (urls) => { for (const url of urls) await chrome.tabs.create({ url, active: false }); }, urls);
  const alive = () => sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => { try { const u = new URL(t.url || t.pendingUrl); return u.hostname + u.pathname; } catch { return ""; } }));
  const runCleanup = async () => {
    await sw.evaluate(() => chrome.storage.local.set({ timeoutMin: 0.02 }));
    await new Promise((r) => setTimeout(r, 2500));
    await sw.evaluate(() => chrome.alarms.create("tabCleanup", { when: Date.now() + 200 }));
    await new Promise((r) => setTimeout(r, 2500));
  };
  const urls = (tag) => [`http://localhost:${P}/${tag}`, `http://sub.localhost:${P}/${tag}`, `http://127.0.0.1:${P}/${tag}`];

  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.click('button[data-page="tabcleaner"]');
  await popup.fill("#hostInput", "localhost");
  await popup.press("#hostInput", "Enter");
  await popup.waitForSelector('#list input[data-sub="localhost"]');
  check(await popup.isChecked('#list input[data-sub="localhost"]'), "new exclusion covers subdomains by default");
  await popup.fill("#hostInput", "LOCALHOST");
  await popup.press("#hostInput", "Enter");
  check(await popup.locator("#list .item").count() === 1, "adding the same host again doesn't duplicate it");

  await open(urls("one"));
  await runCleanup();
  let left = await alive();
  console.log("     left:", left.filter(Boolean).join(", "));
  check(left.includes("localhost/one") && left.includes("sub.localhost/one"), "subdomains on: localhost and sub.localhost stay open");
  check(!left.includes("127.0.0.1/one"), "unrelated idle tab closed");

  await popup.reload();
  await popup.click('button[data-page="tabcleaner"]');
  await popup.locator('#list input[data-sub="localhost"]').click();
  await popup.waitForSelector('#list input[data-sub="exact:localhost"]');
  check(JSON.stringify((await sw.evaluate(() => chrome.storage.local.get("exclusions"))).exclusions) === '["exact:localhost"]', "switch off saves exact:localhost");
  check((await popup.locator("#list .exc-host").textContent()).trim() === "localhost", "list still shows the plain host name");
  await popup.screenshot({ path: path.join(outDir, "exclusions.png") });
  await popup.fill("#hostInput", "localhost");
  await popup.press("#hostInput", "Enter");
  check(await popup.locator("#list .item").count() === 1, "adding localhost when exact:localhost exists doesn't duplicate");

  await open(urls("two"));
  await runCleanup();
  left = await alive();
  console.log("     left:", left.filter(Boolean).join(", "));
  check(left.includes("localhost/two"), "subdomains off: localhost stays open");
  check(!left.includes("sub.localhost/two"), "subdomains off: sub.localhost is closed");

  await popup.reload();
  await popup.click('button[data-page="tabcleaner"]');
  await popup.locator('#list button[data-host="exact:localhost"]').click();
  await popup.waitForTimeout(300);
  check(((await sw.evaluate(() => chrome.storage.local.get("exclusions"))).exclusions || []).length === 0, "× removes an exact: entry");

  await ctx.close(); server.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
