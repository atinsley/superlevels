// Shared browser setup for the extension tests.
//
// Playwright: installed in tests/ (`npm install`), or point PLAYWRIGHT_PATH at an existing
// playwright package directory.
// Browser: Playwright's own Chromium by default (`npx playwright install chromium`), or set
// CHROMIUM_PATH to a Chromium / Chrome for Testing binary. Branded Google Chrome can't be
// used: it ignores --load-extension, which the tests rely on.
const pw = require(process.env.PLAYWRIGHT_PATH || "playwright");

module.exports = {
  chromium: pw.chromium,
  executablePath: process.env.CHROMIUM_PATH || undefined,
};
