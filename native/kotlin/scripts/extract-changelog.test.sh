#!/usr/bin/env bash
# Test for extract-changelog.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTRACT="$SCRIPT_DIR/extract-changelog.sh"

fail() { echo "FAIL: $1" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/CHANGELOG.md" <<'MD'
# aws-blocks-kotlin

## 0.2.0

### Minor Changes

- Added realtime channel support

### Patch Changes

- Fixed a cookie bug

## 0.1.0

Initial version
MD

# --- Case 1: extract the latest (0.2.0) section ---
OUT="$(bash "$EXTRACT" "$WORK/CHANGELOG.md" 0.2.0)"
echo "$OUT" | grep -q "Added realtime channel support" \
  || fail "Case 1: missing minor-change line"
echo "$OUT" | grep -q "Fixed a cookie bug" \
  || fail "Case 1: missing patch-change line"
if echo "$OUT" | grep -q "Initial version"; then
  fail "Case 1: leaked content from the next (0.1.0) section"
fi
if echo "$OUT" | grep -q "^## 0.2.0"; then
  fail "Case 1: should not include the heading line itself"
fi

# --- Case 2: extract a middle/last section (0.1.0) ---
OUT2="$(bash "$EXTRACT" "$WORK/CHANGELOG.md" 0.1.0)"
echo "$OUT2" | grep -q "Initial version" \
  || fail "Case 2: missing 0.1.0 body"

# --- Case 3: unknown version exits non-zero ---
if bash "$EXTRACT" "$WORK/CHANGELOG.md" 5.5.5 2>/dev/null; then
  fail "Case 3: unknown version should exit non-zero"
fi

echo "PASS: extract-changelog.test.sh"
