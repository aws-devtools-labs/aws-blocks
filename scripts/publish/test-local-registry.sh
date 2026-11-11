#!/bin/bash
# Phase 2: Test the local registry with a fresh npm project
set -e

TEST_DIR="/tmp/blocks-registry-test"
REGISTRY_URL="http://localhost:4873/registry/"

echo "=== Phase 2: Local Registry Test ==="
echo ""

# Clean slate
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"

# Create minimal package.json
cat > "$TEST_DIR/package.json" << 'EOF'
{ "name": "blocks-registry-test", "version": "1.0.0", "private": true }
EOF

# Create .npmrc pointing at local registry
cat > "$TEST_DIR/.npmrc" << EOF
@aws-blocks:registry=$REGISTRY_URL
EOF

# Step 1: npm install
echo "1. Running npm install @aws-blocks/blocks..."
(cd "$TEST_DIR" && npm install @aws-blocks/blocks 2>&1)
echo "   ✓ npm install succeeded"
echo ""

# Step 2: Verify dependency tree
echo "2. Verifying dependency tree..."
(cd "$TEST_DIR" && npm ls @aws-blocks/blocks @aws-blocks/core @aws-blocks/bb-auth-basic @aws-blocks/bb-kv-store @aws-blocks/bb-realtime 2>&1)
echo "   ✓ Dependency tree correct"
echo ""

# Step 3: Verify lockfile exists
echo "3. Checking package-lock.json..."
if [ -f "$TEST_DIR/package-lock.json" ]; then
    echo "   ✓ package-lock.json exists"
else
    echo "   ✗ package-lock.json missing!"
    exit 1
fi
echo ""

# Step 4: npm ci (lockfile stability)
echo "4. Running npm ci (lockfile stability)..."
(cd "$TEST_DIR" && npm ci 2>&1)
echo "   ✓ npm ci succeeded — lockfile is stable"
echo ""

# Step 5: Verify transitive deps
echo "5. Checking transitive dependencies..."
AWS_BLOCKS_AUTH_DIR="$TEST_DIR/node_modules/@aws-blocks/bb-auth-basic"
if [ -d "$AWS_BLOCKS_AUTH_DIR" ]; then
    echo "   ✓ @aws-blocks/bb-auth-basic installed (transitive via blocks)"
else
    echo "   ✗ @aws-blocks/bb-auth-basic missing!"
    exit 1
fi

AWS_BLOCKS_CORE_DIR="$TEST_DIR/node_modules/@aws-blocks/core"
if [ -d "$AWS_BLOCKS_CORE_DIR" ]; then
    echo "   ✓ @aws-blocks/core installed (transitive via blocks + bb-auth-basic)"
else
    echo "   ✗ @aws-blocks/core missing!"
    exit 1
fi
echo ""

echo "=== All Phase 2 checks passed ==="
