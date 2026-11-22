// Tests Picture-in-Picture for videos in a cross-origin iframe and in shadow DOM.
// Usage: node pip_test.cjs <extDir> <outDir>
const { chromium, executablePath } = require("./browser.cjs");
const fs = require("fs");
const path = require("path");
const http = require("http");

const [, , extDir, outDir] = process.argv;
fs.mkdirSync(outDir, { recursive: true });
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) failures++; };

// A playing video made from a canvas stream (no media files needed)
const videoScript = (where) => `<script>
  const c = document.createElement("canvas"); c.width = 320; c.height = 180;
  const g = c.getContext("2d"); let n = 0;
  setInterval(() => { g.fillStyle = "hsl(" + (n++ % 360) + ",70%,50%)"; g.fillRect(0, 0, 320, 180); }, 50);
  const v = document.createElement("video"); v.muted = true; v.autoplay = true; v.playsInline = true;
  v.srcObject = c.captureStream(20); v.width = 320;
  ${where}
  v.play();
</script>`;
let framePort = 0;
const PAGES = {
  "/frame": () => `<!doctype html><body style="margin:0">${videoScript("document.body.appendChild(v);")}</body>`,
  "/iframe": () => `<!doctype html><title>iframe video</title><body><h1>Video in a cross-origin iframe</h1>
     <iframe src="http://localhost:${framePort}/frame" width="340" height="200"></iframe></body>`,
  "/shadow": () => `<!doctype html><title>shadow video</title><body><h1>Video in shadow DOM</h1><div id="host"></div>
     ${videoScript('document.getElementById("host").attachShadow({ mode: "open" }).appendChild(v);')}</body>`,
  "/plain": () => `<!doctype html><title>plain video</title><body>${videoScript("document.body.appendChild(v);")}</body>`,
  "/none": () => `<!doctype html><title>no video</title><body><p>nothing here</p></body>`,
};
const handler = (q, r) => { const p = PAGES[q.url]; r.writeHead(p ? 200 : 404, { "content-type": "text/html" }); r.end(p ? p() : "nope"); };
const main = http.createServer(handler);
const frames = http.createServer(handler);

(async () => {
  await new Promise((r) => main.listen(0, "127.0.0.1", r));
  await new Promise((r) => frames.listen(0, "127.0.0.1", r));
  framePort = frames.address().port;
  const base = `http://127.0.0.1:${main.address().port}`;
  const profile = fs.mkdtempSync(path.join(outDir, "profile-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: false, viewport: { width: 1000, height: 700 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--autoplay-policy=no-user-gesture-required"],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  let targetId = null;
  await popup.exposeBinding("__target", () => targetId);
  await popup.evaluate(() => {
    const real = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (q) => (q && q.active && q.currentWindow ? [await chrome.tabs.get(await window.__target())] : real(q));
  });

  const pipIn = async (page) => {
    const frames = page.frames();
    const states = await Promise.all(frames.map((f) => f.evaluate(() => {
      const find = (root) => root.pictureInPictureElement || [...root.querySelectorAll("*")].map((e) => e.shadowRoot && find(e.shadowRoot)).find(Boolean);
      return !!(document.pictureInPictureElement || find(document));
    }).catch(() => false)));
    return states.some(Boolean);
  };

  for (const [p, expect] of [["/plain", true], ["/iframe", true], ["/shadow", true], ["/none", false]]) {
    const page = await ctx.newPage();
    await page.goto(base + p);
    await page.waitForTimeout(1500);
    targetId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, base + p);
    await popup.bringToFront();
    await popup.click('button[data-page="pip"]'); // clicking the tab toggles PiP right away
    await popup.waitForFunction(() => document.getElementById("pipStatus").textContent.trim().length > 0, null, { timeout: 15000 });
    const status = (await popup.textContent("#pipStatus")).trim();
    const inPip = await pipIn(page);
    if (expect) check(status === "Video in Picture-in-Picture" && inPip, `${p}: entered PiP ("${status}", pip element found: ${inPip})`);
    else check(/No video found/.test(status) && !inPip, `${p}: says no video ("${status}")`);
    if (inPip) {
      await popup.click('button[data-page="tabcleaner"]');
      await popup.click('button[data-page="pip"]');
      await popup.waitForFunction(() => /Exited/.test(document.getElementById("pipStatus").textContent), null, { timeout: 15000 }).catch(() => {});
      check(!(await pipIn(page)), `${p}: second click exits PiP ("${(await popup.textContent("#pipStatus")).trim()}")`);
    }
    await popup.click('button[data-page="tabcleaner"]');
    await page.close();
  }
  await ctx.close(); main.close(); frames.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
