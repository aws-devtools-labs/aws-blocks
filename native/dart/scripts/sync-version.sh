#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

VERSION=$(node -p "require('$PROJECT_DIR/package.json').version")

for pubspec in "$PROJECT_DIR"/packages/*/pubspec.yaml; do
  sed -i.bak "s/^version: .*/version: $VERSION/" "$pubspec"
  rm -f "$pubspec.bak"
  echo "Synced version $VERSION to $pubspec"
done
