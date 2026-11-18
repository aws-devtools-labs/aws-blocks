#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

# Creates a "full-content review" PR where all matched files appear as 100% new.
# Usage: npm run review-pr -- docs/design-new/* --title "Review: Design Docs"

EMPTY_BRANCH="review/empty"
TITLE=""
FILES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title) shift; TITLE="$1"; shift ;;
    *) [[ -f "$1" ]] && FILES+=("$1"); shift ;;
  esac
done

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "Usage: npm run review-pr -- <glob|file>... [--title \"PR title\"]"
  exit 1
fi

echo "Files to include (${#FILES[@]}):"
printf "  %s\n" "${FILES[@]}"

SOURCE_REF=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || git rev-parse HEAD)
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
REVIEW_BRANCH="review/${TIMESTAMP}"

# Use a temporary worktree so we never touch the main working tree
TMPDIR=$(mktemp -d)
cleanup() {
  git worktree remove "$TMPDIR" --force 2>/dev/null || true
  git branch -D "$REVIEW_BRANCH" 2>/dev/null || true
}

echo "Creating review branch '${REVIEW_BRANCH}'..."
git worktree add -b "$REVIEW_BRANCH" "$TMPDIR" "$EMPTY_BRANCH" --quiet

# Copy the matched files into the worktree preserving directory structure
for f in "${FILES[@]}"; do
  mkdir -p "$TMPDIR/$(dirname "$f")"
  cp "$f" "$TMPDIR/$f"
done

cd "$TMPDIR"
git add -A
git commit -m "${TITLE:-"Review: ${FILES[*]}"}" --quiet
git push origin "$REVIEW_BRANCH" --quiet
cd - >/dev/null

# Clean up worktree (keep the remote branch)
git worktree remove "$TMPDIR" --force 2>/dev/null || true

echo "Opening PR..."
gh pr create \
  --base "$EMPTY_BRANCH" \
  --head "$REVIEW_BRANCH" \
  --title "${TITLE:-"Review: ${FILES[*]}"}" \
  --body "Full-content review of ${#FILES[@]} file(s) from \`${SOURCE_REF}\`:
$(printf '\n- `%s`' "${FILES[@]}")

> Files shown in their entirety. Comment inline to review.
> ⚠️ This PR is not meant to be merged."

echo "Done! Review PR created."
