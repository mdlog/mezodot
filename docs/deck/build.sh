#!/usr/bin/env bash
# Renders docs/deck/deck.html to docs/deck/DECK.pdf with headless Chrome (needs network for the web fonts).
# Usage: pnpm deck
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CHROME="${CHROME:-$(command -v google-chrome || command -v chromium || command -v chromium-browser)}"

"$CHROME" --headless=new --no-sandbox --disable-gpu --no-pdf-header-footer \
  --virtual-time-budget=15000 \
  --print-to-pdf="$HERE/DECK.pdf" \
  "file://$HERE/deck.html" 2>/dev/null

echo "wrote $HERE/DECK.pdf"
