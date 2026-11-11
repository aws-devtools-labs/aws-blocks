#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Copies the Swift SDK (this native/swift directory) into a checkout of the
# aws-blocks-swift repo, which SwiftPM consumes because it needs Package.swift
# at the repo root.
#
# Usage: sync-to-mirror.sh <mirror-checkout-dir>
#
# Everything at the mirror root is replaced except the files that only live in
# the mirror: .git, .github, LICENSE, NOTICE, CODE_OF_CONDUCT.md and
# CONTRIBUTING.md. The aws-blocks-swift "Sync release from aws-blocks" workflow
# runs this script from a checkout of aws-blocks at the swift@<version> tag, so
# the copy rules ship with the release they apply to.

set -euo pipefail

TARGET="${1:?Usage: sync-to-mirror.sh <mirror-checkout-dir>}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -d "$TARGET/.git" ]; then
  echo "Error: '$TARGET' is not a git checkout." >&2
  exit 1
fi

# Remove synced content (preserve repo-only files).
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
# they only skip native/swift's changeset-tooling manifests. Unanchored patterns
# match at every depth and would also drop Demo/typescript-demo/package.json +
# package-lock.json, which the demo needs (and which carry the
# dependency/security fixes).
rsync -a --exclude='.changeset' \
         --exclude='node_modules' \
         --exclude='.build' \
         --exclude='/package.json' \
         --exclude='/package-lock.json' \
         --exclude='Demo/typescript-demo/node_modules' \
         "$SRC/" "$TARGET/"
