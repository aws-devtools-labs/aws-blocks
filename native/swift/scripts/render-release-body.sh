#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Renders a release-PR body for the Publish Swift SDK workflow.
#
# Usage: render-release-body.sh <template-name> <version>
#        (the changelog entry is read from STDIN)
#
# <template-name> is `monorepo` or `target`; each step opens a differently
# worded PR. <version> is the release version. The changelog entry arrives on
# STDIN — never argv — because it is arbitrary contributor prose that may
# contain `&`, backticks, `$(...)`, or even a bare `EOF` line. Passing it on
# STDIN and substituting it with a QUOTED replacement keeps every one of those
# literal: the quoted heredoc (<<'EOF') disables all expansion, and the quoted
# replacement in `${BODY/.../"$ENTRY"}` stops bash 5.2's patsub_replacement from
# giving `&` and `\` their special meaning during the substitution.

set -euo pipefail

TEMPLATE="${1:?Usage: render-release-body.sh <template-name> <version> (entry on stdin)}"
VERSION="${2:?Usage: render-release-body.sh <template-name> <version> (entry on stdin)}"

# Read the whole changelog entry from stdin so it never passes through argv.
ENTRY=$(cat)

case "$TEMPLATE" in
  monorepo)
    BODY=$(cat <<'EOF'
## Swift SDK Release __VERSION__

__CHANGELOG_ENTRY__

On merge, this will be tagged `swift@__VERSION__` and synced to aws-blocks-swift.
EOF
)
    ;;
  target)
    BODY=$(cat <<'EOF'
## Release __VERSION__

__CHANGELOG_ENTRY__

Synced from aws-blocks monorepo branch `release/swift-__VERSION__`.

On merge, a git tag `__VERSION__` will be created automatically and a GitHub Release published. Swift Package Manager will pick up the new version via the tag.
EOF
)
    ;;
  *)
    echo "Error: unknown template \"${TEMPLATE}\" (expected 'monorepo' or 'target')." >&2
    exit 1
    ;;
esac

# Substitute VERSION before the entry, so a version string can never introduce a
# fresh __CHANGELOG_ENTRY__ marker. Replacements are quoted (see the header).
BODY=${BODY//__VERSION__/"$VERSION"}
BODY=${BODY/__CHANGELOG_ENTRY__/"$ENTRY"}

printf '%s\n' "$BODY"
