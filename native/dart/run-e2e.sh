#!/bin/bash
set -e

# Native SDK E2E — runs the full pipeline locally or in CI.
# Usage: ./run-e2e.sh [--blocks-url URL]
#
# From the monorepo root, this script:
# 1. Generates the OpenRPC spec from test-apps/native-bindings
# 2. Runs Dart codegen to produce a typed client
# 3. Starts the local dev server (unless --blocks-url is provided)
# 4. Runs the E2E test suite
# 5. Stops the server

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MONOREPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BACKEND="$MONOREPO_ROOT/test-apps/native-bindings"
DART_SDK="$SCRIPT_DIR"
DART="${DART:-dart}"

BLOCKS_URL=""
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    echo "🛑 Stopping server (PID: $SERVER_PID)..."
    kill "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --blocks-url) BLOCKS_URL="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

echo "📦 Step 1: Generate OpenRPC spec from test-apps/native-bindings"
cd "$BACKEND"
npx blocks-generate-spec
SPEC_PATH="$BACKEND/aws-blocks/blocks.spec.json"
echo "   ✅ Spec: $SPEC_PATH"

echo ""
echo "🔧 Step 2: Run Dart codegen"
cd "$DART_SDK/packages/blocks_codegen"
$DART pub get --no-precompile 2>/dev/null
$DART run bin/blocks_codegen.dart \
  --spec "$SPEC_PATH" \
  --output "$DART_SDK/example/lib/blocks_client.dart"
echo "   ✅ Client: $DART_SDK/example/lib/blocks_client.dart"

echo ""
echo "🔍 Step 3: Verify generated client compiles"
cd "$DART_SDK/example"
$DART pub get --no-precompile 2>/dev/null
$DART analyze lib/blocks_client.dart
echo "   ✅ No compile errors"

if [ -z "$BLOCKS_URL" ]; then
  echo ""
  echo "🚀 Step 4: Start native-bindings dev server"
  cd "$BACKEND"
  # Pick a free port so concurrent runs / an already-bound 3001 never collide.
  # python3 bind-to-0 is portable across macOS (local) and ubuntu (CI); fall
  # back to 3001 if the picker fails. The launcher owns the port: it passes it
  # to the server via PORT and builds BLOCKS_URL from the same value, so server
  # and client agree without a hardcoded literal.
  PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()' 2>/dev/null || echo 3001)"
  export PORT
  echo "   ℹ️  Using local server port $PORT"
  npx tsx aws-blocks/scripts/server.ts > /tmp/blocks-e2e-server.log 2>&1 &
  SERVER_PID=$!
  BLOCKS_URL="http://localhost:$PORT/aws-blocks/api"

  # Wait for server
  for i in $(seq 1 30); do
    if curl -s -X POST "$BLOCKS_URL" \
      -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","method":"api.kvGet","params":{"key":"healthcheck"},"id":1}' 2>/dev/null | grep -q "result"; then
      echo "   ✅ Server ready at $BLOCKS_URL"
      break
    fi
    sleep 1
    if [ $i -eq 30 ]; then
      echo "   ❌ Server failed to start. Logs:"
      cat /tmp/blocks-e2e-server.log
      exit 1
    fi
  done
else
  echo ""
  echo "🌐 Step 4: Using provided endpoint: $BLOCKS_URL"
  echo "   ℹ️  Against a deployed pool, the AuthCognito suite skips the dev-only"
  echo "       emailed-code leg and signs in a PRE-PROVISIONED user. Seed it first:"
  echo "         (cd \"$BACKEND\" && BLOCKS_STACK_NAME=<stack> AWS_REGION=<region> npm run seed:cognito)"

  # Readiness gate (warm-up). A freshly-deployed stack's Lambda/API Gateway can
  # cold-start: the very first request against a brand-new sandbox can fail
  # before the function is warm. Poll the JSON-RPC endpoint until it answers
  # HTTP 200 (it returns 200 with a JSON-RPC error body for any payload, which
  # proves the Lambda is up and serving) so no suite eats the cold-start on its
  # first call. Hits the same Lambda that serves /auth/* (OIDC), so it protects
  # the OIDC suite's first POST too. Bounded backoff; fails loudly if never ready.
  echo ""
  echo "♨️  Step 4b: Warm up endpoint (poll until HTTP 200)"
  WARMUP_ATTEMPTS="${WARMUP_ATTEMPTS:-24}"
  warmup_delay=2
  warmed=0
  for i in $(seq 1 "$WARMUP_ATTEMPTS"); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
      -X POST -H 'content-type: application/json' -d '{}' "$BLOCKS_URL" 2>/dev/null || echo 000)
    if [ "$code" = "200" ]; then
      echo "   ✅ Endpoint warm after attempt $i (http=200)"
      warmed=1
      break
    fi
    echo "   ⏳ attempt $i/$WARMUP_ATTEMPTS: not ready (http=$code); retry in ${warmup_delay}s"
    sleep "$warmup_delay"
    if [ "$warmup_delay" -lt 10 ]; then warmup_delay=$((warmup_delay + 2)); fi
  done
  if [ "$warmed" -ne 1 ]; then
    echo "   ❌ Endpoint did not return HTTP 200 after $WARMUP_ATTEMPTS attempts."
    exit 1
  fi
fi

echo ""
echo "🧪 Step 5: Run E2E tests"
cd "$DART_SDK/example"
export BLOCKS_URL
$DART run bin/e2e_test.dart
