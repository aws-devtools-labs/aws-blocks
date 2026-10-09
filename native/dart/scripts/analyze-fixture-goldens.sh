#!/usr/bin/env bash
# Runs `dart analyze` over every codegen fixture's Dart golden and fails if any
# has an analyzer error. The goldens are what `blocks_codegen` emits for each
# spec, so an error here is an error in a customer's generated client.
#
# Usage: analyze-fixture-goldens.sh [FIXTURES_DIR]
#   FIXTURES_DIR  defaults to native/codegen-fixtures. Each `*/dart/client.dart`
#                 under it is analyzed.
#   DART          the dart executable (default: dart).
#
# The goldens are copied into a scratch package that depends on the in-repo
# blocks_runtime and uses the SDK's own analysis_options.yaml (strict-casts,
# strict-inference, strict-raw-types). Only errors fail the run (and are printed);
# warnings and lints are advisory, as in the package analyze steps. An analyzer
# that doesn't finish (an exit code outside 0-3, e.g. a crash) also fails it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DART_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURES_DIR="$(cd "${1:-$DART_DIR/../codegen-fixtures}" && pwd)"
DART="${DART:-dart}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/lib"
cat > "$WORK/pubspec.yaml" <<YAML
name: fixture_goldens
publish_to: none
environment:
  sdk: ^3.11.0
dependencies:
  blocks_runtime:
    path: $DART_DIR/packages/blocks_runtime
dev_dependencies:
  lints: ^6.0.0
YAML
cp "$DART_DIR/analysis_options.yaml" "$WORK/analysis_options.yaml"

count=0
for golden in "$FIXTURES_DIR"/*/dart/client.dart; do
  [ -f "$golden" ] || continue
  fixture="$(basename "$(dirname "$(dirname "$golden")")")"
  cp "$golden" "$WORK/lib/$fixture.dart"
  count=$((count + 1))
done
if [ "$count" -eq 0 ]; then
  echo "error: no */dart/client.dart goldens under $FIXTURES_DIR" >&2
  exit 1
fi

(cd "$WORK" && "$DART" pub get > "$WORK/pub-get.log" 2>&1) || {
  cat "$WORK/pub-get.log" >&2
  exit 1
}

# Machine format: SEVERITY|TYPE|CODE|FILE|LINE|COLUMN|LENGTH|MESSAGE.
# `dart analyze` exits 0-3 when it ran: 0 no issues, 1 infos, 2 warnings,
# 3 errors. Anything else (64 usage, 70 a crash, ...) means it didn't analyze,
# so the report can't be trusted to list every error: fail, as the Kotlin
# script fails on any non-zero Gradle exit.
status=0
report="$(cd "$WORK" && "$DART" analyze --format=machine . 2>&1)" || status=$?
errors="$(printf '%s\n' "$report" | grep '^ERROR|' || true)"

if [ "$status" -gt 3 ]; then
  printf '%s\n' "$report" >&2
  echo "FAIL: dart analyze did not complete (exit $status) over $count Dart fixture golden(s)" >&2
  exit 1
fi
if [ "$status" -eq 3 ] && [ -z "$errors" ]; then
  printf '%s\n' "$report" >&2
  echo "FAIL: dart analyze reported errors (exit 3), but no ERROR| line could be parsed" >&2
  exit 1
fi

if [ -n "$errors" ]; then
  # Report each error against the golden it came from (lib/<fixture>.dart).
  printf '%s\n' "$errors" | awk -F'|' -v dir="$FIXTURES_DIR" '{
    fixture = $4; sub(/.*\/lib\//, "", fixture); sub(/\.dart$/, "", fixture)
    printf "error - %s/%s/dart/client.dart:%s:%s - %s - %s\n", dir, fixture, $5, $6, $8, $3
  }' >&2
  echo "FAIL: $(printf '%s\n' "$errors" | wc -l | tr -d ' ') analyzer error(s) in $count Dart fixture golden(s)" >&2
  exit 1
fi

echo "OK: $count Dart fixture golden(s) analyze with 0 errors (warnings and lints are advisory)"
