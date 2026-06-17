#!/usr/bin/env bash
# Scaffold a fresh bench-app from create-blocks-app and start the dev server.
#
# Inputs:
#   $1 = template name (e.g. default, demo, bare, react, nextjs, backend, auth-cognito)
#
# On success: prints `dev-server-up:<port>` and writes the port to /tmp/dev.port.
# On failure: dumps dev-server log tail and exits 1.
#
# Different templates bind different ports (most proxy :3000 -> :3100; backend
# binds :3001 directly). We probe both with `curl --head` so a 404 root
# (backend's API server has no UI at /) still counts as bound.
set -euo pipefail

TEMPLATE="${1:?usage: setup-app.sh <template>}"
cd /workspace

cat > .npmrc <<'EOF'
@aws-blocks:registry=http://localhost:4873/registry/
EOF

echo ">>> installing @aws-blocks/create-blocks-app"
npm install --no-save @aws-blocks/create-blocks-app 2>&1 | tail -5

echo ">>> scaffolding bench-app (template=${TEMPLATE})"
if [ "$TEMPLATE" = "default" ]; then
  ./node_modules/.bin/create-blocks-app bench-app 2>&1 | tail -10
else
  ./node_modules/.bin/create-blocks-app bench-app --template "$TEMPLATE" 2>&1 | tail -10
fi

cd bench-app
nohup npm run dev > /tmp/dev.log 2>&1 &
echo $! > /tmp/dev.pid

for i in $(seq 1 60); do
  for port in 3000 3001; do
    if curl -s --head -m 2 "http://localhost:${port}" > /dev/null 2>&1; then
      echo "dev-server-up:${port}"
      echo "${port}" > /tmp/dev.port
      exit 0
    fi
  done
  sleep 1
done

echo ">>> dev server timed out; tail of /tmp/dev.log:"
tail -50 /tmp/dev.log
exit 1
