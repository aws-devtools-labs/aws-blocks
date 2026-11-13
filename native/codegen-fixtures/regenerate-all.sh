#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "==> Regenerating Kotlin fixtures..."
# The task is never up to date (`doNotTrackState` in native/kotlin/codegen/build.gradle.kts), so this
# always runs the Kotlin generator; native/kotlin/scripts/regenerate-fixtures.test.sh checks it.
(cd "$REPO_ROOT/native/kotlin" && ./gradlew :codegen:regenerateFixtures --quiet)

echo "==> Regenerating Swift fixtures..."
(cd "$REPO_ROOT/native/swift" && REGENERATE_FIXTURES=1 swift test --filter GoldenFileTests 2>&1 | grep -E "(✓|Test Suite|error:)")

echo "==> Regenerating Dart fixtures..."
(cd "$REPO_ROOT/native/dart/packages/blocks_codegen" && REGENERATE_FIXTURES=1 dart test test/golden_file_test.dart 2>&1 | grep -E "(✓|skip|All tests)")

echo ""
echo "==> Done. Review changes with:"
echo "    git diff native/codegen-fixtures/"
