// Tests Send to Paperless against a mock Paperless-ngx API. Usage: node paperless_test.cjs <extDir> <outDir>
const { chromium, executablePath } = require("./browser.cjs");
const fs = require("fs");
const path = require("path");
const http = require("http");

const [, , extDir, outDir] = process.argv;
fs.mkdirSync(outDir, { recursive: true });
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) failures++; };

const TOKEN = "test-token-123";
const uploads = [];
let taskPolls = 0;
let nextResult = "success";
const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const paperless = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  if (req.headers.authorization !== `Token ${TOKEN}`) return json(res, 401, { detail: "Invalid token." });
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/api/documents/" && req.method === "GET") return json(res, 200, { count: 314, results: [] });
  if (u.pathname === "/api/documents/post_document/" && req.method === "POST") {
    const fd = await new Request("http://x/", { method: "POST", headers: req.headers, body, duplex: "half" }).formData();
    const doc = fd.get("document");
    uploads.push({ cookie: req.headers.cookie || null, title: fd.get("title"), created: fd.get("created"), name: doc?.name, type: doc?.type, size: doc?.size,
      magic: doc ? Buffer.from(await doc.slice(0, 5).arrayBuffer()).toString("latin1") : "" });
    taskPolls = 0;
    return json(res, 200, "4b6c1d2e-task");
  }
  if (u.pathname === "/api/tasks/") {
    taskPolls++;
    const status = taskPolls === 1 ? "PENDING" : taskPolls === 2 ? "STARTED" : nextResult === "success" ? "SUCCESS" : "FAILURE";
    return json(res, 200, [{ task_id: u.searchParams.get("task_id"), status,
      result: status === "FAILURE" ? "Not consuming Order.png: It is a duplicate of Order (#12)." : status === "SUCCESS" ? "Success. New document id 42 created" : null,
      related_document: status === "SUCCESS" ? "42" : null }]);
  }
  json(res, 404, { detail: "Not found." });
});
const site = http.createServer((q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(`<!doctype html><title>Order 1234 receipt</title><body style="margin:0"><h1>Receipt</h1><div style="height:1500px;background:linear-gradient(#fff,#ccc)">Total $42.00</div>`); });

(async () => {
  await new Promise((r) => paperless.listen(0, "127.0.0.1", r));
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const plUrl = `http://127.0.0.1:${paperless.address().port}`;
  const siteUrl = `http://localhost:${site.address().port}/`;
  const profile = fs.mkdtempSync(path.join(outDir, "profile-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: false, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, acceptDownloads: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  // A Paperless login cookie in the browser: the extension must not send it
  await ctx.addCookies([{ name: "sessionid", value: "logged-in-session", domain: "127.0.0.1", path: "/" }]);
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;

  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.click('button[data-page="screenshot"]');
  let targetId = null;
  await popup.exposeBinding("__target", () => targetId);
  await popup.evaluate(() => {
    const real = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (q) => (q && q.active && q.currentWindow ? [await chrome.tabs.get(await window.__target())] : real(q));
  });

  const capture = async (kind) => {
    const page = ctx.pages().find((p) => p.url() === siteUrl) || (await ctx.newPage());
    if (page.url() !== siteUrl) await page.goto(siteUrl);
    targetId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, siteUrl);
    await page.bringToFront();
    const vP = ctx.waitForEvent("page", { predicate: (p) => p.url().includes("/screenshot.html"), timeout: 15000 });
    await popup.evaluate((k) => document.getElementById(k === "pdf" ? "shotPdfBtn" : "shotPngBtn").click(), kind);
    const v = await vP;
    await v.waitForEvent("download", { timeout: 60000 });
    await v.waitForSelector("#status.ok");
    return v;
  };

  // Not configured: no button
  let v = await capture("png");
  check(await v.locator("#paperlessBtn").isHidden(), "no Send to Paperless button until Paperless is set up");
  await v.close();

  // Settings
  check(await popup.evaluate(() => Paperless.normalizeUrl(" paperless.example.com/ ")) === "https://paperless.example.com", "URL without http(s) gets https://");
  await popup.click("#plSettingsBtn");
  await popup.fill("#plUrl", "http://127.0.0.1:1");
  await popup.fill("#plToken", TOKEN);
  await popup.click("#plSaveBtn");
  await popup.waitForSelector("#plTestStatus.err");
  check(/Can't reach Paperless/.test(await popup.textContent("#plTestStatus")), `unreachable: "${await popup.textContent("#plTestStatus")}"`);
  await popup.fill("#plUrl", plUrl + "/api/");
  await popup.fill("#plToken", "wrong");
  await popup.click("#plSaveBtn");
  await popup.waitForFunction(() => /refused/.test(document.getElementById("plTestStatus").textContent));
  check(/refused the API token \(Invalid token\.\).*Not saved/.test(await popup.textContent("#plTestStatus")), `wrong token: "${await popup.textContent("#plTestStatus")}"`);
  check(!(await popup.evaluate(() => chrome.storage.local.get("paperless_url"))).paperless_url, "wrong token is not saved");
  await popup.fill("#plToken", TOKEN);
  await popup.click("#plSaveBtn");
  await popup.waitForSelector("#plTestStatus.ok");
  check((await popup.textContent("#plTestStatus")).includes("314 documents"), `connected: "${await popup.textContent("#plTestStatus")}"`);
  check((await popup.inputValue("#plUrl")) === plUrl, `URL saved without /api/ (${await popup.inputValue("#plUrl")})`);
  check((await popup.textContent("#plSettingsBtn")).includes("connected"), "settings button says connected");
  await popup.screenshot({ path: path.join(outDir, "1-settings.png") });

  // PNG upload, success
  v = await capture("png");
  check(await v.locator("#paperlessBtn").isVisible(), "Send to Paperless button shown");
  await v.click("#paperlessBtn");
  await v.waitForSelector("#plStatus.ok", { timeout: 30000 });
  const okText = await v.textContent("#plStatus");
  const link = await v.getAttribute("#plStatus a", "href");
  check(/Added to Paperless/.test(okText) && link === `${plUrl}/documents/42/details`, `success: "${okText}" -> ${link}`);
  const up = uploads.at(-1);
  console.log("     upload:", JSON.stringify(up));
  check(up.type === "image/png" && up.magic.startsWith("\u0089PNG") && up.size > 1000, "a real PNG was uploaded");
  check(/^Order 1234 receipt .*\.png$/.test(up.name), `file name ${up.name}`);
  check(up.title === "Order 1234 receipt", `title "${up.title}"`);
  check(up.created === null, "no created date forced (Paperless reads it from the document)");
  check(up.cookie === null, "Paperless login cookie not sent");
  check((await v.textContent("#paperlessBtn")).includes("✓") && await v.isDisabled("#paperlessBtn"), "button shows sent and can't send twice");
  await v.screenshot({ path: path.join(outDir, "2-sent.png") });
  await v.close();

  // Duplicate (Paperless rejects it)
  nextResult = "failure";
  v = await capture("pdf");
  await v.click("#paperlessBtn");
  await v.waitForSelector("#plStatus.err", { timeout: 30000 });
  const errText = await v.textContent("#plStatus");
  check(/couldn't add it: Not consuming .* duplicate/.test(errText), `duplicate: "${errText}"`);
  check(!(await v.isDisabled("#paperlessBtn")), "button usable again after a failure");
  check(uploads.at(-1).type === "application/pdf" && uploads.at(-1).magic === "%PDF-", "PDF uploaded as a PDF");
  await v.screenshot({ path: path.join(outDir, "3-duplicate.png") });

  // Remove settings
  await popup.click("#plClearBtn");
  check(!(await popup.evaluate(() => chrome.storage.local.get("paperless_token"))).paperless_token, "Remove deletes the token");

  await ctx.close(); paperless.close(); site.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
