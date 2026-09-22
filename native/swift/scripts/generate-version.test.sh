#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Tests for generate-version.sh. Each case builds a throwaway package fixture
# (package.json + .swiftformat) and runs the real script against it via
# PROJECT_DIR, so it exercises the actual file IO with no stubs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GEN="$SCRIPT_DIR/generate-version.sh"

fail() { echo "FAIL: $1" >&2; exit 1; }

HEADER='--header "//\n// Copyright Example.\n//"'

# Builds a fixture package and echoes its dir. version defaults to 9.9.9.
make_fixture() {
  local dir version="${1:-9.9.9}"
  dir="$(mktemp -d)"
  echo "{ \"version\": \"$version\" }" > "$dir/package.json"
  printf '%s\n' "$HEADER" > "$dir/.swiftformat"
  mkdir -p "$dir/Sources/BlocksRuntime"
  echo "$dir"
}

WORK1="$(make_fixture)"
WORK2="$(make_fixture)"
WORK3="$(make_fixture)"
WORK4="$(make_fixture 9.9.9+5)"
WORK5="$(make_fixture)"
trap 'rm -rf "$WORK1" "$WORK2" "$WORK3" "$WORK4" "$WORK5"' EXIT

TARGET_REL="Sources/BlocksRuntime/Version.swift"

# --- Case 1: generate writes the constant, header, and token ---
PROJECT_DIR="$WORK1" bash "$GEN" >/dev/null
grep -q '^let blocksRuntimeVersion = "9.9.9"$' "$WORK1/$TARGET_REL" \
  || fail "Case 1: version constant not generated"
grep -q 'blocksUserAgentToken = "aws-blocks-swift/\\(blocksRuntimeVersion)"' "$WORK1/$TARGET_REL" \
  || fail "Case 1: user-agent token not generated"
grep -q '^// Copyright Example.$' "$WORK1/$TARGET_REL" \
  || fail "Case 1: licence header not sourced from .swiftformat"

# --- Case 2: --check passes for the freshly generated file ---
PROJECT_DIR="$WORK2" bash "$GEN" >/dev/null
PROJECT_DIR="$WORK2" bash "$GEN" --check \
  || fail "Case 2: --check should pass for a freshly generated file"

# --- Case 3: --check fails (non-zero) when the target is missing ---
if PROJECT_DIR="$WORK3" bash "$GEN" --check 2>/dev/null; then
  fail "Case 3: --check should fail when Version.swift is missing"
fi

# --- Case 4: build metadata (+build) is rejected ---
if PROJECT_DIR="$WORK4" bash "$GEN" 2>/dev/null; then
  fail "Case 4: a +build version should be rejected"
fi

# --- Case 5: missing .swiftformat fails with a clear message ---
rm -f "$WORK5/.swiftformat"
if PROJECT_DIR="$WORK5" bash "$GEN" 2>/dev/null; then
  fail "Case 5: missing .swiftformat should fail"
fi

# --- Case 6: an unknown flag exits non-zero instead of being ignored ---
if PROJECT_DIR="$WORK1" bash "$GEN" --nope 2>/dev/null; then
  fail "Case 6: an unknown flag should fail"
fi

echo "PASS: generate-version.test.sh"
