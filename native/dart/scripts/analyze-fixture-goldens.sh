#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Runs `dart analyze` over every codegen fixture's Dart golden and fails if any
# has an analyzer error. The goldens are what `blocks_codegen` emits for each
# spec, so an error here is an error in a customer's generated client.
#
# Usage: analyze-fixture-goldens.sh [FIXTURES_DIR]
#   FIXTURES_DIR  defaults to native/codegen-fixtures. Each `*/dart/client.dart`
#                 under it is analyzed. A fixture whose Dart golden is
#                 `dart/codegen-error.txt` (a spec the generator refuses) has
#                 no client to analyze and is skipped; one with both files
#                 fails the run.
#   DART          the dart executable (default: dart).
#
# The goldens are copied into a scratch package that depends on the in-repo
# blocks_runtime (and the stub packages in fixture-stubs/) and uses the SDK's own analysis_options.yaml (strict-casts,
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

# Compile-only stand-ins for the native packages a fixture declares
# (`x-blocks-native-packages`), so a golden importing a bound type analyzes.
STUBS_DIR="$SCRIPT_DIR/fixture-stubs"
stub_dependencies() {
  for stub in "$STUBS_DIR"/*/pubspec.yaml; do
    [ -f "$stub" ] || continue
    dir="$(dirname "$stub")"
    printf '  %s:\n    path: %s\n' "$(basename "$dir")" "$dir"
  done
}

mkdir -p "$WORK/lib"
cat > "$WORK/pubspec.yaml" <<YAML
name: fixture_goldens
publish_to: none
environment:
  sdk: ^3.11.0
dependencies:
  blocks_runtime:
    path: $DART_DIR/packages/blocks_runtime
$(stub_dependencies)
dev_dependencies:
  lints: ^6.0.0
YAML
cp "$DART_DIR/analysis_options.yaml" "$WORK/analysis_options.yaml"

refused=0
for error_golden in "$FIXTURES_DIR"/*/dart/codegen-error.txt; do
  [ -f "$error_golden" ] || continue
  if [ -f "$(dirname "$error_golden")/client.dart" ]; then
    echo "error: $(dirname "$error_golden") has both client.dart and codegen-error.txt" >&2
    exit 1
  fi
  refused=$((refused + 1))
done

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
if [ "$refused" -gt 0 ]; then
  echo "Skipped $refused fixture(s) whose Dart golden is an expected codegen-error.txt"
fi
