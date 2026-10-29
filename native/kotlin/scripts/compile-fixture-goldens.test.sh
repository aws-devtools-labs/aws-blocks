#!/usr/bin/env bash
# Test for compile-fixture-goldens.sh. Run from anywhere; needs a JDK 17 (JAVA_HOME).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPILE="$SCRIPT_DIR/compile-fixture-goldens.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }

# golden <fixtures-dir> <fixture> <file> <body>: write <fixture>/kotlin/<file>.
golden() {
  mkdir -p "$1/$2/kotlin"
  printf '%s\n' "$4" > "$1/$2/kotlin/$3"
}

SERVERS='package com.example.app

import com.aws.blocks.kotlin.BlocksServer

public object Servers {
  public val local: BlocksServer = BlocksServer(name = "local", url = "http://localhost:3001")
}'

# --- Case 1: clean goldens pass, each counted, even with the same package and type names ---
# (they're separate compilation units). A fixture without a kotlin/ directory is skipped.
CLEAN="$WORK/clean"
golden "$CLEAN" 01-ok Servers.kt "$SERVERS"
golden "$CLEAN" 02-also-ok Servers.kt "$SERVERS"
mkdir -p "$CLEAN/03-swift-only/swift"
out="$(bash "$COMPILE" "$CLEAN" 2>&1)" || fail "Case 1: clean goldens should pass: $out"
case "$out" in *"OK: 2 Kotlin fixture golden(s) compile with 0 errors"*) ;; *) fail "Case 1: unexpected output: $out" ;; esac

# --- Case 2: a warning (unused variable) is advisory, not a failure ---
WARN="$WORK/warn"
golden "$WARN" 01-warning Warn.kt 'package com.example.app

fun f() {
  val unused = 1
}'
bash "$COMPILE" "$WARN" > /dev/null 2>&1 || fail "Case 2: a warning must not fail the run"

# --- Case 3: an error fails, naming the golden and line it came from ---
BROKEN="$WORK/broken"
golden "$BROKEN" 01-ok Servers.kt "$SERVERS"
golden "$BROKEN" 02-type-error Api.kt 'package com.example.app

public val answer: Int = "forty-two"'
if out="$(bash "$COMPILE" "$BROKEN" 2>&1)"; then
  fail "Case 3: a compiler error should fail the run"
fi
case "$out" in *"02-type-error/kotlin/Api.kt:3:"*) ;; *) fail "Case 3: error not attributed to its golden: $out" ;; esac
case "$out" in *"FAIL: 1 compiler error(s) in 1 of 2 Kotlin fixture golden(s)"*) ;; *) fail "Case 3: unexpected summary: $out" ;; esac

# --- Case 4: no opt-ins are added (an experimental API used without @OptIn fails) ---
OPTIN="$WORK/optin"
golden "$OPTIN" 01-uuid Api.kt 'package com.example.app

import kotlin.uuid.Uuid

public fun parse(text: String): Uuid = Uuid.parse(text)'
if bash "$COMPILE" "$OPTIN" > /dev/null 2>&1; then
  fail "Case 4: Uuid without @OptIn(ExperimentalUuidApi::class) should fail"
fi

# --- Case 5: no goldens is an error, not a vacuous pass ---
mkdir -p "$WORK/empty"
if bash "$COMPILE" "$WORK/empty" > /dev/null 2>&1; then
  fail "Case 5: an empty fixtures directory should fail"
fi

# --- Case 6: without a fixtures directory the build still configures, without :fixture-goldens ---
# (a partial checkout, or one without native/codegen-fixtures, must still build and publish the SDK).
MISSING="$WORK/no-such-fixtures"
KOTLIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
out="$(cd "$KOTLIN_DIR" && ./gradlew projects --console=plain "-PfixtureGoldensDir=$MISSING" 2>&1)" ||
  fail "Case 6: the build should configure without a fixtures directory: $out"
case "$out" in *":fixture-goldens"*) fail "Case 6: :fixture-goldens is included without a fixtures directory" ;; esac
case "$out" in *":runtime"*) ;; *) fail "Case 6: :runtime missing from the projects: $out" ;; esac
# `--dry-run` plans the tasks without running them (`build` would also need an Android SDK).
out="$(cd "$KOTLIN_DIR" && ./gradlew :runtime:jvmTest :codegen:jar --dry-run --console=plain "-PfixtureGoldensDir=$MISSING" 2>&1)" ||
  fail "Case 6: :runtime:jvmTest and :codegen:jar should plan without a fixtures directory: $out"
if bash "$COMPILE" "$MISSING" > /dev/null 2>&1; then
  fail "Case 6: a missing fixtures directory should fail the script"
fi

echo "PASS: compile-fixture-goldens.sh"
