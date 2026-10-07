#!/bin/bash
BASE="https://raw.githubusercontent.com/codeswithroh/mergepay/main"
for f in \
  "src/app/api/bounties/route.ts" \
  "src/app/api/badge/[owner]/[repo]/route.ts" \
  "src/lib/contracts.ts" \
  "src/app/app/page.tsx" \
  "src/components/FundTab.tsx" \
  "package.json" \
  "next.config.ts" \
; do
  echo "=== $f ==="
  curl -s "$BASE/$f"
  echo ""
done
