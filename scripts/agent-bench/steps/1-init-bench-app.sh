#!/usr/bin/env bash
# Step 1: build packages, pack to local registry, scaffold the bench-app, and
# seed the telemetry canary. Does NOT start a dev server — the verifier (step 3)
# owns launching + port discovery, so the agent's edit phase (step 2) runs with
# NO server bound (this removes the tsx-watch/EADDRINUSE flakiness the old
# pre-agent launch caused).
#
# Usage: init-bench-app.sh <template>
# Required env: WORKSPACE (absolute path where bench-app lands)
set -euo pipefail

TEMPLATE="${1:?usage: init-bench-app.sh <template>}"
: "${WORKSPACE:?WORKSPACE must be set}"

# Harden npm against transient registry blips (ECONNRESET etc.) during the
# create-blocks-app scaffold and its internal `npm install`, so a network blip
# while scaffolding doesn't harness-fail a cell. npm only RETRIES transient
# network/registry fetch failures (with backoff) — real errors are NOT masked.
# `${VAR:-default}` lets the CI job env win; exported so child npm processes
# (including create-blocks-app's own install) inherit the setting.
export NPM_CONFIG_FETCH_RETRIES="${NPM_CONFIG_FETCH_RETRIES:-5}"
export NPM_CONFIG_FETCH_RETRY_MINTIMEOUT="${NPM_CONFIG_FETCH_RETRY_MINTIMEOUT:-20000}"
export NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT="${NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT:-120000}"

# BUILD-ONCE: the upstream `build-blocks` job packs the monorepo to dist-registry/ once per run and
# hands it to every cell as an artifact. If present (guard requires an actual *.tgz, since
# download-artifact creates the dir even on a skipped/partial extract), reuse it and skip the ~150s
# per-cell build + pack; otherwise build locally so the cell is self-sufficient.
# `npm run build` is topology-aware; `build:packages` runs alphabetically and trips over bb-data.
if [ -d dist-registry ] && [ -n "$(find dist-registry -name '*.tgz' -type f 2>/dev/null)" ]; then
  echo "1. Init: reusing prebuilt dist-registry/ (from the build-blocks job) — skipping monorepo build + pack"
else
  echo "1. Init: no prebuilt dist-registry/ — building + packing the monorepo locally"
  npm run build
  npm run publish:dry-run
fi

npx tsx scripts/publish/serve-local-registry.ts &
echo $! > /tmp/registry.pid
# Reap the registry daemon on exit so it never leaks :4873 and fails a re-run on a reused runner.
trap 'kill "$(cat /tmp/registry.pid)" 2>/dev/null || true' EXIT
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
# The canary id is sourced ONLY from $BLOCKS_TELEMETRY_CANARY_ID (kept out of the
# repo); if it's unset we skip seeding and warn rather than tagging with a
# hardcoded literal — bench traffic then simply isn't flagged as a canary.
if [ -n "${BLOCKS_TELEMETRY_CANARY_ID:-}" ]; then
  mkdir -p "$HOME/.blocks/telemetry"
  echo "$BLOCKS_TELEMETRY_CANARY_ID" > "$HOME/.blocks/telemetry/installation-id"
else
  echo "::warning::BLOCKS_TELEMETRY_CANARY_ID unset; bench traffic not tagged as canary"
fi

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

# Scaffold complete. No dev server is started here — the verifier (step 3) frees
# the candidate ports, launches `npm run dev` fresh, and discovers the bound
# port itself. Keeping the server out of the agent's edit phase is deliberate.
echo "bench-app scaffolded at $WORKSPACE (no dev server started — verifier owns that)"
