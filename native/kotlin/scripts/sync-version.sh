#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

VERSION=$(node -p "require('$PROJECT_DIR/package.json').version")

sed -i.bak "s/^VERSION_NAME=.*/VERSION_NAME=$VERSION/" "$PROJECT_DIR/gradle.properties"
rm -f "$PROJECT_DIR/gradle.properties.bak"

echo "Synced version $VERSION to gradle.properties"
