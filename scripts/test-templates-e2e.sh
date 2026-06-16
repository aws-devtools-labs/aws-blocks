#!/usr/bin/env bash
# E2E test for create-blocks-app templates.
#
# Publishes all packages to a local file-based registry, then creates apps
# from each template using the published CLI — exactly as a customer would.
# No workspace links, no verdaccio.
#
# Usage:  ./scripts/test-templates-e2e.sh [--skip-publish]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGISTRY_PORT=4873
REGISTRY_URL="http://localhost:${REGISTRY_PORT}/registry/"
TEST_DIR="${TMPDIR:-/tmp}/blocks-template-e2e-$$"
REGISTRY_PID=""

cleanup() {
  echo ""
  echo "=== Cleanup ==="
  [[ -n "$REGISTRY_PID" ]] && kill "$REGISTRY_PID" 2>/dev/null && echo "  Killed registry ($REGISTRY_PID)" || true
  rm -rf "$TEST_DIR"
  echo "  Removed $TEST_DIR"
}
trap cleanup EXIT

if [[ "${1:-}" == "--skip-publish" ]] && [[ -d "$ROOT/dist-registry" ]]; then
  echo "=== Step 1: Skipping publish (using existing dist-registry) ==="
else
  echo "=== Step 1: Publish to local registry ==="
  cd "$ROOT"
  npm run publish:local 2>&1
fi

echo ""
echo "=== Step 2: Start local registry ==="
cd "$ROOT"
npx tsx scripts/publish/serve-local-registry.ts &
REGISTRY_PID=$!

# Wait for registry to be ready
for i in $(seq 1 15); do
  if curl -sf "${REGISTRY_URL}@aws-blocks/blocks" > /dev/null 2>&1; then
    echo "  Registry ready (pid $REGISTRY_PID)"
    break
  fi
  if [[ $i -eq 15 ]]; then
    echo "  ERROR: Registry did not start"
    exit 1
  fi
  sleep 1
done

mkdir -p "$TEST_DIR"

# Point npm at a temporary user config so we don't pollute ~/.npmrc.
# Set the scoped registry there so ALL npm operations (including
# create-blocks-app's internal npm install) resolve @aws-blocks
# packages from the local registry.
export NPM_CONFIG_USERCONFIG="$TEST_DIR/.npmrc"
echo "@aws-blocks:registry=${REGISTRY_URL}" > "$TEST_DIR/.npmrc"

# Install create-blocks-app from the local registry (avoids npx cache staleness)
# Use a temp npm cache to avoid stale tarballs from the global cache
# (same version number, different content during development).
NPM_CACHE="$TEST_DIR/.npm-cache"
export npm_config_cache="$NPM_CACHE"
echo ""
echo "=== Step 3: Install create-blocks-app from registry ==="
cd "$TEST_DIR"
npm install @aws-blocks/create-blocks-app@latest 2>&1
CREATE_CMD="$TEST_DIR/node_modules/.bin/create-blocks-app"

TEMPLATES=("default" "demo")
FAILED=0

for TEMPLATE in "${TEMPLATES[@]}"; do
  echo ""
  echo "============================================"
  echo "=== Testing template: $TEMPLATE"
  echo "============================================"

  APP_DIR="$TEST_DIR/app-$TEMPLATE"
  mkdir -p "$APP_DIR"
  cd "$APP_DIR"

  echo ""
  echo "--- Creating app from registry ---"
  TEMPLATE_ARGS=""
  [[ "$TEMPLATE" != "default" ]] && TEMPLATE_ARGS="--template $TEMPLATE"
  "$CREATE_CMD" "$APP_DIR/my-app" $TEMPLATE_ARGS 2>&1 || {
    echo "  FAIL: create-blocks-app failed for template $TEMPLATE"
    FAILED=1
    continue
  }

  cd "$APP_DIR/my-app"

  echo ""
  echo "--- Running e2e tests ---"
  npm run test:e2e 2>&1 || {
    echo "  FAIL: e2e tests failed for template $TEMPLATE"
    FAILED=1
    continue
  }

  echo ""
  echo "--- Testing vendorize bin ---"
  npm run vendorize -- @aws-blocks/bb-kv-store 2>&1 || {
    echo "  FAIL: vendorize failed for template $TEMPLATE"
    FAILED=1
    continue
  }
  # Verify vendorized source exists
  if [[ ! -f "vendor/bb-kv-store/src/index.ts" && ! -f "vendor/bb-kv-store/src/index.cdk.ts" ]]; then
    echo "  FAIL: vendorized source not found for template $TEMPLATE"
    FAILED=1
    continue
  fi
  echo "  ✓ vendorize bin works"

  echo "  ✓ Template $TEMPLATE passed all checks"
done

echo ""
echo "============================================"
if [[ $FAILED -eq 0 ]]; then
  echo "✅ All template e2e tests passed!"
  exit 0
else
  echo "❌ Some template e2e tests failed"
  exit 1
fi
