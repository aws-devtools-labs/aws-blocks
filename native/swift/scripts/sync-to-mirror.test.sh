#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Tests for sync-to-mirror.sh. Builds a workspace laid out like the
# cdk-blocks-swift sync workflow's (mono/native/swift next to a mirror/ git
# checkout) and runs a copy of the real script from inside mono/native/swift.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILURES=0
fail() {
  echo "FAIL: $1"
  FAILURES=$((FAILURES + 1))
}
pass() {
  echo "PASS: $1"
}

setup() {
  rm -rf "$WORK/ws"
  local swift="$WORK/ws/mono/native/swift"
  mkdir -p "$swift/scripts" "$swift/Sources/Lib" "$swift/.changeset" \
    "$swift/Demo/typescript-demo/node_modules/dep" "$swift/.build"
  cp "$SCRIPT_DIR/sync-to-mirror.sh" "$swift/scripts/"
  echo "// swift-tools-version: 6.2" > "$swift/Package.swift"
  echo "new readme" > "$swift/README.md"
  echo "let x = 1" > "$swift/Sources/Lib/Lib.swift"
  echo '{"name":"changeset-tooling"}' > "$swift/package.json"
  echo '{}' > "$swift/package-lock.json"
  echo "---" > "$swift/.changeset/pending.md"
  echo '{"name":"demo"}' > "$swift/Demo/typescript-demo/package.json"
  echo "x" > "$swift/Demo/typescript-demo/node_modules/dep/index.js"
  echo "x" > "$swift/.build/artifact"
  echo "#!/bin/sh" > "$swift/scripts/other.sh"

  local mirror="$WORK/ws/mirror"
  mkdir -p "$mirror/.github/workflows" "$mirror/Demo/typescript-demo" "$mirror/Sources/Old"
  git -C "$mirror" init -q
  echo "name: Release" > "$mirror/.github/workflows/publish-tag-release.yml"
  for f in LICENSE NOTICE CODE_OF_CONDUCT.md CONTRIBUTING.md; do echo "mirror $f" > "$mirror/$f"; done
  echo "old readme" > "$mirror/README.md"
  echo "stale" > "$mirror/stale.txt"
  echo "stale" > "$mirror/.stale-dot"
  echo "old" > "$mirror/Sources/Old/Old.swift"
  echo '{}' > "$mirror/Demo/typescript-demo/package-lock.json"
}

run_sync() {
  (cd "$WORK/ws/mono/native/swift" && bash scripts/sync-to-mirror.sh "$@")
}

# --- A normal sync ---------------------------------------------------------
setup
if run_sync ../../../mirror >/dev/null 2>&1; then pass "sync exits 0"; else fail "sync exits 0"; fi
M="$WORK/ws/mirror"

# Without -mindepth 1 the find deletes the checkout itself and exits 0 anyway,
# so check the checkout still exists and is still its own repo.
TOP="$(git -C "$M" rev-parse --show-toplevel 2>/dev/null || true)"
if [ "$(cd "$TOP" 2>/dev/null && pwd -P)" = "$(cd "$M" && pwd -P)" ]; then
  pass "mirror is still its own git checkout"
else
  fail "mirror is still its own git checkout (toplevel: '$TOP')"
fi

for f in .github/workflows/publish-tag-release.yml LICENSE NOTICE CODE_OF_CONDUCT.md CONTRIBUTING.md; do
  if [ -f "$M/$f" ] && grep -q "mirror\|Release" "$M/$f"; then pass "keeps $f"; else fail "keeps $f"; fi
done

for f in stale.txt .stale-dot Sources/Old/Old.swift Demo/typescript-demo/package-lock.json; do
  if [ ! -e "$M/$f" ]; then pass "removes $f"; else fail "removes $f"; fi
done

for f in Package.swift Sources/Lib/Lib.swift Demo/typescript-demo/package.json scripts/other.sh; do
  if [ -f "$M/$f" ]; then pass "copies $f"; else fail "copies $f"; fi
done
if grep -q "new readme" "$M/README.md"; then pass "overwrites README.md"; else fail "overwrites README.md"; fi

for f in package.json package-lock.json .changeset .build Demo/typescript-demo/node_modules scripts/sync-to-mirror.sh; do
  if [ ! -e "$M/$f" ]; then pass "does not copy $f"; else fail "does not copy $f"; fi
done

# --- Refusals --------------------------------------------------------------
expect_refusal() {
  local name="$1"
  shift
  setup
  if [ -n "${PREPARE:-}" ]; then "$PREPARE"; fi
  local before
  before="$(cd "$WORK/ws" && find . | sort)"
  if run_sync "$@" >/dev/null 2>&1; then
    fail "$name: should exit non-zero"
  elif [ "$(cd "$WORK/ws" && find . | sort)" != "$before" ]; then
    fail "$name: should not change any file"
  else
    pass "$name"
  fi
}

expect_refusal "refuses a missing argument"
expect_refusal "refuses the aws-blocks root" ../..
expect_refusal "refuses the Swift SDK directory itself" .
rm -rf "$WORK/plain" && mkdir -p "$WORK/plain" && git -C "$WORK/plain" init -q
expect_refusal "refuses a checkout without the mirror's release workflow" "$WORK/plain"

# A directory that passes the checkout check but contains the SDK sources.
mono_looks_like_mirror() {
  git -C "$WORK/ws/mono" init -q
  mkdir -p "$WORK/ws/mono/.github/workflows"
  echo "name: Release" > "$WORK/ws/mono/.github/workflows/publish-tag-release.yml"
}
PREPARE=mono_looks_like_mirror expect_refusal "refuses a target that contains the sources" ../..

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES test(s) failed"
  exit 1
fi
echo "All tests passed"
