#!/usr/bin/env bash
# Test for the Kotlin step of native/codegen-fixtures/regenerate-all.sh, the Gradle task
# `:codegen:regenerateFixtures`, and for the golden check `:codegen:test`. Run from
# anywhere; needs a JDK 17 (JAVA_HOME).
#
# A regenerate must always run the generator. Gradle used to consider the task up to date
# after one successful run (it declared neither the fixtures nor the goldens), so a second
# regenerate silently skipped Kotlin: a deleted golden stayed deleted, and a golden left
# stale by a generator change stayed stale. Each case runs against a scratch copy of one
# fixture (`-PfixtureGoldensDir`), so the real goldens are never touched.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KOTLIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_FIXTURE="$KOTLIN_DIR/../codegen-fixtures/01-primitives"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }

FIXTURES="$WORK/fixtures"
FIXTURE="$FIXTURES/01-primitives"
mkdir -p "$FIXTURE"
cp "$SOURCE_FIXTURE/spec.json" "$FIXTURE/spec.json"

# gradle <task> [args...]: run a task against the scratch fixtures; prints the plain console log.
gradle() {
  (cd "$KOTLIN_DIR" && ./gradlew "$@" --console=plain "-PfixtureGoldensDir=$FIXTURES" 2>&1)
}

# regenerate: run the task; fail unless it executed (not UP-TO-DATE, FROM-CACHE, SKIPPED or NO-SOURCE).
regenerate() {
  local out
  out="$(gradle :codegen:regenerateFixtures)" || fail "$1: regenerateFixtures failed: $out"
  case "$out" in
    *"> Task :codegen:regenerateFixtures UP-TO-DATE"* | *"> Task :codegen:regenerateFixtures FROM-CACHE"* | \
    *"> Task :codegen:regenerateFixtures SKIPPED"* | *"> Task :codegen:regenerateFixtures NO-SOURCE"*)
      fail "$1: regenerateFixtures didn't run: $(printf '%s\n' "$out" | grep ':codegen:regenerateFixtures')" ;;
    *"> Task :codegen:regenerateFixtures"*) ;;
    *) fail "$1: no regenerateFixtures task in the output: $out" ;;
  esac
}

# --- Case 1: a regenerate writes the goldens of the fixtures it's pointed at ---
regenerate "Case 1"
[ -f "$FIXTURE/kotlin/Api.kt" ] || fail "Case 1: no Kotlin golden written under $FIXTURE/kotlin"
cmp -s "$FIXTURE/kotlin/Api.kt" "$SOURCE_FIXTURE/kotlin/Api.kt" ||
  fail "Case 1: the regenerated Api.kt differs from the committed golden"
cp "$FIXTURE/kotlin/Api.kt" "$WORK/Api.kt"

# --- Case 2: a second regenerate with nothing changed still runs ---
regenerate "Case 2"

# --- Case 3: a deleted golden is written again ---
rm "$FIXTURE/kotlin/Api.kt"
regenerate "Case 3"
[ -f "$FIXTURE/kotlin/Api.kt" ] || fail "Case 3: the deleted golden wasn't regenerated"

# --- Case 4: a stale golden is overwritten ---
printf '// stale\n' >> "$FIXTURE/kotlin/Api.kt"
regenerate "Case 4"
cmp -s "$FIXTURE/kotlin/Api.kt" "$WORK/Api.kt" || fail "Case 4: the stale golden wasn't overwritten"

# --- Case 5: the golden check reruns when a golden changes (it isn't up to date from the last pass) ---
gradle :codegen:test --tests com.aws.blocks.kotlin.CodegenFixturesTest > /dev/null ||
  fail "Case 5: the golden check should pass on freshly regenerated goldens"
printf '// stale\n' >> "$FIXTURE/kotlin/Api.kt"
if out="$(gradle :codegen:test --tests com.aws.blocks.kotlin.CodegenFixturesTest)"; then
  fail "Case 5: the golden check passed on a stale golden: $(printf '%s\n' "$out" | grep ':codegen:test')"
fi

echo "PASS: regenerateFixtures always regenerates"
