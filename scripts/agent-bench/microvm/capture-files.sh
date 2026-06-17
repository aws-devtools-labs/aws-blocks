#!/usr/bin/env bash
# Tar the agent's workspace (minus heavy ignored dirs) and push to S3 so the
# runner can read back what the agent actually wrote. Required IAM on the
# harness role: s3:PutObject on $TRANSPORT_PREFIX/*.
#
# Inputs (env): TRANSPORT_PREFIX (s3://bucket/bench-uploads/<run-id>/<cell>)
set -euo pipefail

: "${TRANSPORT_PREFIX:?TRANSPORT_PREFIX must be set}"

cd /workspace/bench-app
# The judge step earlier chmod'd the workspace a-w; restore so tar can stat.
chmod -R u+rwX . 2>/dev/null || true

tar -czf /tmp/agent-files.tgz \
  --exclude=node_modules --exclude=.git \
  --exclude=dist --exclude=build --exclude=.next \
  --exclude=.cache --exclude=.turbo --exclude='*.log' \
  --ignore-failed-read . 2>/dev/null || true

aws s3 cp /tmp/agent-files.tgz "${TRANSPORT_PREFIX}/agent-files.tgz"
stat -c '%s bytes' /tmp/agent-files.tgz
