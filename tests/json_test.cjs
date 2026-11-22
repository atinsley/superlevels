// Tests JSON formatter search. Usage: node json_test.cjs <extDir> <outDir>
const { chromium, executablePath } = require("./browser.cjs");
const fs = require("fs");
const path = require("path");
const http = require("http");

const [, , extDir, outDir] = process.argv;
fs.mkdirSync(outDir, { recursive: true });
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) failures++; };
const DATA = {
  order: { id: 1234, total: 42.5, paid: true, items: [{ sku: "A-1", name: "Fish & Chips" }, { sku: "B.2", name: "x < y" }] },
  customer: { name: "Pat", address: { city: "Springfield", note: "<img src=x onerror=window.__pwned=1>" } },
  refund: null,
};
const server = http.createServer((q, r) => { r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify(DATA)); });

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const profile = fs.mkdtempSync(path.join(outDir, "profile-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: false, viewport: { width: 1000, height: 700 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector(".sl-jf-search", { timeout: 10000 });
  check(true, "search box in the JSON toolbar");
  const before = await page.locator(".sl-jf-wrap").innerHTML();
  const count = () => page.textContent(".sl-jf-count");
  const marks = () => page.locator("mark.sl-jf-hit").count();

  // Collapse everything, then search a deep key
  await page.click("text=Collapse All");
  check(await page.locator('.sl-jf-toggle[data-collapsed="true"]').count() > 3, "everything collapsed");
  await page.fill(".sl-jf-search", "CITY");
  check(await marks() === 1 && (await count()) === "1 of 1", `case-insensitive key match (${await count()})`);
  check(await page.locator("mark.sl-jf-hit").isVisible(), "collapsed parents opened to show the match");

  await page.fill(".sl-jf-search", "&");
  check(await marks() === 1 && (await page.locator("mark.sl-jf-hit").textContent()) === "&", "a search for & highlights the & in the value");
  await page.fill(".sl-jf-search", "amp");
  check(await marks() === 0 && (await count()) === "No matches", "a search for amp doesn't match inside &amp;");
  await page.fill(".sl-jf-search", "x < y");
  check(await marks() === 1, "a search containing < matches");
  await page.fill(".sl-jf-search", "b.2");
  check(await marks() === 1, "regex characters are taken literally (b.2)");
  await page.fill(".sl-jf-search", "img src");
  check(await marks() === 1 && await page.locator(".sl-jf-wrap img").count() === 0 && !(await page.evaluate(() => window.__pwned)), "page text never becomes HTML");

  await page.fill(".sl-jf-search", "a");
  const n = await marks();
  check(n > 5 && (await count()) === `1 of ${n}`, `many hits counted (${await count()})`);
  await page.press(".sl-jf-search", "Enter");
  check((await count()) === `2 of ${n}` && await page.locator("mark.sl-jf-current").count() === 1, "Enter goes to the next hit");
  await page.press(".sl-jf-search", "Shift+Enter");
  await page.press(".sl-jf-search", "Shift+Enter");
  check((await count()) === `${n} of ${n}`, "Shift+Enter goes back and wraps around");
  await page.screenshot({ path: path.join(outDir, "json-search.png") });

  await page.fill(".sl-jf-search", "");
  check(await marks() === 0 && (await count()) === "", "clearing removes highlights");
  const restoredText = await page.locator(".sl-jf-wrap").textContent();
  check(restoredText === (await page.evaluate((h) => { const d = document.createElement("div"); d.innerHTML = h; return d.textContent; }, before)), "text identical to before searching");

  await ctx.close(); server.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
