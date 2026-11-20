#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Renders the body of a Swift SDK release PR.
#
# Usage: render-release-body.sh <template-name> <version>
#        (the changelog entry is read from STDIN)
#
# <template-name> is `monorepo` or `target`. The Publish Swift SDK workflow in
# this repo renders `monorepo`. `target` is rendered by the "Sync release from
# aws-blocks" workflow in cdk-blocks-swift, which runs this script from the
# swift@<version> tag. The template names, the `<template> <version>` arguments
# and the entry on STDIN are therefore that repo's interface. Keep them
# compatible: a break only shows up after a release is tagged, and a fix on
# main doesn't reach a version that is already tagged.
#
# <version> is the release version. The changelog entry arrives on STDIN (never
# argv) because it is arbitrary contributor prose that may contain `&`,
# backticks, `$(...)`, or even a bare `EOF` line. Passing it on STDIN and
# substituting it with a QUOTED replacement keeps every one of those literal:
# the quoted heredoc (<<'EOF') disables all expansion, and the quoted
# replacement in `${BODY/.../"$ENTRY"}` stops bash 5.2's patsub_replacement from
# giving `&` and `\` their special meaning during the substitution.
#
# GitHub rejects PR bodies over 65,536 characters. When the rendered body would
# be longer than MAX_BODY_BYTES, the entry is replaced with a link to the
# CHANGELOG, so the PR can still be opened.

set -euo pipefail

TEMPLATE="${1:?Usage: render-release-body.sh <template-name> <version> (entry on stdin)}"
VERSION="${2:?Usage: render-release-body.sh <template-name> <version> (entry on stdin)}"

# Bytes, not characters, so the check is never more lenient than GitHub's.
MAX_BODY_BYTES="${MAX_BODY_BYTES:-60000}"

# Read the whole changelog entry from stdin so it never passes through argv.
ENTRY=$(cat)

case "$TEMPLATE" in
  monorepo)
    BODY=$(cat <<'EOF'
## Swift SDK Release __VERSION__

__CHANGELOG_ENTRY__

This PR was opened by github-actions[bot], so its checks wait for approval. Approve the workflow runs at the bottom of this PR, and merge once they pass.

On merge, this will be tagged `swift@__VERSION__`. Then run the "Sync release from aws-blocks" workflow in cdk-blocks-swift with version `__VERSION__` to open the release PR there: https://github.com/aws/cdk-blocks-swift/actions/workflows/sync-from-monorepo.yml
EOF
)
    CHANGELOG_URL="https://github.com/aws/cdk-blocks/blob/release/swift-${VERSION}/native/swift/CHANGELOG.md"
    ;;
  target)
    BODY=$(cat <<'EOF'
## Release __VERSION__

__CHANGELOG_ENTRY__

Synced from cdk-blocks tag `swift@__VERSION__`.

On merge, a git tag `__VERSION__` will be created automatically and a GitHub Release published. Swift Package Manager will pick up the new version via the tag.
EOF
)
    CHANGELOG_URL="https://github.com/aws/cdk-blocks/blob/swift@${VERSION}/native/swift/CHANGELOG.md"
    ;;
  *)
    echo "Error: unknown template \"${TEMPLATE}\" (expected 'monorepo' or 'target')." >&2
    exit 1
    ;;
esac

# Substitute VERSION before the entry, so a version string can never introduce a
# fresh __CHANGELOG_ENTRY__ marker. Replacements are quoted (see the header).
BODY=${BODY//__VERSION__/"$VERSION"}
RENDERED=${BODY/__CHANGELOG_ENTRY__/"$ENTRY"}

if [ "$(printf '%s\n' "$RENDERED" | LC_ALL=C wc -c)" -gt "$MAX_BODY_BYTES" ]; then
  LINK="The changelog for this release is too long for a PR description. See ${CHANGELOG_URL}"
  RENDERED=${BODY/__CHANGELOG_ENTRY__/"$LINK"}
fi

printf '%s\n' "$RENDERED"
