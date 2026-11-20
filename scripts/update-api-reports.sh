#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Generates API.md reports for all publishable packages using API Extractor.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

failed=0
for config in "$ROOT"/packages/*/api-extractor.json; do
  dir="$(dirname "$config")"
  pkg="$(basename "$dir")"
  echo "→ $pkg"
  (cd "$dir" && npx api-extractor run --local && tr -d '\r' < API.api.md > API.md && rm -f API.api.md) || {
    echo "  ✗ FAILED: $pkg"
    failed=1
  }
done

if [ $failed -ne 0 ]; then
  echo ""
  echo "Some packages failed. See output above."
  exit 1
fi

echo ""
echo "✓ All API reports generated."
