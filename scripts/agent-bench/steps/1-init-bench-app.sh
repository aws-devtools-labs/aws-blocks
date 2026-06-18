#!/usr/bin/env bash
# Step 1: build packages, pack to local registry, scaffold the bench-app,
# start the dev server, write the dev port to /tmp/dev.port and DEV_PORT
# to $GITHUB_ENV.
#
# Usage: init-bench-app.sh <template>
# Required env: WORKSPACE (absolute path where bench-app lands)
set -euo pipefail

TEMPLATE="${1:?usage: init-bench-app.sh <template>}"
: "${WORKSPACE:?WORKSPACE must be set}"

# `npm run build` is topology-aware and runs prebuild hooks in the right order.
# `build:packages` runs alphabetically and trips over bb-data needing
# bb-app-setting's generated version.ts.
npm run build
npm run publish:dry-run

npx tsx scripts/publish/serve-local-registry.ts &
echo $! > /tmp/registry.pid
registry_up=0
for i in $(seq 1 30); do
  if curl -sf http://localhost:4873/registry/@aws-blocks/blocks > /dev/null; then
    registry_up=1
    break
  fi
  sleep 1
done
if [ "$registry_up" != "1" ]; then
  echo "local registry didn't respond on :4873 after 30s"
  exit 1
fi

mkdir -p bench-workdir
cd bench-workdir
cat > .npmrc <<EOF
@aws-blocks:registry=http://localhost:4873/registry/
EOF
# Empty package.json forces npm to treat this as the project root, so
# `npm install` writes into bench-workdir/node_modules instead of walking
# up to the monorepo root and installing there.
cat > package.json <<'EOF'
{ "name": "bench-workdir", "private": true, "version": "0.0.0" }
EOF

# Seed a CANARY telemetry installation-id BEFORE the first Blocks CLI runs so
# the Blocks Telemetry service can recognize and EXCLUDE this bench's traffic
# from real usage metrics. Both create-blocks-app and @aws-blocks/core read
# ~/.blocks/telemetry/installation-id and reuse it when present, so seeding it
# once here tags every event from the scaffold, build, and runtime as a canary.
# (Mirrors PreAmp PR #215.)
mkdir -p "$HOME/.blocks/telemetry"
echo '00000000-0000-0000-0000-00000000bec0' > "$HOME/.blocks/telemetry/installation-id"

# Install create-blocks-app from the local registry, then invoke its bin
# via node directly (npx --yes would fetch the bootstrap package from the
# public registry; .bin linking is unreliable across npm versions).
npm install @aws-blocks/create-blocks-app@latest
CREATE_JS="$(pwd)/node_modules/@aws-blocks/create-blocks-app/dist/index.js"
[ -f "$CREATE_JS" ] || { echo "create-blocks-app bin not found at $CREATE_JS"; ls node_modules/@aws-blocks/ 2>&1; exit 1; }

if [ "$TEMPLATE" = "default" ]; then
  node "$CREATE_JS" bench-app
else
  node "$CREATE_JS" bench-app --template "$TEMPLATE"
fi

mv bench-app "$WORKSPACE"
cd "$WORKSPACE"

nohup npm run dev > /tmp/dev.log 2>&1 &
echo $! > /tmp/dev.pid

# Different templates bind different ports — most proxy :3000 in front of
# :3100; backend binds :3001 directly and serves a 404 root. `curl --head`
# treats any HTTP response as bound (unlike `-sf` which rejects 4xx).
for i in $(seq 1 60); do
  for port in 3000 3001; do
    if curl -s --head -m 2 "http://localhost:$port" > /dev/null 2>&1; then
      echo "$port" > /tmp/dev.port
      echo "DEV_PORT=$port" >> "$GITHUB_ENV"
      exit 0
    fi
  done
  sleep 1
done

echo "dev server timed out; tail of /tmp/dev.log:"
tail -50 /tmp/dev.log
exit 1
