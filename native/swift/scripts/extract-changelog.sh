#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Extracts the body of a specific version section from CHANGELOG.md.
#
# Usage: extract-changelog.sh <changelog-path> <version>
#
# Exits 0 with the section body on stdout (blank lines trimmed).
# Exits 1 if the version heading is not found.

set -euo pipefail

CHANGELOG="${1:?Usage: extract-changelog.sh <changelog-path> <version>}"
VERSION="${2:?Usage: extract-changelog.sh <changelog-path> <version>}"

if [ ! -f "$CHANGELOG" ]; then
  echo "Error: file not found: $CHANGELOG" >&2
  exit 1
fi

# Extract lines between "## <version>" and the next "## " heading.
# Uses whole-line match so "0.1" doesn't match "0.1.0".
BODY=$(awk -v ver="$VERSION" '
  BEGIN { found=0 }
  /^## / {
    if (found) exit
    if ($0 == "## " ver) { found=1; next }
  }
  found { print }
' "$CHANGELOG")

if [ -z "$BODY" ]; then
  # Distinguish: heading exists but empty vs heading not found
  if grep -q "^## ${VERSION}$" "$CHANGELOG"; then
    exit 0
  fi
  echo "Error: version ${VERSION} not found in ${CHANGELOG}" >&2
  exit 1
fi

# Trim leading and trailing blank lines
echo "$BODY" | awk '
  NF { found=1 }
  found { lines[++n] = $0 }
  END {
    # Trim trailing blanks
    while (n > 0 && lines[n] == "") n--
    for (i = 1; i <= n; i++) print lines[i]
  }
'
