#!/bin/bash
set -e

# Native SDK E2E — runs the full pipeline locally or in CI.
# Usage: ./run-e2e.sh [--blocks-url URL] [--target jvm|ios]
#
# From the monorepo root, this script:
# 1. Generates the OpenRPC spec from test-apps/native-bindings
# 2. Copies the spec into the e2e project
# 3. Runs Kotlin codegen via the Gradle plugin
# 4. Starts the local dev server (unless --blocks-url is provided)
# 5. Runs the E2E test suite for the specified target
# 6. Stops the server

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MONOREPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BACKEND="$MONOREPO_ROOT/test-apps/native-bindings"
E2E_DIR="$SCRIPT_DIR/e2e"

BLOCKS_URL=""
SERVER_PID=""
TARGET="jvm"

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    echo "Stopping server (PID: $SERVER_PID)..."
    kill "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --blocks-url) BLOCKS_URL="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

echo "Step 1: Generate OpenRPC spec from test-apps/native-bindings"
cd "$BACKEND"
npm run spec
SPEC_PATH="$BACKEND/aws-blocks/blocks.spec.json"
echo "   Spec: $SPEC_PATH"

echo ""
echo "Step 2: Copy spec to e2e project"
cp "$SPEC_PATH" "$E2E_DIR/blocks.spec.json"
echo "   Copied to: $E2E_DIR/blocks.spec.json"

echo ""
echo "Step 3: Run Kotlin codegen"
cd "$E2E_DIR"
./gradlew awsBlocksCodegen --quiet
echo "   Codegen complete"

if [ -z "$BLOCKS_URL" ]; then
  echo ""
  echo "Step 4: Start native-bindings dev server"
  cd "$BACKEND"
  npx tsx aws-blocks/scripts/server.ts > /tmp/blocks-kotlin-e2e-server.log 2>&1 &
  SERVER_PID=$!
  BLOCKS_URL="http://localhost:3001/aws-blocks/api"

  # Wait for server
  for i in $(seq 1 30); do
    if curl -s -X POST "$BLOCKS_URL" \
      -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","method":"api.kvGet","params":{"key":"healthcheck"},"id":1}' 2>/dev/null | grep -q "result"; then
      echo "   Server ready at $BLOCKS_URL"
      break
    fi
    sleep 1
    if [ $i -eq 30 ]; then
      echo "   Server failed to start. Logs:"
      cat /tmp/blocks-kotlin-e2e-server.log
      exit 1
    fi
  done
else
  echo ""
  echo "Step 4: Using provided endpoint: $BLOCKS_URL"
fi

echo ""
echo "Step 5: Run E2E tests (target: $TARGET)"
cd "$E2E_DIR"

case $TARGET in
  jvm)
    ./gradlew jvmTest -DBLOCKS_URL="$BLOCKS_URL"
    ;;
  ios)
    ./gradlew iosSimulatorArm64Test -DBLOCKS_URL="$BLOCKS_URL"
    ;;
  *)
    echo "Unknown target: $TARGET (expected: jvm, ios)"
    exit 1
    ;;
esac
