#!/usr/bin/env bash
# Best-effort S3 upload for the agent-bench workflow's persist steps.
#
# Usage: s3-put.sh <src-file> <s3-uri> <label>
#
# Warns (never errors) when the source is missing or the copy fails, so a persist
# step stays green-regardless. All bench S3 writes are best-effort archival: a
# miss must surface as a ::warning:: annotation, not a red job.
set -u
src="$1"
uri="$2"
label="$3"
if [ ! -f "$src" ]; then
  echo "::warning::no ${label} at ${src} — nothing to persist"
  exit 0
fi
aws s3 cp "$src" "$uri" || echo "::warning::S3 ${label} write failed for ${uri}"
