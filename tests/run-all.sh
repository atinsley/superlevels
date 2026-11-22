#!/usr/bin/env bash
# Runs every test suite against this checkout of the extension. See README.md.
# Optional: OLLAMA_URL + OLLAMA_MODEL to include the live Ollama / Summarize tests.
set -u
cd "$(dirname "$0")"
EXT="$(cd .. && pwd)"
# Outside the extension folder: browser profiles written inside it could stop Chrome
# loading the unpacked extension (it rejects files whose names start with "_")
OUT="${OUT:-${TMPDIR:-/tmp}/superlevels-tests}"
mkdir -p "$OUT"
failed=0

run() {
  local name=$1; shift
  printf '%-28s' "$name"
  if "$@" > "$OUT/$name.log" 2>&1; then
    echo "passed"
  else
    echo "FAILED (log: $OUT/$name.log)"
    grep -E "^FAIL" -A1 "$OUT/$name.log" | sed 's/^/    /'
    failed=1
  fi
}

for f in "$EXT"/*.js; do node --check "$f" || failed=1; done

if [ -n "${OLLAMA_URL:-}" ] && [ -n "${OLLAMA_MODEL:-}" ]; then
  run summarize-provider   node ollama_test.mjs "$EXT/popup.js" "$OLLAMA_URL"
  run summarize-popup      node ext_test.cjs "$EXT" "$OLLAMA_URL" "$OUT/summarize"
else
  run summarize-provider   node ollama_test.mjs "$EXT/popup.js"
  echo "summarize-popup             skipped (set OLLAMA_URL and OLLAMA_MODEL to run it)"
fi
run focus-blocker          node focus_test.cjs "$EXT" "$OUT/focus"
run screenshot-full-page   node shot_test.cjs "$EXT" "$OUT/shot" 2
run screenshot-pixels      python3 shot_verify.py "$OUT/shot"
run screenshot-element     node elem_test.cjs "$EXT" "$OUT/elem"
run element-pixels         python3 elem_verify.py "$OUT/elem"
run send-to-paperless      node paperless_test.cjs "$EXT" "$OUT/paperless"
run picture-in-picture     node pip_test.cjs "$EXT" "$OUT/pip"
run tab-groups             node groups_test.cjs "$EXT" "$OUT/groups"
run tab-cleaner-subdomains node exact_test.cjs "$EXT" "$OUT/exact"
run cookie-filter          node cookie_test.cjs "$EXT" "$OUT/cookies"
run cookie-dismisser-sites node nocookie_test.cjs "$EXT" "$OUT/nocookie"
run json-search            node json_test.cjs "$EXT" "$OUT/json"
run dark-mode              node dark_test.cjs "$EXT" "$OUT/dark"
run settings               node settings_test.cjs "$EXT" "$OUT/settings"

[ $failed -eq 0 ] && echo "all passed" || echo "some suites FAILED"
exit $failed
