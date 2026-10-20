#!/usr/bin/env bash
# Test for sync-version.sh. Run from native/kotlin/scripts/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC="$SCRIPT_DIR/sync-version.sh"

WORK2=""
WORK3=""
WORK4=""

fail() { echo "FAIL: $1" >&2; exit 1; }

# --- Case 1: happy path — VERSION_NAME is updated from package.json ---
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK" "$WORK2" "$WORK3" "$WORK4"' EXIT
cat > "$WORK/package.json" <<'JSON'
{ "name": "aws-blocks-kotlin", "version": "9.9.9" }
JSON
cat > "$WORK/gradle.properties" <<'PROPS'
GROUP=com.aws.blocks.kotlin
VERSION_NAME=0.0.0
RELEASE_SIGNING_ENABLED=true
PROPS

PROJECT_DIR="$WORK" bash "$SYNC"
grep -q '^VERSION_NAME=9.9.9$' "$WORK/gradle.properties" \
  || fail "Case 1: VERSION_NAME not updated to 9.9.9"

# --- Case 2: missing VERSION_NAME line must fail (non-zero exit) ---
WORK2="$(mktemp -d)"
cat > "$WORK2/package.json" <<'JSON'
{ "name": "aws-blocks-kotlin", "version": "9.9.9" }
JSON
cat > "$WORK2/gradle.properties" <<'PROPS'
GROUP=com.aws.blocks.kotlin
RELEASE_SIGNING_ENABLED=true
PROPS

if PROJECT_DIR="$WORK2" bash "$SYNC" 2>/dev/null; then
  fail "Case 2: sync-version.sh should have failed on missing VERSION_NAME line"
fi

# --- Case 3: --check passes when VERSION_NAME already matches package.json ---
WORK3="$(mktemp -d)"
cat > "$WORK3/package.json" <<'JSON'
{ "name": "aws-blocks-kotlin", "version": "9.9.9" }
JSON
cat > "$WORK3/gradle.properties" <<'PROPS'
GROUP=com.aws.blocks.kotlin
VERSION_NAME=9.9.9
RELEASE_SIGNING_ENABLED=true
PROPS

PROJECT_DIR="$WORK3" bash "$SYNC" --check \
  || fail "Case 3: --check should pass when versions match"
grep -q '^VERSION_NAME=9.9.9$' "$WORK3/gradle.properties" \
  || fail "Case 3: --check must not modify gradle.properties"

# --- Case 4: --check fails (non-zero) when VERSION_NAME drifts from package.json ---
WORK4="$(mktemp -d)"
cat > "$WORK4/package.json" <<'JSON'
{ "name": "aws-blocks-kotlin", "version": "9.9.9" }
JSON
cat > "$WORK4/gradle.properties" <<'PROPS'
GROUP=com.aws.blocks.kotlin
VERSION_NAME=0.0.0
RELEASE_SIGNING_ENABLED=true
PROPS

if PROJECT_DIR="$WORK4" bash "$SYNC" --check 2>/dev/null; then
  fail "Case 4: --check should fail when VERSION_NAME drifts"
fi
grep -q '^VERSION_NAME=0.0.0$' "$WORK4/gradle.properties" \
  || fail "Case 4: --check must not modify gradle.properties on drift"

echo "PASS: sync-version.test.sh"
