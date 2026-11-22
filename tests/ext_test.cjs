// Loads the unpacked SuperLevels extension in Playwright's Chromium (fresh profile) and
// tests the Summarize popup with Ollama, plus the cookie dismisser on sonos.com.
// Usage: node ext_test.cjs <extensionDir> <ollamaUrl> <outDir>
const { chromium, executablePath } = require("./browser.cjs");
const fs = require("fs");
const path = require("path");

const [, , extDir, ollamaUrl, outDir] = process.argv;
fs.mkdirSync(outDir, { recursive: true });
const shot = (page, name) => page.screenshot({ path: path.join(outDir, `${name}.png`) });
let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures++;
};

(async () => {
  const profile = fs.mkdtempSync(path.join(outDir, "profile-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: false, // extensions need the full browser, not the headless shell
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;
  console.log("extension id", extId);

  // Article to summarize
  const article = await ctx.newPage();
  await article.goto("https://en.wikipedia.org/wiki/Large_language_model", { waitUntil: "domcontentloaded" });
  await article.bringToFront();

  // The popup opened as a tab would be its own "active tab", so pin the Summarize
  // target to the article tab: only chrome.tabs.query is replaced, everything else is real.
  const articleTabId = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => (t.url || "").includes("wikipedia.org")).id;
  });
  const popup = await ctx.newPage();
  await popup.addInitScript((id) => {
    const real = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (q) =>
      q && q.active && q.currentWindow ? [await chrome.tabs.get(id)] : real(q);
  }, articleTabId);
  await popup.setViewportSize({ width: 600, height: 600 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.click('button[data-page="summarize"]');
  await popup.waitForSelector("#page-summarize", { state: "visible" });

  const vis = (sel) => popup.locator(sel).isVisible();
  const txt = (sel) => popup.locator(sel).textContent();

  // ── Settings UI per provider ──
  await popup.selectOption("#aiProvider", "openai");
  await popup.waitForTimeout(300);
  check(await vis("#aiConfig"), "OpenAI with no key: settings open automatically");
  check(await vis("#aiKeyRow"), "OpenAI: API key field shown");
  check(!(await vis("#aiUrlRow")), "OpenAI: Server URL field hidden");
  check((await txt("#aiSignupLink")) === "Get an API key →", "OpenAI: signup link says 'Get an API key'");
  check((await popup.inputValue("#aiModel")) === "gpt-4o", "OpenAI: default model gpt-4o");
  check((await txt("#aiPrivacyNote")).startsWith("Keys are stored locally"), "OpenAI: note talks about keys");
  await shot(popup, "1-openai-settings");

  await popup.selectOption("#aiProvider", "ollama");
  await popup.waitForTimeout(300);
  check(!(await vis("#aiConfig")), "Ollama: settings stay closed (no key needed)");
  check((await txt("#aiSettingsBtn")).includes("Server & model"), "Ollama: settings button says 'Server & model'");
  await popup.click("#aiSettingsBtn");
  check(await vis("#aiUrlRow"), "Ollama: Server URL field shown");
  check(!(await vis("#aiKeyRow")), "Ollama: API key field hidden");
  check((await popup.inputValue("#aiUrl")) === "http://localhost:11434", "Ollama: default URL localhost:11434");
  check((await popup.inputValue("#aiModel")) === "", "Ollama: model blank by default");
  check((await popup.getAttribute("#aiModel", "placeholder")).includes("first installed"), "Ollama: model placeholder explains blank");
  check((await txt("#aiSignupLink")) === "Get Ollama →", "Ollama: link says 'Get Ollama'");
  check((await txt("#aiPrivacyNote")) === "Settings are stored locally in your browser. Page text is sent only to your Ollama server.", "Ollama: note talks about settings and the Ollama server, not keys");
  await shot(popup, "2-ollama-settings-default");

  // Unreachable server error (port 1 on localhost)
  await popup.fill("#aiUrl", "127.0.0.1:1");
  await popup.click("#aiSaveBtn");
  await popup.click("#summarizeBtn");
  await popup.waitForSelector("#aiResult .ai-err", { timeout: 30000 });
  const err = await txt("#aiResult");
  check(/can't reach http:\/\/127\.0\.0\.1:1/.test(err), `unreachable server error: "${err}"`);
  await shot(popup, "3-ollama-unreachable");

  // Save the real server without http:// and with a trailing slash; model blank
  await popup.click("#aiSettingsBtn");
  await popup.fill("#aiUrl", ollamaUrl.replace(/^https?:\/\//, "") + "/");
  await popup.fill("#aiModel", "");
  await popup.click("#aiSaveBtn");
  const stored = await popup.evaluate(() => chrome.storage.local.get(["ai_provider", "ai_url_ollama", "ai_model_ollama"]));
  check(stored.ai_url_ollama === ollamaUrl, `URL saved normalized: ${stored.ai_url_ollama}`);
  check(stored.ai_provider === "ollama", "provider choice saved");

  // Reopen the popup: settings persist
  await popup.reload();
  await popup.click('button[data-page="summarize"]');
  await popup.waitForTimeout(400);
  check((await popup.inputValue("#aiProvider")) === "ollama", "after reopen: Ollama still selected");
  check((await popup.inputValue("#aiUrl")) === ollamaUrl, "after reopen: server URL kept");

  // ── Summarize the article ──
  const t0 = Date.now();
  await popup.click("#summarizeBtn");
  // Sample the result box while it is being written
  const samples = [];
  for (let i = 0; i < 1200; i++) {
    const st = await popup.evaluate(() => ({
      len: document.getElementById("aiResult").innerText.length,
      cursor: !!document.querySelector("#aiResult .ai-cursor"),
      done: !!document.querySelector("#aiResult #aiCopyBtn, #aiResult .ai-err"),
    }));
    if (st.cursor) samples.push(st.len);
    if (st.done) break;
    await popup.waitForTimeout(100);
  }
  const growing = samples.filter((v, i) => i && v > samples[i - 1]).length;
  check(samples.length >= 3 && growing >= 2, `summary streams in: ${samples.length} samples with the cursor, text grew ${growing} times`);
  check(!(await popup.locator("#aiResult .ai-cursor").count()), "cursor gone when finished");
  await popup.waitForSelector("#aiResult #aiCopyBtn, #aiResult .ai-err", { timeout: 240000 });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const result = (await txt("#aiResult")).replace(/^Copy/, "").trim();
  check(!(await popup.locator("#aiResult .ai-err").count()), `summary returned in ${secs}s`);
  check(/language model|LLM/i.test(result), "summary is about large language models");
  console.log("---- summary ----\n" + result.slice(0, 900) + "\n-----------------");
  const items = await popup.locator("#aiResult li").count();
  check(items >= 3, `rendered as a bullet list (${items} bullets)`);
  await shot(popup, "4-ollama-summary");

  // ── Ask about this page ──
  check(await vis("#aiAsk"), "question box shown after the summary");
  const ask = async (q) => {
    const before = await popup.locator("#aiThread .ai-result").count();
    await popup.fill("#aiQuestion", q);
    await popup.press("#aiQuestion", "Enter");
    await popup.waitForFunction((n) => {
      const blocks = document.querySelectorAll("#aiThread .ai-result");
      const last = blocks[blocks.length - 1];
      return blocks.length > n && last && !last.querySelector(".ai-spin, .ai-cursor");
    }, before, { timeout: 240000 });
    return (await popup.locator("#aiThread .ai-result .ai-a").last().textContent()).trim();
  };
  const a1 = await ask("Which company made the transformer architecture paper mentioned on this page? Answer in one short sentence.");
  console.log("     Q1 answer:", a1.slice(0, 200));
  check(/google/i.test(a1), "answer 1 comes from the page (Google)");
  const a2 = await ask("What year was that paper published? Just the year.");
  console.log("     Q2 answer:", a2.slice(0, 200));
  check(/2017/.test(a2), "follow-up uses the earlier answer (2017)");
  check(await popup.locator("#aiThread .ai-err").count() === 0, "no errors in the thread");
  check(await popup.locator("#aiThread .ai-q").count() === 2, "both questions shown");
  await shot(popup, "4b-ollama-ask");

  // A new summary clears the thread
  await popup.click("#summarizeBtn");
  await popup.waitForTimeout(300);
  check(await popup.locator("#aiThread .ai-result").count() === 0 && !(await vis("#aiAsk")), "new summary clears the old questions");
  await popup.waitForSelector("#aiResult #aiCopyBtn, #aiResult .ai-err", { timeout: 240000 });

  // ── Cookie dismisser: sonos.com must not be blank ──
  const sonos = await ctx.newPage();
  await sonos.goto("https://www.sonos.com/en-us/shop/promotional-offers", { waitUntil: "domcontentloaded", timeout: 60000 });
  await sonos.waitForTimeout(6000);
  const body = await sonos.evaluate(() => {
    const cs = getComputedStyle(document.body);
    return {
      cls: document.body.className,
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
      height: document.body.getBoundingClientRect().height,
      text: document.body.innerText.length,
      styleInjected: [...document.querySelectorAll("style")].some((s) => s.textContent.includes("cmplz-cookiebanner")),
    };
  });
  console.log("sonos body", JSON.stringify(body));
  check(body.styleInjected, "cookie dismisser CSS is injected on sonos.com");
  check(body.display !== "none" && body.visibility !== "hidden" && body.opacity !== "0", "sonos.com body is visible");
  check(body.height > 500, `sonos.com body has height (${Math.round(body.height)}px)`);
  await shot(sonos, "5-sonos");

  await ctx.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
