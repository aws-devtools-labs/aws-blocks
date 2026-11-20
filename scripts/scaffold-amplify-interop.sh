#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# ─────────────────────────────────────────────────────────────────────────────
# scaffold-amplify-interop.sh
#
# Recreates test-apps/amplify-gen2 from scratch:
# 1. Scaffolds a fresh Amplify Gen 2 project
# 2. Runs create-blocks-app to integrate CDK Blocks
# 3. Restores the hand-maintained frontend + Playwright tests from git
#
# Usage (from repo root):
#   bash scripts/scaffold-amplify-interop.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e

MONOREPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_APP="$MONOREPO_ROOT/test-apps/amplify-gen2"

echo "🗑️  Removing existing test app..."
rm -rf "$TEST_APP"
mkdir -p "$TEST_APP"

echo "📦 Creating fresh Amplify Gen 2 project..."
cd "$TEST_APP"
npm create amplify@latest -- --yes

echo "🔨 Building create-blocks-app..."
cd "$MONOREPO_ROOT"
npm run build --workspace=packages/create-blocks-app

echo "🔌 Scaffolding AWS CDK Blocks into test app..."
cd "$TEST_APP"
node "$MONOREPO_ROOT/packages/create-blocks-app/dist/index.js" --yes .

echo "🔄 Restoring frontend + test files from git..."
cd "$MONOREPO_ROOT"
git checkout HEAD -- \
  test-apps/amplify-gen2/src/ \
  test-apps/amplify-gen2/test/ \
  test-apps/amplify-gen2/vite.config.ts \
  test-apps/amplify-gen2/playwright.config.ts \
  test-apps/amplify-gen2/package.json

echo "📦 Installing dependencies..."
cd "$TEST_APP"
npm install

echo ""
echo "✅ Done! App recreated at: test-apps/amplify-gen2"
echo ""
echo "Next steps:"
echo "  cd test-apps/amplify-gen2"
echo "  npm run sandbox:once -- --identifier <name>   # deploy"
echo "  npm run test:e2e                              # run Playwright tests"
echo "  npm run sandbox:delete -- --identifier <name> # tear down"
