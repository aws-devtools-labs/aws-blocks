#!/usr/bin/env bash
# Generates API.md reports for all publishable packages using API Extractor.
#
# The packages are independent (each run reads its own dist/ and writes its own
# API.md), so they run in parallel, one per CPU (API_REPORT_JOBS overrides).
# Each package's output is buffered and printed in package order at the end.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JOBS="${API_REPORT_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}"
LOGS="$(mktemp -d)"
trap 'rm -rf "$LOGS"' EXIT

# Writes <pkg>.log, and <pkg>.failed when the package fails.
report() {
  local dir="$1" pkg
  pkg="$(basename "$dir")"
  (cd "$dir" && npx api-extractor run --local && tr -d '\r' < API.api.md > API.md && rm -f API.api.md) \
    >"$LOGS/$pkg.log" 2>&1 || touch "$LOGS/$pkg.failed"
}
export -f report
export LOGS

configs=("$ROOT"/packages/*/api-extractor.json)
for config in "${configs[@]}"; do dirname "$config"; done |
  xargs -P "$JOBS" -I{} bash -c 'report "$1"' _ {}

failed=0
for config in "${configs[@]}"; do
  pkg="$(basename "$(dirname "$config")")"
  echo "→ $pkg"
  cat "$LOGS/$pkg.log"
  if [ -e "$LOGS/$pkg.failed" ]; then
    echo "  ✗ FAILED: $pkg"
    failed=1
  fi
done

if [ $failed -ne 0 ]; then
  echo ""
  echo "Some packages failed. See output above."
  exit 1
fi

echo ""
echo "✓ All API reports generated."
