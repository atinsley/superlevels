# Tests

Browser tests for the extension. They load this checkout as an unpacked extension in a fresh Chromium profile, drive the real popup and pages with [Playwright](https://playwright.dev), and check the results, down to the pixel for screenshots.

## Setup

```bash
cd tests
npm install
npx playwright install chromium
pip3 install pillow   # the screenshot pixel checks use PIL
```

Already have Playwright or a Chromium build somewhere? Point the tests at them instead:

- `PLAYWRIGHT_PATH`: path to a `playwright` package directory.
- `CHROMIUM_PATH`: path to a Chromium or Chrome for Testing binary. Branded Google Chrome won't work, because it ignores `--load-extension`.

## Run

```bash
./run-all.sh
```

Each suite prints `passed` or the checks that failed, and writes a full log and screenshots to `$TMPDIR/superlevels-tests/` (set `OUT` to change it; keep it outside the extension folder). A browser window opens while the tests run: extensions need a full (headed) browser.

To include the live Summarize tests, point them at an Ollama server whose chat model is already loaded, and allow extension requests on it (`OLLAMA_ORIGINS=chrome-extension://*`):

```bash
OLLAMA_URL=http://localhost:11434 OLLAMA_MODEL=llama3.2 ./run-all.sh
```

Without those, the Ollama provider code is still tested against a fake server.

## What's covered

| Suite | What it checks |
| --- | --- |
| `ollama_test.mjs` | The Summarize provider code: Ollama requests, context size reuse, picking a model, streaming, conversations, errors, and that OpenAI / xAI / Anthropic requests are unchanged. Runs in Node with a fake Ollama server, plus live checks when `OLLAMA_URL` is set |
| `ext_test.cjs` | The Summarize popup end to end with a live Ollama: settings for each provider, streaming, follow-up questions, and that the cookie dismisser no longer blanks sonos.com |
| `focus_test.cjs` | Focus Blocker: blocking, the block page, suffix matching, iframes, per-site and global switches, persistence |
| `shot_test.cjs` + `shot_verify.py` | Full-page screenshots: long pages captured in slices with exact seams, fixed headers, inner scrolling panels, lazy images, PDF, Copy, and error cases |
| `elem_test.cjs` + `elem_verify.py` | Element capture: the picker (hover, ↑/↓, Esc, click), exact element size, tall elements, page scroll restored |
| `paperless_test.cjs` | Send to Paperless against a fake Paperless-ngx API: settings test, upload, task polling, duplicates, no login cookie sent |
| `pip_test.cjs` | Picture-in-Picture for videos in cross-origin iframes and shadow DOM |
| `groups_test.cjs` | The tab cleaner skipping named tab groups, or all of them |
| `exact_test.cjs` | The tab cleaner's per-host "subdomains" switch |
| `cookie_test.cjs` | Cookie editor filter, Delete Filtered, and that a row's delete removes that cookie |
| `nocookie_test.cjs` | Switching the cookie dismisser off for one site |
| `json_test.cjs` | JSON formatter search: highlights, opening collapsed blocks, next/previous, escaping |
| `dark_test.cjs` | Dark mode Off / On / Auto, following the system appearance live, already-dark pages |
| `settings_test.cjs` | The Settings tab: hiding and reordering tabs, drag and drop, persistence |
| `sort_test.cjs` | Website lists (No paywall, Tabs, Focus, Cookies=OK) put in alphabetical order when you leave them or reopen the popup |

Most suites serve their own test pages from a local server. A few also load real sites (Wikipedia, sonos.com, example.com, x.com, reddit.com), so they need internet access.
