#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Copies the Swift SDK (this native/swift directory) into a checkout of the
# cdk-blocks-swift repo, which SwiftPM consumes because it needs Package.swift
# at the repo root.
#
# Usage: sync-to-mirror.sh <mirror-checkout-dir>
#
# Everything at the mirror root is replaced except the files that only live in
# the mirror: .git, .github, LICENSE, NOTICE, CODE_OF_CONDUCT.md and
# CONTRIBUTING.md. The cdk-blocks-swift "Sync release from aws-blocks" workflow
# runs this script from a checkout of aws-blocks at the swift@<version> tag, so
# the copy rules ship with the release they apply to.

set -euo pipefail

ARG="${1:?Usage: sync-to-mirror.sh <mirror-checkout-dir>}"
SRC="$(CDPATH='' cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
TARGET="$(CDPATH='' cd -P -- "$ARG" && pwd -P)"

# The delete below removes almost everything in TARGET, so only accept a
# checkout of the mirror: it has the mirror's own release workflow, which
# aws-blocks doesn't. (`-e` because .git is a file in a worktree.)
if [ ! -e "$TARGET/.git" ] || [ ! -f "$TARGET/.github/workflows/publish-tag-release.yml" ]; then
  echo "Error: '$ARG' is not a cdk-blocks-swift checkout." >&2
  exit 1
fi
# Refuse a TARGET that is SRC or contains it, such as the aws-blocks root.
case "$SRC/" in
  "$TARGET"/*)
    echo "Error: '$ARG' contains the Swift SDK sources." >&2
    exit 1
    ;;
esac

# Remove synced content (preserve repo-only files). -mindepth 1 keeps find from
# matching TARGET itself, which would delete the whole checkout.
find "$TARGET" -mindepth 1 -maxdepth 1 \
  -not -name '.git' \
  -not -name '.github' \
  -not -name 'LICENSE' \
  -not -name 'NOTICE' \
  -not -name 'CODE_OF_CONDUCT.md' \
  -not -name 'CONTRIBUTING.md' \
  -exec rm -rf {} +

# Copy native/swift contents to the mirror root.
# Anchor the root package.json/package-lock.json excludes with a leading '/' so
# they only skip native/swift's changeset-tooling manifests and keep
# Demo/typescript-demo/package.json. The demo's package-lock.json isn't
# committed in aws-blocks (see the root .gitignore), so a sync removes the
# mirror's copy. This script isn't copied: the mirror runs the one from the tag.
rsync -a --exclude='.changeset' \
         --exclude='node_modules' \
         --exclude='.build' \
         --exclude='/package.json' \
         --exclude='/package-lock.json' \
         --exclude='/scripts/sync-to-mirror.sh' \
         --exclude='/scripts/sync-to-mirror.test.sh' \
         "$SRC/" "$TARGET/"
