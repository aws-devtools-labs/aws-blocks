#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Tests for extract-changelog.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXTRACT="$SCRIPT_DIR/extract-changelog.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# Create a sample CHANGELOG
cat > "$TMPDIR/CHANGELOG.md" <<'CHANGELOG'
# aws-blocks-swift

## 0.3.0

### Minor Changes

- feat: add realtime cursor tracking
- feat: add file bucket support

### Patch Changes

- fix: correct cookie handling

## 0.2.0

### Patch Changes

- fix: identifier naming cleanup
- chore: add SwiftLint configuration

## 0.1.0

- Initial release
CHANGELOG

PASS=0
FAIL=0

run_test() {
  local name="$1"
  shift
  if "$@"; then
    echo "✓ $name"
    PASS=$((PASS + 1))
  else
    echo "✗ $name"
    FAIL=$((FAIL + 1))
  fi
}

# Case 1: Extract latest version (0.3.0)
test_latest() {
  local output
  output=$("$EXTRACT" "$TMPDIR/CHANGELOG.md" "0.3.0")
  echo "$output" | grep -q "Minor Changes" || return 1
  echo "$output" | grep -q "add realtime cursor tracking" || return 1
  echo "$output" | grep -q "Patch Changes" || return 1
  echo "$output" | grep -q "correct cookie handling" || return 1
  # Should NOT contain content from 0.2.0
  echo "$output" | grep -q "identifier naming" && return 1
  return 0
}
run_test "Case 1: extracts latest (0.3.0) section" test_latest

# Case 2: Extract middle version (0.2.0)
test_middle() {
  local output
  output=$("$EXTRACT" "$TMPDIR/CHANGELOG.md" "0.2.0")
  echo "$output" | grep -q "identifier naming cleanup" || return 1
  echo "$output" | grep -q "SwiftLint configuration" || return 1
  # Should NOT contain content from 0.3.0 or 0.1.0
  echo "$output" | grep -q "realtime" && return 1
  echo "$output" | grep -q "Initial release" && return 1
  return 0
}
run_test "Case 2: extracts middle (0.2.0) section" test_middle

# Case 3: Extract oldest version (0.1.0)
test_oldest() {
  local output
  output=$("$EXTRACT" "$TMPDIR/CHANGELOG.md" "0.1.0")
  echo "$output" | grep -q "Initial release" || return 1
  return 0
}
run_test "Case 3: extracts oldest (0.1.0) section" test_oldest

# Case 4: Unknown version exits non-zero
test_unknown() {
  if "$EXTRACT" "$TMPDIR/CHANGELOG.md" "5.5.5" > /dev/null 2>&1; then
    return 1
  fi
  return 0
}
run_test "Case 4: unknown version exits non-zero" test_unknown

# Case 5: Partial version match is rejected (0.1 vs 0.1.0)
test_partial() {
  if "$EXTRACT" "$TMPDIR/CHANGELOG.md" "0.1" > /dev/null 2>&1; then
    return 1
  fi
  return 0
}
run_test "Case 5: partial version match (0.1) is rejected" test_partial

# Case 6: Heading line itself is excluded from output
test_no_heading() {
  local output
  output=$("$EXTRACT" "$TMPDIR/CHANGELOG.md" "0.3.0")
  echo "$output" | grep -q "^## " && return 1
  return 0
}
run_test "Case 6: heading line excluded from output" test_no_heading

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
