#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# PROJECT_DIR defaults to the package root (parent of scripts/) but can be
# overridden (e.g. by tests) to point at a fixture directory.
PROJECT_DIR="${PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"

CHECK=false
if [[ "${1:-}" == "--check" ]]; then
  CHECK=true
elif [[ -n "${1:-}" ]]; then
  echo "Usage: sync-version.sh [--check]" >&2
  exit 1
fi

VERSION=$(node -p "require('$PROJECT_DIR/package.json').version")

PROPS="$PROJECT_DIR/gradle.properties"

# Fail loudly if there is no VERSION_NAME line. `sed` exits 0 even when its
# pattern matches nothing, which would otherwise leave a stale version and
# silently publish/tag the wrong number.
if ! grep -q '^VERSION_NAME=' "$PROPS"; then
  echo "ERROR: no VERSION_NAME= line found in $PROPS" >&2
  exit 1
fi

# --check compares VERSION_NAME with package.json without writing. CI runs it
# for native/kotlin pull requests to prevent stale runtime and release versions.
if [[ "$CHECK" == true ]]; then
  CURRENT=$(grep '^VERSION_NAME=' "$PROPS" | head -1 | cut -d= -f2-)
  if [[ "$CURRENT" == "$VERSION" ]]; then
    echo "ok: VERSION_NAME matches package.json ($VERSION)"
    exit 0
  fi
  echo "DRIFT: gradle.properties VERSION_NAME=$CURRENT does not match package.json ($VERSION)." >&2
  echo "       package.json is the source of truth (managed via changesets)." >&2
  echo "       If it holds the intended version, run: scripts/sync-version.sh" >&2
  exit 1
fi

sed -i.bak "s/^VERSION_NAME=.*/VERSION_NAME=$VERSION/" "$PROPS"
rm -f "$PROPS.bak"

# Verify the write landed.
WRITTEN=$(grep '^VERSION_NAME=' "$PROPS" | head -1 | cut -d= -f2-)
if [[ "$WRITTEN" != "$VERSION" ]]; then
  echo "ERROR: failed to set VERSION_NAME=$VERSION in $PROPS" >&2
  exit 1
fi

echo "Synced version $VERSION to gradle.properties"
