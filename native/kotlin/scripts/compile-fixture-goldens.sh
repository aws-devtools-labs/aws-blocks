#!/usr/bin/env bash
# Compiles every codegen fixture's Kotlin golden against the in-repo runtime (JVM) and
# fails if any has a compiler error. The goldens are what the Kotlin codegen emits for
# each spec, so an error here is an error in a customer's generated client. The
# golden-file tests (`:codegen:test`) only compare text, so they can't catch it.
#
# Usage: compile-fixture-goldens.sh [FIXTURES_DIR]
#   FIXTURES_DIR  defaults to native/codegen-fixtures. Each `*/kotlin/` directory
#                 under it is compiled.
#   JAVA_HOME     a JDK 17 (as in CI).
#
# Each fixture is its own compilation unit (a source set of the `:fixture-goldens`
# Gradle module): the goldens share a package and type names, and a golden must
# compile on its own, with no opt-ins beyond what it declares. Only errors fail the
# run (and are printed, against the golden they came from); warnings are advisory.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KOTLIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURES_DIR="$(cd "${1:-$KOTLIN_DIR/../codegen-fixtures}" && pwd -P)"

count=0
for dir in "$FIXTURES_DIR"/*/kotlin; do
  [ -d "$dir" ] && count=$((count + 1))
done
if [ "$count" -eq 0 ]; then
  echo "error: no */kotlin/ goldens under $FIXTURES_DIR" >&2
  exit 1
fi

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

status=0
(cd "$KOTLIN_DIR" && ./gradlew :fixture-goldens:compileFixtureGoldens --continue \
  "-PfixtureGoldensDir=$FIXTURES_DIR" > "$LOG" 2>&1) || status=$?

# Kotlin compiler errors: `e: file:///<path>:<line>:<column> <message>`.
errors="$(grep '^e: file://' "$LOG" || true)"

if [ -n "$errors" ]; then
  printf '%s\n' "$errors" | sed -e 's|^e: file://|error - |' -e 's|^\(error - [^ ]*\) |\1 - |' >&2
  failed="$(printf '%s\n' "$errors" | sed -e 's|^e: file://||' -e "s|^$FIXTURES_DIR/||" -e 's|/.*||' | sort -u | wc -l | tr -d ' ')"
  echo "FAIL: $(printf '%s\n' "$errors" | wc -l | tr -d ' ') compiler error(s) in $failed of $count Kotlin fixture golden(s)" >&2
  exit 1
fi

if [ "$status" -ne 0 ]; then
  # The build failed without a compiler error (a Gradle or dependency problem).
  tail -n 40 "$LOG" >&2
  echo "FAIL: Gradle failed before compiling the Kotlin fixture goldens (exit $status)" >&2
  exit 1
fi

echo "OK: $count Kotlin fixture golden(s) compile with 0 errors (warnings are advisory)"
