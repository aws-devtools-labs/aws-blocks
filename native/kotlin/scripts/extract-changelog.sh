#!/usr/bin/env bash
# Print the body of a single CHANGELOG section.
# Usage: extract-changelog.sh <changelog-path> <version>
# Prints everything between "## <version>" and the next "## " heading,
# trimming surrounding blank lines. Exits non-zero if the version is absent.
set -euo pipefail

CHANGELOG="${1:?usage: extract-changelog.sh <changelog-path> <version>}"
VERSION="${2:?usage: extract-changelog.sh <changelog-path> <version>}"

# awk: start printing after the matching "## <version>" heading; stop at the
# next line beginning with "## ". Track whether we matched at all.
BODY="$(awk -v ver="$VERSION" '
  $0 == "## " ver { found=1; next }
  found && /^## / { exit }
  found { print }
' "$CHANGELOG")"

if [ -z "${BODY//[$' \t\n']/}" ]; then
  # Distinguish "version not found" from "found but empty". Re-scan for the heading.
  if ! grep -qxF "## $VERSION" "$CHANGELOG"; then
    echo "ERROR: version $VERSION not found in $CHANGELOG" >&2
    exit 1
  fi
fi

# Trim leading/trailing blank lines (portable across GNU and BSD/macOS).
printf '%s\n' "$BODY" | awk '
  /[^[:space:]]/ { for (; held > 0; held--) print ""; print; started=1; next }
  started { held++ }
'
