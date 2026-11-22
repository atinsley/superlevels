// Tests the Summarize provider code from superlevels/popup.js in Node.
// Usage: node ollama_test.mjs /path/to/popup.js [liveOllamaUrl]
// The live part also needs OLLAMA_MODEL (a chat model already loaded on that server).
import fs from "node:fs";
import http from "node:http";
import vm from "node:vm";
import assert from "node:assert/strict";

const [, , popupPath, liveUrl] = process.argv;
const src = fs.readFileSync(popupPath, "utf8");
const start = src.indexOf("const AI_PROVIDERS");
const end = src.indexOf("// Minimal safe markdown");
assert.ok(start > 0 && end > start, "could not find the AI section");
const section = src.slice(start, end);

const stubEl = () => ({ addEventListener() {}, style: {}, value: "", textContent: "" });
const ctx = {
  fetch: (...a) => ctx.__fetch(...a),
  __fetch: fetch,
  TextDecoder, TextEncoder, requestAnimationFrame: (f) => setTimeout(f, 16),
  document: { getElementById: stubEl, querySelector: stubEl },
  chrome: { storage: { local: { get() {}, set() {} } } },
  console,
};
vm.createContext(ctx);
vm.runInContext(section + "\nthis.api = { normalizeOllamaUrl, callAiProvider, AI_PROVIDERS };", ctx);
const { normalizeOllamaUrl, callAiProvider, AI_PROVIDERS } = ctx.api;

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n     ${e.message}`);
    process.exitCode = 1;
  }
}

// ── Mock Ollama server ──
// state: installed models, loaded models {name: ctx}, the server's default context
let mode = "ok";
let installed, loaded, serverDefaultCtx;
const reset = (o = {}) => {
  mode = o.mode || "ok";
  installed = o.installed || ["embed:1", "chat:7b", "other:3b"];
  loaded = o.loaded || {};
  serverDefaultCtx = o.serverDefaultCtx ?? 65536;
  seen.length = 0;
};
const seen = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const b = body ? JSON.parse(body) : null;
    seen.push({ method: req.method, url: req.url, body: b });
    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const load = (name, ctx) => {
      // like Ollama, a bare name means the :latest tag
      if (!installed.includes(name) && installed.includes(`${name}:latest`)) name = `${name}:latest`;
      if (!installed.includes(name)) return false;
      loaded[name] = ctx || serverDefaultCtx; // a different num_ctx = reload
      return true;
    };
    if (mode === "forbidden") return res.writeHead(403).end();
    if (req.url === "/api/tags") return send(200, { models: installed.map((name) => ({ name })) });
    if (req.url === "/api/ps") {
      if (mode === "nops") return send(404, { error: "404 page not found" });
      return send(200, {
        models: Object.entries(loaded).map(([name, ctx]) =>
          mode === "noctx" ? { name } : { name, context_length: ctx }),
      });
    }
    if (req.url === "/api/show") {
      return send(200, { capabilities: b.model.startsWith("embed") ? ["embedding"] : ["completion"] });
    }
    if (req.url === "/api/generate") {
      if (!load(b.model)) return send(404, { error: `model '${b.model}' not found` });
      return send(200, { done: true });
    }
    if (req.url === "/api/chat") {
      if (!load(b.model, b.options?.num_ctx)) return send(404, { error: `model '${b.model}' not found` });
      if (b.stream) {
        // NDJSON in network chunks; one JSON line is split across two chunks on purpose
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        const line = (o) => JSON.stringify(o) + "\n";
        const pieces = ["- point", " one\n", "- point two"];
        const chunks = [line({ message: { content: pieces[0] } })];
        const second = line({ message: { content: pieces[1] } });
        chunks.push(second.slice(0, 10), second.slice(10));
        if (mode === "streamerror") chunks.push(line({ error: "model ran out of memory" }));
        chunks.push(line({ message: { content: pieces[2] } }), line({ message: { content: "" }, done: true }));
        let i = 0;
        const next = () => (i < chunks.length ? (res.write(chunks[i++]), setTimeout(next, 30)) : res.end());
        return next();
      }
      if (mode === "empty") return send(200, { message: { role: "assistant", content: "" } });
      return send(200, { message: { role: "assistant", content: "  - point one\n- point two  " } });
    }
    send(404, { error: "not found" });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const mockUrl = `http://127.0.0.1:${server.address().port}`;
const chatBody = () => seen.find((s) => s.url === "/api/chat").body;
const urls = () => seen.map((s) => s.url);

await test("provider is registered with no default model", () => {
  assert.equal(AI_PROVIDERS.ollama.label, "Ollama");
  assert.equal(AI_PROVIDERS.ollama.defaultModel, "");
  assert.equal(AI_PROVIDERS.ollama.local, true);
});

await test("normalizeOllamaUrl", () => {
  assert.equal(normalizeOllamaUrl(""), "http://localhost:11434");
  assert.equal(normalizeOllamaUrl("   "), "http://localhost:11434");
  assert.equal(normalizeOllamaUrl(undefined), "http://localhost:11434");
  assert.equal(normalizeOllamaUrl("localhost:11434"), "http://localhost:11434");
  assert.equal(normalizeOllamaUrl("http://10.0.0.5:11434/"), "http://10.0.0.5:11434");
  assert.equal(normalizeOllamaUrl("https://ollama.example.test//"), "https://ollama.example.test");
  assert.equal(normalizeOllamaUrl(" HTTP://box:1 "), "HTTP://box:1");
});

await test("chat request body", async () => {
  reset({ loaded: { "chat:7b": 65536 } });
  const out = await callAiProvider("ollama", "chat:7b", mockUrl + "/", "SYS", "USER");
  assert.equal(out, "- point one\n- point two");
  const b = chatBody();
  assert.equal(b.model, "chat:7b");
  assert.equal(b.stream, false);
  assert.deepEqual(b.messages, [{ role: "system", content: "SYS" }, { role: "user", content: "USER" }]);
});

await test("loaded at 64k: reuses 65536, no load, no reload", async () => {
  reset({ loaded: { "chat:7b": 65536 } });
  await callAiProvider("ollama", "chat:7b", mockUrl, "S", "U");
  assert.deepEqual(urls(), ["/api/ps", "/api/chat"]);
  assert.equal(chatBody().options.num_ctx, 65536);
  assert.equal(loaded["chat:7b"], 65536);
});

await test("loaded at 16k: reuses 16384 (any size >= 8192 is kept)", async () => {
  reset({ loaded: { "chat:7b": 16384 } });
  await callAiProvider("ollama", "chat:7b", mockUrl, "S", "U");
  assert.equal(chatBody().options.num_ctx, 16384);
});

await test("name without tag matches the :latest copy in memory", async () => {
  reset({ installed: ["llama3.2:latest"], loaded: { "llama3.2:latest": 32768 } });
  await callAiProvider("ollama", "llama3.2", mockUrl, "S", "U");
  assert.deepEqual(urls(), ["/api/ps", "/api/chat"]);
  assert.equal(chatBody().options.num_ctx, 32768);
});

await test("not loaded, server default 64k: loads with defaults, then uses 65536", async () => {
  reset({ serverDefaultCtx: 65536 });
  await callAiProvider("ollama", "chat:7b", mockUrl, "S", "U");
  assert.deepEqual(urls(), ["/api/ps", "/api/generate", "/api/ps", "/api/chat"]);
  assert.equal(seen[1].body.options, undefined, "preload must not set num_ctx");
  assert.equal(chatBody().options.num_ctx, 65536);
  assert.equal(loaded["chat:7b"], 65536);
});

await test("not loaded, small server default (4096): raises to 8192", async () => {
  reset({ serverDefaultCtx: 4096 });
  await callAiProvider("ollama", "chat:7b", mockUrl, "S", "U");
  assert.equal(chatBody().options.num_ctx, 8192);
});

await test("loaded below the minimum (2048): raises to 8192", async () => {
  reset({ loaded: { "chat:7b": 2048 } });
  await callAiProvider("ollama", "chat:7b", mockUrl, "S", "U");
  assert.deepEqual(urls(), ["/api/ps", "/api/chat"]);
  assert.equal(chatBody().options.num_ctx, 8192);
});

await test("old Ollama without /api/ps or context_length: falls back to 8192", async () => {
  reset({ mode: "nops" });
  await callAiProvider("ollama", "chat:7b", mockUrl, "S", "U");
  assert.equal(chatBody().options.num_ctx, 8192);
  reset({ mode: "noctx", loaded: { "chat:7b": 65536 } });
  await callAiProvider("ollama", "chat:7b", mockUrl, "S", "U");
  assert.equal(chatBody().options.num_ctx, 8192);
});

await test("model not installed: Ollama's error is shown", async () => {
  reset();
  await assert.rejects(callAiProvider("ollama", "nope", mockUrl, "S", "U"), /Ollama: model 'nope' not found/);
});

await test("blank model: prefers a chat model already in memory", async () => {
  reset({ loaded: { "embed:1": 2048, "other:3b": 65536 } });
  await callAiProvider("ollama", "", mockUrl, "S", "U");
  assert.equal(chatBody().model, "other:3b");
  assert.equal(chatBody().options.num_ctx, 65536);
  assert.ok(!urls().includes("/api/generate"));
});

await test("blank model, nothing loaded: skips embedding model, uses first chat model", async () => {
  reset();
  await callAiProvider("ollama", "", mockUrl, "S", "U");
  assert.equal(chatBody().model, "chat:7b");
});

await test("blank model, no models installed: clear error", async () => {
  reset({ installed: [] });
  await assert.rejects(callAiProvider("ollama", "", mockUrl, "S", "U"), /no chat models installed/);
});

await test("blank model, only embedding models: clear error", async () => {
  reset({ installed: ["embed:1"] });
  await assert.rejects(callAiProvider("ollama", "", mockUrl, "S", "U"), /no chat models installed/);
});

await test("403 explains OLLAMA_ORIGINS", async () => {
  reset({ mode: "forbidden" });
  await assert.rejects(callAiProvider("ollama", "m", mockUrl, "S", "U"), /OLLAMA_ORIGINS=chrome-extension:\/\/\*/);
  await assert.rejects(callAiProvider("ollama", "", mockUrl, "S", "U"), /OLLAMA_ORIGINS/);
});

await test("empty reply is an error", async () => {
  reset({ mode: "empty", loaded: { "chat:7b": 65536 } });
  await assert.rejects(callAiProvider("ollama", "chat:7b", mockUrl, "S", "U"), /Empty response/);
});

await test("streaming: onDelta gets growing text, final text joined", async () => {
  reset({ loaded: { "chat:7b": 65536 } });
  const seenText = [];
  const out = await callAiProvider("ollama", "chat:7b", mockUrl, "S", "U", (t) => seenText.push(t));
  assert.equal(chatBody().stream, true);
  assert.equal(chatBody().options.num_ctx, 65536);
  assert.deepEqual(seenText, ["- point", "- point one\n", "- point one\n- point two"]);
  assert.equal(out, "- point one\n- point two");
});

await test("streaming: an error line from Ollama is raised", async () => {
  reset({ mode: "streamerror", loaded: { "chat:7b": 65536 } });
  await assert.rejects(callAiProvider("ollama", "chat:7b", mockUrl, "S", "U", () => {}), /Ollama: model ran out of memory/);
});

await test("streaming: 403 and unreachable still explained", async () => {
  reset({ mode: "forbidden" });
  await assert.rejects(callAiProvider("ollama", "m", mockUrl, "S", "U", () => {}), /OLLAMA_ORIGINS/);
  await assert.rejects(callAiProvider("ollama", "m", "http://127.0.0.1:1", "S", "U", () => {}), /can't reach/);
});

await test("no onDelta: stream false (one JSON reply)", async () => {
  reset({ loaded: { "chat:7b": 65536 } });
  await callAiProvider("ollama", "chat:7b", mockUrl, "S", "U");
  assert.equal(chatBody().stream, false);
});

const convo = [
  { role: "user", content: "PAGE + summarize" },
  { role: "assistant", content: "the summary" },
  { role: "user", content: "a follow-up question" },
];

await test("conversation: Ollama gets system + the whole history", async () => {
  reset({ loaded: { "chat:7b": 65536 } });
  await callAiProvider("ollama", "chat:7b", mockUrl, "SYS", convo, () => {});
  assert.deepEqual(chatBody().messages, [{ role: "system", content: "SYS" }, ...convo]);
});

await test("unreachable server: says so", async () => {
  await assert.rejects(callAiProvider("ollama", "m", "http://127.0.0.1:1", "S", "U"), /can't reach http:\/\/127\.0\.0\.1:1/);
});

await test("other providers still use their own endpoints", async () => {
  const urls = [];
  ctx.__fetch = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify({ choices: [{ message: { content: "x" } }], content: [{ type: "text", text: "y" }] }), { status: 200 });
  };
  assert.equal(await callAiProvider("openai", "m", "k", "S", "U"), "x");
  assert.equal(await callAiProvider("xai", "m", "k", "S", "U"), "x");
  assert.equal(await callAiProvider("anthropic", "m", "k", "S", "U"), "y");
  assert.deepEqual(urls, [
    "https://api.openai.com/v1/chat/completions",
    "https://api.x.ai/v1/chat/completions",
    "https://api.anthropic.com/v1/messages",
  ]);
  ctx.__fetch = fetch;
});

await test("conversation: OpenAI/xAI/Anthropic get the history in their own shapes", async () => {
  const bodies = {};
  ctx.__fetch = async (url, init) => {
    bodies[url] = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "x" } }], content: [{ type: "text", text: "y" }] }), { status: 200 });
  };
  await callAiProvider("openai", "m", "k", "SYS", convo);
  await callAiProvider("anthropic", "m", "k", "SYS", convo);
  await callAiProvider("openai", "m", "k", "SYS", "just one prompt");
  const oa = bodies["https://api.openai.com/v1/chat/completions"];
  assert.deepEqual(oa.messages, [{ role: "system", content: "SYS" }, { role: "user", content: "just one prompt" }]);
  const an = bodies["https://api.anthropic.com/v1/messages"];
  assert.equal(an.system, "SYS");
  assert.deepEqual(an.messages, convo);
  ctx.__fetch = fetch;
});

server.close();

if (liveUrl) {
  // The chat model your server has loaded (the live tests check it is reused, not reloaded)
  const GEMMA = process.env.OLLAMA_MODEL;
  if (!GEMMA) throw new Error("Set OLLAMA_MODEL to the chat model loaded on the Ollama server");
  const sent = [];
  ctx.__fetch = async (url, init) => {
    if (String(url).endsWith("/api/chat") || String(url).endsWith("/api/generate")) sent.push(JSON.parse(init.body));
    return fetch(url, init);
  };
  const ps = async () => (await (await fetch(liveUrl + "/api/ps")).json()).models;
  const before = (await ps()).find((m) => m.name === GEMMA);
  const page = "Title: Test\n\nThe quick brown fox jumps over the lazy dog. ".repeat(400); // ~18k chars

  await test(`live: explicit Gemma reuses its loaded context (${before?.context_length})`, async () => {
    assert.ok(before, "Gemma should be loaded before the test");
    const t = Date.now();
    const out = await callAiProvider("ollama", GEMMA, liveUrl,
      "You summarize web pages.", "Summarize this web page in 2 sentences.\n\n" + page);
    console.log(`     (${Date.now() - t} ms) ${out.slice(0, 140).replace(/\n/g, " ")}`);
    assert.match(out, /fox|dog/i);
    assert.equal(sent.length, 1, "no preload request");
    assert.equal(sent[0].options.num_ctx, before.context_length);
  });

  await test("live: streaming delivers text in several pieces", async () => {
    sent.length = 0;
    const deltas = [];
    const t0 = Date.now(); let first = 0;
    const out = await callAiProvider("ollama", GEMMA, liveUrl, "You summarize web pages.",
      "Summarize this web page in 3 bullet points.\n\n" + page, (t) => { if (!first) first = Date.now() - t0; deltas.push(t); });
    console.log(`     first text after ${first} ms, done after ${Date.now() - t0} ms, ${deltas.length} updates`);
    assert.ok(deltas.length > 5, "several updates");
    assert.equal(out, deltas.at(-1).trim());
    assert.equal(sent[0].options.num_ctx, before.context_length);
  });

  await test("live: blank model picks the loaded Gemma", async () => {
    sent.length = 0;
    await callAiProvider("ollama", "", liveUrl, "You summarize web pages.", "Summarize in one sentence: Ollama runs models locally.");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].model, GEMMA);
    assert.equal(sent[0].options.num_ctx, before.context_length);
  });

  await test("live: Gemma was not reloaded", async () => {
    const after = (await ps()).find((m) => m.name === GEMMA);
    assert.equal(after.context_length, before.context_length);
    // expires_at can't show a reload: with keep_alive -1 every request moves it forward.
    // Reloads are checked in Ollama's log instead ("offloaded N/N layers").
  });
  ctx.__fetch = fetch;
}

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
