#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# PROJECT_DIR defaults to the package root (parent of scripts/) but can be
# overridden (e.g. by tests) to point at a fixture directory.
PROJECT_DIR="${PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"

VERSION=$(node -p "require('$PROJECT_DIR/package.json').version")

PROPS="$PROJECT_DIR/gradle.properties"

# Fail loudly if there is no VERSION_NAME line to replace. `sed` exits 0 even
# when its pattern matches nothing, which would otherwise leave a stale version
# and silently publish/tag the wrong number.
if ! grep -q '^VERSION_NAME=' "$PROPS"; then
  echo "ERROR: no VERSION_NAME= line found in $PROPS" >&2
  exit 1
fi

sed -i.bak "s/^VERSION_NAME=.*/VERSION_NAME=$VERSION/" "$PROPS"
rm -f "$PROPS.bak"

# Verify the write landed.
if ! grep -q "^VERSION_NAME=$VERSION$" "$PROPS"; then
  echo "ERROR: failed to set VERSION_NAME=$VERSION in $PROPS" >&2
  exit 1
fi

echo "Synced version $VERSION to gradle.properties"
