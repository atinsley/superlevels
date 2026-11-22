// Tests element capture (picker + region screenshot). Usage: node elem_test.cjs <extDir> <outDir>
const { chromium, executablePath } = require("./browser.cjs");
const fs = require("fs");
const path = require("path");
const http = require("http");

const [, , extDir, outDir] = process.argv;
fs.mkdirSync(outDir, { recursive: true });
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) failures++; };
const pngSize = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
const band = (i, h, w = "100%") => `<div class="band" style="height:${h}px;width:${w};background:hsl(${(i * 37) % 360},70%,60%)"></div>`;

const PAGES = {
  "/receipt": `<!doctype html><html><head><title>Order 1234</title><style>body{margin:0;font:14px sans-serif}</style></head><body>
    <div style="height:3000px;background:#eee">filler <button id="btn" onclick="this.dataset.n=(+this.dataset.n||0)+1">count</button></div>
    <div id="receipt" style="width:600px;margin-left:100px;background:#fff">${Array.from({ length: 9 }, (_, i) => band(i, 100)).join("")}</div>
    <div style="height:3000px;background:#ddd"></div></body></html>`,
  "/tall": `<!doctype html><html><head><title>Tall</title><style>body{margin:0}</style></head><body>
    <div style="height:500px"></div>
    <div id="long" style="width:800px;margin-left:50px">${Array.from({ length: 12 }, (_, i) => band(i, 1000)).join("")}</div>
    <div style="height:2000px"></div></body></html>`,
};
const server = http.createServer((req, res) => {
  const p = PAGES[req.url.split("?")[0]];
  res.writeHead(p ? 200 : 404, { "content-type": "text/html" });
  res.end(p || "nope");
});

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(outDir, "profile-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: false, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, acceptDownloads: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;

  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.click('button[data-page="screenshot"]');
  check(await popup.locator("#shotPickBtn").isVisible(), "Pick an element button shown");
  let targetId = null;
  await popup.exposeBinding("__target", () => targetId);
  await popup.evaluate(() => {
    const real = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (q) => (q && q.active && q.currentWindow ? [await chrome.tabs.get(await window.__target())] : real(q));
  });

  const open = async (p, scrollSel) => {
    const page = await ctx.newPage();
    await page.goto(base + p);
    await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: "start" }), scrollSel);
    targetId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, page.url());
    await page.bringToFront();
    await popup.evaluate(() => document.getElementById("shotPickBtn").click());
    await page.waitForTimeout(500);
    await page.bringToFront();
    return page;
  };
  const overlay = (page) => page.evaluate(() => {
    const box = [...document.documentElement.children].find((e) => e.style && e.style.border && e.style.border.includes("2px solid"));
    return box && box.style.display !== "none" ? { w: parseFloat(box.style.width), h: parseFloat(box.style.height) } : null;
  });

  // ── Esc cancels ──
  let page = await open("/receipt", "#receipt");
  check(await page.evaluate(() => document.body.innerText.includes("")) && (await page.locator("text=Click an element to capture it").count()) === 1, "picker hint shown on the page");
  await page.mouse.move(400, 150);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check((await page.locator("text=Click an element to capture it").count()) === 0 && !(await overlay(page)), "Esc removes the picker");
  const tabsBefore = ctx.pages().length;
  await page.evaluate(() => scrollTo(0, 0));
  await page.click("#btn");
  check((await page.getAttribute("#btn", "data-n")) === "1", "page clicks work again after Esc");
  await page.waitForTimeout(1000);
  check(ctx.pages().length === tabsBefore, "no preview opened after Esc");
  await page.close();

  // ── Receipt: hover a band, ↑ to the receipt, click ──
  page = await open("/receipt", "#receipt");
  await page.mouse.move(400, 150); // inside band 1 of the receipt
  await page.waitForTimeout(200);
  let ov = await overlay(page);
  check(ov && ov.w === 600 && ov.h === 100, `hover highlights the band under the mouse (${JSON.stringify(ov)})`);
  await page.keyboard.press("ArrowUp");
  ov = await overlay(page);
  check(ov && ov.w === 600 && ov.h === 900, `↑ selects the whole receipt (${JSON.stringify(ov)})`);
  await page.keyboard.press("ArrowDown");
  ov = await overlay(page);
  check(ov && ov.h === 100, "↓ goes back to the band");
  await page.keyboard.press("ArrowUp");
  await page.mouse.move(420, 260); // a small move inside the receipt (into another band)
  ov = await overlay(page);
  check(ov && ov.h === 900, "after ↑, moving inside keeps the whole receipt selected");
  const viewerP = ctx.waitForEvent("page", { predicate: (p) => p.url().includes("/screenshot.html"), timeout: 15000 });
  await page.mouse.click(400, 150);
  const viewer = await viewerP;
  check(viewer.url().includes("element=1"), "preview opened in element mode");
  const dl = await viewer.waitForEvent("download", { timeout: 60000 });
  const file = path.join(outDir, "receipt.png");
  await dl.saveAs(file);
  const sz = pngSize(fs.readFileSync(file));
  check(sz.w === 1200 && sz.h === 1800, `receipt PNG is exactly the element at 2x (${sz.w}x${sz.h})`);
  check(/\(part\) .*\.png$/.test(dl.suggestedFilename()) && dl.suggestedFilename().startsWith("Order 1234"), `file name "${dl.suggestedFilename()}"`);
  check((await page.getAttribute("#btn", "data-n")) === null, "the picking click did not reach the page");
  check(await page.evaluate(() => !document.querySelector("[data-sl-shot]")), "picker mark removed from the page");
  check((await page.evaluate(() => scrollY)) === 3000, `page scroll put back after the capture (${await page.evaluate(() => scrollY)})`);
  await viewer.screenshot({ path: path.join(outDir, "receipt-viewer.png") });

  // ── Tall element: several slices ──
  page = await open("/tall", "#long");
  await page.mouse.move(400, 300);
  await page.keyboard.press("ArrowUp");
  ov = await overlay(page);
  check(ov && ov.w === 800 && ov.h === 12000, `↑ selects the 12000 px element (${JSON.stringify(ov)})`);
  const v2P = ctx.waitForEvent("page", { predicate: (p) => p.url().includes("/screenshot.html"), timeout: 15000 });
  await page.mouse.click(400, 300);
  const v2 = await v2P;
  const dl2 = await v2.waitForEvent("download", { timeout: 120000 });
  const file2 = path.join(outDir, "tall.png");
  await dl2.saveAs(file2);
  const sz2 = pngSize(fs.readFileSync(file2));
  check(sz2.w === 1600 && sz2.h === 24000, `tall element PNG ${sz2.w}x${sz2.h} (expect 1600x24000, sliced)`);

  fs.writeFileSync(path.join(outDir, "elem.json"), JSON.stringify({ receipt: file, tall: file2 }));
  await ctx.close();
  server.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
