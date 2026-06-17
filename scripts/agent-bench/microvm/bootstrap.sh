#!/usr/bin/env bash
# Bootstrap the AgentCore microVM for a bench cell.
#
# Inputs (env): TRANSPORT_PREFIX (s3://bucket/bench-uploads/<run-id>/<cell>)
#
# Steps:
#   1. Install Node 22 (AL2023 ships Node 18, but the dev server uses
#      process.loadEnvFile which is a Node 20.6+ API).
#   2. Pull the dist-registry tarball from S3 and extract.
#   3. Pull the local-registry server script and start it on :4873.
#      (npm refuses file:// tarball URLs in packuments, so we serve over HTTP.)
set -euo pipefail

: "${TRANSPORT_PREFIX:?TRANSPORT_PREFIX must be set}"

dnf install -y tar gzip 2>&1 | tail -3
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - >/tmp/nodesource.log 2>&1
dnf install -y nodejs 2>&1 | tail -3
node --version

mkdir -p /workspace/dist-registry
aws s3 cp "${TRANSPORT_PREFIX}/dist-registry.tgz" /tmp/dist-registry.tgz
aws s3 cp "${TRANSPORT_PREFIX}/serve-local-registry.ts" /tmp/serve-local-registry.ts
tar -xzf /tmp/dist-registry.tgz -C /workspace/dist-registry

npm install -g tsx 2>&1 | tail -3
nohup tsx /tmp/serve-local-registry.ts > /tmp/registry.log 2>&1 &
echo $! > /tmp/registry.pid

for i in $(seq 1 30); do
  if curl -sf http://localhost:4873/registry/@aws-blocks/blocks > /dev/null; then
    echo "registry-up"
    exit 0
  fi
  sleep 1
done

echo ">>> registry server failed to start; tail of log:"
tail -50 /tmp/registry.log
exit 1
