#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

VERSION=$(node -p "require('$PROJECT_DIR/package.json').version")

for pubspec in "$PROJECT_DIR"/packages/*/pubspec.yaml; do
  # Update the package version
  sed -i.bak "s/^version: .*/version: $VERSION/" "$pubspec"

  # Update inter-package dependency constraint on blocks_runtime
  sed -i.bak "s/\(blocks_runtime\): \^.*/\1: ^$VERSION/" "$pubspec"

  rm -f "$pubspec.bak"
  echo "Synced version $VERSION to $pubspec"
done
